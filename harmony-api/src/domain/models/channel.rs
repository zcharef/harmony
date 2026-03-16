//! Channel domain model.
//!
//! Text or voice channel within a server.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

use super::ids::{CategoryId, ChannelId, ServerId};

/// Channel type (matches Postgres `channel_type` enum).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum ChannelType {
    Text,
    Voice,
}

/// A channel within a server.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Channel {
    pub id: ChannelId,
    pub server_id: ServerId,
    pub name: String,
    pub topic: Option<String>,
    pub channel_type: ChannelType,
    pub position: i32,
    pub category_id: Option<CategoryId>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl Channel {
    /// Create a new channel with given parameters.
    #[must_use]
    pub fn new(
        server_id: ServerId,
        name: String,
        channel_type: ChannelType,
        position: i32,
    ) -> Self {
        let now = Utc::now();
        Self {
            id: ChannelId::new(Uuid::new_v4()),
            server_id,
            name,
            topic: None,
            channel_type,
            position,
            category_id: None,
            created_at: now,
            updated_at: now,
        }
    }

    /// Create the default `#general` text channel for a newly created server.
    #[must_use]
    pub fn default_general(server_id: ServerId) -> Self {
        let now = Utc::now();
        Self {
            id: ChannelId::new(Uuid::new_v4()),
            server_id,
            name: "general".to_string(),
            topic: None,
            channel_type: ChannelType::Text,
            position: 0,
            category_id: None,
            created_at: now,
            updated_at: now,
        }
    }
}
