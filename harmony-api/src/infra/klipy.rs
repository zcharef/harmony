//! Klipy GIF API client.
//!
//! Read-through proxy for the composer GIF picker. The API key stays
//! server-side (path segment on the upstream URL) and never reaches the
//! browser — every Klipy call is proxied through `/v1/gifs/*`.
//!
//! Mirrors [`crate::infra::safe_browsing`] (the canonical external-HTTP
//! pattern): `reqwest::Client`, `SecretString` key with a redacted `Debug`,
//! retry/backoff on transient failures, and a `thiserror` error enum classified
//! retryable vs non-retryable.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use secrecy::{ExposeSecret, SecretString};
use serde::Deserialize;
use tokio::sync::Mutex;

/// Klipy API base (the key is appended as the next path segment).
const DEFAULT_BASE_URL: &str = "https://api.klipy.com/api/v1";

/// HTTP request timeout.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// Maximum retry attempts for transient failures.
const MAX_RETRIES: u32 = 3;

/// Base delay for exponential backoff (doubles each retry: 1s, 2s).
const BACKOFF_BASE: Duration = Duration::from_secs(1);

/// Fixed page size sent upstream. Not client-controllable (one fewer abuse
/// vector); Klipy default is 24.
const PER_PAGE: u32 = 24;

/// SFW ceiling sent on every request. The server, not the client, sets this.
const RATING: &str = "pg-13";

/// Default process-global budget: upstream calls per rolling hour, capped safely
/// under the test key's 100/hr. Overridable via `KLIPY_GLOBAL_MAX_PER_HOUR`.
pub const DEFAULT_GLOBAL_MAX_PER_HOUR: u32 = 90;

/// Rolling one-hour window for the global budget.
const BUDGET_WINDOW: Duration = Duration::from_secs(3600);

/// Cap on the upstream 4xx body we retain/log — bounds memory and log bloat
/// from a misbehaving or hostile upstream.
const MAX_ERROR_BODY_CHARS: usize = 512;

// ── Public result types ─────────────────────────────────────────

/// A single GIF, flattened from Klipy's nested tiered envelope. This is the
/// shape the handler maps into the response DTO — Klipy's raw envelope (with ad
/// payloads) never leaves this module.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KlipyGif {
    /// Stable slug (React list key + telemetry).
    pub id: String,
    /// Alt text; falls back to the query when Klipy gives none.
    pub title: String,
    /// Hosted animated `.gif` URL — inserted verbatim as message content.
    pub url: String,
    /// Smaller preview URL for the grid (webp preferred, gif fallback).
    pub preview_url: String,
    pub width: u32,
    pub height: u32,
}

/// One page of GIF results.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KlipyGifPage {
    pub items: Vec<KlipyGif>,
    /// True when a next page exists (drives infinite scroll).
    pub has_next: bool,
    pub page: u32,
}

// ── Global budget ───────────────────────────────────────────────

/// Process-global rolling-window limiter protecting the shared upstream budget.
///
/// WHY separate from the per-user `SpamGuard`: 10 users × 30/min each would
/// obliterate the 100/hr test key. This caps *total* upstream calls across all
/// users. `tokio::sync::Mutex` (never `std::sync::Mutex`, ADR-022) but the guard
/// is dropped before any `.await`, so it never spans a suspension point.
#[derive(Debug)]
struct GlobalBudget {
    max: usize,
    hits: Mutex<VecDeque<Instant>>,
}

impl GlobalBudget {
    fn new(max: u32) -> Self {
        Self {
            max: max as usize,
            hits: Mutex::new(VecDeque::new()),
        }
    }

    /// Consume one slot. Returns the remaining budget on success, or `None` when
    /// exhausted. Evicts entries older than [`BUDGET_WINDOW`] first.
    async fn try_consume(&self) -> Option<usize> {
        let now = Instant::now();
        let mut hits = self.hits.lock().await;
        while let Some(front) = hits.front() {
            if now.duration_since(*front) >= BUDGET_WINDOW {
                hits.pop_front();
            } else {
                break;
            }
        }
        if hits.len() >= self.max {
            return None;
        }
        hits.push_back(now);
        Some(self.max - hits.len())
    }
}

