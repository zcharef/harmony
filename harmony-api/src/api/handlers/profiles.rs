//! Profile handlers.

use axum::{
    Extension, Json, extract::Query, extract::State, http::StatusCode, response::IntoResponse,
};

use crate::api::dto::{CheckUsernameQuery, CheckUsernameResponse, ProfileResponse};
use crate::api::errors::{ApiError, ProblemDetails};
use crate::api::extractors::AuthUser;
use crate::api::session;
use crate::api::state::AppState;
use crate::infra::auth::AuthenticatedUser;

/// WHY: Prevent confusion with system roles and @mention keywords.
const RESERVED_USERNAMES: &[&str] = &[
    "admin",
    "administrator",
    "system",
    "everyone",
    "here",
    "moderator",
    "mod",
    "harmony",
    "support",
    "deleted",
    "root",
    "bot",
    "official",
];

/// Sync (get or create) the authenticated user's profile.
///
/// Called after Supabase login. Creates a profile row if this is the first login,
/// or returns the existing one.
///
/// Username resolution order:
/// 1. `user_metadata.username` from the JWT (set during signup)
/// 2. Fallback: derived from the email prefix
///
/// # Errors
/// Returns `ApiError` if the JWT lacks an email claim, the username is reserved,
/// or the upsert fails.
#[utoipa::path(
    post,
    path = "/v1/auth/me",
    tag = "Auth",
    security(("bearer_auth" = [])),
    responses(
        (status = 200, description = "Profile synced successfully", body = ProfileResponse),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 409, description = "Username reserved", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state, auth_user))]
pub async fn sync_profile(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    Extension(auth_user): Extension<AuthenticatedUser>,
) -> Result<impl IntoResponse, ApiError> {
    let email = auth_user
        .email
        .ok_or_else(|| ApiError::bad_request("JWT must contain an email claim"))?;

    // Extract username: prefer user_metadata.username, fall back to email-derived
    let username_from_meta: Option<String> = auth_user
        .user_metadata
        .as_ref()
        .and_then(|m: &serde_json::Value| m.get("username"))
        .and_then(serde_json::Value::as_str)
        .map(String::from);

    let username = if let Some(ref meta_username) = username_from_meta {
        if !is_valid_username(meta_username) {
            tracing::warn!(
                meta_username = %meta_username,
                "user_metadata.username failed format validation, falling back to email-derived"
            );
            derive_username_from_email(&email)
        } else {
            meta_username.clone()
        }
    } else {
        derive_username_from_email(&email)
    };

    // WHY: Check AFTER resolution so both user-chosen AND email-derived usernames
    // are validated. An email like admin@example.com must not claim "admin".
    if RESERVED_USERNAMES.contains(&username.as_str()) {
        return Err(ApiError::conflict("This username is reserved"));
    }

    let profile = state
        .profile_service()
        .upsert_from_auth(user_id.clone(), email, username)
        .await?;

    // WHY: Set the HMAC session cookie so the browser EventSource can authenticate
    // via cookie (`withCredentials: true`). EventSource cannot send custom headers
    // like `Authorization`, so cookie auth is the only option (ADR-SSE-005).
    // This is the first authenticated endpoint called after every login.
    let token = session::create_session_token(
        &user_id.to_string(),
        auth_user.email_verified,
        false, // phone_verified — Supabase phone auth is not used
        &state.session_secret,
    );
    let cookie_value = session::build_session_cookie(&token, state.is_production);
    let mut headers = axum::http::HeaderMap::new();
    headers.insert(
        axum::http::header::SET_COOKIE,
        axum::http::HeaderValue::from_str(&cookie_value)
            .map_err(|_| ApiError::internal("Failed to build session cookie"))?,
    );

    Ok((StatusCode::OK, headers, Json(ProfileResponse::from(profile))))
}

/// Get the authenticated user's own profile.
///
/// # Errors
/// Returns `ApiError` if the profile is not found or a repository error occurs.
#[utoipa::path(
    get,
    path = "/v1/profiles/me",
    tag = "Profiles",
    security(("bearer_auth" = [])),
    responses(
        (status = 200, description = "Profile found", body = ProfileResponse),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 404, description = "Profile not found", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn get_my_profile(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, ApiError> {
    let profile = state.profile_service().get_by_id(&user_id).await?;

    Ok((StatusCode::OK, Json(ProfileResponse::from(profile))))
}

/// Check whether a username is available for registration.
///
/// Public endpoint (no auth required) — used during signup to give instant feedback.
/// Validates format, checks reserved list, and queries the database.
///
/// # Errors
/// Returns `ApiError` on database failure.
#[utoipa::path(
    get,
    path = "/v1/auth/check-username",
    tag = "Auth",
    params(CheckUsernameQuery),
    responses(
        (status = 200, description = "Availability check result", body = CheckUsernameResponse),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn check_username(
    State(state): State<AppState>,
    Query(query): Query<CheckUsernameQuery>,
) -> Result<impl IntoResponse, ApiError> {
    // WHY: Fast-reject invalid format and reserved names without hitting the DB.
    // From<bool> treats the bool as is_taken, so `true` → available: false.
    if !is_valid_username(&query.username) || RESERVED_USERNAMES.contains(&query.username.as_str())
    {
        return Ok(Json(CheckUsernameResponse::from(true)));
    }

    let taken = state
        .profile_service()
        .is_username_taken(&query.username)
        .await?;

    Ok(Json(CheckUsernameResponse::from(taken)))
}

/// Validate username format: `^[a-z0-9_]{3,32}$` without pulling in the `regex` crate.
fn is_valid_username(s: &str) -> bool {
    let len = s.len();
    (3..=32).contains(&len)
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/// Derive a DB-safe username from an email prefix.
///
/// Sanitizes to match the DB constraint `^[a-z0-9_]{3,32}$`:
/// non-alphanumeric chars become underscores, min-padded to 3 chars.
fn derive_username_from_email(email: &str) -> String {
    let raw_prefix = email.split('@').next().unwrap_or("user");
    let sanitized: String = raw_prefix
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(32)
        .collect();
    if sanitized.len() < 3 {
        format!("{sanitized}{}", "_".repeat(3 - sanitized.len()))
    } else {
        sanitized
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn valid_usernames_accepted() {
        assert!(is_valid_username("abc"));
        assert!(is_valid_username("user_123"));
        assert!(is_valid_username("a".repeat(32).as_str()));
    }

    #[test]
    fn invalid_usernames_rejected() {
        // Too short
        assert!(!is_valid_username("ab"));
        // Too long
        assert!(!is_valid_username(&"a".repeat(33)));
        // Uppercase
        assert!(!is_valid_username("Abc"));
        // Special chars
        assert!(!is_valid_username("user@name"));
        // Empty
        assert!(!is_valid_username(""));
    }

    #[test]
    fn reserved_usernames_list_is_lowercase() {
        for name in RESERVED_USERNAMES {
            assert_eq!(
                *name,
                name.to_lowercase(),
                "reserved name must be lowercase"
            );
        }
    }

    #[test]
    fn derive_username_sanitizes_email() {
        assert_eq!(
            derive_username_from_email("John.Doe@example.com"),
            "john_doe"
        );
        assert_eq!(derive_username_from_email("ab@x.com"), "ab_");
        assert_eq!(derive_username_from_email("a@x.com"), "a__");
    }
}
