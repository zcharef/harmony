//! Invite domain service.

use std::sync::Arc;

use chrono::{DateTime, Utc};
use rand::Rng;

use crate::domain::errors::DomainError;
use crate::domain::models::{Invite, InviteCode, ServerId, UserId};
use crate::domain::ports::{InviteRepository, MemberRepository};

/// Length of generated invite codes (alphanumeric).
const INVITE_CODE_LENGTH: usize = 8;

/// Characters used for invite code generation.
const INVITE_CODE_CHARSET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/// Service for invite-related business logic.
#[derive(Debug)]
pub struct InviteService {
    invite_repo: Arc<dyn InviteRepository>,
    member_repo: Arc<dyn MemberRepository>,
}

impl InviteService {
    #[must_use]
    pub fn new(
        invite_repo: Arc<dyn InviteRepository>,
        member_repo: Arc<dyn MemberRepository>,
    ) -> Self {
        Self {
            invite_repo,
            member_repo,
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
        // Only members can create invites
        let is_member = self
            .member_repo
            .is_member(&server_id, &creator_id)
            .await?;
        if !is_member {
            return Err(DomainError::Forbidden(
                "Only server members can create invites".to_string(),
            ));
        }

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

        self.invite_repo.create(&invite).await
    }

    /// Preview an invite by code (no auth required).
    ///
    /// # Errors
    /// - `DomainError::NotFound` if the invite does not exist.
    /// - Repository errors on failure.
    pub async fn preview_invite(&self, code: &InviteCode) -> Result<Invite, DomainError> {
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
    /// - `DomainError::NotFound` if the invite does not exist.
    /// - `DomainError::ValidationError` if the invite is expired or exhausted.
    /// - `DomainError::Conflict` if the user is already a member.
    /// - Repository errors on failure.
    pub async fn join_via_invite(
        &self,
        code: &InviteCode,
        user_id: &UserId,
    ) -> Result<ServerId, DomainError> {
        let invite = self
            .invite_repo
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

        let already_member = self
            .member_repo
            .is_member(&invite.server_id, user_id)
            .await?;
        if already_member {
            return Err(DomainError::Conflict(
                "User is already a member of this server".to_string(),
            ));
        }

        self.invite_repo.increment_use_count(code).await?;
        self.member_repo
            .add_member(&invite.server_id, user_id)
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
