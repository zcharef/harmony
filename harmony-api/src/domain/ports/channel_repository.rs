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

    /// Create a new channel. Returns the created channel.
    async fn create(&self, channel: &Channel) -> Result<Channel, DomainError>;

    /// Update a channel's name and/or topic. Returns the updated channel.
    ///
    /// `topic` uses `Option<Option<String>>`: outer = "was field provided?",
    /// inner = "null (clear) or a value". Follows JSON PATCH semantics.
    async fn update(
        &self,
        channel_id: &ChannelId,
        name: Option<String>,
        topic: Option<Option<String>>,
    ) -> Result<Channel, DomainError>;

    /// Delete a channel by ID, unless it is the last channel in its server.
    ///
    /// Returns `Ok(())` on success, `DomainError::ValidationError` if this is
    /// the last channel, or `DomainError::NotFound` if the channel does not exist.
    /// The check and delete are atomic (single SQL statement) to prevent TOCTOU races.
    async fn delete_if_not_last(&self, channel_id: &ChannelId) -> Result<(), DomainError>;

    /// Count channels in a server (used for position auto-assignment on create).
    async fn count_for_server(&self, server_id: &ServerId) -> Result<i64, DomainError>;
}
