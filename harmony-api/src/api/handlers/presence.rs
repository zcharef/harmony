//! Presence handlers.

use std::time::Duration;

use axum::{extract::State, http::StatusCode, response::IntoResponse};
use serde::Deserialize;
use utoipa::ToSchema;

use crate::api::errors::{ApiError, ProblemDetails};
use crate::api::extractors::{ApiJson, AuthUser};
use crate::api::state::AppState;
use crate::domain::models::{ServerEvent, UserStatus};

/// Maximum presence updates per user within [`PRESENCE_RATE_WINDOW`].
const PRESENCE_RATE_MAX: usize = 10;

/// Window for the per-user presence rate limit.
const PRESENCE_RATE_WINDOW: Duration = Duration::from_secs(60);

/// Request body for updating presence status.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdatePresenceRequest {
    /// User-settable status. Must be one of: `online`, `idle`, `dnd`.
    /// `offline` is system-managed (set on disconnect) and cannot be set via this endpoint.
    pub status: UserStatus,
}

/// Update the authenticated user's presence status.
///
/// Validates that the requested status is user-settable (not `offline`),
/// then emits a `PresenceChanged` event via the event bus so other
/// connected users receive the update through SSE.
///
/// # Errors
/// Returns `ApiError` on invalid status value or when the per-user
/// presence rate limit is exceeded.
#[utoipa::path(
    post,
    path = "/v1/presence",
    tag = "Presence",
    security(("bearer_auth" = [])),
    request_body = UpdatePresenceRequest,
    responses(
        (status = 204, description = "Presence updated"),
        (status = 400, description = "Invalid status (e.g. 'offline' is system-managed)", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 422, description = "Unprocessable request body", body = ProblemDetails),
        (status = 429, description = "Presence rate limit exceeded", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn update_presence(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiJson(req): ApiJson<UpdatePresenceRequest>,
) -> Result<impl IntoResponse, ApiError> {
    // WHY: `offline` is set by the system on SSE disconnect (with grace period).
    // Allowing clients to set it would conflict with connection lifecycle management.
    if req.status == UserStatus::Offline {
        return Err(ApiError::bad_request(
            "Cannot set status to 'offline' — it is managed by the server on disconnect",
        ));
    }

    // WHY: Each update fans out a PresenceChanged event to every user sharing
    // a server/DM — a per-user cap keeps a misbehaving client from flooding the bus.
    // Legitimate use is a few manual status changes per minute at most.
    state.spam_guard().check_and_record_action(
        &user_id,
        "presence",
        PRESENCE_RATE_MAX,
        PRESENCE_RATE_WINDOW,
    )?;

    state
        .presence_tracker()
        .set_status(&user_id, req.status.clone());

    // WHY: Routing metadata so the SSE layer delivers this only to users
    // sharing a server or DM with the subject (redacted before it reaches
    // clients). Queried here because the handler, unlike the SSE stream, has
    // no live membership snapshot.
    // WHY fail-open (not `?`): set_status above already mutated the tracker —
    // failing the request here would leave the status changed but the event
    // unpublished. Empty metadata = broadcast fallback, same pattern as the
    // presence sweep (ADR-027: never silently lose the signal).
    let server_ids = match state.server_service().list_all_memberships(&user_id).await {
        Ok(ids) => ids,
        Err(e) => {
            tracing::warn!(
                error = %e,
                "presence update: membership lookup failed — broadcasting unscoped presence event"
            );
            Vec::new()
        }
    };

    let event = ServerEvent::PresenceChanged {
        sender_id: user_id.clone(),
        user_id,
        status: req.status,
        server_ids,
    };
    state.event_bus().publish(event);

    Ok(StatusCode::NO_CONTENT)
}
