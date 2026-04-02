//! User preferences handlers.

use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};

use crate::api::dto::user_preferences::{UpdateUserPreferencesRequest, UserPreferencesResponse};
use crate::api::errors::{ApiError, ProblemDetails};
use crate::api::extractors::{ApiJson, AuthUser};
use crate::api::state::AppState;
use crate::domain::ports::UpdatePreferences;

/// Get the authenticated user's preferences.
///
/// Returns default preferences (`dndEnabled: false`) when no explicit setting exists.
///
/// # Errors
/// Returns `ApiError` on repository error.
#[utoipa::path(
    get,
    path = "/v1/preferences",
    tag = "UserPreferences",
    security(("bearer_auth" = [])),
    responses(
        (status = 200, description = "User preferences", body = UserPreferencesResponse),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn get_preferences(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, ApiError> {
    let prefs = state.user_preferences_service().get(&user_id).await?;

    Ok((StatusCode::OK, Json(UserPreferencesResponse::from(prefs))))
}

/// Update the authenticated user's preferences (partial patch).
///
/// # Errors
/// Returns `ApiError` on validation failure or repository error.
#[utoipa::path(
    patch,
    path = "/v1/preferences",
    tag = "UserPreferences",
    security(("bearer_auth" = [])),
    request_body = UpdateUserPreferencesRequest,
    responses(
        (status = 204, description = "Preferences updated"),
        (status = 400, description = "Validation error", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state, req))]
pub async fn update_preferences(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiJson(req): ApiJson<UpdateUserPreferencesRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let patch = UpdatePreferences {
        dnd_enabled: req.dnd_enabled,
        hide_profanity: req.hide_profanity,
    };

    state
        .user_preferences_service()
        .update(&user_id, patch)
        .await?;

    Ok(StatusCode::NO_CONTENT)
}
