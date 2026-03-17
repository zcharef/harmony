//! Moderation domain service.
//!
//! WHY: Centralizes authorization logic for ban/kick/unban operations.
//! Handlers become thin pass-throughs; all owner checks live here.

use std::sync::Arc;

use crate::domain::errors::DomainError;
use crate::domain::models::{Server, ServerBan, ServerId, UserId};
use crate::domain::ports::{BanRepository, MemberRepository, ServerRepository};

/// Service for moderation-related business logic (ban, kick, unban).
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

    /// Ban a user from a server and remove their membership. Owner-only.
    ///
    /// # Errors
    /// - `DomainError::NotFound` if the server doesn't exist.
    /// - `DomainError::Forbidden` if the caller is not the owner, or tries to ban self/owner.
    /// - `DomainError::ValidationError` if the reason exceeds 512 characters.
    /// - `DomainError::Conflict` if the user is already banned.
    pub async fn ban_user(
        &self,
        server_id: &ServerId,
        target_user_id: &UserId,
        caller_id: &UserId,
        reason: Option<String>,
    ) -> Result<ServerBan, DomainError> {
        let server = self.require_owner(server_id, caller_id).await?;

        if *target_user_id == *caller_id {
            return Err(DomainError::Forbidden("Cannot ban yourself".to_string()));
        }

        if *target_user_id == server.owner_id {
            return Err(DomainError::Forbidden(
                "Cannot ban the server owner".to_string(),
            ));
        }

        if let Some(ref r) = reason
            && r.chars().count() > 512
        {
            return Err(DomainError::ValidationError(
                "Ban reason must not exceed 512 characters".to_string(),
            ));
        }

        self.ban_repo
            .ban_user(server_id, target_user_id, caller_id, reason)
            .await
    }

    /// Unban a user from a server. Owner-only.
    ///
    /// # Errors
    /// - `DomainError::NotFound` if the server or ban doesn't exist.
    /// - `DomainError::Forbidden` if the caller is not the owner.
    pub async fn unban_user(
        &self,
        server_id: &ServerId,
        target_user_id: &UserId,
        caller_id: &UserId,
    ) -> Result<(), DomainError> {
        self.require_owner(server_id, caller_id).await?;

        self.ban_repo.unban_user(server_id, target_user_id).await
    }

    /// Kick a member from a server. Owner-only.
    ///
    /// # Errors
    /// - `DomainError::NotFound` if the server doesn't exist or user is not a member.
    /// - `DomainError::Forbidden` if the caller is not the owner, or tries to kick self/owner.
    pub async fn kick_member(
        &self,
        server_id: &ServerId,
        target_user_id: &UserId,
        caller_id: &UserId,
    ) -> Result<(), DomainError> {
        let server = self.require_owner(server_id, caller_id).await?;

        if *target_user_id == *caller_id {
            return Err(DomainError::Forbidden("Cannot kick yourself".to_string()));
        }

        if *target_user_id == server.owner_id {
            return Err(DomainError::Forbidden(
                "Cannot kick the server owner".to_string(),
            ));
        }

        self.member_repo
            .remove_member(server_id, target_user_id)
            .await
    }

    /// List all bans for a server. Owner-only.
    ///
    /// # Errors
    /// - `DomainError::NotFound` if the server doesn't exist.
    /// - `DomainError::Forbidden` if the caller is not the owner.
    pub async fn list_bans(
        &self,
        server_id: &ServerId,
        caller_id: &UserId,
    ) -> Result<Vec<ServerBan>, DomainError> {
        self.require_owner(server_id, caller_id).await?;

        self.ban_repo.list_bans(server_id).await
    }
}
