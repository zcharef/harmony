//! Supabase JWT authentication adapter.
//!
//! Verifies Supabase-issued JWTs using the project's JWT secret (HS256).

use jsonwebtoken::{DecodingKey, TokenData, Validation, decode};
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
}

/// Verified user extracted from a Supabase JWT.
#[derive(Debug, Clone)]
pub struct AuthenticatedUser {
    pub user_id: UserId,
    pub email: Option<String>,
    pub role: Option<String>,
}

/// Verify a Supabase JWT and extract user information.
///
/// # Errors
/// Returns [`AuthError::TokenExpired`] if the token's `exp` claim is in the past,
/// or [`AuthError::InvalidToken`] for any other verification failure (bad signature, wrong audience, malformed).
pub fn verify_supabase_jwt(
    token: &str,
    jwt_secret: &SecretString,
) -> Result<AuthenticatedUser, AuthError> {
    let key = DecodingKey::from_secret(jwt_secret.expose_secret().as_bytes());

    let mut validation = Validation::default();
    validation.set_audience(&["authenticated"]);
    // Supabase uses HS256 by default
    validation.algorithms = vec![jsonwebtoken::Algorithm::HS256];

    let token_data: TokenData<SupabaseClaims> =
        decode(token, &key, &validation).map_err(|e| match e.kind() {
            jsonwebtoken::errors::ErrorKind::ExpiredSignature => AuthError::TokenExpired,
            _ => AuthError::InvalidToken(e.to_string()),
        })?;

    Ok(AuthenticatedUser {
        user_id: UserId::new(token_data.claims.sub),
        email: token_data.claims.email,
        role: token_data.claims.role,
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
