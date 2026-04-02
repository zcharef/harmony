//! Rate limiting middleware using Governor.
//!
//! Provides per-IP rate limiting for all requests. User-level rate limiting
//! is handled in the service layer (e.g., `MessageService::create`), not here.
//!
//! WHY IP-only: This middleware runs BEFORE auth, so it cannot reliably identify
//! users. Extracting JWT `sub` without signature verification would let attackers
//! forge arbitrary user IDs to hijack rate-limit buckets or create unlimited ones.
//!
//! Uses in-memory state for single-instance deployments.
//! Future: Migrate to Redis for multi-instance deployments.

use std::{
    net::IpAddr,
    num::NonZeroU32,
    sync::Arc,
    task::{Context, Poll},
};

use axum::{
    body::Body,
    extract::ConnectInfo,
    http::{HeaderValue, Request, StatusCode, header},
    response::{IntoResponse, Response},
};
use governor::{
    Quota, RateLimiter, clock::DefaultClock, middleware::NoOpMiddleware, state::InMemoryState,
};
use ipnet::IpNet;
use tower::{Layer, Service};

use crate::api::errors::ProblemDetails;

/// Rate limiter state shared across requests.
///
/// Contains a single per-IP limiter. Per-user limiting lives in the service layer.
#[derive(Debug, Clone)]
pub struct RateLimiterState {
    /// Per-IP limiter for all requests.
    ip_limiter: Arc<
        RateLimiter<String, dashmap::DashMap<String, InMemoryState>, DefaultClock, NoOpMiddleware>,
    >,
    /// Trusted proxy CIDRs. Proxy headers are only used when the peer IP matches.
    trusted_proxies: Arc<Vec<IpNet>>,
}

impl RateLimiterState {
    /// Creates a new rate limiter state with the specified quota.
    ///
    /// # Arguments
    /// * `requests_per_minute` - Requests per minute per IP address.
    /// * `trusted_proxies` - CIDRs of trusted reverse proxies.
    ///
    /// # Panics
    /// Panics if `requests_per_minute` is 0.
    #[must_use]
    #[allow(clippy::expect_used)]
    pub fn new(requests_per_minute: u32, trusted_proxies: Vec<IpNet>) -> Self {
        let quota = Quota::per_minute(
            NonZeroU32::new(requests_per_minute).expect("requests_per_minute must be > 0"),
        );

        Self {
            ip_limiter: Arc::new(RateLimiter::keyed(quota)),
            trusted_proxies: Arc::new(trusted_proxies),
        }
    }

    /// Check rate limit for an IP address.
    ///
    /// # Errors
    /// Returns `Err(retry_after_secs)` if the IP has exceeded its per-minute quota.
    pub fn check_ip(&self, ip: &str) -> Result<(), u64> {
        match self.ip_limiter.check_key(&ip.to_string()) {
            Ok(_) => Ok(()),
            Err(not_until) => {
                let retry_after =
                    not_until.wait_time_from(governor::clock::Clock::now(&DefaultClock::default()));
                Err(retry_after.as_secs().saturating_add(1)) // Round up
            }
        }
    }
}

/// Layer for applying rate limiting middleware.
#[derive(Debug, Clone)]
pub struct RateLimitLayer {
    state: RateLimiterState,
}

impl RateLimitLayer {
    /// Creates a new rate limit layer with the specified quota and trusted proxy list.
    #[must_use]
    pub fn new(requests_per_minute: u32, trusted_proxies: Vec<IpNet>) -> Self {
        Self {
            state: RateLimiterState::new(requests_per_minute, trusted_proxies),
        }
    }
}

impl<S> Layer<S> for RateLimitLayer {
    type Service = RateLimitService<S>;

    fn layer(&self, inner: S) -> Self::Service {
        RateLimitService {
            inner,
            state: self.state.clone(),
        }
    }
}

/// Rate limiting service wrapping inner handler.
#[derive(Debug, Clone)]
pub struct RateLimitService<S> {
    inner: S,
    state: RateLimiterState,
}

impl<S> Service<Request<Body>> for RateLimitService<S>
where
    S: Service<Request<Body>, Response = Response> + Clone + Send + 'static,
    S::Future: Send,
{
    type Response = Response;
    type Error = S::Error;
    type Future = std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Self::Response, Self::Error>> + Send>,
    >;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, req: Request<Body>) -> Self::Future {
        let state = self.state.clone();
        let mut inner = self.inner.clone();

        Box::pin(async move {
            // Extract client IP (only trusts proxy headers when peer is a trusted proxy)
            let client_ip = extract_client_ip(&req, &state.trusted_proxies);

            // Apply IP-based rate limit
            if let Err(retry_after) = state.check_ip(&client_ip) {
                tracing::warn!(
                    client_ip = %client_ip,
                    retry_after_secs = retry_after,
                    "Rate limit exceeded"
                );
                return Ok(rate_limit_response(retry_after));
            }

            // Proceed to handler
            inner.call(req).await
        })
    }
}

