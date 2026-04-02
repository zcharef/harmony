//! `PostgreSQL` adapter (Supabase Postgres via `SQLx`).

mod ban_repository;
mod channel_repository;
mod desktop_auth_repository;
mod dm_repository;
mod invite_repository;
mod key_repository;
mod megolm_session_repository;
mod member_repository;
mod message_repository;
mod notification_settings_repository;
mod plan_limit_checker;
mod profile_repository;
mod reaction_repository;
mod read_state_repository;
mod server_repository;

pub use ban_repository::PgBanRepository;
pub use channel_repository::PgChannelRepository;
pub use desktop_auth_repository::PgDesktopAuthRepository;
pub use dm_repository::PgDmRepository;
pub use invite_repository::PgInviteRepository;
pub use key_repository::PgKeyRepository;
pub use megolm_session_repository::PgMegolmSessionRepository;
pub use member_repository::PgMemberRepository;
pub use message_repository::PgMessageRepository;
pub use notification_settings_repository::PgNotificationSettingsRepository;
pub use plan_limit_checker::PgPlanLimitChecker;
pub use profile_repository::PgProfileRepository;
pub use reaction_repository::PgReactionRepository;
pub use read_state_repository::PgReadStateRepository;
pub use server_repository::PgServerRepository;

use std::time::Duration;

use secrecy::{ExposeSecret, SecretString};
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;

use crate::domain::errors::DomainError;

/// Convert a sqlx error to the appropriate `DomainError`, logging the real error.
///
/// WHY: Centralizes DB error logging so every repository adapter
/// automatically traces the raw sqlx error at the point of failure.
/// Maps Postgres error code 42501 (`insufficient_privilege`) to
/// `DomainError::Forbidden` so trigger-raised permission errors
/// surface as 403 instead of 500.
#[allow(clippy::needless_pass_by_value)] // WHY: map_err provides owned values
pub(crate) fn db_err(e: sqlx::Error) -> DomainError {
    // WHY: Postgres triggers (e.g. protect_message_content) raise
    // ERRCODE 42501 for permission violations. Map these to Forbidden
    // so the API returns 403 instead of a misleading 500.
    if let sqlx::Error::Database(ref db_err) = e
        && db_err.code().as_deref() == Some("42501")
    {
        tracing::warn!(
            error = %e,
            pg_code = "42501",
            pg_message = %db_err.message(),
            "Database permission denied (trigger or RLS)"
        );
        return DomainError::Forbidden("Operation not permitted".to_string());
    }

    tracing::error!(error = %e, "Database query failed");
    DomainError::Internal(e.to_string())
}

/// Create a connection pool to the Supabase Postgres database.
///
/// # Panics
/// Panics if the database connection cannot be established (fail-fast at startup).
#[allow(clippy::expect_used)]
pub async fn create_pool(database_url: &SecretString, max_connections: u32) -> PgPool {
    PgPoolOptions::new()
        .max_connections(max_connections)
        .acquire_timeout(Duration::from_secs(10))
        .after_connect(|conn, _meta| {
            Box::pin(async move {
                sqlx::query("SET statement_timeout = '30s'") // allow: runtime-sql (connection setup, not data query)
                    .execute(&mut *conn)
                    .await
                    .map(|_| ())
            })
        })
        .connect(database_url.expose_secret())
        .await
        .expect("Failed to connect to Postgres")
}

/// Verify database connectivity (used by health check).
///
/// # Errors
/// Returns `sqlx::Error` if the database is unreachable or the query fails.
pub async fn ping(pool: &PgPool) -> Result<(), sqlx::Error> {
    sqlx::query("SELECT 1").execute(pool).await?; // allow: runtime-sql (health check ping, not data query)
    Ok(())
}
