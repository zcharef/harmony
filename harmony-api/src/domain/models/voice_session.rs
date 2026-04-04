//! Voice session domain model.
//!
//! Tracks users currently connected to a voice channel.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::ids::{ChannelId, ServerId, UserId, VoiceSessionId};

/// A user's active voice session in a channel.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceSession {
    pub id: VoiceSessionId,
    pub user_id: UserId,
    pub channel_id: ChannelId,
    pub server_id: ServerId,
    pub session_id: String,
    pub joined_at: DateTime<Utc>,
    pub last_seen_at: DateTime<Utc>,
}

/// Input for creating a new voice session. No id or timestamps — DB generates those.
#[derive(Debug, Clone)]
pub struct NewVoiceSession {
    pub user_id: UserId,
    pub channel_id: ChannelId,
    pub server_id: ServerId,
    pub session_id: String,
}

/// Voice channel action for SSE events.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum VoiceAction {
    Joined,
    Left,
}

/// Token and metadata returned after a successful `join_voice` call.
#[derive(Debug)]
pub struct VoiceToken {
    pub token: String,
    pub url: String,
    /// WHY: Clients send this back in heartbeats so the server can validate
    /// that the heartbeat belongs to the current session, not a stale device.
    pub session_id: String,
    pub previous_channel_id: Option<ChannelId>,
    /// WHY: When auto-leaving a channel on a different server, the SSE "left"
    /// event must target the OLD server so its subscribers receive it.
    pub previous_server_id: Option<ServerId>,
    pub server_id: ServerId,
    pub channel_id: ChannelId,
    pub user_id: UserId,
}
