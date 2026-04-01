//! Read state domain service.

use std::sync::Arc;

use crate::domain::errors::DomainError;
use crate::domain::models::{ChannelId, ChannelReadState, MessageId, UserId};
use crate::domain::ports::ReadStateRepository;

/// Service for channel read state business logic.
#[derive(Debug)]
pub struct ReadStateService {
    repo: Arc<dyn ReadStateRepository>,
}

impl ReadStateService {
    #[must_use]
    pub fn new(repo: Arc<dyn ReadStateRepository>) -> Self {
        Self { repo }
    }

    /// Mark a channel as read up to a specific message.
    ///
    /// # Errors
    /// Returns `DomainError` on repository failure.
    pub async fn mark_read(
        &self,
        channel_id: &ChannelId,
        user_id: &UserId,
        last_message_id: &MessageId,
    ) -> Result<(), DomainError> {
        self.repo
            .mark_read(channel_id, user_id, last_message_id)
            .await
    }

    /// List channels with unread messages across all servers the user belongs to.
    /// Used by the SSE `unread.sync` initial snapshot.
    ///
    /// # Errors
    /// Returns `DomainError` on repository failure.
    pub async fn list_all_for_user(
        &self,
        user_id: &UserId,
    ) -> Result<Vec<ChannelReadState>, DomainError> {
        self.repo.list_all_for_user(user_id).await
    }
}
