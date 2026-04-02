//! Notification settings domain service.

use std::sync::Arc;

use crate::domain::errors::DomainError;
use crate::domain::models::{ChannelId, UserId};
use crate::domain::ports::{NotificationLevel, NotificationSettingsRepository};

/// Service for per-channel notification settings.
#[derive(Debug)]
pub struct NotificationSettingsService {
    repo: Arc<dyn NotificationSettingsRepository>,
}

impl NotificationSettingsService {
    #[must_use]
    pub fn new(repo: Arc<dyn NotificationSettingsRepository>) -> Self {
        Self { repo }
    }

    /// Get the notification level for a user in a channel.
    /// Defaults to `All` when no explicit setting exists.
    ///
    /// # Errors
    /// Returns a repository error on failure.
    pub async fn get(
        &self,
        channel_id: &ChannelId,
        user_id: &UserId,
    ) -> Result<NotificationLevel, DomainError> {
        let level = self.repo.get(channel_id, user_id).await?;
        Ok(level.unwrap_or(NotificationLevel::All))
    }

    /// Update the notification level for a user in a channel.
    ///
    /// # Errors
    /// Returns a repository error on failure.
    pub async fn upsert(
        &self,
        channel_id: &ChannelId,
        user_id: &UserId,
        level: NotificationLevel,
    ) -> Result<(), DomainError> {
        self.repo.upsert(channel_id, user_id, level).await
    }
}
