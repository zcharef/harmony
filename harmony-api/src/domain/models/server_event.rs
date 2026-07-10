//! Server-sent events for real-time updates.
//!
//! Each variant maps to an SSE event type (e.g. `message.created`).
//! Events carry full payload data so the client never needs to
//! resolve IDs from cache (ADR-SSE-003).

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::Channel;
use super::ChannelType;
use super::MentionedUser;
use super::MessageWithAuthor;
use super::UserStatus;
use super::ids::{ChannelId, MessageId, ServerId, UserId};
use super::message::MessageType;
use super::role::Role;
use super::voice_session::VoiceAction;

// ── Payload structs ──────────────────────────────────────────────

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
    pub created_at: DateTime<Utc>,
}

impl From<MessageWithAuthor> for MessagePayload {
    fn from(mwa: MessageWithAuthor) -> Self {
        let mentions = mwa.mentions;
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
    },
    ChannelUpdated {
        sender_id: UserId,
        server_id: ServerId,
        channel: ChannelPayload,
    },
    ChannelDeleted {
        sender_id: UserId,
        server_id: ServerId,
        channel_id: ChannelId,
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

    // ── Profiles (user-scoped, not server-scoped) ────────────
    /// A user's public profile changed (display name / avatar / custom status).
    /// Carries the NEW current values so every observer can rehydrate the
    /// subject's identity everywhere it is cached, Discord-style. A `null`
    /// field means the value was cleared (not "unchanged") — the event is a
    /// full snapshot, not a patch, so the three fields are serialized even
    /// when null.
    ProfileUpdated {
        sender_id: UserId,
        user_id: UserId,
        display_name: Option<String>,
        avatar_url: Option<String>,
        custom_status: Option<String>,
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
            Self::MemberJoined { .. } => "member.joined",
            Self::MemberRemoved { .. } => "member.removed",
            Self::MemberBanned { .. } => "member.banned",
            Self::MemberRoleUpdated { .. } => "member.role_updated",
            Self::ChannelCreated { .. } => "channel.created",
            Self::ChannelUpdated { .. } => "channel.updated",
            Self::ChannelDeleted { .. } => "channel.deleted",
            Self::ServerUpdated { .. } => "server.updated",
            Self::ModerationSettingsUpdated { .. } => "server.moderation_settings_updated",
            Self::DmCreated { .. } => "dm.created",
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
            | Self::MemberJoined { sender_id, .. }
            | Self::MemberRemoved { sender_id, .. }
            | Self::MemberBanned { sender_id, .. }
            | Self::MemberRoleUpdated { sender_id, .. }
            | Self::ChannelCreated { sender_id, .. }
            | Self::ChannelUpdated { sender_id, .. }
            | Self::ChannelDeleted { sender_id, .. }
            | Self::ServerUpdated { sender_id, .. }
            | Self::ModerationSettingsUpdated { sender_id, .. }
            | Self::DmCreated { sender_id, .. }
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
            | Self::MemberJoined { server_id, .. }
            | Self::MemberRemoved { server_id, .. }
            | Self::MemberBanned { server_id, .. }
            | Self::MemberRoleUpdated { server_id, .. }
            | Self::ChannelCreated { server_id, .. }
            | Self::ChannelUpdated { server_id, .. }
            | Self::ChannelDeleted { server_id, .. }
            | Self::ServerUpdated { server_id, .. }
            | Self::ModerationSettingsUpdated { server_id, .. }
            | Self::TypingStarted { server_id, .. }
            | Self::ReactionAdded { server_id, .. }
            | Self::ReactionRemoved { server_id, .. }
            | Self::VoiceStateUpdate { server_id, .. }
            | Self::MentionReceived { server_id, .. }
            | Self::ForceDisconnect { server_id, .. } => Some(server_id),
            Self::DmCreated { .. } | Self::ProfileUpdated { .. } | Self::PresenceChanged { .. } => {
                None
            }
        }
    }

