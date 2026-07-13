//! Desktop auth exchange handlers (PKCE-based token exchange for Tauri deep links).
//!
//! WHY: Tauri can't run Cloudflare Turnstile in its webview. Auth is delegated
//! to the system browser, which redirects back via `harmony://` deep link.
//! Passing raw tokens in the deep link URL is unsafe (scheme hijacking).
//! Instead, the browser creates a one-time auth code here, and the desktop
//! app redeems it by proving possession of the PKCE `code_verifier`.

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
/// Binds the code to the authenticated user (verified by the auth middleware)
/// and the PKCE `code_challenge`. Returns a short-lived auth code the desktop
/// app can redeem. Redeem mints a FRESH, independent session for this user — no
/// token is stored or forwarded here.
///
/// # Errors
/// Returns `ApiError` on validation failure or DB error.
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
#[tracing::instrument(skip(state, req))]
pub async fn create_desktop_auth_code(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiJson(req): ApiJson<CreateDesktopAuthRequest>,
) -> Result<impl IntoResponse, ApiError> {
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

    // Generate a cryptographically random 32-byte hex auth code.
    let auth_code = hex::encode(rand::random::<[u8; 32]>());

    let expires_at = chrono::Utc::now() + chrono::Duration::seconds(CODE_TTL_SECONDS);

    // WHY store user_id (not the caller's tokens): redeem mints a brand-new
    // session for this user via the service-role admin path. The code is bound
    // to the already-authenticated creator and can only ever mint a session for
    // them — never a different user.
    state
        .desktop_auth_repository()
        .create_code(&auth_code, &req.code_challenge, user_id, expires_at)
        .await?;

    Ok((
        StatusCode::OK,
        Json(CreateDesktopAuthResponse::new(auth_code)),
    ))
}

// --- Redeem (public) --------------------------------------------------------

/// Redeem a one-time desktop auth code for a fresh, independent session.
///
/// Verifies the PKCE `code_verifier` against the stored `code_challenge` (S256),
/// then mints a BRAND-NEW Supabase session for the user the code is bound to
/// (service-role admin path) and returns its access + refresh tokens. The auth
/// code is consumed (deleted) in a single atomic query to guarantee single-use.
///
/// WHY mint (not forward): the desktop must own its own refresh-token family so
/// web-side rotation cannot revoke it while the desktop is closed. The minted
/// session is disjoint from the browser's.
///
/// # Errors
/// Returns `ApiError` on validation failure, expired/invalid code, PKCE
/// mismatch, or `502` when the session mint (external Supabase call) fails.
#[utoipa::path(
    post,
    path = "/v1/auth/desktop-exchange/redeem",
    tag = "Auth",
    request_body = RedeemDesktopAuthRequest,
    responses(
        (status = 200, description = "Tokens returned", body = RedeemDesktopAuthResponse),
        (status = 400, description = "Validation error", body = ProblemDetails),
        (status = 401, description = "Invalid or expired auth code", body = ProblemDetails),
        (status = 502, description = "Session mint failed (upstream auth)", body = ProblemDetails),
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

    // WHY resolve the minter before consuming the code: if desktop session
    // minting is unavailable (service-role key unset), fail without burning the
    // single-use code, so a retry after fixing config can still succeed.
    let minter = state.session_minter().ok_or_else(|| {
        tracing::error!("desktop redeem attempted but SUPABASE_SERVICE_ROLE_KEY is not configured");
        ApiError::from(crate::domain::errors::DomainError::ExternalService(
            "desktop session minting is not configured".to_string(),
        ))
    })?;

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

    // WHY mint for code.user_id (never a client-supplied value): the session is
    // minted for exactly the user who created the code — binding is enforced by
    // the stored user_id, so a code can only ever mint that user's session.
    let session = minter.mint_session(code.user_id).await?;

    Ok((
        StatusCode::OK,
        Json(RedeemDesktopAuthResponse::from(session)),
    ))
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
