//! `OpenAI` Moderation API adapter.
//!
//! Calls `POST https://api.openai.com/v1/moderations` to check text content
//! for policy violations. Non-retryable errors (401, 403) short-circuit
//! immediately. Retryable errors (5xx, 429, network) get up to 3 attempts
//! with exponential backoff (1s, 2s) before returning `DomainError::ExternalService`.

use std::collections::HashMap;
use std::time::Duration;

use async_trait::async_trait;
use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};

use crate::domain::errors::DomainError;
use crate::domain::ports::{ContentModerator, ModerationResult};

const OPENAI_MODERATION_URL: &str = "https://api.openai.com/v1/moderations";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_ATTEMPTS: u32 = 3;

/// `OpenAI` Moderation API client.
///
/// Holds a shared `reqwest::Client` (connection-pooled) and the API key.
/// The `Debug` impl redacts the key to prevent accidental logging.
pub struct OpenAiModerator {
    client: reqwest::Client,
    api_key: SecretString,
}

impl OpenAiModerator {
    /// Create a new moderator client.
    ///
    /// The `reqwest::Client` is configured with a 10-second timeout.
    /// The API key is stored as a `SecretString` and never exposed in logs.
    /// # Panics
    ///
    /// Panics if the TLS backend cannot initialize (fatal, no recovery possible).
    #[must_use]
    #[allow(clippy::expect_used)] // WHY: reqwest::Client::build only fails on TLS init — fatal.
    pub fn new(api_key: SecretString) -> Self {
        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .expect("Failed to build reqwest client for OpenAI moderator");

        Self { client, api_key }
    }
}

// WHY: Manual Debug impl to redact the API key.
impl std::fmt::Debug for OpenAiModerator {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OpenAiModerator")
            .field("api_key", &"[REDACTED]")
            .finish()
    }
}

#[async_trait]
impl ContentModerator for OpenAiModerator {
    async fn check_text(&self, text: &str) -> Result<ModerationResult, DomainError> {
        let body = ModerationRequest {
            input: text.to_string(),
        };

        let mut last_error = String::new();

        for attempt in 1..=MAX_ATTEMPTS {
            match self
                .client
                .post(OPENAI_MODERATION_URL)
                .bearer_auth(self.api_key.expose_secret())
                .json(&body)
                .send()
                .await
            {
                Ok(response) => {
                    if !response.status().is_success() {
                        let status = response.status();
                        let body_text = response
                            .text()
                            .await
                            .unwrap_or_else(|e| format!("<body read failed: {e}>"));
                        last_error = format!("OpenAI API returned HTTP {status}: {body_text}");

                        if is_retryable_status(status) {
                            tracing::warn!(
                                attempt,
                                status = %status,
                                "OpenAI Moderation API transient error"
                            );
                        } else {
                            // WHY: Non-retryable (401, 403, etc.) = config/auth problem.
                            // Will never self-heal — alert immediately via Sentry (error!),
                            // don't waste time retrying.
                            tracing::error!(
                                status = %status,
                                "OpenAI Moderation API non-retryable error — check API key configuration"
                            );
                            return Err(DomainError::ExternalService(last_error));
                        }
                    } else {
                        match response.json::<ModerationResponse>().await {
                            Ok(parsed) => return Ok(interpret_response(&parsed)),
                            Err(e) => {
                                last_error =
                                    format!("Failed to parse OpenAI moderation response: {e}");
                                tracing::warn!(
                                    attempt,
                                    error = %e,
                                    "Failed to parse OpenAI moderation response"
                                );
                            }
                        }
                    }
                }
                Err(e) => {
                    last_error = format!("OpenAI moderation request failed: {e}");
                    tracing::warn!(
                        attempt,
                        error = %e,
                        "OpenAI Moderation API request failed"
                    );
                }
            }

            // Exponential backoff: 1s, 2s, 4s (skip sleep after the last attempt).
            if attempt < MAX_ATTEMPTS {
                let backoff = Duration::from_secs(1 << (attempt - 1));
                tokio::time::sleep(backoff).await;
            }
        }

        // WHY: All retries exhausted — the service is genuinely down or degraded.
        // Log as error so Sentry captures it for operator alerting.
        tracing::error!(
            attempts = MAX_ATTEMPTS,
            "OpenAI Moderation API retries exhausted — service degraded"
        );
        Err(DomainError::ExternalService(last_error))
    }
}

