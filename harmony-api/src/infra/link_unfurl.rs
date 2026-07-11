//! SSRF-safe link unfurler (Open Graph / twitter-card fetcher + parser).
//!
//! Security posture (the heart of the link-preview feature):
//! - DNS is resolved HERE, every resolved address is validated against the
//!   forbidden ranges (private, loopback, link-local, CGNAT, metadata — IPv4
//!   AND IPv6, including IPv4-mapped/NAT64 forms), and the connection is
//!   PINNED to the vetted addresses via `resolve_to_addrs` so a
//!   resolve-then-connect TOCTOU rebind is impossible.
//! - Redirects are followed manually (max [`MAX_REDIRECTS`]); every hop goes
//!   back through the same resolve-validate-pin funnel, so a public page
//!   redirecting to an internal address is rejected mid-chain.
//! - One total time budget ([`FETCH_TIMEOUT`]) across all hops, a hard body
//!   cap ([`MAX_BODY_BYTES`]) enforced while streaming, `text/html` only,
//!   no cookies/credentials, a stable bot User-Agent.

use std::net::{IpAddr, SocketAddr};
use std::sync::OnceLock;
use std::time::Duration;

use regex::Regex;
use url::Url;

use crate::domain::models::UnfurledPage;

/// Maximum redirect hops before giving up.
pub const MAX_REDIRECTS: usize = 3;

/// Total time budget for the whole unfurl (all hops + body read).
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(5);

/// Hard response-body cap (bytes). OG metadata lives in `<head>`, so 2 MB is
/// generous; anything larger is truncated at the cap and parsed as-is.
pub const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;

/// Stable User-Agent identifying the unfurler to remote sites.
const USER_AGENT: &str = "HarmonyLinkBot/1.0 (+https://joinharmony.app)";

/// Field length caps (chars) — keeps rows and the SSE envelope bounded.
const MAX_TITLE_CHARS: usize = 300;
const MAX_DESCRIPTION_CHARS: usize = 500;
const MAX_SITE_NAME_CHARS: usize = 200;
const MAX_IMAGE_URL_CHARS: usize = 1000;

/// Why an unfurl failed. Everything is non-retryable from the caller's
/// perspective (failures are cached to avoid refetch storms).
#[derive(Debug, thiserror::Error)]
pub enum UnfurlError {
    #[error("invalid URL: {0}")]
    InvalidUrl(String),
    #[error("URL target is not publicly routable")]
    ForbiddenAddress,
    #[error("DNS resolution failed: {0}")]
    DnsFailure(String),
    #[error("too many redirects")]
    TooManyRedirects,
    #[error("unsupported content type: {0}")]
    UnsupportedContentType(String),
    #[error("upstream returned status {0}")]
    UpstreamStatus(u16),
    #[error("fetch failed: {0}")]
    Fetch(String),
    #[error("fetch timed out")]
    Timeout,
}

/// Normalize a URL for cache keying: lowercase scheme/host (done by the
/// WHATWG parser), drop the fragment, keep path + query verbatim.
///
/// # Errors
/// Returns [`UnfurlError::InvalidUrl`] when the input does not parse as an
/// absolute http(s) URL with a host.
pub fn normalize_url(raw: &str) -> Result<Url, UnfurlError> {
    let mut url = Url::parse(raw).map_err(|e| UnfurlError::InvalidUrl(e.to_string()))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(UnfurlError::InvalidUrl(format!(
            "unsupported scheme: {}",
            url.scheme()
        )));
    }
    if url.host_str().is_none() {
        return Err(UnfurlError::InvalidUrl("missing host".to_string()));
    }
    // WHY reject userinfo: `https://user:pass@host/` smuggles credentials and
    // confuses host parsing downstream — previews never need it.
    if !url.username().is_empty() || url.password().is_some() {
        return Err(UnfurlError::InvalidUrl(
            "userinfo is not allowed".to_string(),
        ));
    }
    url.set_fragment(None);
    Ok(url)
}

