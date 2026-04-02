//! Desktop auth DTOs (request/response types for PKCE-based desktop exchange).

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::domain::models::DesktopAuthCode;

/// Request body for creating a desktop auth code.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateDesktopAuthRequest {
    /// PKCE `code_challenge` (S256-hashed `code_verifier`, base64url-encoded).
    pub code_challenge: String,
    /// Supabase refresh token to store for the desktop app.
    pub refresh_token: String,
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

impl From<DesktopAuthCode> for RedeemDesktopAuthResponse {
    fn from(code: DesktopAuthCode) -> Self {
        Self {
            access_token: code.access_token,
            refresh_token: code.refresh_token,
        }
    }
}
