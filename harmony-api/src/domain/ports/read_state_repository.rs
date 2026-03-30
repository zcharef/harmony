//! Port: channel read state persistence.

use async_trait::async_trait;

use crate::domain::errors::DomainError;
use crate::domain::models::{ChannelId, ChannelReadState, MessageId, ServerId, UserId};

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

    /// List read states with computed unread counts for all channels in a server.
    async fn list_for_server(
        &self,
        server_id: &ServerId,
        user_id: &UserId,
    ) -> Result<Vec<ChannelReadState>, DomainError>;
}
