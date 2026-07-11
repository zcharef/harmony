//! Channel handlers.

use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};
use serde::Deserialize;

use crate::api::dto::{
    ChannelListResponse, ChannelResponse, ChannelRoleAccessResponse, CreateChannelRequest,
    CreateMegolmSessionRequest, MegolmSessionResponse, SetChannelRoleAccessRequest,
    UpdateChannelRequest,
};
use crate::api::errors::{ApiError, ProblemDetails};
use crate::api::extractors::{ApiJson, ApiPath, AuthUser};
use crate::api::state::AppState;
use crate::domain::models::server_event::ChannelPayload;
use crate::domain::models::{ChannelId, Role, ServerEvent, ServerId, VoiceAction};
use crate::domain::services::{
    ensure_channel_access, resolve_channel_access, resolve_channel_access_by_id,
};

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

    // WHY resolve AFTER creation: the grant lookup needs the channel id. A
    // fresh private channel has no channel_role_access rows yet, so only
    // Owner/Admin receive channel.created — grants come later (Discord parity).
    // Fail OPEN on resolver error (ADR-027, F5 decision #3): losing the event
    // (e.g. a PUBLIC channel silently missing from every sidebar) is worse
    // than a private one reaching a few extra members for one event — REST
    // stays the authoritative gate. Matches the F3 moderation-sweep precedent.
    let channel_access = resolve_channel_access(state.channel_repository(), &channel)
        .await
        .unwrap_or_else(|e| {
            tracing::warn!(
                server_id = %server_id,
                channel_id = %channel.id,
                error = %e,
                "Failed to resolve channel access for channel.created — failing open (public)"
            );
            None
        });
    let receivers = state.event_bus().publish(ServerEvent::ChannelCreated {
        sender_id: user_id,
        server_id: server_id.clone(),
        channel: ChannelPayload::from(&channel),
        channel_access,
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

    // WHY snapshot pre-update privacy: a public→private flip gates the
    // channel.updated below to the granted set, so ungranted members never
    // hear about it — the flip must ALSO fan out channel.access_updated
    // (server-scoped) so their sidebars evict the channel live. Fail open to
    // `None` (unknown) on lookup error: the flip then still emits the
    // idempotent access_updated event rather than silently skipping it.
    let was_private = match state
        .channel_repository()
        .get_by_id(&params.channel_id)
        .await
    {
        Ok(pre) => pre.map(|c| c.is_private),
        Err(e) => {
            tracing::warn!(
                server_id = %params.id,
                channel_id = %params.channel_id,
                error = %e,
                "Failed to read pre-update channel state — treating privacy transition as unknown"
            );
            None
        }
    };

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
            req.slow_mode_seconds,
        )
        .await?;

    // WHY resolve from the POST-update channel: a public→private toggle gates
    // this very event immediately; private→public resolves to None and delivers
    // to everyone. Fail OPEN on resolver error (ADR-027, F5 decision #3) —
    // same reasoning as channel.created above.
    let channel_access = resolve_channel_access(state.channel_repository(), &channel)
        .await
        .unwrap_or_else(|e| {
            tracing::warn!(
                server_id = %params.id,
                channel_id = %channel.id,
                error = %e,
                "Failed to resolve channel access for channel.updated — failing open (public)"
            );
            None
        });

    // WHY emit access_updated on the public→private flip (and ONLY that
    // direction): channel.updated above now reaches granted roles + admins
    // only, so ungranted members would keep a phantom sidebar entry forever.
    // channel.access_updated is deliberately server-scoped with bounded
    // metadata (channel id + grant set, never name/topic) — every member
    // re-evaluates visibility live, mirroring set_channel_role_access. The
    // private→public direction must NOT emit it: clients treat a role missing
    // from the grant set as "evict", which would wrongly hide a now-public
    // channel; that direction is already covered by the ungated
    // channel.updated.
    if channel.is_private && was_private != Some(true) {
        let authorized_roles = channel_access
            .as_ref()
            .map(|scope| scope.authorized_roles.clone())
            .unwrap_or_default();
        let receivers = state
            .event_bus()
            .publish(ServerEvent::ChannelAccessUpdated {
                sender_id: user_id.clone(),
                server_id: params.id.clone(),
                channel_id: channel.id.clone(),
                authorized_roles,
            });
        tracing::debug!(
            server_id = %params.id,
            channel_id = %channel.id,
            receivers,
            "emitted channel.access_updated (channel made private)"
        );
    }

    let receivers = state.event_bus().publish(ServerEvent::ChannelUpdated {
        sender_id: user_id,
        server_id: params.id.clone(),
        channel: ChannelPayload::from(&channel),
        channel_access,
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

    // WHY: ON DELETE CASCADE in voice_sessions will silently remove sessions
    // when the channel row is deleted. Snapshot them BEFORE deletion so we can
    // emit VoiceStateUpdate(Left) events and prevent ghost participants on
    // other clients.
    let orphaned_voice_sessions = if let Some(voice_service) = state.voice_service() {
        voice_service
            .list_participants(&params.channel_id, &user_id)
            .await?
    } else {
        vec![]
    };

    // WHY resolve BEFORE deletion: the channel row (and its channel_role_access
    // grants) are gone afterwards, and a missing channel resolves to None
    // (public) — which would broadcast a private channel's deletion AND its
    // voice roster to the whole server. A resolver error fails the request
    // here (nothing deleted yet) — fail closed, the client simply retries.
    // NOTE on the Ok(None)-for-missing-channel case: if a concurrent request
    // deletes the channel between this resolve and the delete below, the
    // delete_channel service call 404s (get_by_id + delete_if_not_last both
    // error on a missing row) and the handler bails BEFORE any publish — so
    // the fail-open-on-missing semantics of the resolver cannot leak here.
    // Every orphaned voice session below is in this same channel, so the
    // cascade Left events and channel.deleted share this one scope.
    let channel_access =
        resolve_channel_access_by_id(state.channel_repository(), &params.channel_id).await?;

    state
        .channel_service()
        .delete_channel(&params.id, &params.channel_id)
        .await?;

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
            channel_access: channel_access.clone(),
        });
        tracing::debug!(
            server_id = %session.server_id,
            channel_id = %session.channel_id,
            user_id = %session.user_id,
            receivers,
            "emitted voice.state_update (left, channel cascade-deleted)"
        );
    }

    let receivers = state.event_bus().publish(ServerEvent::ChannelDeleted {
        sender_id: user_id,
        server_id: params.id.clone(),
        channel_id: params.channel_id.clone(),
        channel_access,
    });
    tracing::debug!(
        server_id = %params.id,
        channel_id = %params.channel_id,
        receivers,
        "emitted channel.deleted"
    );

    Ok(StatusCode::NO_CONTENT)
}

