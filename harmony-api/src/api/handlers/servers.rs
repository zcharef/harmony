//! Server handlers.

use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};

use crate::api::dto::{
    CreateServerRequest, ServerListResponse, ServerResponse, UpdateServerRequest,
};
use crate::api::errors::{ApiError, ProblemDetails};
use crate::api::extractors::{ApiJson, ApiPath, AuthUser};
use crate::api::state::AppState;
use crate::domain::models::server_event::ServerPayload;
use crate::domain::models::{Role, ServerEvent, ServerId, VoiceAction};

/// Create a new server.
///
/// The authenticated user becomes the owner. A default `#general` channel
/// and server membership are created automatically.
///
/// # Errors
/// Returns `ApiError` on validation failure or repository error.
#[utoipa::path(
    post,
    path = "/v1/servers",
    tag = "Servers",
    security(("bearer_auth" = [])),
    request_body = CreateServerRequest,
    responses(
        (status = 201, description = "Server created", body = ServerResponse),
        (status = 400, description = "Validation error", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state, req))]
pub async fn create_server(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiJson(req): ApiJson<CreateServerRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let server = state
        .server_service()
        .create_server(req.name, user_id)
        .await?;

    Ok((StatusCode::CREATED, Json(ServerResponse::from(server))))
}

/// List all servers the authenticated user is a member of.
///
/// # Errors
/// Returns `ApiError` on repository error.
#[utoipa::path(
    get,
    path = "/v1/servers",
    tag = "Servers",
    security(("bearer_auth" = [])),
    responses(
        (status = 200, description = "Server list", body = ServerListResponse),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn list_servers(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, ApiError> {
    let servers = state.server_service().list_for_user(&user_id).await?;

    Ok((StatusCode::OK, Json(ServerListResponse::from(servers))))
}

/// Get a server by ID.
///
/// # Errors
/// Returns `ApiError` if the server is not found or a repository error occurs.
#[utoipa::path(
    get,
    path = "/v1/servers/{id}",
    tag = "Servers",
    security(("bearer_auth" = [])),
    params(("id" = ServerId, Path, description = "Server ID")),
    responses(
        (status = 200, description = "Server found", body = ServerResponse),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 404, description = "Server not found", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn get_server(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(id): ApiPath<ServerId>,
) -> Result<impl IntoResponse, ApiError> {
    let is_member = state.member_repository().is_member(&id, &user_id).await?;
    if !is_member {
        return Err(ApiError::forbidden(
            "You must be a server member to view this server",
        ));
    }

    let server = state.server_service().get_by_id(&id).await?;

    Ok((StatusCode::OK, Json(ServerResponse::from(server))))
}

/// Update a server's name. Requires admin+ role.
///
/// # Errors
/// Returns `ApiError` on validation failure or repository error.
#[utoipa::path(
    patch,
    path = "/v1/servers/{id}",
    tag = "Servers",
    security(("bearer_auth" = [])),
    params(("id" = ServerId, Path, description = "Server ID")),
    request_body = UpdateServerRequest,
    responses(
        (status = 200, description = "Server updated", body = ServerResponse),
        (status = 400, description = "Validation error", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Insufficient role", body = ProblemDetails),
        (status = 404, description = "Server not found", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state, req))]
pub async fn update_server(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(id): ApiPath<ServerId>,
    ApiJson(req): ApiJson<UpdateServerRequest>,
) -> Result<impl IntoResponse, ApiError> {
    state
        .moderation_service()
        .require_role(&id, &user_id, Role::Admin)
        .await?;

    let server = state.server_service().update_server(&id, req.name).await?;

    let receivers = state.event_bus().publish(ServerEvent::ServerUpdated {
        sender_id: user_id,
        server_id: server.id.clone(),
        server: ServerPayload {
            id: server.id.clone(),
            name: server.name.clone(),
            icon_url: server.icon_url.clone(),
            owner_id: server.owner_id.clone(),
        },
    });
    tracing::debug!(
        server_id = %server.id,
        receivers,
        "emitted server.updated"
    );

    Ok((StatusCode::OK, Json(ServerResponse::from(server))))
}

/// Delete a server. Requires owner role.
///
/// # Errors
/// Returns `ApiError` on insufficient role, not found, or repository error.
#[utoipa::path(
    delete,
    path = "/v1/servers/{id}",
    tag = "Servers",
    security(("bearer_auth" = [])),
    params(("id" = ServerId, Path, description = "Server ID")),
    responses(
        (status = 204, description = "Server deleted"),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Insufficient role", body = ProblemDetails),
        (status = 404, description = "Server not found", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn delete_server(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(id): ApiPath<ServerId>,
) -> Result<impl IntoResponse, ApiError> {
    state
        .moderation_service()
        .require_role(&id, &user_id, Role::Owner)
        .await?;

    // WHY: ON DELETE CASCADE in voice_sessions will silently remove sessions
    // when the server row is deleted. Snapshot them BEFORE deletion so we can
    // emit VoiceStateUpdate(Left) events and prevent ghost participants on
    // other clients.
    let orphaned_voice_sessions = if let Some(voice_service) = state.voice_service() {
        voice_service.list_server_sessions(&id).await?
    } else {
        vec![]
    };

    state.server_service().delete_server(&id).await?;

    // Emit voice "left" events for sessions that were CASCADE-deleted.
    for session in &orphaned_voice_sessions {
        let receivers = state.event_bus().publish(ServerEvent::VoiceStateUpdate {
            sender_id: user_id.clone(),
            server_id: session.server_id.clone(),
            channel_id: session.channel_id.clone(),
            user_id: session.user_id.clone(),
            action: VoiceAction::Left,
            display_name: String::new(),
            is_muted: None,
            is_deafened: None,
        });
        tracing::debug!(
            server_id = %session.server_id,
            channel_id = %session.channel_id,
            user_id = %session.user_id,
            receivers,
            "emitted voice.state_update (left, server cascade-deleted)"
        );
    }

    tracing::debug!(
        server_id = %id,
        "server deleted"
    );

    Ok(StatusCode::NO_CONTENT)
}
