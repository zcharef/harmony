//! Port: channel persistence.

use async_trait::async_trait;

use crate::domain::errors::DomainError;
use crate::domain::models::{Channel, ChannelId, ServerId};

/// Intent-based repository for channels.
#[async_trait]
pub trait ChannelRepository: Send + Sync + std::fmt::Debug {
    /// List all channels in a server, ordered by position.
    async fn list_for_server(&self, server_id: &ServerId) -> Result<Vec<Channel>, DomainError>;

    /// Get a channel by ID. Returns `None` if not found.
    async fn get_by_id(&self, channel_id: &ChannelId) -> Result<Option<Channel>, DomainError>;
}
