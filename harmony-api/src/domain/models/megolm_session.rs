//! Megolm session domain model.
//!
//! Represents a Megolm E2EE session registered on an encrypted channel.

use chrono::{DateTime, Utc};

use super::ids::{ChannelId, MegolmSessionId, UserId};

/// A registered Megolm session on an encrypted channel.
#[derive(Debug, Clone)]
pub struct MegolmSession {
    pub id: MegolmSessionId,
    pub channel_id: ChannelId,
    /// The vodozemac Megolm session ID (base64-encoded Ed25519 public key).
    pub session_id: String,
    pub creator_id: UserId,
    pub created_at: DateTime<Utc>,
}
