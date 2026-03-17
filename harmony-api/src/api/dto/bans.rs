//! Ban DTOs (request/response types).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

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

/// Envelope for a list of server bans (ADR-036).
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct BanListResponse {
    pub items: Vec<BanResponse>,
    pub total: i64,
}

impl BanListResponse {
    #[must_use]
    pub fn from_bans(bans: Vec<ServerBan>) -> Self {
        let total = i64::try_from(bans.len()).unwrap_or(0);
        Self {
            items: bans.into_iter().map(BanResponse::from).collect(),
            total,
        }
    }
}
