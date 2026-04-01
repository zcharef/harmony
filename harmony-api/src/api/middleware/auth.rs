//! Authentication middleware — Bearer JWT only.
//!
//! Verifies Supabase JWT from the `Authorization: Bearer <token>` header,
//! then injects `AuthenticatedUser` into request extensions for downstream
//! handlers.

use axum::{extract::State, middleware::Next, response::Response};

use crate::api::errors::ApiError;
use crate::api::state::AppState;
use crate::infra::auth;

/// Paths exempt from email verification.
/// WHY: Unverified users must call `sync_profile` (`/v1/auth/me`) after
/// registration to complete onboarding, so that endpoint stays accessible.
const EMAIL_EXEMPT_PATHS: &[&str] = &["/v1/auth/me"];

/// Middleware: reject unauthenticated requests.
///
/// Extracts the Supabase JWT from the `Authorization: Bearer <token>` header,
/// verifies it, and injects `AuthenticatedUser` into request extensions.
///
/// # Errors
/// - 401 if the header is missing, malformed, or the token is invalid/expired.
/// - 403 if the user's email is not verified (except for exempt paths).
pub async fn require_auth(
    State(state): State<AppState>,
    request: axum::extract::Request,
    next: Next,
) -> Result<Response, ApiError> {
    let (mut parts, body) = request.into_parts();

    let auth_header = parts
        .headers
        .get(axum::http::header::AUTHORIZATION)
        .ok_or_else(|| ApiError::unauthorized("Missing Authorization header"))?
        .to_str()
        .map_err(|_| {
            ApiError::unauthorized("Invalid Authorization header format, expected: Bearer <token>")
        })?;

    let token = auth_header.strip_prefix("Bearer ").ok_or_else(|| {
        ApiError::unauthorized("Invalid Authorization header format, expected: Bearer <token>")
    })?;

    if token.is_empty() {
        return Err(ApiError::unauthorized(
            "Invalid Authorization header format, expected: Bearer <token>",
        ));
    }

    let user = auth::verify_supabase_jwt(token, &state.jwt_secret, state.es256_key.as_ref())
        .map_err(|e| {
            tracing::warn!(error = %e, "JWT verification failed");
            ApiError::unauthorized("Invalid or expired token")
        })?;

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
