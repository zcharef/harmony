//! GIF picker handlers — a thin authenticated proxy over the Klipy API.
//!
//! The upstream key stays server-side (see [`crate::infra::klipy`]); the client
//! only ever talks to these two endpoints. Two rate limits guard the shared
//! upstream budget: a per-user `SpamGuard` limit here, and a process-global
//! rolling window inside `KlipyClient`.

use std::time::Duration;

use axum::{Json, extract::Query, extract::State, http::StatusCode, response::IntoResponse};

use crate::api::dto::{GifListResponse, GifSearchQuery, GifTrendingQuery};
use crate::api::errors::{ApiError, ProblemDetails};
use crate::api::extractors::AuthUser;
use crate::api::state::AppState;
use crate::infra::klipy::KlipyError;

/// Per-user rate limit for GIF calls: max actions per window.
const GIF_RATE_MAX: usize = 30;
const GIF_RATE_WINDOW: Duration = Duration::from_secs(60);

/// Server-side page clamp (Klipy pagination is 1-based).
const MIN_PAGE: u32 = 1;
const MAX_PAGE: u32 = 50;

fn clamp_page(page: Option<u32>) -> u32 {
    page.unwrap_or(MIN_PAGE).clamp(MIN_PAGE, MAX_PAGE)
}

/// `503` returned when `KLIPY_API_KEY` is unset — the client reads this to hide
/// the GIF button (feature disabled), so self-hosters never see a dead button.
fn klipy_unavailable() -> ApiError {
    ApiError::service_unavailable("GIF Picker Unavailable", "GIF picker is not configured")
}

/// Map a Klipy client error to an `ApiError`.
///
/// Budget exhaustion is a transient capacity limit (`503`); every other upstream
/// failure is a bad-gateway (`502`). The upstream body is never leaked to the
/// client (it was already logged at `error!` for the operator).
fn map_klipy_error(err: &KlipyError) -> ApiError {
    match err {
        KlipyError::BudgetExhausted => ApiError::service_unavailable(
            "GIF Picker Unavailable",
            "GIF search is temporarily rate-limited, try again shortly",
        ),
        KlipyError::Http(_)
        | KlipyError::ServerError(_)
        | KlipyError::ClientError { .. }
        | KlipyError::RetriesExhausted => ApiError::bad_gateway("GIF provider is unavailable"),
    }
}

/// Search GIFs (Klipy proxy).
///
/// # Errors
/// `400` empty query, `401` unauthorized, `429` per-user rate limit,
/// `502` upstream failure, `503` feature disabled or global budget exhausted.
#[utoipa::path(
    get,
    path = "/v1/gifs/search",
    tag = "Gifs",
    security(("bearer_auth" = [])),
    params(GifSearchQuery),
    responses(
        (status = 200, description = "GIF search results", body = GifListResponse),
        (status = 400, description = "Empty query", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 429, description = "Rate limit exceeded", body = ProblemDetails),
        (status = 502, description = "Upstream GIF provider failure", body = ProblemDetails),
        (status = 503, description = "GIF picker unavailable", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn search_gifs(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    Query(query): Query<GifSearchQuery>,
) -> Result<impl IntoResponse, ApiError> {
    // WHY reject empty before touching Klipy: an empty search wastes the shared
    // global budget and returns nothing useful.
    let q = query.q.trim();
    if q.is_empty() {
        return Err(ApiError::bad_request("Search query must not be empty"));
    }

    state.spam_guard().check_and_record_action(
        &user_id,
        "gif_search",
        GIF_RATE_MAX,
        GIF_RATE_WINDOW,
    )?;

    let klipy = state.klipy().ok_or_else(klipy_unavailable)?;
    let page = klipy
        .search(q, clamp_page(query.page))
        .await
        .map_err(|e| map_klipy_error(&e))?;

    Ok((StatusCode::OK, Json(GifListResponse::from(page))))
}

/// Trending GIFs (Klipy proxy).
///
/// # Errors
/// `401` unauthorized, `429` per-user rate limit, `502` upstream failure,
/// `503` feature disabled or global budget exhausted.
#[utoipa::path(
    get,
    path = "/v1/gifs/trending",
    tag = "Gifs",
    security(("bearer_auth" = [])),
    params(GifTrendingQuery),
    responses(
        (status = 200, description = "Trending GIFs", body = GifListResponse),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 429, description = "Rate limit exceeded", body = ProblemDetails),
        (status = 502, description = "Upstream GIF provider failure", body = ProblemDetails),
        (status = 503, description = "GIF picker unavailable", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn trending_gifs(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    Query(query): Query<GifTrendingQuery>,
) -> Result<impl IntoResponse, ApiError> {
    state.spam_guard().check_and_record_action(
        &user_id,
        "gif_trending",
        GIF_RATE_MAX,
        GIF_RATE_WINDOW,
    )?;

    let klipy = state.klipy().ok_or_else(klipy_unavailable)?;
    let page = klipy
        .trending(clamp_page(query.page))
        .await
        .map_err(|e| map_klipy_error(&e))?;

    Ok((StatusCode::OK, Json(GifListResponse::from(page))))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn clamp_page_defaults_and_bounds() {
        assert_eq!(clamp_page(None), 1);
        assert_eq!(clamp_page(Some(0)), 1);
        assert_eq!(clamp_page(Some(3)), 3);
        assert_eq!(clamp_page(Some(9999)), 50);
    }

    #[test]
    fn budget_exhausted_maps_to_503() {
        let err = map_klipy_error(&KlipyError::BudgetExhausted);
        assert_eq!(err.status, StatusCode::SERVICE_UNAVAILABLE);
    }

    #[test]
    fn upstream_failures_map_to_502_without_leaking_body() {
        let err = map_klipy_error(&KlipyError::ClientError {
            status: 401,
            body: "secret upstream detail".to_string(),
        });
        assert_eq!(err.status, StatusCode::BAD_GATEWAY);
        // The upstream body must never reach the client.
        assert!(!err.problem.detail.contains("secret upstream detail"));

        assert_eq!(
            map_klipy_error(&KlipyError::ServerError(503)).status,
            StatusCode::BAD_GATEWAY
        );
        assert_eq!(
            map_klipy_error(&KlipyError::RetriesExhausted).status,
            StatusCode::BAD_GATEWAY
        );
    }
}
