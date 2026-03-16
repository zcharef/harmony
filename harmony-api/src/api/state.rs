//! Application state shared across handlers.

use secrecy::SecretString;
use sqlx::PgPool;

/// Application state shared across all handlers.
///
/// Uses `Clone` (`PgPool` is `Arc` internally, `SecretString` is `Arc` internally).
#[derive(Debug, Clone)]
pub struct AppState {
    /// Postgres connection pool (Supabase).
    pub pool: PgPool,
    /// Supabase JWT secret for token verification.
    pub jwt_secret: SecretString,
    /// Session secret for signing HMAC session tokens.
    pub session_secret: SecretString,
    /// Whether the server is running in production mode.
    pub is_production: bool,
}
