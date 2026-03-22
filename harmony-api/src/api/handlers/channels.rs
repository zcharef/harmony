//! Channel handlers.

use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};
use serde::Deserialize;

use crate::api::dto::{
    ChannelListResponse, ChannelResponse, CreateChannelRequest, UpdateChannelRequest,
};
use crate::api::errors::{ApiError, ProblemDetails};
use crate::api::extractors::{ApiJson, ApiPath, AuthUser};
use crate::api::state::AppState;
use crate::domain::models::{ChannelId, Role, ServerId};

/// List all channels in a server.
///
/// # Errors
/// Returns `ApiError` on repository error.
#[utoipa::path(
    get,
    path = "/v1/servers/{id}/channels",
    tag = "Channels",
    security(("bearer_auth" = [])),
    params(("id" = ServerId, Path, description = "Server ID")),
    responses(
        (status = 200, description = "Channel list", body = ChannelListResponse),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 404, description = "Server not found", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn list_channels(
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
            "You must be a server member to view channels",
        ));
    }

    let channels = state
        .channel_service()
        .list_for_server(&server_id, &user_id)
        .await?;

    Ok((StatusCode::OK, Json(ChannelListResponse::from(channels))))
}

/// Create a new channel in a server. Requires admin+ role.
///
/// # Errors
/// Returns `ApiError` on validation failure or repository error.
#[utoipa::path(
    post,
    path = "/v1/servers/{id}/channels",
    tag = "Channels",
    security(("bearer_auth" = [])),
    params(("id" = ServerId, Path, description = "Server ID")),
    request_body = CreateChannelRequest,
    responses(
        (status = 201, description = "Channel created", body = ChannelResponse),
        (status = 400, description = "Validation error", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Insufficient role", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state, req))]
pub async fn create_channel(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(server_id): ApiPath<ServerId>,
    ApiJson(req): ApiJson<CreateChannelRequest>,
) -> Result<impl IntoResponse, ApiError> {
    state
        .moderation_service()
        .require_role(&server_id, &user_id, Role::Admin)
        .await?;

    let channel = state
        .channel_service()
        .create_channel(
            server_id,
            req.name,
            req.channel_type,
            req.is_private,
            req.is_read_only,
        )
        .await?;

    Ok((StatusCode::CREATED, Json(ChannelResponse::from(channel))))
}

/// Path parameters for channel-specific operations.
#[derive(Debug, Deserialize)]
pub struct ChannelPath {
    pub id: ServerId,
    pub channel_id: ChannelId,
}

/// Update a channel's name and/or topic. Requires admin+ role.
///
/// # Errors
/// Returns `ApiError` on validation failure or repository error.
#[utoipa::path(
    patch,
    path = "/v1/servers/{id}/channels/{channel_id}",
    tag = "Channels",
    security(("bearer_auth" = [])),
    params(
        ("id" = ServerId, Path, description = "Server ID"),
        ("channel_id" = ChannelId, Path, description = "Channel ID"),
    ),
    request_body = UpdateChannelRequest,
    responses(
        (status = 200, description = "Channel updated", body = ChannelResponse),
        (status = 400, description = "Validation error", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Insufficient role", body = ProblemDetails),
        (status = 404, description = "Channel not found", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state, req))]
pub async fn update_channel(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(params): ApiPath<ChannelPath>,
    ApiJson(req): ApiJson<UpdateChannelRequest>,
) -> Result<impl IntoResponse, ApiError> {
    state
        .moderation_service()
        .require_role(&params.id, &user_id, Role::Admin)
        .await?;

    let channel = state
        .channel_service()
        .update_channel(
            &params.id,
            &params.channel_id,
            req.name,
            req.topic,
            req.is_private,
            req.is_read_only,
        )
        .await?;

    Ok((StatusCode::OK, Json(ChannelResponse::from(channel))))
}

/// Delete a channel. Requires admin+ role.
///
/// # Errors
/// Returns `ApiError` if this is the last channel or the channel is not found.
#[utoipa::path(
    delete,
    path = "/v1/servers/{id}/channels/{channel_id}",
    tag = "Channels",
    security(("bearer_auth" = [])),
    params(
        ("id" = ServerId, Path, description = "Server ID"),
        ("channel_id" = ChannelId, Path, description = "Channel ID"),
    ),
    responses(
        (status = 204, description = "Channel deleted"),
        (status = 400, description = "Cannot delete last channel", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Insufficient role", body = ProblemDetails),
        (status = 404, description = "Channel not found", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn delete_channel(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(params): ApiPath<ChannelPath>,
) -> Result<impl IntoResponse, ApiError> {
    state
        .moderation_service()
        .require_role(&params.id, &user_id, Role::Admin)
        .await?;

    state
        .channel_service()
        .delete_channel(&params.id, &params.channel_id)
        .await?;

    Ok(StatusCode::NO_CONTENT)
}
