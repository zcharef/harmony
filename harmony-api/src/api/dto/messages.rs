//! Message DTOs (request/response types).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use crate::domain::models::{
    ChannelId, MessageId, MessageType, MessageWithAuthor, ParentMessagePreview, ReactionSummary,
    UserId,
};

/// Request body for sending a new message.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SendMessageRequest {
    /// Message content (required, non-empty). Contains ciphertext when `encrypted = true`.
    pub content: String,
    /// Whether this message contains E2EE ciphertext. Defaults to `false`.
    pub encrypted: Option<bool>,
    /// Device ID of the sending device. Required when `encrypted = true`.
    pub sender_device_id: Option<String>,
    /// Parent message ID for reply threading. Omit for top-level messages.
    #[serde(default)]
    pub parent_message_id: Option<MessageId>,
}

/// Request body for editing a message.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditMessageRequest {
    /// Updated message content (required, non-empty).
    pub content: String,
}

/// Message response returned to API consumers.
///
/// Soft-deleted messages are filtered from list queries, but `deleted_by`
/// is included so realtime-delivered tombstones can distinguish self-deletes
/// from moderator-deletes on the client.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MessageResponse {
    pub id: MessageId,
    pub channel_id: ChannelId,
    pub author_id: UserId,
    /// Author's username from their profile.
    pub author_username: String,
    /// Author's avatar URL (if set).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author_avatar_url: Option<String>,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edited_at: Option<DateTime<Utc>>,
    /// WHO deleted this message. `None` for live messages; `Some` for
    /// soft-deleted messages delivered via realtime.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted_by: Option<UserId>,
    /// Whether this message contains E2EE ciphertext.
    pub encrypted: bool,
    /// Device ID of the sender. Present when `encrypted = true`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sender_device_id: Option<String>,
    /// `default` for user messages, `system` for announcements.
    pub message_type: MessageType,
    /// System event key (e.g. `member_join`). Only present for system messages.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_event_key: Option<String>,
    /// Aggregated reaction summaries for this message.
    #[serde(default)]
    pub reactions: Vec<ReactionSummary>,
    /// Parent message ID when this is a reply.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_message_id: Option<MessageId>,
    /// Preview of the parent message (author + content snippet).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_message: Option<ParentMessagePreview>,
    /// When `AutoMod` flagged this message. Content is already masked.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub moderated_at: Option<DateTime<Utc>>,
    /// Why `AutoMod` flagged this message.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub moderation_reason: Option<String>,
    pub created_at: DateTime<Utc>,
}

impl From<MessageWithAuthor> for MessageResponse {
    fn from(mwa: MessageWithAuthor) -> Self {
        let m = mwa.message;
        Self {
            id: m.id,
            channel_id: m.channel_id,
            author_id: m.author_id,
            author_username: mwa.author_username,
            author_avatar_url: mwa.author_avatar_url,
            content: m.content,
            edited_at: m.edited_at,
            deleted_by: m.deleted_by,
            encrypted: m.encrypted,
            sender_device_id: m.sender_device_id,
            message_type: m.message_type,
            system_event_key: m.system_event_key,
            reactions: mwa.reactions,
            parent_message_id: m.parent_message_id,
            parent_message: mwa.parent_message,
            moderated_at: m.moderated_at,
            moderation_reason: m.moderation_reason,
            created_at: m.created_at,
        }
    }
}

/// Envelope for a list of messages with cursor pagination (ADR-036).
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MessageListResponse {
    pub items: Vec<MessageResponse>,
    /// Cursor for the next page. `None` if this is the last page.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

impl MessageListResponse {
    /// Build from enriched messages with an optional cursor for the next page.
    #[must_use]
    pub fn from_messages(messages: Vec<MessageWithAuthor>, next_cursor: Option<String>) -> Self {
        Self {
            items: messages.into_iter().map(MessageResponse::from).collect(),
            next_cursor,
        }
    }
}

/// Query parameters for listing messages (cursor-based pagination).
// WHY: Query parameter structs cannot use deny_unknown_fields because
// Axum's query deserializer passes all URL query params to the struct,
// and extra params (e.g., cache-busters) would cause 400 errors.
#[derive(Debug, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "camelCase")]
#[into_params(parameter_in = Query)]
pub struct MessageListQuery {
    /// ISO 8601 timestamp cursor — fetch messages created before this time.
    pub before: Option<String>,
    /// Maximum number of messages to return (1-100, default 50).
    pub limit: Option<i64>,
}
