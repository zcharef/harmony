//! HTTP router with middleware stack.

use std::time::Duration;

use axum::{
    Router,
    http::{HeaderValue, Method, header},
    middleware,
    routing::{get, patch, post},
};
use sentry::integrations::tower::{NewSentryLayer, SentryHttpLayer};
use tower_http::{
    compression::CompressionLayer,
    cors::{AllowOrigin, CorsLayer},
    limit::RequestBodyLimitLayer,
    request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer},
    set_header::SetResponseHeaderLayer,
    timeout::TimeoutLayer,
    trace::TraceLayer,
};
use utoipa::OpenApi;
use utoipa_swagger_ui::SwaggerUi;

use super::handlers;
use super::middleware::rate_limit::RateLimitLayer;
use super::openapi::ApiDoc;
use super::state::AppState;

/// Build the main application router with production middleware stack.
///
/// Layers are applied in reverse order of declaration:
/// ```text
/// Request  → SentryHub → RequestId → Tracing → Timeout → BodyLimit → Handler
/// Response ← Compression ← SecurityHeaders ← CORS ← Handler
/// ```
#[allow(deprecated)] // TimeoutLayer::new is deprecated; upgrade when tower-http 0.7 releases
pub fn build_router(state: AppState) -> Router {
    let request_id_header = header::HeaderName::from_static("x-request-id");

    let cors = CorsLayer::new()
        .allow_origin(if state.is_production {
            AllowOrigin::list([
                // SAFETY: hardcoded valid header value
                HeaderValue::from_static("https://harmony.app"),
            ])
        } else {
            AllowOrigin::mirror_request()
        })
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION, header::ACCEPT])
        .allow_credentials(true);

    // ── Authenticated v1 routes ───────────
    let v1_routes = Router::new()
        // Auth
        .route("/v1/auth/me", post(handlers::profiles::sync_profile))
        // Profiles
        .route("/v1/profiles/me", get(handlers::profiles::get_my_profile))
        // Servers
        .route(
            "/v1/servers",
            post(handlers::servers::create_server).get(handlers::servers::list_servers),
        )
        .route("/v1/servers/{id}", get(handlers::servers::get_server))
        .route(
            "/v1/servers/{id}/channels",
            post(handlers::channels::create_channel).get(handlers::channels::list_channels),
        )
        .route(
            "/v1/servers/{id}/channels/{channel_id}",
            patch(handlers::channels::update_channel).delete(handlers::channels::delete_channel),
        )
        // Invites
        .route(
            "/v1/servers/{id}/invites",
            post(handlers::invites::create_invite),
        )
        // Members (join + list)
        .route(
            "/v1/servers/{id}/members",
            post(handlers::invites::join_server).get(handlers::members::list_members),
        )
        // Messages
        .route(
            "/v1/channels/{id}/messages",
            post(handlers::messages::send_message).get(handlers::messages::list_messages),
        )
        .route(
            "/v1/channels/{channel_id}/messages/{message_id}",
            patch(handlers::messages::edit_message).delete(handlers::messages::delete_message),
        )
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            super::middleware::auth::require_auth,
        ));

    // ── Public v1 routes (no auth required) ───────────
    let public_routes =
        Router::new().route("/v1/invites/{code}", get(handlers::invites::preview_invite));

    Router::new()
        // Swagger UI
        .merge(SwaggerUi::new("/swagger-ui").url("/api-docs/openapi.json", ApiDoc::openapi()))
        // System endpoints
        .route("/health", get(handlers::health_check))
        // Public API routes (no auth)
        .merge(public_routes)
        // Versioned API routes (auth-protected)
        .merge(v1_routes)
        .with_state(state)
        .fallback(handlers::not_found_fallback)
        // Middleware layers (applied in REVERSE order - last declared = runs first)
        .layer(SetResponseHeaderLayer::overriding(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::X_FRAME_OPTIONS,
            HeaderValue::from_static("DENY"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::STRICT_TRANSPORT_SECURITY,
            HeaderValue::from_static("max-age=63072000; includeSubDomains; preload"),
        ))
        .layer(cors)
        .layer(CompressionLayer::new())
        .layer(RateLimitLayer::new(60, 300))
        .layer(RequestBodyLimitLayer::new(2 * 1024 * 1024))
        .layer(TimeoutLayer::new(Duration::from_secs(30)))
        .layer(TraceLayer::new_for_http())
        .layer(PropagateRequestIdLayer::new(request_id_header.clone()))
        .layer(SetRequestIdLayer::new(request_id_header, MakeRequestUuid))
        .layer(SentryHttpLayer::default().enable_transaction())
        .layer(NewSentryLayer::new_from_top())
}
