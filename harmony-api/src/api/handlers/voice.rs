//! Voice channel handlers.

use std::collections::HashMap;

use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};

use crate::api::dto::voice::{
    VoiceHeartbeatRequest, VoiceParticipantsResponse, VoiceTokenResponse,
};
use crate::api::errors::{ApiError, ProblemDetails};
use crate::api::extractors::{ApiPath, AuthUser};
use crate::api::state::AppState;
use crate::domain::models::{ChannelId, ServerEvent, VoiceAction, VoiceParticipant};

/// Join a voice channel. Returns a `LiveKit` token for the client.
///
/// If the user is already in another voice channel, they are automatically
/// moved and a `VoiceStateUpdate(Left)` event is emitted for the old channel.
///
/// # Errors
/// - 401 if not authenticated.
/// - 403 if not a server member or plan limit exceeded.
/// - 404 if the channel does not exist.
/// - 422 if the channel is not a voice channel.
/// - 503 if voice is not configured (`LiveKit` disabled).
#[utoipa::path(
    post,
    path = "/v1/channels/{id}/voice/join",
    tag = "Voice",
    security(("bearer_auth" = [])),
    params(("id" = ChannelId, Path, description = "Voice channel ID")),
    responses(
        (status = 200, description = "Joined voice channel", body = VoiceTokenResponse),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Forbidden or plan limit exceeded", body = ProblemDetails),
        (status = 404, description = "Channel not found", body = ProblemDetails),
        (status = 422, description = "Not a voice channel", body = ProblemDetails),
        (status = 503, description = "Voice not configured", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn join_voice(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(channel_id): ApiPath<ChannelId>,
) -> Result<impl IntoResponse, ApiError> {
    let voice_service = state.voice_service().ok_or_else(|| {
        ApiError::service_unavailable(
            "Voice Not Configured",
            "Voice channels are not available on this server. Configure LiveKit to enable voice.",
        )
    })?;

    let voice_token = voice_service.join_voice(&user_id, &channel_id).await?;

    // WHY: If the user was in a different channel, notify that channel's
    // listeners that the user left before notifying the new channel.
    // Uses previous_server_id so cross-server auto-leave targets the correct
    // server's SSE subscribers.
    if let Some(prev_channel_id) = &voice_token.previous_channel_id {
        let prev_server_id = voice_token
            .previous_server_id
            .as_ref()
            .unwrap_or(&voice_token.server_id);

        let receivers = state.event_bus().publish(ServerEvent::VoiceStateUpdate {
            sender_id: user_id.clone(),
            server_id: prev_server_id.clone(),
            channel_id: prev_channel_id.clone(),
            user_id: user_id.clone(),
            action: VoiceAction::Left,
            display_name: String::new(),
        });
        tracing::debug!(
            server_id = %prev_server_id,
            channel_id = %prev_channel_id,
            user_id = %user_id,
            receivers,
            "emitted voice.state_update (left previous channel)"
        );
    }

    // WHY: Resolve username so SSE subscribers can render the participant
    // immediately without a follow-up API call (prevents UUID flash in the UI).
    let display_name = match state.profile_service().get_by_id_optional(&user_id).await {
        Ok(Some(profile)) => profile.username,
        Ok(None) => user_id.to_string(),
        Err(e) => {
            tracing::warn!(
                user_id = %user_id,
                error = ?e,
                "Failed to fetch profile for voice join event — using user_id"
            );
            user_id.to_string()
        }
    };

    let receivers = state.event_bus().publish(ServerEvent::VoiceStateUpdate {
        sender_id: user_id.clone(),
        server_id: voice_token.server_id.clone(),
        channel_id: voice_token.channel_id.clone(),
        user_id: user_id.clone(),
        action: VoiceAction::Joined,
        display_name,
    });
    tracing::debug!(
        server_id = %voice_token.server_id,
        channel_id = %voice_token.channel_id,
        user_id = %user_id,
        receivers,
        "emitted voice.state_update (joined)"
    );

    Ok((StatusCode::OK, Json(VoiceTokenResponse::from(voice_token))))
}

/// Leave a voice channel. The user must be in the specified channel.
///
/// # Errors
/// - 401 if not authenticated.
/// - 409 if the user is not in the specified channel.
/// - 503 if voice is not configured (`LiveKit` disabled).
#[utoipa::path(
    post,
    path = "/v1/channels/{id}/voice/leave",
    tag = "Voice",
    security(("bearer_auth" = [])),
    params(("id" = ChannelId, Path, description = "Voice channel ID")),
    responses(
        (status = 204, description = "Left voice channel"),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 409, description = "Not in the specified channel", body = ProblemDetails),
        (status = 503, description = "Voice not configured", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn leave_voice(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(channel_id): ApiPath<ChannelId>,
) -> Result<impl IntoResponse, ApiError> {
    let voice_service = state.voice_service().ok_or_else(|| {
        ApiError::service_unavailable(
            "Voice Not Configured",
            "Voice channels are not available on this server. Configure LiveKit to enable voice.",
        )
    })?;

    // WHY: Pass channel_id to the service so it validates the user is in the
    // specified channel before removing. Prevents leaving the wrong channel.
    let removed_session = voice_service
        .leave_voice(&user_id, Some(&channel_id))
        .await?;

    if let Some(session) = removed_session {
        let receivers = state.event_bus().publish(ServerEvent::VoiceStateUpdate {
            sender_id: user_id.clone(),
            server_id: session.server_id.clone(),
            channel_id: session.channel_id.clone(),
            user_id: user_id.clone(),
            action: VoiceAction::Left,
            display_name: String::new(),
        });
        tracing::debug!(
            server_id = %session.server_id,
            channel_id = %session.channel_id,
            user_id = %user_id,
            receivers,
            "emitted voice.state_update (left)"
        );
    }

    Ok(StatusCode::NO_CONTENT)
}

/// List all participants currently in a voice channel.
///
/// # Errors
/// - 401 if not authenticated.
/// - 403 if not a server member.
/// - 404 if the channel does not exist.
/// - 503 if voice is not configured (`LiveKit` disabled).
#[utoipa::path(
    get,
    path = "/v1/channels/{id}/voice/participants",
    tag = "Voice",
    security(("bearer_auth" = [])),
    params(("id" = ChannelId, Path, description = "Voice channel ID")),
    responses(
        (status = 200, description = "Participant list", body = VoiceParticipantsResponse),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Forbidden", body = ProblemDetails),
        (status = 404, description = "Channel not found", body = ProblemDetails),
        (status = 503, description = "Voice not configured", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn list_voice_participants(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(channel_id): ApiPath<ChannelId>,
) -> Result<impl IntoResponse, ApiError> {
    let voice_service = state.voice_service().ok_or_else(|| {
        ApiError::service_unavailable(
            "Voice Not Configured",
            "Voice channels are not available on this server. Configure LiveKit to enable voice.",
        )
    })?;

    let sessions = voice_service
        .list_participants(&channel_id, &user_id)
        .await?;

    // WHY: VoiceSession doesn't carry display_name. Resolve from profiles so
    // the participant list shows human-readable names instead of UUIDs.

    // WHY: Single batch query instead of N+1 per-session lookups.
    let user_ids: Vec<_> = sessions.iter().map(|s| s.user_id.clone()).collect();
    let profiles_by_id: HashMap<_, _> = match state
        .profile_service()
        .get_profiles_by_ids(&user_ids)
        .await
    {
        Ok(profiles) => profiles.into_iter().map(|p| (p.id.clone(), p)).collect(),
        Err(e) => {
            tracing::warn!(
                error = ?e,
                "Failed to batch-fetch profiles for voice participants — falling back to user_ids"
            );
            HashMap::new()
        }
    };

    let participants: Vec<_> = sessions
        .into_iter()
        .map(|session| {
            let display_name = profiles_by_id
                .get(&session.user_id)
                .map(|p| p.username.clone())
                .unwrap_or_else(|| session.user_id.to_string());

            VoiceParticipant {
                user_id: session.user_id,
                channel_id: session.channel_id,
                display_name,
                joined_at: session.joined_at,
            }
        })
        .collect();

    Ok((
        StatusCode::OK,
        Json(VoiceParticipantsResponse::from_participants(participants)),
    ))
}

/// Heartbeat to keep a voice session alive. Clients should call this
/// periodically (e.g. every 30s) while connected to voice.
///
/// The `session_id` in the request body must match the session created on join.
/// This prevents a stale device from keeping a replaced session alive.
///
/// # Errors
/// - 401 if not authenticated.
/// - 404 if the session does not exist (expired, replaced, or user not in voice).
/// - 503 if voice is not configured (`LiveKit` disabled).
#[utoipa::path(
    post,
    path = "/v1/voice/heartbeat",
    tag = "Voice",
    security(("bearer_auth" = [])),
    request_body = VoiceHeartbeatRequest,
    responses(
        (status = 204, description = "Heartbeat acknowledged"),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 404, description = "Session not found", body = ProblemDetails),
        (status = 503, description = "Voice not configured", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn voice_heartbeat(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    Json(body): Json<VoiceHeartbeatRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let voice_service = state.voice_service().ok_or_else(|| {
        ApiError::service_unavailable(
            "Voice Not Configured",
            "Voice channels are not available on this server. Configure LiveKit to enable voice.",
        )
    })?;

    // WHY: session_id is a UUID v4 (36 chars). Cap at 64 to prevent DoS via
    // oversized strings reaching the database layer.
    if body.session_id.len() > 64 {
        return Err(ApiError::bad_request(
            "session_id must not exceed 64 characters",
        ));
    }

    voice_service.heartbeat(&user_id, &body.session_id).await?;

    Ok(StatusCode::NO_CONTENT)
}
