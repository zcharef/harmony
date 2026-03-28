//! Profile DTOs (request/response types).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use crate::domain::models::{Profile, UserId, UserStatus};

/// Profile response returned to API consumers.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProfileResponse {
    pub id: UserId,
    pub username: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
    pub status: UserStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_status: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

// WHY: Query parameter structs cannot use deny_unknown_fields because
// Axum's query deserializer passes all URL query params to the struct,
// and extra params (e.g., cache-busters) would cause 400 errors.
#[derive(Debug, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "camelCase")]
#[into_params(parameter_in = Query)]
pub struct CheckUsernameQuery {
    /// The username to check for availability.
    pub username: String,
}

/// Response for the username availability check.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CheckUsernameResponse {
    /// Whether the username is available for registration.
    pub available: bool,
}

/// WHY: `available` is the inverse of `taken` (domain concept).
/// `From<bool>` converts the domain boolean (`is_taken`) into the API response
/// (`is_available`) — keeps the inversion in one place, not in the handler.
impl From<bool> for CheckUsernameResponse {
    fn from(is_taken: bool) -> Self {
        Self {
            available: !is_taken,
        }
    }
}

impl From<Profile> for ProfileResponse {
    fn from(p: Profile) -> Self {
        Self {
            id: p.id,
            username: p.username,
            display_name: p.display_name,
            avatar_url: p.avatar_url,
            status: p.status,
            custom_status: p.custom_status,
            created_at: p.created_at,
            updated_at: p.updated_at,
        }
    }
}
