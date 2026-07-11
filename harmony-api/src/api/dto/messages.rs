//! Message DTOs (request/response types).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use crate::domain::models::{
    Attachment, AttachmentId, AttachmentModerationStatus, ChannelId, MentionedUser, MessageId,
    MessageType, MessageWithAuthor, ParentMessagePreview, ReactionSummary, UserId,
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
    /// Users mentioned in this message. ONLY honored when `encrypted = true`
    /// (the server cannot parse ciphertext, so the client parses pre-encryption).
    /// For plaintext messages the server parses `<@user_id>` markers itself and
    /// this field is IGNORED. Max 10 entries (`MAX_MENTIONS`).
    ///
    /// Clients MUST omit this key entirely when there are no mentions — never send
    /// `[]` or `null` (house rule; also minimizes the `deny_unknown_fields`
    /// version-skew surface, spec §8).
    #[serde(default)]
    pub mentioned_user_ids: Option<Vec<UserId>>,
    /// Files attached to this message. Each entry references an object the
    /// client already uploaded to the `attachments` Supabase Storage bucket
    /// under its own `{uid}/…` prefix. The server validates the URL belongs to
    /// that bucket, the per-plan count + size caps, then persists the rows
    /// atomically with the message.
    ///
    /// Clients MUST omit this key entirely when there are no attachments —
    /// never send `[]` or `null` (house rule; minimizes the
    /// `deny_unknown_fields` version-skew surface). Rejected with 400 on
    /// `encrypted = true` messages (plaintext attachments only in v1).
    #[serde(default)]
    pub attachments: Option<Vec<NewAttachmentRequest>>,
}

/// A single attachment reference in a `SendMessageRequest`.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NewAttachmentRequest {
    /// Public Storage URL (`…/storage/v1/object/public/attachments/{uid}/{uuid}.{ext}`).
    pub url: String,
    /// Mime type — must be in the bucket allowlist.
    pub mime: String,
    /// Byte size the client reports (used for the per-plan cap; the bucket
    /// enforces the 100MB hard boundary regardless).
    pub size: i64,
    /// Pixel width for images (omit for non-images) — drives no-CLS render.
    #[serde(default)]
    pub width: Option<i32>,
    /// Pixel height for images (omit for non-images).
    #[serde(default)]
    pub height: Option<i32>,
}

// NOTE (deliberate ADR-023 deviation): there is no `TryFrom<NewAttachmentRequest>
// for NewAttachment`. The validation needs request context a `TryFrom` cannot
// carry — the authenticated author id and the configured Supabase origin — so
// the handler calls `NewAttachment::try_new` directly (same pattern as
// `DeviceId::try_new` in `handlers/keys.rs`). Validation tests live next to
// the funnel in `domain/models/message.rs`.

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
    /// Author's display name (if set).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author_display_name: Option<String>,
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
    /// Users mentioned in this message, resolved to display data (server-validated:
    /// deduplicated, author-stripped, channel-access-gated). Drives pill labels,
    /// the mention row highlight and the `mentions` notification level. Users who
    /// left the server still appear (nickname null); deleted accounts are omitted.
    pub mentions: Vec<MentionedUserResponse>,
    /// Files attached to this message, in insertion order.
    pub attachments: Vec<AttachmentResponse>,
    /// Whether this message is pinned in its channel. Always present (defaults
    /// `false`) so the client always knows the state.
    pub is_pinned: bool,
    /// Who pinned it (moderator+). Present only when `is_pinned = true`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pinned_by: Option<UserId>,
    /// When it was pinned. Present only when `is_pinned = true`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pinned_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

/// A file attached to a message.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentResponse {
    pub id: AttachmentId,
    /// Public Storage URL of the uploaded object.
    pub url: String,
    pub mime: String,
    /// Byte size (client-reported at send time).
    pub size: i64,
    /// Pixel width for images; omitted for non-images.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<i32>,
    /// Pixel height for images; omitted for non-images.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<i32>,
    /// Content-moderation verdict driving the client render (blur/reveal/
    /// removed). `nsfwScore` is server-side only and never shipped.
    pub moderation_status: AttachmentModerationStatus,
}

impl From<Attachment> for AttachmentResponse {
    fn from(a: Attachment) -> Self {
        Self {
            id: a.id,
            url: a.url,
            mime: a.mime,
            size: a.size,
            width: a.width,
            height: a.height,
            moderation_status: a.moderation_status,
        }
    }
}