    /// Target user for user-directed events (`DmCreated`, `MemberBanned`, `ForceDisconnect`).
    /// Returns `None` for broadcast events.
    #[must_use]
    pub fn target_user_id(&self) -> Option<&UserId> {
        match self {
            Self::DmCreated { target_user_id, .. }
            | Self::MemberBanned { target_user_id, .. }
            | Self::MentionReceived { target_user_id, .. }
            | Self::ForceDisconnect { target_user_id, .. } => Some(target_user_id),
            Self::MessageCreated { .. }
            | Self::MessageUpdated { .. }
            | Self::MessageDeleted { .. }
            | Self::MemberJoined { .. }
            | Self::MemberRemoved { .. }
            | Self::MemberRoleUpdated { .. }
            | Self::ChannelCreated { .. }
            | Self::ChannelUpdated { .. }
            | Self::ChannelDeleted { .. }
            | Self::ServerUpdated { .. }
            | Self::ModerationSettingsUpdated { .. }
            | Self::ProfileUpdated { .. }
            | Self::TypingStarted { .. }
            | Self::PresenceChanged { .. }
            | Self::ReactionAdded { .. }
            | Self::ReactionRemoved { .. }
            | Self::VoiceStateUpdate { .. } => None,
        }
    }

    /// Private-channel access scope for channel-scoped events, if any.
    ///
    /// `Some` only for the six channel events (message/reaction/typing) that
    /// target a PRIVATE channel; `None` for public channels and every other
    /// variant. The SSE Stage-2 filter uses this to gate delivery by channel
    /// access, then redacts it (sets it to `None`) before serializing to clients.
    #[must_use]
    pub fn channel_access(&self) -> Option<&ChannelAccessScope> {
        match self {
            Self::MessageCreated { channel_access, .. }
            | Self::MessageUpdated { channel_access, .. }
            | Self::MessageDeleted { channel_access, .. }
            | Self::TypingStarted { channel_access, .. }
            | Self::ReactionAdded { channel_access, .. }
            | Self::ReactionRemoved { channel_access, .. } => channel_access.as_ref(),
            Self::MemberJoined { .. }
            | Self::MemberRemoved { .. }
            | Self::MemberBanned { .. }
            | Self::MemberRoleUpdated { .. }
            | Self::ChannelCreated { .. }
            | Self::ChannelUpdated { .. }
            | Self::ChannelDeleted { .. }
            | Self::ServerUpdated { .. }
            | Self::ModerationSettingsUpdated { .. }
            | Self::DmCreated { .. }
            | Self::ProfileUpdated { .. }
            | Self::PresenceChanged { .. }
            | Self::VoiceStateUpdate { .. }
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
            | Self::TypingStarted { channel_access, .. }
            | Self::ReactionAdded { channel_access, .. }
            | Self::ReactionRemoved { channel_access, .. } => *channel_access = None,
            Self::PresenceChanged { server_ids, .. } | Self::ProfileUpdated { server_ids, .. } => {
                server_ids.clear();
            }
            Self::MemberJoined { .. }
            | Self::MemberRemoved { .. }
            | Self::MemberBanned { .. }
            | Self::MemberRoleUpdated { .. }
            | Self::ChannelCreated { .. }
            | Self::ChannelUpdated { .. }
            | Self::ChannelDeleted { .. }
            | Self::ServerUpdated { .. }
            | Self::ModerationSettingsUpdated { .. }
            | Self::DmCreated { .. }
            | Self::MentionReceived { .. }
            | Self::VoiceStateUpdate { .. }
            | Self::ForceDisconnect { .. } => {}
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
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
            channel_access: Some(scope.clone()),
        };

        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("channelAccess"));
        assert!(json.contains("authorizedRoles"));

        let back: ServerEvent = serde_json::from_str(&json).unwrap();
        assert_eq!(back.channel_access(), Some(&scope));
    }

    #[test]
    fn profile_updated_event_name_and_scope_accessors() {
        let event = ServerEvent::ProfileUpdated {
            sender_id: test_user_id(),
            user_id: test_user_id(),
            display_name: Some("Ada".to_string()),
            avatar_url: None,
            custom_status: None,
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
            server_ids: Vec::new(),
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["type"], "profileUpdated");
        assert!(json["displayName"].is_null());
        assert!(json["avatarUrl"].is_null());
        assert!(json["customStatus"].is_null());
        // Empty routing metadata is omitted entirely.
        assert!(json.get("serverIds").is_none());
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
}
