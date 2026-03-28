//! Stateless session tokens (HMAC-SHA256).
//!
//! Token format: `{uid}.{flags}.{expiry_unix}.{hex_hmac}`
//! where `flags` is a single digit encoding two booleans:
//!   bit 0 = `phone_verified`, bit 1 = `email_verified`
//! The HMAC signs `{uid}.{flags}.{expiry}` — expiry is embedded in the token for
//! server-side enforcement (independent of cookie Max-Age).

use std::time::{SystemTime, UNIX_EPOCH};

use axum::http::HeaderMap;
use hmac::{Hmac, Mac};
use secrecy::{ExposeSecret, SecretString};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

pub const SESSION_COOKIE_NAME: &str = "session";
const SESSION_DURATION_SECS: u64 = 7 * 24 * 60 * 60; // 7 days

/// Decoded session data embedded in the token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionData {
    pub uid: String,
    pub email_verified: bool,
    pub phone_verified: bool,
}

/// Encode verification flags into a single digit (0-3).
fn encode_flags(email_verified: bool, phone_verified: bool) -> u8 {
    let mut flags: u8 = 0;
    if phone_verified {
        flags |= 1;
    }
    if email_verified {
        flags |= 2;
    }
    flags
}

/// Decode a single digit (0-3) into verification flags.
fn decode_flags(flags: u8) -> (bool, bool) {
    let phone_verified = flags & 1 != 0;
    let email_verified = flags & 2 != 0;
    (email_verified, phone_verified)
}

/// Create a signed session token for the given UID with verification flags.
///
/// # Panics
/// Panics if HMAC-SHA256 initialization fails (should never happen — SHA256 accepts any key size).
#[must_use]
pub fn create_session_token(
    uid: &str,
    email_verified: bool,
    phone_verified: bool,
    secret: &SecretString,
) -> String {
    let flags = encode_flags(email_verified, phone_verified);
    let expiry = now_secs() + SESSION_DURATION_SECS;
    let message = format!("{}.{}.{}", uid, flags, expiry);

    // WHY: HMAC-SHA256 accepts any key size — new_from_slice never fails for Sha256.
    #[allow(clippy::expect_used)]
    let mut mac = HmacSha256::new_from_slice(secret.expose_secret().as_bytes())
        .expect("HMAC-SHA256 accepts any key size");
    mac.update(message.as_bytes());
    let signature = hex::encode(mac.finalize().into_bytes());

    format!("{}.{}", message, signature)
}

/// Verify a session token and return the session data if valid + not expired.
///
/// # Panics
/// Panics if HMAC-SHA256 initialization fails (should never happen — SHA256 accepts any key size).
pub fn verify_session_token(token: &str, secret: &SecretString) -> Option<SessionData> {
    // Split into exactly 4 parts: uid, flags, expiry, signature
    let parts: Vec<&str> = token.splitn(4, '.').collect();
    if parts.len() != 4 {
        return None;
    }

    let uid = parts[0];
    let flags_str = parts[1];
    let expiry_str = parts[2];
    let signature_hex = parts[3];

    // Parse flags (single digit 0-3)
    let flags: u8 = flags_str.parse().ok()?;
    if flags > 3 {
        return None;
    }

    // Parse and check expiry
    let expiry: u64 = expiry_str.parse().ok()?;
    if now_secs() > expiry {
        tracing::debug!(uid = uid, "Session token expired");
        return None;
    }

    // Verify HMAC (constant-time comparison)
    let message = format!("{}.{}.{}", uid, flags_str, expiry_str);
    // WHY: HMAC-SHA256 accepts any key size — new_from_slice never fails for Sha256.
    #[allow(clippy::expect_used)]
    let mut mac = HmacSha256::new_from_slice(secret.expose_secret().as_bytes())
        .expect("HMAC-SHA256 accepts any key size");
    mac.update(message.as_bytes());

    let signature_bytes = hex::decode(signature_hex).ok()?;
    mac.verify_slice(&signature_bytes).ok()?;

    let (email_verified, phone_verified) = decode_flags(flags);

    Some(SessionData {
        uid: uid.to_string(),
        email_verified,
        phone_verified,
    })
}

/// Try to extract and verify session data from the cookie header.
pub fn extract_session_from_cookie(
    headers: &HeaderMap,
    secret: &SecretString,
) -> Option<SessionData> {
    let cookie_header = headers.get(axum::http::header::COOKIE)?.to_str().ok()?;

    // Parse cookies manually — avoid pulling in a full cookie-jar crate
    for pair in cookie_header.split(';') {
        let pair = pair.trim();
        if let Some(value) = pair
            .strip_prefix(SESSION_COOKIE_NAME)
            .and_then(|rest| rest.strip_prefix('='))
            .filter(|v| !v.is_empty())
        {
            return verify_session_token(value, secret);
        }
    }

    None
}

/// Build a `Set-Cookie` header value for the session token.
#[must_use]
pub fn build_session_cookie(token: &str, is_production: bool) -> String {
    let secure = if is_production { "; Secure" } else { "" };
    format!(
        "{}={}; HttpOnly; SameSite=Lax; Path=/; Max-Age={}{}",
        SESSION_COOKIE_NAME, token, SESSION_DURATION_SECS, secure
    )
}

/// Build a `Set-Cookie` header value that clears the session cookie.
#[must_use]
pub fn build_clear_cookie(is_production: bool) -> String {
    let secure = if is_production { "; Secure" } else { "" };
    format!(
        "{}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0{}",
        SESSION_COOKIE_NAME, secure
    )
}

