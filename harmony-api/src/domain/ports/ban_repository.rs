//! Port: server ban persistence.

use async_trait::async_trait;

use crate::domain::errors::DomainError;
use crate::domain::models::{ServerBan, ServerId, UserId};

/// Intent-based repository for server bans.
#[async_trait]
pub trait BanRepository: Send + Sync + std::fmt::Debug {
    /// Ban a user from a server and remove their membership atomically.
    ///
    /// Transaction order: INSERT ban → DELETE member.
    /// Returns `DomainError::Conflict` if the user is already banned.
    async fn ban_user(
        &self,
        server_id: &ServerId,
        user_id: &UserId,
        banned_by: &UserId,
        reason: Option<String>,
    ) -> Result<ServerBan, DomainError>;

    /// Remove a ban, allowing the user to rejoin via invite.
    ///
    /// Returns `DomainError::NotFound` if the ban does not exist.
    async fn unban_user(&self, server_id: &ServerId, user_id: &UserId) -> Result<(), DomainError>;

    /// List all bans for a server.
    async fn list_bans(&self, server_id: &ServerId) -> Result<Vec<ServerBan>, DomainError>;

    /// Check if a user is banned from a server.
    async fn is_banned(&self, server_id: &ServerId, user_id: &UserId) -> Result<bool, DomainError>;
}
