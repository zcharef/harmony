//! `PostgreSQL` adapter for the emoji-image-scan dead-letter queue.

use async_trait::async_trait;
use sqlx::PgPool;

use crate::domain::errors::DomainError;
use crate::domain::models::{EmojiId, EmojiImageScanRetry};
use crate::domain::ports::EmojiImageScanRetryRepository;

/// PostgreSQL-backed emoji-image-scan retry repository.
#[derive(Debug, Clone)]
pub struct PgEmojiImageScanRetryRepository {
    pool: PgPool,
}

impl PgEmojiImageScanRetryRepository {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl EmojiImageScanRetryRepository for PgEmojiImageScanRetryRepository {
    async fn insert(&self, emoji_id: &EmojiId, url: &str, error: &str) -> Result<(), DomainError> {
        // WHY UPSERT: concurrent scan failures for the same emoji must not
        // duplicate rows (unique index). A repeat failure refreshes the error and
        // bumps the retry count.
        sqlx::query!(
            r#"
            INSERT INTO emoji_image_scan_retry (emoji_id, url, last_error)
            VALUES ($1, $2, $3)
            ON CONFLICT (emoji_id) DO UPDATE
            SET retry_count = emoji_image_scan_retry.retry_count + 1,
                url = EXCLUDED.url,
                last_error = EXCLUDED.last_error,
                updated_at = now()
            "#,
            emoji_id.0,
            url,
            error,
        )
        .execute(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(())
    }

    async fn list_pending(&self, limit: i64) -> Result<Vec<EmojiImageScanRetry>, DomainError> {
        let rows = sqlx::query!(
            r#"
            SELECT emoji_id, url, retry_count, last_error, created_at
            FROM emoji_image_scan_retry
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
            .map(|r| EmojiImageScanRetry {
                emoji_id: EmojiId::new(r.emoji_id),
                url: r.url,
                retry_count: r.retry_count,
                last_error: r.last_error,
                created_at: r.created_at,
            })
            .collect())
    }

    async fn delete(&self, emoji_id: &EmojiId) -> Result<(), DomainError> {
        sqlx::query!(
            r#"DELETE FROM emoji_image_scan_retry WHERE emoji_id = $1"#,
            emoji_id.0,
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
            FROM emoji_image_scan_retry
            WHERE retry_count < 5
            "#,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(row.count)
    }
}