/// Whether an IP address must be REJECTED as an unfurl target.
///
/// Covers (IPv4): unspecified, loopback 127/8, RFC1918 (10/8, 172.16/12,
/// 192.168/16), link-local + cloud metadata 169.254/16, CGNAT 100.64/10,
/// benchmarking 198.18/15, multicast 224/4, reserved 240/4, broadcast.
/// Covers (IPv6): unspecified, loopback `::1`, unique-local `fc00::/7`,
/// link-local `fe80::/10`, multicast `ff00::/8`, and any IPv4-mapped
/// (`::ffff:a.b.c.d`) or NAT64 (`64:ff9b::/96`) form of a forbidden IPv4.
#[must_use]
pub fn ip_is_forbidden(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let octets = v4.octets();
            v4.is_unspecified()
                || v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_multicast()
                // CGNAT 100.64.0.0/10 (RFC 6598)
                || (octets[0] == 100 && (octets[1] & 0xC0) == 64)
                // Benchmarking 198.18.0.0/15 (RFC 2544)
                || (octets[0] == 198 && (octets[1] & 0xFE) == 18)
                // Reserved 240.0.0.0/4 (RFC 1112)
                || octets[0] >= 240
        }
        IpAddr::V6(v6) => {
            let segments = v6.segments();
            // IPv4-mapped (::ffff:a.b.c.d) — validate the embedded IPv4.
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return ip_is_forbidden(IpAddr::V4(mapped));
            }
            // NAT64 well-known prefix 64:ff9b::/96 — embedded IPv4 in the tail.
            if segments[0] == 0x64 && segments[1] == 0xff9b && segments[2..6] == [0, 0, 0, 0] {
                let [a, b] = segments[6].to_be_bytes();
                let [c, d] = segments[7].to_be_bytes();
                return ip_is_forbidden(IpAddr::V4(std::net::Ipv4Addr::new(a, b, c, d)));
            }
            v6.is_unspecified()
                || v6.is_loopback()
                // Unique-local fc00::/7
                || (segments[0] & 0xFE00) == 0xFC00
                // Link-local fe80::/10
                || (segments[0] & 0xFFC0) == 0xFE80
                // Multicast ff00::/8
                || (segments[0] & 0xFF00) == 0xFF00
        }
    }
}

/// SSRF-safe HTTP unfurler.
pub struct LinkUnfurler {
    /// Test-only escape hatch: permit loopback targets (127/8, `::1`) so unit /
    /// integration tests can serve pages from a local `wiremock`. EVERY OTHER
    /// forbidden range stays rejected, so redirect re-validation is still
    /// exercised for real. Never enabled in production wiring.
    allow_loopback: bool,
}

impl std::fmt::Debug for LinkUnfurler {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LinkUnfurler")
            .field("allow_loopback", &self.allow_loopback)
            .finish()
    }
}

impl Default for LinkUnfurler {
    fn default() -> Self {
        Self::new()
    }
}

impl LinkUnfurler {
    /// Production unfurler: full forbidden-range enforcement.
    #[must_use]
    pub fn new() -> Self {
        Self {
            allow_loopback: false,
        }
    }

    /// Test-only constructor allowing loopback targets (local wiremock).
    #[must_use]
    pub fn new_allowing_loopback_for_tests() -> Self {
        Self {
            allow_loopback: true,
        }
    }

    fn is_forbidden(&self, ip: IpAddr) -> bool {
        if self.allow_loopback {
            let is_loopback = match ip {
                IpAddr::V4(v4) => v4.is_loopback(),
                IpAddr::V6(v6) => v6.is_loopback(),
            };
            if is_loopback {
                return false;
            }
        }
        ip_is_forbidden(ip)
    }

