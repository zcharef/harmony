//! Desktop auth code domain model.
//!
//! Represents a one-time PKCE auth code for Tauri desktop deep-link exchange.

use chrono::{DateTime, Utc};

/// A one-time desktop auth code with stored tokens and PKCE challenge.
///
/// WHY: The desktop app cannot run Cloudflare Turnstile in its webview.
/// Auth is delegated to the system browser, which creates a short-lived
/// auth code. The desktop app redeems it by proving PKCE possession.
#[derive(Clone)]
pub struct DesktopAuthCode {
    pub auth_code: String,
    pub code_challenge: String,
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: DateTime<Utc>,
}

// WHY: Manual Debug to mask tokens. `#[derive(Debug)]` would leak access_token
// and refresh_token into tracing spans (CLAUDE.md Critical Invariant #1).
impl std::fmt::Debug for DesktopAuthCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DesktopAuthCode")
            .field("auth_code", &"[REDACTED]")
            .field("code_challenge", &self.code_challenge)
            .field("access_token", &"[REDACTED]")
            .field("refresh_token", &"[REDACTED]")
            .field("expires_at", &self.expires_at)
            .finish()
    }
}
