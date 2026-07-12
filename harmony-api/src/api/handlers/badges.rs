//! Badge handlers.
//!
//! Two surfaces for the `official` verified badge:
//! - a lightweight, authenticated read of the official-holder set that the SPA
//!   caches to decorate message authors, the profile card and the member list;
//! - an owner-only grant/revoke admin action (no self-serve path — anti-abuse).

use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};

use crate::api::dto::{OfficialBadgeGrantRequest, OfficialBadgesResponse};
use crate::api::errors::{ApiError, ProblemDetails};
use crate::api::extractors::{ApiJson, AuthUser};
use crate::api::founder::require_platform_founder;
use crate::api::state::AppState;
use crate::domain::models::UserId;

/// List the user IDs holding the `official` verified badge.
///
/// Authenticated (badges are as public as the profiles they decorate). Returns
/// the whole set in one small payload; the SPA caches it and checks author-id
/// membership per message rather than stamping a flag on every message.
///
/// # Errors
/// Returns `ApiError` on a repository failure.
#[utoipa::path(
    get,
    path = "/v1/badges/official",
    tag = "Badges",
    security(("bearer_auth" = [])),
    responses(
        (status = 200, description = "Official badge holders", body = OfficialBadgesResponse),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn list_official_badges(
    AuthUser(_user_id): AuthUser,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, ApiError> {
    let user_ids = state.profile_service().list_official_user_ids().await?;
    Ok((StatusCode::OK, Json(OfficialBadgesResponse::from(user_ids))))
}

/// Grant the `official` verified badge to a user. Platform-owner only.
///
/// Identify the subject by exactly one of `userId` or `username`. Idempotent —
/// re-granting is a no-op.
///
/// # Errors
/// Returns `ApiError` 403 if the caller is not the platform owner, 400 if the
/// subject is under- or over-specified, 404 if the subject does not exist.
#[utoipa::path(
    post,
    path = "/v1/admin/badges/official/grant",
    tag = "Badges",
    security(("bearer_auth" = [])),
    request_body = OfficialBadgeGrantRequest,
    responses(
        (status = 204, description = "Badge granted"),
        (status = 400, description = "Subject under- or over-specified", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Not the platform owner", body = ProblemDetails),
        (status = 404, description = "Subject not found", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state, req))]
pub async fn grant_official_badge(
    AuthUser(caller_id): AuthUser,
    State(state): State<AppState>,
    ApiJson(req): ApiJson<OfficialBadgeGrantRequest>,
) -> Result<impl IntoResponse, ApiError> {
    require_platform_founder(&state, &caller_id)?;
    let subject = resolve_subject(&state, req).await?;
    state
        .profile_service()
        .grant_official_badge(&subject)
        .await?;
    tracing::info!(actor = %caller_id, subject = %subject, "official badge granted");
    Ok(StatusCode::NO_CONTENT)
}

/// Revoke the `official` verified badge from a user. Platform-owner only.
///
/// Identify the subject by exactly one of `userId` or `username`. Idempotent —
/// revoking a badge the user never held is a no-op.
///
/// # Errors
/// Returns `ApiError` 403 if the caller is not the platform owner, 400 if the
/// subject is under- or over-specified, 404 if the subject does not exist.
#[utoipa::path(
    post,
    path = "/v1/admin/badges/official/revoke",
    tag = "Badges",
    security(("bearer_auth" = [])),
    request_body = OfficialBadgeGrantRequest,
    responses(
        (status = 204, description = "Badge revoked"),
        (status = 400, description = "Subject under- or over-specified", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Not the platform owner", body = ProblemDetails),
        (status = 404, description = "Subject not found", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state, req))]
pub async fn revoke_official_badge(
    AuthUser(caller_id): AuthUser,
    State(state): State<AppState>,
    ApiJson(req): ApiJson<OfficialBadgeGrantRequest>,
) -> Result<impl IntoResponse, ApiError> {
    require_platform_founder(&state, &caller_id)?;
    let subject = resolve_subject(&state, req).await?;
    state
        .profile_service()
        .revoke_official_badge(&subject)
        .await?;
    tracing::info!(actor = %caller_id, subject = %subject, "official badge revoked");
    Ok(StatusCode::NO_CONTENT)
}

/// Resolve the grant subject to a `UserId`, requiring exactly one of
/// `userId` / `username` and that the subject profile actually exists.
async fn resolve_subject(
    state: &AppState,
    req: OfficialBadgeGrantRequest,
) -> Result<UserId, ApiError> {
    match (req.user_id, req.username) {
        (Some(_), Some(_)) => Err(ApiError::bad_request(
            "Provide exactly one of userId or username, not both",
        )),
        (None, None) => Err(ApiError::bad_request("Provide either userId or username")),
        (Some(user_id), None) => {
            let profile = state
                .profile_service()
                .get_by_id_optional(&user_id)
                .await?
                .ok_or_else(|| ApiError::not_found(format!("No user with id '{user_id}'")))?;
            Ok(profile.id)
        }
        (None, Some(username)) => {
            let profile = state
                .profile_service()
                .get_by_username(&username)
                .await?
                .ok_or_else(|| {
                    ApiError::not_found(format!("No user with username '{username}'"))
                })?;
            Ok(profile.id)
        }
    }
}
