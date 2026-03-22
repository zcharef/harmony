//! Channel domain service.

use std::sync::Arc;

use crate::domain::errors::DomainError;
use crate::domain::models::{Channel, ChannelId, ChannelType, ServerId, UserId};
use crate::domain::ports::ChannelRepository;

/// Maximum length for a channel name (lowercase slug).
const MAX_CHANNEL_NAME_LENGTH: usize = 100;

/// Maximum length for a channel topic.
const MAX_CHANNEL_TOPIC_LENGTH: usize = 1024;

/// Service for channel-related business logic.
#[derive(Debug)]
pub struct ChannelService {
    repo: Arc<dyn ChannelRepository>,
}

/// Validate that a channel name matches `^[a-z0-9-]{1,100}$`.
fn validate_channel_name(name: &str) -> Result<(), DomainError> {
    if name.is_empty() || name.len() > MAX_CHANNEL_NAME_LENGTH {
        return Err(DomainError::ValidationError(format!(
            "Channel name must be between 1 and {} characters",
            MAX_CHANNEL_NAME_LENGTH
        )));
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

/// Validate that a channel topic does not exceed the maximum length.
fn validate_channel_topic(topic: &str) -> Result<(), DomainError> {
    if topic.chars().count() > MAX_CHANNEL_TOPIC_LENGTH {
        return Err(DomainError::ValidationError(format!(
            "Channel topic must not exceed {} characters",
            MAX_CHANNEL_TOPIC_LENGTH
        )));
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
        is_private: bool,
        is_read_only: bool,
    ) -> Result<Channel, DomainError> {
        let normalized = name.trim().to_lowercase();
        validate_channel_name(&normalized)?;

        let channel_type = channel_type.unwrap_or(ChannelType::Text);
        let count = self.repo.count_for_server(&server_id).await?;
        let position = i32::try_from(count).unwrap_or(i32::MAX);

        let channel = Channel::new(
            server_id,
            normalized,
            channel_type,
            position,
            is_private,
            is_read_only,
        );
        self.repo.create(&channel).await
    }

    /// List channels visible to the caller in a server, ordered by position.
    ///
    /// Private channels are filtered out unless the caller has access.
    ///
    /// # Errors
    /// Returns a repository error on failure.
    pub async fn list_for_server(
        &self,
        server_id: &ServerId,
        caller_user_id: &UserId,
    ) -> Result<Vec<Channel>, DomainError> {
        self.repo.list_for_server(server_id, caller_user_id).await
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

    /// Update a channel's name, topic, and/or permission flags.
    ///
    /// # Errors
    /// Returns `DomainError::ValidationError` if the new name or topic is invalid.
    /// Returns `DomainError::Forbidden` if the channel does not belong to `server_id`.
    /// Returns `DomainError::NotFound` if the channel does not exist.
    pub async fn update_channel(
        &self,
        server_id: &ServerId,
        channel_id: &ChannelId,
        name: Option<String>,
        topic: Option<Option<String>>,
        is_private: Option<bool>,
        is_read_only: Option<bool>,
    ) -> Result<Channel, DomainError> {
        // WHY: Prevents cross-server IDOR — an admin on Server A must not
        // be able to update channels on Server B by crafting the channel_id.
        let channel = self.get_by_id(channel_id).await?;
        if channel.server_id != *server_id {
            return Err(DomainError::Forbidden(
                "Channel does not belong to this server".to_string(),
            ));
        }

        let validated_name = match name {
            Some(raw) => {
                let normalized = raw.trim().to_lowercase();
                validate_channel_name(&normalized)?;
                Some(normalized)
            }
            None => None,
        };

        // Validate topic length when provided (outer Some = field present).
        if let Some(Some(ref t)) = topic {
            validate_channel_topic(t)?;
        }

        self.repo
            .update(channel_id, validated_name, topic, is_private, is_read_only)
            .await
    }

    /// Delete a channel.
    ///
    /// # Errors
    /// Returns `DomainError::ValidationError` if this is the last channel in the server.
    /// Returns `DomainError::Forbidden` if the channel does not belong to `server_id`.
    /// Returns `DomainError::NotFound` if the channel does not exist.
    pub async fn delete_channel(
        &self,
        server_id: &ServerId,
        channel_id: &ChannelId,
    ) -> Result<(), DomainError> {
        // WHY: Prevents cross-server IDOR — an admin on Server A must not
        // be able to delete channels on Server B by crafting the channel_id.
        let channel = self.get_by_id(channel_id).await?;
        if channel.server_id != *server_id {
            return Err(DomainError::Forbidden(
                "Channel does not belong to this server".to_string(),
            ));
        }

        self.repo.delete_if_not_last(channel_id).await
    }
}
