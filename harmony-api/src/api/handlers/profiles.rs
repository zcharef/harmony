//! Profile handlers.

use axum::{Extension, Json, extract::State, http::StatusCode, response::IntoResponse};

use crate::api::dto::ProfileResponse;
use crate::api::errors::{ApiError, ProblemDetails};
use crate::api::extractors::AuthUser;
use crate::api::state::AppState;
use crate::infra::auth::AuthenticatedUser;

/// Sync (get or create) the authenticated user's profile.
///
/// Called after Supabase login. Creates a profile row if this is the first login,
/// or returns the existing one.
///
/// # Errors
/// Returns `ApiError` if the JWT lacks an email claim or the upsert fails.
#[utoipa::path(
    post,
    path = "/v1/auth/me",
    tag = "Auth",
    security(("bearer_auth" = [])),
    responses(
        (status = 200, description = "Profile synced successfully", body = ProfileResponse),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state, auth_user))]
pub async fn sync_profile(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    Extension(auth_user): Extension<AuthenticatedUser>,
) -> Result<impl IntoResponse, ApiError> {
    let email = auth_user
        .email
        .ok_or_else(|| ApiError::bad_request("JWT must contain an email claim"))?;

    // WHY: Derive username from email prefix as a sensible default.
    let username = email
        .split('@')
        .next()
        .unwrap_or("user")
        .to_string();

    let profile = state
        .profile_service()
        .upsert_from_auth(user_id, email, username)
        .await?;

    Ok((StatusCode::OK, Json(ProfileResponse::from(profile))))
}

/// Get the authenticated user's own profile.
///
/// # Errors
/// Returns `ApiError` if the profile is not found or a repository error occurs.
#[utoipa::path(
    get,
    path = "/v1/profiles/me",
    tag = "Profiles",
    security(("bearer_auth" = [])),
    responses(
        (status = 200, description = "Profile found", body = ProfileResponse),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 404, description = "Profile not found", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn get_my_profile(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, ApiError> {
    let profile = state.profile_service().get_by_id(&user_id).await?;

    Ok((StatusCode::OK, Json(ProfileResponse::from(profile))))
}
