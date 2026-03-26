//! Port: message persistence.

use async_trait::async_trait;
use chrono::{DateTime, Utc};

use crate::domain::errors::DomainError;
use crate::domain::models::{ChannelId, Message, MessageId, MessageWithAuthor, UserId};

/// Intent-based repository for messages.
#[async_trait]
pub trait MessageRepository: Send + Sync + std::fmt::Debug {
    /// Create a new message in a channel.
    async fn create(
        &self,
        channel_id: &ChannelId,
        author_id: &UserId,
        content: String,
    ) -> Result<MessageWithAuthor, DomainError>;

    /// List messages in a channel with cursor-based pagination (ADR-036).
    ///
    /// Returns messages older than `cursor` (if provided), limited to `limit` rows.
    async fn list_for_channel(
        &self,
        channel_id: &ChannelId,
        cursor: Option<DateTime<Utc>>,
        limit: i64,
    ) -> Result<Vec<MessageWithAuthor>, DomainError>;

    /// Find a message by ID (returns `None` if not found OR soft-deleted).
    async fn find_by_id(&self, message_id: &MessageId) -> Result<Option<Message>, DomainError>;

    /// Update message content. Sets `is_edited=true`, `edited_at=now()`.
    /// Returns the updated message.
    async fn update_content(
        &self,
        message_id: &MessageId,
        content: String,
    ) -> Result<MessageWithAuthor, DomainError>;

    /// Soft-delete a message (ADR-038). Sets `deleted_at=now()` and `deleted_by`.
    async fn soft_delete(
        &self,
        message_id: &MessageId,
        deleted_by: &UserId,
    ) -> Result<(), DomainError>;

    /// Count non-deleted messages by an author in a channel within the last `window_secs` seconds.
    ///
    /// Used for per-channel rate limiting in `MessageService::create`.
    async fn count_recent(
        &self,
        channel_id: &ChannelId,
        author_id: &UserId,
        window_secs: i64,
    ) -> Result<i64, DomainError>;
}
