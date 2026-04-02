//! Channel DTOs (request/response types).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::domain::models::{
    CategoryId, Channel, ChannelId, ChannelType, MegolmSession, MegolmSessionId, ServerId,
};

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
    pub is_private: bool,
    pub is_read_only: bool,
    /// Whether Megolm E2EE is enabled on this channel.
    pub encrypted: bool,
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
            is_private: c.is_private,
            is_read_only: c.is_read_only,
            encrypted: c.encrypted,
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
    /// Whether the channel is private (visible only to admin+ or explicit role grants).
    #[serde(default)]
    pub is_private: bool,
    /// Whether the channel is read-only (only admin+ can post messages).
    #[serde(default)]
    pub is_read_only: bool,
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
    /// Update private flag (if provided).
    #[serde(default)]
    pub is_private: Option<bool>,
    /// Update read-only flag (if provided).
    #[serde(default)]
    pub is_read_only: Option<bool>,
    /// Enable Megolm E2EE (one-way toggle: once true, cannot be set back to false).
    #[serde(default)]
    pub encrypted: Option<bool>,
}

/// Request body for registering a Megolm session on a channel.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateMegolmSessionRequest {
    /// The vodozemac Megolm session ID (base64-encoded Ed25519 public key).
    pub session_id: String,
}

/// Response after registering a Megolm session.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MegolmSessionResponse {
    /// Server-generated record ID.
    pub id: MegolmSessionId,
    pub channel_id: ChannelId,
    pub session_id: String,
    pub created_at: DateTime<Utc>,
}

impl From<MegolmSession> for MegolmSessionResponse {
    fn from(s: MegolmSession) -> Self {
        Self {
            id: s.id,
            channel_id: s.channel_id,
            session_id: s.session_id,
            created_at: s.created_at,
        }
    }
}
