//! Moderation domain service.
//!
//! WHY: Centralizes authorization logic for ban/kick/unban/role operations.
//! Handlers become thin pass-throughs; all permission checks live here.

use std::sync::Arc;

use chrono::{DateTime, Utc};

use crate::domain::errors::DomainError;
use crate::domain::models::{Role, Server, ServerBan, ServerId, UserId};
use crate::domain::ports::{BanRepository, MemberRepository, ServerRepository};

/// Maximum length for a ban reason. Validated in `ban_user`.
const MAX_BAN_REASON_LENGTH: usize = 512;

/// Service for moderation-related business logic (ban, kick, unban, roles).
#[derive(Debug)]
pub struct ModerationService {
    server_repo: Arc<dyn ServerRepository>,
    ban_repo: Arc<dyn BanRepository>,
    member_repo: Arc<dyn MemberRepository>,
}

impl ModerationService {
    #[must_use]
    pub fn new(
        server_repo: Arc<dyn ServerRepository>,
        ban_repo: Arc<dyn BanRepository>,
        member_repo: Arc<dyn MemberRepository>,
    ) -> Self {
        Self {
            server_repo,
            ban_repo,
            member_repo,
        }
    }

    /// Look up a server and verify the caller is the owner. Returns the server.
    async fn require_owner(
        &self,
        server_id: &ServerId,
        caller_id: &UserId,
    ) -> Result<Server, DomainError> {
        let server = self
            .server_repo
            .get_by_id(server_id)
            .await?
            .ok_or_else(|| DomainError::NotFound {
                resource_type: "Server",
                id: server_id.to_string(),
            })?;

        if server.owner_id != *caller_id {
            return Err(DomainError::Forbidden(
                "Only the server owner can perform this action".to_string(),
            ));
        }

        Ok(server)
    }

    /// Verify the caller has at least `min_role` in the server.
    /// Returns the caller's actual role on success.
    ///
    /// # Errors
    /// - `DomainError::NotFound` if the server doesn't exist or caller is not a member.
    /// - `DomainError::Forbidden` if the caller's role is below `min_role`.
    pub async fn require_role(
        &self,
        server_id: &ServerId,
        caller_id: &UserId,
        min_role: Role,
    ) -> Result<Role, DomainError> {
        let (role, _server) = self
            .require_role_with_server(server_id, caller_id, min_role)
            .await?;
        Ok(role)
    }

    /// Verify the caller has at least `min_role` and return both the role and
    /// the server in a single DB round-trip. Avoids the double-fetch that
    /// occurs when `require_role` and a subsequent `get_by_id` are called
    /// separately.
    ///
    /// # Errors
    /// - `DomainError::NotFound` if the server doesn't exist or caller is not a member.
    /// - `DomainError::Forbidden` if the caller's role is below `min_role`.
    async fn require_role_with_server(
        &self,
        server_id: &ServerId,
        caller_id: &UserId,
        min_role: Role,
    ) -> Result<(Role, Server), DomainError> {
        let server = self
            .server_repo
            .get_by_id(server_id)
            .await?
            .ok_or_else(|| DomainError::NotFound {
                resource_type: "Server",
                id: server_id.to_string(),
            })?;

        let caller_role = self
            .member_repo
            .get_member_role(server_id, caller_id)
            .await?
            .ok_or_else(|| {
                DomainError::Forbidden("You are not a member of this server".to_string())
            })?;

        if caller_role.level() < min_role.level() {
            return Err(DomainError::Forbidden(format!(
                "Requires at least '{}' role",
                min_role
            )));
        }

        Ok((caller_role, server))
    }

    /// Ban a user from a server and remove their membership.
    /// Requires admin+ role with hierarchy enforcement.
    ///
    /// # Errors
    /// - `DomainError::NotFound` if the server doesn't exist.
    /// - `DomainError::Forbidden` if the caller lacks admin+ role or hierarchy violation.
    /// - `DomainError::ValidationError` if the server is a DM or the reason exceeds 512 characters.
    /// - `DomainError::Conflict` if the user is already banned.
    pub async fn ban_user(
        &self,
        server_id: &ServerId,
        target_user_id: &UserId,
        caller_id: &UserId,
        reason: Option<String>,
    ) -> Result<ServerBan, DomainError> {
        let (caller_role, server) = self
            .require_role_with_server(server_id, caller_id, Role::Admin)
            .await?;

        if server.is_dm {
            return Err(DomainError::ValidationError(
                "Cannot ban users in DM conversations".to_string(),
            ));
        }

        if *target_user_id == *caller_id {
            return Err(DomainError::Forbidden("Cannot ban yourself".to_string()));
        }

        if *target_user_id == server.owner_id {
            return Err(DomainError::Forbidden(
                "Cannot ban the server owner".to_string(),
            ));
        }

        // Hierarchy check: get target's role if they are a member
        if let Some(target_role) = self
            .member_repo
            .get_member_role(server_id, target_user_id)
            .await?
        {
            require_higher_role(caller_role, target_role)?;
        }

        if let Some(ref r) = reason
            && r.chars().count() > MAX_BAN_REASON_LENGTH
        {
            return Err(DomainError::ValidationError(format!(
                "Ban reason must not exceed {MAX_BAN_REASON_LENGTH} characters"
            )));
        }

        self.ban_repo
            .ban_user(server_id, target_user_id, caller_id, reason)
            .await
    }

