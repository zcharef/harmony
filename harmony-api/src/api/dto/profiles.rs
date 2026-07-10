//! Profile DTOs (request/response types).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use super::serde_helpers::double_option;
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bio: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub banner_url: Option<String>,
    /// Whether this user holds the `founding` badge (one of the first accounts).
    pub is_founding: bool,
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

/// Request body for updating the authenticated user's profile.
///
/// Patch semantics per field: omitted = unchanged, `null` = cleared,
/// value = replaced (same contract as `UpdateChannelRequest.topic`).
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateProfileRequest {
    /// Avatar image URL (must be HTTPS). `null` clears it.
    #[serde(default, deserialize_with = "double_option")]
    #[schema(value_type = Option<String>)]
    pub avatar_url: Option<Option<String>>,
    /// Display name (1-32 characters). `null` clears it (falls back to username).
    #[serde(default, deserialize_with = "double_option")]
    #[schema(value_type = Option<String>)]
    pub display_name: Option<Option<String>>,
    /// Custom status text (max 128 characters). `null` clears it.
    #[serde(default, deserialize_with = "double_option")]
    #[schema(value_type = Option<String>)]
    pub custom_status: Option<Option<String>>,
    /// Bio (markdown-lite, links only, max 190 characters). `null` clears it.
    #[serde(default, deserialize_with = "double_option")]
    #[schema(value_type = Option<String>)]
    pub bio: Option<Option<String>>,
    /// Banner image URL (must be HTTPS, avatars bucket). `null` clears it.
    #[serde(default, deserialize_with = "double_option")]
    #[schema(value_type = Option<String>)]
    pub banner_url: Option<Option<String>>,
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
            bio: p.bio,
            banner_url: p.banner_url,
            is_founding: p.is_founding,
            created_at: p.created_at,
            updated_at: p.updated_at,
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use chrono::Utc;
    use uuid::Uuid;

    fn make_profile(is_founding: bool) -> Profile {
        let now = Utc::now();
        Profile {
            id: UserId::from(Uuid::new_v4()),
            username: "alice".to_string(),
            display_name: None,
            avatar_url: None,
            status: UserStatus::Offline,
            custom_status: None,
            bio: None,
            banner_url: None,
            is_founding,
            created_at: now,
            updated_at: now,
        }
    }

    /// WHY: The profile hover card renders the founding badge from this flag.
    /// The From conversion must carry `is_founding` and serde must emit the
    /// camelCase `isFounding` key (ADR-039), always present.
    #[test]
    fn profile_response_carries_founding_flag() {
        let json = serde_json::to_value(ProfileResponse::from(make_profile(true))).unwrap();
        assert_eq!(json["isFounding"], true);

        let json = serde_json::to_value(ProfileResponse::from(make_profile(false))).unwrap();
        assert_eq!(json["isFounding"], false);
    }
}
