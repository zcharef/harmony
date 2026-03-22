//! Message DTOs (request/response types).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use crate::domain::models::{ChannelId, Message, MessageId, UserId};

/// Request body for sending a new message.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SendMessageRequest {
    /// Message content (required, non-empty).
    pub content: String,
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
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edited_at: Option<DateTime<Utc>>,
    /// WHO deleted this message. `None` for live messages; `Some` for
    /// soft-deleted messages delivered via realtime.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted_by: Option<UserId>,
    pub created_at: DateTime<Utc>,
}

impl From<Message> for MessageResponse {
    fn from(m: Message) -> Self {
        Self {
            id: m.id,
            channel_id: m.channel_id,
            author_id: m.author_id,
            content: m.content,
            edited_at: m.edited_at,
            deleted_by: m.deleted_by,
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
    /// Build from domain messages with an optional cursor for the next page.
    #[must_use]
    pub fn from_messages(messages: Vec<Message>, next_cursor: Option<String>) -> Self {
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
