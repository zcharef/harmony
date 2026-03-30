//! `PostgreSQL` adapter for channel read state persistence.

use async_trait::async_trait;
use sqlx::PgPool;

use crate::domain::errors::DomainError;
use crate::domain::models::{ChannelId, ChannelReadState, MessageId, ServerId, UserId};
use crate::domain::ports::ReadStateRepository;

/// PostgreSQL-backed read state repository.
#[derive(Debug, Clone)]
pub struct PgReadStateRepository {
    pool: PgPool,
}

impl PgReadStateRepository {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl ReadStateRepository for PgReadStateRepository {
    async fn mark_read(
        &self,
        channel_id: &ChannelId,
        user_id: &UserId,
        last_message_id: &MessageId,
    ) -> Result<(), DomainError> {
        sqlx::query!(
            r#"
            INSERT INTO channel_read_states (channel_id, user_id, last_read_at, last_message_id)
            VALUES ($1, $2, now(), $3)
            ON CONFLICT (channel_id, user_id)
            DO UPDATE SET last_read_at = now(), last_message_id = $3
            "#,
            channel_id.0,
            user_id.0,
            last_message_id.0,
        )
        .execute(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(())
    }

    async fn list_for_server(
        &self,
        server_id: &ServerId,
        user_id: &UserId,
    ) -> Result<Vec<ChannelReadState>, DomainError> {
        let rows = sqlx::query!(
            r#"
            SELECT
                c.id AS "channel_id!",
                crs.last_read_at AS "last_read_at?",
                crs.last_message_id,
                COALESCE(COUNT(m.id)::BIGINT, 0) AS "unread_count!"
            FROM channels c
            LEFT JOIN channel_read_states crs
                ON crs.channel_id = c.id AND crs.user_id = $2
            LEFT JOIN messages m
                ON m.channel_id = c.id
                AND m.deleted_at IS NULL
                AND m.author_id != $2
                AND (crs.last_read_at IS NULL OR m.created_at > crs.last_read_at)
            WHERE c.server_id = $1
            GROUP BY c.id, crs.last_read_at, crs.last_message_id
            "#,
            server_id.0,
            user_id.0,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(super::db_err)?;

        let states = rows
            .into_iter()
            .map(|r| ChannelReadState {
                channel_id: ChannelId::new(r.channel_id),
                unread_count: r.unread_count,
                last_read_at: r.last_read_at,
                last_message_id: r.last_message_id.map(MessageId::new),
            })
            .collect();

        Ok(states)
    }
}
