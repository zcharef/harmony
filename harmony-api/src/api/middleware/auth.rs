//! Authentication middleware (defense-in-depth).
//!
//! Verifies Supabase JWT from Authorization header or session cookie,
//! then injects `AuthenticatedUser` into request extensions for downstream handlers.

use axum::{extract::State, middleware::Next, response::Response};

use crate::api::errors::ApiError;
use crate::api::session;
use crate::api::state::AppState;
use crate::domain::models::UserId;
use crate::infra::auth::{self, AuthenticatedUser};

/// Middleware: reject unauthenticated requests.
///
/// Checks (in order):
/// 1. Session cookie (HMAC-signed, web clients)
/// 2. Authorization Bearer JWT (Supabase token, mobile/API clients)
///
/// On success, injects `AuthenticatedUser` into request extensions.
///
/// # Errors
/// Returns `ApiError::unauthorized` if no valid session cookie or Bearer JWT is present,
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
        };

        // WHY: Unverified users must not access protected resources, but
        // `/v1/auth/me` (sync_profile) is exempt so they can sync after registration.
        if !user.email_verified && parts.uri.path() != "/v1/auth/me" {
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
    let token = parts
        .headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .filter(|t| !t.is_empty())
        .ok_or_else(|| {
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
    if !user.email_verified && parts.uri.path() != "/v1/auth/me" {
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
