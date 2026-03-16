//! Message domain service.

use std::sync::Arc;

use chrono::{DateTime, Utc};

use crate::domain::errors::DomainError;
use crate::domain::models::{ChannelId, Message, MessageId, UserId};
use crate::domain::ports::MessageRepository;

/// Service for message-related business logic.
#[derive(Debug)]
pub struct MessageService {
    repo: Arc<dyn MessageRepository>,
}

impl MessageService {
    #[must_use]
    pub fn new(repo: Arc<dyn MessageRepository>) -> Self {
        Self { repo }
    }

    /// Send a new message to a channel.
    ///
    /// # Errors
    /// Returns `DomainError::ValidationError` if content is empty,
    /// or a repository error on failure.
    pub async fn create(
        &self,
        channel_id: &ChannelId,
        author_id: &UserId,
        content: String,
    ) -> Result<Message, DomainError> {
        if content.trim().is_empty() {
            return Err(DomainError::ValidationError(
                "Message content must not be empty".to_string(),
            ));
        }

        self.repo.create(channel_id, author_id, content).await
    }

    /// List messages in a channel with cursor-based pagination.
    ///
    /// # Errors
    /// Returns a repository error on failure.
    pub async fn list_for_channel(
        &self,
        channel_id: &ChannelId,
        cursor: Option<DateTime<Utc>>,
        limit: i64,
    ) -> Result<Vec<Message>, DomainError> {
        self.repo.list_for_channel(channel_id, cursor, limit).await
    }

    /// Edit a message's content. Only the author can edit.
    ///
    /// # Errors
    /// Returns `DomainError::ValidationError` if content is empty,
    /// `DomainError::NotFound` if the message doesn't exist or is deleted,
    /// `DomainError::Forbidden` if the caller is not the author.
    pub async fn edit_message(
        &self,
        message_id: &MessageId,
        user_id: &UserId,
        content: String,
    ) -> Result<Message, DomainError> {
        if content.trim().is_empty() {
            return Err(DomainError::ValidationError(
                "Message content must not be empty".to_string(),
            ));
        }

        let message = self
            .repo
            .find_by_id(message_id)
            .await?
            .ok_or_else(|| DomainError::NotFound {
                resource_type: "Message",
                id: message_id.to_string(),
            })?;

        if message.author_id != *user_id {
            return Err(DomainError::Forbidden(
                "Only the message author can edit this message".to_string(),
            ));
        }

        self.repo.update_content(message_id, content).await
    }

    /// Soft-delete a message. Only the author can delete (ADR-038).
    ///
    /// # Errors
    /// Returns `DomainError::NotFound` if the message doesn't exist or is deleted,
    /// `DomainError::Forbidden` if the caller is not the author.
    pub async fn delete_message(
        &self,
        message_id: &MessageId,
        user_id: &UserId,
    ) -> Result<(), DomainError> {
        let message = self
            .repo
            .find_by_id(message_id)
            .await?
            .ok_or_else(|| DomainError::NotFound {
                resource_type: "Message",
                id: message_id.to_string(),
            })?;

        if message.author_id != *user_id {
            return Err(DomainError::Forbidden(
                "Only the message author can delete this message".to_string(),
            ));
        }

        self.repo.soft_delete(message_id).await
    }
}
