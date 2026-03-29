//! Member DTOs (request/response types).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use crate::domain::models::{Role, ServerMember, UserId};

/// Server member response returned to API consumers.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MemberResponse {
    pub user_id: UserId,
    pub username: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nickname: Option<String>,
    pub role: String,
    pub joined_at: DateTime<Utc>,
}

impl From<ServerMember> for MemberResponse {
    fn from(m: ServerMember) -> Self {
        Self {
            user_id: m.user_id,
            username: m.username,
            avatar_url: m.avatar_url,
            nickname: m.nickname,
            role: m.role.to_string(),
            joined_at: m.joined_at,
        }
    }
}

/// Envelope for a list of server members with cursor pagination (ADR-036).
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MemberListResponse {
    pub items: Vec<MemberResponse>,
    /// Cursor for the next page. `None` if this is the last page.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

impl MemberListResponse {
    /// Build from a list of domain members with an optional cursor for the next page.
    #[must_use]
    pub fn from_members(members: Vec<ServerMember>, next_cursor: Option<String>) -> Self {
        Self {
            items: members.into_iter().map(MemberResponse::from).collect(),
            next_cursor,
        }
    }
}

/// Query parameters for listing members (cursor-based pagination).
// WHY: Query parameter structs cannot use deny_unknown_fields because
// Axum's query deserializer passes all URL query params to the struct,
// and extra params (e.g., cache-busters) would cause 400 errors.
#[derive(Debug, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "camelCase")]
#[into_params(parameter_in = Query)]
pub struct MemberListQuery {
    /// ISO 8601 timestamp cursor -- fetch members who joined before this time.
    pub before: Option<String>,
    /// Maximum number of members to return (1-100, default 50).
    pub limit: Option<i64>,
}

/// Request body for assigning a role to a server member.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssignRoleRequest {
    /// The role to assign (admin, moderator, member). Use transfer-ownership for owner.
    pub role: Role,
}

/// Request body for transferring server ownership.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferOwnershipRequest {
    /// The user ID of the new owner (must be an existing member).
    pub new_owner_id: UserId,
}
