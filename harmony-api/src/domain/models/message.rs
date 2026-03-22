//! Message domain model.
//!
//! Chat messages within a channel. Supports soft delete (ADR-038).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::ids::{ChannelId, MessageId, UserId};

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
    pub created_at: DateTime<Utc>,
}
