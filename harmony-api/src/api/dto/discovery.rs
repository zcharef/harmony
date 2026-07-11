//! Server-directory DTOs (request/response types).

use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use crate::domain::models::{DiscoveryServer, ServerId};
use crate::domain::services::DiscoveryPage;

/// Request body for updating a server's directory settings.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateServerDiscoveryRequest {
    /// Whether the server is listed in the public directory.
    pub discoverable: bool,
    /// Directory category (required when `discoverable` is true).
    /// One of: gaming, tech, education, music, art, science, community, other.
    #[serde(default)]
    pub category: Option<String>,
    /// Short public description shown on the directory card (max 300 chars).
    #[serde(default)]
    pub description: Option<String>,
}

/// One server card in the public directory.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryServerResponse {
    pub id: ServerId,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_url: Option<String>,
    pub member_count: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

impl From<DiscoveryServer> for DiscoveryServerResponse {
    fn from(s: DiscoveryServer) -> Self {
        Self {
            id: s.id,
            name: s.name,
            icon_url: s.icon_url,
            member_count: s.member_count,
            category: s.category,
            description: s.description,
        }
    }
}

/// Envelope for a directory page with keyset pagination (ADR-036).
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryListResponse {
    pub items: Vec<DiscoveryServerResponse>,
    /// Total count of directory entries matching the filters.
    pub total: i64,
    /// Cursor for the next page. `None` if this is the last page.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

impl From<DiscoveryPage> for DiscoveryListResponse {
    fn from(page: DiscoveryPage) -> Self {
        Self {
            items: page
                .items
                .into_iter()
                .map(DiscoveryServerResponse::from)
                .collect(),
            total: page.total,
            next_cursor: page.next_cursor,
        }
    }
}

/// Query parameters for the directory listing.
// WHY no deny_unknown_fields: Axum's query deserializer passes ALL URL query
// params to the struct — extra params (cache-busters) must not 400.
#[derive(Debug, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "camelCase")]
#[into_params(parameter_in = Query)]
pub struct DiscoveryListQuery {
    /// Filter by directory category (allowlisted value).
    pub category: Option<String>,
    /// Substring search on the server name (case-insensitive, max 100 chars).
    pub q: Option<String>,
    /// Opaque keyset cursor from a previous page's `nextCursor`.
    pub cursor: Option<String>,
    /// Page size (1-50, default 20).
    pub limit: Option<i64>,
}
