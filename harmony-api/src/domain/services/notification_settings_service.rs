//! Notification settings domain service.

use std::sync::Arc;

use crate::domain::errors::DomainError;
use crate::domain::models::{ChannelId, UserId};
use crate::domain::ports::{
    ChannelRepository, MemberRepository, NotificationLevel, NotificationSettingsRepository,
};
use crate::domain::services::channel_access::ensure_channel_access;

/// Service for per-channel notification settings.
#[derive(Debug)]
pub struct NotificationSettingsService {
    repo: Arc<dyn NotificationSettingsRepository>,
    channel_repo: Arc<dyn ChannelRepository>,
    member_repo: Arc<dyn MemberRepository>,
}

impl NotificationSettingsService {
    #[must_use]
    pub fn new(
        repo: Arc<dyn NotificationSettingsRepository>,
        channel_repo: Arc<dyn ChannelRepository>,
        member_repo: Arc<dyn MemberRepository>,
    ) -> Self {
        Self {
            repo,
            channel_repo,
            member_repo,
        }
    }

    /// Get the notification level for a user in a channel.
    /// Defaults to `All` when no explicit setting exists.
    ///
    /// WHY ungated: returns only the caller's own row (or the default) —
    /// nothing to leak.
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
    /// WHY the access gate: without it any authenticated user could upsert
    /// rows for arbitrary existing channel UUIDs (treat every endpoint as
    /// exposed). Delegates to the shared [`ensure_channel_access`] helper so
    /// this path can't drift from the message/reaction/read-state paths.
    ///
    /// # Errors
    /// Returns `DomainError::NotFound` if the channel doesn't exist,
    /// `DomainError::Forbidden` if the user is not a server member or lacks
    /// private-channel access, or a repository error on failure.
    pub async fn upsert(
        &self,
        channel_id: &ChannelId,
        user_id: &UserId,
        level: NotificationLevel,
    ) -> Result<(), DomainError> {
        let channel = self
            .channel_repo
            .get_by_id(channel_id)
            .await?
            .ok_or_else(|| DomainError::NotFound {
                resource_type: "Channel",
                id: channel_id.to_string(),
            })?;

        ensure_channel_access(&*self.channel_repo, &*self.member_repo, &channel, user_id).await?;

        self.repo.upsert(channel_id, user_id, level).await
    }

    /// List all channel overrides for a user (bounded, newest-updated first).
    ///
    /// # Errors
    /// Returns a repository error on failure.
    pub async fn list_for_user(
        &self,
        user_id: &UserId,
    ) -> Result<Vec<(ChannelId, NotificationLevel)>, DomainError> {
        self.repo.list_for_user(user_id).await
    }
}
