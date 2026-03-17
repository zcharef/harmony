//! Channel domain service.

use std::sync::Arc;

use crate::domain::errors::DomainError;
use crate::domain::models::{Channel, ChannelId, ChannelType, ServerId};
use crate::domain::ports::ChannelRepository;

/// Service for channel-related business logic.
#[derive(Debug)]
pub struct ChannelService {
    repo: Arc<dyn ChannelRepository>,
}

/// Validate that a channel name matches `^[a-z0-9-]{1,100}$`.
fn validate_channel_name(name: &str) -> Result<(), DomainError> {
    if name.is_empty() || name.len() > 100 {
        return Err(DomainError::ValidationError(
            "Channel name must be between 1 and 100 characters".to_string(),
        ));
    }

    let valid = name
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');

    if !valid {
        return Err(DomainError::ValidationError(
            "Channel name may only contain lowercase letters, digits, and hyphens".to_string(),
        ));
    }

    Ok(())
}

impl ChannelService {
    #[must_use]
    pub fn new(repo: Arc<dyn ChannelRepository>) -> Self {
        Self { repo }
    }

    /// Create a new channel in a server.
    ///
    /// # Errors
    /// Returns `DomainError::ValidationError` if the name is invalid.
    pub async fn create_channel(
        &self,
        server_id: ServerId,
        name: String,
        channel_type: Option<ChannelType>,
    ) -> Result<Channel, DomainError> {
        let normalized = name.trim().to_lowercase();
        validate_channel_name(&normalized)?;

        let channel_type = channel_type.unwrap_or(ChannelType::Text);
        let count = self.repo.count_for_server(&server_id).await?;
        let position = i32::try_from(count).unwrap_or(i32::MAX);

        let channel = Channel::new(server_id, normalized, channel_type, position);
        self.repo.create(&channel).await
    }

    /// List all channels in a server, ordered by position.
    ///
    /// # Errors
    /// Returns a repository error on failure.
    pub async fn list_for_server(&self, server_id: &ServerId) -> Result<Vec<Channel>, DomainError> {
        self.repo.list_for_server(server_id).await
    }

    /// Get a channel by ID.
    ///
    /// # Errors
    /// Returns `DomainError::NotFound` if the channel does not exist.
    pub async fn get_by_id(&self, channel_id: &ChannelId) -> Result<Channel, DomainError> {
        self.repo
            .get_by_id(channel_id)
            .await?
            .ok_or_else(|| DomainError::NotFound {
                resource_type: "Channel",
                id: channel_id.to_string(),
            })
    }

    /// Update a channel's name and/or topic.
    ///
    /// # Errors
    /// Returns `DomainError::ValidationError` if the new name is invalid.
    pub async fn update_channel(
        &self,
        channel_id: &ChannelId,
        name: Option<String>,
        topic: Option<Option<String>>,
    ) -> Result<Channel, DomainError> {
        let validated_name = match name {
            Some(raw) => {
                let normalized = raw.trim().to_lowercase();
                validate_channel_name(&normalized)?;
                Some(normalized)
            }
            None => None,
        };

        self.repo.update(channel_id, validated_name, topic).await
    }

    /// Delete a channel.
    ///
    /// # Errors
    /// Returns `DomainError::ValidationError` if this is the last channel in the server.
    /// Returns `DomainError::NotFound` if the channel does not exist.
    pub async fn delete_channel(&self, channel_id: &ChannelId) -> Result<(), DomainError> {
        self.repo.delete_if_not_last(channel_id).await
    }
}
