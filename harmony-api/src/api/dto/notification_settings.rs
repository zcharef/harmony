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

/// Response for the bulk notification-settings list (ADR-036 envelope).
///
/// WHY `next_cursor` is always `None`: rows exist only for explicit user
/// overrides and the query is capped server-side (stalest dropped, logged).
/// The envelope keeps the shape forward-compatible without cursor plumbing.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListNotificationSettingsResponse {
    pub items: Vec<NotificationSettingsResponse>,
    pub total: i64,
    pub next_cursor: Option<String>,
}

impl From<Vec<(ChannelId, DomainNotificationLevel)>> for ListNotificationSettingsResponse {
    fn from(overrides: Vec<(ChannelId, DomainNotificationLevel)>) -> Self {
        let items: Vec<NotificationSettingsResponse> = overrides
            .into_iter()
            .map(|(channel_id, level)| NotificationSettingsResponse::new(channel_id, level.into()))
            .collect();
        let total = i64::try_from(items.len()).unwrap_or(i64::MAX);
        Self {
            items,
            total,
            next_cursor: None,
        }
    }
}