// ── Client ──────────────────────────────────────────────────────

/// HTTP client for the Klipy GIF API.
///
/// The key is stored as `SecretString` and only exposed at send time — it is
/// never written into a loggable variable (see the redacted `Debug` below).
pub struct KlipyClient {
    client: reqwest::Client,
    api_key: SecretString,
    base_url: String,
    budget: GlobalBudget,
}

// WHY: Manual Debug so the API key never leaks into logs / Sentry / spans.
impl std::fmt::Debug for KlipyClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KlipyClient")
            .field("api_key", &"[REDACTED]")
            .field("base_url", &self.base_url)
            .field("budget_max", &self.budget.max)
            .finish()
    }
}

impl KlipyClient {
    /// Create a client against the production Klipy endpoint.
    ///
    /// # Errors
    /// Returns an error if the underlying HTTP client cannot be constructed.
    pub fn new(api_key: SecretString, global_max_per_hour: u32) -> Result<Self, reqwest::Error> {
        Self::with_base_url(api_key, global_max_per_hour, DEFAULT_BASE_URL.to_string())
    }

    /// Create a client against a custom base URL (used by tests to point at a
    /// `wiremock` server).
    ///
    /// # Errors
    /// Returns an error if the underlying HTTP client cannot be constructed.
    pub fn with_base_url(
        api_key: SecretString,
        global_max_per_hour: u32,
        base_url: String,
    ) -> Result<Self, reqwest::Error> {
        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()?;
        Ok(Self {
            client,
            api_key,
            base_url,
            budget: GlobalBudget::new(global_max_per_hour),
        })
    }

    /// Search GIFs for `query` at 1-based `page`.
    ///
    /// # Errors
    /// See [`KlipyError`] — budget exhaustion, upstream 4xx/5xx, or retries.
    pub async fn search(&self, query: &str, page: u32) -> Result<KlipyGifPage, KlipyError> {
        self.fetch("search", Some(query), page, query).await
    }

    /// Fetch trending GIFs at 1-based `page`.
    ///
    /// # Errors
    /// See [`KlipyError`].
    pub async fn trending(&self, page: u32) -> Result<KlipyGifPage, KlipyError> {
        self.fetch("trending", None, page, "trending").await
    }

    /// Shared fetch + retry loop for both endpoints.
    ///
    /// `endpoint` is `"search"` or `"trending"` (also the only thing ever
    /// logged — never the URL, which carries the key). `fallback_title` seeds a
    /// GIF's alt text when Klipy returns an empty title.
    async fn fetch(
        &self,
        endpoint: &'static str,
        query: Option<&str>,
        page: u32,
        fallback_title: &str,
    ) -> Result<KlipyGifPage, KlipyError> {
        let mut last_error = None;
        for attempt in 0..MAX_RETRIES {
            if attempt > 0 {
                let delay = BACKOFF_BASE * 2u32.saturating_pow(attempt - 1);
                tracing::warn!(
                    attempt,
                    endpoint,
                    delay_secs = delay.as_secs(),
                    "retrying klipy request"
                );
                tokio::time::sleep(delay).await;
            }

            // WHY consume per attempt (not once per fetch): the budget guards the
            // shared upstream key's quota, and each retry is a real upstream call.
            // Charging one slot per network attempt keeps the 90/hr cap honest —
            // consuming once per fetch would let 3 retries burn 3× the quota.
            match self.budget.try_consume().await {
                Some(remaining) => {
                    tracing::info!(
                        endpoint,
                        page,
                        attempt,
                        budget_remaining = remaining,
                        "klipy request"
                    );
                }
                None => {
                    tracing::warn!(remaining = 0, endpoint, "klipy global budget exhausted");
                    // If a prior attempt already failed, surface that upstream
                    // error; otherwise this is a clean budget rejection (503).
                    return Err(last_error.unwrap_or(KlipyError::BudgetExhausted));
                }
            }

            match self.send(endpoint, query, page, fallback_title).await {
                Ok(page) => return Ok(page),
                Err(e) if e.is_retryable() => {
                    tracing::warn!(attempt, endpoint, error = %e, "klipy transient failure");
                    last_error = Some(e);
                }
                Err(e) => {
                    // WHY error!: a 4xx is a bad/expired key or quota — a config
                    // problem that never self-heals. Body logged for the operator,
                    // never returned to the client.
                    tracing::error!(endpoint, error = %e, "klipy non-retryable error");
                    return Err(e);
                }
            }
        }

        tracing::error!(retries = MAX_RETRIES, endpoint, "klipy retries exhausted");
        Err(last_error.unwrap_or(KlipyError::RetriesExhausted))
    }

