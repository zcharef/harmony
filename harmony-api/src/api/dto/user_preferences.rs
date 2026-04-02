//! User preferences DTOs (request/response types).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::domain::models::UserPreferences;

/// Response for user preferences.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UserPreferencesResponse {
    pub dnd_enabled: bool,
    pub hide_profanity: bool,
    pub updated_at: DateTime<Utc>,
}

impl From<UserPreferences> for UserPreferencesResponse {
    fn from(prefs: UserPreferences) -> Self {
        Self {
            dnd_enabled: prefs.dnd_enabled,
            hide_profanity: prefs.hide_profanity,
            updated_at: prefs.updated_at,
        }
    }
}

/// Request body for updating user preferences (partial patch).
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateUserPreferencesRequest {
    #[serde(default)]
    pub dnd_enabled: Option<bool>,
    #[serde(default)]
    pub hide_profanity: Option<bool>,
}
