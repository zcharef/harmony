//! Port: desktop auth code persistence.

use async_trait::async_trait;

use crate::domain::errors::DomainError;
use crate::domain::models::{DesktopAuthCode, UserId};

/// Intent-based repository for PKCE desktop auth codes.
#[async_trait]
pub trait DesktopAuthRepository: Send + Sync + std::fmt::Debug {
    /// Create a one-time auth code bound to `user_id` with its PKCE challenge.
    ///
    /// WHY `user_id` (not tokens): redeem mints a fresh, independent session
    /// for this user — the code no longer stores or forwards the browser's
    /// session tokens.
    async fn create_code(
        &self,
        auth_code: &str,
        code_challenge: &str,
        user_id: UserId,
        expires_at: chrono::DateTime<chrono::Utc>,
    ) -> Result<(), DomainError>;

    /// Atomically redeem (consume) an auth code. Returns `None` if the code
    /// does not exist or has expired.
    ///
    /// WHY: Single DELETE + RETURNING guarantees the code is single-use.
    async fn redeem_code(&self, auth_code: &str) -> Result<Option<DesktopAuthCode>, DomainError>;
}