/// Extract client IP from request, only trusting proxy headers when the TCP peer
/// matches a configured trusted proxy CIDR.
///
/// WHY: Blindly trusting `X-Forwarded-For` lets any client spoof their IP to bypass
/// rate limits. We only read proxy headers when the direct connection comes from a
/// known reverse proxy (e.g., Fly.io edge, Nginx, Cloudflare).
fn extract_client_ip(req: &Request<Body>, trusted_proxies: &[IpNet]) -> String {
    let peer_ip = req
        .extensions()
        .get::<ConnectInfo<std::net::SocketAddr>>()
        .map(|ci| ci.0.ip());

    // Only trust proxy headers when the peer IP is from a known proxy
    if let Some(peer) = peer_ip {
        if is_trusted_proxy(peer, trusted_proxies) {
            // Peer is a trusted proxy — read forwarded headers
            if let Some(ip) = extract_ip_from_xff(req) {
                return ip;
            }
            if let Some(ip) = extract_ip_from_real_ip(req) {
                return ip;
            }
        }
        // Peer is not a trusted proxy, or no proxy headers — use peer address
        return peer.to_string();
    }

    // No ConnectInfo available (should not happen in production)
    "unknown".to_string()
}

/// Check whether the given IP matches any of the trusted proxy CIDRs.
fn is_trusted_proxy(ip: IpAddr, trusted_proxies: &[IpNet]) -> bool {
    trusted_proxies.iter().any(|cidr| cidr.contains(&ip))
}

/// Extract client IP from `X-Forwarded-For` header.
fn extract_ip_from_xff(req: &Request<Body>) -> Option<String> {
    let xff = req.headers().get("x-forwarded-for")?;
    let xff_str = xff.to_str().ok()?;
    // X-Forwarded-For format: "client, proxy1, proxy2" - first IP is the original client
    let client_ip = xff_str.split(',').next()?.trim();
    if client_ip.is_empty() {
        return None;
    }
    Some(client_ip.to_string())
}

/// Extract client IP from `X-Real-IP` header.
fn extract_ip_from_real_ip(req: &Request<Body>) -> Option<String> {
    let real_ip = req.headers().get("x-real-ip")?;
    let ip = real_ip.to_str().ok()?.trim();
    if ip.is_empty() {
        return None;
    }
    Some(ip.to_string())
}

/// Parse a comma-separated list of CIDRs into a `Vec<IpNet>`.
///
/// Logs a warning and skips any entry that fails to parse.
#[must_use]
pub fn parse_trusted_proxies(raw: &str) -> Vec<IpNet> {
    raw.split(',')
        .filter_map(|entry| {
            let trimmed = entry.trim();
            if trimmed.is_empty() {
                return None;
            }
            match trimmed.parse::<IpNet>() {
                Ok(net) => Some(net),
                Err(e) => {
                    tracing::warn!(
                        entry = trimmed,
                        error = %e,
                        "Ignoring invalid CIDR in TRUSTED_PROXIES"
                    );
                    None
                }
            }
        })
        .collect()
}

