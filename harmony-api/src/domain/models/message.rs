//! Message domain model.
//!
//! Chat messages within a channel. Supports soft delete (ADR-038)
//! and system messages (join/leave announcements).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::ids::{ChannelId, MessageId, UserId};

/// Discriminates user messages from system announcements.
///
/// `Default` = regular user message. `System` = server-generated event
/// (join, leave, etc.) whose display text is resolved from `system_event_key`
/// on the frontend via i18n templates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum MessageType {
    Default,
    System,
}

/// A chat message.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: MessageId,
    pub channel_id: ChannelId,
    pub author_id: UserId,
    pub content: String,
    pub edited_at: Option<DateTime<Utc>>,
    /// Soft delete timestamp (ADR-038). `Some` means the message is deleted.
    pub deleted_at: Option<DateTime<Utc>>,
    /// WHO deleted this message. Enables the frontend to distinguish
    /// self-deletes from moderator-deletes.
    pub deleted_by: Option<UserId>,
    /// Whether this message contains E2EE ciphertext.
    pub encrypted: bool,
    /// Device that sent this encrypted message. Required when `encrypted = true`
    /// so recipients know which Olm session to use for decryption.
    pub sender_device_id: Option<String>,
    /// `Default` for user messages, `System` for announcements.
    pub message_type: MessageType,
    /// Event key for system messages (e.g. `member_join`). Frontend resolves
    /// this to a localized template. Always `None` for default messages.
    pub system_event_key: Option<String>,
    /// Parent message ID for reply threading. `None` for top-level messages.
    pub parent_message_id: Option<MessageId>,
    pub created_at: DateTime<Utc>,
}

/// Lightweight preview of a parent message for reply display.
///
/// Sent alongside reply messages so the client can render a quote block
/// without an extra API call.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ParentMessagePreview {
    pub id: MessageId,
    pub author_username: String,
    /// First 100 characters of the parent message content.
    pub content_preview: String,
}
