//! Read state handlers.

use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};

use crate::api::dto::{MarkReadRequest, ReadStatesListResponse};
use crate::api::errors::{ApiError, ProblemDetails};
use crate::api::extractors::{ApiJson, ApiPath, AuthUser};
use crate::api::state::AppState;
use crate::domain::models::{ChannelId, ServerId};

/// Mark a channel as read up to a specific message.
///
/// # Errors
/// Returns `ApiError` on validation failure or repository error.
#[utoipa::path(
    patch,
    path = "/v1/channels/{id}/read-state",
    tag = "ReadStates",
    security(("bearer_auth" = [])),
    params(("id" = ChannelId, Path, description = "Channel ID")),
    request_body = MarkReadRequest,
    responses(
        (status = 204, description = "Read state updated"),
        (status = 400, description = "Validation error", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state, req))]
pub async fn mark_channel_read(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(channel_id): ApiPath<ChannelId>,
    ApiJson(req): ApiJson<MarkReadRequest>,
) -> Result<impl IntoResponse, ApiError> {
    state
        .read_state_service()
        .mark_read(&channel_id, &user_id, &req.last_message_id)
        .await?;

    Ok(StatusCode::NO_CONTENT)
}

/// List read states with unread counts for all channels in a server.
///
/// # Errors
/// Returns `ApiError` on repository error.
#[utoipa::path(
    get,
    path = "/v1/servers/{id}/read-states",
    tag = "ReadStates",
    security(("bearer_auth" = [])),
    params(("id" = ServerId, Path, description = "Server ID")),
    responses(
        (status = 200, description = "Read states list", body = ReadStatesListResponse),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn list_server_read_states(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(server_id): ApiPath<ServerId>,
) -> Result<impl IntoResponse, ApiError> {
    let states = state
        .read_state_service()
        .list_for_server(&server_id, &user_id)
        .await?;

    Ok((
        StatusCode::OK,
        Json(ReadStatesListResponse::from_states(states)),
    ))
}
