//! `PostgreSQL` adapter for the moderation retry dead-letter queue.

use async_trait::async_trait;
use sqlx::PgPool;

use crate::domain::errors::DomainError;
use crate::domain::models::{ChannelId, MessageId, ModerationRetry, ModerationRetryId, ServerId};
use crate::domain::ports::ModerationRetryRepository;

/// PostgreSQL-backed moderation retry repository.
#[derive(Debug, Clone)]
pub struct PgModerationRetryRepository {
    pool: PgPool,
}

impl PgModerationRetryRepository {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl ModerationRetryRepository for PgModerationRetryRepository {
    async fn insert(
        &self,
        message_id: &MessageId,
        server_id: &ServerId,
        channel_id: &ChannelId,
        content: &str,
        error: &str,
    ) -> Result<(), DomainError> {
        sqlx::query!(
            r#"
            INSERT INTO moderation_retries (message_id, server_id, channel_id, content, last_error)
            VALUES ($1, $2, $3, $4, $5)
            "#,
            message_id.0,
            server_id.0,
            channel_id.0,
            content,
            error,
        )
        .execute(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(())
    }

    async fn list_pending(&self, limit: i64) -> Result<Vec<ModerationRetry>, DomainError> {
        let rows = sqlx::query!(
            r#"
            SELECT id, message_id, server_id, channel_id, content,
                   retry_count, last_error, created_at
            FROM moderation_retries
            WHERE retry_count < 5
            ORDER BY created_at ASC
            LIMIT $1
            "#,
            limit,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(super::db_err)?;

        let retries = rows
            .into_iter()
            .map(|r| ModerationRetry {
                id: ModerationRetryId::new(r.id),
                message_id: MessageId::new(r.message_id),
                server_id: ServerId::new(r.server_id),
                channel_id: ChannelId::new(r.channel_id),
                content: r.content,
                retry_count: r.retry_count,
                last_error: r.last_error,
                created_at: r.created_at,
            })
            .collect();

        Ok(retries)
    }

    async fn increment_retry(
        &self,
        id: &ModerationRetryId,
        error: &str,
    ) -> Result<i32, DomainError> {
        let row = sqlx::query!(
            r#"
            UPDATE moderation_retries
            SET retry_count = retry_count + 1,
                last_error = $2,
                updated_at = now()
            WHERE id = $1
            RETURNING retry_count
            "#,
            id.0,
            error,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(row.retry_count)
    }

    async fn delete(&self, id: &ModerationRetryId) -> Result<(), DomainError> {
        sqlx::query!(
            r#"
            DELETE FROM moderation_retries
            WHERE id = $1
            "#,
            id.0,
        )
        .execute(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(())
    }
}
