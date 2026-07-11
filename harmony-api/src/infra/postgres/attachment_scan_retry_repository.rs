//! `PostgreSQL` adapter for the attachment-scan dead-letter queue.

use async_trait::async_trait;
use sqlx::PgPool;

use crate::domain::errors::DomainError;
use crate::domain::models::{AttachmentId, AttachmentScanRetry, ChannelId, MessageId};
use crate::domain::ports::AttachmentScanRetryRepository;

/// PostgreSQL-backed attachment-scan retry repository.
#[derive(Debug, Clone)]
pub struct PgAttachmentScanRetryRepository {
    pool: PgPool,
}

impl PgAttachmentScanRetryRepository {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl AttachmentScanRetryRepository for PgAttachmentScanRetryRepository {
    async fn insert(
        &self,
        attachment_id: &AttachmentId,
        message_id: &MessageId,
        channel_id: &ChannelId,
        url: &str,
        mime: &str,
        error: &str,
    ) -> Result<(), DomainError> {
        // WHY UPSERT: concurrent scan failures for the same attachment must not
        // duplicate rows (unique index on attachment_id). A repeat failure
        // refreshes the error and bumps the retry count.
        sqlx::query!(
            r#"
            INSERT INTO attachment_scan_retry
                (attachment_id, message_id, channel_id, url, mime, last_error)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (attachment_id) DO UPDATE
            SET retry_count = attachment_scan_retry.retry_count + 1,
                last_error = EXCLUDED.last_error,
                updated_at = now()
            "#,
            attachment_id.0,
            message_id.0,
            channel_id.0,
            url,
            mime,
            error,
        )
        .execute(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(())
    }

    async fn list_pending(&self, limit: i64) -> Result<Vec<AttachmentScanRetry>, DomainError> {
        let rows = sqlx::query!(
            r#"
            SELECT attachment_id, message_id, channel_id, url, mime,
                   retry_count, last_error, created_at
            FROM attachment_scan_retry
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
            .map(|r| AttachmentScanRetry {
                attachment_id: AttachmentId::new(r.attachment_id),
                message_id: MessageId::new(r.message_id),
                channel_id: ChannelId::new(r.channel_id),
                url: r.url,
                mime: r.mime,
                retry_count: r.retry_count,
                last_error: r.last_error,
                created_at: r.created_at,
            })
            .collect())
    }

    async fn increment_retry(
        &self,
        attachment_id: &AttachmentId,
        error: &str,
    ) -> Result<i32, DomainError> {
        let row = sqlx::query!(
            r#"
            UPDATE attachment_scan_retry
            SET retry_count = retry_count + 1,
                last_error = $2,
                updated_at = now()
            WHERE attachment_id = $1
            RETURNING retry_count
            "#,
            attachment_id.0,
            error,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(row.retry_count)
    }

    async fn delete(&self, attachment_id: &AttachmentId) -> Result<(), DomainError> {
        sqlx::query!(
            r#"
            DELETE FROM attachment_scan_retry
            WHERE attachment_id = $1
            "#,
            attachment_id.0,
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
            FROM attachment_scan_retry
            WHERE retry_count < 5
            "#,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(row.count)
    }
}
