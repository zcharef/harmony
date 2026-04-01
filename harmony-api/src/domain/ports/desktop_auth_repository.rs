//! Port: desktop auth code persistence.

use async_trait::async_trait;

use crate::domain::errors::DomainError;
use crate::domain::models::DesktopAuthCode;

/// Intent-based repository for PKCE desktop auth codes.
#[async_trait]
pub trait DesktopAuthRepository: Send + Sync + std::fmt::Debug {
    /// Create a one-time auth code with stored tokens and PKCE challenge.
    async fn create_code(
        &self,
        auth_code: &str,
        code_challenge: &str,
        access_token: &str,
        refresh_token: &str,
        expires_at: chrono::DateTime<chrono::Utc>,
    ) -> Result<(), DomainError>;

    /// Atomically redeem (consume) an auth code. Returns `None` if the code
    /// does not exist or has expired.
    ///
    /// WHY: Single DELETE + RETURNING guarantees the code is single-use.
    async fn redeem_code(&self, auth_code: &str) -> Result<Option<DesktopAuthCode>, DomainError>;
}