    /// Send one request and parse the response.
    async fn send(
        &self,
        endpoint: &str,
        query: Option<&str>,
        page: u32,
        fallback_title: &str,
    ) -> Result<KlipyGifPage, KlipyError> {
        // WHY build the URL here and never store it: the key is a path segment,
        // so any persisted URL string would leak the secret. Expose it only for
        // the lifetime of this call.
        let url = format!(
            "{}/{}/gifs/{}",
            self.base_url,
            self.api_key.expose_secret(),
            endpoint
        );

        let per_page = PER_PAGE.to_string();
        let page_str = page.to_string();
        let mut params: Vec<(&str, &str)> = vec![
            ("page", &page_str),
            ("per_page", &per_page),
            ("rating", RATING),
        ];
        if let Some(q) = query {
            params.push(("q", q));
        }

        let response = self
            .client
            .get(&url)
            .query(&params)
            .send()
            .await
            .map_err(KlipyError::Http)?;

        let status = response.status();
        if status.is_server_error() {
            return Err(KlipyError::ServerError(status.as_u16()));
        }
        if status.is_client_error() {
            let body = response
                .text()
                .await
                .unwrap_or_else(|_| "<unreadable body>".to_string());
            // WHY cap: this body is logged at error! and stored in the error — a
            // misbehaving/hostile upstream could return megabytes. Char-safe take
            // (never split a UTF-8 boundary) bounds memory and log-line size.
            let body = body.chars().take(MAX_ERROR_BODY_CHARS).collect();
            return Err(KlipyError::ClientError {
                status: status.as_u16(),
                body,
            });
        }

        let envelope: KlipyEnvelope = response.json().await.map_err(KlipyError::Http)?;
        Ok(map_envelope(envelope, fallback_title))
    }
}

// ── Errors ──────────────────────────────────────────────────────

/// Errors from the Klipy API client.
#[derive(Debug, thiserror::Error)]
pub enum KlipyError {
    /// Network or deserialization error from `reqwest`.
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),

    /// Server returned a 5xx status (retryable).
    #[error("Klipy API server error: HTTP {0}")]
    ServerError(u16),

    /// Server returned a 4xx status (non-retryable — bad key / quota).
    #[error("Klipy API client error: HTTP {status} — {body}")]
    ClientError { status: u16, body: String },

    /// All retry attempts were exhausted.
    #[error("Klipy API retries exhausted")]
    RetriesExhausted,

    /// The process-global rolling-window budget is exhausted.
    #[error("Klipy global budget exhausted")]
    BudgetExhausted,
}

impl KlipyError {
    /// Whether this error is transient and the request should be retried.
    #[must_use]
    fn is_retryable(&self) -> bool {
        match self {
            Self::Http(e) => e.is_timeout() || e.is_connect(),
            Self::ServerError(_) => true,
            Self::ClientError { .. } | Self::RetriesExhausted | Self::BudgetExhausted => false,
        }
    }
}

// ── Raw envelope parsing (private) ──────────────────────────────

#[derive(Deserialize)]
struct KlipyEnvelope {
    data: KlipyData,
}

#[derive(Deserialize)]
struct KlipyData {
    #[serde(default)]
    data: Vec<KlipyItem>,
    #[serde(default)]
    current_page: u32,
    #[serde(default)]
    has_next: bool,
}

#[derive(Deserialize)]
struct KlipyItem {
    #[serde(default)]
    slug: String,
    #[serde(default)]
    title: String,
    file: Option<KlipyFile>,
}

/// Size tiers. Only the tiers we actually consume are modeled.
#[derive(Deserialize)]
struct KlipyFile {
    hd: Option<KlipyTier>,
    md: Option<KlipyTier>,
    sm: Option<KlipyTier>,
}

