//! Port: notification settings persistence.

use async_trait::async_trait;

use crate::domain::errors::DomainError;
use crate::domain::models::{ChannelId, UserId};

/// Notification level for a channel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NotificationLevel {
    All,
    Mentions,
    None,
}

/// Intent-based repository for per-channel notification settings.
#[async_trait]
pub trait NotificationSettingsRepository: Send + Sync + std::fmt::Debug {
    /// Get the notification level for a user in a channel.
    /// Returns `None` when no row exists (caller should default to `All`).
    async fn get(
        &self,
        channel_id: &ChannelId,
        user_id: &UserId,
    ) -> Result<Option<NotificationLevel>, DomainError>;

    /// Insert or update the notification level for a user in a channel.
    async fn upsert(
        &self,
        channel_id: &ChannelId,
        user_id: &UserId,
        level: NotificationLevel,
    ) -> Result<(), DomainError>;
}
