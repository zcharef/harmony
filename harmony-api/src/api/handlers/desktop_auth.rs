//! Desktop auth exchange handlers (PKCE-based token exchange for Tauri deep links).
//!
//! WHY: Tauri can't run Cloudflare Turnstile in its webview. Auth is delegated
//! to the system browser, which redirects back via `harmony://` deep link.
//! Passing raw tokens in the deep link URL is unsafe (scheme hijacking).
//! Instead, the browser creates a one-time auth code here, and the desktop
//! app redeems it by proving possession of the PKCE `code_verifier`.

use axum::http::HeaderMap;
use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};
use base64::Engine;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::api::dto::desktop_auth::{
    CreateDesktopAuthRequest, CreateDesktopAuthResponse, RedeemDesktopAuthRequest,
    RedeemDesktopAuthResponse,
};
use crate::api::errors::{ApiError, ProblemDetails};
use crate::api::extractors::{ApiJson, AuthUser};
use crate::api::state::AppState;

/// TTL for desktop auth codes (seconds).
const CODE_TTL_SECONDS: i64 = 60;

/// Create a one-time desktop auth code (browser side of the PKCE exchange).
///
/// The authenticated user's access token is extracted from the Authorization header,
/// and the refresh token + PKCE `code_challenge` are provided in the request body.
/// Returns a short-lived auth code that the desktop app can redeem.
///
/// # Errors
/// Returns `ApiError` on missing Authorization header, validation failure, or DB error.
#[utoipa::path(
    post,
    path = "/v1/auth/desktop-exchange/create",
    tag = "Auth",
    security(("bearer_auth" = [])),
    request_body = CreateDesktopAuthRequest,
    responses(
        (status = 200, description = "Auth code created", body = CreateDesktopAuthResponse),
        (status = 400, description = "Validation error", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state, headers, req))]
pub async fn create_desktop_auth_code(
    AuthUser(_user_id): AuthUser,
    State(state): State<AppState>,
    headers: HeaderMap,
    ApiJson(req): ApiJson<CreateDesktopAuthRequest>,
) -> Result<impl IntoResponse, ApiError> {
    // WHY: The auth middleware already verified the Bearer token, but we need
    // the raw access_token string to store it for the desktop app to retrieve later.
    let access_token = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .filter(|t| !t.is_empty())
        .ok_or_else(|| ApiError::unauthorized("Missing Bearer token in Authorization header"))?;

    if req.code_challenge.len() != 43
        || !req
            .code_challenge
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(ApiError::bad_request(
            "code_challenge must be a 43-character base64url-encoded S256 hash",
        ));
    }
    if req.refresh_token.is_empty() {
        return Err(ApiError::bad_request("refresh_token must not be empty"));
    }

    // Generate a cryptographically random 32-byte hex auth code.
    let auth_code = hex::encode(rand::random::<[u8; 32]>());

    let expires_at = chrono::Utc::now() + chrono::Duration::seconds(CODE_TTL_SECONDS);

    state
        .desktop_auth_repository()
        .create_code(
            &auth_code,
            &req.code_challenge,
            access_token,
            &req.refresh_token,
            expires_at,
        )
        .await?;

    Ok((
        StatusCode::OK,
        Json(CreateDesktopAuthResponse::new(auth_code)),
    ))
}

// --- Redeem (public) --------------------------------------------------------

/// Redeem a one-time desktop auth code for session tokens.
///
/// Verifies the PKCE `code_verifier` against the stored `code_challenge` (S256),
/// then returns the access and refresh tokens. The auth code is consumed
/// (deleted) in a single atomic query to guarantee single-use.
///
/// # Errors
/// Returns `ApiError` on validation failure, expired/invalid code, or PKCE mismatch.
#[utoipa::path(
    post,
    path = "/v1/auth/desktop-exchange/redeem",
    tag = "Auth",
    request_body = RedeemDesktopAuthRequest,
    responses(
        (status = 200, description = "Tokens returned", body = RedeemDesktopAuthResponse),
        (status = 400, description = "Validation error", body = ProblemDetails),
        (status = 401, description = "Invalid or expired auth code", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state, req))]
pub async fn redeem_desktop_auth_code(
    State(state): State<AppState>,
    ApiJson(req): ApiJson<RedeemDesktopAuthRequest>,
) -> Result<impl IntoResponse, ApiError> {
    // WHY: Auth codes are 32-byte hex (64 chars). Reject anything else early
    // to avoid sending arbitrarily large strings to Postgres.
    if req.auth_code.len() != 64 || !req.auth_code.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(ApiError::bad_request(
            "auth_code must be a 64-character hex string",
        ));
    }
    if req.code_verifier.is_empty() {
        return Err(ApiError::bad_request("code_verifier must not be empty"));
    }

    let code = state
        .desktop_auth_repository()
        .redeem_code(&req.auth_code)
        .await?
        .ok_or_else(|| ApiError::unauthorized("Invalid or expired auth code"))?;

    // WHY: Verify PKCE -- SHA256(code_verifier), base64url-encoded, must match
    // the stored code_challenge. This proves the redeemer is the same party
    // that initiated the flow (or has the code_verifier from that party).
    let expected_challenge = s256(&req.code_verifier);
    if expected_challenge
        .as_bytes()
        .ct_eq(code.code_challenge.as_bytes())
        .unwrap_u8()
        == 0
    {
        return Err(ApiError::unauthorized("PKCE verification failed"));
    }

    Ok((StatusCode::OK, Json(RedeemDesktopAuthResponse::from(code))))
}

/// SHA-256 hash, base64url-encoded without padding (S256 per RFC 7636).
fn s256(plain: &str) -> String {
    let hash = Sha256::digest(plain.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(hash)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn s256_matches_known_vector() {
        // RFC 7636 Appendix B example (code_verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
        let result = s256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
        assert_eq!(result, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn s256_deterministic() {
        let a = s256("test-verifier");
        let b = s256("test-verifier");
        assert_eq!(a, b);
    }

    #[test]
    fn s256_different_inputs_differ() {
        let a = s256("verifier-a");
        let b = s256("verifier-b");
        assert_ne!(a, b);
    }
}
