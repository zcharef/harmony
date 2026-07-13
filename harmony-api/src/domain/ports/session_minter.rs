//! Port: mint an independent Supabase session for a user.

use async_trait::async_trait;

use crate::domain::errors::DomainError;
use crate::domain::models::{MintedSession, UserId};

/// Mints a fresh, independent Supabase session (access + refresh token pair)
/// for a given user via the service-role admin path.
///
/// WHY a port: the desktop redeem handler must not forward the browser's
/// rotating refresh token. It asks this port to mint a brand-new session that
/// belongs solely to the desktop client. The concrete adapter
/// (`SupabaseAdminClient`) talks to Supabase Auth (`GoTrue`) with the
/// service-role key — an external service, kept behind this boundary so the
/// handler stays infrastructure-agnostic (hexagonal).
#[async_trait]
pub trait SessionMinter: Send + Sync + std::fmt::Debug {
    /// Mint a new session for `user_id`.
    ///
    /// # Errors
    /// Returns [`DomainError::ExternalService`] when the Supabase admin call
    /// fails (network, 5xx after retries, or a non-retryable 4xx such as an
    /// unknown user).
    async fn mint_session(&self, user_id: UserId) -> Result<MintedSession, DomainError>;
}
