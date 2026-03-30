//! Domain model for channel read state.

use chrono::{DateTime, Utc};

use super::ids::{ChannelId, MessageId};

/// A user's read position in a channel, with computed unread count.
#[derive(Debug, Clone)]
pub struct ChannelReadState {
    pub channel_id: ChannelId,
    pub unread_count: i64,
    pub last_read_at: Option<DateTime<Utc>>,
    pub last_message_id: Option<MessageId>,
}