/// Whether an HTTP status code is transient and worth retrying.
///
/// 5xx (server errors) and 429 (rate-limited) are retryable.
/// 4xx (client errors like 401/403) indicate config problems that won't self-heal.
fn is_retryable_status(status: reqwest::StatusCode) -> bool {
    status.is_server_error() || status == reqwest::StatusCode::TOO_MANY_REQUESTS
}

/// Extract flagged categories from the `OpenAI` response.
fn interpret_response(response: &ModerationResponse) -> ModerationResult {
    let Some(result) = response.results.first() else {
        // WHY: The OpenAI Moderation API should always return exactly one result
        // per input. An empty array is anomalous and could indicate an API change.
        tracing::warn!(
            "OpenAI moderation response had empty results array — treating as unflagged"
        );
        return ModerationResult {
            flagged: false,
            reason: String::new(),
        };
    };

    if !result.flagged {
        return ModerationResult {
            flagged: false,
            reason: String::new(),
        };
    }

    let flagged_categories: Vec<&str> = result
        .categories
        .iter()
        .filter_map(|(name, &flagged)| if flagged { Some(name.as_str()) } else { None })
        .collect();

    ModerationResult {
        flagged: true,
        reason: flagged_categories.join(", "),
    }
}

// ── OpenAI Moderation API wire types ────────────────────────────────────────

#[derive(Serialize)]
struct ModerationRequest {
    input: String,
}

#[derive(Deserialize)]
struct ModerationResponse {
    results: Vec<ModerationResultEntry>,
}

#[derive(Deserialize)]
struct ModerationResultEntry {
    flagged: bool,
    categories: HashMap<String, bool>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interpret_not_flagged() {
        let response = ModerationResponse {
            results: vec![ModerationResultEntry {
                flagged: false,
                categories: HashMap::from([
                    ("hate".to_string(), false),
                    ("violence".to_string(), false),
                ]),
            }],
        };

        let result = interpret_response(&response);
        assert!(!result.flagged);
        assert!(result.reason.is_empty());
    }

    #[test]
    fn interpret_flagged_single_category() {
        let response = ModerationResponse {
            results: vec![ModerationResultEntry {
                flagged: true,
                categories: HashMap::from([
                    ("hate".to_string(), true),
                    ("violence".to_string(), false),
                ]),
            }],
        };

        let result = interpret_response(&response);
        assert!(result.flagged);
        assert_eq!(result.reason, "hate");
    }

    #[test]
    fn interpret_flagged_multiple_categories() {
        let response = ModerationResponse {
            results: vec![ModerationResultEntry {
                flagged: true,
                categories: HashMap::from([
                    ("hate".to_string(), true),
                    ("violence".to_string(), true),
                    ("sexual".to_string(), false),
                ]),
            }],
        };

        let result = interpret_response(&response);
        assert!(result.flagged);
        // HashMap iteration order is non-deterministic, so check both are present.
        assert!(result.reason.contains("hate"));
        assert!(result.reason.contains("violence"));
        assert!(!result.reason.contains("sexual"));
    }

    #[test]
    fn interpret_empty_results() {
        let response = ModerationResponse { results: vec![] };

        let result = interpret_response(&response);
        assert!(!result.flagged);
        assert!(result.reason.is_empty());
    }

    #[test]
    fn debug_redacts_api_key() {
        let moderator = OpenAiModerator::new(SecretString::from("sk-test-key-12345".to_string()));
        let debug_output = format!("{moderator:?}");
        assert!(!debug_output.contains("sk-test-key"));
        assert!(debug_output.contains("[REDACTED]"));
    }
}
