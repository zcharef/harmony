//! HTTP handlers for API endpoints.

pub mod bans;
pub mod channels;
pub mod desktop_auth;
pub mod dms;
pub mod events;
pub mod invites;
pub mod keys;
pub mod members;
pub mod messages;
pub mod moderation_settings;
pub mod notification_settings;
pub mod presence;
pub mod profiles;
pub mod reactions;
pub mod read_states;
pub mod servers;
pub mod typing;
pub mod user_preferences;

use std::time::Instant;

use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};
use serde::Serialize;
use utoipa::ToSchema;

use crate::api::state::AppState;
use crate::domain::models::server_event::{MessagePayload, ServerEvent};
use crate::domain::models::{ServerId, UserId};
use crate::infra::postgres;

/// Fallback handler for unmatched routes.
///
/// Returns a 404 RFC 9457 `ProblemDetails` response instead of Axum's default empty body.
pub async fn not_found_fallback() -> crate::api::errors::ApiError {
    crate::api::errors::ApiError::not_found("The requested resource was not found")
}

/// Liveness probe response.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct LivenessResponse {
    /// Always `"ok"` when the process is alive.
    pub status: &'static str,
}

impl LivenessResponse {
    #[must_use]
    pub fn ok() -> Self {
        Self { status: "ok" }
    }
}

/// Liveness probe — confirms the process is running and can serve HTTP.
///
/// No dependency checks (DB, cache, etc.). Use `/health` for deep readiness.
#[utoipa::path(
    get,
    path = "/health/live",
    tag = "System",
    responses(
        (status = 200, description = "Process is alive", body = LivenessResponse)
    )
)]
#[tracing::instrument]
pub async fn liveness_check() -> impl IntoResponse {
    Json(LivenessResponse::ok())
}

/// Deep health check response with component status.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct HealthResponse {
    /// Overall service status: "up" or "down"
    pub status: &'static str,
    /// Individual component health
    pub components: ComponentHealth,
    /// Time taken for health check in milliseconds
    pub latency_ms: u64,
    /// API version from Cargo.toml
    pub version: &'static str,
}

/// Health status of individual components.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ComponentHealth {
    /// Database connectivity: "connected", "disconnected", or error detail
    pub database: String,
    /// API server status (always "operational" if responding)
    pub api: &'static str,
}

/// Deep health check endpoint.
#[utoipa::path(
    get,
    path = "/health",
    tag = "System",
    responses(
        (status = 200, description = "Service is healthy", body = HealthResponse),
        (status = 503, description = "Service degraded", body = HealthResponse)
    )
)]
pub async fn health_check(State(state): State<AppState>) -> impl IntoResponse {
    let start = Instant::now();

    let db_status = match postgres::ping(state.pool()).await {
        Ok(()) => "connected".to_string(),
        Err(e) => {
            tracing::warn!(error = %e, "Database ping failed");
            "disconnected".to_string()
        }
    };

    let is_healthy = db_status == "connected";
    let latency_ms = u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX);

    let response = HealthResponse {
        status: if is_healthy { "up" } else { "down" },
        components: ComponentHealth {
            database: db_status,
            api: "operational",
        },
        latency_ms,
        version: env!("CARGO_PKG_VERSION"),
    };

    let status_code = if is_healthy {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };

    (status_code, Json(response))
}

/// Post a system message in the server's default channel and emit SSE.
///
/// WHY shared: Used by join (invites.rs), leave/kick (members.rs), and ban (bans.rs).
/// Best-effort — callers should catch errors and log, never propagate.
///
/// `sender_id` is set to `subject_user_id` (the user who joined/was kicked/banned/left).
/// This leverages the SSE sender-exclusion filter: the subject won't receive their
/// own system message via SSE (for join: they fetch on load; for kick/ban/leave:
/// they're already disconnected via `ForceDisconnect`).
///
/// # Errors
/// Returns `anyhow::Error` if the default channel lookup or message creation fails.
#[tracing::instrument(skip(state))]
pub async fn post_system_message(
    state: &AppState,
    server_id: &ServerId,
    subject_user_id: &UserId,
    system_event_key: &str,
) -> anyhow::Result<()> {
    let channel = state
        .channel_service()
        .find_default_for_server(server_id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("No default channel found for server {server_id}"))?;

    let message = state
        .message_service()
        .create_system_message(&channel.id, subject_user_id, system_event_key.to_string())
        .await?;

    let event = ServerEvent::MessageCreated {
        sender_id: subject_user_id.clone(),
        server_id: server_id.clone(),
        channel_id: channel.id.clone(),
        message: MessagePayload::from(message),
    };
    let receivers = state.event_bus().publish(event);
    tracing::debug!(
        server_id = %server_id,
        subject_user_id = %subject_user_id,
        system_event_key,
        receivers,
        "emitted message.created for system message"
    );

    Ok(())
}