    /// Unban a user from a server. Requires admin+ role.
    ///
    /// # Errors
    /// - `DomainError::NotFound` if the server or ban doesn't exist.
    /// - `DomainError::Forbidden` if the caller lacks admin+ role.
    pub async fn unban_user(
        &self,
        server_id: &ServerId,
        target_user_id: &UserId,
        caller_id: &UserId,
    ) -> Result<(), DomainError> {
        self.require_role(server_id, caller_id, Role::Admin).await?;

        self.ban_repo.unban_user(server_id, target_user_id).await
    }

    /// Kick a member from a server. Requires moderator+ role with hierarchy.
    ///
    /// # Errors
    /// - `DomainError::NotFound` if the server doesn't exist or user is not a member.
    /// - `DomainError::ValidationError` if the server is a DM.
    /// - `DomainError::Forbidden` if the caller lacks moderator+ role or hierarchy violation.
    pub async fn kick_member(
        &self,
        server_id: &ServerId,
        target_user_id: &UserId,
        caller_id: &UserId,
    ) -> Result<(), DomainError> {
        let (caller_role, server) = self
            .require_role_with_server(server_id, caller_id, Role::Moderator)
            .await?;

        if server.is_dm {
            return Err(DomainError::ValidationError(
                "Cannot kick users in DM conversations".to_string(),
            ));
        }

        if *target_user_id == *caller_id {
            return Err(DomainError::Forbidden("Cannot kick yourself".to_string()));
        }

        if *target_user_id == server.owner_id {
            return Err(DomainError::Forbidden(
                "Cannot kick the server owner".to_string(),
            ));
        }

        // Hierarchy check
        let target_role = self
            .member_repo
            .get_member_role(server_id, target_user_id)
            .await?
            .ok_or_else(|| DomainError::NotFound {
                resource_type: "ServerMember",
                id: format!("server={}, user={}", server_id, target_user_id),
            })?;

        require_higher_role(caller_role, target_role)?;

        self.member_repo
            .remove_member(server_id, target_user_id)
            .await
    }

    /// List bans for a server with cursor-based pagination. Requires admin+ role.
    ///
    /// # Errors
    /// - `DomainError::NotFound` if the server doesn't exist.
    /// - `DomainError::Forbidden` if the caller lacks admin+ role.
    pub async fn list_bans(
        &self,
        server_id: &ServerId,
        caller_id: &UserId,
        cursor: Option<DateTime<Utc>>,
        limit: i64,
    ) -> Result<Vec<ServerBan>, DomainError> {
        self.require_role(server_id, caller_id, Role::Admin).await?;

        self.ban_repo
            .list_bans_paginated(server_id, cursor, limit)
            .await
    }

    /// Assign a role to a server member. Requires admin+ role with hierarchy enforcement.
    ///
    /// # Errors
    /// - `DomainError::ValidationError` if the role is invalid or not assignable.
    /// - `DomainError::Forbidden` if caller lacks permissions or hierarchy violation.
    /// - `DomainError::NotFound` if the target is not a member.
    pub async fn assign_role(
        &self,
        server_id: &ServerId,
        caller_id: &UserId,
        target_user_id: &UserId,
        new_role: Role,
    ) -> Result<(), DomainError> {
        if !new_role.is_assignable() {
            return Err(DomainError::ValidationError(
                "Cannot assign 'owner' role directly; use ownership transfer instead".to_string(),
            ));
        }

        let caller_role = self.require_role(server_id, caller_id, Role::Admin).await?;

        if *caller_id == *target_user_id {
            return Err(DomainError::ValidationError(
                "Cannot change your own role".to_string(),
            ));
        }

        let target_role = self
            .member_repo
            .get_member_role(server_id, target_user_id)
            .await?
            .ok_or_else(|| DomainError::NotFound {
                resource_type: "ServerMember",
                id: format!("server={}, user={}", server_id, target_user_id),
            })?;

        // Cannot change role of someone with >= own role level
        if target_role.level() >= caller_role.level() {
            return Err(DomainError::Forbidden(
                "Cannot change the role of a user with equal or higher role".to_string(),
            ));
        }

        // Cannot assign a role >= own role level
        if new_role.level() >= caller_role.level() {
            return Err(DomainError::Forbidden(
                "Cannot assign a role equal to or higher than your own".to_string(),
            ));
        }

        self.member_repo
            .update_member_role(server_id, target_user_id, new_role)
            .await
    }

