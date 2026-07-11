//! Server-sent events for real-time updates.
//!
//! Each variant maps to an SSE event type (e.g. `message.created`).
//! Events carry full payload data so the client never needs to
//! resolve IDs from cache (ADR-SSE-003).

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::Attachment;
use super::AttachmentModerationStatus;
use super::Channel;
use super::ChannelType;
use super::IdentityImageModerationStatus;
use super::MentionedUser;
use super::MessageWithAuthor;
use super::ServerEmoji;
use super::UserStatus;
use super::friendship::RequestDirection;
use super::ids::{AttachmentId, ChannelId, EmojiId, MessageId, ServerId, UserId};
use super::message::MessageType;
use super::role::Role;
use super::voice_session::VoiceAction;

// ── Payload structs ──────────────────────────────────────────────

/// Slim attachment shape for the SSE wire.
///
/// WHY not the full domain [`Attachment`]: `message_id` and `created_at` are
/// wire-dead weight (the client schema never read them) and every byte counts
/// against the 7500-byte `pg_notify` envelope cap — a max-attachments message
/// must stay deliverable cross-instance. Dims are omitted (not `null`) when
/// absent for the same reason.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentPayload {
    pub id: AttachmentId,
    pub url: String,
    pub mime: String,
    pub size: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<i32>,
    /// Content-moderation verdict — drives the client render (blur/reveal/
    /// removed). `nsfwScore` is deliberately NOT on the wire (server-side only).
    ///
    /// WHY `default`: rollout-safe (mirrors `mentions`/`attachments`) — an older
    /// instance publishes this payload WITHOUT the key over `pg_notify`; the
    /// `default` fails CLOSED to `Pending` (blurred) rather than dropping the
    /// event or revealing an unscanned image.
    #[serde(default = "default_pending_status")]
    pub moderation_status: AttachmentModerationStatus,
}

/// Fail-closed default for the rollout-window `moderation_status` gap.
fn default_pending_status() -> AttachmentModerationStatus {
    AttachmentModerationStatus::Pending
}

impl From<Attachment> for AttachmentPayload {
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

/// Message payload embedded in message events.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagePayload {
    pub id: MessageId,
    pub channel_id: ChannelId,
    pub content: String,
    pub author_id: UserId,
    pub author_username: String,
    pub author_display_name: Option<String>,
    pub author_avatar_url: Option<String>,
    pub encrypted: bool,
    pub sender_device_id: Option<String>,
    pub edited_at: Option<DateTime<Utc>>,
    pub parent_message_id: Option<MessageId>,
    /// `default` for user messages, `system` for announcements.
    pub message_type: MessageType,
    /// System event key (e.g. `member_join`). Only present for system messages.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_event_key: Option<String>,
    /// When `AutoMod` flagged this message. Content is already masked.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub moderated_at: Option<DateTime<Utc>>,
    /// Why `AutoMod` flagged this message.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub moderation_reason: Option<String>,
    /// Server-resolved mentioned users (the Discord `mentions` array). Rides both
    /// `message.created` and `message.updated` so pills render and the `mentions`
    /// notification level applies without a second lookup.
    ///
    /// WHY `default`: during the rollout window an older instance publishes this
    /// payload WITHOUT the field over `pg_notify`; `default` lets a new instance
    /// deserialize it (empty mentions) instead of dropping the event.
    #[serde(default)]
    pub mentions: Vec<MentionedUser>,
    /// Files attached to this message (slim wire shape). Rides both
    /// `message.created` and `message.updated` so every reader renders
    /// attachments live, no refetch.
    ///
    /// WHY `default`: same rollout reasoning as `mentions` — an older instance
    /// publishes this payload WITHOUT the field over `pg_notify`; `default`
    /// lets a new instance deserialize it (empty attachments) instead of
    /// dropping the event. No new `ServerEvent` variant (ticket decision D9).
    /// An oversize envelope sheds this field before `pg_notify` (see
    /// [`ServerEvent::shed_attachments`]) rather than dropping the event.
    #[serde(default)]
    pub attachments: Vec<AttachmentPayload>,
    /// Whether this message is pinned in its channel. Rides `message.created`/
    /// `updated`/`pinned`/`unpinned` so every client's cache keeps `isPinned`
    /// convergent without a refetch.
    ///
    /// WHY `default`: rollout-safe (mirrors `mentions`/`attachments`) — an older
    /// instance publishes this payload WITHOUT the key over `pg_notify`; a new
    /// instance deserializes it as `false` rather than dropping the event.
    #[serde(default)]
    pub is_pinned: bool,
    /// Who pinned it (moderator+). Present only when `is_pinned = true`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned_by: Option<UserId>,
    /// When it was pinned. Present only when `is_pinned = true`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

impl From<MessageWithAuthor> for MessagePayload {
    fn from(mwa: MessageWithAuthor) -> Self {
        let mentions = mwa.mentions;
        let attachments = mwa
            .attachments
            .into_iter()
            .map(AttachmentPayload::from)
            .collect();
        let m = mwa.message;
        Self {
            id: m.id,
            channel_id: m.channel_id,
            content: m.content,
            author_id: m.author_id,
            author_username: mwa.author_username,
            author_display_name: mwa.author_display_name,
            author_avatar_url: mwa.author_avatar_url,
            encrypted: m.encrypted,
            sender_device_id: m.sender_device_id,
            edited_at: m.edited_at,
            parent_message_id: m.parent_message_id,
            message_type: m.message_type,
            system_event_key: m.system_event_key,
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

/// Member payload embedded in member events.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberPayload {
    pub user_id: UserId,
    pub username: String,
    pub avatar_url: Option<String>,
    pub nickname: Option<String>,
    pub role: Role,
    /// Whether this member holds the `founding` badge. Carried on the event so
    /// a live cache update (join / role change) keeps the badge correct without
    /// a refetch — a role change must not drop a founding member's badge.
    pub is_founding: bool,
    pub joined_at: DateTime<Utc>,
}

/// Ban payload embedded in `MemberBanned`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BanPayload {
    pub reason: Option<String>,
    pub banned_by: Option<UserId>,
    pub created_at: DateTime<Utc>,
}

/// Channel payload embedded in channel events.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelPayload {
    pub id: ChannelId,
    pub name: String,
    pub topic: Option<String>,
    pub channel_type: ChannelType,
    pub position: i32,
    pub is_private: bool,
    pub is_read_only: bool,
    pub encrypted: bool,
    pub slow_mode_seconds: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl From<&Channel> for ChannelPayload {
    fn from(c: &Channel) -> Self {
        Self {
            id: c.id.clone(),
            name: c.name.clone(),
            topic: c.topic.clone(),
            channel_type: c.channel_type.clone(),
            position: c.position,
            is_private: c.is_private,
            is_read_only: c.is_read_only,
            encrypted: c.encrypted,
            slow_mode_seconds: c.slow_mode_seconds,
            created_at: c.created_at,
            updated_at: c.updated_at,
        }
    }
}

/// Server payload embedded in `ServerUpdated`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerPayload {
    pub id: ServerId,
    pub name: String,
    pub icon_url: Option<String>,
    pub owner_id: UserId,
}

/// DM payload embedded in `DmCreated`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DmPayload {
    pub server_id: ServerId,
    pub channel_id: ChannelId,
    pub other_user_id: UserId,
    pub other_username: String,
    pub other_display_name: Option<String>,
    pub other_avatar_url: Option<String>,
}

/// Friend-request payload embedded in `FriendRequestCreated`. Carries the
/// counterpart's profile + the direction FROM THE RECEIVER's perspective so the
/// receiving tab can `setQueryData` without a refetch (ADR-SSE-003).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FriendRequestPayload {
    pub user_id: UserId,
    pub username: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub direction: RequestDirection,
    pub created_at: DateTime<Utc>,
}

/// Friend payload embedded in `FriendAdded`. Carries the counterpart's LIVE
/// presence status (read at publish time) so a freshly accepted friend never
/// renders offline while online (§4.1). `friends_since` maps to `updated_at`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FriendPayload {
    pub user_id: UserId,
    pub username: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub status: UserStatus,
    pub friends_since: DateTime<Utc>,
}

/// Custom-emoji payload embedded in `EmojiCreated`. Server-wide metadata visible
/// to every member — carries no routing scope (see the variant docs).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmojiPayload {
    pub id: EmojiId,
    pub server_id: ServerId,
    pub name: String,
    pub url: String,
    pub is_animated: bool,
    pub created_by: UserId,
    pub created_at: DateTime<Utc>,
}

impl From<ServerEmoji> for EmojiPayload {
    fn from(e: ServerEmoji) -> Self {
        Self {
            id: e.id,
            server_id: e.server_id,
            name: e.name,
            url: e.url,
            is_animated: e.is_animated,
            created_by: e.created_by,
            created_at: e.created_at,
        }
    }
}

