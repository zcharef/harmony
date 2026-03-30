//! `PostgreSQL` adapter for message reaction persistence.

use std::collections::HashMap;

use async_trait::async_trait;
use sqlx::PgPool;
use uuid::Uuid;

use crate::domain::errors::DomainError;
use crate::domain::models::{MessageId, ReactionSummary, UserId};
use crate::domain::ports::ReactionRepository;

/// PostgreSQL-backed reaction repository.
#[derive(Debug, Clone)]
pub struct PgReactionRepository {
    pool: PgPool,
}

impl PgReactionRepository {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl ReactionRepository for PgReactionRepository {
    async fn add(
        &self,
        message_id: &MessageId,
        user_id: &UserId,
        emoji: &str,
    ) -> Result<(), DomainError> {
        sqlx::query!(
            r#"
            INSERT INTO message_reactions (message_id, user_id, emoji)
            VALUES ($1, $2, $3)
            ON CONFLICT (message_id, user_id, emoji) DO NOTHING
            "#,
            message_id.0,
            user_id.0,
            emoji,
        )
        .execute(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(())
    }

    async fn remove(
        &self,
        message_id: &MessageId,
        user_id: &UserId,
        emoji: &str,
    ) -> Result<(), DomainError> {
        sqlx::query!(
            r#"
            DELETE FROM message_reactions
            WHERE message_id = $1 AND user_id = $2 AND emoji = $3
            "#,
            message_id.0,
            user_id.0,
            emoji,
        )
        .execute(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(())
    }

    async fn batch_for_messages(
        &self,
        message_ids: &[MessageId],
        viewer_id: &UserId,
    ) -> Result<HashMap<MessageId, Vec<ReactionSummary>>, DomainError> {
        // WHY: Empty array guard — skip DB call entirely.
        if message_ids.is_empty() {
            return Ok(HashMap::new());
        }

        let ids: Vec<Uuid> = message_ids.iter().map(|id| id.0).collect();

        let rows = sqlx::query!(
            r#"
            SELECT
                message_id,
                emoji,
                COALESCE(COUNT(*)::BIGINT, 0) as "count!",
                BOOL_OR(user_id = $2) as "reacted_by_me!"
            FROM message_reactions
            WHERE message_id = ANY($1::uuid[])
            GROUP BY message_id, emoji
            ORDER BY message_id, MIN(created_at)
            "#,
            &ids,
            viewer_id.0,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(super::db_err)?;

        let mut result: HashMap<MessageId, Vec<ReactionSummary>> = HashMap::new();
        for row in rows {
            let msg_id = MessageId::new(row.message_id);
            let summary = ReactionSummary {
                emoji: row.emoji,
                count: row.count,
                reacted_by_me: row.reacted_by_me,
            };
            result.entry(msg_id).or_default().push(summary);
        }

        Ok(result)
    }
}
