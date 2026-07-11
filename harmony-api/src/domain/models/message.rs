//! Message domain model.
//!
//! Chat messages within a channel. Supports soft delete (ADR-038)
//! and system messages (join/leave announcements).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use url::Url;
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
    /// Whether this message is pinned in its channel. The `is_pinned` flag and
    /// its provenance (`pinned_by`/`pinned_at`) are written atomically by the
    /// single pin write path (`MessageService::set_pinned`).
    pub is_pinned: bool,
    /// WHO pinned this message (moderator+). `Some` iff `is_pinned = true`.
    pub pinned_by: Option<UserId>,
    /// WHEN this message was pinned. `Some` iff `is_pinned = true`.
    pub pinned_at: Option<DateTime<Utc>>,
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

/// Public URL *path prefix* for objects in the `attachments` storage bucket.
///
/// `NewAttachment::try_new` requires the parsed URL PATH to start with this
/// prefix (never a substring match — a substring is trivially satisfiable in
/// a query string or mid-path on an attacker host) AND the URL origin to
/// equal the configured Supabase origin. The client mirror
/// (`parseAttachmentStoragePath`) matches the same string when parsing its
/// own uploaded URLs (non-security use).
pub const ATTACHMENT_PUBLIC_PATH_MARKER: &str = "/storage/v1/object/public/attachments/";

/// Terminal moderation state of an image/file attachment (mirrors the Postgres
/// `attachment_moderation_status` enum). Drives the client render:
/// - `Pending` → blurred "Scanning…" placeholder (default on insert; the bytes
///   are never shown in the clear before a verdict).
/// - `Approved` → normal inline render.
/// - `Gated` → blurred + spoiler + per-viewer click-to-reveal.
/// - `Blocked` → removed-placeholder chip ("not permitted here"); no reveal.
/// - `Quarantined` → the whole message is tombstoned; the URL never reaches a
///   client (CSAM path — Noop this phase, so never produced).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum AttachmentModerationStatus {
    Pending,
    Approved,
    Gated,
    Blocked,
    Quarantined,
}

