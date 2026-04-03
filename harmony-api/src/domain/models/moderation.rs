//! Moderation domain models.
//!
//! Per-server AI moderation configuration, separate from the `Server` model
//! to avoid rippling through every SELECT/DTO.

use std::collections::HashMap;

use chrono::{DateTime, Utc};

use super::ids::{ChannelId, MessageId, ModerationRetryId, ServerId};

/// Per-server AI moderation configuration (Tier 2 category toggles).
/// WHY: Separate from `Server` to avoid rippling through every SELECT/DTO.
/// Only fetched by the moderation pipeline and settings endpoints.
#[derive(Debug, Clone)]
pub struct ServerModerationSettings {
    pub server_id: ServerId,
    pub categories: HashMap<String, bool>,
}

/// A failed moderation check awaiting retry.
/// WHY: When the `OpenAI` Moderation API fails (retries exhausted) for a
/// Tier 1 category check, letting the message pass unmoderated is
/// unacceptable. This dead-letter record captures the failure for
/// background retry.
#[derive(Debug, Clone)]
pub struct ModerationRetry {
    pub id: ModerationRetryId,
    pub message_id: MessageId,
    pub server_id: ServerId,
    pub channel_id: ChannelId,
    pub content: String,
    pub retry_count: i32,
    pub last_error: Option<String>,
    pub created_at: DateTime<Utc>,
}
