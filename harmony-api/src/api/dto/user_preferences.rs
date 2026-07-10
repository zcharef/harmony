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
    pub onboarding_completed: bool,
    pub updated_at: DateTime<Utc>,
}

impl From<UserPreferences> for UserPreferencesResponse {
    fn from(prefs: UserPreferences) -> Self {
        Self {
            dnd_enabled: prefs.dnd_enabled,
            hide_profanity: prefs.hide_profanity,
            onboarding_completed: prefs.onboarding_completed,
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
    #[serde(default)]
    pub onboarding_completed: Option<bool>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use chrono::Utc;
    use uuid::Uuid;

    use crate::domain::models::UserId;

    fn make_preferences(onboarding_completed: bool) -> UserPreferences {
        let now = Utc::now();
        UserPreferences {
            user_id: UserId::from(Uuid::new_v4()),
            dnd_enabled: false,
            hide_profanity: true,
            onboarding_completed,
            created_at: now,
            updated_at: now,
        }
    }

    /// WHY: The onboarding gate in the SPA reads `onboardingCompleted` from
    /// GET /v1/preferences — the From conversion must carry the flag through
    /// and serde must emit the camelCase key (ADR-039).
    #[test]
    fn preferences_response_carries_onboarding_completed() {
        let response = UserPreferencesResponse::from(make_preferences(true));

        assert!(response.onboarding_completed);

        let json = serde_json::to_value(&response).unwrap();
        assert_eq!(json["onboardingCompleted"], true);
    }

    /// WHY: The onboarding completion PATCH sends only `onboardingCompleted`
    /// — the partial-patch request must deserialize it and leave the other
    /// fields as None (COALESCE preserves them server-side).
    #[test]
    fn update_request_deserializes_onboarding_completed_alone() {
        let req: UpdateUserPreferencesRequest =
            serde_json::from_str(r#"{"onboardingCompleted": true}"#).unwrap();

        assert_eq!(req.onboarding_completed, Some(true));
        assert_eq!(req.dnd_enabled, None);
        assert_eq!(req.hide_profanity, None);
    }

    /// WHY: `deny_unknown_fields` (ADR-026) is the version-skew guard — a
    /// client sending a field this API doesn't know must get a 400, not a
    /// silent drop (§8 deploy-order precondition relies on it).
    #[test]
    fn update_request_rejects_unknown_field() {
        let result = serde_json::from_str::<UpdateUserPreferencesRequest>(
            r#"{"onboardingCompleted": true, "someFutureField": 1}"#,
        );

        assert!(result.is_err());
    }
}
