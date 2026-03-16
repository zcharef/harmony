//! Channel DTOs (request/response types).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::domain::models::{CategoryId, Channel, ChannelId, ChannelType, ServerId};

/// Channel response returned to API consumers.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChannelResponse {
    pub id: ChannelId,
    pub server_id: ServerId,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topic: Option<String>,
    pub channel_type: ChannelType,
    pub position: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category_id: Option<CategoryId>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl From<Channel> for ChannelResponse {
    fn from(c: Channel) -> Self {
        Self {
            id: c.id,
            server_id: c.server_id,
            name: c.name,
            topic: c.topic,
            channel_type: c.channel_type,
            position: c.position,
            category_id: c.category_id,
            created_at: c.created_at,
            updated_at: c.updated_at,
        }
    }
}

/// Envelope for a list of channels (ADR-036).
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChannelListResponse {
    pub items: Vec<ChannelResponse>,
}

impl From<Vec<Channel>> for ChannelListResponse {
    fn from(channels: Vec<Channel>) -> Self {
        Self {
            items: channels.into_iter().map(ChannelResponse::from).collect(),
        }
    }
}

/// Request body for creating a new channel.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateChannelRequest {
    /// Channel name (lowercase alphanumeric + hyphens, 1-100 chars).
    pub name: String,
    /// Channel type (defaults to "text" if omitted).
    #[serde(default)]
    pub channel_type: Option<ChannelType>,
}

/// Request body for updating an existing channel.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateChannelRequest {
    /// New channel name (if provided).
    #[serde(default)]
    pub name: Option<String>,
    /// New channel topic (if provided; null clears it).
    #[serde(default)]
    pub topic: Option<Option<String>>,
}