/// A user mentioned in a message, resolved to display data (mirrors
/// `MemberResponse` field naming).
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MentionedUserResponse {
    pub user_id: UserId,
    pub username: String,
    pub display_name: Option<String>,
    pub nickname: Option<String>,
}

impl From<MentionedUser> for MentionedUserResponse {
    fn from(m: MentionedUser) -> Self {
        Self {
            user_id: m.user_id,
            username: m.username,
            display_name: m.display_name,
            nickname: m.nickname,
        }
    }
}

impl From<MessageWithAuthor> for MessageResponse {
    fn from(mwa: MessageWithAuthor) -> Self {
        let mentions = mwa
            .mentions
            .into_iter()
            .map(MentionedUserResponse::from)
            .collect();
        let attachments = mwa
            .attachments
            .into_iter()
            .map(AttachmentResponse::from)
            .collect();
        let reactions = mwa.reactions;
        let parent_message = mwa.parent_message;
        let author_username = mwa.author_username;
        let author_display_name = mwa.author_display_name;
        let author_avatar_url = mwa.author_avatar_url;
        let m = mwa.message;
        Self {
            id: m.id,
            channel_id: m.channel_id,
            author_id: m.author_id,
            author_username,
            author_display_name,
            author_avatar_url,
            content: m.content,
            edited_at: m.edited_at,
            deleted_by: m.deleted_by,
            encrypted: m.encrypted,
            sender_device_id: m.sender_device_id,
            message_type: m.message_type,
            system_event_key: m.system_event_key,
            reactions,
            parent_message_id: m.parent_message_id,
            parent_message,
            moderated_at: m.moderated_at,
            moderation_reason: m.moderation_reason,
            mentions,
            attachments,
            is_pinned: m.is_pinned,
            pinned_by: m.pinned_by,
            pinned_at: m.pinned_at,
            created_at: m.created_at,
        }
    }
}

/// Pinned messages for a channel (bounded, no pagination — capped at `MAX_PINS`).
///
/// WHY no cursor (ADR-036 deviation): the pinned set is hard-capped per channel,
/// so the whole list fits one bounded response — pagination would be dead weight.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PinnedMessagesResponse {
    pub items: Vec<MessageResponse>,
    pub total: i64,
}