    /// Resolve `url`'s host and return the vetted socket addresses to pin the
    /// connection to. Rejects when ANY resolved address is forbidden — a
    /// half-poisoned DNS answer must not be reachable via happy-eyeballs.
    async fn resolve_and_validate(&self, url: &Url) -> Result<Vec<SocketAddr>, UnfurlError> {
        let host = url
            .host_str()
            .ok_or_else(|| UnfurlError::InvalidUrl("missing host".to_string()))?;
        let port = url.port_or_known_default().unwrap_or(443);

        // IP-literal hosts skip DNS but not validation.
        if let Ok(ip) = host.trim_matches(['[', ']']).parse::<IpAddr>() {
            if self.is_forbidden(ip) {
                return Err(UnfurlError::ForbiddenAddress);
            }
            return Ok(vec![SocketAddr::new(ip, port)]);
        }

        let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host, port))
            .await
            .map_err(|e| UnfurlError::DnsFailure(e.to_string()))?
            .collect();
        if addrs.is_empty() {
            return Err(UnfurlError::DnsFailure("no addresses".to_string()));
        }
        if addrs.iter().any(|a| self.is_forbidden(a.ip())) {
            return Err(UnfurlError::ForbiddenAddress);
        }
        Ok(addrs)
    }

    /// Fetch one hop with the connection pinned to pre-validated addresses.
    async fn fetch_hop(
        &self,
        url: &Url,
        budget: Duration,
    ) -> Result<reqwest::Response, UnfurlError> {
        let addrs = self.resolve_and_validate(url).await?;
        let host = url
            .host_str()
            .ok_or_else(|| UnfurlError::InvalidUrl("missing host".to_string()))?;

        // WHY a fresh client per hop: `resolve_to_addrs` pins THIS hop's host
        // to THIS hop's vetted addresses — reqwest will not re-resolve, which
        // closes the validate-then-connect TOCTOU window. Redirects are
        // disabled so every Location goes back through this funnel.
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .resolve_to_addrs(host, &addrs)
            .timeout(budget)
            .user_agent(USER_AGENT)
            .build()
            .map_err(|e| UnfurlError::Fetch(e.to_string()))?;

        client
            .get(url.clone())
            .header(reqwest::header::ACCEPT, "text/html")
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    UnfurlError::Timeout
                } else {
                    UnfurlError::Fetch(e.to_string())
                }
            })
    }

    /// Unfurl a page: follow up to [`MAX_REDIRECTS`] (re-validating the target
    /// address on every hop), stream at most [`MAX_BODY_BYTES`] of `text/html`,
    /// and parse Open Graph / twitter-card / `<title>` metadata.
    ///
    /// # Errors
    /// Returns an [`UnfurlError`] describing the first hard failure (invalid
    /// URL, forbidden target, redirect overflow, non-HTML, upstream error,
    /// timeout).
    pub async fn unfurl(&self, raw_url: &str) -> Result<UnfurledPage, UnfurlError> {
        let started = tokio::time::Instant::now();
        let mut current = normalize_url(raw_url)?;

        for _hop in 0..=MAX_REDIRECTS {
            let budget = FETCH_TIMEOUT
                .checked_sub(started.elapsed())
                .ok_or(UnfurlError::Timeout)?;
            let response = self.fetch_hop(&current, budget).await?;
            let status = response.status();

            if status.is_redirection() {
                let location = response
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|v| v.to_str().ok())
                    .ok_or(UnfurlError::Fetch("redirect without Location".to_string()))?;
                // Relative Locations resolve against the current URL; the next
                // loop iteration re-validates the new target's addresses.
                let next = current
                    .join(location)
                    .map_err(|e| UnfurlError::InvalidUrl(e.to_string()))?;
                current = normalize_url(next.as_str())?;
                continue;
            }

            if !status.is_success() {
                return Err(UnfurlError::UpstreamStatus(status.as_u16()));
            }

            let content_type = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_ascii_lowercase();
            if !content_type.starts_with("text/html")
                && !content_type.starts_with("application/xhtml+xml")
            {
                return Err(UnfurlError::UnsupportedContentType(content_type));
            }

            let body = read_capped_body(response).await?;
            return Ok(parse_metadata(&body, &current));
        }

        Err(UnfurlError::TooManyRedirects)
    }
}

/// Stream the body, stopping at [`MAX_BODY_BYTES`]. Oversized pages are
/// truncated (OG tags live in `<head>`), never buffered whole.
async fn read_capped_body(mut response: reqwest::Response) -> Result<String, UnfurlError> {
    let mut buf: Vec<u8> = Vec::with_capacity(64 * 1024);
    while let Some(chunk) = response.chunk().await.map_err(|e| {
        if e.is_timeout() {
            UnfurlError::Timeout
        } else {
            UnfurlError::Fetch(e.to_string())
        }
    })? {
        let remaining = MAX_BODY_BYTES - buf.len();
        if chunk.len() >= remaining {
            buf.extend_from_slice(&chunk[..remaining]);
            break;
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

// ── Metadata parsing (Open Graph → twitter-card → HTML fallback) ──

fn meta_tag_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        #[allow(clippy::expect_used)]
        Regex::new(r"(?is)<meta\s[^>]*>").expect("hardcoded meta regex is valid")
    })
}

fn attr_regex(name: &'static str) -> Regex {
    #[allow(clippy::expect_used)]
    Regex::new(&format!(r#"(?is){name}\s*=\s*("([^"]*)"|'([^']*)')"#))
        .expect("hardcoded attr regex is valid")
}

fn key_attr_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| attr_regex("(?:property|name)"))
}

fn content_attr_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| attr_regex("content"))
}

