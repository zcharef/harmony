//! `PostgreSQL` adapter for desktop auth code persistence.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::PgPool;

use crate::domain::errors::DomainError;
use crate::domain::models::{DesktopAuthCode, UserId};
use crate::domain::ports::DesktopAuthRepository;

/// PostgreSQL-backed desktop auth code repository.
#[derive(Debug, Clone)]
pub struct PgDesktopAuthRepository {
    pool: PgPool,
}

impl PgDesktopAuthRepository {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl DesktopAuthRepository for PgDesktopAuthRepository {
    async fn create_code(
        &self,
        auth_code: &str,
        code_challenge: &str,
        user_id: UserId,
        expires_at: DateTime<Utc>,
    ) -> Result<(), DomainError> {
        sqlx::query!(
            "INSERT INTO desktop_auth_codes (auth_code, code_challenge, user_id, expires_at) \
             VALUES ($1, $2, $3, $4)",
            auth_code,
            code_challenge,
            user_id.0,
            expires_at,
        )
        .execute(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(())
    }

    async fn redeem_code(&self, auth_code: &str) -> Result<Option<DesktopAuthCode>, DomainError> {
        // WHY: Single DELETE + RETURNING guarantees the code is single-use.
        // If two requests race, only one will get the row back.
        //
        // WHY `user_id IS NOT NULL`: the column is nullable at the schema level
        // (additive migration, ADR-019). New code always writes it; this guard
        // rejects any legacy pre-migration row and lets sqlx type the returned
        // `user_id` as non-null (`user_id!`).
        let row = sqlx::query!(
            r#"
            DELETE FROM desktop_auth_codes
            WHERE auth_code = $1 AND expires_at > now() AND user_id IS NOT NULL
            RETURNING auth_code, code_challenge, user_id AS "user_id!", expires_at
            "#,
            auth_code,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(row.map(|r| DesktopAuthCode {
            auth_code: r.auth_code,
            code_challenge: r.code_challenge,
            user_id: UserId::new(r.user_id),
            expires_at: r.expires_at,
        }))
    }
}