impl PinnedMessagesResponse {
    #[must_use]
    pub fn from_messages(messages: Vec<MessageWithAuthor>) -> Self {
        let items: Vec<MessageResponse> = messages.into_iter().map(MessageResponse::from).collect();
        let total = i64::try_from(items.len()).unwrap_or(i64::MAX);
        Self { items, total }
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
    /// Center the returned window on this message (jump-to-message). Mutually
    /// exclusive with `before`; sending both is a 400. The anchor is included
    /// even when soft-deleted so a jump lands on the tombstone.
    pub around: Option<MessageId>,
    /// Maximum number of messages to return (1-100, default 50).
    pub limit: Option<i64>,
}

/// Query parameters for full-text message search.
// WHY no deny_unknown_fields: Axum query deserializer passes every URL param
// (cache-busters etc.) — same reason as MessageListQuery.
#[derive(Debug, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "camelCase")]
#[into_params(parameter_in = Query)]
pub struct MessageSearchQuery {
    /// Full-text query. Required, 1..=200 chars after trim. Parsed by Postgres
    /// `websearch_to_tsquery` ("quoted phrases", OR, -negation supported).
    pub q: Option<String>,
    /// `in:` filter — restrict to a single channel of this server.
    pub channel_id: Option<ChannelId>,
    /// `from:` filter — restrict to a single author.
    pub author_id: Option<UserId>,
    /// `has:` filter. Accepts `link` or `image`. Any other value is ignored.
    /// (Repeatable via comma, e.g. `has=link,image`.)
    pub has: Option<String>,
    /// ISO 8601 keyset cursor — messages created before this time.
    pub before: Option<String>,
    /// Max results (1..=50, default 25).
    pub limit: Option<i64>,
}

/// Search results envelope. Same shape as `MessageListResponse` but a distinct
/// type so future search-only fields (snippets, rank) don't leak into the list
/// endpoint.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MessageSearchResponse {
    pub items: Vec<MessageResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

impl MessageSearchResponse {
    #[must_use]
    pub fn from_messages(messages: Vec<MessageWithAuthor>, next_cursor: Option<String>) -> Self {
        Self {
            items: messages.into_iter().map(MessageResponse::from).collect(),
            next_cursor,
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use chrono::Utc;
    use uuid::Uuid;

    use crate::domain::models::Message;

    fn make_message_with_author(display_name: Option<String>) -> MessageWithAuthor {
        MessageWithAuthor {
            message: Message {
                id: MessageId::from(Uuid::new_v4()),
                channel_id: ChannelId::from(Uuid::new_v4()),
                author_id: UserId::from(Uuid::new_v4()),
                content: "hello".to_string(),
                edited_at: None,
                deleted_at: None,
                deleted_by: None,
                encrypted: false,
                sender_device_id: None,
                message_type: MessageType::Default,
                system_event_key: None,
                parent_message_id: None,
                moderated_at: None,
                moderation_reason: None,
                original_content: None,
                mentioned_user_ids: vec![],
                is_pinned: false,
                pinned_by: None,
                pinned_at: None,
                created_at: Utc::now(),
            },
            author_username: "alice".to_string(),
            author_display_name: display_name,
            author_avatar_url: None,
            reactions: vec![],
            parent_message: None,
            mentions: vec![],
            attachments: vec![],
        }
    }

    /// WHY: `authorDisplayName` is how the SPA resolves the render chain
    /// (`displayName ?? username`). The From conversion must carry it through
    /// and serde must emit the camelCase key (ADR-039).
    #[test]
    fn message_response_carries_author_display_name() {
        let mwa = make_message_with_author(Some("Alice Doe".to_string()));
        let response = MessageResponse::from(mwa);

        assert_eq!(response.author_username, "alice");
        assert_eq!(response.author_display_name, Some("Alice Doe".to_string()));

        let json = serde_json::to_value(&response).unwrap();
        assert_eq!(json["authorUsername"], "alice");
        assert_eq!(json["authorDisplayName"], "Alice Doe");
    }

    /// WHY: `skip_serializing_if` must omit the key entirely when the author
    /// has no display name — old clients tolerate a missing optional field.
    #[test]
    fn message_response_omits_absent_author_display_name() {
        let response = MessageResponse::from(make_message_with_author(None));

        let json = serde_json::to_value(&response).unwrap();
        assert!(json.get("authorDisplayName").is_none());
    }

    // ── Attachments (T1.3) ───────────────────────────────────────────
    // URL/mime/size validation tests live next to the funnel
    // (`NewAttachment::try_new`) in `domain/models/message.rs`.

    const VALID_ATTACHMENT_URL: &str =
        "https://xyz.supabase.co/storage/v1/object/public/attachments/user-uuid/file-uuid.webp";

    /// `attachments` rides the response in camelCase; absent dims are omitted.
    #[test]
    fn message_response_serializes_attachments_camel_case() {
        let mut mwa = make_message_with_author(None);
        mwa.attachments = vec![Attachment {
            id: crate::domain::models::AttachmentId::from(Uuid::new_v4()),
            message_id: mwa.message.id.clone(),
            url: VALID_ATTACHMENT_URL.to_string(),
            mime: "application/pdf".to_string(),
            size: 2048,
            width: None,
            height: None,
            moderation_status: AttachmentModerationStatus::Approved,
            created_at: Utc::now(),
        }];

        let json = serde_json::to_value(MessageResponse::from(mwa)).unwrap();
        let attachment = &json["attachments"][0];
        assert_eq!(attachment["url"], VALID_ATTACHMENT_URL);
        assert_eq!(attachment["mime"], "application/pdf");
        assert_eq!(attachment["size"], 2048);
        // Non-image dims are omitted entirely, not null.
        assert!(attachment.get("width").is_none());
        assert!(attachment.get("height").is_none());
    }

    /// A request without the `attachments` key deserializes to `None`
    /// (rollout-safe: old clients keep working).
    #[test]
    fn send_message_request_attachments_key_optional() {
        let req: SendMessageRequest = serde_json::from_str(r#"{"content": "hello"}"#).unwrap();
        assert!(req.attachments.is_none());

        let req: SendMessageRequest = serde_json::from_str(&format!(
            r#"{{"content": "", "attachments": [{{"url": "{VALID_ATTACHMENT_URL}", "mime": "image/webp", "size": 10, "width": 4, "height": 4}}]}}"#
        ))
        .unwrap();
        assert_eq!(req.attachments.unwrap().len(), 1);
    }

    /// `deny_unknown_fields` on the nested DTO — a stray key is a 400.
    #[test]
    fn new_attachment_request_rejects_unknown_fields() {
        let result = serde_json::from_str::<NewAttachmentRequest>(&format!(
            r#"{{"url": "{VALID_ATTACHMENT_URL}", "mime": "image/webp", "size": 10, "sneaky": true}}"#
        ));
        assert!(result.is_err());
    }
}