#[derive(Deserialize)]
struct KlipyTier {
    gif: Option<KlipyFormat>,
    webp: Option<KlipyFormat>,
}

#[derive(Deserialize)]
struct KlipyFormat {
    #[serde(default)]
    url: String,
    #[serde(default)]
    width: u32,
    #[serde(default)]
    height: u32,
}

/// Flatten Klipy's tiered envelope into [`KlipyGifPage`].
///
/// Items with no usable animated `gif` in any tier are skipped and logged (a
/// GIF with no renderable format is genuinely unusable — dropping the whole
/// page for one bad item would be worse). Everything else maps deterministically.
fn map_envelope(envelope: KlipyEnvelope, fallback_title: &str) -> KlipyGifPage {
    let data = envelope.data;
    let mut items = Vec::with_capacity(data.data.len());

    for item in data.data {
        let Some(file) = item.file.as_ref() else {
            tracing::warn!(slug = %item.slug, "klipy item missing file — skipped");
            continue;
        };

        // Prefer the medium tier (good quality/size trade-off for a chat grid),
        // fall back to small then hd.
        let Some(gif) = pick_gif(file) else {
            tracing::warn!(slug = %item.slug, "klipy item has no gif format — skipped");
            continue;
        };

        let preview_url = pick_preview(file).unwrap_or_else(|| gif.url.clone());
        let title = if item.title.trim().is_empty() {
            fallback_title.to_string()
        } else {
            item.title
        };

        items.push(KlipyGif {
            id: item.slug,
            title,
            url: gif.url.clone(),
            preview_url,
            width: gif.width,
            height: gif.height,
        });
    }

    KlipyGifPage {
        items,
        has_next: data.has_next,
        // WHY fallback to 1: current_page is defaulted to 0 only if Klipy omits
        // it, which never happens; guard against a nonsensical 0 page anyway.
        page: data.current_page.max(1),
    }
}

/// Pick the best animated gif format: md → sm → hd.
fn pick_gif(file: &KlipyFile) -> Option<&KlipyFormat> {
    [file.md.as_ref(), file.sm.as_ref(), file.hd.as_ref()]
        .into_iter()
        .flatten()
        .find_map(|tier| tier.gif.as_ref().filter(|g| !g.url.is_empty()))
}

/// Pick the best preview URL: md.webp → sm.webp → md.gif → sm.gif.
fn pick_preview(file: &KlipyFile) -> Option<String> {
    let webp = [file.md.as_ref(), file.sm.as_ref()]
        .into_iter()
        .flatten()
        .find_map(|t| t.webp.as_ref())
        .filter(|f| !f.url.is_empty());
    if let Some(w) = webp {
        return Some(w.url.clone());
    }
    let gif = [file.md.as_ref(), file.sm.as_ref()]
        .into_iter()
        .flatten()
        .find_map(|t| t.gif.as_ref())
        .filter(|f| !f.url.is_empty());
    gif.map(|g| g.url.clone())
}