    /// Transfer server ownership. Only the current owner can do this.
    ///
    /// Atomically: `new_owner` gets role='owner', old owner gets role='admin',
    /// and `servers.owner_id` is updated.
    ///
    /// # Errors
    /// - `DomainError::Forbidden` if the caller is not the owner.
    /// - `DomainError::NotFound` if the new owner is not a member.
    /// - `DomainError::ValidationError` if transferring to self.
    pub async fn transfer_ownership(
        &self,
        server_id: &ServerId,
        caller_id: &UserId,
        new_owner_id: &UserId,
    ) -> Result<Server, DomainError> {
        self.require_owner(server_id, caller_id).await?;

        if *caller_id == *new_owner_id {
            return Err(DomainError::ValidationError(
                "Cannot transfer ownership to yourself".to_string(),
            ));
        }

        // Verify new owner is a member
        let is_member = self.member_repo.is_member(server_id, new_owner_id).await?;
        if !is_member {
            return Err(DomainError::NotFound {
                resource_type: "ServerMember",
                id: format!("server={}, user={}", server_id, new_owner_id),
            });
        }

        self.member_repo
            .transfer_ownership(server_id, caller_id, new_owner_id)
            .await?;

        // Return updated server
        self.server_repo
            .get_by_id(server_id)
            .await?
            .ok_or_else(|| DomainError::NotFound {
                resource_type: "Server",
                id: server_id.to_string(),
            })
    }
}

/// Verify that the caller's role strictly outranks the target's role.
///
/// # Errors
/// - `DomainError::Forbidden` if `caller_role` <= `target_role` in hierarchy.
fn require_higher_role(caller_role: Role, target_role: Role) -> Result<(), DomainError> {
    if !caller_role.can_moderate(target_role) {
        return Err(DomainError::Forbidden(
            "Cannot moderate a user with equal or higher role".to_string(),
        ));
    }
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic)]
mod tests {
    use super::*;

    // ── require_higher_role (pure validation) ─────────────────────

    #[test]
    fn higher_role_owner_can_moderate_all_lower() {
        assert!(require_higher_role(Role::Owner, Role::Admin).is_ok());
        assert!(require_higher_role(Role::Owner, Role::Moderator).is_ok());
        assert!(require_higher_role(Role::Owner, Role::Member).is_ok());
    }

    #[test]
    fn higher_role_admin_can_moderate_below() {
        assert!(require_higher_role(Role::Admin, Role::Moderator).is_ok());
        assert!(require_higher_role(Role::Admin, Role::Member).is_ok());
    }

    #[test]
    fn higher_role_moderator_can_moderate_member() {
        assert!(require_higher_role(Role::Moderator, Role::Member).is_ok());
    }

    #[test]
    fn higher_role_same_level_rejected() {
        for role in [Role::Owner, Role::Admin, Role::Moderator, Role::Member] {
            let result = require_higher_role(role, role);
            assert!(result.is_err(), "{} vs {} should fail", role, role);
            match result.unwrap_err() {
                DomainError::Forbidden(msg) => {
                    assert_eq!(msg, "Cannot moderate a user with equal or higher role");
                }
                other => panic!("Expected Forbidden, got {:?}", other),
            }
        }
    }

    #[test]
    fn higher_role_lower_vs_higher_rejected() {
        assert!(require_higher_role(Role::Member, Role::Moderator).is_err());
        assert!(require_higher_role(Role::Member, Role::Admin).is_err());
        assert!(require_higher_role(Role::Member, Role::Owner).is_err());
        assert!(require_higher_role(Role::Moderator, Role::Admin).is_err());
        assert!(require_higher_role(Role::Moderator, Role::Owner).is_err());
        assert!(require_higher_role(Role::Admin, Role::Owner).is_err());
    }

    #[test]
    fn higher_role_owner_cannot_moderate_owner() {
        // WHY: Even owner-vs-owner must fail (strict greater-than).
        let result = require_higher_role(Role::Owner, Role::Owner);
        assert!(result.is_err());
    }

    // ── Role::is_assignable (used by assign_role pre-check) ──────

    #[test]
    fn owner_role_not_assignable() {
        assert!(!Role::Owner.is_assignable());
    }

    #[test]
    fn non_owner_roles_are_assignable() {
        assert!(Role::Admin.is_assignable());
        assert!(Role::Moderator.is_assignable());
        assert!(Role::Member.is_assignable());
    }

    // ── Ban reason length constant ───────────────────────────────

    #[test]
    fn ban_reason_max_length_constant() {
        // WHY: Must match the 512-char limit enforced in ban_user.
        assert_eq!(MAX_BAN_REASON_LENGTH, 512);
    }

    // ── Validation logic documented but requiring repos ──────────
    //
    // The following business rules are enforced in async methods that
    // require repository trait objects (banned by ADR-018: no mocks):
    //
    // - ban_user: rejects DM servers, self-ban, banning owner, reason > 512 chars
    // - kick_member: rejects DM servers, self-kick, kicking owner
    // - assign_role: rejects Owner assignment, self-role-change, hierarchy violations
    // - transfer_ownership: rejects self-transfer, non-member targets
    //
    // These are covered by integration tests with real Postgres.
}
