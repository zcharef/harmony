//! Founder admin DTOs (request/response types).

use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use crate::domain::models::{AdminUserQuota, AdminUserSummary, Plan, UserId};

/// Query params for the founder user-search endpoint.
///
/// WHY no `deny_unknown_fields`: Axum's query deserializer passes every URL
/// param to the struct, and extra params (cache-busters) would 400 (mirrors
/// `CheckUsernameQuery`).
#[derive(Debug, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "camelCase")]
#[into_params(parameter_in = Query)]
pub struct AdminUserSearchQuery {
    /// Case-insensitive username substring to match.
    pub q: String,
}

/// One user in the founder search results.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdminUserSummaryResponse {
    pub id: UserId,
    pub username: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    pub plan: Plan,
    /// Holds the `founding` badge.
    pub is_founding: bool,
    /// Holds the `official` verified badge (staff account).
    pub is_official: bool,
}

impl From<AdminUserSummary> for AdminUserSummaryResponse {
    fn from(s: AdminUserSummary) -> Self {
        Self {
            id: s.id,
            username: s.username,
            display_name: s.display_name,
            plan: s.plan,
            is_founding: s.is_founding,
            is_official: s.is_official,
        }
    }
}

/// Envelope for the founder user-search results (bounded, top-N).
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdminUserSearchResponse {
    pub items: Vec<AdminUserSummaryResponse>,
    /// Number of items returned (bounded by the server-side cap).
    pub total: i64,
}

impl From<Vec<AdminUserSummary>> for AdminUserSearchResponse {
    fn from(users: Vec<AdminUserSummary>) -> Self {
        let items: Vec<AdminUserSummaryResponse> = users
            .into_iter()
            .map(AdminUserSummaryResponse::from)
            .collect();
        // WHY i64: matches the collection-envelope `total` type (ADR-036).
        let total = i64::try_from(items.len()).unwrap_or(i64::MAX);
        Self { items, total }
    }
}

/// Request body to set a user's plan.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetUserPlanRequest {
    /// The plan to grant: `free`, `supporter`, or `creator`.
    pub plan: Plan,
}

/// Per-user caps relevant to the quota view.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdminQuotaLimits {
    pub max_owned_servers: u64,
    pub max_joined_servers: u64,
    pub max_open_dms: u64,
}

/// Current per-user usage counts.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdminQuotaUsage {
    pub owned_servers: u64,
    pub joined_servers: u64,
    pub open_dms: u64,
}

/// A user's plan, per-user caps, and current usage.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdminUserQuotaResponse {
    pub plan: Plan,
    pub limits: AdminQuotaLimits,
    pub usage: AdminQuotaUsage,
}

impl From<AdminUserQuota> for AdminUserQuotaResponse {
    fn from(q: AdminUserQuota) -> Self {
        Self {
            plan: q.plan,
            limits: AdminQuotaLimits {
                max_owned_servers: q.limits.max_owned_servers,
                max_joined_servers: q.limits.max_joined_servers,
                max_open_dms: q.limits.max_open_dms,
            },
            usage: AdminQuotaUsage {
                owned_servers: q.usage.owned_servers,
                joined_servers: q.usage.joined_servers,
                open_dms: q.usage.open_dms,
            },
        }
    }
}
