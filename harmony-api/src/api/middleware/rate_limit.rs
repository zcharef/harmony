//! Rate limiting middleware using Governor.
//!
//! Provides per-IP rate limiting for unauthenticated requests and
//! per-user rate limiting for authenticated requests.
//!
//! Uses in-memory state for single-instance deployments.
//! Future: Migrate to Redis for multi-instance deployments.

use std::{
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
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use governor::{
    Quota, RateLimiter, clock::DefaultClock, middleware::NoOpMiddleware, state::InMemoryState,
};
use tower::{Layer, Service};

use crate::api::errors::ProblemDetails;

/// Session cookie name (must match the value in `extractors.rs`).
const SESSION_COOKIE_NAME: &str = "session";

/// Rate limiter state shared across requests.
///
/// Contains separate limiters for IP-based (unauthenticated) and
/// user-based (authenticated) rate limiting.
#[derive(Debug, Clone)]
pub struct RateLimiterState {
    /// Per-IP limiter for unauthenticated requests.
    ip_limiter: Arc<
        RateLimiter<String, dashmap::DashMap<String, InMemoryState>, DefaultClock, NoOpMiddleware>,
    >,
    /// Per-user limiter for authenticated requests.
    user_limiter: Arc<
        RateLimiter<String, dashmap::DashMap<String, InMemoryState>, DefaultClock, NoOpMiddleware>,
    >,
}

impl RateLimiterState {
    /// Creates a new rate limiter state with the specified quotas.
    ///
    /// # Arguments
    /// * `ip_quota` - Requests per minute for unauthenticated (IP-based) limiting.
    /// * `user_quota` - Requests per minute for authenticated (user-based) limiting.
    /// # Panics
    /// Panics if either rate is 0.
    #[must_use]
    #[allow(clippy::expect_used)]
    pub fn new(ip_requests_per_minute: u32, user_requests_per_minute: u32) -> Self {
        let ip_quota = Quota::per_minute(
            NonZeroU32::new(ip_requests_per_minute).expect("ip_requests_per_minute must be > 0"),
        );
        let user_quota = Quota::per_minute(
            NonZeroU32::new(user_requests_per_minute)
                .expect("user_requests_per_minute must be > 0"),
        );

        Self {
            ip_limiter: Arc::new(RateLimiter::keyed(ip_quota)),
            user_limiter: Arc::new(RateLimiter::keyed(user_quota)),
        }
    }

    /// Check rate limit for an IP address (unauthenticated requests).
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

    /// Check rate limit for a user ID (authenticated requests).
    ///
    /// # Errors
    /// Returns `Err(retry_after_secs)` if the user has exceeded their per-minute quota.
    pub fn check_user(&self, user_id: &str) -> Result<(), u64> {
        match self.user_limiter.check_key(&user_id.to_string()) {
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
    /// Creates a new rate limit layer with the specified quotas.
    #[must_use]
    pub fn new(ip_requests_per_minute: u32, user_requests_per_minute: u32) -> Self {
        Self {
            state: RateLimiterState::new(ip_requests_per_minute, user_requests_per_minute),
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
            // 1. Try to extract user ID from auth (cookie or bearer)
            let user_id = extract_user_id_from_request(&req);

            // 2. Extract client IP (X-Forwarded-For or peer address)
            let client_ip = extract_client_ip(&req);

            // 3. Apply rate limit based on authentication status
            let rate_limit_result = if let Some(ref uid) = user_id {
                // Authenticated: use per-user limiter (higher quota)
                state.check_user(uid)
            } else {
                // Unauthenticated: use per-IP limiter
                state.check_ip(&client_ip)
            };

            // 4. If rate limited, return 429 with Retry-After
            if let Err(retry_after) = rate_limit_result {
                tracing::warn!(
                    client_ip = %client_ip,
                    user_id = ?user_id,
                    retry_after_secs = retry_after,
                    "Rate limit exceeded"
                );
                return Ok(rate_limit_response(retry_after));
            }

            // 5. Proceed to handler
            inner.call(req).await
        })
    }
}

/// Extract user ID from request headers (cookie or bearer token).
///
/// This mirrors the logic in `AuthUser` extractor but without async DB lookup.
/// For rate limiting, we only need the claimed user ID, not full validation.
fn extract_user_id_from_request(req: &Request<Body>) -> Option<String> {
    // 1. Try cookie first (web clients)
    if let Some(user_id) = extract_user_from_cookie(req) {
        return Some(user_id);
    }

    // 2. Try Authorization Bearer header (mobile clients)
    extract_user_from_bearer(req)
}

/// Extract user ID from session cookie.
///
/// WHY: The session token format is `{uid}.{flags}.{expiry}.{hmac}`.
/// We extract the uid (first segment) as a stable rate limit key instead
/// of using the full cookie value, which changes on every session refresh.
fn extract_user_from_cookie(req: &Request<Body>) -> Option<String> {
    let cookie_header = req.headers().get(header::COOKIE)?;
    let cookie_str = cookie_header.to_str().ok()?;
    let prefix = format!("{}=", SESSION_COOKIE_NAME);

    for cookie in cookie_str.split(';') {
        let cookie = cookie.trim();
        if let Some(value) = cookie.strip_prefix(&prefix)
            && !value.is_empty()
        {
            // Extract uid from the first dot-separated segment of the session token.
            let uid = value.split('.').next()?;
            if !uid.is_empty() {
                return Some(uid.to_string());
            }
        }
    }
    None
}

/// Extract user ID from Authorization Bearer header.
///
/// WHY: We extract the `sub` claim from the JWT payload without full verification
/// (auth middleware handles that). This ensures users who rotate tokens still
/// share a single rate limit bucket keyed by their stable user ID.
fn extract_user_from_bearer(req: &Request<Body>) -> Option<String> {
    let auth_header = req.headers().get(header::AUTHORIZATION)?;
    let auth_str = auth_header.to_str().ok()?;
    let token = auth_str.strip_prefix("Bearer ")?;

    if token.is_empty() {
        return None;
    }

    extract_sub_from_jwt(token)
}

/// Extract the `sub` claim from a JWT payload without signature verification.
///
/// JWTs have three base64url-encoded segments: `header.payload.signature`.
/// We decode only the payload (middle segment) and read the `sub` field.
fn extract_sub_from_jwt(token: &str) -> Option<String> {
    let segments: Vec<&str> = token.splitn(4, '.').collect();
    if segments.len() < 3 {
        return None;
    }

    let payload_bytes = URL_SAFE_NO_PAD.decode(segments[1]).ok()?;
    let payload: serde_json::Value = serde_json::from_slice(&payload_bytes).ok()?;
    let sub = payload.get("sub")?.as_str()?;

    if sub.is_empty() {
        return None;
    }

    Some(sub.to_string())
}

/// Extract client IP from X-Forwarded-For header or peer address.
///
/// When behind Nginx/load balancer, the real client IP is in X-Forwarded-For.
/// Falls back to peer address if no proxy header present.
fn extract_client_ip(req: &Request<Body>) -> String {
    // 1. Check X-Forwarded-For (from reverse proxy)
    if let Some(ip) = extract_ip_from_xff(req) {
        return ip;
    }

    // 2. Check X-Real-IP (alternative proxy header)
    if let Some(ip) = extract_ip_from_real_ip(req) {
        return ip;
    }

    // 3. Fall back to peer address from extensions
    if let Some(connect_info) = req.extensions().get::<ConnectInfo<std::net::SocketAddr>>() {
        return connect_info.0.ip().to_string();
    }

    // 4. Ultimate fallback (should not happen in production)
    "unknown".to_string()
}

/// Extract client IP from X-Forwarded-For header.
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

/// Extract client IP from X-Real-IP header.
fn extract_ip_from_real_ip(req: &Request<Body>) -> Option<String> {
    let real_ip = req.headers().get("x-real-ip")?;
    let ip = real_ip.to_str().ok()?.trim();
    if ip.is_empty() {
        return None;
    }
    Some(ip.to_string())
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
        let state = RateLimiterState::new(10, 50);

        // Should allow first request
        assert!(state.check_ip("192.168.1.1").is_ok());
        assert!(state.check_user("user123").is_ok());
    }

    #[test]
    fn test_rate_limiter_blocks_over_quota() {
        let state = RateLimiterState::new(2, 2);

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
        let state = RateLimiterState::new(1, 1);

        // First IP exhausts quota
        assert!(state.check_ip("192.168.1.1").is_ok());
        assert!(state.check_ip("192.168.1.1").is_err());

        // Second IP still has quota
        assert!(state.check_ip("192.168.1.2").is_ok());
    }

    #[test]
    fn test_different_users_have_separate_quotas() {
        let state = RateLimiterState::new(1, 1);

        // First user exhausts quota
        assert!(state.check_user("user1").is_ok());
        assert!(state.check_user("user1").is_err());

        // Second user still has quota
        assert!(state.check_user("user2").is_ok());
    }

    /// Build a minimal JWT with the given `sub` claim (no signature verification needed).
    fn build_test_jwt(sub: &str) -> String {
        let header = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(br#"{"alg":"HS256","typ":"JWT"}"#);
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(format!(r#"{{"sub":"{sub}","role":"authenticated"}}"#).as_bytes());
        let signature = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b"fake-sig");
        format!("{header}.{payload}.{signature}")
    }

    #[test]
    fn test_extract_user_id_from_bearer() {
        let jwt = build_test_jwt("user-uuid-123");
        let req = Request::builder()
            .header(header::AUTHORIZATION, format!("Bearer {jwt}"))
            .body(Body::empty())
            .unwrap();

        let user_id = extract_user_id_from_request(&req);
        assert_eq!(user_id, Some("user-uuid-123".to_string()));
    }

    #[test]
    fn test_extract_user_id_from_bearer_non_jwt_falls_back_to_none() {
        let req = Request::builder()
            .header(header::AUTHORIZATION, "Bearer not-a-jwt-token")
            .body(Body::empty())
            .unwrap();

        let user_id = extract_user_id_from_request(&req);
        assert!(user_id.is_none());
    }

    #[test]
    fn test_extract_sub_from_jwt() {
        let jwt = build_test_jwt("abc-def-123");
        assert_eq!(extract_sub_from_jwt(&jwt), Some("abc-def-123".to_string()));
    }

    #[test]
    fn test_extract_sub_from_jwt_missing_sub() {
        let header = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(br#"{"alg":"HS256"}"#);
        let payload =
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(br#"{"role":"authenticated"}"#);
        let sig = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b"sig");
        let jwt = format!("{header}.{payload}.{sig}");
        assert_eq!(extract_sub_from_jwt(&jwt), None);
    }

    #[test]
    fn test_extract_sub_from_jwt_invalid_base64() {
        assert_eq!(extract_sub_from_jwt("a.!!!invalid.c"), None);
    }

    #[test]
    fn test_extract_user_id_from_cookie() {
        // Session token format: {uid}.{flags}.{expiry}.{hmac}
        let req = Request::builder()
            .header(
                header::COOKIE,
                format!(
                    "{}=cookie_user_456.0.9999999999.deadbeef; other=value",
                    SESSION_COOKIE_NAME
                ),
            )
            .body(Body::empty())
            .unwrap();

        let user_id = extract_user_id_from_request(&req);
        assert_eq!(user_id, Some("cookie_user_456".to_string()));
    }

    #[test]
    fn test_extract_user_id_no_auth() {
        let req = Request::builder().body(Body::empty()).unwrap();

        let user_id = extract_user_id_from_request(&req);
        assert!(user_id.is_none());
    }

    #[test]
    fn test_extract_client_ip_from_xff() {
        let req = Request::builder()
            .header(
                "x-forwarded-for",
                "203.0.113.195, 70.41.3.18, 150.172.238.178",
            )
            .body(Body::empty())
            .unwrap();

        let ip = extract_client_ip(&req);
        assert_eq!(ip, "203.0.113.195");
    }

    #[test]
    fn test_extract_client_ip_from_real_ip() {
        let req = Request::builder()
            .header("x-real-ip", "10.0.0.1")
            .body(Body::empty())
            .unwrap();

        let ip = extract_client_ip(&req);
        assert_eq!(ip, "10.0.0.1");
    }

    #[test]
    fn test_extract_client_ip_fallback() {
        let req = Request::builder().body(Body::empty()).unwrap();

        let ip = extract_client_ip(&req);
        assert_eq!(ip, "unknown");
    }
}
