//! Ban handlers.

use axum::extract::Query;
use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};
use serde::Deserialize;

use crate::api::dto::bans::{BanListQuery, BanListResponse, BanResponse, BanUserRequest};
use crate::api::errors::{ApiError, ProblemDetails};
use crate::api::extractors::{ApiJson, ApiPath, AuthUser};
use crate::api::state::AppState;
use crate::domain::models::server_event::{BanPayload, ServerEvent};
use crate::domain::models::{ServerId, UserId};
use crate::domain::ports::EventBus;

/// Default ban page size.
const DEFAULT_BAN_LIMIT: i64 = 50;
/// Maximum ban page size.
const MAX_BAN_LIMIT: i64 = 100;

/// List bans for a server with cursor-based pagination. Requires admin+ role.
///
/// Use `before` (ISO 8601) to paginate backward. Default limit is 50, max is 100.
///
/// # Errors
/// Returns `ApiError` if the cursor is invalid, authorization fails, or a repository error occurs.
#[utoipa::path(
    get,
    path = "/v1/servers/{id}/bans",
    tag = "Moderation",
    security(("bearer_auth" = [])),
    params(
        ("id" = ServerId, Path, description = "Server ID"),
        BanListQuery,
    ),
    responses(
        (status = 200, description = "Ban list", body = BanListResponse),
        (status = 400, description = "Invalid cursor or limit", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Insufficient role", body = ProblemDetails),
        (status = 404, description = "Server not found", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn list_bans(
    AuthUser(caller_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(server_id): ApiPath<ServerId>,
    Query(query): Query<BanListQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let limit = query
        .limit
        .unwrap_or(DEFAULT_BAN_LIMIT)
        .clamp(1, MAX_BAN_LIMIT);

    let cursor = query
        .before
        .map(|s| {
            s.parse::<chrono::DateTime<chrono::Utc>>()
                .map_err(|_| "Invalid 'before' cursor: expected ISO 8601 timestamp")
        })
        .transpose()
        .map_err(ApiError::bad_request)?;

    let bans = state
        .moderation_service()
        .list_bans(&server_id, &caller_id, cursor, limit)
        .await?;

    // WHY: If we received exactly `limit` rows, there may be more — provide a cursor.
    let next_cursor = if i64::try_from(bans.len()).unwrap_or(0) == limit {
        bans.last().map(|b| b.created_at.to_rfc3339())
    } else {
        None
    };

    Ok((
        StatusCode::OK,
        Json(BanListResponse::from_bans(bans, next_cursor)),
    ))
}

/// Ban a user from a server and remove their membership.
/// Requires admin+ role with hierarchy enforcement.
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
        (status = 403, description = "Insufficient role / hierarchy violation / cannot ban owner", body = ProblemDetails),
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
    let ban = state
        .moderation_service()
        .ban_user(&server_id, &req.user_id, &caller_id, req.reason)
        .await?;

    // WHY: Ban is a compound operation (INSERT ban + DELETE member). Emit three
    // events after the transaction commits:
    // 1. MemberBanned — targeted to the banned user so their client knows why
    // 2. MemberRemoved — broadcast to remaining server members to update lists
    // 3. ForceDisconnect — targeted to the banned user to drop their SSE stream
    let banned_user_id = ban.user_id.clone();

    state.event_bus().publish(ServerEvent::MemberBanned {
        sender_id: caller_id.clone(),
        server_id: server_id.clone(),
        target_user_id: banned_user_id.clone(),
        ban: BanPayload {
            reason: ban.reason.clone(),
            banned_by: ban.banned_by.clone(),
            created_at: ban.created_at,
        },
    });

    state.event_bus().publish(ServerEvent::MemberRemoved {
        sender_id: caller_id.clone(),
        server_id: server_id.clone(),
        user_id: banned_user_id.clone(),
    });

    state.event_bus().publish(ServerEvent::ForceDisconnect {
        sender_id: caller_id,
        server_id,
        target_user_id: banned_user_id,
        reason: "banned".to_string(),
    });

    Ok((StatusCode::CREATED, Json(BanResponse::from(ban))))
}

/// Path parameters for unban operations.
#[derive(Debug, Deserialize)]
pub struct BanPath {
    pub id: ServerId,
    pub user_id: UserId,
}

/// Unban a user from a server. Requires admin+ role.
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
        (status = 403, description = "Insufficient role", body = ProblemDetails),
        (status = 404, description = "Ban not found", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn unban_member(
    AuthUser(caller_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(path): ApiPath<BanPath>,
) -> Result<impl IntoResponse, ApiError> {
    state
        .moderation_service()
        .unban_user(&path.id, &path.user_id, &caller_id)
        .await?;

    // WHY: No SSE event emitted — the unbanned user is not a server member and
    // therefore has no active SSE subscription to receive server-scoped events.

    Ok(StatusCode::NO_CONTENT)
}