fn title_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        #[allow(clippy::expect_used)]
        Regex::new(r"(?is)<title[^>]*>(.*?)</title>").expect("hardcoded title regex is valid")
    })
}

/// Decode the entity forms that matter for metadata text (`&amp;`, `&lt;`,
/// `&gt;`, `&quot;`, `&#39;`/`&apos;`, numeric). Unknown entities pass through.
fn decode_entities(input: &str) -> String {
    static NUMERIC: OnceLock<Regex> = OnceLock::new();
    let numeric = NUMERIC.get_or_init(|| {
        #[allow(clippy::expect_used)]
        Regex::new(r"&#(x[0-9a-fA-F]{1,6}|\d{1,7});").expect("hardcoded entity regex is valid")
    });
    let with_numeric = numeric.replace_all(input, |caps: &regex::Captures<'_>| {
        let body = &caps[1];
        let code = if let Some(hex) = body.strip_prefix(['x', 'X']) {
            u32::from_str_radix(hex, 16).ok()
        } else {
            body.parse::<u32>().ok()
        };
        code.and_then(char::from_u32)
            .map_or_else(|| caps[0].to_string(), |c| c.to_string())
    });
    with_numeric
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
}

/// Collapse whitespace runs, strip control chars, decode entities, and cap to
/// `max_chars` (on a char boundary). Returns `None` when nothing remains —
/// stored fields are text-only (the client renders them as text nodes).
fn clean_text(raw: &str, max_chars: usize) -> Option<String> {
    let decoded = decode_entities(raw);
    let collapsed: String = decoded
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .filter(|c| !c.is_control())
        .take(max_chars)
        .collect();
    let trimmed = collapsed.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Validate/resolve a thumbnail URL: relative values join against the page
/// URL; the result must be absolute http(s) and within the length cap.
fn clean_image_url(raw: &str, base: &Url) -> Option<String> {
    let decoded = decode_entities(raw.trim());
    let resolved = base.join(&decoded).ok()?;
    if resolved.scheme() != "http" && resolved.scheme() != "https" {
        return None;
    }
    let s = resolved.to_string();
    if s.chars().count() > MAX_IMAGE_URL_CHARS {
        return None;
    }
    Some(s)
}

/// Parse OG / twitter-card metadata with `<title>` + meta-description
/// fallback. Pure function — table-driven tests below.
#[must_use]
pub fn parse_metadata(html: &str, page_url: &Url) -> UnfurledPage {
    let mut og_title = None;
    let mut og_description = None;
    let mut og_site_name = None;
    let mut og_image = None;
    let mut tw_title = None;
    let mut tw_description = None;
    let mut tw_image = None;
    let mut meta_description = None;

    for tag in meta_tag_regex().find_iter(html) {
        let tag = tag.as_str();
        let Some(key_caps) = key_attr_regex().captures(tag) else {
            continue;
        };
        let key = key_caps
            .get(2)
            .or_else(|| key_caps.get(3))
            .map(|m| m.as_str().trim().to_ascii_lowercase())
            .unwrap_or_default();
        let Some(content_caps) = content_attr_regex().captures(tag) else {
            continue;
        };
        let Some(content) = content_caps.get(2).or_else(|| content_caps.get(3)) else {
            continue;
        };
        let content = content.as_str();

        // First occurrence wins for each key (OG spec: first tag is canonical).
        match key.as_str() {
            "og:title" if og_title.is_none() => og_title = Some(content.to_string()),
            "og:description" if og_description.is_none() => {
                og_description = Some(content.to_string());
            }
            "og:site_name" if og_site_name.is_none() => og_site_name = Some(content.to_string()),
            "og:image" | "og:image:url" | "og:image:secure_url" if og_image.is_none() => {
                og_image = Some(content.to_string());
            }
            "twitter:title" if tw_title.is_none() => tw_title = Some(content.to_string()),
            "twitter:description" if tw_description.is_none() => {
                tw_description = Some(content.to_string());
            }
            "twitter:image" | "twitter:image:src" if tw_image.is_none() => {
                tw_image = Some(content.to_string());
            }
            "description" if meta_description.is_none() => {
                meta_description = Some(content.to_string());
            }
            _ => {}
        }
    }

    let html_title = title_regex()
        .captures(html)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string());

    let title = og_title
        .or(tw_title)
        .or(html_title)
        .and_then(|t| clean_text(&t, MAX_TITLE_CHARS));
    let description = og_description
        .or(tw_description)
        .or(meta_description)
        .and_then(|d| clean_text(&d, MAX_DESCRIPTION_CHARS));
    let site_name = og_site_name.and_then(|s| clean_text(&s, MAX_SITE_NAME_CHARS));
    let image_url = og_image
        .or(tw_image)
        .and_then(|i| clean_image_url(&i, page_url));

    UnfurledPage {
        title,
        description,
        site_name,
        image_url,
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    // ── SSRF guard: table-driven forbidden-range coverage ──────────

    #[test]
    fn forbidden_ipv4_ranges_are_rejected() {
        let cases: &[(&str, &str)] = &[
            ("0.0.0.0", "unspecified"),
            ("127.0.0.1", "loopback"),
            ("127.255.255.254", "loopback /8 edge"),
            ("10.0.0.1", "RFC1918 10/8"),
            ("10.255.255.255", "RFC1918 10/8 edge"),
            ("172.16.0.1", "RFC1918 172.16/12"),
            ("172.31.255.255", "RFC1918 172.16/12 edge"),
            ("192.168.1.1", "RFC1918 192.168/16"),
            ("169.254.169.254", "cloud metadata"),
            ("169.254.0.1", "link-local"),
            ("100.64.0.1", "CGNAT 100.64/10"),
            ("100.127.255.255", "CGNAT 100.64/10 edge"),
            ("198.18.0.1", "benchmarking 198.18/15"),
            ("198.19.255.255", "benchmarking edge"),
            ("224.0.0.1", "multicast"),
            ("240.0.0.1", "reserved 240/4"),
            ("255.255.255.255", "broadcast"),
        ];
        for (ip, label) in cases {
            assert!(
                ip_is_forbidden(ip.parse().unwrap()),
                "{label} ({ip}) must be forbidden"
            );
        }
    }

    #[test]
    fn public_ipv4_addresses_are_allowed() {
        let cases: &[&str] = &[
            "1.1.1.1",
            "8.8.8.8",
            "93.184.216.34",
            "172.15.255.255", // just below 172.16/12
            "172.32.0.0",     // just above 172.16/12
            "100.63.255.255", // just below CGNAT
            "100.128.0.0",    // just above CGNAT
            "198.17.255.255", // just below benchmarking
            "198.20.0.0",     // just above benchmarking
            "9.255.255.255",  // just below 10/8
            "11.0.0.0",       // just above 10/8
        ];
        for ip in cases {
            assert!(
                !ip_is_forbidden(ip.parse().unwrap()),
                "{ip} must be allowed"
            );
        }
    }

    #[test]
    fn forbidden_ipv6_ranges_are_rejected() {
        let cases: &[(&str, &str)] = &[
            ("::", "unspecified"),
            ("::1", "loopback"),
            ("fc00::1", "unique-local fc00::/7"),
            ("fdff::1", "unique-local fd side"),
            ("fe80::1", "link-local fe80::/10"),
            ("febf::1", "link-local /10 edge"),
            ("ff02::1", "multicast"),
            ("::ffff:127.0.0.1", "IPv4-mapped loopback"),
            ("::ffff:10.0.0.1", "IPv4-mapped RFC1918"),
            ("::ffff:169.254.169.254", "IPv4-mapped metadata"),
            ("64:ff9b::7f00:1", "NAT64 loopback"),
            ("64:ff9b::a9fe:a9fe", "NAT64 metadata (169.254.169.254)"),
        ];
        for (ip, label) in cases {
            assert!(
                ip_is_forbidden(ip.parse().unwrap()),
                "{label} ({ip}) must be forbidden"
            );
        }
    }

    #[test]
    fn public_ipv6_addresses_are_allowed() {
        let cases: &[&str] = &[
            "2606:4700:4700::1111", // Cloudflare DNS
            "2001:4860:4860::8888", // Google DNS
            "::ffff:8.8.8.8",       // IPv4-mapped public
            "64:ff9b::808:808",     // NAT64 public (8.8.8.8)
            "fbff::1",              // just below fc00::/7
            "fec0::1", // just above fe80::/10 (deprecated site-local, still routable-ish)
        ];
        for ip in cases {
            assert!(
                !ip_is_forbidden(ip.parse().unwrap()),
                "{ip} must be allowed"
            );
        }
    }

    #[test]
    fn ip_literal_hosts_are_validated_without_dns() {
        // Sanity anchor for the guard used by resolve_and_validate.
        assert!(ip_is_forbidden(IpAddr::V4(Ipv4Addr::new(192, 168, 0, 1))));
        assert!(ip_is_forbidden(IpAddr::V6(Ipv6Addr::LOCALHOST)));
    }

    // ── URL normalization ──────────────────────────────────────────

    #[test]
    fn normalize_url_lowercases_and_strips_fragment() {
        let url = normalize_url("HTTPS://Example.COM/Path?q=1#frag").unwrap();
        assert_eq!(url.as_str(), "https://example.com/Path?q=1");
    }

    #[test]
    fn normalize_url_rejects_non_http_schemes() {
        for raw in [
            "ftp://example.com/",
            "file:///etc/passwd",
            "gopher://example.com/",
            "javascript:alert(1)",
        ] {
            assert!(normalize_url(raw).is_err(), "{raw} must be rejected");
        }
    }

    #[test]
    fn normalize_url_rejects_userinfo() {
        assert!(normalize_url("https://admin:hunter2@example.com/").is_err());
        assert!(normalize_url("https://admin@example.com/").is_err());
    }

    // ── Metadata parser (og / twitter / fallback) ──────────────────

    fn base() -> Url {
        Url::parse("https://example.com/article").unwrap()
    }

    #[test]
    fn parses_open_graph_tags() {
        let html = r#"<html><head>
            <meta property="og:title" content="OG Title" />
            <meta property="og:description" content="OG Description" />
            <meta property="og:site_name" content="Example Site" />
            <meta property="og:image" content="https://cdn.example.com/img.png" />
            <title>HTML Title</title>
        </head><body></body></html>"#;
        let page = parse_metadata(html, &base());
        assert_eq!(page.title.as_deref(), Some("OG Title"));
        assert_eq!(page.description.as_deref(), Some("OG Description"));
        assert_eq!(page.site_name.as_deref(), Some("Example Site"));
        assert_eq!(
            page.image_url.as_deref(),
            Some("https://cdn.example.com/img.png")
        );
    }

    #[test]
    fn falls_back_to_twitter_card_tags() {
        let html = r#"<head>
            <meta name="twitter:title" content="TW Title">
            <meta name="twitter:description" content="TW Description">
            <meta name="twitter:image" content="https://cdn.example.com/tw.png">
        </head>"#;
        let page = parse_metadata(html, &base());
        assert_eq!(page.title.as_deref(), Some("TW Title"));
        assert_eq!(page.description.as_deref(), Some("TW Description"));
        assert_eq!(
            page.image_url.as_deref(),
            Some("https://cdn.example.com/tw.png")
        );
        assert!(page.site_name.is_none());
    }

    #[test]
    fn falls_back_to_html_title_and_meta_description() {
        let html = r#"<head>
            <title>  Plain   Title </title>
            <meta name="description" content="Plain description.">
        </head>"#;
        let page = parse_metadata(html, &base());
        assert_eq!(page.title.as_deref(), Some("Plain Title"));
        assert_eq!(page.description.as_deref(), Some("Plain description."));
    }

    #[test]
    fn og_wins_over_twitter_and_fallback() {
        let html = r#"<head>
            <meta name="twitter:title" content="TW">
            <meta property="og:title" content="OG">
            <title>HTML</title>
        </head>"#;
        let page = parse_metadata(html, &base());
        assert_eq!(page.title.as_deref(), Some("OG"));
    }

    #[test]
    fn attribute_order_and_quotes_do_not_matter() {
        let html = r#"<head>
            <meta content='Reversed &amp; quoted' property='og:title'>
        </head>"#;
        let page = parse_metadata(html, &base());
        assert_eq!(page.title.as_deref(), Some("Reversed & quoted"));
    }

    #[test]
    fn decodes_numeric_entities() {
        let html = r#"<head><meta property="og:title" content="A&#39;s &#x2014; test"></head>"#;
        let page = parse_metadata(html, &base());
        assert_eq!(page.title.as_deref(), Some("A's \u{2014} test"));
    }

    #[test]
    fn relative_image_resolves_against_page_url() {
        let html = r#"<head><meta property="og:image" content="/img/hero.png"></head>"#;
        let page = parse_metadata(html, &base());
        assert_eq!(
            page.image_url.as_deref(),
            Some("https://example.com/img/hero.png")
        );
    }

    #[test]
    fn non_http_image_is_dropped() {
        let html = r#"<head>
            <meta property="og:title" content="T">
            <meta property="og:image" content="javascript:alert(1)">
        </head>"#;
        let page = parse_metadata(html, &base());
        assert!(page.image_url.is_none());
    }

    #[test]
    fn empty_page_yields_no_content() {
        let page = parse_metadata("<html><body>hi</body></html>", &base());
        assert!(!page.has_content());
        assert!(page.title.is_none());
    }

    #[test]
    fn long_fields_are_capped() {
        let long = "x".repeat(2000);
        let html = format!(
            r#"<head><meta property="og:description" content="{long}"><meta property="og:title" content="{long}"></head>"#
        );
        let page = parse_metadata(&html, &base());
        assert_eq!(page.title.unwrap().chars().count(), 300);
        assert_eq!(page.description.unwrap().chars().count(), 500);
    }

    #[test]
    fn markup_in_metadata_stays_text_after_decode() {
        // `&lt;img&gt;` decodes to literal text "<img>", which the client
        // renders as a TEXT NODE — asserting we never store live entities.
        let html = r#"<head><meta property="og:title" content="&lt;img src=x onerror=alert(1)&gt;"></head>"#;
        let page = parse_metadata(html, &base());
        assert_eq!(page.title.as_deref(), Some("<img src=x onerror=alert(1)>"));
    }

    // ── Live fetch behavior (wiremock on loopback, test-only allow) ──

    async fn serve(mock: &wiremock::MockServer, path: &str, html: &str) {
        use wiremock::matchers::{method, path as p};
        // WHY set_body_raw: `set_body_string` stamps `text/plain`, which the
        // unfurler correctly rejects — the raw variant carries the mime.
        wiremock::Mock::given(method("GET"))
            .and(p(path.to_string()))
            .respond_with(
                wiremock::ResponseTemplate::new(200)
                    .set_body_raw(html.as_bytes().to_vec(), "text/html; charset=utf-8"),
            )
            .mount(mock)
            .await;
    }

    #[tokio::test]
    async fn unfurl_rejects_loopback_in_production_mode() {
        let unfurler = LinkUnfurler::new();
        let err = unfurler.unfurl("http://127.0.0.1:9/").await.unwrap_err();
        assert!(matches!(err, UnfurlError::ForbiddenAddress), "{err:?}");

        let err = unfurler.unfurl("http://[::1]:9/").await.unwrap_err();
        assert!(matches!(err, UnfurlError::ForbiddenAddress), "{err:?}");
    }

    #[tokio::test]
    async fn unfurl_rejects_metadata_endpoint() {
        let unfurler = LinkUnfurler::new();
        let err = unfurler
            .unfurl("http://169.254.169.254/latest/meta-data/")
            .await
            .unwrap_err();
        assert!(matches!(err, UnfurlError::ForbiddenAddress), "{err:?}");
    }

    #[tokio::test]
    async fn unfurl_fetches_and_parses_og_page() {
        let mock = wiremock::MockServer::start().await;
        serve(
            &mock,
            "/article",
            r#"<head><meta property="og:title" content="Hello"><meta property="og:description" content="World"></head>"#,
        )
        .await;

        let unfurler = LinkUnfurler::new_allowing_loopback_for_tests();
        let page = unfurler
            .unfurl(&format!("{}/article", mock.uri()))
            .await
            .unwrap();
        assert_eq!(page.title.as_deref(), Some("Hello"));
        assert_eq!(page.description.as_deref(), Some("World"));
    }

    /// The redirect target is re-validated: a public-looking first hop that
    /// redirects to the cloud metadata address is rejected mid-chain, even
    /// though the FIRST hop was allowed. This is the per-hop re-validation
    /// guarantee (loopback is test-allowed; 169.254/16 is NOT).
    #[tokio::test]
    async fn unfurl_rejects_redirect_to_forbidden_address() {
        use wiremock::matchers::{method, path as p};
        let mock = wiremock::MockServer::start().await;
        wiremock::Mock::given(method("GET"))
            .and(p("/redirect"))
            .respond_with(
                wiremock::ResponseTemplate::new(302)
                    .insert_header("location", "http://169.254.169.254/latest/meta-data/"),
            )
            .mount(&mock)
            .await;

        let unfurler = LinkUnfurler::new_allowing_loopback_for_tests();
        let err = unfurler
            .unfurl(&format!("{}/redirect", mock.uri()))
            .await
            .unwrap_err();
        assert!(matches!(err, UnfurlError::ForbiddenAddress), "{err:?}");
    }

    /// Same guarantee for private-range redirect targets (10/8).
    #[tokio::test]
    async fn unfurl_rejects_redirect_to_private_range() {
        use wiremock::matchers::{method, path as p};
        let mock = wiremock::MockServer::start().await;
        wiremock::Mock::given(method("GET"))
            .and(p("/redirect"))
            .respond_with(
                wiremock::ResponseTemplate::new(301)
                    .insert_header("location", "http://10.0.0.5/internal"),
            )
            .mount(&mock)
            .await;

        let unfurler = LinkUnfurler::new_allowing_loopback_for_tests();
        let err = unfurler
            .unfurl(&format!("{}/redirect", mock.uri()))
            .await
            .unwrap_err();
        assert!(matches!(err, UnfurlError::ForbiddenAddress), "{err:?}");
    }

    #[tokio::test]
    async fn unfurl_follows_relative_redirect_then_parses() {
        use wiremock::matchers::{method, path as p};
        let mock = wiremock::MockServer::start().await;
        wiremock::Mock::given(method("GET"))
            .and(p("/start"))
            .respond_with(wiremock::ResponseTemplate::new(302).insert_header("location", "/final"))
            .mount(&mock)
            .await;
        serve(
            &mock,
            "/final",
            r#"<head><meta property="og:title" content="Landed"></head>"#,
        )
        .await;

        let unfurler = LinkUnfurler::new_allowing_loopback_for_tests();
        let page = unfurler
            .unfurl(&format!("{}/start", mock.uri()))
            .await
            .unwrap();
        assert_eq!(page.title.as_deref(), Some("Landed"));
    }

    #[tokio::test]
    async fn unfurl_stops_after_max_redirects() {
        use wiremock::matchers::{method, path as p};
        let mock = wiremock::MockServer::start().await;
        // /loop redirects to itself forever.
        wiremock::Mock::given(method("GET"))
            .and(p("/loop"))
            .respond_with(wiremock::ResponseTemplate::new(302).insert_header("location", "/loop"))
            .mount(&mock)
            .await;

        let unfurler = LinkUnfurler::new_allowing_loopback_for_tests();
        let err = unfurler
            .unfurl(&format!("{}/loop", mock.uri()))
            .await
            .unwrap_err();
        assert!(matches!(err, UnfurlError::TooManyRedirects), "{err:?}");
    }

    #[tokio::test]
    async fn unfurl_rejects_non_html_content_type() {
        use wiremock::matchers::{method, path as p};
        let mock = wiremock::MockServer::start().await;
        wiremock::Mock::given(method("GET"))
            .and(p("/data.json"))
            .respond_with(
                wiremock::ResponseTemplate::new(200)
                    .insert_header("content-type", "application/json")
                    .set_body_string("{}"),
            )
            .mount(&mock)
            .await;

        let unfurler = LinkUnfurler::new_allowing_loopback_for_tests();
        let err = unfurler
            .unfurl(&format!("{}/data.json", mock.uri()))
            .await
            .unwrap_err();
        assert!(
            matches!(err, UnfurlError::UnsupportedContentType(_)),
            "{err:?}"
        );
    }

    #[tokio::test]
    async fn unfurl_caps_oversized_bodies_but_still_parses_head() {
        let mock = wiremock::MockServer::start().await;
        // Head with OG tags followed by > MAX_BODY_BYTES of filler.
        let html = format!(
            r#"<head><meta property="og:title" content="Big Page"></head><body>{}</body>"#,
            "z".repeat(MAX_BODY_BYTES + 1024)
        );
        serve(&mock, "/big", &html).await;

        let unfurler = LinkUnfurler::new_allowing_loopback_for_tests();
        let page = unfurler
            .unfurl(&format!("{}/big", mock.uri()))
            .await
            .unwrap();
        assert_eq!(page.title.as_deref(), Some("Big Page"));
    }

    #[tokio::test]
    async fn unfurl_surfaces_upstream_error_status() {
        use wiremock::matchers::{method, path as p};
        let mock = wiremock::MockServer::start().await;
        wiremock::Mock::given(method("GET"))
            .and(p("/missing"))
            .respond_with(wiremock::ResponseTemplate::new(404))
            .mount(&mock)
            .await;

        let unfurler = LinkUnfurler::new_allowing_loopback_for_tests();
        let err = unfurler
            .unfurl(&format!("{}/missing", mock.uri()))
            .await
            .unwrap_err();
        assert!(matches!(err, UnfurlError::UpstreamStatus(404)), "{err:?}");
    }
}
