//! Client IP resolution for UNAUTHENTICATED rate limiting.
//!
//! Unauth endpoints (invite preview) have no `UserId` to key limits on, so
//! the `SpamGuard` unauth limiter keys on the client IP. Resolution order:
//!
//! 1. `x-harmony-client-ip` — ONLY when the request also carries the
//!    configured shared secret in `x-harmony-proxy-secret`. This is how the
//!    invite OG Cloudflare Pages Function forwards the ORIGINAL client IP:
//!    its server-side fetch reaches the API from Cloudflare egress, which
//!    would otherwise collapse every crawler/visitor into one bucket.
//! 2. `cf-connecting-ip` — set by the Cloudflare proxy for direct browser
//!    traffic in production (router.rs: the API sits behind Cloudflare).
//! 3. First hop of `x-forwarded-for` — self-hosted reverse proxies.
//! 4. The shared `"unattributed"` bucket — deliberately FAIL-CLOSED: traffic
//!    with no attribution shares one budget instead of bypassing the limit.
//!
//! Threat model note: headers 2–3 are spoofable by clients that can reach
//! the origin directly. That degrades an attacker to per-spoofed-IP buckets
//! (bounded memory — entries are swept after the window) and matches the
//! existing edge-rate-limiting trust assumption in `router.rs`.

use std::net::IpAddr;

use axum::http::HeaderMap;
use secrecy::{ExposeSecret, SecretString};
use sha2::{Digest, Sha256};

/// Forwarded original client IP, trusted only with a valid proxy secret.
pub const CLIENT_IP_HEADER: &str = "x-harmony-client-ip";

/// Shared secret proving the request comes from a trusted server-side proxy.
pub const PROXY_SECRET_HEADER: &str = "x-harmony-proxy-secret";

/// Rate-limit bucket for requests with no usable IP attribution.
const UNATTRIBUTED_KEY: &str = "unattributed";

/// Resolve the rate-limit key for an unauthenticated request.
///
/// Always returns a usable key — never fails open (see module docs).
#[must_use]
pub fn resolve_client_key(
    headers: &HeaderMap,
    trusted_proxy_secret: Option<&SecretString>,
) -> String {
    if let Some(secret) = trusted_proxy_secret
        && let Some(presented) = header_str(headers, PROXY_SECRET_HEADER)
        && secrets_match(presented, secret)
        && let Some(ip) = header_ip(headers, CLIENT_IP_HEADER)
    {
        return ip.to_string();
    }

    if let Some(ip) = header_ip(headers, "cf-connecting-ip") {
        return ip.to_string();
    }

    // WHY first hop: `x-forwarded-for` is "client, proxy1, proxy2, ..." —
    // the leftmost entry is the original client as seen by the first proxy.
    if let Some(raw) = header_str(headers, "x-forwarded-for")
        && let Some(first) = raw.split(',').next()
        && let Ok(ip) = first.trim().parse::<IpAddr>()
    {
        return ip.to_string();
    }

    UNATTRIBUTED_KEY.to_string()
}

fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

/// Parse a header value as an IP address. Garbage values are rejected so an
/// attacker cannot mint unbounded arbitrary-string buckets.
fn header_ip(headers: &HeaderMap, name: &str) -> Option<IpAddr> {
    header_str(headers, name).and_then(|v| v.trim().parse::<IpAddr>().ok())
}

/// Constant-time-by-construction secret comparison: comparing fixed-length
/// SHA-256 digests leaks no prefix-length timing signal about the secret.
fn secrets_match(presented: &str, expected: &SecretString) -> bool {
    Sha256::digest(presented.as_bytes()) == Sha256::digest(expected.expose_secret().as_bytes())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic)]
mod tests {
    use axum::http::HeaderValue;

    use super::*;

    fn secret(s: &str) -> SecretString {
        SecretString::from(s.to_string())
    }

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(
                axum::http::HeaderName::from_bytes(name.as_bytes()).unwrap(),
                HeaderValue::from_str(value).unwrap(),
            );
        }
        map
    }

    #[test]
    fn forwarded_ip_trusted_with_valid_secret() {
        let h = headers(&[
            (PROXY_SECRET_HEADER, "s3cret"),
            (CLIENT_IP_HEADER, "203.0.113.7"),
            ("cf-connecting-ip", "198.51.100.1"),
        ]);
        assert_eq!(
            resolve_client_key(&h, Some(&secret("s3cret"))),
            "203.0.113.7"
        );
    }

    #[test]
    fn forwarded_ip_ignored_with_wrong_or_missing_secret() {
        let wrong = headers(&[
            (PROXY_SECRET_HEADER, "nope"),
            (CLIENT_IP_HEADER, "203.0.113.7"),
        ]);
        assert_eq!(
            resolve_client_key(&wrong, Some(&secret("s3cret"))),
            UNATTRIBUTED_KEY
        );

        let missing = headers(&[(CLIENT_IP_HEADER, "203.0.113.7")]);
        assert_eq!(
            resolve_client_key(&missing, Some(&secret("s3cret"))),
            UNATTRIBUTED_KEY
        );
    }

    #[test]
    fn forwarded_ip_ignored_when_no_secret_configured() {
        let h = headers(&[
            (PROXY_SECRET_HEADER, "anything"),
            (CLIENT_IP_HEADER, "203.0.113.7"),
        ]);
        assert_eq!(resolve_client_key(&h, None), UNATTRIBUTED_KEY);
    }

    #[test]
    fn cf_connecting_ip_used_for_direct_proxied_traffic() {
        let h = headers(&[("cf-connecting-ip", "198.51.100.1")]);
        assert_eq!(resolve_client_key(&h, None), "198.51.100.1");
    }

    #[test]
    fn x_forwarded_for_first_hop_used_as_fallback() {
        let h = headers(&[("x-forwarded-for", "203.0.113.7, 10.0.0.1")]);
        assert_eq!(resolve_client_key(&h, None), "203.0.113.7");
    }

    #[test]
    fn garbage_ip_values_fall_through_to_unattributed() {
        let h = headers(&[
            ("cf-connecting-ip", "not-an-ip"),
            ("x-forwarded-for", "also garbage"),
        ]);
        assert_eq!(resolve_client_key(&h, None), UNATTRIBUTED_KEY);
    }

    #[test]
    fn no_headers_resolves_to_unattributed() {
        assert_eq!(
            resolve_client_key(&HeaderMap::new(), None),
            UNATTRIBUTED_KEY
        );
    }

    #[test]
    fn ipv6_forwarded_ip_accepted() {
        let h = headers(&[("cf-connecting-ip", "2001:db8::1")]);
        assert_eq!(resolve_client_key(&h, None), "2001:db8::1");
    }
}
