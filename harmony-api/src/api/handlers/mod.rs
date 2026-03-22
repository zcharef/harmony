//! HTTP handlers for API endpoints.

pub mod bans;
pub mod channels;
pub mod dms;
pub mod invites;
pub mod members;
pub mod messages;
pub mod profiles;
pub mod servers;

use std::time::Instant;

use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};
use serde::Serialize;
use utoipa::ToSchema;

use crate::api::state::AppState;
use crate::infra::postgres;

/// Fallback handler for unmatched routes.
///
/// Returns a 404 RFC 9457 `ProblemDetails` response instead of Axum's default empty body.
pub async fn not_found_fallback() -> crate::api::errors::ApiError {
    crate::api::errors::ApiError::not_found("The requested resource was not found")
}

/// Deep health check response with component status.
#[derive(Debug, Serialize, ToSchema)]
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

    let db_status = match postgres::ping(&state.pool).await {
        Ok(()) => "connected".to_string(),
        Err(e) => {
            tracing::warn!(error = %e, "Database ping failed");
            format!("disconnected: {}", e)
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
