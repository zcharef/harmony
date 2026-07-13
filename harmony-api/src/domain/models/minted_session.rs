//! Freshly minted Supabase session tokens.

/// An independent Supabase session minted server-side for a user via the
/// service-role admin path.
///
/// WHY: The desktop app must own a refresh-token family that no other client
/// (the web browser) rotates. Redeeming a desktop auth code returns one of
/// these — a brand-new access + refresh token pair, disjoint from the
/// browser's session.
#[derive(Clone)]
pub struct MintedSession {
    pub access_token: String,
    pub refresh_token: String,
}

// WHY: Manual Debug so the tokens never leak into logs / Sentry / spans
// (CLAUDE.md Critical Invariant #1).
impl std::fmt::Debug for MintedSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MintedSession")
            .field("access_token", &"[REDACTED]")
            .field("refresh_token", &"[REDACTED]")
            .finish()
    }
}
