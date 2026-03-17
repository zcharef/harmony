//! Port: invite persistence.

use async_trait::async_trait;

use crate::domain::errors::DomainError;
use crate::domain::models::{Invite, InviteCode, ServerId, UserId};

/// Intent-based repository for server invites.
#[async_trait]
pub trait InviteRepository: Send + Sync + std::fmt::Debug {
    /// Persist a new invite.
    async fn create(&self, invite: &Invite) -> Result<Invite, DomainError>;

    /// Look up an invite by its code. Returns `None` if not found.
    async fn get_by_code(&self, code: &InviteCode) -> Result<Option<Invite>, DomainError>;

    /// Atomically increment the invite use count and add the user as a server member.
    ///
    /// WHY: These two operations must be atomic — if `add_member` fails after
    /// `increment_use_count` succeeds, an invite use is silently lost.
    async fn complete_join(
        &self,
        code: &InviteCode,
        server_id: &ServerId,
        user_id: &UserId,
    ) -> Result<(), DomainError>;

    /// List all invites for a server.
    async fn list_by_server(&self, server_id: &ServerId) -> Result<Vec<Invite>, DomainError>;

    /// Delete an invite by its code.
    async fn delete_by_code(&self, code: &InviteCode) -> Result<(), DomainError>;
}
