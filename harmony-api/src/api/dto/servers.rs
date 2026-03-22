//! Server DTOs (request/response types).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::domain::models::{Server, ServerId, UserId};

/// Request body for creating a new server.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateServerRequest {
    /// Server name (required, non-empty).
    pub name: String,
}

/// Server response returned to API consumers.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ServerResponse {
    pub id: ServerId,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_url: Option<String>,
    pub owner_id: UserId,
    pub is_dm: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl From<Server> for ServerResponse {
    fn from(s: Server) -> Self {
        Self {
            id: s.id,
            name: s.name,
            icon_url: s.icon_url,
            owner_id: s.owner_id,
            is_dm: s.is_dm,
            created_at: s.created_at,
            updated_at: s.updated_at,
        }
    }
}

/// Request body for updating a server.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateServerRequest {
    /// New server name (if provided).
    #[serde(default)]
    pub name: Option<String>,
}

/// Envelope for a list of servers (ADR-036).
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ServerListResponse {
    pub items: Vec<ServerResponse>,
}

impl From<Vec<Server>> for ServerListResponse {
    fn from(servers: Vec<Server>) -> Self {
        Self {
            items: servers.into_iter().map(ServerResponse::from).collect(),
        }
    }
}
