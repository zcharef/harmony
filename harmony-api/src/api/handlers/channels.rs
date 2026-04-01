//! Channel handlers.

use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};
use serde::Deserialize;

use crate::api::dto::{
    ChannelListResponse, ChannelResponse, CreateChannelRequest, CreateMegolmSessionRequest,
    MegolmSessionResponse, UpdateChannelRequest,
};
use crate::api::errors::{ApiError, ProblemDetails};
use crate::api::extractors::{ApiJson, ApiPath, AuthUser};
use crate::api::state::AppState;
use crate::domain::models::server_event::ChannelPayload;
use crate::domain::models::{ChannelId, Role, ServerEvent, ServerId};

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
            server_id.clone(),
            req.name,
            req.channel_type,
            req.is_private,
            req.is_read_only,
        )
        .await?;

    let receivers = state.event_bus().publish(ServerEvent::ChannelCreated {
        sender_id: user_id,
        server_id: server_id.clone(),
        channel: ChannelPayload {
            id: channel.id.clone(),
            name: channel.name.clone(),
            topic: channel.topic.clone(),
            channel_type: channel.channel_type.clone(),
            position: channel.position,
            is_private: channel.is_private,
            is_read_only: channel.is_read_only,
            encrypted: channel.encrypted,
            created_at: channel.created_at,
            updated_at: channel.updated_at,
        },
    });
    tracing::debug!(
        server_id = %server_id,
        channel_id = %channel.id,
        receivers,
        "emitted channel.created"
    );

    Ok((StatusCode::CREATED, Json(ChannelResponse::from(channel))))
}

/// Path parameters for channel-specific operations.
#[derive(Debug, Deserialize)]
pub struct ChannelPath {
    pub id: ServerId,
    pub channel_id: ChannelId,
}

/// Update a channel's name, topic, and/or flags. Requires admin+ role.
/// Enabling encryption requires owner role (one-way toggle).
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
    // WHY: Enabling encryption is an irreversible action — require Owner role.
    // Other channel updates (name, topic, flags) only require Admin+.
    let required_role = if req.encrypted == Some(true) {
        Role::Owner
    } else {
        Role::Admin
    };

    state
        .moderation_service()
        .require_role(&params.id, &user_id, required_role)
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
            req.encrypted,
        )
        .await?;

    let receivers = state.event_bus().publish(ServerEvent::ChannelUpdated {
        sender_id: user_id,
        server_id: params.id.clone(),
        channel: ChannelPayload {
            id: channel.id.clone(),
            name: channel.name.clone(),
            topic: channel.topic.clone(),
            channel_type: channel.channel_type.clone(),
            position: channel.position,
            is_private: channel.is_private,
            is_read_only: channel.is_read_only,
            encrypted: channel.encrypted,
            created_at: channel.created_at,
            updated_at: channel.updated_at,
        },
    });
    tracing::debug!(
        server_id = %params.id,
        channel_id = %channel.id,
        receivers,
        "emitted channel.updated"
    );

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

    let receivers = state.event_bus().publish(ServerEvent::ChannelDeleted {
        sender_id: user_id,
        server_id: params.id.clone(),
        channel_id: params.channel_id.clone(),
    });
    tracing::debug!(
        server_id = %params.id,
        channel_id = %params.channel_id,
        receivers,
        "emitted channel.deleted"
    );

    Ok(StatusCode::NO_CONTENT)
}

/// Register a Megolm session for an encrypted channel. Requires channel membership.
///
/// # Errors
/// Returns `ApiError` if the channel is not encrypted, or on repository error.
#[utoipa::path(
    post,
    path = "/v1/channels/{id}/megolm-sessions",
    tag = "Channels",
    security(("bearer_auth" = [])),
    params(("id" = ChannelId, Path, description = "Channel ID")),
    request_body = CreateMegolmSessionRequest,
    responses(
        (status = 201, description = "Megolm session registered", body = MegolmSessionResponse),
        (status = 400, description = "Channel not encrypted", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Not a member", body = ProblemDetails),
        (status = 404, description = "Channel not found", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state, req))]
pub async fn create_megolm_session(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(channel_id): ApiPath<ChannelId>,
    ApiJson(req): ApiJson<CreateMegolmSessionRequest>,
) -> Result<impl IntoResponse, ApiError> {
    // Validate the channel exists and is encrypted
    let channel = state.channel_service().get_by_id(&channel_id).await?;

    if !channel.encrypted {
        return Err(ApiError::bad_request(
            "Cannot register Megolm session on a non-encrypted channel",
        ));
    }

    // Verify the caller is a member of the server
    let is_member = state
        .member_repository()
        .is_member(&channel.server_id, &user_id)
        .await?;
    if !is_member {
        return Err(ApiError::forbidden(
            "You must be a server member to register Megolm sessions",
        ));
    }

    // Validate session_id is not empty
    if req.session_id.trim().is_empty() {
        return Err(ApiError::bad_request("session_id must not be empty"));
    }
    if req.session_id.len() > 256 {
        return Err(ApiError::bad_request(
            "session_id must not exceed 256 characters",
        ));
    }

    let session = state
        .megolm_session_repository()
        .store_session(&channel_id, &req.session_id, &user_id)
        .await?;

    Ok((
        StatusCode::CREATED,
        Json(MegolmSessionResponse::from(session)),
    ))
}
