//! Desktop auth DTOs (request/response types for PKCE-based desktop exchange).

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::domain::models::MintedSession;

/// Request body for creating a desktop auth code.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateDesktopAuthRequest {
    /// PKCE `code_challenge` (S256-hashed `code_verifier`, base64url-encoded).
    ///
    /// WHY no token here: the code binds to the authenticated user (derived
    /// from the Bearer access token), and redeem mints a fresh, independent
    /// session for that user — the browser never hands over its own token.
    pub code_challenge: String,
}

/// Response containing the one-time auth code.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateDesktopAuthResponse {
    pub auth_code: String,
}

impl CreateDesktopAuthResponse {
    #[must_use]
    pub fn new(auth_code: String) -> Self {
        Self { auth_code }
    }
}

/// Request body for redeeming a desktop auth code.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RedeemDesktopAuthRequest {
    /// The one-time auth code received via deep link.
    pub auth_code: String,
    /// The PKCE `code_verifier` (plaintext; S256-hashed must match stored `code_challenge`).
    pub code_verifier: String,
}

/// Response containing the session tokens.
#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RedeemDesktopAuthResponse {
    pub access_token: String,
    pub refresh_token: String,
}

// WHY: Manual Debug to mask tokens. `#[derive(Debug)]` would leak tokens
// into tracing spans (CLAUDE.md Critical Invariant #1).
impl std::fmt::Debug for RedeemDesktopAuthResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RedeemDesktopAuthResponse")
            .field("access_token", &"[REDACTED]")
            .field("refresh_token", &"[REDACTED]")
            .finish()
    }
}

impl From<MintedSession> for RedeemDesktopAuthResponse {
    fn from(session: MintedSession) -> Self {
        Self {
            access_token: session.access_token,
            refresh_token: session.refresh_token,
        }
    }
}
