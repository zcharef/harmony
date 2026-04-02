//! Port: Megolm session persistence.

use async_trait::async_trait;

use crate::domain::errors::DomainError;
use crate::domain::models::{ChannelId, MegolmSession, UserId};

/// Intent-based repository for Megolm E2EE sessions.
#[async_trait]
pub trait MegolmSessionRepository: Send + Sync + std::fmt::Debug {
    /// Store a Megolm session for an encrypted channel.
    ///
    /// If a session with the same `(channel_id, session_id)` already exists,
    /// the existing record is returned (idempotent upsert).
    async fn store_session(
        &self,
        channel_id: &ChannelId,
        session_id: &str,
        creator_id: &UserId,
    ) -> Result<MegolmSession, DomainError>;
}
