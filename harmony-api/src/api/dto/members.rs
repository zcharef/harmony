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
    /// Member's display name (if set).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nickname: Option<String>,
    pub role: String,
    /// Whether this member holds the `founding` badge (one of the first accounts).
    pub is_founding: bool,
    pub joined_at: DateTime<Utc>,
}

impl From<ServerMember> for MemberResponse {
    fn from(m: ServerMember) -> Self {
        Self {
            user_id: m.user_id,
            username: m.username,
            display_name: m.display_name,
            avatar_url: m.avatar_url,
            nickname: m.nickname,
            role: m.role.to_string(),
            is_founding: m.is_founding,
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
    /// Autocomplete search: substring match on `username`/`display_name`/`nickname`,
    /// prefix matches ranked first. Must be non-empty (an empty or whitespace-only
    /// `q` is a 400) and at most 32 characters -- the username DB cap.
    /// `nextCursor` is always null for search results, and combining `q` with
    /// `before` is a 400.
    pub q: Option<String>,
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

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use chrono::Utc;
    use uuid::Uuid;

    use crate::domain::models::ServerId;

    fn make_member(display_name: Option<String>) -> ServerMember {
        ServerMember {
            user_id: UserId::from(Uuid::new_v4()),
            server_id: ServerId::from(Uuid::new_v4()),
            username: "alice".to_string(),
            display_name,
            avatar_url: None,
            nickname: None,
            role: Role::Member,
            is_founding: false,
            joined_at: Utc::now(),
        }
    }

    /// WHY: The member list is where the SPA resolves
    /// `nickname ?? displayName ?? username` — the From conversion must carry
    /// `display_name` through and serde must emit the camelCase key (ADR-039).
    #[test]
    fn member_response_carries_display_name() {
        let response = MemberResponse::from(make_member(Some("Alice Doe".to_string())));

        assert_eq!(response.username, "alice");
        assert_eq!(response.display_name, Some("Alice Doe".to_string()));

        let json = serde_json::to_value(&response).unwrap();
        assert_eq!(json["username"], "alice");
        assert_eq!(json["displayName"], "Alice Doe");
    }

    /// WHY: `skip_serializing_if` must omit the key entirely when the member
    /// has no display name — old clients tolerate a missing optional field.
    #[test]
    fn member_response_omits_absent_display_name() {
        let response = MemberResponse::from(make_member(None));

        let json = serde_json::to_value(&response).unwrap();
        assert!(json.get("displayName").is_none());
    }

    /// WHY: The member list drives the founding badge next to member names.
    /// The From conversion must carry `is_founding` through and serde must emit
    /// the camelCase `isFounding` key (ADR-039), always present (never skipped).
    #[test]
    fn member_response_carries_founding_flag() {
        let mut member = make_member(None);
        member.is_founding = true;
        let json = serde_json::to_value(MemberResponse::from(member)).unwrap();
        assert_eq!(json["isFounding"], true);

        let json = serde_json::to_value(MemberResponse::from(make_member(None))).unwrap();
        assert_eq!(json["isFounding"], false);
    }
}
