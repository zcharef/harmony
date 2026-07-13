//! Supabase Auth (`GoTrue`) admin client — mints independent user sessions.
//!
//! WHY: The desktop app must own its own refresh-token family. At desktop
//! auth-code redeem time we mint a BRAND-NEW Supabase session for the user via
//! the service-role admin path, instead of forwarding the browser's rotating
//! refresh token (which web-side rotation would revoke while the desktop is
//! closed → forced re-login).
//!
//! Mint flow (all server-side, service-role key never leaves this process):
//! 1. `GET  /auth/v1/admin/users/{id}` → resolve the user's email.
//! 2. `POST /auth/v1/admin/generate_link` → mint a magic-link `hashed_token`.
//! 3. `POST /auth/v1/verify` → exchange `token_hash` for a fresh access +
//!    refresh token pair.
//!
//! Mirrors [`crate::infra::klipy`] (the canonical external-HTTP pattern):
//! `reqwest::Client`, `SecretString` key with a redacted `Debug`, retry/backoff
//! on transient failures, and errors classified retryable vs non-retryable
//! (ADR-046). All failures map to [`DomainError::ExternalService`] (→ 502).

use std::time::Duration;

use async_trait::async_trait;
use secrecy::{ExposeSecret, SecretString};
use serde::Deserialize;

use crate::domain::errors::DomainError;
use crate::domain::models::{MintedSession, UserId};
use crate::domain::ports::SessionMinter;

/// HTTP request timeout per attempt.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// Maximum attempts (1 initial + retries) for transient failures.
const MAX_RETRIES: u32 = 3;

/// Base delay for exponential backoff (doubles each retry: 500ms, 1s).
const BACKOFF_BASE: Duration = Duration::from_millis(500);

/// `GoTrue` admin client for minting independent user sessions.
///
/// The service-role key is stored as `SecretString` and only exposed at send
/// time — never written into a loggable variable (see the redacted `Debug`).
pub struct SupabaseAdminClient {
    client: reqwest::Client,
    /// Supabase project URL, e.g. `https://xyz.supabase.co` (no trailing slash).
    base_url: String,
    service_role_key: SecretString,
}

// WHY: Manual Debug so the service-role key never leaks into logs / Sentry /
// spans (CLAUDE.md Critical Invariant #1).
impl std::fmt::Debug for SupabaseAdminClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SupabaseAdminClient")
            .field("base_url", &self.base_url)
            .field("service_role_key", &"[REDACTED]")
            .finish()
    }
}

impl SupabaseAdminClient {
    /// Create a client against the given Supabase project URL.
    ///
    /// # Errors
    /// Returns an error if the underlying HTTP client cannot be constructed.
    pub fn new(base_url: &str, service_role_key: SecretString) -> Result<Self, reqwest::Error> {
        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()?;
        // WHY: strip a trailing slash so path joins never produce a double `//`.
        let base_url = base_url.trim_end_matches('/').to_string();
        Ok(Self {
            client,
            base_url,
            service_role_key,
        })
    }

    fn key(&self) -> &str {
        self.service_role_key.expose_secret()
    }

    /// Resolve the user's email via the admin users endpoint.
    async fn fetch_email(&self, user_id: UserId) -> Result<String, SupabaseAdminError> {
        let url = format!("{}/auth/v1/admin/users/{}", self.base_url, user_id.0);
        let user: AdminUser = self
            .send_with_retry("admin/users", || {
                self.client
                    .get(&url)
                    .header("apikey", self.key())
                    .bearer_auth(self.key())
            })
            .await?;
        user.email
            .filter(|e| !e.is_empty())
            .ok_or(SupabaseAdminError::MissingField("email"))
    }

    /// Mint a magic-link `hashed_token` for the given email.
    async fn generate_link(&self, email: &str) -> Result<String, SupabaseAdminError> {
        let url = format!("{}/auth/v1/admin/generate_link", self.base_url);
        let body = serde_json::json!({ "type": "magiclink", "email": email });
        let link: GenerateLinkResponse = self
            .send_with_retry("admin/generate_link", || {
                self.client
                    .post(&url)
                    .header("apikey", self.key())
                    .bearer_auth(self.key())
                    .json(&body)
            })
            .await?;
        Ok(link.hashed_token)
    }

    /// Exchange a magic-link `token_hash` for a fresh session.
    async fn verify(&self, token_hash: &str) -> Result<MintedSession, SupabaseAdminError> {
        let url = format!("{}/auth/v1/verify", self.base_url);
        let body = serde_json::json!({ "type": "magiclink", "token_hash": token_hash });
        // WHY no bearer here: `/verify` is the token-issuing endpoint; the
        // standard client sends only `apikey`. Sending the service-role bearer
        // is unnecessary — the freshly issued session comes from the token_hash.
        let token: AccessTokenResponse = self
            .send_with_retry("verify", || {
                self.client
                    .post(&url)
                    .header("apikey", self.key())
                    .json(&body)
            })
            .await?;
        Ok(MintedSession {
            access_token: token.access_token,
            refresh_token: token.refresh_token,
        })
    }

