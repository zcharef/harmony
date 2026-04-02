//! Invite domain service.

use std::sync::Arc;

use chrono::{DateTime, Utc};
use rand::Rng;

use crate::domain::errors::DomainError;
use crate::domain::models::{Invite, InviteCode, ServerId, UserId};
use crate::domain::ports::{
    BanRepository, InviteRepository, MemberRepository, PlanLimitChecker, ServerRepository,
};

/// Length of generated invite codes (alphanumeric).
const INVITE_CODE_LENGTH: usize = 8;

/// Maximum length for an invite code (defense-in-depth against oversized input).
const MAX_INVITE_CODE_LENGTH: usize = 32;

/// Characters used for invite code generation.
const INVITE_CODE_CHARSET: &[u8] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/// Validate that an invite code is non-empty, within length bounds, and alphanumeric.
fn validate_invite_code(code: &InviteCode) -> Result<(), DomainError> {
    let s = &code.0;

    if s.is_empty() || s.len() > MAX_INVITE_CODE_LENGTH {
        return Err(DomainError::ValidationError(format!(
            "Invite code must be between 1 and {} characters",
            MAX_INVITE_CODE_LENGTH
        )));
    }

    if !s.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(DomainError::ValidationError(
            "Invite code must contain only alphanumeric characters".to_string(),
        ));
    }

    Ok(())
}

/// Service for invite-related business logic.
#[derive(Debug)]
pub struct InviteService {
    invite_repo: Arc<dyn InviteRepository>,
    member_repo: Arc<dyn MemberRepository>,
    ban_repo: Arc<dyn BanRepository>,
    server_repo: Arc<dyn ServerRepository>,
    plan_checker: Arc<dyn PlanLimitChecker>,
}

impl InviteService {
    #[must_use]
    pub fn new(
        invite_repo: Arc<dyn InviteRepository>,
        member_repo: Arc<dyn MemberRepository>,
        ban_repo: Arc<dyn BanRepository>,
        server_repo: Arc<dyn ServerRepository>,
        plan_checker: Arc<dyn PlanLimitChecker>,
    ) -> Self {
        Self {
            invite_repo,
            member_repo,
            ban_repo,
            server_repo,
            plan_checker,
        }
    }

    /// Create a new invite for a server.
    ///
    /// # Errors
    /// - `DomainError::Forbidden` if the creator is not a member of the server.
    /// - Repository errors on failure.
    pub async fn create_invite(
        &self,
        server_id: ServerId,
        creator_id: UserId,
        max_uses: Option<i32>,
        expires_at: Option<DateTime<Utc>>,
    ) -> Result<Invite, DomainError> {
        // WHY: DM servers use direct user pairing, not invites.
        let server = self
            .server_repo
            .get_by_id(&server_id)
            .await?
            .ok_or_else(|| DomainError::NotFound {
                resource_type: "Server",
                id: server_id.to_string(),
            })?;

        if server.is_dm {
            return Err(DomainError::ValidationError(
                "Cannot create invites for DM conversations".to_string(),
            ));
        }

        // Only members can create invites
        let is_member = self.member_repo.is_member(&server_id, &creator_id).await?;
        if !is_member {
            return Err(DomainError::Forbidden(
                "Only server members can create invites".to_string(),
            ));
        }

        // WHY: Check active invite limit AFTER membership check (no point counting
        // limits for non-members) but BEFORE resource creation to enforce billing constraints.
        // Same TOCTOU tolerance as check_channel_limit — billing guard-rail, not hard DB constraint.
        self.plan_checker.check_invite_limit(&server_id).await?;

        let code = generate_invite_code();
        let invite = Invite {
            code,
            server_id,
            creator_id,
            max_uses,
            use_count: 0,
            expires_at,
            created_at: Utc::now(),
        };

        self.invite_repo.create_invite(&invite).await
    }

    /// Preview an invite by code (no auth required).
    ///
    /// # Errors
    /// - `DomainError::ValidationError` if the code format is invalid.
    /// - `DomainError::NotFound` if the invite does not exist.
    /// - Repository errors on failure.
    pub async fn preview_invite(&self, code: &InviteCode) -> Result<Invite, DomainError> {
        validate_invite_code(code)?;

        self.invite_repo
            .get_by_code(code)
            .await?
            .ok_or_else(|| DomainError::NotFound {
                resource_type: "Invite",
                id: code.to_string(),
            })
    }