/// Bounded routing metadata: the roles explicitly granted access to a PRIVATE
/// channel (its `channel_role_access` rows). Attached to message/reaction/typing
/// events so the SSE layer can gate delivery by channel access, not by server
/// membership alone.
///
/// Owner/Admin are NEVER listed — they hold implicit access. The set is bounded
/// to the three grantable roles (admin/moderator/member), so it stays far under
/// the `pg_notify` payload cap even though it must survive the cross-instance
/// serde round-trip.
///
/// WHY roles, not user-ids: a user-id list is unbounded and would blow the
/// 7500-byte NOTIFY limit on large private channels; the grantable role set is ≤3.
///
/// REDACTED before serialization to clients — the SSE Stage-2 filter sets
/// `channel_access` back to `None`, so this authorized-role set never reaches any
/// client (the field is `skip_serializing_if = "Option::is_none"`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelAccessScope {
    /// Roles with an explicit `channel_role_access` grant (Owner/Admin excluded).
    pub authorized_roles: Vec<Role>,
}

// ── Event enum ───────────────────────────────────────────────────

/// All real-time events pushed to clients via SSE.
///
/// Serializes as a tagged union: `{"type": "messageCreated", "senderId": "...", ...}`.
/// The SSE handler uses `event_name()` for the SSE `event:` field and
/// serializes the full variant as JSON `data:`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ServerEvent {
    // ── Messages ─────────────────────────────────────────────
    MessageCreated {
        sender_id: UserId,
        server_id: ServerId,
        channel_id: ChannelId,
        message: MessagePayload,
        /// Private-channel access scope (routing metadata). `None` = public
        /// channel (deliver by server membership). REDACTED before client serialize.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        channel_access: Option<ChannelAccessScope>,
    },
    MessageUpdated {
        sender_id: UserId,
        server_id: ServerId,
        channel_id: ChannelId,
        message: MessagePayload,
        /// Private-channel access scope (routing metadata). See `MessageCreated`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        channel_access: Option<ChannelAccessScope>,
    },
    MessageDeleted {
        sender_id: UserId,
        server_id: ServerId,
        channel_id: ChannelId,
        message_id: MessageId,
        /// Who performed the deletion: the author's `UserId` for user-initiated,
        /// `SYSTEM_MODERATOR_ID` for automod deletions.
        deleted_by: UserId,
        /// Private-channel access scope (routing metadata). See `MessageCreated`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        channel_access: Option<ChannelAccessScope>,
    },
    MessagePinned {
        sender_id: UserId,
        server_id: ServerId,
        channel_id: ChannelId,
        /// Full message so the pinned panel renders without a refetch.
        message: MessagePayload,
        pinned_by: UserId,
        /// Private-channel access scope (routing metadata). See `MessageCreated`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        channel_access: Option<ChannelAccessScope>,
    },
    MessageUnpinned {
        sender_id: UserId,
        server_id: ServerId,
        channel_id: ChannelId,
        message_id: MessageId,
        /// Private-channel access scope (routing metadata). See `MessageCreated`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        channel_access: Option<ChannelAccessScope>,
    },

    // ── Members ──────────────────────────────────────────────
    MemberJoined {
        sender_id: UserId,
        server_id: ServerId,
        member: MemberPayload,
    },
    MemberRemoved {
        sender_id: UserId,
        server_id: ServerId,
        user_id: UserId,
    },
    MemberBanned {
        sender_id: UserId,
        server_id: ServerId,
        target_user_id: UserId,
        ban: BanPayload,
    },
    MemberRoleUpdated {
        sender_id: UserId,
        server_id: ServerId,
        member: MemberPayload,
    },

    // ── Channels ─────────────────────────────────────────────
    ChannelCreated {
        sender_id: UserId,
        server_id: ServerId,
        channel: ChannelPayload,
        /// Private-channel access scope (routing metadata). `None` = public
        /// channel (deliver by server membership). REDACTED before client serialize.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        channel_access: Option<ChannelAccessScope>,
    },
    ChannelUpdated {
        sender_id: UserId,
        server_id: ServerId,
        channel: ChannelPayload,
        /// Private-channel access scope (routing metadata). See `MessageCreated`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        channel_access: Option<ChannelAccessScope>,
    },
    ChannelDeleted {
        sender_id: UserId,
        server_id: ServerId,
        channel_id: ChannelId,
        /// Private-channel access scope (routing metadata). See `MessageCreated`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        channel_access: Option<ChannelAccessScope>,
    },
    /// A private channel's `channel_role_access` grant set changed. Server-scoped:
    /// every member re-evaluates whether they can now see (or must now hide) the
    /// channel. Carries only the channel id + the granted role set — NOT the
    /// name/topic — so a non-granted member learns a private channel id exists but
    /// nothing about it (same bounded-metadata posture as `ChannelCreated`, which
    /// is already server-scoped; name/topic are only ever fetched through the
    /// access-gated `list_channels`, which never returns a channel the caller
    /// cannot see — no content leak).
    ///
    /// DELIBERATELY carries NO `channel_access` routing scope: unlike message /
    /// channel-lifecycle events, this one's entire job is to reach a member whose
    /// role is being newly granted (or revoked). Gating it by the CURRENT grant
    /// set would starve the very member who just gained access, so it fans out by
    /// server membership and the bounded id+roles payload is the accepted cost.
    ChannelAccessUpdated {
        sender_id: UserId,
        server_id: ServerId,
        channel_id: ChannelId,
        authorized_roles: Vec<Role>,
    },

    // ── Server ───────────────────────────────────────────────
    ServerUpdated {
        sender_id: UserId,
        server_id: ServerId,
        server: ServerPayload,
    },
    ModerationSettingsUpdated {
        sender_id: UserId,
        server_id: ServerId,
        categories: HashMap<String, bool>,
    },

    // ── DMs (user-scoped, not server-scoped) ─────────────────
    DmCreated {
        sender_id: UserId,
        target_user_id: UserId,
        dm: DmPayload,
    },

    // ── Friends (user-scoped, routed via target_user_id) ─────
    FriendRequestCreated {
        sender_id: UserId,
        target_user_id: UserId,
        request: FriendRequestPayload,
    },
    FriendRequestRemoved {
        sender_id: UserId,
        target_user_id: UserId,
        user_id: UserId,
    },
    FriendAdded {
        sender_id: UserId,
        target_user_id: UserId,
        friend: FriendPayload,
    },
    FriendRemoved {
        sender_id: UserId,
        target_user_id: UserId,
        user_id: UserId,
    },
    // ── Blocks (self-sync only, target = the blocker) ────────
    BlockCreated {
        sender_id: UserId,
        target_user_id: UserId,
        user_id: UserId,
    },
    BlockRemoved {
        sender_id: UserId,
        target_user_id: UserId,
        user_id: UserId,
    },

    // ── Custom emoji (server-scoped, no channel_access) ──────
    /// A custom emoji was created. Server-scoped broadcast so every member's
    /// `:name:` tokens resolve live. Carries the full payload (ADR-SSE-003); no
    /// `channel_access` (emoji are server-wide, not channel-private) and nothing
    /// to redact — the simplest event class.
    EmojiCreated {
        sender_id: UserId,
        server_id: ServerId,
        emoji: EmojiPayload,
    },
    /// A custom emoji was deleted. Members drop it from their resolution map so
    /// `:name:` degrades to literal text (Discord-parity).
    EmojiDeleted {
        sender_id: UserId,
        server_id: ServerId,
        emoji_id: EmojiId,
    },
    /// A newly-created custom emoji was REJECTED by the async image scan and
    /// never revealed (scan-before-reveal). User-scoped to the creator: it was
    /// never shown to other members, so only the creator is notified (drop the
    /// optimistic emoji + show a rejection notice). Carries `name` for the
    /// notice copy and `emoji_id` so the creator's cache patch is exact.
    EmojiRejected {
        sender_id: UserId,
        target_user_id: UserId,
        server_id: ServerId,
        emoji_id: EmojiId,
        name: String,
    },

    // ── Profiles (user-scoped, not server-scoped) ────────────
    /// A user's public profile changed (display name / avatar / custom status /
    /// bio / banner). Carries the NEW current values so every observer can
    /// rehydrate the subject's identity everywhere it is cached, Discord-style.
    /// A `null` field means the value was cleared (not "unchanged") — the event
    /// is a full snapshot, not a patch, so the identity fields are serialized
    /// even when null.
    ProfileUpdated {
        sender_id: UserId,
        user_id: UserId,
        display_name: Option<String>,
        avatar_url: Option<String>,
        custom_status: Option<String>,
        /// Bio (full snapshot; `null` = cleared). Same sensitivity class as the
        /// other identity fields — client-facing, survives redaction.
        bio: Option<String>,
        /// Banner URL (full snapshot; `null` = cleared). Client-facing.
        banner_url: Option<String>,
        /// Scan state of the avatar candidate. `avatar_url` always carries the
        /// APPROVED image, so every render surface is unaffected; the subject's
        /// own client reads this to know its pending image cleared (`approved`)
        /// or was `rejected` (surface a notice). `#[serde(default)]` keeps a
        /// rolling deploy / older instance forward-compatible.
        #[serde(default)]
        avatar_moderation_status: IdentityImageModerationStatus,
        /// Scan state of the banner candidate (see `avatar_moderation_status`).
        #[serde(default)]
        banner_moderation_status: IdentityImageModerationStatus,
        /// Routing metadata: the subject's server memberships (incl. DM
        /// servers), used by the SSE layer to deliver profile updates only to
        /// users sharing a server or DM. Like `PresenceChanged.server_ids` it
        /// survives the cross-instance `pg_notify` round-trip, then is
        /// REDACTED (emptied) before client serialize — but unlike presence,
        /// an EMPTY scope fails CLOSED to the subject only (F8): a
        /// membership-lookup failure at publish time must not broadcast the
        /// profile snapshot to every connected user.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        server_ids: Vec<ServerId>,
    },

    // ── Ephemeral ────────────────────────────────────────────
    TypingStarted {
        sender_id: UserId,
        server_id: ServerId,
        channel_id: ChannelId,
        username: String,
        /// Resolved display name (nickname ?? `display_name` ?? username) so the
        /// typing indicator shows a human name, not the raw username. Optional
        /// for back-compat with older instances during a rolling deploy.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        display_name: Option<String>,
        /// Private-channel access scope (routing metadata). See `MessageCreated`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        channel_access: Option<ChannelAccessScope>,
    },
    PresenceChanged {
        sender_id: UserId,
        user_id: UserId,
        status: UserStatus,
        /// Routing metadata: the subject's server memberships (incl. DM
        /// servers), used by the SSE layer to deliver presence only to users
        /// sharing a server or DM.
        ///
        /// WHY `default` + `skip_serializing_if empty`: the field must survive
        /// the cross-instance `pg_notify` serde round-trip (so remote instances
        /// can scope delivery), but the SSE layer REDACTS it (sets it empty)
        /// before serializing to clients — an empty vec is omitted entirely, so
        /// the client payload is unchanged and no membership list leaks.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        server_ids: Vec<ServerId>,
    },

    // ── Reactions ────────────────────────────────────────────
    ReactionAdded {
        sender_id: UserId,
        server_id: ServerId,
        channel_id: ChannelId,
        message_id: MessageId,
        emoji: String,
        user_id: UserId,
        username: String,
        /// Reactor's account display name, if set. Lets the client patch the
        /// "who reacted" list live with `displayName ?? username`. Omitted when
        /// absent so older instances that never send it deserialize cleanly.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        display_name: Option<String>,
        /// Private-channel access scope (routing metadata). See `MessageCreated`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        channel_access: Option<ChannelAccessScope>,
    },
    ReactionRemoved {
        sender_id: UserId,
        server_id: ServerId,
        channel_id: ChannelId,
        message_id: MessageId,
        emoji: String,
        user_id: UserId,
        /// Reactor's username — lets the client drop the matching entry from the
        /// "who reacted" list, which is keyed by username, not id.
        username: String,
        /// Private-channel access scope (routing metadata). See `MessageCreated`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        channel_access: Option<ChannelAccessScope>,
    },

    // ── Mentions (user-targeted) ─────────────────────────────
    /// Targeted ping for a mentioned user. Rides the `target_user_id` delivery
    /// path: delivered ONLY to the target (all their devices), bypassing
    /// sender-exclusion and server-scope filtering edge cases. Because the
    /// persisted mention list passed `filter_mentionable`, no event ever targets
    /// a user who cannot see the channel — so `channel_id`/`message_id`/`sender`
    /// never leak to a user without access (no `channel_access` routing needed).
    /// Published on SEND only. Edits NEVER publish this event — not even for
    /// mentions the edit newly added (spec §2.4, Discord parity: edit-in
    /// mentions don't ping; badges converge on reconnect).
    MentionReceived {
        /// The message author.
        sender_id: UserId,
        /// The mentioned user (delivery target).
        target_user_id: UserId,
        server_id: ServerId,
        channel_id: ChannelId,
        message_id: MessageId,
    },

    // ── Voice ────────────────────────────────────────────────
    VoiceStateUpdate {
        sender_id: UserId,
        server_id: ServerId,
        channel_id: ChannelId,
        user_id: UserId,
        action: VoiceAction,
        /// Human-readable name resolved from the user's profile.
        /// Populated on `Joined` events; empty on `Left` events (unused by clients).
        display_name: String,
        /// Authoritative mute state from the DB. Present on mute/deaf events,
        /// absent on join/leave (clients use `action` for those).
        #[serde(skip_serializing_if = "Option::is_none")]
        is_muted: Option<bool>,
        /// Authoritative deafen state from the DB.
        #[serde(skip_serializing_if = "Option::is_none")]
        is_deafened: Option<bool>,
        /// Private-channel access scope (routing metadata). See `MessageCreated`.
        /// Gates the voice roster (`userId`, `displayName`, mute/deaf) of a
        /// private voice channel to its authorized roles.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        channel_access: Option<ChannelAccessScope>,
    },

    // ── System ───────────────────────────────────────────────
    /// Tells a specific user to disconnect from a server (kicked/banned).
    ForceDisconnect {
        sender_id: UserId,
        server_id: ServerId,
        target_user_id: UserId,
        reason: String,
    },
}

