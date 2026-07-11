//! Badge DTOs (request/response types).

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::domain::models::UserId;

/// The set of user IDs currently holding the `official` verified badge.
///
/// WHY a flat ID list (not per-user objects): the SPA fetches this once, caches
/// it, and checks author-id membership per message — keeping the payload tiny
/// avoids bloating every message with an `isOfficial` flag.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct OfficialBadgesResponse {
    /// User IDs that hold the `official` badge, ordered by grant time.
    pub user_ids: Vec<UserId>,
}

impl From<Vec<UserId>> for OfficialBadgesResponse {
    fn from(user_ids: Vec<UserId>) -> Self {
        Self { user_ids }
    }
}

/// Request body for the owner-only grant/revoke of the `official` badge.
///
/// Exactly one of `userId` / `username` identifies the subject. The handler
/// rejects the request when neither (or both) is provided.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficialBadgeGrantRequest {
    /// The subject's user ID. Mutually exclusive with `username`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_id: Option<UserId>,
    /// The subject's username. Mutually exclusive with `userId`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
}
