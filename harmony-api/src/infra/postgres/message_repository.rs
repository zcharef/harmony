//! `PostgreSQL` adapter for message persistence.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use crate::domain::errors::DomainError;
use crate::domain::models::{ChannelId, Message, MessageId, UserId};
use crate::domain::ports::MessageRepository;

/// PostgreSQL-backed message repository.
#[derive(Debug, Clone)]
pub struct PgMessageRepository {
    pool: PgPool,
}

impl PgMessageRepository {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

/// Intermediate row type for sqlx decoding.
struct MessageRow {
    id: Uuid,
    channel_id: Uuid,
    author_id: Uuid,
    content: Option<String>,
    edited_at: Option<DateTime<Utc>>,
    deleted_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
}

impl MessageRow {
    fn into_message(self) -> Message {
        Message {
            id: MessageId::new(self.id),
            channel_id: ChannelId::new(self.channel_id),
            author_id: UserId::new(self.author_id),
            content: self.content.unwrap_or_default(),
            edited_at: self.edited_at,
            deleted_at: self.deleted_at,
            created_at: self.created_at,
        }
    }
}

#[async_trait]
impl MessageRepository for PgMessageRepository {
    async fn create(
        &self,
        channel_id: &ChannelId,
        author_id: &UserId,
        content: String,
    ) -> Result<Message, DomainError> {
        let cid = channel_id.0;
        let aid = author_id.0;

        let row = sqlx::query!(
            r#"
            INSERT INTO messages (channel_id, author_id, content)
            VALUES ($1, $2, $3)
            RETURNING
                id,
                channel_id,
                author_id,
                content,
                edited_at,
                deleted_at,
                created_at
            "#,
            cid,
            aid,
            content,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(super::db_err)?;

        let msg = MessageRow {
            id: row.id,
            channel_id: row.channel_id,
            author_id: row.author_id,
            content: row.content,
            edited_at: row.edited_at,
            deleted_at: row.deleted_at,
            created_at: row.created_at,
        };

        Ok(msg.into_message())
    }

    async fn list_for_channel(
        &self,
        channel_id: &ChannelId,
        cursor: Option<DateTime<Utc>>,
        limit: i64,
    ) -> Result<Vec<Message>, DomainError> {
        let cid = channel_id.0;

        // Cursor pagination (ADR-036): filter by created_at < cursor when present.
        // Soft deletes (ADR-038): exclude messages where deleted_at IS NOT NULL.
        let rows = sqlx::query!(
            r#"
            SELECT
                id,
                channel_id,
                author_id,
                content,
                edited_at,
                deleted_at,
                created_at
            FROM messages
            WHERE channel_id = $1
              AND deleted_at IS NULL
              AND ($2::timestamptz IS NULL OR created_at < $2)
            ORDER BY created_at DESC
            LIMIT $3
            "#,
            cid,
            cursor,
            limit,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(super::db_err)?;

        let messages = rows
            .into_iter()
            .map(|r| {
                MessageRow {
                    id: r.id,
                    channel_id: r.channel_id,
                    author_id: r.author_id,
                    content: r.content,
                    edited_at: r.edited_at,
                    deleted_at: r.deleted_at,
                    created_at: r.created_at,
                }
                .into_message()
            })
            .collect();

        Ok(messages)
    }

    async fn find_by_id(&self, message_id: &MessageId) -> Result<Option<Message>, DomainError> {
        let mid = message_id.0;

        let row = sqlx::query!(
            r#"
            SELECT
                id,
                channel_id,
                author_id,
                content,
                edited_at,
                deleted_at,
                created_at
            FROM messages
            WHERE id = $1 AND deleted_at IS NULL
            "#,
            mid,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(row.map(|r| {
            MessageRow {
                id: r.id,
                channel_id: r.channel_id,
                author_id: r.author_id,
                content: r.content,
                edited_at: r.edited_at,
                deleted_at: r.deleted_at,
                created_at: r.created_at,
            }
            .into_message()
        }))
    }

    async fn update_content(
        &self,
        message_id: &MessageId,
        content: String,
    ) -> Result<Message, DomainError> {
        let mid = message_id.0;

        let row = sqlx::query!(
            r#"
            UPDATE messages
            SET content = $2, is_edited = true, edited_at = now()
            WHERE id = $1 AND deleted_at IS NULL
            RETURNING
                id,
                channel_id,
                author_id,
                content,
                edited_at,
                deleted_at,
                created_at
            "#,
            mid,
            content,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(super::db_err)?
        .ok_or_else(|| DomainError::NotFound {
            resource_type: "Message",
            id: message_id.to_string(),
        })?;

        let msg = MessageRow {
            id: row.id,
            channel_id: row.channel_id,
            author_id: row.author_id,
            content: row.content,
            edited_at: row.edited_at,
            deleted_at: row.deleted_at,
            created_at: row.created_at,
        };

        Ok(msg.into_message())
    }

    async fn soft_delete(&self, message_id: &MessageId) -> Result<(), DomainError> {
        let mid = message_id.0;

        let result = sqlx::query!(
            r#"
            UPDATE messages
            SET deleted_at = now()
            WHERE id = $1 AND deleted_at IS NULL
            "#,
            mid,
        )
        .execute(&self.pool)
        .await
        .map_err(super::db_err)?;

        if result.rows_affected() == 0 {
            return Err(DomainError::NotFound {
                resource_type: "Message",
                id: message_id.to_string(),
            });
        }

        Ok(())
    }

    async fn count_recent(
        &self,
        channel_id: &ChannelId,
        author_id: &UserId,
        window_secs: i64,
    ) -> Result<i64, DomainError> {
        let cid = channel_id.0;
        let aid = author_id.0;

        let row = sqlx::query!(
            r#"
            SELECT COALESCE(COUNT(*)::BIGINT, 0) AS "count!"
            FROM messages
            WHERE channel_id = $1
              AND author_id = $2
              AND deleted_at IS NULL
              AND created_at > now() - make_interval(secs => $3::double precision)
            "#,
            cid,
            aid,
            window_secs as f64,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(row.count)
    }
}
