//! Port: message persistence.

use async_trait::async_trait;
use chrono::{DateTime, Utc};

use crate::domain::errors::DomainError;
use crate::domain::models::{ChannelId, Message, MessageId, MessageWithAuthor, UserId};

/// Intent-based repository for messages.
#[async_trait]
pub trait MessageRepository: Send + Sync + std::fmt::Debug {
    /// Send a new message to a channel.
    #[allow(clippy::too_many_arguments)]
    async fn send_to_channel(
        &self,
        channel_id: &ChannelId,
        author_id: &UserId,
        content: String,
        encrypted: bool,
        sender_device_id: Option<String>,
        parent_message_id: Option<MessageId>,
        moderated_at: Option<DateTime<Utc>>,
        moderation_reason: Option<String>,
        original_content: Option<String>,
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
        moderated_at: Option<DateTime<Utc>>,
        moderation_reason: Option<String>,
        original_content: Option<String>,
    ) -> Result<MessageWithAuthor, DomainError>;

    /// Soft-delete a message (ADR-038). Sets `deleted_at=now()` and `deleted_by`.
    ///
    /// When `checked_at` is `Some(ts)`, the UPDATE includes an atomic stale-content
    /// guard: `AND COALESCE(edited_at, created_at) = ts`. If the message was edited
    /// after `ts`, the UPDATE matches zero rows and the method returns `Ok(())`
    /// (stale moderation result — skip silently). When `checked_at` is `None`,
    /// the guard is skipped (user-initiated deletes always proceed).
    async fn soft_delete(
        &self,
        message_id: &MessageId,
        deleted_by: &UserId,
        checked_at: Option<DateTime<Utc>>,
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

    /// Get the timestamp of the last non-deleted message by this author in this channel.
    ///
    /// Used for slow mode enforcement in `MessageService::create`.
    async fn get_last_message_time(
        &self,
        channel_id: &ChannelId,
        author_id: &UserId,
    ) -> Result<Option<DateTime<Utc>>, DomainError>;

    /// Create a system message (e.g. join announcement).
    ///
    /// `author_id` is the subject of the event (the user who joined, left, etc.)
    /// — NOT a "sender". Content is empty; the frontend renders localized text
    /// from `system_event_key`.
    async fn create_system(
        &self,
        channel_id: &ChannelId,
        author_id: &UserId,
        system_event_key: String,
    ) -> Result<MessageWithAuthor, DomainError>;
}
