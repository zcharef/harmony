//! Ban DTOs (request/response types).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use crate::domain::models::{ServerBan, UserId};

/// Request body for banning a user from a server.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BanUserRequest {
    pub user_id: UserId,
    #[serde(default)]
    pub reason: Option<String>,
}

/// Server ban response returned to API consumers.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct BanResponse {
    pub user_id: UserId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub banned_by: Option<UserId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub created_at: DateTime<Utc>,
}

impl From<ServerBan> for BanResponse {
    fn from(b: ServerBan) -> Self {
        Self {
            user_id: b.user_id,
            banned_by: b.banned_by,
            reason: b.reason,
            created_at: b.created_at,
        }
    }
}

/// Envelope for a list of server bans with cursor pagination (ADR-036).
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct BanListResponse {
    pub items: Vec<BanResponse>,
    /// Cursor for the next page. `None` if this is the last page.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

impl BanListResponse {
    /// Build from a list of domain bans with an optional cursor for the next page.
    #[must_use]
    pub fn from_bans(bans: Vec<ServerBan>, next_cursor: Option<String>) -> Self {
        Self {
            items: bans.into_iter().map(BanResponse::from).collect(),
            next_cursor,
        }
    }
}

/// Query parameters for listing bans (cursor-based pagination).
// WHY: Query parameter structs cannot use deny_unknown_fields because
// Axum's query deserializer passes all URL query params to the struct,
// and extra params (e.g., cache-busters) would cause 400 errors.
#[derive(Debug, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "camelCase")]
#[into_params(parameter_in = Query)]
pub struct BanListQuery {
    /// ISO 8601 timestamp cursor -- fetch bans created before this time.
    pub before: Option<String>,
    /// Maximum number of bans to return (1-100, default 50).
    pub limit: Option<i64>,
}
