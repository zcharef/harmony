//! `PostgreSQL` adapter for the identity-image-scan dead-letter queue.

use async_trait::async_trait;
use sqlx::PgPool;

use crate::domain::errors::DomainError;
use crate::domain::models::{IdentityImageKind, IdentityImageScanRetry, UserId};
use crate::domain::ports::IdentityImageScanRetryRepository;

/// PostgreSQL-backed identity-image-scan retry repository.
#[derive(Debug, Clone)]
pub struct PgIdentityImageScanRetryRepository {
    pool: PgPool,
}

impl PgIdentityImageScanRetryRepository {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

/// Parse the stored `image_kind` text (`'avatar'`/`'banner'`) into the enum.
/// Unknown → `Avatar` (fail-safe: the sweep re-reads the actual pending column).
fn parse_kind(value: &str) -> IdentityImageKind {
    match value {
        "banner" => IdentityImageKind::Banner,
        _ => IdentityImageKind::Avatar,
    }
}

#[async_trait]
impl IdentityImageScanRetryRepository for PgIdentityImageScanRetryRepository {
    async fn insert(
        &self,
        user_id: &UserId,
        kind: IdentityImageKind,
        url: &str,
        error: &str,
    ) -> Result<(), DomainError> {
        // WHY UPSERT: concurrent scan failures for the same (user, kind) must not
        // duplicate rows (unique index). A repeat failure refreshes the error,
        // the URL (a newer candidate), and bumps the retry count.
        sqlx::query!(
            r#"
            INSERT INTO identity_image_scan_retry
                (user_id, image_kind, url, last_error)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (user_id, image_kind) DO UPDATE
            SET retry_count = identity_image_scan_retry.retry_count + 1,
                url = EXCLUDED.url,
                last_error = EXCLUDED.last_error,
                updated_at = now()
            "#,
            user_id.0,
            kind.as_db_str(),
            url,
            error,
        )
        .execute(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(())
    }

    async fn list_pending(&self, limit: i64) -> Result<Vec<IdentityImageScanRetry>, DomainError> {
        let rows = sqlx::query!(
            r#"
            SELECT user_id, image_kind, url, retry_count, last_error, created_at
            FROM identity_image_scan_retry
            WHERE retry_count < 5
            ORDER BY created_at ASC
            LIMIT $1
            "#,
            limit,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(rows
            .into_iter()
            .map(|r| IdentityImageScanRetry {
                user_id: UserId::new(r.user_id),
                kind: parse_kind(&r.image_kind),
                url: r.url,
                retry_count: r.retry_count,
                last_error: r.last_error,
                created_at: r.created_at,
            })
            .collect())
    }

    async fn delete(&self, user_id: &UserId, kind: IdentityImageKind) -> Result<(), DomainError> {
        sqlx::query!(
            r#"
            DELETE FROM identity_image_scan_retry
            WHERE user_id = $1 AND image_kind = $2
            "#,
            user_id.0,
            kind.as_db_str(),
        )
        .execute(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(())
    }

    async fn count_pending(&self) -> Result<i64, DomainError> {
        let row = sqlx::query!(
            r#"
            SELECT COUNT(*) AS "count!"
            FROM identity_image_scan_retry
            WHERE retry_count < 5
            "#,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(row.count)
    }
}
