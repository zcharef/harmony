//! Google Safe Browsing API v4 client.
//!
//! Checks URLs against Google's threat lists (malware, phishing, unwanted software).
//! Used by the anti-spam pipeline to flag dangerous links in messages.

use std::sync::OnceLock;
use std::time::Duration;

use regex::Regex;
use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};

/// Google Safe Browsing API v4 endpoint.
const API_URL: &str = "https://safebrowsing.googleapis.com/v4/threatMatches:find";

/// HTTP request timeout.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// Maximum retry attempts for transient failures.
const MAX_RETRIES: u32 = 3;

/// Base delay for exponential backoff (doubles each retry: 1s, 2s).
const BACKOFF_BASE: Duration = Duration::from_secs(1);

// ── URL extraction ─────────────────────────────────────────────

/// Compiled regex for URL extraction, initialized once.
fn url_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        // WHY: Intentionally simple pattern. Covers http/https URLs while
        // excluding surrounding punctuation and markup characters.
        #[allow(clippy::expect_used)]
        Regex::new(r#"https?://[^\s<>"{}|\\^`\[\]]+"#).expect("hardcoded URL regex is valid")
    })
}

/// Extract URLs from message text using a simple regex.
///
/// Returns a deduplicated list of URLs found, preserving first-occurrence order.
#[must_use]
pub fn extract_urls(text: &str) -> Vec<String> {
    let re = url_regex();
    let mut seen = std::collections::HashSet::new();
    let mut urls = Vec::new();

    for m in re.find_iter(text) {
        let url = m.as_str().to_string();
        if seen.insert(url.clone()) {
            urls.push(url);
        }
    }

    urls
}

// ── Safe Browsing client ───────────────────────────────────────

/// HTTP client for Google Safe Browsing API v4.
///
/// Wraps `reqwest::Client` with retry logic and timeout handling.
/// The API key is stored as `SecretString` and never appears in logs.
pub struct SafeBrowsingClient {
    client: reqwest::Client,
    api_key: SecretString,
}

// WHY: Manual Debug to avoid leaking the API key in logs/error reports.
impl std::fmt::Debug for SafeBrowsingClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SafeBrowsingClient")
            .field("api_key", &"[REDACTED]")
            .finish()
    }
}

/// Result of scanning URLs against Safe Browsing threat lists.
#[derive(Debug)]
pub struct UrlScanResult {
    /// Whether any of the submitted URLs matched a threat list.
    pub has_threats: bool,
    /// Threat types found (e.g. `"MALWARE"`, `"SOCIAL_ENGINEERING"`).
    pub threat_types: Vec<String>,
}

impl SafeBrowsingClient {
    /// Create a new Safe Browsing client.
    ///
    /// Uses a shared `reqwest::Client` with a 10-second timeout.
    ///
    /// # Errors
    /// Returns an error if the underlying HTTP client cannot be constructed.
    pub fn new(api_key: SecretString) -> Result<Self, reqwest::Error> {
        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()?;

        Ok(Self { client, api_key })
    }

    /// Check URLs against Google Safe Browsing threat lists.
    ///
    /// Sends up to `MAX_RETRIES` attempts with exponential backoff on transient
    /// failures (network errors, 5xx responses). Returns a scan result indicating
    /// whether any URL was flagged.
    ///
    /// # Errors
    /// Returns an error if all retry attempts are exhausted or the API returns
    /// a non-retryable error (4xx).
    pub async fn check_urls(&self, urls: &[String]) -> Result<UrlScanResult, SafeBrowsingError> {
        if urls.is_empty() {
            return Ok(UrlScanResult {
                has_threats: false,
                threat_types: Vec::new(),
            });
        }

        let request_body = Self::build_request_body(urls);
        // WHY: Build the key as a query param tuple instead of format!() to avoid
        // the secret appearing in any string variable that could be logged.
        // reqwest's .query() adds it to the URL at send time only.
        let api_key = self.api_key.expose_secret().to_string();

        let mut last_error = None;

        for attempt in 0..MAX_RETRIES {
            if attempt > 0 {
                let delay = BACKOFF_BASE * 2u32.saturating_pow(attempt - 1);
                tracing::warn!(
                    attempt,
                    delay_secs = delay.as_secs(),
                    "Retrying Safe Browsing API request"
                );
                tokio::time::sleep(delay).await;
            }

            match self.send_request(API_URL, &api_key, &request_body).await {
                Ok(result) => return Ok(result),
                Err(e) if e.is_retryable() => {
                    tracing::warn!(
                        attempt,
                        error = %e,
                        "Safe Browsing API transient failure"
                    );
                    last_error = Some(e);
                }
                Err(e) => {
                    // WHY: Non-retryable (4xx) = config/auth problem.
                    // Will never self-heal — alert via Sentry (error!).
                    tracing::error!(
                        error = %e,
                        "Safe Browsing API non-retryable error"
                    );
                    return Err(e);
                }
            }
        }

        // WHY: All retries exhausted — the service is genuinely down.
        // Log as error so Sentry captures it for operator alerting.
        tracing::error!(
            retries = MAX_RETRIES,
            "Safe Browsing API retries exhausted — service degraded"
        );
        Err(last_error.unwrap_or(SafeBrowsingError::RetriesExhausted))
    }

