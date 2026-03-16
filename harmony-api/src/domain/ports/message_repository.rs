//! Port: message persistence.

use async_trait::async_trait;
use chrono::{DateTime, Utc};

use crate::domain::errors::DomainError;
use crate::domain::models::{ChannelId, Message, UserId};

/// Intent-based repository for messages.
#[async_trait]
pub trait MessageRepository: Send + Sync + std::fmt::Debug {
    /// Create a new message in a channel.
    async fn create(
        &self,
        channel_id: &ChannelId,
        author_id: &UserId,
        content: String,
    ) -> Result<Message, DomainError>;

    /// List messages in a channel with cursor-based pagination (ADR-036).
    ///
    /// Returns messages older than `cursor` (if provided), limited to `limit` rows.
    async fn list_for_channel(
        &self,
        channel_id: &ChannelId,
        cursor: Option<DateTime<Utc>>,
        limit: i64,
    ) -> Result<Vec<Message>, DomainError>;
}
