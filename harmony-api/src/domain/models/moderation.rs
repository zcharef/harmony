//! Moderation domain models.
//!
//! Per-server AI moderation configuration, separate from the `Server` model
//! to avoid rippling through every SELECT/DTO.

use std::collections::HashMap;

use chrono::{DateTime, Utc};

use super::ids::{AttachmentId, ChannelId, MessageId, ModerationRetryId, ServerId, UserId};

/// Per-server AI moderation configuration (Tier 2 category toggles).
/// WHY: Separate from `Server` to avoid rippling through every SELECT/DTO.
/// Only fetched by the moderation pipeline and settings endpoints.
#[derive(Debug, Clone)]
pub struct ServerModerationSettings {
    pub server_id: ServerId,
    pub categories: HashMap<String, bool>,
}

/// A failed moderation check awaiting retry.
/// WHY: When the `OpenAI` Moderation API fails (retries exhausted) for a
/// Tier 1 category check, letting the message pass unmoderated is
/// unacceptable. This dead-letter record captures the failure for
/// background retry.
#[derive(Debug, Clone)]
pub struct ModerationRetry {
    pub id: ModerationRetryId,
    pub message_id: MessageId,
    pub server_id: ServerId,
    pub channel_id: ChannelId,
    pub content: String,
    pub retry_count: i32,
    pub last_error: Option<String>,
    pub created_at: DateTime<Utc>,
}

/// A failed image content-moderation scan awaiting retry (image analogue of
/// [`ModerationRetry`], keyed by attachment). Fail-closed: while a row exists
/// the attachment stays `pending` (blurred/withheld). The sweep re-runs the
/// scan and clears the row on success.
#[derive(Debug, Clone)]
pub struct AttachmentScanRetry {
    pub attachment_id: AttachmentId,
    pub message_id: MessageId,
    pub channel_id: ChannelId,
    /// Public object URL to re-fetch and scan.
    pub url: String,
    pub mime: String,
    pub retry_count: i32,
    pub last_error: Option<String>,
    pub created_at: DateTime<Utc>,
}

/// A failed identity-image (avatar/banner) content-moderation scan awaiting
/// retry — the identity analogue of [`AttachmentScanRetry`], keyed by
/// `(user_id, image_kind)`. Fail-closed: while a row exists the candidate stays
/// in `pending_{kind}_url` (never revealed). The sweep re-runs the scan.
#[derive(Debug, Clone)]
pub struct IdentityImageScanRetry {
    pub user_id: UserId,
    pub kind: super::IdentityImageKind,
    /// Public object URL to re-fetch and scan.
    pub url: String,
    pub retry_count: i32,
    pub last_error: Option<String>,
    pub created_at: DateTime<Utc>,
}
