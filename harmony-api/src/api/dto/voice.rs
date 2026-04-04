//! Voice DTOs (request/response types).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::domain::models::{ChannelId, UserId, VoiceToken};

/// Request body for the voice heartbeat endpoint.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VoiceHeartbeatRequest {
    /// The session identifier returned when the user joined voice.
    /// Ensures only the current device's session receives the heartbeat.
    pub session_id: String,
}

/// Voice token response returned after joining a voice channel.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct VoiceTokenResponse {
    /// `LiveKit` JWT token for the client to connect with.
    pub token: String,
    /// `LiveKit` server URL to connect to.
    pub url: String,
    /// Token time-to-live in seconds. Frontend schedules refresh at 80% of this.
    #[schema(example = 7200)]
    pub ttl_secs: u32,
    /// Opaque session identifier. Clients must send this back in heartbeats
    /// so the server can distinguish the current device from stale ones.
    pub session_id: String,
    /// Channel the user was previously in (if auto-moved). Clients use this
    /// to update UI state for the old channel.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_channel_id: Option<ChannelId>,
}

impl From<VoiceToken> for VoiceTokenResponse {
    fn from(vt: VoiceToken) -> Self {
        Self {
            token: vt.token,
            url: vt.url,
            ttl_secs: vt.ttl_secs,
            session_id: vt.session_id,
            previous_channel_id: vt.previous_channel_id,
        }
    }
}

/// A single voice participant in a channel.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct VoiceParticipantResponse {
    pub user_id: UserId,
    pub channel_id: ChannelId,
    /// Display name (nickname or username). Populated from the user's
    /// profile — not stored on `VoiceSession` itself.
    pub display_name: String,
    pub joined_at: DateTime<Utc>,
}

/// Envelope for a list of voice participants (ADR-036).
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct VoiceParticipantsResponse {
    pub items: Vec<VoiceParticipantResponse>,
    pub total: i64,
}
