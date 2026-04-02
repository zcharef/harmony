//! Port: channel read state persistence.

use async_trait::async_trait;

use crate::domain::errors::DomainError;
use crate::domain::models::{ChannelId, ChannelReadState, MessageId, UserId};

/// Intent-based repository for channel read states.
#[async_trait]
pub trait ReadStateRepository: Send + Sync + std::fmt::Debug {
    /// Upsert the user's read position for a channel.
    async fn mark_read(
        &self,
        channel_id: &ChannelId,
        user_id: &UserId,
        last_message_id: &MessageId,
    ) -> Result<(), DomainError>;

    /// List channels with unread messages across ALL servers the user belongs to.
    /// Returns only channels with unread > 0, capped at 999 per channel.
    /// Used by the SSE `unread.sync` initial snapshot.
    async fn list_all_for_user(
        &self,
        user_id: &UserId,
    ) -> Result<Vec<ChannelReadState>, DomainError>;
}