    /// Build the JSON request body for the `threatMatches:find` endpoint.
    fn build_request_body(urls: &[String]) -> ThreatMatchRequest {
        ThreatMatchRequest {
            client: ClientInfo {
                client_id: "harmony".to_string(),
                client_version: "0.1.0".to_string(),
            },
            threat_info: ThreatInfo {
                threat_types: vec![
                    "MALWARE".to_string(),
                    "SOCIAL_ENGINEERING".to_string(),
                    "UNWANTED_SOFTWARE".to_string(),
                    "POTENTIALLY_HARMFUL_APPLICATION".to_string(),
                ],
                platform_types: vec!["ANY_PLATFORM".to_string()],
                threat_entry_types: vec!["URL".to_string()],
                threat_entries: urls
                    .iter()
                    .map(|u| ThreatEntry { url: u.clone() })
                    .collect(),
            },
        }
    }

    /// Send a single request to the Safe Browsing API.
    async fn send_request(
        &self,
        url: &str,
        api_key: &str,
        body: &ThreatMatchRequest,
    ) -> Result<UrlScanResult, SafeBrowsingError> {
        // WHY: Use .query() so the API key is added at send time without
        // appearing in any loggable URL string (prevents key leakage in
        // debug logs, Sentry breadcrumbs, or tracing spans).
        let response = self
            .client
            .post(url)
            .query(&[("key", api_key)])
            .json(body)
            .send()
            .await
            .map_err(SafeBrowsingError::Http)?;

        let status = response.status();

        if status.is_server_error() {
            return Err(SafeBrowsingError::ServerError(status.as_u16()));
        }

        if status.is_client_error() {
            let body = response
                .text()
                .await
                .unwrap_or_else(|_| "<unreadable body>".to_string());
            return Err(SafeBrowsingError::ClientError {
                status: status.as_u16(),
                body,
            });
        }

        let api_response: ThreatMatchResponse =
            response.json().await.map_err(SafeBrowsingError::Http)?;

        let threat_types: Vec<String> = api_response
            .matches
            .unwrap_or_default()
            .iter()
            .map(|m| m.threat_type.clone())
            .collect::<std::collections::HashSet<_>>()
            .into_iter()
            .collect();

        Ok(UrlScanResult {
            has_threats: !threat_types.is_empty(),
            threat_types,
        })
    }
}

// ── Errors ─────────────────────────────────────────────────────

/// Errors from the Safe Browsing API client.
#[derive(Debug, thiserror::Error)]
pub enum SafeBrowsingError {
    /// Network or deserialization error from `reqwest`.
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),

    /// Server returned a 5xx status (retryable).
    #[error("Safe Browsing API server error: HTTP {0}")]
    ServerError(u16),

    /// Server returned a 4xx status (non-retryable).
    #[error("Safe Browsing API client error: HTTP {status} — {body}")]
    ClientError { status: u16, body: String },

    /// All retry attempts were exhausted.
    #[error("Safe Browsing API retries exhausted")]
    RetriesExhausted,
}

impl SafeBrowsingError {
    /// Whether this error is transient and the request should be retried.
    #[must_use]
    fn is_retryable(&self) -> bool {
        match self {
            Self::Http(e) => e.is_timeout() || e.is_connect(),
            Self::ServerError(_) => true,
            Self::ClientError { .. } | Self::RetriesExhausted => false,
        }
    }
}

