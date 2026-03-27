//! Supabase JWT authentication adapter.
//!
//! Verifies Supabase-issued JWTs using either HS256 (legacy HMAC secret) or
//! ES256 (ECDSA P-256 via JWKS), depending on the token's `alg` header.
//! Newer Supabase CLI versions sign tokens with ES256.

use jsonwebtoken::{Algorithm, DecodingKey, TokenData, Validation, decode, decode_header};
use secrecy::{ExposeSecret, SecretString};
use serde::Deserialize;
use thiserror::Error;
use uuid::Uuid;

use crate::domain::models::UserId;

/// Authentication errors.
#[derive(Debug, Error)]
pub enum AuthError {
    #[error("Invalid token: {0}")]
    InvalidToken(String),

    #[error("Token expired")]
    TokenExpired,
}

/// Claims from a Supabase JWT.
#[derive(Debug, Deserialize)]
pub struct SupabaseClaims {
    /// Subject — the user's UUID in auth.users
    pub sub: Uuid,
    /// User's email (if available)
    pub email: Option<String>,
    /// Token role (e.g., "authenticated", "anon")
    pub role: Option<String>,
    /// Timestamp when email was confirmed.
    /// NOT present in standard Supabase access tokens, but may appear if a
    /// custom access token hook injects it. Kept as a fallback.
    pub email_confirmed_at: Option<String>,
    /// User metadata from Supabase JWT.
    /// WHY: Standard Supabase access tokens do NOT include `email_confirmed_at`
    /// at the top level. After email confirmation, Supabase sets
    /// `user_metadata.email_verified = true` inside the JWT. This is the
    /// reliable source for email verification status on the JWT path.
    pub user_metadata: Option<serde_json::Value>,
}

/// Verified user extracted from a Supabase JWT.
#[derive(Debug, Clone)]
pub struct AuthenticatedUser {
    pub user_id: UserId,
    pub email: Option<String>,
    pub role: Option<String>,
    pub email_verified: bool,
    pub user_metadata: Option<serde_json::Value>,
}

