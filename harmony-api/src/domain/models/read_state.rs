//! Domain model for channel read state.

use chrono::{DateTime, Utc};

use super::ids::{ChannelId, MessageId};

/// A user's read position in a channel, with computed unread and mention counts.
#[derive(Debug, Clone)]
pub struct ChannelReadState {
    pub channel_id: ChannelId,
    pub unread_count: i64,
    /// Computed mention-equivalent count (§2.2): unread messages that mention
    /// this user OR any unread message in a DM channel (`servers.is_dm`). A
    /// strict subset of `unread_count`.
    pub mention_count: i64,
    pub last_read_at: Option<DateTime<Utc>>,
    pub last_message_id: Option<MessageId>,
}
