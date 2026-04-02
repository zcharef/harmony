//! Presence handlers.

use axum::{extract::State, http::StatusCode, response::IntoResponse};
use serde::Deserialize;
use utoipa::ToSchema;

use crate::api::errors::{ApiError, ProblemDetails};
use crate::api::extractors::{ApiJson, AuthUser};
use crate::api::state::AppState;
use crate::domain::models::{ServerEvent, UserStatus};

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
/// Returns `ApiError` on invalid status value.
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

    state
        .presence_tracker()
        .set_status(&user_id, req.status.clone());

    let event = ServerEvent::PresenceChanged {
        sender_id: user_id.clone(),
        user_id,
        status: req.status,
    };
    state.event_bus().publish(event);

    Ok(StatusCode::NO_CONTENT)
}