// ── Tests ───────────────────────────────────────────────────────

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    /// A captured-shape fixture mirroring the live Klipy `trending` response
    /// (pinned from a real `curl`, trimmed to the fields we consume).
    fn fixture_json() -> serde_json::Value {
        serde_json::json!({
            "result": true,
            "data": {
                "data": [
                    {
                        "id": 6628111025458995_i64,
                        "slug": "cant-walk-4",
                        "title": "Tiana Can't Walk",
                        "file": {
                            "hd": { "gif": { "url": "https://static.klipy.com/hd.gif", "width": 470, "height": 260 } },
                            "md": {
                                "gif": { "url": "https://static.klipy.com/md.gif", "width": 470, "height": 260 },
                                "webp": { "url": "https://static.klipy.com/md.webp", "width": 470, "height": 260 }
                            },
                            "sm": { "gif": { "url": "https://static.klipy.com/sm.gif", "width": 220, "height": 122 } }
                        }
                    },
                    {
                        "id": 42,
                        "slug": "no-title-item",
                        "title": "",
                        "file": {
                            "sm": { "gif": { "url": "https://static.klipy.com/only-sm.gif", "width": 200, "height": 100 } }
                        }
                    }
                ],
                "current_page": 1,
                "per_page": 24,
                "has_next": true
            }
        })
    }

    #[test]
    fn debug_impl_redacts_api_key() {
        let client =
            KlipyClient::new(SecretString::from("super-secret-key".to_string()), 90).unwrap();
        let debug_output = format!("{client:?}");
        assert!(debug_output.contains("[REDACTED]"));
        assert!(!debug_output.contains("super-secret-key"));
    }

    #[test]
    fn error_is_retryable_for_server_errors() {
        assert!(KlipyError::ServerError(502).is_retryable());
    }

    #[test]
    fn error_is_not_retryable_for_client_errors() {
        let err = KlipyError::ClientError {
            status: 401,
            body: "bad key".to_string(),
        };
        assert!(!err.is_retryable());
    }

    #[test]
    fn error_is_not_retryable_for_budget_or_exhausted() {
        assert!(!KlipyError::BudgetExhausted.is_retryable());
        assert!(!KlipyError::RetriesExhausted.is_retryable());
    }

    #[test]
    fn maps_envelope_to_medium_tier_gif_and_webp_preview() {
        let envelope: KlipyEnvelope = serde_json::from_value(fixture_json()).unwrap();
        let page = map_envelope(envelope, "fallback");

        assert_eq!(page.page, 1);
        assert!(page.has_next);
        assert_eq!(page.items.len(), 2);

        let first = &page.items[0];
        assert_eq!(first.id, "cant-walk-4");
        assert_eq!(first.title, "Tiana Can't Walk");
        // url = md gif, preview = md webp
        assert_eq!(first.url, "https://static.klipy.com/md.gif");
        assert_eq!(first.preview_url, "https://static.klipy.com/md.webp");
        assert_eq!(first.width, 470);
        assert_eq!(first.height, 260);
    }

    #[test]
    fn maps_falls_back_to_small_tier_and_title() {
        let envelope: KlipyEnvelope = serde_json::from_value(fixture_json()).unwrap();
        let page = map_envelope(envelope, "search-query");

        let second = &page.items[1];
        assert_eq!(second.id, "no-title-item");
        // Empty Klipy title → the caller-provided fallback (the search query).
        assert_eq!(second.title, "search-query");
        // No md/hd tier → sm gif; no webp anywhere → gif is its own preview.
        assert_eq!(second.url, "https://static.klipy.com/only-sm.gif");
        assert_eq!(second.preview_url, "https://static.klipy.com/only-sm.gif");
        assert_eq!(second.width, 200);
    }

    #[test]
    fn maps_skips_items_without_any_gif() {
        let json = serde_json::json!({
            "result": true,
            "data": {
                "data": [
                    { "slug": "broken", "title": "no file", "file": null },
                    { "slug": "ok", "title": "good", "file": {
                        "md": { "gif": { "url": "https://static.klipy.com/ok.gif", "width": 1, "height": 1 } }
                    } }
                ],
                "current_page": 2,
                "has_next": false
            }
        });
        let envelope: KlipyEnvelope = serde_json::from_value(json).unwrap();
        let page = map_envelope(envelope, "q");
        assert_eq!(page.page, 2);
        assert!(!page.has_next);
        // The item with no file is dropped; only the usable one survives.
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].id, "ok");
    }

    #[tokio::test]
    async fn global_budget_admits_up_to_max_then_rejects_and_recovers() {
        let budget = GlobalBudget::new(2);
        assert_eq!(budget.try_consume().await, Some(1));
        assert_eq!(budget.try_consume().await, Some(0));
        // Exhausted.
        assert_eq!(budget.try_consume().await, None);

        // Simulate the window fully sliding by back-dating the recorded hits.
        {
            let mut hits = budget.hits.lock().await;
            let old = Instant::now() - BUDGET_WINDOW - Duration::from_secs(1);
            let len = hits.len();
            *hits = VecDeque::from(vec![old; len]);
        }
        // Window drained → a call succeeds again.
        assert_eq!(budget.try_consume().await, Some(1));
    }
}
