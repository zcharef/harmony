//! Notification settings DTOs (request/response types).

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::domain::models::ChannelId;
use crate::domain::ports::NotificationLevel as DomainNotificationLevel;

/// Notification level for a channel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum NotificationLevel {
    All,
    Mentions,
    None,
}

impl From<DomainNotificationLevel> for NotificationLevel {
    fn from(level: DomainNotificationLevel) -> Self {
        match level {
            DomainNotificationLevel::All => Self::All,
            DomainNotificationLevel::Mentions => Self::Mentions,
            DomainNotificationLevel::None => Self::None,
        }
    }
}

impl From<NotificationLevel> for DomainNotificationLevel {
    fn from(level: NotificationLevel) -> Self {
        match level {
            NotificationLevel::All => Self::All,
            NotificationLevel::Mentions => Self::Mentions,
            NotificationLevel::None => Self::None,
        }
    }
}

/// Request body for updating notification settings.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateNotificationSettingsRequest {
    pub level: NotificationLevel,
}

/// Response for notification settings.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSettingsResponse {
    pub channel_id: ChannelId,
    pub level: NotificationLevel,
}

impl NotificationSettingsResponse {
    #[must_use]
    pub fn new(channel_id: ChannelId, level: NotificationLevel) -> Self {
        Self { channel_id, level }
    }
}
