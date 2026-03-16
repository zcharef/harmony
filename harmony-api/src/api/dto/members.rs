//! Member DTOs (request/response types).

use chrono::{DateTime, Utc};
use serde::Serialize;
use utoipa::ToSchema;

use crate::domain::models::{ServerMember, UserId};

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
    pub joined_at: DateTime<Utc>,
}

impl From<ServerMember> for MemberResponse {
    fn from(m: ServerMember) -> Self {
        Self {
            user_id: m.user_id,
            username: m.username,
            avatar_url: m.avatar_url,
            nickname: m.nickname,
            joined_at: m.joined_at,
        }
    }
}

/// Envelope for a list of server members (ADR-036).
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MemberListResponse {
    pub items: Vec<MemberResponse>,
    pub total: i64,
}

impl MemberListResponse {
    /// Build from a list of domain members.
    #[must_use]
    pub fn from_members(members: Vec<ServerMember>) -> Self {
        let total = i64::try_from(members.len()).unwrap_or(0);
        Self {
            items: members.into_iter().map(MemberResponse::from).collect(),
            total,
        }
    }
}