    /// Join a server via an invite code.
    ///
    /// Validates the invite, checks the user is not already a member,
    /// increments the use count, and adds the user as a member.
    ///
    /// # Errors
    /// - `DomainError::ValidationError` if the code format is invalid.
    /// - `DomainError::NotFound` if the invite does not exist.
    /// - `DomainError::ValidationError` if the invite is expired or exhausted.
    /// - `DomainError::Conflict` if the user is already a member.
    /// - Repository errors on failure.
    pub async fn join_via_invite(
        &self,
        code: &InviteCode,
        user_id: &UserId,
    ) -> Result<ServerId, DomainError> {
        validate_invite_code(code)?;

        let invite =
            self.invite_repo
                .get_by_code(code)
                .await?
                .ok_or_else(|| DomainError::NotFound {
                    resource_type: "Invite",
                    id: code.to_string(),
                })?;

        if !invite.is_valid() {
            return Err(DomainError::ValidationError(
                "Invite is expired or has reached its maximum uses".to_string(),
            ));
        }

        // WHY: TOCTOU race exists between this ban check and add_member below.
        // A user could be banned between these two calls. This is acceptable:
        // the UNIQUE constraint on server_members prevents duplicates, and the
        // ban check is defense-in-depth. A concurrent ban will still atomically
        // remove the membership via ban_user's transaction.
        let is_banned = self.ban_repo.is_banned(&invite.server_id, user_id).await?;

        if is_banned {
            return Err(DomainError::Forbidden(
                "You are banned from this server".to_string(),
            ));
        }

        let already_member = self
            .member_repo
            .is_member(&invite.server_id, user_id)
            .await?;
        if already_member {
            return Err(DomainError::Conflict(
                "User is already a member of this server".to_string(),
            ));
        }

        // WHY: TOCTOU race exists between this limit check and complete_join below.
        // Two concurrent join requests could both pass, exceeding the limit by one.
        // Acceptable: same pattern as Discord. Plan limits are billing guard-rails,
        // not hard DB constraints. Exact enforcement would require advisory locks.
        //
        // Check plan member limit AFTER already-member check (no point
        // counting limits for someone who's already in) but BEFORE the actual
        // join to enforce billing constraints.
        self.plan_checker
            .check_member_limit(&invite.server_id)
            .await?;

        // WHY: TOCTOU race exists between this limit check and complete_join below.
        // Acceptable: same pattern as channel/member limits. Plan limits are billing
        // guard-rails, not hard DB constraints.
        //
        // Per-user joined server limit — Free: 20, Supporter: 100, Creator: 500.
        // Checked AFTER member limit (server-level) since both must pass.
        self.plan_checker.check_joined_server_limit(user_id).await?;

        self.invite_repo
            .complete_join(code, &invite.server_id, user_id)
            .await?;

        Ok(invite.server_id)
    }
}

/// Generate a random alphanumeric invite code.
fn generate_invite_code() -> InviteCode {
    let mut rng = rand::rng();
    let code: String = (0..INVITE_CODE_LENGTH)
        .map(|_| {
            let idx = rng.random_range(0..INVITE_CODE_CHARSET.len());
            INVITE_CODE_CHARSET[idx] as char
        })
        .collect();
    InviteCode::new(code)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    // ── validate_invite_code ───────────────────────────────────────

    #[test]
    fn invite_code_valid_alphanumeric() {
        assert!(validate_invite_code(&InviteCode::new("abc123XY".to_string())).is_ok());
        assert!(validate_invite_code(&InviteCode::new("A".to_string())).is_ok());
        assert!(validate_invite_code(&InviteCode::new("z".to_string())).is_ok());
        assert!(validate_invite_code(&InviteCode::new("0".to_string())).is_ok());
        assert!(validate_invite_code(&InviteCode::new("9".to_string())).is_ok());
    }

    #[test]
    fn invite_code_max_length_boundary() {
        // Exactly at limit: OK
        let at_limit = "a".repeat(MAX_INVITE_CODE_LENGTH);
        assert!(validate_invite_code(&InviteCode::new(at_limit)).is_ok());

        // One over limit: rejected
        let over_limit = "a".repeat(MAX_INVITE_CODE_LENGTH + 1);
        assert!(validate_invite_code(&InviteCode::new(over_limit)).is_err());
    }

    #[test]
    fn invite_code_empty_rejected() {
        let result = validate_invite_code(&InviteCode::new(String::new()));
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(matches!(err, DomainError::ValidationError(_)));
    }

    #[test]
    fn invite_code_non_alphanumeric_rejected() {
        assert!(validate_invite_code(&InviteCode::new("abc-123".to_string())).is_err()); // hyphen
        assert!(validate_invite_code(&InviteCode::new("abc 123".to_string())).is_err()); // space
        assert!(validate_invite_code(&InviteCode::new("abc_123".to_string())).is_err()); // underscore
        assert!(validate_invite_code(&InviteCode::new("abc.123".to_string())).is_err()); // dot
        assert!(validate_invite_code(&InviteCode::new("abc@123".to_string())).is_err()); // at
        assert!(validate_invite_code(&InviteCode::new("abc!".to_string())).is_err()); // exclamation
    }

    #[test]
    fn invite_code_unicode_rejected() {
        assert!(validate_invite_code(&InviteCode::new("\u{00e9}".to_string())).is_err());
        assert!(validate_invite_code(&InviteCode::new("\u{1f600}".to_string())).is_err());
    }

    // ── generate_invite_code ───────────────────────────────────────

    #[test]
    fn generated_code_has_correct_length() {
        let code = generate_invite_code();
        assert_eq!(code.0.len(), INVITE_CODE_LENGTH);
    }

    #[test]
    fn generated_code_is_alphanumeric() {
        // Run multiple times to increase confidence in randomness.
        for _ in 0..20 {
            let code = generate_invite_code();
            assert!(
                code.0.chars().all(|c| c.is_ascii_alphanumeric()),
                "Generated code '{}' contains non-alphanumeric characters",
                code.0,
            );
        }
    }

    #[test]
    fn generated_code_passes_validation() {
        for _ in 0..20 {
            let code = generate_invite_code();
            assert!(
                validate_invite_code(&code).is_ok(),
                "Generated code '{}' failed validation",
                code.0,
            );
        }
    }
}