impl AttachmentModerationStatus {
    /// Postgres enum label. WHY hand-mapped (not the sqlx `Type` derive): the
    /// repository casts the enum column to/from `text` in SQL (mirroring
    /// `message_type`), so no offline-metadata coupling to a custom SQL type.
    #[must_use]
    pub fn as_db_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Approved => "approved",
            Self::Gated => "gated",
            Self::Blocked => "blocked",
            Self::Quarantined => "quarantined",
        }
    }

    /// Parse a Postgres enum label. Unknown values fail CLOSED to `Pending`
    /// (blurred/withheld) — never silently reveal an unrecognized state.
    #[must_use]
    pub fn from_db_str(s: &str) -> Self {
        match s {
            "approved" => Self::Approved,
            "gated" => Self::Gated,
            "blocked" => Self::Blocked,
            "quarantined" => Self::Quarantined,
            _ => Self::Pending,
        }
    }
}

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
    /// Content-moderation verdict. `Pending` until the async scan resolves it
    /// (scan-before-reveal, spec §c.1).
    pub moderation_status: AttachmentModerationStatus,
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
    /// The URL must be a public `attachments`-bucket object on OUR Supabase
    /// instance, uploaded by the message author:
    /// - `allowed_origin` is the configured Supabase origin
    ///   (`scheme://host[:port]`, threaded in from config by the caller —
    ///   the domain layer holds no config). `None` FAILS CLOSED: without a
    ///   pinned origin any host could serve the bucket path, so attachments
    ///   are rejected outright rather than accepted unverified.
    /// - The parsed PATH must start with [`ATTACHMENT_PUBLIC_PATH_MARKER`] —
    ///   a substring match would pass the marker in a query string or
    ///   mid-path on a foreign host.
    /// - The first path segment after the marker must be the author's user
    ///   id: the bucket's INSERT RLS only lets a user write under their own
    ///   `{auth.uid()}/…` prefix, so a legit upload always satisfies this
    ///   and a foreign object (another user's upload) never does.
    ///
    /// # Errors
    /// Returns a static message when any of the URL checks above fail, the
    /// mime is not allowlisted, or the size is not positive.
    pub fn try_new(
        url: String,
        mime: String,
        size: i64,
        width: Option<i32>,
        height: Option<i32>,
        author_id: &UserId,
        allowed_origin: Option<&str>,
    ) -> Result<Self, &'static str> {
        let Some(allowed_origin) = allowed_origin else {
            return Err("Attachments are unavailable: storage origin is not configured");
        };
        let parsed = Url::parse(&url).map_err(|_| "Invalid attachment URL")?;
        // WHY an explicit scheme allowlist even though the origin is compared
        // below: opaque origins (data:, file:, javascript:) all serialize to
        // "null" — two "null"s would compare equal if the configured origin
        // were ever degenerate. http(s) origins are never opaque.
        if parsed.scheme() != "https" && parsed.scheme() != "http" {
            return Err("Invalid attachment URL");
        }
        if parsed.origin().ascii_serialization() != allowed_origin {
            return Err("Invalid attachment URL");
        }
        let Some(object_path) = parsed.path().strip_prefix(ATTACHMENT_PUBLIC_PATH_MARKER) else {
            return Err("Invalid attachment URL");
        };
        let mut segments = object_path.split('/');
        if segments.next().unwrap_or("") != author_id.to_string() {
            return Err("Attachment URL must reference the sender's upload folder");
        }
        if !segments.any(|segment| !segment.is_empty()) {
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

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use uuid::Uuid;

    use super::*;

    /// The origin every valid fixture URL lives on.
    const ORIGIN: &str = "https://xyz.supabase.co";

    fn author() -> UserId {
        UserId::new(Uuid::new_v4())
    }

    fn bucket_url(author_id: &UserId) -> String {
        format!("{ORIGIN}{ATTACHMENT_PUBLIC_PATH_MARKER}{author_id}/file-uuid.webp")
    }

    fn try_new(
        url: &str,
        mime: &str,
        size: i64,
        author_id: &UserId,
    ) -> Result<NewAttachment, &'static str> {
        NewAttachment::try_new(
            url.to_string(),
            mime.to_string(),
            size,
            Some(800),
            Some(600),
            author_id,
            Some(ORIGIN),
        )
    }

    #[test]
    fn try_new_accepts_own_bucket_url_on_configured_origin() {
        let author_id = author();
        let url = bucket_url(&author_id);
        let attachment = try_new(&url, "image/webp", 1024, &author_id).unwrap();
        assert_eq!(attachment.url, url);
        assert_eq!(attachment.width, Some(800));
    }

    /// Regression (review finding): the bucket path marker on a FOREIGN host
    /// must not pass — the old substring check accepted this.
    #[test]
    fn try_new_rejects_marker_in_path_on_foreign_host() {
        let author_id = author();
        let url =
            format!("https://evil.example.com{ATTACHMENT_PUBLIC_PATH_MARKER}{author_id}/x.png");
        assert_eq!(
            try_new(&url, "image/png", 1024, &author_id),
            Err("Invalid attachment URL")
        );
    }

    /// Regression (review finding): the marker in the QUERY STRING must not
    /// pass — the old substring check accepted this too.
    #[test]
    fn try_new_rejects_marker_in_query_string() {
        let author_id = author();
        for host in ["https://evil.com", ORIGIN] {
            let url = format!("{host}/mal.bin?{ATTACHMENT_PUBLIC_PATH_MARKER}");
            assert!(
                try_new(&url, "image/png", 1024, &author_id).is_err(),
                "query-string marker must be rejected on {host}"
            );
        }
    }

    /// The marker mid-path (not a path PREFIX) never passes, even on our origin.
    #[test]
    fn try_new_rejects_marker_mid_path() {
        let author_id = author();
        let url = format!("{ORIGIN}/prefix{ATTACHMENT_PUBLIC_PATH_MARKER}{author_id}/x.png");
        assert_eq!(
            try_new(&url, "image/png", 1024, &author_id),
            Err("Invalid attachment URL")
        );
    }

    /// Another bucket (avatars) on our origin is not the attachments bucket.
    #[test]
    fn try_new_rejects_other_bucket_url() {
        let author_id = author();
        let url = format!("{ORIGIN}/storage/v1/object/public/avatars/{author_id}/file.webp");
        assert!(try_new(&url, "image/webp", 1024, &author_id).is_err());
    }

    /// Non-http(s) schemes never pass, even with the marker embedded.
    #[test]
    fn try_new_rejects_non_http_scheme() {
        let author_id = author();
        let url = format!("javascript:alert(1)//{ATTACHMENT_PUBLIC_PATH_MARKER}x");
        assert!(try_new(&url, "image/png", 1024, &author_id).is_err());
    }

    /// A URL under ANOTHER user's `{uid}/` prefix is rejected: the bucket
    /// INSERT RLS binds uploads to the uploader's folder, so the author of
    /// the message must own the referenced object.
    #[test]
    fn try_new_rejects_other_users_upload_folder() {
        let author_id = author();
        let other = author();
        let url = bucket_url(&other);
        assert_eq!(
            try_new(&url, "image/webp", 1024, &author_id),
            Err("Attachment URL must reference the sender's upload folder")
        );
    }

    /// The bucket prefix alone (no object segment) is not a valid object URL.
    #[test]
    fn try_new_rejects_missing_object_segment() {
        let author_id = author();
        for url in [
            format!("{ORIGIN}{ATTACHMENT_PUBLIC_PATH_MARKER}{author_id}"),
            format!("{ORIGIN}{ATTACHMENT_PUBLIC_PATH_MARKER}{author_id}/"),
        ] {
            assert!(
                try_new(&url, "image/webp", 1024, &author_id).is_err(),
                "{url} must be rejected"
            );
        }
    }

    /// FAIL CLOSED: without a configured storage origin, no URL is verifiable,
    /// so every attachment is rejected (never accepted unverified).
    #[test]
    fn try_new_fails_closed_without_configured_origin() {
        let author_id = author();
        let url = bucket_url(&author_id);
        let result = NewAttachment::try_new(
            url,
            "image/webp".to_string(),
            1024,
            None,
            None,
            &author_id,
            None,
        );
        assert_eq!(
            result,
            Err("Attachments are unavailable: storage origin is not configured")
        );
    }

    /// Mime must be on the bucket allowlist.
    #[test]
    fn try_new_rejects_unlisted_mime() {
        let author_id = author();
        let url = bucket_url(&author_id);
        assert_eq!(
            try_new(&url, "application/x-msdownload", 1024, &author_id),
            Err("Unsupported attachment type")
        );
    }

    /// Size must be strictly positive.
    #[test]
    fn try_new_rejects_non_positive_size() {
        let author_id = author();
        let url = bucket_url(&author_id);
        for size in [0, -1] {
            assert_eq!(
                try_new(&url, "image/png", size, &author_id),
                Err("Attachment size must be positive"),
                "size {size} must be rejected"
            );
        }
    }
}
