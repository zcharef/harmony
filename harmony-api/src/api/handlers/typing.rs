//! Typing indicator handler.
//!
//! Ephemeral relay — no database write. Client POSTs when user starts
//! typing; server emits `TypingStarted` via `EventBus` so other channel
//! members see the indicator in their SSE stream.

use std::time::Duration;

use axum::{extract::State, http::StatusCode, response::IntoResponse};

use crate::api::errors::{ApiError, ProblemDetails};
use crate::api::extractors::{ApiPath, AuthUser};
use crate::api::state::AppState;
use crate::domain::models::{ChannelId, ServerEvent};

/// Maximum typing signals per user within [`TYPING_RATE_WINDOW`].
const TYPING_RATE_MAX: usize = 15;

/// Window for the per-user typing rate limit.
const TYPING_RATE_WINDOW: Duration = Duration::from_secs(10);

/// Signal that the authenticated user is typing in a channel.
///
/// Validates channel existence and server membership, then emits a
/// `TypingStarted` event via the event bus. No database write — purely
/// ephemeral relay.
///
/// # Errors
/// Returns `ApiError` if the channel is not found, the user is not a
/// member, the per-user typing rate limit is exceeded, or the profile
/// lookup fails.
#[utoipa::path(
    post,
    path = "/v1/channels/{id}/typing",
    tag = "Events",
    security(("bearer_auth" = [])),
    params(("id" = ChannelId, Path, description = "Channel ID")),
    responses(
        (status = 204, description = "Typing event relayed"),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Not a server member", body = ProblemDetails),
        (status = 404, description = "Channel not found", body = ProblemDetails),
        (status = 429, description = "Typing rate limit exceeded", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn send_typing(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(channel_id): ApiPath<ChannelId>,
) -> Result<impl IntoResponse, ApiError> {
    // WHY: Need channel to get server_id for the event envelope + membership check.
    let channel = state.channel_service().get_by_id(&channel_id).await?;

    let is_member = state
        .member_repository()
        .is_member(&channel.server_id, &user_id)
        .await?;
    if !is_member {
        return Err(ApiError::forbidden(
            "You must be a server member to send typing indicators",
        ));
    }

    // WHY: Typing is fire-and-forget with no DB write — without a per-user cap
    // a client could flood the event bus. Per-IP limiting is Cloudflare's job
    // (see router.rs); this is the application-level per-user cap.
    state.spam_guard().check_and_record_action(
        &user_id,
        "typing",
        TYPING_RATE_MAX,
        TYPING_RATE_WINDOW,
    )?;

    // WHY: TypingStarted carries the username so clients don't need an extra lookup.
    let profile = state.profile_service().get_by_id(&user_id).await?;

    let receivers = state.event_bus().publish(ServerEvent::TypingStarted {
        sender_id: user_id,
        server_id: channel.server_id,
        channel_id,
        username: profile.username,
    });
    tracing::debug!(receivers, "emitted typing.started");

    Ok(StatusCode::NO_CONTENT)
}
