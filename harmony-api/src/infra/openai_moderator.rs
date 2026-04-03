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

/// Synthetic category injected when `OpenAI` returns `flagged: true` but empty category maps.
///
/// WHY: `#[serde(default)]` on the wire types means a missing `categories` field deserializes
/// to an empty `HashMap`. If `flagged` is `true` but no individual category booleans exist,
/// `evaluate_moderation` would iterate zero entries and return `Pass` — a fail-open bypass.
/// This synthetic category is not in `TIER1_CATEGORIES` or `TIER2_CATEGORIES`, so the
/// unknown-category path in `evaluate_moderation` treats it as Tier 1 (safe-by-default).
const ANOMALOUS_FLAGGED_CATEGORY: &str = "__anomalous_flagged";

/// Extract per-category flags and scores from the `OpenAI` response.
///
/// Does NOT short-circuit on `flagged: false` — the tiered moderation system
/// needs per-category scores regardless of the top-level flag. The caller
/// (tiered policy) decides what action to take based on individual scores.
///
/// **Fail-closed guard:** If `OpenAI`'s top-level `flagged` is `true` but no individual
/// category boolean is `true` (empty or all-false maps), injects a synthetic
/// `__anomalous_flagged` category so the downstream tiered system catches it as Tier 1.
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
            category_scores: HashMap::new(),
            category_flags: HashMap::new(),
        };
    };

    let any_category_true = result.categories.values().any(|&v| v);

    // WHY: Fail-closed guard. If OpenAI says flagged but categories are empty or all-false
    // (e.g. API version migration drops fields, serde(default) fills empty HashMap),
    // we must NOT let the content pass unmoderated. Inject a synthetic unknown category
    // so evaluate_moderation's unknown-category path treats it as Tier 1 (auto-delete).
    if result.flagged && !any_category_true {
        tracing::warn!(
            categories_len = result.categories.len(),
            scores_len = result.category_scores.len(),
            "OpenAI flagged content but returned no true categories — injecting anomalous flag (fail-closed)"
        );

        let mut category_flags = result.categories.clone();
        category_flags.insert(ANOMALOUS_FLAGGED_CATEGORY.to_string(), true);

        let mut category_scores = result.category_scores.clone();
        category_scores.insert(ANOMALOUS_FLAGGED_CATEGORY.to_string(), 1.0);

        return ModerationResult {
            flagged: true,
            reason: ANOMALOUS_FLAGGED_CATEGORY.to_string(),
            category_scores,
            category_flags,
        };
    }

    let flagged_categories: Vec<&str> = result
        .categories
        .iter()
        .filter_map(|(name, &flagged)| if flagged { Some(name.as_str()) } else { None })
        .collect();

    ModerationResult {
        flagged: !flagged_categories.is_empty(),
        reason: flagged_categories.join(", "),
        category_scores: result.category_scores.clone(),
        category_flags: result.categories.clone(),
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
    // WHY serde(default): If OpenAI omits these fields during an API version migration,
    // deserialization won't fail. Empty HashMaps = no flags = message passes (fail-open).
    #[serde(default)]
    categories: HashMap<String, bool>,
    #[serde(default)]
    category_scores: HashMap<String, f64>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic)]
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
                category_scores: HashMap::from([
                    ("hate".to_string(), 0.01),
                    ("violence".to_string(), 0.02),
                ]),
            }],
        };

        let result = interpret_response(&response);
        assert!(!result.flagged);
        assert!(result.reason.is_empty());
        assert!(result.category_flags.values().all(|&v| !v));
        assert_eq!(result.category_scores.len(), 2);
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
                category_scores: HashMap::from([
                    ("hate".to_string(), 0.95),
                    ("violence".to_string(), 0.03),
                ]),
            }],
        };

        let result = interpret_response(&response);
        assert!(result.flagged);
        assert_eq!(result.reason, "hate");
        assert_eq!(result.category_flags.get("hate"), Some(&true));
        assert_eq!(result.category_flags.get("violence"), Some(&false));
        assert!(result.category_scores["hate"] > 0.9);
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
                category_scores: HashMap::from([
                    ("hate".to_string(), 0.92),
                    ("violence".to_string(), 0.88),
                    ("sexual".to_string(), 0.01),
                ]),
            }],
        };

        let result = interpret_response(&response);
        assert!(result.flagged);
        // HashMap iteration order is non-deterministic, so check both are present.
        assert!(result.reason.contains("hate"));
        assert!(result.reason.contains("violence"));
        assert!(!result.reason.contains("sexual"));
        assert_eq!(result.category_scores.len(), 3);
        assert_eq!(result.category_flags.len(), 3);
    }

    #[test]
    fn interpret_empty_results() {
        let response = ModerationResponse { results: vec![] };

        let result = interpret_response(&response);
        assert!(!result.flagged);
        assert!(result.reason.is_empty());
        assert!(result.category_scores.is_empty());
        assert!(result.category_flags.is_empty());
    }

    /// Top-level `flagged: false` but a category has a high score.
    /// `interpret_response` derives `flagged` from per-category booleans, not the
    /// top-level field. The caller (tiered policy) uses the scores to decide.
    #[test]
    fn interpret_unflagged_but_high_score() {
        let response = ModerationResponse {
            results: vec![ModerationResultEntry {
                flagged: false,
                categories: HashMap::from([("violence".to_string(), false)]),
                category_scores: HashMap::from([("violence".to_string(), 0.9)]),
            }],
        };

        let result = interpret_response(&response);
        // No category boolean is true → flagged must be false.
        assert!(!result.flagged);
        assert!(result.reason.is_empty());
        // But scores are still populated for the tiered system to inspect.
        assert!(result.category_scores["violence"] >= 0.9);
        assert_eq!(result.category_flags.get("violence"), Some(&false));
    }

    /// If `OpenAI` omits the `category_scores` field entirely (API version migration),
    /// `#[serde(default)]` gives us an empty `HashMap` instead of a deserialization error.
    #[test]
    fn serde_default_missing_scores() {
        let json = r#"{"results":[{"flagged":false,"categories":{"hate":false}}]}"#;
        let response: ModerationResponse = serde_json::from_str(json).unwrap();
        let entry = &response.results[0];
        assert!(!entry.flagged);
        assert_eq!(entry.categories.get("hate"), Some(&false));
        assert!(entry.category_scores.is_empty());
    }

    #[test]
    fn debug_redacts_api_key() {
        let moderator = OpenAiModerator::new(SecretString::from("sk-test-key-12345".to_string()));
        let debug_output = format!("{moderator:?}");
        assert!(!debug_output.contains("sk-test-key"));
        assert!(debug_output.contains("[REDACTED]"));
    }

    // ── Fail-closed: flagged=true with empty categories ─────────────

    /// S6 fix: `OpenAI` returns `flagged: true` but `categories` is completely empty
    /// (e.g. `serde(default)` fills an empty `HashMap` when the field is missing).
    /// Must inject synthetic category so `evaluate_moderation` treats it as Tier 1.
    #[test]
    fn interpret_flagged_true_empty_categories_is_fail_closed() {
        let response = ModerationResponse {
            results: vec![ModerationResultEntry {
                flagged: true,
                categories: HashMap::new(),
                category_scores: HashMap::new(),
            }],
        };

        let result = interpret_response(&response);
        assert!(
            result.flagged,
            "Must be flagged when OpenAI says flagged=true"
        );
        assert_eq!(result.reason, ANOMALOUS_FLAGGED_CATEGORY);
        assert_eq!(
            result.category_flags.get(ANOMALOUS_FLAGGED_CATEGORY),
            Some(&true),
            "Synthetic category must be injected into category_flags"
        );
        assert!(
            result.category_scores[ANOMALOUS_FLAGGED_CATEGORY] >= 1.0,
            "Synthetic category score must be 1.0 to exceed any threshold"
        );
    }

    /// S6 fix: `OpenAI` returns `flagged: true` with categories present but ALL set to false.
    /// This is equally anomalous — the top-level flag contradicts per-category flags.
    #[test]
    fn interpret_flagged_true_all_categories_false_is_fail_closed() {
        let response = ModerationResponse {
            results: vec![ModerationResultEntry {
                flagged: true,
                categories: HashMap::from([
                    ("hate".to_string(), false),
                    ("violence".to_string(), false),
                ]),
                category_scores: HashMap::from([
                    ("hate".to_string(), 0.3),
                    ("violence".to_string(), 0.2),
                ]),
            }],
        };

        let result = interpret_response(&response);
        assert!(
            result.flagged,
            "Must be flagged when OpenAI says flagged=true"
        );
        assert_eq!(result.reason, ANOMALOUS_FLAGGED_CATEGORY);
        // Original categories are preserved alongside the synthetic one
        assert_eq!(result.category_flags.get("hate"), Some(&false));
        assert_eq!(result.category_flags.get("violence"), Some(&false));
        assert_eq!(
            result.category_flags.get(ANOMALOUS_FLAGGED_CATEGORY),
            Some(&true)
        );
        // Original scores preserved, synthetic score = 1.0
        assert!((result.category_scores["hate"] - 0.3).abs() < f64::EPSILON);
        assert!(result.category_scores[ANOMALOUS_FLAGGED_CATEGORY] >= 1.0);
    }

    /// Verify: `flagged: false` with empty categories is NOT affected by the fail-closed guard.
    /// This is the normal "content is clean" response — must remain Pass.
    #[test]
    fn interpret_unflagged_empty_categories_still_passes() {
        let response = ModerationResponse {
            results: vec![ModerationResultEntry {
                flagged: false,
                categories: HashMap::new(),
                category_scores: HashMap::new(),
            }],
        };

        let result = interpret_response(&response);
        assert!(!result.flagged);
        assert!(result.reason.is_empty());
        assert!(result.category_flags.is_empty());
        assert!(result.category_scores.is_empty());
    }

    /// End-to-end: verify the synthetic category triggers Tier 1 deletion
    /// in `evaluate_moderation` (the downstream consumer).
    #[test]
    fn anomalous_flag_triggers_tier1_in_evaluate_moderation() {
        use crate::domain::services::content_moderation::{
            ModerationDecision, SCORE_THRESHOLD, evaluate_moderation,
        };

        let response = ModerationResponse {
            results: vec![ModerationResultEntry {
                flagged: true,
                categories: HashMap::new(),
                category_scores: HashMap::new(),
            }],
        };

        let moderation_result = interpret_response(&response);
        let server_categories = HashMap::new();

        let decision = evaluate_moderation(
            &moderation_result.category_scores,
            &moderation_result.category_flags,
            &server_categories,
            SCORE_THRESHOLD,
        );

        assert!(
            matches!(decision, ModerationDecision::Delete { is_tier1: true, .. }),
            "Anomalous flagged response must be treated as Tier 1 deletion, got: {decision:?}"
        );
    }
}