/// Verify a Supabase JWT and extract user information.
///
/// Supports both HS256 (legacy HMAC secret) and ES256 (ECDSA via JWKS).
/// The algorithm is determined by inspecting the token's header:
/// - HS256: verified using `jwt_secret` (Supabase JWT secret).
/// - ES256: verified using `es256_key` (public key from Supabase JWKS endpoint).
///
/// # Errors
/// Returns [`AuthError::TokenExpired`] if the token's `exp` claim is in the past,
/// or [`AuthError::InvalidToken`] for any other verification failure (bad signature,
/// wrong audience, malformed, or unsupported algorithm).
pub fn verify_supabase_jwt(
    token: &str,
    jwt_secret: &SecretString,
    es256_key: Option<&DecodingKey>,
) -> Result<AuthenticatedUser, AuthError> {
    // WHY: Peek at the JWT header to determine which verification key to use.
    // Newer Supabase CLI versions sign with ES256 instead of HS256.
    let header = decode_header(token)
        .map_err(|e| AuthError::InvalidToken(format!("malformed JWT header: {e}")))?;

    let (key, algorithm) = match header.alg {
        Algorithm::HS256 => {
            let key = DecodingKey::from_secret(jwt_secret.expose_secret().as_bytes());
            (key, Algorithm::HS256)
        }
        Algorithm::ES256 => {
            let key = es256_key
                .ok_or_else(|| {
                    AuthError::InvalidToken(
                        "ES256 token received but no JWKS public key configured".to_string(),
                    )
                })?
                .clone();
            (key, Algorithm::ES256)
        }
        other => {
            return Err(AuthError::InvalidToken(format!(
                "unsupported JWT algorithm: {other:?}"
            )));
        }
    };

    let mut validation = Validation::new(algorithm);
    validation.set_audience(&["authenticated"]);

    let token_data: TokenData<SupabaseClaims> =
        decode(token, &key, &validation).map_err(|e| match e.kind() {
            jsonwebtoken::errors::ErrorKind::ExpiredSignature => AuthError::TokenExpired,
            _ => AuthError::InvalidToken(e.to_string()),
        })?;

    // WHY: Supabase access tokens do NOT include `email_confirmed_at` as a
    // top-level claim. The reliable signal is `user_metadata.email_verified`,
    // which Supabase sets to `true` after the user confirms their email.
    // We also check `email_confirmed_at` as a fallback in case a custom
    // access token hook injects it.
    let email_verified = token_data.claims.email_confirmed_at.is_some()
        || token_data
            .claims
            .user_metadata
            .as_ref()
            .and_then(|m| m.get("email_verified"))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);

    Ok(AuthenticatedUser {
        user_id: UserId::new(token_data.claims.sub),
        email: token_data.claims.email,
        role: token_data.claims.role,
        email_verified,
        user_metadata: token_data.claims.user_metadata,
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use jsonwebtoken::{EncodingKey, Header};

    /// Test-only JWT secret. NOT a real secret.
    const TEST_SECRET: &str = "test-jwt-secret-for-unit-tests-only";

    /// Build a claims map for JWT encoding. Returns a `serde_json::Value`
    /// so tests can omit or tamper individual fields.
    fn base_claims(sub: Uuid) -> serde_json::Value {
        let now = chrono::Utc::now().timestamp();
        serde_json::json!({
            "sub": sub.to_string(),
            "aud": "authenticated",
            "role": "authenticated",
            "email": "test@example.com",
            "iat": now,
            "exp": now + 3600,
        })
    }

    /// Encode a JWT with HS256 using the test secret.
    fn encode_hs256(claims: &serde_json::Value) -> String {
        let header = Header::new(Algorithm::HS256);
        let key = EncodingKey::from_secret(TEST_SECRET.as_bytes());
        jsonwebtoken::encode(&header, claims, &key).unwrap()
    }

    fn test_secret() -> SecretString {
        SecretString::from(TEST_SECRET.to_string())
    }

    // ── Error display ────────────────────────────────────────────

    #[test]
    fn auth_error_display() {
        let err = AuthError::InvalidToken("bad token".to_string());
        assert_eq!(err.to_string(), "Invalid token: bad token");

        let err = AuthError::TokenExpired;
        assert_eq!(err.to_string(), "Token expired");
    }

    // ── Valid JWT ────────────────────────────────────────────────

    #[test]
    fn valid_hs256_jwt_succeeds() {
        let sub = Uuid::new_v4();
        let claims = base_claims(sub);
        let token = encode_hs256(&claims);
        let secret = test_secret();

        let result = verify_supabase_jwt(&token, &secret, None);
        assert!(result.is_ok(), "Expected Ok, got {:?}", result);

        let user = result.unwrap();
        assert_eq!(user.user_id, UserId::new(sub));
        assert_eq!(user.email.as_deref(), Some("test@example.com"));
        assert_eq!(user.role.as_deref(), Some("authenticated"));
    }

    // ── Expired JWT ─────────────────────────────────────────────

    #[test]
    fn expired_jwt_returns_token_expired() {
        let sub = Uuid::new_v4();
        let mut claims = base_claims(sub);
        // Set exp to 1 hour in the past
        let past = chrono::Utc::now().timestamp() - 3600;
        claims["exp"] = serde_json::json!(past);
        claims["iat"] = serde_json::json!(past - 3600);

        let token = encode_hs256(&claims);
        let secret = test_secret();

        let result = verify_supabase_jwt(&token, &secret, None);
        assert!(result.is_err());
        match result.unwrap_err() {
            AuthError::TokenExpired => {} // expected
            other => panic!("Expected TokenExpired, got {:?}", other),
        }
    }

    // ── Tampered JWT ────────────────────────────────────────────

    #[test]
    fn tampered_jwt_payload_rejected() {
        let sub = Uuid::new_v4();
        let claims = base_claims(sub);
        let token = encode_hs256(&claims);

        // Tamper with the payload by flipping a character in the middle segment
        let parts: Vec<&str> = token.split('.').collect();
        assert_eq!(parts.len(), 3, "JWT should have 3 parts");

        let mut payload_bytes = parts[1].as_bytes().to_vec();
        // Flip the first byte (safe because base64 chars are ASCII)
        payload_bytes[0] ^= 0x01;
        let tampered_payload = String::from_utf8(payload_bytes).unwrap();
        let tampered_token = format!("{}.{}.{}", parts[0], tampered_payload, parts[2]);

        let secret = test_secret();
        let result = verify_supabase_jwt(&tampered_token, &secret, None);
        assert!(result.is_err());
        match result.unwrap_err() {
            AuthError::InvalidToken(_) => {} // expected
            other => panic!("Expected InvalidToken, got {:?}", other),
        }
    }

    // ── Wrong secret ────────────────────────────────────────────

    #[test]
    fn wrong_secret_rejected() {
        let sub = Uuid::new_v4();
        let claims = base_claims(sub);
        let token = encode_hs256(&claims);

        let wrong_secret = SecretString::from("wrong-secret-entirely".to_string());
        let result = verify_supabase_jwt(&token, &wrong_secret, None);
        assert!(result.is_err());
        match result.unwrap_err() {
            AuthError::InvalidToken(_) => {} // expected
            other => panic!("Expected InvalidToken, got {:?}", other),
        }
    }

    // ── Missing sub claim ───────────────────────────────────────

    #[test]
    fn missing_sub_claim_rejected() {
        let now = chrono::Utc::now().timestamp();
        let claims = serde_json::json!({
            "aud": "authenticated",
            "role": "authenticated",
            "iat": now,
            "exp": now + 3600,
        });
        let token = encode_hs256(&claims);
        let secret = test_secret();

        let result = verify_supabase_jwt(&token, &secret, None);
        assert!(result.is_err());
        match result.unwrap_err() {
            AuthError::InvalidToken(_) => {} // expected: sub is required
            other => panic!("Expected InvalidToken, got {:?}", other),
        }
    }

    // ── Wrong audience ──────────────────────────────────────────

    #[test]
    fn wrong_audience_rejected() {
        let sub = Uuid::new_v4();
        let now = chrono::Utc::now().timestamp();
        let claims = serde_json::json!({
            "sub": sub.to_string(),
            "aud": "anon",
            "role": "anon",
            "iat": now,
            "exp": now + 3600,
        });
        let token = encode_hs256(&claims);
        let secret = test_secret();

        let result = verify_supabase_jwt(&token, &secret, None);
        assert!(result.is_err());
        match result.unwrap_err() {
            AuthError::InvalidToken(_) => {} // expected: audience mismatch
            other => panic!("Expected InvalidToken, got {:?}", other),
        }
    }

    // ── Unsupported algorithm ───────────────────────────────────

    #[test]
    fn unsupported_algorithm_rejected() {
        let sub = Uuid::new_v4();
        let claims = base_claims(sub);

        // Encode with HS384 which is not supported by verify_supabase_jwt
        let header = Header::new(Algorithm::HS384);
        let key = EncodingKey::from_secret(TEST_SECRET.as_bytes());
        let token = jsonwebtoken::encode(&header, &claims, &key).unwrap();

        let secret = test_secret();
        let result = verify_supabase_jwt(&token, &secret, None);
        assert!(result.is_err());
        match result.unwrap_err() {
            AuthError::InvalidToken(msg) => {
                assert!(
                    msg.contains("unsupported JWT algorithm"),
                    "Error should mention unsupported algorithm: {msg}"
                );
            }
            other => panic!("Expected InvalidToken, got {:?}", other),
        }
    }

    // ── Malformed token ─────────────────────────────────────────

    #[test]
    fn completely_malformed_token_rejected() {
        let secret = test_secret();
        let result = verify_supabase_jwt("not.a.jwt.at.all", &secret, None);
        assert!(result.is_err());
        match result.unwrap_err() {
            AuthError::InvalidToken(msg) => {
                assert!(
                    msg.contains("malformed JWT header"),
                    "Error should mention malformed header: {msg}"
                );
            }
            other => panic!("Expected InvalidToken, got {:?}", other),
        }
    }

    #[test]
    fn empty_token_rejected() {
        let secret = test_secret();
        let result = verify_supabase_jwt("", &secret, None);
        assert!(result.is_err());
        match result.unwrap_err() {
            AuthError::InvalidToken(_) => {} // expected
            other => panic!("Expected InvalidToken, got {:?}", other),
        }
    }

    // ── ES256 without key configured ────────────────────────────

    #[test]
    fn es256_token_without_configured_key_rejected() {
        // Craft a JWT header that claims ES256 but use HS256 encoding trick:
        // we can't easily sign a real ES256 in tests without a private key,
        // but we CAN test the "no JWKS key configured" branch by building
        // a token whose header says ES256.
        //
        // Manually build a JWT with an ES256 header:
        let header_json = serde_json::json!({"alg": "ES256", "typ": "JWT"});
        let header_b64 = base64::Engine::encode(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD,
            serde_json::to_vec(&header_json).unwrap(),
        );

        let sub = Uuid::new_v4();
        let claims = base_claims(sub);
        let payload_b64 = base64::Engine::encode(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD,
            serde_json::to_vec(&claims).unwrap(),
        );

        // Fake signature (won't validate, but we should hit the "no key" check first)
        let fake_sig = "fake-signature-bytes";
        let token = format!("{header_b64}.{payload_b64}.{fake_sig}");

        let secret = test_secret();
        let result = verify_supabase_jwt(&token, &secret, None);
        assert!(result.is_err());
        match result.unwrap_err() {
            AuthError::InvalidToken(msg) => {
                assert!(
                    msg.contains("no JWKS public key configured"),
                    "Error should mention missing JWKS key: {msg}"
                );
            }
            other => panic!("Expected InvalidToken, got {:?}", other),
        }
    }

    // ── email_verified extraction ───────────────────────────────

    #[test]
    fn email_verified_from_user_metadata() {
        let sub = Uuid::new_v4();
        let mut claims = base_claims(sub);
        claims["user_metadata"] = serde_json::json!({"email_verified": true});

        let token = encode_hs256(&claims);
        let secret = test_secret();

        let user = verify_supabase_jwt(&token, &secret, None).unwrap();
        assert!(user.email_verified);
    }

    #[test]
    fn email_verified_from_email_confirmed_at() {
        let sub = Uuid::new_v4();
        let mut claims = base_claims(sub);
        claims["email_confirmed_at"] = serde_json::json!("2026-01-01T00:00:00Z");

        let token = encode_hs256(&claims);
        let secret = test_secret();

        let user = verify_supabase_jwt(&token, &secret, None).unwrap();
        assert!(user.email_verified);
    }

    #[test]
    fn email_not_verified_when_neither_source_present() {
        let sub = Uuid::new_v4();
        let claims = base_claims(sub);
        // base_claims has neither email_confirmed_at nor user_metadata

        let token = encode_hs256(&claims);
        let secret = test_secret();

        let user = verify_supabase_jwt(&token, &secret, None).unwrap();
        assert!(!user.email_verified);
    }

    #[test]
    fn email_not_verified_when_metadata_says_false() {
        let sub = Uuid::new_v4();
        let mut claims = base_claims(sub);
        claims["user_metadata"] = serde_json::json!({"email_verified": false});

        let token = encode_hs256(&claims);
        let secret = test_secret();

        let user = verify_supabase_jwt(&token, &secret, None).unwrap();
        assert!(!user.email_verified);
    }

    // ── Optional claims ─────────────────────────────────────────

    #[test]
    fn optional_email_is_none_when_absent() {
        let sub = Uuid::new_v4();
        let now = chrono::Utc::now().timestamp();
        let claims = serde_json::json!({
            "sub": sub.to_string(),
            "aud": "authenticated",
            "iat": now,
            "exp": now + 3600,
        });
        let token = encode_hs256(&claims);
        let secret = test_secret();

        let user = verify_supabase_jwt(&token, &secret, None).unwrap();
        assert!(user.email.is_none());
        assert!(user.role.is_none());
    }
}
