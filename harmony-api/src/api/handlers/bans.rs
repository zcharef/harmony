//! Ban handlers.

use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};
use serde::Deserialize;

use crate::api::dto::bans::{BanListResponse, BanResponse, BanUserRequest};
use crate::api::errors::{ApiError, ProblemDetails};
use crate::api::extractors::{ApiJson, ApiPath, AuthUser};
use crate::api::state::AppState;
use crate::domain::models::{ServerId, UserId};

/// List all bans for a server. Owner-only.
///
/// # Errors
/// Returns `ApiError` on authorization failure or repository error.
#[utoipa::path(
    get,
    path = "/v1/servers/{id}/bans",
    tag = "Moderation",
    security(("bearer_auth" = [])),
    params(("id" = ServerId, Path, description = "Server ID")),
    responses(
        (status = 200, description = "Ban list", body = BanListResponse),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Not server owner", body = ProblemDetails),
        (status = 404, description = "Server not found", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn list_bans(
    AuthUser(caller_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(server_id): ApiPath<ServerId>,
) -> Result<impl IntoResponse, ApiError> {
    let server = state.server_service().get_by_id(&server_id).await?;

    if server.owner_id != caller_id {
        return Err(ApiError::forbidden("Only the server owner can view bans"));
    }

    let bans = state.ban_repository().list_bans(&server_id).await?;

    Ok((StatusCode::OK, Json(BanListResponse::from_bans(bans))))
}

/// Ban a user from a server and remove their membership. Owner-only.
///
/// # Errors
/// Returns `ApiError` on authorization failure, conflict, or repository error.
#[utoipa::path(
    post,
    path = "/v1/servers/{id}/bans",
    tag = "Moderation",
    security(("bearer_auth" = [])),
    params(("id" = ServerId, Path, description = "Server ID")),
    request_body = BanUserRequest,
    responses(
        (status = 201, description = "User banned", body = BanResponse),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Not server owner / cannot ban owner", body = ProblemDetails),
        (status = 404, description = "Server not found", body = ProblemDetails),
        (status = 409, description = "User already banned", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state, req))]
pub async fn ban_member(
    AuthUser(caller_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(server_id): ApiPath<ServerId>,
    ApiJson(req): ApiJson<BanUserRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let server = state.server_service().get_by_id(&server_id).await?;

    if server.owner_id != caller_id {
        return Err(ApiError::forbidden("Only the server owner can ban members"));
    }

    if req.user_id == caller_id {
        return Err(ApiError::forbidden("Cannot ban yourself"));
    }

    if req.user_id == server.owner_id {
        return Err(ApiError::forbidden("Cannot ban the server owner"));
    }

    if let Some(ref reason) = req.reason
        && reason.len() > 512
    {
        return Err(ApiError::bad_request(
            "Ban reason must not exceed 512 characters",
        ));
    }

    let ban = state
        .ban_repository()
        .ban_user(&server_id, &req.user_id, &caller_id, req.reason)
        .await?;

    Ok((StatusCode::CREATED, Json(BanResponse::from(ban))))
}

/// Path parameters for unban operations.
#[derive(Debug, Deserialize)]
pub struct BanPath {
    pub id: ServerId,
    pub user_id: UserId,
}

/// Unban a user from a server. Owner-only.
///
/// # Errors
/// Returns `ApiError` on authorization failure or repository error.
#[utoipa::path(
    delete,
    path = "/v1/servers/{id}/bans/{user_id}",
    tag = "Moderation",
    security(("bearer_auth" = [])),
    params(
        ("id" = ServerId, Path, description = "Server ID"),
        ("user_id" = UserId, Path, description = "User ID to unban"),
    ),
    responses(
        (status = 204, description = "User unbanned"),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Not server owner", body = ProblemDetails),
        (status = 404, description = "Ban not found", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn unban_member(
    AuthUser(caller_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(path): ApiPath<BanPath>,
) -> Result<impl IntoResponse, ApiError> {
    let server = state.server_service().get_by_id(&path.id).await?;

    if server.owner_id != caller_id {
        return Err(ApiError::forbidden(
            "Only the server owner can unban members",
        ));
    }

    state
        .ban_repository()
        .unban_user(&path.id, &path.user_id)
        .await?;

    Ok(StatusCode::NO_CONTENT)
}
