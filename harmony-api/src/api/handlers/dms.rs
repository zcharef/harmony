//! DM (Direct Message) handlers.

use axum::extract::Query;
use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};

use crate::api::dto::dms::{CreateDmRequest, DmListQuery, DmListResponse, DmResponse};
use crate::api::errors::{ApiError, ProblemDetails};
use crate::api::extractors::{ApiJson, ApiPath, AuthUser};
use crate::api::state::AppState;
use crate::domain::models::ServerId;

/// Default DM list page size.
const DEFAULT_DM_LIMIT: i64 = 50;
/// Maximum DM list page size.
const MAX_DM_LIMIT: i64 = 100;

/// Create a new DM conversation or return an existing one (idempotent).
///
/// If a DM already exists between the caller and the recipient, returns the
/// existing conversation with `200 OK`. Otherwise creates a new DM and returns
/// `201 Created`.
///
/// # Errors
/// Returns `ApiError` on validation failure or repository error.
#[utoipa::path(
    post,
    path = "/v1/dms",
    tag = "DirectMessages",
    security(("bearer_auth" = [])),
    request_body = CreateDmRequest,
    responses(
        (status = 201, description = "DM created", body = DmResponse),
        (status = 200, description = "Existing DM returned", body = DmResponse),
        (status = 400, description = "Cannot DM yourself", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 404, description = "Recipient not found", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state, req))]
pub async fn create_dm(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiJson(req): ApiJson<CreateDmRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let (conversation, created) = state
        .dm_service()
        .create_or_get_dm(&user_id, &req.recipient_id)
        .await?;

    let status = if created {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };

    Ok((status, Json(DmResponse::from(conversation))))
}

/// List DM conversations for the authenticated user.
///
/// Returns DM conversations sorted by most recent activity (message or creation).
/// Uses cursor-based pagination.
///
/// # Errors
/// Returns `ApiError` if the cursor is invalid or a repository error occurs.
#[utoipa::path(
    get,
    path = "/v1/dms",
    tag = "DirectMessages",
    security(("bearer_auth" = [])),
    params(DmListQuery),
    responses(
        (status = 200, description = "DM list", body = DmListResponse),
        (status = 400, description = "Invalid cursor or limit", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn list_dms(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    Query(query): Query<DmListQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let limit = query
        .limit
        .unwrap_or(DEFAULT_DM_LIMIT)
        .clamp(1, MAX_DM_LIMIT);

    let cursor = query
        .before
        .map(|s| {
            s.parse::<chrono::DateTime<chrono::Utc>>()
                .map_err(|_| "Invalid 'before' cursor: expected ISO 8601 timestamp")
        })
        .transpose()
        .map_err(ApiError::bad_request)?;

    let dms = state.dm_service().list_dms(&user_id, cursor, limit).await?;

    // WHY: If we received exactly `limit` rows, there may be more -- provide a cursor.
    // Use last_message_at (or joined_at as fallback) matching the ORDER BY in the query:
    // `COALESCE(latest_msg.created_at, my_membership.joined_at)`.
    let next_cursor = if i64::try_from(dms.len()).unwrap_or(0) == limit {
        dms.last()
            .map(|dm| dm.last_message_at.unwrap_or(dm.joined_at).to_rfc3339())
    } else {
        None
    };

    Ok((
        StatusCode::OK,
        Json(DmListResponse::from_conversations(dms, next_cursor)),
    ))
}

/// Close (leave) a DM conversation.
///
/// Removes the authenticated user from the DM server. The conversation data
/// is preserved for the other participant.
///
/// # Errors
/// Returns `ApiError` on authorization failure or repository error.
#[utoipa::path(
    delete,
    path = "/v1/dms/{server_id}",
    tag = "DirectMessages",
    security(("bearer_auth" = [])),
    params(("server_id" = ServerId, Path, description = "DM server ID")),
    responses(
        (status = 204, description = "DM closed"),
        (status = 400, description = "Not a DM server", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Not a member of this DM", body = ProblemDetails),
        (status = 404, description = "DM not found", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn close_dm(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(server_id): ApiPath<ServerId>,
) -> Result<impl IntoResponse, ApiError> {
    state.dm_service().close_dm(&user_id, &server_id).await?;

    Ok(StatusCode::NO_CONTENT)
}