fn now_secs() -> u64 {
    // WHY: System clock before UNIX epoch would indicate a severely broken system.
    #[allow(clippy::expect_used)]
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock before UNIX epoch")
        .as_secs()
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    fn test_secret() -> SecretString {
        SecretString::from("test-secret-key-that-is-at-least-32-bytes-long!!")
    }

    #[test]
    fn roundtrip_create_verify() {
        let secret = test_secret();
        let token = create_session_token("user123", true, false, &secret);
        let data = verify_session_token(&token, &secret).unwrap();
        assert_eq!(data.uid, "user123");
        assert!(data.email_verified);
        assert!(!data.phone_verified);
    }

    #[test]
    fn roundtrip_all_flags() {
        let secret = test_secret();

        // Both false
        let token = create_session_token("u1", false, false, &secret);
        let data = verify_session_token(&token, &secret).unwrap();
        assert!(!data.email_verified);
        assert!(!data.phone_verified);

        // Both true
        let token = create_session_token("u2", true, true, &secret);
        let data = verify_session_token(&token, &secret).unwrap();
        assert!(data.email_verified);
        assert!(data.phone_verified);

        // phone only
        let token = create_session_token("u3", false, true, &secret);
        let data = verify_session_token(&token, &secret).unwrap();
        assert!(!data.email_verified);
        assert!(data.phone_verified);
    }

    #[test]
    fn reject_tampered_uid() {
        let secret = test_secret();
        let token = create_session_token("user123", true, false, &secret);

        // Tamper with the UID
        let tampered = token.replacen("user123", "hacker", 1);
        assert_eq!(verify_session_token(&tampered, &secret), None);
    }

    #[test]
    fn reject_wrong_secret() {
        let secret = test_secret();
        let token = create_session_token("user123", false, false, &secret);

        let wrong_secret = SecretString::from("wrong-secret-key-that-is-also-long-enough!!");
        assert_eq!(verify_session_token(&token, &wrong_secret), None);
    }

    #[test]
    fn reject_expired_token() {
        let secret = test_secret();
        // Manually craft an expired token with new format
        let flags: u8 = 0;
        let expiry = now_secs() - 1; // 1 second in the past
        let message = format!("user123.{}.{}", flags, expiry);
        let mut mac = HmacSha256::new_from_slice(secret.expose_secret().as_bytes()).unwrap();
        mac.update(message.as_bytes());
        let sig = hex::encode(mac.finalize().into_bytes());
        let token = format!("{}.{}", message, sig);

        assert_eq!(verify_session_token(&token, &secret), None);
    }

    #[test]
    fn reject_malformed_tokens() {
        let secret = test_secret();
        assert_eq!(verify_session_token("", &secret), None);
        assert_eq!(verify_session_token("only-one-part", &secret), None);
        assert_eq!(verify_session_token("two.parts", &secret), None);
        assert_eq!(verify_session_token("three.parts.only", &secret), None);
    }

    #[test]
    fn reject_invalid_flags() {
        let secret = test_secret();
        // Flags value of 4 is out of range (only 0-3 valid)
        let expiry = now_secs() + 3600;
        let message = format!("user123.4.{}", expiry);
        let mut mac = HmacSha256::new_from_slice(secret.expose_secret().as_bytes()).unwrap();
        mac.update(message.as_bytes());
        let sig = hex::encode(mac.finalize().into_bytes());
        let token = format!("{}.{}", message, sig);

        assert_eq!(verify_session_token(&token, &secret), None);
    }

    #[test]
    fn extract_from_cookie_header() {
        let secret = test_secret();
        let token = create_session_token("uid_abc", true, true, &secret);

        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::COOKIE,
            format!("other=foo; session={}; bar=baz", token)
                .parse()
                .unwrap(),
        );

        let data = extract_session_from_cookie(&headers, &secret).unwrap();
        assert_eq!(data.uid, "uid_abc");
        assert!(data.email_verified);
        assert!(data.phone_verified);
    }

    #[test]
    fn extract_returns_none_when_no_cookie() {
        let secret = test_secret();
        let headers = HeaderMap::new();
        assert_eq!(extract_session_from_cookie(&headers, &secret), None);
    }

    #[test]
    fn build_cookie_dev() {
        let cookie = build_session_cookie("tok123", false);
        assert!(cookie.contains("session=tok123"));
        assert!(cookie.contains("HttpOnly"));
        assert!(cookie.contains("SameSite=Lax"));
        assert!(cookie.contains("Path=/"));
        assert!(cookie.contains("Max-Age=604800"));
        assert!(!cookie.contains("Secure"));
    }

    #[test]
    fn build_cookie_prod() {
        let cookie = build_session_cookie("tok123", true);
        assert!(cookie.contains("Secure"));
    }

    #[test]
    fn clear_cookie() {
        let cookie = build_clear_cookie(false);
        assert!(cookie.contains("session=;"));
        assert!(cookie.contains("Max-Age=0"));
    }

    #[test]
    fn encode_decode_flags_roundtrip() {
        for ev in [false, true] {
            for pv in [false, true] {
                let flags = encode_flags(ev, pv);
                let (ev2, pv2) = decode_flags(flags);
                assert_eq!((ev, pv), (ev2, pv2));
            }
        }
    }
}
