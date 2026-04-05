//! Voice DTOs (request/response types).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::domain::models::{ChannelId, UserId, VoiceParticipant, VoiceToken};

/// Request body for the voice heartbeat endpoint.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VoiceHeartbeatRequest {
    /// The session identifier returned when the user joined voice.
    /// Ensures only the current device's session receives the heartbeat.
    pub session_id: String,
    /// Whether the user is actively participating (speaking, unmuted).
    /// `None` means the client didn't send a value; handler treats that as
    /// `true` via `unwrap_or(true)` for backward compatibility.
    #[serde(default)]
    pub is_active: Option<bool>,
    /// Whether the user's microphone is muted. Muted users are still
    /// considered "active" for AFK purposes (they are listening).
    #[serde(default)]
    pub is_muted: Option<bool>,
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

impl From<VoiceParticipant> for VoiceParticipantResponse {
    fn from(p: VoiceParticipant) -> Self {
        Self {
            user_id: p.user_id,
            channel_id: p.channel_id,
            display_name: p.display_name,
            joined_at: p.joined_at,
        }
    }
}

/// Envelope for a list of voice participants (ADR-036).
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct VoiceParticipantsResponse {
    pub items: Vec<VoiceParticipantResponse>,
    pub total: i64,
}

impl VoiceParticipantsResponse {
    pub fn from_participants(participants: Vec<VoiceParticipant>) -> Self {
        #[allow(clippy::cast_possible_wrap)]
        let total = participants.len() as i64;
        Self {
            items: participants.into_iter().map(Into::into).collect(),
            total,
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    /// T8.16: Missing `isActive` deserializes to `None`; handler uses
    /// `unwrap_or(true)` so the runtime behavior is identical.
    #[test]
    fn heartbeat_dto_missing_is_active_defaults_to_none() {
        let json = r#"{"sessionId":"test-session-123"}"#;
        let dto: VoiceHeartbeatRequest =
            serde_json::from_str(json).expect("should deserialize with missing isActive");

        assert_eq!(dto.session_id, "test-session-123");
        assert_eq!(
            dto.is_active, None,
            "Missing isActive should be None; handler unwrap_or(true) preserves backward compat"
        );
    }

    /// T8.17: Missing `isMuted` defaults to not-muted (None).
    #[test]
    fn heartbeat_dto_missing_is_muted_defaults_to_none() {
        let json = r#"{"sessionId":"test-session-456"}"#;
        let dto: VoiceHeartbeatRequest =
            serde_json::from_str(json).expect("should deserialize with missing isMuted");

        assert_eq!(dto.session_id, "test-session-456");
        assert_eq!(dto.is_muted, None, "Missing isMuted should default to None");
    }

    /// T8.18: Full payload with all fields deserializes correctly.
    #[test]
    fn heartbeat_dto_full_payload_deserializes_correctly() {
        let json = r#"{"sessionId":"x","isActive":false,"isMuted":true}"#;
        let dto: VoiceHeartbeatRequest =
            serde_json::from_str(json).expect("should deserialize full payload");

        assert_eq!(dto.session_id, "x");
        assert_eq!(dto.is_active, Some(false), "isActive should be Some(false)");
        assert_eq!(dto.is_muted, Some(true), "isMuted should be Some(true)");
    }
}