// ── API request/response types (private) ───────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ThreatMatchRequest {
    client: ClientInfo,
    threat_info: ThreatInfo,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientInfo {
    client_id: String,
    client_version: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ThreatInfo {
    threat_types: Vec<String>,
    platform_types: Vec<String>,
    threat_entry_types: Vec<String>,
    threat_entries: Vec<ThreatEntry>,
}

#[derive(Serialize)]
struct ThreatEntry {
    url: String,
}

#[derive(Deserialize)]
struct ThreatMatchResponse {
    matches: Option<Vec<ThreatMatch>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreatMatch {
    threat_type: String,
}

// ── Tests ──────────────────────────────────────────────────────

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    // ── extract_urls ────────────────────────────────────────────

    #[test]
    fn extract_urls_finds_http_and_https() {
        let text = "check http://example.com and https://secure.example.org/path";
        let urls = extract_urls(text);
        assert_eq!(urls.len(), 2);
        assert_eq!(urls[0], "http://example.com");
        assert_eq!(urls[1], "https://secure.example.org/path");
    }

    #[test]
    fn extract_urls_deduplicates() {
        let text = "visit https://example.com twice: https://example.com";
        let urls = extract_urls(text);
        assert_eq!(urls.len(), 1);
        assert_eq!(urls[0], "https://example.com");
    }

    #[test]
    fn extract_urls_returns_empty_for_no_urls() {
        let urls = extract_urls("no links here, just text");
        assert!(urls.is_empty());
    }

    #[test]
    fn extract_urls_handles_urls_with_query_params() {
        let text = "link: https://example.com/path?foo=bar&baz=1#section";
        let urls = extract_urls(text);
        assert_eq!(urls.len(), 1);
        assert_eq!(urls[0], "https://example.com/path?foo=bar&baz=1#section");
    }

    #[test]
    fn extract_urls_excludes_angle_bracket_delimited() {
        let text = "see <https://example.com> for more";
        let urls = extract_urls(text);
        assert_eq!(urls.len(), 1);
        // WHY: The regex stops at `>`, so the URL is cleanly extracted.
        assert_eq!(urls[0], "https://example.com");
    }

    #[test]
    fn extract_urls_handles_empty_input() {
        let urls = extract_urls("");
        assert!(urls.is_empty());
    }

    #[test]
    fn extract_urls_preserves_first_occurrence_order() {
        let text = "first https://a.com then https://b.com then https://a.com again";
        let urls = extract_urls(text);
        assert_eq!(urls, vec!["https://a.com", "https://b.com"]);
    }

    // ── SafeBrowsingClient ─────────────────────────────────────

    #[test]
    fn debug_impl_redacts_api_key() {
        let client =
            SafeBrowsingClient::new(SecretString::from("super-secret-key".to_string())).unwrap();
        let debug_output = format!("{:?}", client);
        assert!(debug_output.contains("[REDACTED]"));
        assert!(!debug_output.contains("super-secret-key"));
    }

    #[test]
    fn error_is_retryable_for_server_errors() {
        let err = SafeBrowsingError::ServerError(502);
        assert!(err.is_retryable());
    }

    #[test]
    fn error_is_not_retryable_for_client_errors() {
        let err = SafeBrowsingError::ClientError {
            status: 400,
            body: "bad request".to_string(),
        };
        assert!(!err.is_retryable());
    }

    #[test]
    fn error_is_not_retryable_for_retries_exhausted() {
        let err = SafeBrowsingError::RetriesExhausted;
        assert!(!err.is_retryable());
    }

    #[tokio::test]
    async fn check_urls_returns_no_threats_for_empty_list() {
        let client = SafeBrowsingClient::new(SecretString::from("test-key".to_string())).unwrap();
        let result = client.check_urls(&[]).await.unwrap();
        assert!(!result.has_threats);
        assert!(result.threat_types.is_empty());
    }

    #[test]
    fn build_request_body_includes_all_threat_types() {
        let urls = vec!["https://example.com".to_string()];
        let body = SafeBrowsingClient::build_request_body(&urls);

        assert_eq!(body.client.client_id, "harmony");
        assert_eq!(body.client.client_version, "0.1.0");
        assert_eq!(body.threat_info.threat_types.len(), 4);
        assert!(
            body.threat_info
                .threat_types
                .contains(&"MALWARE".to_string())
        );
        assert!(
            body.threat_info
                .threat_types
                .contains(&"SOCIAL_ENGINEERING".to_string())
        );
        assert!(
            body.threat_info
                .threat_types
                .contains(&"UNWANTED_SOFTWARE".to_string())
        );
        assert!(
            body.threat_info
                .threat_types
                .contains(&"POTENTIALLY_HARMFUL_APPLICATION".to_string())
        );
        assert_eq!(body.threat_info.platform_types, vec!["ANY_PLATFORM"]);
        assert_eq!(body.threat_info.threat_entry_types, vec!["URL"]);
        assert_eq!(body.threat_info.threat_entries.len(), 1);
        assert_eq!(
            body.threat_info.threat_entries[0].url,
            "https://example.com"
        );
    }

    // ── UrlScanResult ──────────────────────────────────────────

    #[test]
    fn url_scan_result_debug_output() {
        let result = UrlScanResult {
            has_threats: true,
            threat_types: vec!["MALWARE".to_string()],
        };
        let debug = format!("{:?}", result);
        assert!(debug.contains("has_threats: true"));
        assert!(debug.contains("MALWARE"));
    }

    // ── SafeBrowsingError display ──────────────────────────────

    #[test]
    fn error_display_messages() {
        let err = SafeBrowsingError::ServerError(503);
        assert_eq!(err.to_string(), "Safe Browsing API server error: HTTP 503");

        let err = SafeBrowsingError::ClientError {
            status: 403,
            body: "forbidden".to_string(),
        };
        assert_eq!(
            err.to_string(),
            "Safe Browsing API client error: HTTP 403 \u{2014} forbidden"
        );

        let err = SafeBrowsingError::RetriesExhausted;
        assert_eq!(err.to_string(), "Safe Browsing API retries exhausted");
    }
}
