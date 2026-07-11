//! Read state DTOs (request/response types).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::domain::models::{ChannelId, ChannelReadState, MessageId};

/// Request body for marking a channel as read.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MarkReadRequest {
    /// ID of the last message the user has read.
    pub last_message_id: MessageId,
}

/// The caller's read position for a single channel — powers the "new messages"
/// divider anchor (unread-divider ticket §3.1).
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChannelReadStateResponse {
    pub channel_id: ChannelId,
    /// RFC 3339 timestamp of the last read position. `None` = never read.
    pub last_read_at: Option<DateTime<Utc>>,
    pub last_read_message_id: Option<MessageId>,
    /// Unread count, capped at 999 (matches the SSE `unread.sync` snapshot).
    pub unread_count: i64,
    pub mention_count: i64,
}

impl From<ChannelReadState> for ChannelReadStateResponse {
    fn from(s: ChannelReadState) -> Self {
        Self {
            channel_id: s.channel_id,
            last_read_at: s.last_read_at,
            last_read_message_id: s.last_message_id,
            unread_count: s.unread_count,
            mention_count: s.mention_count,
        }
    }
}
