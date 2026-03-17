//! Member handlers.

use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};
use serde::Deserialize;

use crate::api::dto::members::MemberListResponse;
use crate::api::errors::{ApiError, ProblemDetails};
use crate::api::extractors::{ApiPath, AuthUser};
use crate::api::state::AppState;
use crate::domain::models::{ServerId, UserId};

/// List all members of a server.
///
/// # Errors
/// Returns `ApiError` on repository error.
#[utoipa::path(
    get,
    path = "/v1/servers/{id}/members",
    tag = "Members",
    security(("bearer_auth" = [])),
    params(("id" = ServerId, Path, description = "Server ID")),
    responses(
        (status = 200, description = "Member list", body = MemberListResponse),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 404, description = "Server not found", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn list_members(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(server_id): ApiPath<ServerId>,
) -> Result<impl IntoResponse, ApiError> {
    let is_member = state
        .member_repository()
        .is_member(&server_id, &user_id)
        .await?;
    if !is_member {
        return Err(ApiError::forbidden(
            "You must be a server member to view the member list",
        ));
    }

    let members = state.member_repository().list_by_server(&server_id).await?;

    Ok((
        StatusCode::OK,
        Json(MemberListResponse::from_members(members)),
    ))
}

/// Path parameters for member-specific operations.
#[derive(Debug, Deserialize)]
pub struct MemberPath {
    pub id: ServerId,
    pub user_id: UserId,
}

/// Kick a member from a server. Owner-only.
///
/// # Errors
/// Returns `ApiError` on authorization failure or repository error.
#[utoipa::path(
    delete,
    path = "/v1/servers/{id}/members/{user_id}",
    tag = "Members",
    security(("bearer_auth" = [])),
    params(
        ("id" = ServerId, Path, description = "Server ID"),
        ("user_id" = UserId, Path, description = "User ID to kick"),
    ),
    responses(
        (status = 204, description = "Member kicked"),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Not server owner / cannot kick owner", body = ProblemDetails),
        (status = 404, description = "Server not found", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn kick_member(
    AuthUser(caller_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(path): ApiPath<MemberPath>,
) -> Result<impl IntoResponse, ApiError> {
    state
        .moderation_service()
        .kick_member(&path.id, &path.user_id, &caller_id)
        .await?;

    Ok(StatusCode::NO_CONTENT)
}
