//! Read state handlers.

use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};

use crate::api::dto::{ChannelReadStateResponse, MarkReadRequest};
use crate::api::errors::{ApiError, ProblemDetails};
use crate::api::extractors::{ApiJson, ApiPath, AuthUser};
use crate::api::state::AppState;
use crate::domain::models::ChannelId;

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

/// Read the caller's read position for a single channel.
///
/// Powers the "new messages" divider anchor: the client snapshots
/// `lastReadAt` once on channel open and freezes the divider boundary there.
///
/// # Errors
/// Returns `ApiError` when the channel does not exist (404), the caller may not
/// access it (403), or on a repository error.
#[utoipa::path(
    get,
    path = "/v1/channels/{id}/read-state",
    tag = "ReadStates",
    security(("bearer_auth" = [])),
    params(("id" = ChannelId, Path, description = "Channel ID")),
    responses(
        (status = 200, description = "Channel read state", body = ChannelReadStateResponse),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "No access to channel", body = ProblemDetails),
        (status = 404, description = "Channel not found", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn get_channel_read_state(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(channel_id): ApiPath<ChannelId>,
) -> Result<impl IntoResponse, ApiError> {
    let read_state = state
        .read_state_service()
        .get_for_channel(&channel_id, &user_id)
        .await?;

    Ok((
        StatusCode::OK,
        Json(ChannelReadStateResponse::from(read_state)),
    ))
}
