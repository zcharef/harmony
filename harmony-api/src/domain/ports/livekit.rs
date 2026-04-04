//! Port: `LiveKit` token generation.

use crate::domain::errors::DomainError;
use crate::domain::models::UserId;

/// Grants embedded in a `LiveKit` JWT for a single voice participant.
#[derive(Debug)]
pub struct VoiceGrants {
    pub can_publish: bool,
    pub can_subscribe: bool,
    pub bitrate_kbps: i32,
    pub max_duration_secs: u64,
}

/// Generates `LiveKit` JWTs for voice channel access.
///
/// NOT async -- token generation is pure CPU (JWT signing), no I/O.
pub trait LiveKitTokenGenerator: Send + Sync + std::fmt::Debug {
    /// Create a signed JWT for the given user and room.
    ///
    /// # Errors
    /// Returns `DomainError::Internal` if JWT signing fails.
    fn generate_token(
        &self,
        room_name: &str,
        user_id: &UserId,
        display_name: &str,
        grants: VoiceGrants,
    ) -> Result<String, DomainError>;

    /// The `LiveKit` server URL clients connect to (e.g. `wss://livekit.example.com`).
    fn livekit_url(&self) -> &str;
}