    /// Send a request built by `build` with retry/backoff, deserializing the
    /// success body as `T`.
    ///
    /// `endpoint` is the only thing ever logged — never the URL (carries the
    /// user id) or the body (carries tokens).
    async fn send_with_retry<T, F>(
        &self,
        endpoint: &'static str,
        build: F,
    ) -> Result<T, SupabaseAdminError>
    where
        T: for<'de> Deserialize<'de>,
        F: Fn() -> reqwest::RequestBuilder + Send + Sync,
    {
        let mut last_error: Option<SupabaseAdminError> = None;
        for attempt in 0..MAX_RETRIES {
            if attempt > 0 {
                let delay = BACKOFF_BASE * 2u32.saturating_pow(attempt - 1);
                tracing::warn!(
                    attempt,
                    endpoint,
                    delay_ms = u64::try_from(delay.as_millis()).unwrap_or(u64::MAX),
                    "retrying supabase admin request"
                );
                tokio::time::sleep(delay).await;
            }

            match self.send_once::<T, F>(&build).await {
                Ok(value) => return Ok(value),
                Err(e) if e.is_retryable() => {
                    tracing::warn!(attempt, endpoint, error = %e, "supabase admin transient failure");
                    last_error = Some(e);
                }
                Err(e) => {
                    // WHY error!: a non-retryable failure (4xx — unknown user,
                    // bad key) never self-heals. Endpoint only; no body/token.
                    tracing::error!(endpoint, error = %e, "supabase admin non-retryable error");
                    return Err(e);
                }
            }
        }

        tracing::error!(
            retries = MAX_RETRIES,
            endpoint,
            "supabase admin retries exhausted"
        );
        Err(last_error.unwrap_or(SupabaseAdminError::RetriesExhausted))
    }

    /// One request attempt: classify status, then parse the body.
    async fn send_once<T, F>(&self, build: &F) -> Result<T, SupabaseAdminError>
    where
        T: for<'de> Deserialize<'de>,
        F: Fn() -> reqwest::RequestBuilder + Send + Sync,
    {
        let response = build().send().await.map_err(SupabaseAdminError::Http)?;
        let status = response.status();
        if status.is_server_error() {
            return Err(SupabaseAdminError::ServerError(status.as_u16()));
        }
        if status.is_client_error() {
            return Err(SupabaseAdminError::ClientError(status.as_u16()));
        }
        // WHY .json map_err: a malformed/truncated success body is a transport
        // problem — surface it as retryable HTTP rather than a silent None.
        response.json::<T>().await.map_err(SupabaseAdminError::Http)
    }
}

#[async_trait]
impl SessionMinter for SupabaseAdminClient {
    async fn mint_session(&self, user_id: UserId) -> Result<MintedSession, DomainError> {
        let uid = user_id.0;
        let email = self.fetch_email(user_id).await?;
        let token_hash = self.generate_link(&email).await?;
        let session = self.verify(&token_hash).await?;
        tracing::info!(user_id = %uid, "minted independent desktop session");
        Ok(session)
    }
}

// ── Wire types (only the fields we consume) ─────────────────────────

#[derive(Deserialize)]
struct AdminUser {
    email: Option<String>,
}

#[derive(Deserialize)]
struct GenerateLinkResponse {
    hashed_token: String,
}

#[derive(Deserialize)]
struct AccessTokenResponse {
    access_token: String,
    refresh_token: String,
}

// ── Errors ──────────────────────────────────────────────────────────

/// Errors from the Supabase admin client. All map to
/// [`DomainError::ExternalService`] (→ 502) — never expose internals to the
/// client, and never include response bodies (they carry tokens).
#[derive(Debug, thiserror::Error)]
pub enum SupabaseAdminError {
    /// Network or deserialization error from `reqwest` (retryable).
    #[error("HTTP error")]
    Http(#[source] reqwest::Error),

    /// Server returned a 5xx status (retryable).
    #[error("Supabase admin server error: HTTP {0}")]
    ServerError(u16),

    /// Server returned a 4xx status (non-retryable — bad key / unknown user).
    #[error("Supabase admin client error: HTTP {0}")]
    ClientError(u16),

    /// A required field was absent from an otherwise-successful response.
    #[error("Supabase admin response missing field: {0}")]
    MissingField(&'static str),

    /// All retry attempts were exhausted.
    #[error("Supabase admin retries exhausted")]
    RetriesExhausted,
}

impl SupabaseAdminError {
    /// Whether this error is transient and the request should be retried.
    #[must_use]
    fn is_retryable(&self) -> bool {
        match self {
            Self::Http(e) => e.is_timeout() || e.is_connect() || e.is_request() || e.is_body(),
            Self::ServerError(_) => true,
            Self::ClientError(_) | Self::MissingField(_) | Self::RetriesExhausted => false,
        }
    }
}

impl From<SupabaseAdminError> for DomainError {
    fn from(e: SupabaseAdminError) -> Self {
        // WHY generic message: the client only needs "upstream auth failed".
        // The specific endpoint/status is already logged server-side.
        DomainError::ExternalService(format!("session mint failed: {e}"))
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn debug_impl_redacts_service_role_key() {
        let client = SupabaseAdminClient::new(
            "https://proj.supabase.co",
            SecretString::from("super-secret-service-role".to_string()),
        )
        .unwrap();
        let debug = format!("{client:?}");
        assert!(debug.contains("[REDACTED]"));
        assert!(!debug.contains("super-secret-service-role"));
    }

    #[test]
    fn base_url_trailing_slash_is_stripped() {
        let client = SupabaseAdminClient::new(
            "https://proj.supabase.co/",
            SecretString::from("k".to_string()),
        )
        .unwrap();
        assert_eq!(client.base_url, "https://proj.supabase.co");
    }

    #[test]
    fn server_error_is_retryable_client_error_is_not() {
        assert!(SupabaseAdminError::ServerError(503).is_retryable());
        assert!(!SupabaseAdminError::ClientError(404).is_retryable());
        assert!(!SupabaseAdminError::MissingField("email").is_retryable());
        assert!(!SupabaseAdminError::RetriesExhausted.is_retryable());
    }
}