impl ServerEvent {
    /// SSE `event:` field value (dot-separated, lowercase).
    #[must_use]
    pub fn event_name(&self) -> &'static str {
        match self {
            Self::MessageCreated { .. } => "message.created",
            Self::MessageUpdated { .. } => "message.updated",
            Self::MessageDeleted { .. } => "message.deleted",
            Self::MessagePinned { .. } => "message.pinned",
            Self::MessageUnpinned { .. } => "message.unpinned",
            Self::MemberJoined { .. } => "member.joined",
            Self::MemberRemoved { .. } => "member.removed",
            Self::MemberBanned { .. } => "member.banned",
            Self::MemberRoleUpdated { .. } => "member.role_updated",
            Self::ChannelCreated { .. } => "channel.created",
            Self::ChannelUpdated { .. } => "channel.updated",
            Self::ChannelDeleted { .. } => "channel.deleted",
            Self::ChannelAccessUpdated { .. } => "channel.access_updated",
            Self::ServerUpdated { .. } => "server.updated",
            Self::ModerationSettingsUpdated { .. } => "server.moderation_settings_updated",
            Self::DmCreated { .. } => "dm.created",
            Self::FriendRequestCreated { .. } => "friend.request_created",
            Self::FriendRequestRemoved { .. } => "friend.request_removed",
            Self::FriendAdded { .. } => "friend.added",
            Self::FriendRemoved { .. } => "friend.removed",
            Self::BlockCreated { .. } => "block.created",
            Self::BlockRemoved { .. } => "block.removed",
            Self::EmojiCreated { .. } => "emoji.created",
            Self::EmojiDeleted { .. } => "emoji.deleted",
            Self::EmojiRejected { .. } => "emoji.rejected",
            Self::ProfileUpdated { .. } => "profile.updated",
            Self::TypingStarted { .. } => "typing.started",
            Self::PresenceChanged { .. } => "presence.changed",
            Self::ReactionAdded { .. } => "reaction.added",
            Self::ReactionRemoved { .. } => "reaction.removed",
            Self::MentionReceived { .. } => "mention.received",
            Self::VoiceStateUpdate { .. } => "voice.state_update",
            Self::ForceDisconnect { .. } => "force.disconnect",
        }
    }

    /// The user who triggered this event. Used by the SSE endpoint to
    /// exclude the sender from receiving their own actions.
    #[must_use]
    pub fn sender_id(&self) -> &UserId {
        match self {
            Self::MessageCreated { sender_id, .. }
            | Self::MessageUpdated { sender_id, .. }
            | Self::MessageDeleted { sender_id, .. }
            | Self::MessagePinned { sender_id, .. }
            | Self::MessageUnpinned { sender_id, .. }
            | Self::MemberJoined { sender_id, .. }
            | Self::MemberRemoved { sender_id, .. }
            | Self::MemberBanned { sender_id, .. }
            | Self::MemberRoleUpdated { sender_id, .. }
            | Self::ChannelCreated { sender_id, .. }
            | Self::ChannelUpdated { sender_id, .. }
            | Self::ChannelDeleted { sender_id, .. }
            | Self::ChannelAccessUpdated { sender_id, .. }
            | Self::ServerUpdated { sender_id, .. }
            | Self::ModerationSettingsUpdated { sender_id, .. }
            | Self::DmCreated { sender_id, .. }
            | Self::FriendRequestCreated { sender_id, .. }
            | Self::FriendRequestRemoved { sender_id, .. }
            | Self::FriendAdded { sender_id, .. }
            | Self::FriendRemoved { sender_id, .. }
            | Self::BlockCreated { sender_id, .. }
            | Self::BlockRemoved { sender_id, .. }
            | Self::EmojiCreated { sender_id, .. }
            | Self::EmojiDeleted { sender_id, .. }
            | Self::EmojiRejected { sender_id, .. }
            | Self::ProfileUpdated { sender_id, .. }
            | Self::TypingStarted { sender_id, .. }
            | Self::PresenceChanged { sender_id, .. }
            | Self::ReactionAdded { sender_id, .. }
            | Self::ReactionRemoved { sender_id, .. }
            | Self::MentionReceived { sender_id, .. }
            | Self::VoiceStateUpdate { sender_id, .. }
            | Self::ForceDisconnect { sender_id, .. } => sender_id,
        }
    }

    /// Server this event belongs to, if server-scoped.
    /// Returns `None` for user-scoped events (`DmCreated`, `PresenceChanged`).
    #[must_use]
    pub fn server_id(&self) -> Option<&ServerId> {
        match self {
            Self::MessageCreated { server_id, .. }
            | Self::MessageUpdated { server_id, .. }
            | Self::MessageDeleted { server_id, .. }
            | Self::MessagePinned { server_id, .. }
            | Self::MessageUnpinned { server_id, .. }
            | Self::MemberJoined { server_id, .. }
            | Self::MemberRemoved { server_id, .. }
            | Self::MemberBanned { server_id, .. }
            | Self::MemberRoleUpdated { server_id, .. }
            | Self::ChannelCreated { server_id, .. }
            | Self::ChannelUpdated { server_id, .. }
            | Self::ChannelDeleted { server_id, .. }
            | Self::ChannelAccessUpdated { server_id, .. }
            | Self::ServerUpdated { server_id, .. }
            | Self::ModerationSettingsUpdated { server_id, .. }
            | Self::TypingStarted { server_id, .. }
            | Self::ReactionAdded { server_id, .. }
            | Self::ReactionRemoved { server_id, .. }
            | Self::VoiceStateUpdate { server_id, .. }
            | Self::MentionReceived { server_id, .. }
            | Self::EmojiCreated { server_id, .. }
            | Self::EmojiDeleted { server_id, .. }
            | Self::EmojiRejected { server_id, .. }
            | Self::ForceDisconnect { server_id, .. } => Some(server_id),
            Self::DmCreated { .. }
            | Self::FriendRequestCreated { .. }
            | Self::FriendRequestRemoved { .. }
            | Self::FriendAdded { .. }
            | Self::FriendRemoved { .. }
            | Self::BlockCreated { .. }
            | Self::BlockRemoved { .. }
            | Self::ProfileUpdated { .. }
            | Self::PresenceChanged { .. } => None,
        }
    }

    /// Target user for user-directed events (`DmCreated`, `MemberBanned`, `ForceDisconnect`).
    /// Returns `None` for broadcast events.
    #[must_use]
    pub fn target_user_id(&self) -> Option<&UserId> {
        match self {
            Self::DmCreated { target_user_id, .. }
            | Self::FriendRequestCreated { target_user_id, .. }
            | Self::FriendRequestRemoved { target_user_id, .. }
            | Self::FriendAdded { target_user_id, .. }
            | Self::FriendRemoved { target_user_id, .. }
            | Self::BlockCreated { target_user_id, .. }
            | Self::BlockRemoved { target_user_id, .. }
            | Self::MemberBanned { target_user_id, .. }
            | Self::MentionReceived { target_user_id, .. }
            | Self::EmojiRejected { target_user_id, .. }
            | Self::ForceDisconnect { target_user_id, .. } => Some(target_user_id),
            Self::MessageCreated { .. }
            | Self::MessageUpdated { .. }
            | Self::MessageDeleted { .. }
            | Self::MessagePinned { .. }
            | Self::MessageUnpinned { .. }
            | Self::MemberJoined { .. }
            | Self::MemberRemoved { .. }
            | Self::MemberRoleUpdated { .. }
            | Self::ChannelCreated { .. }
            | Self::ChannelUpdated { .. }
            | Self::ChannelDeleted { .. }
            | Self::ChannelAccessUpdated { .. }
            | Self::ServerUpdated { .. }
            | Self::ModerationSettingsUpdated { .. }
            | Self::ProfileUpdated { .. }
            | Self::TypingStarted { .. }
            | Self::PresenceChanged { .. }
            | Self::ReactionAdded { .. }
            | Self::ReactionRemoved { .. }
            | Self::EmojiCreated { .. }
            | Self::EmojiDeleted { .. }
            | Self::VoiceStateUpdate { .. } => None,
        }
    }

    /// Private-channel access scope for channel-scoped events, if any.
    ///
    /// `Some` only for the ten channel-scoped events (message/reaction/typing,
    /// channel lifecycle, voice state) when they target a PRIVATE channel;
    /// `None` for public channels and every other variant. The SSE Stage-2
    /// filter uses this to gate delivery by channel access, then redacts it
    /// (sets it to `None`) before serializing to clients.
    #[must_use]
    pub fn channel_access(&self) -> Option<&ChannelAccessScope> {
        match self {
            Self::MessageCreated { channel_access, .. }
            | Self::MessageUpdated { channel_access, .. }
            | Self::MessageDeleted { channel_access, .. }
            | Self::MessagePinned { channel_access, .. }
            | Self::MessageUnpinned { channel_access, .. }
            | Self::TypingStarted { channel_access, .. }
            | Self::ReactionAdded { channel_access, .. }
            | Self::ReactionRemoved { channel_access, .. }
            | Self::ChannelCreated { channel_access, .. }
            | Self::ChannelUpdated { channel_access, .. }
            | Self::ChannelDeleted { channel_access, .. }
            | Self::VoiceStateUpdate { channel_access, .. } => channel_access.as_ref(),
            Self::MemberJoined { .. }
            | Self::MemberRemoved { .. }
            | Self::MemberBanned { .. }
            | Self::MemberRoleUpdated { .. }
            | Self::ChannelAccessUpdated { .. }
            | Self::ServerUpdated { .. }
            | Self::ModerationSettingsUpdated { .. }
            | Self::DmCreated { .. }
            | Self::FriendRequestCreated { .. }
            | Self::FriendRequestRemoved { .. }
            | Self::FriendAdded { .. }
            | Self::FriendRemoved { .. }
            | Self::BlockCreated { .. }
            | Self::BlockRemoved { .. }
            | Self::EmojiCreated { .. }
            | Self::EmojiDeleted { .. }
            | Self::EmojiRejected { .. }
            | Self::ProfileUpdated { .. }
            | Self::PresenceChanged { .. }
            | Self::MentionReceived { .. }
            | Self::ForceDisconnect { .. } => None,
        }
    }

    /// Strip ALL delivery-scoping metadata before serializing to a client.
    ///
    /// WHY: `channel_access` (private-channel gate) and `server_ids` (presence
    /// scope) exist only for the SSE Stage-2 filter to route/gate delivery —
    /// they must NEVER reach a client. This lives next to the variant
    /// definitions and is an EXHAUSTIVE match with no `_` arm: a future variant
    /// that gains scoping metadata forces a compile error here, so redaction can
    /// never be silently forgotten at a distant call site (the prior footgun).
    /// `skip_serializing_if` then omits the emptied fields, keeping client JSON
    /// byte-identical to before scoping.
    pub fn redact_routing_metadata(&mut self) {
        match self {
            Self::MessageCreated { channel_access, .. }
            | Self::MessageUpdated { channel_access, .. }
            | Self::MessageDeleted { channel_access, .. }
            | Self::MessagePinned { channel_access, .. }
            | Self::MessageUnpinned { channel_access, .. }
            | Self::TypingStarted { channel_access, .. }
            | Self::ReactionAdded { channel_access, .. }
            | Self::ReactionRemoved { channel_access, .. }
            | Self::ChannelCreated { channel_access, .. }
            | Self::ChannelUpdated { channel_access, .. }
            | Self::ChannelDeleted { channel_access, .. }
            | Self::VoiceStateUpdate { channel_access, .. } => *channel_access = None,
            Self::PresenceChanged { server_ids, .. } | Self::ProfileUpdated { server_ids, .. } => {
                server_ids.clear();
            }
            Self::MemberJoined { .. }
            | Self::MemberRemoved { .. }
            | Self::MemberBanned { .. }
            | Self::MemberRoleUpdated { .. }
            | Self::ChannelAccessUpdated { .. }
            | Self::ServerUpdated { .. }
            | Self::ModerationSettingsUpdated { .. }
            | Self::DmCreated { .. }
            | Self::FriendRequestCreated { .. }
            | Self::FriendRequestRemoved { .. }
            | Self::FriendAdded { .. }
            | Self::FriendRemoved { .. }
            | Self::BlockCreated { .. }
            | Self::BlockRemoved { .. }
            | Self::EmojiCreated { .. }
            | Self::EmojiDeleted { .. }
            | Self::EmojiRejected { .. }
            | Self::MentionReceived { .. }
            | Self::ForceDisconnect { .. } => {}
        }
    }

    /// Drop the attachments payload from a message event. Returns `true`
    /// when something was actually shed.
    ///
    /// WHY: last-resort degradation for the 7500-byte `pg_notify` envelope
    /// cap. A max-attachments + long-caption message can exceed the cap; the
    /// notify worker sheds the attachments and re-serializes so REMOTE
    /// instances still deliver the message (text renders live, attachments
    /// heal on the next REST fetch/reconnect invalidation) instead of
    /// silently losing the whole event cross-instance. Local subscribers are
    /// unaffected — they receive the full event via the broadcast channel.
    pub fn shed_attachments(&mut self) -> bool {
        match self {
            Self::MessageCreated { message, .. } | Self::MessageUpdated { message, .. } => {
                if message.attachments.is_empty() {
                    false
                } else {
                    message.attachments.clear();
                    true
                }
            }
            _ => false,
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn test_user_id() -> UserId {
        UserId::new(Uuid::new_v4())
    }

    fn test_server_id() -> ServerId {
        ServerId::new(Uuid::new_v4())
    }

    fn test_channel_id() -> ChannelId {
        ChannelId::new(Uuid::new_v4())
    }

    #[test]
    fn event_name_returns_correct_strings() {
        let sender = test_user_id();
        let server = test_server_id();
        let channel = test_channel_id();

        let cases: Vec<(ServerEvent, &str)> = vec![
            (
                ServerEvent::MessageCreated {
                    sender_id: sender.clone(),
                    server_id: server.clone(),
                    channel_id: channel.clone(),
                    message: MessagePayload {
                        id: MessageId::new(Uuid::new_v4()),
                        channel_id: channel.clone(),
                        content: "hello".to_string(),
                        author_id: sender.clone(),
                        author_username: "alice".to_string(),
                        author_display_name: None,
                        author_avatar_url: None,
                        encrypted: false,
                        sender_device_id: None,
                        edited_at: None,
                        parent_message_id: None,
                        message_type: crate::domain::models::MessageType::Default,
                        system_event_key: None,
                        moderated_at: None,
                        moderation_reason: None,
                        mentions: vec![],
                        attachments: vec![],
                        is_pinned: false,
                        pinned_by: None,
                        pinned_at: None,
                        created_at: Utc::now(),
                    },
                    channel_access: None,
                },
                "message.created",
            ),
            (
                ServerEvent::MemberRemoved {
                    sender_id: sender.clone(),
                    server_id: server.clone(),
                    user_id: test_user_id(),
                },
                "member.removed",
            ),
            (
                ServerEvent::ForceDisconnect {
                    sender_id: sender.clone(),
                    server_id: server.clone(),
                    target_user_id: test_user_id(),
                    reason: "kicked".to_string(),
                },
                "force.disconnect",
            ),
        ];

        for (event, expected_name) in cases {
            assert_eq!(event.event_name(), expected_name);
        }
    }

    #[test]
    fn server_id_returns_none_for_user_scoped_events() {
        let sender = test_user_id();

        let dm_event = ServerEvent::DmCreated {
            sender_id: sender.clone(),
            target_user_id: test_user_id(),
            dm: DmPayload {
                server_id: test_server_id(),
                channel_id: test_channel_id(),
                other_user_id: test_user_id(),
                other_username: "bob".to_string(),
                other_display_name: None,
                other_avatar_url: None,
            },
        };
        assert!(dm_event.server_id().is_none());

        let presence_event = ServerEvent::PresenceChanged {
            sender_id: sender,
            user_id: test_user_id(),
            status: UserStatus::Online,
            server_ids: Vec::new(),
        };
        assert!(presence_event.server_id().is_none());
    }

    #[test]
    fn target_user_id_returns_some_for_directed_events() {
        let sender = test_user_id();
        let target = test_user_id();

        let event = ServerEvent::ForceDisconnect {
            sender_id: sender,
            server_id: test_server_id(),
            target_user_id: target.clone(),
            reason: "banned".to_string(),
        };
        assert_eq!(event.target_user_id(), Some(&target));
    }

    #[test]
    fn target_user_id_returns_none_for_broadcast_events() {
        let event = ServerEvent::MemberRemoved {
            sender_id: test_user_id(),
            server_id: test_server_id(),
            user_id: test_user_id(),
        };
        assert!(event.target_user_id().is_none());
    }

    #[test]
    fn serializes_as_tagged_union() {
        let deleter = test_user_id();
        let event = ServerEvent::MessageDeleted {
            sender_id: deleter.clone(),
            server_id: test_server_id(),
            channel_id: test_channel_id(),
            message_id: MessageId::new(Uuid::new_v4()),
            deleted_by: deleter,
            channel_access: None,
        };
        let json = serde_json::to_value(&event).unwrap();
        // WHY: `rename_all_fields = "camelCase"` renames all struct variant
        // field names to camelCase in the JSON output, matching the frontend
        // convention (ADR-039).
        assert_eq!(json["type"], "messageDeleted");
        assert!(json["senderId"].is_string());
        assert!(json["serverId"].is_string());
        assert!(json["channelId"].is_string());
        assert!(json["deletedBy"].is_string());
        assert!(json["messageId"].is_string());
    }

    #[test]
    fn server_event_round_trip_serialization() {
        let event = ServerEvent::MessageCreated {
            sender_id: test_user_id(),
            server_id: test_server_id(),
            channel_id: test_channel_id(),
            message: MessagePayload {
                id: MessageId::new(Uuid::new_v4()),
                channel_id: test_channel_id(),
                content: "round-trip test".to_string(),
                author_id: test_user_id(),
                author_username: "alice".to_string(),
                author_display_name: None,
                author_avatar_url: None,
                encrypted: false,
                sender_device_id: None,
                edited_at: None,
                parent_message_id: None,
                message_type: crate::domain::models::MessageType::Default,
                system_event_key: None,
                moderated_at: None,
                moderation_reason: None,
                mentions: vec![],
                attachments: vec![],
                is_pinned: false,
                pinned_by: None,
                pinned_at: None,
                created_at: Utc::now(),
            },
            channel_access: None,
        };

        let json = serde_json::to_string(&event).unwrap();
        let deserialized: ServerEvent = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.event_name(), "message.created");
        assert_eq!(deserialized.sender_id(), event.sender_id());
    }

    #[test]
    fn mention_received_event_name_and_routing() {
        let sender = test_user_id();
        let target = test_user_id();
        let event = ServerEvent::MentionReceived {
            sender_id: sender.clone(),
            target_user_id: target.clone(),
            server_id: test_server_id(),
            channel_id: test_channel_id(),
            message_id: MessageId::new(Uuid::new_v4()),
        };
        assert_eq!(event.event_name(), "mention.received");
        // Targeted: rides the target_user_id delivery path.
        assert_eq!(event.target_user_id(), Some(&target));
        assert_eq!(event.sender_id(), &sender);
        // Server-scoped id present but the SSE filter checks target first.
        assert!(event.server_id().is_some());
        // Never carries private-channel routing metadata.
        assert!(event.channel_access().is_none());
    }

    #[test]
    fn mention_received_tagged_union_round_trip() {
        let event = ServerEvent::MentionReceived {
            sender_id: test_user_id(),
            target_user_id: test_user_id(),
            server_id: test_server_id(),
            channel_id: test_channel_id(),
            message_id: MessageId::new(Uuid::new_v4()),
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["type"], "mentionReceived");
        assert!(json["senderId"].is_string());
        assert!(json["targetUserId"].is_string());
        assert!(json["channelId"].is_string());
        assert!(json["messageId"].is_string());

        let back: ServerEvent = serde_json::from_value(json).unwrap();
        assert_eq!(back.event_name(), "mention.received");
        assert_eq!(back.target_user_id(), event.target_user_id());
    }

    /// A public-channel event (`channel_access: None`) MUST omit the key
    /// entirely — byte-identical to the pre-fix payload — and the accessor
    /// returns `None`.
    #[test]
    fn public_channel_event_omits_channel_access() {
        let event = ServerEvent::TypingStarted {
            sender_id: test_user_id(),
            server_id: test_server_id(),
            channel_id: test_channel_id(),
            username: "alice".to_string(),
            display_name: None,
            channel_access: None,
        };
        assert!(event.channel_access().is_none());
        let json = serde_json::to_string(&event).unwrap();
        assert!(
            !json.contains("channelAccess"),
            "public event leaked channelAccess key: {json}"
        );
    }

    /// A private-channel event carries the authorized-role set as camelCase
    /// routing metadata and survives the cross-instance (`pg_notify`) serde
    /// round-trip so remote instances can gate delivery.
    #[test]
    fn private_channel_event_round_trips_authorized_roles() {
        let scope = ChannelAccessScope {
            authorized_roles: vec![Role::Moderator, Role::Member],
        };
        let event = ServerEvent::ReactionAdded {
            sender_id: test_user_id(),
            server_id: test_server_id(),
            channel_id: test_channel_id(),
            message_id: MessageId::new(Uuid::new_v4()),
            emoji: "👍".to_string(),
            user_id: test_user_id(),
            username: "alice".to_string(),
            display_name: Some("Alice A".to_string()),
            channel_access: Some(scope.clone()),
        };

        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("channelAccess"));
        assert!(json.contains("authorizedRoles"));

        let back: ServerEvent = serde_json::from_str(&json).unwrap();
        assert_eq!(back.channel_access(), Some(&scope));
    }

    /// `reaction.added` carries `displayName` in camelCase for the "who reacted"
    /// tooltip, and omits it entirely when the reactor has no display name.
    #[test]
    fn reaction_added_serializes_display_name() {
        let with_name = ServerEvent::ReactionAdded {
            sender_id: test_user_id(),
            server_id: test_server_id(),
            channel_id: test_channel_id(),
            message_id: MessageId::new(Uuid::new_v4()),
            emoji: "🎉".to_string(),
            user_id: test_user_id(),
            username: "alice".to_string(),
            display_name: Some("Alice A".to_string()),
            channel_access: None,
        };
        let json = serde_json::to_value(&with_name).unwrap();
        assert_eq!(json["displayName"], "Alice A");
        assert_eq!(json["username"], "alice");

        let without_name = ServerEvent::ReactionAdded {
            sender_id: test_user_id(),
            server_id: test_server_id(),
            channel_id: test_channel_id(),
            message_id: MessageId::new(Uuid::new_v4()),
            emoji: "🎉".to_string(),
            user_id: test_user_id(),
            username: "bob".to_string(),
            display_name: None,
            channel_access: None,
        };
        let json = serde_json::to_value(&without_name).unwrap();
        assert!(json.get("displayName").is_none());
    }

    /// `reaction.removed` carries the reactor `username` so the client can drop
    /// the matching "who reacted" entry (the list is keyed by username, not id).
    #[test]
    fn reaction_removed_carries_username() {
        let event = ServerEvent::ReactionRemoved {
            sender_id: test_user_id(),
            server_id: test_server_id(),
            channel_id: test_channel_id(),
            message_id: MessageId::new(Uuid::new_v4()),
            emoji: "👍".to_string(),
            user_id: test_user_id(),
            username: "alice".to_string(),
            channel_access: None,
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["username"], "alice");
    }

    /// Redaction still nulls `channel_access` on both reaction variants after the
    /// display-field additions — the added `display_name`/`username` are plain
    /// display data and are never touched by routing/redaction.
    #[test]
    fn redaction_nulls_channel_access_on_reaction_variants() {
        let scope = ChannelAccessScope {
            authorized_roles: vec![Role::Member],
        };
        let mut added = ServerEvent::ReactionAdded {
            sender_id: test_user_id(),
            server_id: test_server_id(),
            channel_id: test_channel_id(),
            message_id: MessageId::new(Uuid::new_v4()),
            emoji: "👍".to_string(),
            user_id: test_user_id(),
            username: "alice".to_string(),
            display_name: Some("Alice A".to_string()),
            channel_access: Some(scope.clone()),
        };
        added.redact_routing_metadata();
        assert!(added.channel_access().is_none());
        let json = serde_json::to_value(&added).unwrap();
        assert_eq!(json["displayName"], "Alice A");
        assert!(json.get("channelAccess").is_none());

        let mut removed = ServerEvent::ReactionRemoved {
            sender_id: test_user_id(),
            server_id: test_server_id(),
            channel_id: test_channel_id(),
            message_id: MessageId::new(Uuid::new_v4()),
            emoji: "👍".to_string(),
            user_id: test_user_id(),
            username: "alice".to_string(),
            channel_access: Some(scope),
        };
        removed.redact_routing_metadata();
        assert!(removed.channel_access().is_none());
        let json = serde_json::to_value(&removed).unwrap();
        assert_eq!(json["username"], "alice");
        assert!(json.get("channelAccess").is_none());
    }

    #[test]
    fn profile_updated_event_name_and_scope_accessors() {
        let event = ServerEvent::ProfileUpdated {
            sender_id: test_user_id(),
            user_id: test_user_id(),
            display_name: Some("Ada".to_string()),
            avatar_url: None,
            custom_status: None,
            bio: None,
            banner_url: None,
            avatar_moderation_status: IdentityImageModerationStatus::Approved,
            banner_moderation_status: IdentityImageModerationStatus::Approved,
            server_ids: vec![test_server_id()],
        };
        assert_eq!(event.event_name(), "profile.updated");
        // User-scoped like PresenceChanged/DmCreated: no server_id, no target.
        assert!(event.server_id().is_none());
        assert!(event.target_user_id().is_none());
        assert!(event.channel_access().is_none());
    }

    /// The `server_ids` routing field must survive the cross-instance
    /// (`pg_notify`) serde round-trip, and must be OMITTED once redacted so the
    /// client payload never carries the subject's membership list.
    #[test]
    fn profile_updated_routing_metadata_carried_then_omitted_when_redacted() {
        let routed = ServerEvent::ProfileUpdated {
            sender_id: test_user_id(),
            user_id: test_user_id(),
            display_name: Some("Ada".to_string()),
            avatar_url: None,
            custom_status: None,
            bio: Some("hello world".to_string()),
            banner_url: Some("https://cdn.example/banner.png".to_string()),
            avatar_moderation_status: IdentityImageModerationStatus::Approved,
            banner_moderation_status: IdentityImageModerationStatus::Approved,
            server_ids: vec![test_server_id()],
        };
        let json = serde_json::to_string(&routed).unwrap();
        assert!(json.contains("serverIds"), "bus path must carry serverIds");
        let back: ServerEvent = serde_json::from_str(&json).unwrap();
        assert!(matches!(
            back,
            ServerEvent::ProfileUpdated { ref server_ids, .. } if server_ids.len() == 1
        ));

        let mut redacted = routed;
        redacted.redact_routing_metadata();
        let json = serde_json::to_string(&redacted).unwrap();
        assert!(
            !json.contains("serverIds"),
            "redacted payload leaked serverIds: {json}"
        );
        // WHY (security): bio/banner are client-facing profile data — redaction
        // strips ONLY routing metadata, never the snapshot the client rehydrates.
        assert!(
            json.contains("hello world") && json.contains("banner.png"),
            "redaction must preserve client-facing bio/banner: {json}"
        );
    }

    /// The three identity fields are a FULL snapshot, not a patch: a cleared
    /// value (`None`) must serialize as explicit `null` (camelCase), so the
    /// client can distinguish "cleared" from "still set".
    #[test]
    fn profile_updated_cleared_fields_serialize_as_null() {
        let event = ServerEvent::ProfileUpdated {
            sender_id: test_user_id(),
            user_id: test_user_id(),
            display_name: None,
            avatar_url: None,
            custom_status: None,
            bio: None,
            banner_url: None,
            avatar_moderation_status: IdentityImageModerationStatus::Approved,
            banner_moderation_status: IdentityImageModerationStatus::Approved,
            server_ids: Vec::new(),
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["type"], "profileUpdated");
        assert!(json["displayName"].is_null());
        assert!(json["avatarUrl"].is_null());
        assert!(json["customStatus"].is_null());
        assert!(json["bio"].is_null());
        assert!(json["bannerUrl"].is_null());
        // Empty routing metadata is omitted entirely.
        assert!(json.get("serverIds").is_none());
    }

    /// Builds each of the four F5 variants (channel lifecycle + voice) with the
    /// given access scope, so the scoping tests below cover all of them.
    fn f5_events(channel_access: Option<ChannelAccessScope>) -> Vec<ServerEvent> {
        let payload = ChannelPayload {
            id: test_channel_id(),
            name: "ops-private".to_string(),
            topic: Some("secret topic".to_string()),
            channel_type: ChannelType::Text,
            position: 0,
            is_private: true,
            is_read_only: false,
            encrypted: false,
            slow_mode_seconds: 0,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };
        vec![
            ServerEvent::ChannelCreated {
                sender_id: test_user_id(),
                server_id: test_server_id(),
                channel: payload.clone(),
                channel_access: channel_access.clone(),
            },
            ServerEvent::ChannelUpdated {
                sender_id: test_user_id(),
                server_id: test_server_id(),
                channel: payload,
                channel_access: channel_access.clone(),
            },
            ServerEvent::ChannelDeleted {
                sender_id: test_user_id(),
                server_id: test_server_id(),
                channel_id: test_channel_id(),
                channel_access: channel_access.clone(),
            },
            ServerEvent::VoiceStateUpdate {
                sender_id: test_user_id(),
                server_id: test_server_id(),
                channel_id: test_channel_id(),
                user_id: test_user_id(),
                action: crate::domain::models::VoiceAction::Joined,
                display_name: "Ada".to_string(),
                is_muted: None,
                is_deafened: None,
                channel_access,
            },
        ]
    }

    /// F5: the four channel/voice variants expose their scope through
    /// `channel_access()` so the SSE Stage-2 gate applies to them — and
    /// `server_id()` stays `Some` (the gate needs it to look up the receiver's
    /// role).
    #[test]
    fn channel_access_returns_some_for_channel_and_voice_events() {
        let scope = ChannelAccessScope {
            authorized_roles: vec![Role::Moderator],
        };
        for event in f5_events(Some(scope.clone())) {
            assert_eq!(
                event.channel_access(),
                Some(&scope),
                "{} must expose its access scope",
                event.event_name()
            );
            assert!(
                event.server_id().is_some(),
                "{} must stay server-scoped for the role lookup",
                event.event_name()
            );
        }
        for event in f5_events(None) {
            assert!(
                event.channel_access().is_none(),
                "{} public form must carry no scope",
                event.event_name()
            );
        }
    }

    /// F5: redaction clears the scope on all four variants and the wire payload
    /// carries no `channelAccess`/`authorizedRoles` key — byte-identical to the
    /// pre-fix client payload.
    #[test]
    fn redact_clears_channel_and_voice_access() {
        let scope = ChannelAccessScope {
            authorized_roles: vec![Role::Moderator, Role::Member],
        };
        for mut event in f5_events(Some(scope.clone())) {
            // Bus path (pg_notify): the scope must survive the serde round-trip
            // so remote instances can gate delivery.
            let json = serde_json::to_string(&event).unwrap();
            assert!(json.contains("channelAccess"), "bus payload must route");
            let back: ServerEvent = serde_json::from_str(&json).unwrap();
            assert_eq!(back.channel_access(), Some(&scope));

            // Client path: redacted before serialize — never leaks the role set.
            event.redact_routing_metadata();
            assert!(event.channel_access().is_none());
            let json = serde_json::to_string(&event).unwrap();
            assert!(
                !json.contains("channelAccess") && !json.contains("authorizedRoles"),
                "{} leaked routing metadata: {json}",
                event.event_name()
            );
        }
    }

    /// Rollout safety (mirrors `mentions`): an OLDER instance publishes a
    /// `MessagePayload` WITHOUT the `attachments` key over `pg_notify` — a new
    /// instance must deserialize it (empty attachments), not drop the event.
    #[test]
    fn message_payload_without_attachments_key_deserializes() {
        let json = serde_json::json!({
            "id": Uuid::new_v4().to_string(),
            "channelId": Uuid::new_v4().to_string(),
            "content": "old instance payload",
            "authorId": Uuid::new_v4().to_string(),
            "authorUsername": "alice",
            "authorDisplayName": null,
            "authorAvatarUrl": null,
            "encrypted": false,
            "senderDeviceId": null,
            "editedAt": null,
            "parentMessageId": null,
            "messageType": "default",
            "createdAt": Utc::now().to_rfc3339(),
        });
        let payload: MessagePayload = serde_json::from_value(json).unwrap();
        assert!(payload.attachments.is_empty());
        assert!(payload.mentions.is_empty());
    }

    /// Attachments survive the cross-instance (`pg_notify`) serde round-trip
    /// in camelCase — this is what makes SSE-live rendering possible without
    /// a refetch (hard requirement: reactivity). The wire shape is SLIM:
    /// `messageId`/`createdAt` must NOT ride the envelope (dead weight against
    /// the 7500-byte `pg_notify` cap; the client schema never read them).
    #[test]
    fn message_payload_attachments_round_trip() {
        let attachment = AttachmentPayload {
            id: crate::domain::models::AttachmentId::new(Uuid::new_v4()),
            url: "https://x.supabase.co/storage/v1/object/public/attachments/u/f.webp".to_string(),
            mime: "image/webp".to_string(),
            size: 1234,
            width: Some(800),
            height: Some(600),
            moderation_status: AttachmentModerationStatus::Approved,
        };
        let event = ServerEvent::MessageCreated {
            sender_id: test_user_id(),
            server_id: test_server_id(),
            channel_id: test_channel_id(),
            message: MessagePayload {
                id: MessageId::new(Uuid::new_v4()),
                channel_id: test_channel_id(),
                content: String::new(), // image-only message
                author_id: test_user_id(),
                author_username: "alice".to_string(),
                author_display_name: None,
                author_avatar_url: None,
                encrypted: false,
                sender_device_id: None,
                edited_at: None,
                parent_message_id: None,
                message_type: crate::domain::models::MessageType::Default,
                system_event_key: None,
                moderated_at: None,
                moderation_reason: None,
                mentions: vec![],
                attachments: vec![attachment.clone()],
                is_pinned: false,
                pinned_by: None,
                pinned_at: None,
                created_at: Utc::now(),
            },
            channel_access: None,
        };

        let json = serde_json::to_value(&event).unwrap();
        let wire = &json["message"]["attachments"][0];
        assert_eq!(wire["mime"], "image/webp");
        assert_eq!(wire["width"], 800);
        // Regression (review finding): the slim wire shape must not carry the
        // redundant domain fields.
        assert!(wire.get("messageId").is_none());
        assert!(wire.get("createdAt").is_none());

        let back: ServerEvent = serde_json::from_value(json).unwrap();
        if let ServerEvent::MessageCreated { message, .. } = back {
            assert_eq!(message.attachments, vec![attachment]);
        } else {
            panic!("expected MessageCreated");
        }
    }

    /// `ChannelAccessUpdated` is a server-scoped broadcast (no target, no
    /// `channel_access` routing scope — it must reach the newly-granted member,
    /// so gating by the current grant set would starve them) and carries the
    /// granted role set as camelCase `authorizedRoles`.
    #[test]
    fn channel_access_updated_name_and_routing() {
        let event = ServerEvent::ChannelAccessUpdated {
            sender_id: test_user_id(),
            server_id: test_server_id(),
            channel_id: test_channel_id(),
            authorized_roles: vec![Role::Moderator, Role::Member],
        };
        assert_eq!(event.event_name(), "channel.access_updated");
        assert!(event.server_id().is_some(), "must stay server-scoped");
        assert!(event.target_user_id().is_none(), "broadcast, not targeted");
        assert!(
            event.channel_access().is_none(),
            "must NOT be gated by the current grant set"
        );
    }

    /// `redact_routing_metadata` is a no-op for `ChannelAccessUpdated` (its
    /// payload is the client-facing data), and the tagged-union round-trip
    /// preserves the granted roles.
    #[test]
    fn channel_access_updated_round_trip_and_redaction_noop() {
        let mut event = ServerEvent::ChannelAccessUpdated {
            sender_id: test_user_id(),
            server_id: test_server_id(),
            channel_id: test_channel_id(),
            authorized_roles: vec![Role::Member],
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["type"], "channelAccessUpdated");
        assert!(json["channelId"].is_string());
        assert_eq!(json["authorizedRoles"][0], "member");

        event.redact_routing_metadata();
        let after = serde_json::to_value(&event).unwrap();
        assert_eq!(
            after["authorizedRoles"][0], "member",
            "redaction must not strip the client-facing grant set"
        );

        let back: ServerEvent = serde_json::from_value(after).unwrap();
        assert_eq!(back.event_name(), "channel.access_updated");
    }

    /// All six friend/block variants ride the `target_user_id` delivery path
    /// (Some target, no server scope, no channel access) and name correctly.
    #[test]
    fn friend_and_block_events_are_user_targeted() {
        let target = test_user_id();
        let cases: Vec<(ServerEvent, &str)> = vec![
            (
                ServerEvent::FriendRequestCreated {
                    sender_id: test_user_id(),
                    target_user_id: target.clone(),
                    request: FriendRequestPayload {
                        user_id: test_user_id(),
                        username: "alice".to_string(),
                        display_name: None,
                        avatar_url: None,
                        direction: RequestDirection::Incoming,
                        created_at: Utc::now(),
                    },
                },
                "friend.request_created",
            ),
            (
                ServerEvent::FriendRequestRemoved {
                    sender_id: test_user_id(),
                    target_user_id: target.clone(),
                    user_id: test_user_id(),
                },
                "friend.request_removed",
            ),
            (
                ServerEvent::FriendAdded {
                    sender_id: test_user_id(),
                    target_user_id: target.clone(),
                    friend: FriendPayload {
                        user_id: test_user_id(),
                        username: "bob".to_string(),
                        display_name: None,
                        avatar_url: None,
                        status: UserStatus::Online,
                        friends_since: Utc::now(),
                    },
                },
                "friend.added",
            ),
            (
                ServerEvent::FriendRemoved {
                    sender_id: test_user_id(),
                    target_user_id: target.clone(),
                    user_id: test_user_id(),
                },
                "friend.removed",
            ),
            (
                ServerEvent::BlockCreated {
                    sender_id: test_user_id(),
                    target_user_id: target.clone(),
                    user_id: test_user_id(),
                },
                "block.created",
            ),
            (
                ServerEvent::BlockRemoved {
                    sender_id: test_user_id(),
                    target_user_id: target.clone(),
                    user_id: test_user_id(),
                },
                "block.removed",
            ),
        ];
        for (event, name) in cases {
            assert_eq!(event.event_name(), name);
            assert_eq!(event.target_user_id(), Some(&target), "{name} must target");
            assert!(event.server_id().is_none(), "{name} is user-scoped");
            assert!(
                event.channel_access().is_none(),
                "{name} has no channel scope"
            );
        }
    }

    /// `friend.added` carries the counterpart's live `status` (camelCase) so the
    /// client seeds presence — verified through the tagged-union round-trip (§4.1).
    #[test]
    fn friend_added_carries_status_through_round_trip() {
        let event = ServerEvent::FriendAdded {
            sender_id: test_user_id(),
            target_user_id: test_user_id(),
            friend: FriendPayload {
                user_id: test_user_id(),
                username: "ada".to_string(),
                display_name: Some("Ada".to_string()),
                avatar_url: None,
                status: UserStatus::DoNotDisturb,
                friends_since: Utc::now(),
            },
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["type"], "friendAdded");
        assert_eq!(json["friend"]["status"], "dnd");
        assert_eq!(json["friend"]["username"], "ada");

        let back: ServerEvent = serde_json::from_value(json).unwrap();
        match back {
            ServerEvent::FriendAdded { friend, .. } => {
                assert_eq!(friend.status, UserStatus::DoNotDisturb);
            }
            _ => panic!("expected FriendAdded"),
        }
    }

    fn pinned_message_payload() -> MessagePayload {
        MessagePayload {
            id: MessageId::new(Uuid::new_v4()),
            channel_id: test_channel_id(),
            content: "pinned".to_string(),
            author_id: test_user_id(),
            author_username: "alice".to_string(),
            author_display_name: None,
            author_avatar_url: None,
            encrypted: false,
            sender_device_id: None,
            edited_at: None,
            parent_message_id: None,
            message_type: crate::domain::models::MessageType::Default,
            system_event_key: None,
            moderated_at: None,
            moderation_reason: None,
            mentions: vec![],
            attachments: vec![],
            is_pinned: true,
            pinned_by: Some(test_user_id()),
            pinned_at: Some(Utc::now()),
            created_at: Utc::now(),
        }
    }

    /// Both pin variants name correctly, stay server-scoped (the SSE gate needs
    /// `server_id` to look up the receiver's role), are NOT user-targeted, and
    /// carry the private-channel access scope so Stage-2 gating applies.
    #[test]
    fn pin_events_naming_and_routing() {
        let scope = ChannelAccessScope {
            authorized_roles: vec![Role::Moderator, Role::Member],
        };
        let pinned = ServerEvent::MessagePinned {
            sender_id: test_user_id(),
            server_id: test_server_id(),
            channel_id: test_channel_id(),
            message: pinned_message_payload(),
            pinned_by: test_user_id(),
            channel_access: Some(scope.clone()),
        };
        let unpinned = ServerEvent::MessageUnpinned {
            sender_id: test_user_id(),
            server_id: test_server_id(),
            channel_id: test_channel_id(),
            message_id: MessageId::new(Uuid::new_v4()),
            channel_access: Some(scope.clone()),
        };

        assert_eq!(pinned.event_name(), "message.pinned");
        assert_eq!(unpinned.event_name(), "message.unpinned");
        for event in [&pinned, &unpinned] {
            assert!(event.server_id().is_some(), "pin events stay server-scoped");
            assert!(event.target_user_id().is_none(), "pin events broadcast");
            assert_eq!(event.channel_access(), Some(&scope));
        }

        // Redaction strips the routing scope from both before client serialize,
        // but keeps the client-facing pinned message payload intact.
        let mut redacted = pinned;
        redacted.redact_routing_metadata();
        assert!(redacted.channel_access().is_none());
        let json = serde_json::to_value(&redacted).unwrap();
        assert_eq!(json["type"], "messagePinned");
        assert_eq!(json["message"]["isPinned"], true);
        assert!(json["message"]["pinnedBy"].is_string());
        assert!(json.get("channelAccess").is_none());

        let mut redacted_unpin = unpinned;
        redacted_unpin.redact_routing_metadata();
        assert!(redacted_unpin.channel_access().is_none());
        let json = serde_json::to_value(&redacted_unpin).unwrap();
        assert_eq!(json["type"], "messageUnpinned");
        assert!(json["messageId"].is_string());
    }

    /// `TypingStarted.display_name` carries the resolved name in camelCase when
    /// present, and is omitted entirely when absent (back-compat).
    #[test]
    fn typing_started_display_name_serialization() {
        let with_name = ServerEvent::TypingStarted {
            sender_id: test_user_id(),
            server_id: test_server_id(),
            channel_id: test_channel_id(),
            username: "ada".to_string(),
            display_name: Some("Ada Lovelace".to_string()),
            channel_access: None,
        };
        let json = serde_json::to_value(&with_name).unwrap();
        assert_eq!(json["displayName"], "Ada Lovelace");
        assert_eq!(json["username"], "ada");

        let without_name = ServerEvent::TypingStarted {
            sender_id: test_user_id(),
            server_id: test_server_id(),
            channel_id: test_channel_id(),
            username: "ada".to_string(),
            display_name: None,
            channel_access: None,
        };
        let json = serde_json::to_string(&without_name).unwrap();
        assert!(
            !json.contains("displayName"),
            "absent display name must be omitted: {json}"
        );
    }

    /// Both emoji variants name correctly and are server-scoped broadcasts with
    /// no target, no channel access, and a no-op redaction (the six-match cover).
    #[test]
    fn emoji_events_are_server_scoped_broadcasts() {
        let server = test_server_id();
        let created = ServerEvent::EmojiCreated {
            sender_id: test_user_id(),
            server_id: server.clone(),
            emoji: EmojiPayload {
                id: EmojiId::new(Uuid::new_v4()),
                server_id: server.clone(),
                name: "party".to_string(),
                url: "https://x.supabase.co/storage/v1/object/public/server-emojis/s/p.png"
                    .to_string(),
                is_animated: false,
                created_by: test_user_id(),
                created_at: Utc::now(),
            },
        };
        let deleted = ServerEvent::EmojiDeleted {
            sender_id: test_user_id(),
            server_id: server.clone(),
            emoji_id: EmojiId::new(Uuid::new_v4()),
        };

        for (event, name) in [(&created, "emoji.created"), (&deleted, "emoji.deleted")] {
            assert_eq!(event.event_name(), name);
            assert_eq!(event.server_id(), Some(&server), "{name} is server-scoped");
            assert!(event.target_user_id().is_none(), "{name} is a broadcast");
            assert!(
                event.channel_access().is_none(),
                "{name} has no channel scope"
            );
        }

        // Redaction is a no-op and the tagged-union round-trips in camelCase.
        let mut redacted = created;
        redacted.redact_routing_metadata();
        let json = serde_json::to_value(&redacted).unwrap();
        assert_eq!(json["type"], "emojiCreated");
        assert_eq!(json["emoji"]["name"], "party");
        assert_eq!(json["emoji"]["isAnimated"], false);
        let back: ServerEvent = serde_json::from_value(json).unwrap();
        assert_eq!(back.event_name(), "emoji.created");
    }
}
