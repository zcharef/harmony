//! Invite DTOs (request/response types).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::domain::models::{Invite, InviteCode, ServerId, UserId};

/// Request body for creating a new invite.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateInviteRequest {
    /// Maximum number of times this invite can be used. `None` means unlimited.
    #[serde(default)]
    pub max_uses: Option<i32>,
    /// Invite expires after this many hours. `None` means it never expires.
    #[serde(default)]
    pub expires_in_hours: Option<i32>,
}

/// Request body for joining a server via invite code.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JoinServerRequest {
    /// The invite code to use.
    pub invite_code: String,
}

/// Invite response returned to API consumers.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct InviteResponse {
    pub code: InviteCode,
    pub server_id: ServerId,
    pub creator_id: UserId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_uses: Option<i32>,
    pub use_count: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

impl From<Invite> for InviteResponse {
    fn from(inv: Invite) -> Self {
        Self {
            code: inv.code,
            server_id: inv.server_id,
            creator_id: inv.creator_id,
            max_uses: inv.max_uses,
            use_count: inv.use_count,
            expires_at: inv.expires_at,
            created_at: inv.created_at,
        }
    }
}

/// Public invite preview (no auth required).
///
/// Contains just enough information for a user to decide whether to join.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct InvitePreviewResponse {
    pub code: InviteCode,
    pub server_id: ServerId,
    pub server_name: String,
    pub member_count: i64,
}

impl InvitePreviewResponse {
    /// WHY: This DTO aggregates data from three sources (invite, server, members),
    /// so a simple From<DomainModel> is not possible. A constructor keeps the
    /// assembly logic out of the handler (ADR-023).
    #[must_use]
    pub fn new(invite: &Invite, server_name: String, member_count: i64) -> Self {
        Self {
            code: invite.code.clone(),
            server_id: invite.server_id.clone(),
            server_name,
            member_count,
        }
    }
}