/// List the role-access grant set of a private channel. Requires admin+ role.
///
/// Only admins manage channel access, so this is admin-gated: a plain member
/// never needs to enumerate grants (they either see the channel or they don't).
///
/// # Errors
/// Returns `ApiError` on authorization failure or if the channel is not found /
/// does not belong to the path server.
#[utoipa::path(
    get,
    path = "/v1/servers/{id}/channels/{channel_id}/role-access",
    tag = "Channels",
    security(("bearer_auth" = [])),
    params(
        ("id" = ServerId, Path, description = "Server ID"),
        ("channel_id" = ChannelId, Path, description = "Channel ID"),
    ),
    responses(
        (status = 200, description = "Channel role-access grant set", body = ChannelRoleAccessResponse),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Insufficient role", body = ProblemDetails),
        (status = 404, description = "Channel not found", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn get_channel_role_access(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(params): ApiPath<ChannelPath>,
) -> Result<impl IntoResponse, ApiError> {
    state
        .moderation_service()
        .require_role(&params.id, &user_id, Role::Admin)
        .await?;

    // WHY load + verify: a channel_id from another server must 404, not leak the
    // target channel's grants (path-integrity, same posture as the reaction
    // message-channel binding).
    let channel = load_channel_in_server(&state, &params).await?;

    let roles = state
        .channel_repository()
        .list_authorized_roles(&channel.id)
        .await?;

    Ok((
        StatusCode::OK,
        Json(ChannelRoleAccessResponse::from((channel.id, roles))),
    ))
}

/// Replace the role-access grant set of a private channel. Requires admin+ role.
///
/// Idempotent, replace-the-set semantics (last-writer-wins, race-safe): the body
/// is the DESIRED set of grantable roles. Only `moderator`/`member` are accepted.
///
/// # Errors
/// Returns `ApiError` on authorization failure, an ungrantable role in the body,
/// or if the channel is not found / does not belong to the path server.
#[utoipa::path(
    put,
    path = "/v1/servers/{id}/channels/{channel_id}/role-access",
    tag = "Channels",
    security(("bearer_auth" = [])),
    params(
        ("id" = ServerId, Path, description = "Server ID"),
        ("channel_id" = ChannelId, Path, description = "Channel ID"),
    ),
    request_body = SetChannelRoleAccessRequest,
    responses(
        (status = 200, description = "Grant set replaced", body = ChannelRoleAccessResponse),
        (status = 400, description = "admin/owner cannot be granted", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Insufficient role", body = ProblemDetails),
        (status = 404, description = "Channel not found", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state, req))]
pub async fn set_channel_role_access(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(params): ApiPath<ChannelPath>,
    ApiJson(req): ApiJson<SetChannelRoleAccessRequest>,
) -> Result<impl IntoResponse, ApiError> {
    state
        .moderation_service()
        .require_role(&params.id, &user_id, Role::Admin)
        .await?;

    let channel = load_channel_in_server(&state, &params).await?;

    // WHY reject admin/owner: they hold IMPLICIT access to every private channel.
    // Persisting them would break the read path's invariant that the grant table
    // only ever stores moderator/member (F-note in the migration; the read path
    // merely `warn`s on drift — the write path must PREVENT it).
    for role in &req.roles {
        if !role.is_channel_grantable() {
            return Err(ApiError::bad_request(
                "admin and owner have implicit access and cannot be granted",
            ));
        }
    }

    state
        .channel_repository()
        .replace_role_access(&channel.id, &req.roles)
        .await?;

    // WHY re-read: the response + SSE payload must reflect the canonical stored
    // set (deduped, parsed), not the raw request — and it proves the write landed.
    let granted_roles = state
        .channel_repository()
        .list_authorized_roles(&channel.id)
        .await?;

    // WHY server-scoped fan-out (not gated by channel_access): every member must
    // re-evaluate visibility, including the member whose role was just GRANTED —
    // gating by the current grant set would starve them (A4 decision).
    let receivers = state
        .event_bus()
        .publish(ServerEvent::ChannelAccessUpdated {
            sender_id: user_id,
            server_id: params.id.clone(),
            channel_id: channel.id.clone(),
            authorized_roles: granted_roles.clone(),
        });
    tracing::debug!(
        server_id = %params.id,
        channel_id = %channel.id,
        receivers,
        "emitted channel.access_updated"
    );

    Ok((
        StatusCode::OK,
        Json(ChannelRoleAccessResponse::from((channel.id, granted_roles))),
    ))
}

/// Load a channel and assert it belongs to the path server.
///
/// WHY: both role-access handlers take `{id}/channels/{channel_id}` — a
/// `channel_id` from a different server must 404 (not act on / leak another
/// server's channel), even though the caller is an admin of the path server.
async fn load_channel_in_server(
    state: &AppState,
    params: &ChannelPath,
) -> Result<crate::domain::models::Channel, ApiError> {
    let channel = state
        .channel_service()
        .get_by_id(&params.channel_id)
        .await?;
    if channel.server_id != params.id {
        return Err(ApiError::not_found("Channel not found"));
    }
    Ok(channel)
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

    // WHY: The previous check verified server membership only — any member could
    // register a Megolm session on a PRIVATE encrypted channel they had no grant
    // for. The shared gate enforces membership AND the private-channel role gate,
    // same as the message/reaction paths (DomainError → ApiError per ADR-021).
    ensure_channel_access(
        state.channel_repository(),
        state.member_repository(),
        &channel,
        &user_id,
    )
    .await?;

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
