//! Message domain model.
//!
//! Chat messages within a channel. Supports soft delete (ADR-038)
//! and system messages (join/leave announcements).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::ids::{AttachmentId, ChannelId, MessageId, UserId};

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
    /// When `AutoMod` flagged this message. `Some` = content was masked.
    pub moderated_at: Option<DateTime<Utc>>,
    /// Generic reason for moderation (never the matched word itself).
    pub moderation_reason: Option<String>,
    /// Original unmasked content before `AutoMod`. Only set when moderated.
    /// NOT exposed through any API endpoint — reserved for future appeals.
    #[serde(skip_serializing)]
    pub original_content: Option<String>,
    /// Server-validated mention targets (deduped, author-stripped,
    /// channel-access-gated). For plaintext messages the server parses the
    /// `<@uuid>` markers; for E2EE messages it stores the client-provided
    /// sidecar (deliberate metadata leak — see spec §6). Drives targeted
    /// `mention.received` events and the computed mention badge counts.
    pub mentioned_user_ids: Vec<UserId>,
    pub created_at: DateTime<Utc>,
}

/// A user mentioned in a message, resolved to display data for the response
/// `mentions` array (the Discord model). Resolved at read time so labels are
/// always current. Users who left the server still resolve (`nickname = None`);
/// deleted accounts (no profile row) are omitted.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MentionedUser {
    pub user_id: UserId,
    pub username: String,
    pub display_name: Option<String>,
    pub nickname: Option<String>,
}

/// Mime types accepted for message attachments.
///
/// WHY duplicated from the migration: the `attachments` storage bucket
/// enforces this list at upload time (hard boundary); the API re-checks it at
/// message-send time so a client cannot persist an attachment row claiming a
/// mime the bucket would never store. Keep both lists in sync
/// (`20260711100000_create_message_attachments.sql`).
pub const ALLOWED_ATTACHMENT_MIME: &[&str] = &[
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "image/avif",
    "application/pdf",
    "text/plain",
    "application/zip",
    "video/mp4",
    "video/webm",
    "audio/mpeg",
    "audio/ogg",
    "audio/wav",
];

/// Public URL marker for objects in the `attachments` storage bucket.
///
/// WHY a marker (not a full-origin prefix): the domain layer has no access to
/// the Supabase URL config (hexagonal purity), and the client mirror
/// (`parseAttachmentStoragePath`) matches the same substring. The check stops
/// arbitrary external URLs from being persisted as "attachments"; the bucket
/// RLS + uuid paths are the actual security boundary (ticket decision D6).
pub const ATTACHMENT_PUBLIC_PATH_MARKER: &str = "/storage/v1/object/public/attachments/";

/// A file attached to a message (persisted row).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: AttachmentId,
    pub message_id: MessageId,
    /// Public Storage URL (`…/storage/v1/object/public/attachments/{uid}/{uuid}.{ext}`).
    pub url: String,
    pub mime: String,
    /// Byte size as reported by the client at send time (per-plan cap input).
    pub size: i64,
    /// Pixel width for images; `None` for non-images.
    pub width: Option<i32>,
    /// Pixel height for images; `None` for non-images.
    pub height: Option<i32>,
    pub created_at: DateTime<Utc>,
}

/// A validated attachment awaiting insertion (pre-persist form).
///
/// Constructed only via [`NewAttachment::try_new`], which is the single
/// validation funnel (parse, don't validate).
#[derive(Debug, Clone, PartialEq)]
pub struct NewAttachment {
    pub url: String,
    pub mime: String,
    pub size: i64,
    pub width: Option<i32>,
    pub height: Option<i32>,
}

impl NewAttachment {
    /// Validated construction for an attachment reference.
    ///
    /// # Errors
    /// Returns a static message when the URL is not an `attachments`-bucket
    /// public URL, the mime is not allowlisted, or the size is not positive.
    pub fn try_new(
        url: String,
        mime: String,
        size: i64,
        width: Option<i32>,
        height: Option<i32>,
    ) -> Result<Self, &'static str> {
        let is_https = url.starts_with("https://") || url.starts_with("http://");
        if !is_https || !url.contains(ATTACHMENT_PUBLIC_PATH_MARKER) {
            return Err("Invalid attachment URL");
        }
        if !ALLOWED_ATTACHMENT_MIME.contains(&mime.as_str()) {
            return Err("Unsupported attachment type");
        }
        if size <= 0 {
            return Err("Attachment size must be positive");
        }
        Ok(Self {
            url,
            mime,
            size,
            width,
            height,
        })
    }
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
    /// WHY: When true, the parent message was soft-deleted. The frontend
    /// renders "[Original message was deleted]" instead of the content.
    /// `author_username` and `content_preview` are empty when deleted
    /// to avoid leaking content or identity.
    pub deleted: bool,
}
