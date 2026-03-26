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
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn test_auth_error_display() {
        let err = AuthError::InvalidToken("bad token".to_string());
        assert_eq!(err.to_string(), "Invalid token: bad token");

        let err = AuthError::TokenExpired;
        assert_eq!(err.to_string(), "Token expired");
    }
}
