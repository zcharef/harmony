//! Message domain service.

use std::sync::Arc;

use chrono::{DateTime, Utc};

use crate::domain::errors::DomainError;
use crate::domain::models::{ChannelId, Message, UserId};
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
}
