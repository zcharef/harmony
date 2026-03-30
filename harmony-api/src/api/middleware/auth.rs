//! Authentication middleware (defense-in-depth).
//!
//! Verifies Supabase JWT from Authorization header, session cookie, or query
//! parameter, then injects `AuthenticatedUser` into request extensions for
//! downstream handlers.

use axum::{extract::State, middleware::Next, response::Response};

use crate::api::errors::ApiError;
use crate::api::session;
use crate::api::state::AppState;
use crate::domain::models::UserId;
use crate::infra::auth::{self, AuthenticatedUser};

/// Paths exempt from email verification.
/// WHY: Unverified users must call `sync_profile` (`/v1/auth/me`) after
/// registration to complete onboarding, so that endpoint stays accessible.
const EMAIL_EXEMPT_PATHS: &[&str] = &["/v1/auth/me"];

/// Middleware: reject unauthenticated requests.
///
/// Checks (in order):
/// 1. Session cookie (HMAC-signed, web clients)
/// 2. Authorization Bearer JWT (Supabase token, mobile/API clients)
/// 3. `access_token` query parameter (Supabase JWT, Tauri SSE fallback)
///
/// On success, injects `AuthenticatedUser` into request extensions.
///
/// # Errors
/// Returns `ApiError::unauthorized` if no valid credential is present,
/// or if the provided token fails verification.
pub async fn require_auth(
    State(state): State<AppState>,
    request: axum::extract::Request,
    next: Next,
) -> Result<Response, ApiError> {
    let (mut parts, body) = request.into_parts();

    // 1. Try session cookie first (web clients)
    if let Some(session_data) =
        session::extract_session_from_cookie(&parts.headers, &state.session_secret)
    {
        let user_id = session_data
            .uid
            .parse::<uuid::Uuid>()
            .map_err(|_| ApiError::unauthorized("Invalid session"))?;

        let user = AuthenticatedUser {
            user_id: UserId::new(user_id),
            email: None,
            role: None,
            email_verified: session_data.email_verified,
            user_metadata: None,
        };

        // WHY: email_verified is baked into the session cookie at login time.
        // If a user verifies their email later, the cookie remains stale until
        // they re-login. The client must trigger a fresh login after verification.
        if !user.email_verified && !EMAIL_EXEMPT_PATHS.contains(&parts.uri.path()) {
            return Err(ApiError::forbidden(
                "Email verification required. Please verify your email address.",
            ));
        }

        sentry::configure_scope(|scope| {
            scope.set_user(Some(sentry::protocol::User {
                id: Some(user.user_id.to_string()),
                ..Default::default()
            }));
        });

        parts.extensions.insert(user);
        let request = axum::extract::Request::from_parts(parts, body);
        return Ok(next.run(request).await);
    }

    // 2. Try Authorization Bearer header (Supabase JWT)
    // 3. Try `access_token` query parameter (Tauri SSE fallback)
    // WHY: EventSource cannot set custom headers. Tauri's webview origin
    // (tauri://localhost) is a non-HTTP custom scheme — WKWebView's ITP
    // silently drops Set-Cookie from cross-origin HTTPS responses, so the
    // session cookie never persists. The query parameter is the only viable
    // auth path for SSE in Tauri (ADR-SSE-005).
    let bearer_token = parts
        .headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .filter(|t| !t.is_empty());

    // WHY: Scoped to /v1/events only — placing JWTs in URLs exposes them in
    // server/proxy logs. Acceptable for the long-lived SSE stream (no other
    // option), but not for mutation endpoints like DELETE /members.
    let query_token = if parts.uri.path() == "/v1/events" {
        parts
            .uri
            .query()
            .into_iter()
            .flat_map(|q| q.split('&'))
            .find_map(|pair| pair.strip_prefix("access_token="))
            .filter(|t| !t.is_empty())
    } else {
        None
    };

    let token = bearer_token.or(query_token).ok_or_else(|| {
        ApiError::unauthorized(
            "Missing or invalid authentication. Provide session cookie or Bearer token.",
        )
    })?;

    let user = auth::verify_supabase_jwt(token, &state.jwt_secret, state.es256_key.as_ref())
        .map_err(|e| {
            tracing::warn!(error = %e, "JWT verification failed");
            ApiError::unauthorized("Invalid or expired token")
        })?;

    // WHY: Same email verification gate as the session cookie path above.
    if !user.email_verified && !EMAIL_EXEMPT_PATHS.contains(&parts.uri.path()) {
        return Err(ApiError::forbidden(
            "Email verification required. Please verify your email address.",
        ));
    }

    sentry::configure_scope(|scope| {
        scope.set_user(Some(sentry::protocol::User {
            id: Some(user.user_id.to_string()),
            email: user.email.clone(),
            ..Default::default()
        }));
    });

    parts.extensions.insert(user);
    let request = axum::extract::Request::from_parts(parts, body);
    Ok(next.run(request).await)
}
