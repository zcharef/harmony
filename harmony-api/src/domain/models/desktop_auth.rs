//! Desktop auth code domain model.
//!
//! Represents a one-time PKCE auth code for Tauri desktop deep-link exchange.

use chrono::{DateTime, Utc};

use crate::domain::models::UserId;

/// A one-time desktop auth code, bound to the user who created it.
///
/// WHY: The desktop app cannot run Cloudflare Turnstile in its webview.
/// Auth is delegated to the system browser, which creates a short-lived
/// auth code bound to the authenticated user. The desktop app redeems it by
/// proving PKCE possession; redeem then mints a FRESH, independent Supabase
/// session for [`Self::user_id`] (never the browser's forwarded token).
#[derive(Clone)]
pub struct DesktopAuthCode {
    pub auth_code: String,
    pub code_challenge: String,
    /// The user this code was issued for. Redeem mints a new session for
    /// exactly this user — the code cannot mint a session for anyone else.
    pub user_id: UserId,
    pub expires_at: DateTime<Utc>,
}

// WHY: Manual Debug to mask the opaque auth code. `#[derive(Debug)]` would leak
// the single-use secret into tracing spans (CLAUDE.md Critical Invariant #1).
// user_id is a non-secret identifier and is safe to log.
impl std::fmt::Debug for DesktopAuthCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DesktopAuthCode")
            .field("auth_code", &"[REDACTED]")
            .field("code_challenge", &self.code_challenge)
            .field("user_id", &self.user_id)
            .field("expires_at", &self.expires_at)
            .finish()
    }
}
