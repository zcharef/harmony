//! `PostgreSQL` adapter for desktop auth code persistence.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::PgPool;

use crate::domain::errors::DomainError;
use crate::domain::models::DesktopAuthCode;
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

/// Intermediate row type for `desktop_auth_codes` sqlx decoding.
struct DesktopAuthCodeRow {
    auth_code: String,
    code_challenge: String,
    access_token: String,
    refresh_token: String,
    expires_at: DateTime<Utc>,
}

impl DesktopAuthCodeRow {
    fn into_desktop_auth_code(self) -> DesktopAuthCode {
        DesktopAuthCode {
            auth_code: self.auth_code,
            code_challenge: self.code_challenge,
            access_token: self.access_token,
            refresh_token: self.refresh_token,
            expires_at: self.expires_at,
        }
    }
}

#[async_trait]
impl DesktopAuthRepository for PgDesktopAuthRepository {
    async fn create_code(
        &self,
        auth_code: &str,
        code_challenge: &str,
        access_token: &str,
        refresh_token: &str,
        expires_at: DateTime<Utc>,
    ) -> Result<(), DomainError> {
        sqlx::query!(
            "INSERT INTO desktop_auth_codes (auth_code, code_challenge, access_token, refresh_token, expires_at) \
             VALUES ($1, $2, $3, $4, $5)",
            auth_code,
            code_challenge,
            access_token,
            refresh_token,
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
        let row = sqlx::query!(
            r#"
            DELETE FROM desktop_auth_codes
            WHERE auth_code = $1 AND expires_at > now()
            RETURNING auth_code, code_challenge, access_token, refresh_token, expires_at
            "#,
            auth_code,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(row.map(|r| {
            DesktopAuthCodeRow {
                auth_code: r.auth_code,
                code_challenge: r.code_challenge,
                access_token: r.access_token,
                refresh_token: r.refresh_token,
                expires_at: r.expires_at,
            }
            .into_desktop_auth_code()
        }))
    }
}
