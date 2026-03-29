//! Member handlers.

use axum::extract::Query;
use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};
use serde::Deserialize;

use crate::api::dto::members::{
    AssignRoleRequest, MemberListQuery, MemberListResponse, TransferOwnershipRequest,
};
use crate::api::dto::{MemberResponse, ServerResponse};
use crate::api::errors::{ApiError, ProblemDetails};
use crate::api::extractors::{ApiJson, ApiPath, AuthUser};
use crate::api::state::AppState;
use crate::domain::models::{ServerId, UserId};

/// Default member page size.
const DEFAULT_MEMBER_LIMIT: i64 = 50;
/// Maximum member page size.
const MAX_MEMBER_LIMIT: i64 = 100;

/// List members of a server with cursor-based pagination.
///
/// Use `before` (ISO 8601) to paginate backward. Default limit is 50, max is 100.
///
/// # Errors
/// Returns `ApiError` if the cursor is invalid or a repository error occurs.
#[utoipa::path(
    get,
    path = "/v1/servers/{id}/members",
    tag = "Members",
    security(("bearer_auth" = [])),
    params(
        ("id" = ServerId, Path, description = "Server ID"),
        MemberListQuery,
    ),
    responses(
        (status = 200, description = "Member list", body = MemberListResponse),
        (status = 400, description = "Invalid cursor or limit", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 404, description = "Server not found", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn list_members(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(server_id): ApiPath<ServerId>,
    Query(query): Query<MemberListQuery>,
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

    let limit = query
        .limit
        .unwrap_or(DEFAULT_MEMBER_LIMIT)
        .clamp(1, MAX_MEMBER_LIMIT);

    let cursor = query
        .before
        .map(|s| {
            s.parse::<chrono::DateTime<chrono::Utc>>()
                .map_err(|_| "Invalid 'before' cursor: expected ISO 8601 timestamp")
        })
        .transpose()
        .map_err(ApiError::bad_request)?;

    let members = state
        .member_repository()
        .list_by_server_paginated(&server_id, cursor, limit)
        .await?;

    // WHY: If we received exactly `limit` rows, there may be more — provide a cursor.
    let next_cursor = if i64::try_from(members.len()).unwrap_or(0) == limit {
        members.last().map(|m| m.joined_at.to_rfc3339())
    } else {
        None
    };

    Ok((
        StatusCode::OK,
        Json(MemberListResponse::from_members(members, next_cursor)),
    ))
}

/// Path parameters for member-specific operations.
#[derive(Debug, Deserialize)]
pub struct MemberPath {
    pub id: ServerId,
    pub user_id: UserId,
}

/// Kick a member from a server. Requires moderator+ role with hierarchy enforcement.
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
        (status = 403, description = "Insufficient role or hierarchy violation", body = ProblemDetails),
        (status = 404, description = "Server or member not found", body = ProblemDetails),
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

/// Assign a role to a server member. Requires admin+ role with hierarchy enforcement.
///
/// # Errors
/// Returns `ApiError` on validation failure, authorization failure, or repository error.
#[utoipa::path(
    patch,
    path = "/v1/servers/{id}/members/{user_id}/role",
    tag = "Members",
    security(("bearer_auth" = [])),
    params(
        ("id" = ServerId, Path, description = "Server ID"),
        ("user_id" = UserId, Path, description = "Target user ID"),
    ),
    request_body = AssignRoleRequest,
    responses(
        (status = 200, description = "Role assigned", body = MemberResponse),
        (status = 400, description = "Invalid role or self-assignment", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Insufficient role or hierarchy violation", body = ProblemDetails),
        (status = 404, description = "Server or member not found", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state, req))]
pub async fn assign_role(
    AuthUser(caller_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(path): ApiPath<MemberPath>,
    ApiJson(req): ApiJson<AssignRoleRequest>,
) -> Result<impl IntoResponse, ApiError> {
    state
        .moderation_service()
        .assign_role(&path.id, &caller_id, &path.user_id, req.role)
        .await?;

    // Return the updated member
    let member = state
        .member_repository()
        .get_member(&path.id, &path.user_id)
        .await?
        .ok_or_else(|| {
            ApiError::not_found(format!(
                "ServerMember with id 'server={}, user={}' not found",
                path.id, path.user_id
            ))
        })?;

    Ok((StatusCode::OK, Json(MemberResponse::from(member))))
}

/// Transfer server ownership. Only the current owner can do this.
///
/// # Errors
/// Returns `ApiError` on authorization failure or repository error.
#[utoipa::path(
    post,
    path = "/v1/servers/{id}/transfer-ownership",
    tag = "Members",
    security(("bearer_auth" = [])),
    params(("id" = ServerId, Path, description = "Server ID")),
    request_body = TransferOwnershipRequest,
    responses(
        (status = 200, description = "Ownership transferred", body = ServerResponse),
        (status = 400, description = "Cannot transfer to self", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Not server owner", body = ProblemDetails),
        (status = 404, description = "Server or new owner not found", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state, req))]
pub async fn transfer_ownership(
    AuthUser(caller_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(server_id): ApiPath<ServerId>,
    ApiJson(req): ApiJson<TransferOwnershipRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let server = state
        .moderation_service()
        .transfer_ownership(&server_id, &caller_id, &req.new_owner_id)
        .await?;

    Ok((StatusCode::OK, Json(ServerResponse::from(server))))
}
