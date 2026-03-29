//! Desktop auth DTOs (request/response types for PKCE-based desktop exchange).
//!
//! WHY no `rename_all = "camelCase"`: These DTOs follow OAuth/PKCE conventions
//! (RFC 7636) where field names are snake_case (`code_challenge`, `code_verifier`,
//! `access_token`, `refresh_token`). The TypeScript clients already use snake_case
//! for these endpoints.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// Request body for creating a desktop auth code.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateDesktopAuthRequest {
    /// PKCE `code_challenge` (S256-hashed `code_verifier`, base64url-encoded).
    pub code_challenge: String,
    /// Supabase refresh token to store for the desktop app.
    pub refresh_token: String,
}

/// Response containing the one-time auth code.
#[derive(Debug, Serialize, ToSchema)]
pub struct CreateDesktopAuthResponse {
    pub auth_code: String,
}

/// Request body for redeeming a desktop auth code.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct RedeemDesktopAuthRequest {
    /// The one-time auth code received via deep link.
    pub auth_code: String,
    /// The PKCE `code_verifier` (plaintext; S256-hashed must match stored `code_challenge`).
    pub code_verifier: String,
}

/// Response containing the session tokens.
#[derive(Debug, Serialize, ToSchema)]
pub struct RedeemDesktopAuthResponse {
    pub access_token: String,
    pub refresh_token: String,
}