/// Build a 429 Too Many Requests response with RFC 9457 `ProblemDetails`.
fn rate_limit_response(retry_after_secs: u64) -> Response {
    let problem = ProblemDetails::new(
        StatusCode::TOO_MANY_REQUESTS,
        "Too Many Requests",
        format!(
            "Rate limit exceeded. Please retry after {} seconds.",
            retry_after_secs
        ),
    );

    let body = serde_json::to_vec(&problem).unwrap_or_else(|_| {
        br#"{"type":"about:blank","title":"Too Many Requests","status":429,"detail":"Rate limit exceeded"}"#.to_vec()
    });
    let mut response = (StatusCode::TOO_MANY_REQUESTS, body).into_response();

    // RFC 9457 Content-Type
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/problem+json"),
    );

    // Retry-After header (RFC 7231 Section 7.1.3)
    if let Ok(val) = HeaderValue::from_str(&retry_after_secs.to_string()) {
        response.headers_mut().insert(header::RETRY_AFTER, val);
    }

    response
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn test_rate_limiter_allows_under_quota() {
        let state = RateLimiterState::new(10, vec![]);

        // Should allow first request
        assert!(state.check_ip("192.168.1.1").is_ok());
    }

    #[test]
    fn test_rate_limiter_blocks_over_quota() {
        let state = RateLimiterState::new(2, vec![]);

        // First two requests allowed
        assert!(state.check_ip("192.168.1.1").is_ok());
        assert!(state.check_ip("192.168.1.1").is_ok());

        // Third request blocked
        let result = state.check_ip("192.168.1.1");
        assert!(result.is_err());
        assert!(result.unwrap_err() > 0); // Retry-after should be positive
    }

    #[test]
    fn test_different_ips_have_separate_quotas() {
        let state = RateLimiterState::new(1, vec![]);

        // First IP exhausts quota
        assert!(state.check_ip("192.168.1.1").is_ok());
        assert!(state.check_ip("192.168.1.1").is_err());

        // Second IP still has quota
        assert!(state.check_ip("192.168.1.2").is_ok());
    }

    #[test]
    fn test_extract_client_ip_ignores_xff_without_trusted_proxy() {
        // WHY: Without trusted proxies configured, X-Forwarded-For must be ignored
        // to prevent IP spoofing attacks.
        let req = Request::builder()
            .header(
                "x-forwarded-for",
                "203.0.113.195, 70.41.3.18, 150.172.238.178",
            )
            .body(Body::empty())
            .unwrap();

        let ip = extract_client_ip(&req, &[]);
        // No ConnectInfo and no trusted proxy => falls back to "unknown"
        assert_eq!(ip, "unknown");
    }

    #[test]
    fn test_extract_client_ip_uses_xff_with_trusted_proxy() {
        let trusted: Vec<IpNet> = vec!["10.0.0.0/8".parse().unwrap()];

        let mut req = Request::builder()
            .header("x-forwarded-for", "203.0.113.195, 10.0.0.1")
            .body(Body::empty())
            .unwrap();

        // Simulate ConnectInfo from a trusted proxy
        req.extensions_mut()
            .insert(ConnectInfo(std::net::SocketAddr::from((
                [10, 0, 0, 1],
                12345,
            ))));

        let ip = extract_client_ip(&req, &trusted);
        assert_eq!(ip, "203.0.113.195");
    }

    #[test]
    fn test_extract_client_ip_ignores_xff_from_untrusted_peer() {
        let trusted: Vec<IpNet> = vec!["10.0.0.0/8".parse().unwrap()];

        let mut req = Request::builder()
            .header("x-forwarded-for", "203.0.113.195")
            .body(Body::empty())
            .unwrap();

        // Simulate ConnectInfo from an untrusted IP (attacker)
        req.extensions_mut()
            .insert(ConnectInfo(std::net::SocketAddr::from((
                [192, 168, 1, 100],
                54321,
            ))));

        let ip = extract_client_ip(&req, &trusted);
        // Must use peer address, NOT the spoofed X-Forwarded-For
        assert_eq!(ip, "192.168.1.100");
    }

    #[test]
    fn test_extract_client_ip_uses_real_ip_with_trusted_proxy() {
        let trusted: Vec<IpNet> = vec!["172.16.0.0/12".parse().unwrap()];

        let mut req = Request::builder()
            .header("x-real-ip", "8.8.8.8")
            .body(Body::empty())
            .unwrap();

        req.extensions_mut()
            .insert(ConnectInfo(std::net::SocketAddr::from((
                [172, 20, 0, 1],
                12345,
            ))));

        let ip = extract_client_ip(&req, &trusted);
        assert_eq!(ip, "8.8.8.8");
    }

    #[test]
    fn test_extract_client_ip_peer_fallback() {
        let mut req = Request::builder().body(Body::empty()).unwrap();

        req.extensions_mut()
            .insert(ConnectInfo(std::net::SocketAddr::from((
                [127, 0, 0, 1],
                12345,
            ))));

        let ip = extract_client_ip(&req, &[]);
        assert_eq!(ip, "127.0.0.1");
    }

    #[test]
    fn test_extract_client_ip_no_connect_info_fallback() {
        let req = Request::builder().body(Body::empty()).unwrap();

        let ip = extract_client_ip(&req, &[]);
        assert_eq!(ip, "unknown");
    }

    #[test]
    fn test_is_trusted_proxy_matches_cidr() {
        let trusted: Vec<IpNet> = vec![
            "10.0.0.0/8".parse().unwrap(),
            "172.16.0.0/12".parse().unwrap(),
        ];

        assert!(is_trusted_proxy("10.0.0.1".parse().unwrap(), &trusted));
        assert!(is_trusted_proxy(
            "10.255.255.255".parse().unwrap(),
            &trusted
        ));
        assert!(is_trusted_proxy("172.20.0.1".parse().unwrap(), &trusted));
        assert!(!is_trusted_proxy("192.168.1.1".parse().unwrap(), &trusted));
        assert!(!is_trusted_proxy("8.8.8.8".parse().unwrap(), &trusted));
    }

    #[test]
    fn test_is_trusted_proxy_empty_list() {
        assert!(!is_trusted_proxy("10.0.0.1".parse().unwrap(), &[]));
    }

    #[test]
    fn test_parse_trusted_proxies_valid() {
        let result = parse_trusted_proxies("10.0.0.0/8, 172.16.0.0/12");
        assert_eq!(result.len(), 2);
        assert_eq!(result[0], "10.0.0.0/8".parse::<IpNet>().unwrap());
        assert_eq!(result[1], "172.16.0.0/12".parse::<IpNet>().unwrap());
    }

    #[test]
    fn test_parse_trusted_proxies_empty() {
        let result = parse_trusted_proxies("");
        assert!(result.is_empty());
    }

    #[test]
    fn test_parse_trusted_proxies_skips_invalid() {
        // "not-a-cidr" is invalid, should be skipped with a warning
        let result = parse_trusted_proxies("10.0.0.0/8, not-a-cidr, 172.16.0.0/12");
        assert_eq!(result.len(), 2);
    }

    #[test]
    fn test_parse_trusted_proxies_single_ip() {
        // Single IPs without prefix length should parse as /32
        let result = parse_trusted_proxies("10.0.0.1/32");
        assert_eq!(result.len(), 1);
    }
}
