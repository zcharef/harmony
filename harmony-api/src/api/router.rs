//! HTTP router with middleware stack.

use std::time::Duration;

use axum::{
    Router,
    http::{HeaderValue, Method, header},
    middleware,
    routing::{delete, get, patch, post},
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
use super::openapi::ApiDoc;
use super::state::AppState;

/// Build the main application router with production middleware stack.
///
/// Layers are applied in reverse order of declaration:
/// ```text
/// Request  → SentryHub → RequestId → Tracing → Timeout → BodyLimit → CORS → Handler
/// Response ← SecurityHeaders(X-Content-Type-Options, X-Frame-Options, HSTS, CSP, Referrer-Policy, Permissions-Policy) ← Compression ← CORS ← Handler
/// ```
///
/// Per-IP rate limiting is handled at the edge (Cloudflare) rather than in the
/// application. Per-user business rate limits (message flooding, DM creation,
/// spam guard) remain in the service layer.
#[allow(deprecated)] // TimeoutLayer::new is deprecated; upgrade when tower-http 0.7 releases
pub fn build_router(state: AppState, livekit_url: Option<&str>) -> Router {
    let is_production = state.is_production;
    let request_id_header = header::HeaderName::from_static("x-request-id");

    let cors = CorsLayer::new()
        .allow_origin(if state.is_production {
            AllowOrigin::list([
                HeaderValue::from_static("https://app.joinharmony.app"),
                HeaderValue::from_static("https://joinharmony.app"),
                // WHY: Tauri v2 webview origin differs by platform:
                //   - macOS/Linux: tauri://localhost  (custom scheme)
                //   - Windows:     https://tauri.localhost (secure context requirement)
                // WebView2 uses https://tauri.localhost because it needs a secure context
                // for Web APIs (crypto.subtle, fetch credentials, etc.) and custom URI
                // schemes don't qualify on Windows. Both http:// and https:// variants
                // are allowed because the exact scheme depends on the Tauri/WebView2 version.
                // Ref: https://github.com/tauri-apps/tauri/issues/3007
                HeaderValue::from_static("tauri://localhost"),
                HeaderValue::from_static("https://tauri.localhost"),
                HeaderValue::from_static("http://tauri.localhost"),
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
        .allow_headers([
            header::CONTENT_TYPE,
            header::AUTHORIZATION,
            header::ACCEPT,
            // WHY: The frontend generates a UUID per request and sends it as
            // x-request-id. SetRequestIdLayer respects client-provided IDs,
            // enabling end-to-end correlation between Sentry breadcrumbs and
            // backend structured logs.
            request_id_header.clone(),
        ])
        // WHY: Expose x-request-id in responses so the browser JS can read it
        // via response.headers.get(). Without this, CORS hides custom headers.
        .expose_headers([request_id_header.clone()])
        .allow_credentials(true);

    // ── Authenticated v1 routes ───────────
    let v1_routes = Router::new()
        // SSE event stream (must be before body-limited routes)
        .route("/v1/events", get(handlers::events::sse_events))
        // Auth
        .route("/v1/auth/me", post(handlers::profiles::sync_profile))
        // Profiles
        .route(
            "/v1/profiles/me",
            get(handlers::profiles::get_my_profile).patch(handlers::profiles::update_my_profile),
        )
        // Servers
        .route(
            "/v1/servers",
            post(handlers::servers::create_server).get(handlers::servers::list_servers),
        )
        .route(
            "/v1/servers/{id}",
            get(handlers::servers::get_server)
                .patch(handlers::servers::update_server)
                .delete(handlers::servers::delete_server),
        )
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
        // Members (join + list + leave + kick + role assignment)
        .route(
            "/v1/servers/{id}/members",
            post(handlers::invites::join_server).get(handlers::members::list_members),
        )
        .route(
            "/v1/servers/{id}/leave",
            post(handlers::members::leave_server),
        )
        .route(
            "/v1/servers/{id}/members/{user_id}",
            delete(handlers::members::kick_member),
        )
        .route(
            "/v1/servers/{id}/members/{user_id}/role",
            patch(handlers::members::assign_role),
        )
        // Ownership transfer
        .route(
            "/v1/servers/{id}/transfer-ownership",
            post(handlers::members::transfer_ownership),
        )
        // Bans (moderation)
        .route(
            "/v1/servers/{id}/bans",
            post(handlers::bans::ban_member).get(handlers::bans::list_bans),
        )
        .route(
            "/v1/servers/{id}/bans/{user_id}",
            delete(handlers::bans::unban_member),
        )
        // Moderation Settings
        .route(
            "/v1/servers/{id}/moderation",
            get(handlers::moderation_settings::get_moderation_settings)
                .patch(handlers::moderation_settings::update_moderation_settings),
        )
        // Megolm sessions (E2EE channel encryption)
        .route(
            "/v1/channels/{id}/megolm-sessions",
            post(handlers::channels::create_megolm_session),
        )
        // Read States
        .route(
            "/v1/channels/{id}/read-state",
            patch(handlers::read_states::mark_channel_read),
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
        // Reactions
        .route(
            "/v1/channels/{channel_id}/messages/{message_id}/reactions",
            post(handlers::reactions::add_reaction),
        )
        .route(
            "/v1/channels/{channel_id}/messages/{message_id}/reactions/{emoji}",
            delete(handlers::reactions::remove_reaction),
        )
        // Notification Settings
        .route(
            "/v1/channels/{id}/notification-settings",
            get(handlers::notification_settings::get_notification_settings)
                .patch(handlers::notification_settings::update_notification_settings),
        )
        // Voice channels
        .route(
            "/v1/channels/{id}/voice/join",
            post(handlers::voice::join_voice),
        )
        .route(
            "/v1/channels/{id}/voice/leave",
            post(handlers::voice::leave_voice),
        )
        .route(
            "/v1/channels/{id}/voice/participants",
            get(handlers::voice::list_voice_participants),
        )
        .route(
            "/v1/voice/refresh-token",
            post(handlers::voice::refresh_voice_token),
        )
        .route(
            "/v1/voice/heartbeat",
            post(handlers::voice::voice_heartbeat),
        )
        .route(
            "/v1/voice/state",
            patch(handlers::voice::update_voice_state),
        )
        // Typing indicators
        .route(
            "/v1/channels/{id}/typing",
            post(handlers::typing::send_typing),
        )
        // Direct Messages
        .route(
            "/v1/dms",
            post(handlers::dms::create_dm).get(handlers::dms::list_dms),
        )
        .route("/v1/dms/{server_id}", delete(handlers::dms::close_dm))
        // User Preferences
        .route(
            "/v1/preferences",
            get(handlers::user_preferences::get_preferences)
                .patch(handlers::user_preferences::update_preferences),
        )
        // Presence
        .route("/v1/presence", post(handlers::presence::update_presence))
        // E2EE Key Distribution
        .route("/v1/keys/device", post(handlers::keys::register_device))
        .route(
            "/v1/keys/one-time",
            post(handlers::keys::upload_one_time_keys),
        )
        .route(
            "/v1/keys/bundle/{user_id}",
            get(handlers::keys::get_pre_key_bundle),
        )
        .route(
            "/v1/keys/devices/{user_id}",
            get(handlers::keys::list_devices),
        )
        .route(
            "/v1/keys/device/{device_id}",
            delete(handlers::keys::remove_device),
        )
        .route("/v1/keys/count", get(handlers::keys::get_key_count))
        // Desktop auth (PKCE exchange — browser creates code, desktop redeems it)
        .route(
            "/v1/auth/desktop-exchange/create",
            post(handlers::desktop_auth::create_desktop_auth_code),
        )
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            super::middleware::auth::require_auth,
        ));

    // ── Public v1 routes (no auth required) ───────────
    let public_routes = Router::new()
        .route("/v1/invites/{code}", get(handlers::invites::preview_invite))
        .route(
            "/v1/auth/check-username",
            get(handlers::profiles::check_username),
        )
        // Desktop auth redemption (public — the desktop app has no session yet)
        .route(
            "/v1/auth/desktop-exchange/redeem",
            post(handlers::desktop_auth::redeem_desktop_auth_code),
        );

    let mut router = Router::new();

    // Swagger UI — disabled in production to avoid exposing API surface
    if !state.is_production {
        router = router
            .merge(SwaggerUi::new("/swagger-ui").url("/api-docs/openapi.json", ApiDoc::openapi()));
    }

    let mut router = router
        // System endpoints
        .route("/health", get(handlers::health_check))
        .route("/health/live", get(handlers::liveness_check))
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
        ));

    // WHY: CSP `default-src 'none'` blocks all resource loading (JS, CSS, fetch).
    // Swagger UI needs these in development mode. Only enforce in production.
    // WHY connect-src: LiveKit voice requires WebSocket connections. Instead of a
    // wildcard `wss://*.livekit.cloud`, we derive the exact host from the configured
    // LIVEKIT_URL. Dev gets `ws://localhost:7880`; production gets only the explicit host.
    if is_production {
        let mut connect_src = String::from("'self'");

        if let Some(url) = livekit_url
            && let Some(host) = url
                .strip_prefix("wss://")
                .or_else(|| url.strip_prefix("ws://"))
                .or_else(|| url.strip_prefix("https://"))
                .or_else(|| url.strip_prefix("http://"))
        {
            let host = host.trim_end_matches('/').split('/').next().unwrap_or(host);
            connect_src.push_str(&format!(" wss://{host}"));
        }

        let csp = format!("default-src 'none'; frame-ancestors 'none'; connect-src {connect_src}");
        if let Ok(val) = HeaderValue::from_str(&csp) {
            router = router.layer(SetResponseHeaderLayer::overriding(
                header::HeaderName::from_static("content-security-policy"),
                val,
            ));
        }
    } else if let Some(url) = livekit_url {
        // WHY: In development, add both the configured LiveKit host and localhost
        // for local LiveKit dev server.
        let mut connect_src = String::from("'self' ws://localhost:7880");

        if let Some(host) = url
            .strip_prefix("wss://")
            .or_else(|| url.strip_prefix("ws://"))
            .or_else(|| url.strip_prefix("https://"))
            .or_else(|| url.strip_prefix("http://"))
        {
            let host = host.trim_end_matches('/').split('/').next().unwrap_or(host);
            connect_src.push_str(&format!(" wss://{host}"));
        }

        let csp = format!("default-src 'none'; frame-ancestors 'none'; connect-src {connect_src}");
        if let Ok(val) = HeaderValue::from_str(&csp) {
            router = router.layer(SetResponseHeaderLayer::overriding(
                header::HeaderName::from_static("content-security-policy"),
                val,
            ));
        }
    }

    router
        .layer(SetResponseHeaderLayer::overriding(
            header::HeaderName::from_static("referrer-policy"),
            HeaderValue::from_static("no-referrer"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::HeaderName::from_static("permissions-policy"),
            HeaderValue::from_static("interest-cohort=()"),
        ))
        .layer(CompressionLayer::new())
        .layer(cors)
        .layer(RequestBodyLimitLayer::new(2 * 1024 * 1024))
        .layer(TimeoutLayer::new(Duration::from_secs(30)))
        .layer(TraceLayer::new_for_http())
        .layer(PropagateRequestIdLayer::new(request_id_header.clone()))
        .layer(SetRequestIdLayer::new(request_id_header, MakeRequestUuid))
        .layer(SentryHttpLayer::default().enable_transaction())
        .layer(NewSentryLayer::new_from_top())
}
