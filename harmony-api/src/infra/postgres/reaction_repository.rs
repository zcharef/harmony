//! `PostgreSQL` adapter for message reaction persistence.

use std::collections::HashMap;

use async_trait::async_trait;
use sqlx::PgPool;
use uuid::Uuid;

use crate::domain::errors::DomainError;
use crate::domain::models::{EmojiVariety, MessageId, ReactionSummary, Reactor, UserId};
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

    async fn emoji_variety(
        &self,
        message_id: &MessageId,
        emoji: &str,
    ) -> Result<EmojiVariety, DomainError> {
        // WHY: COUNT(DISTINCT ...) already returns BIGINT (no ::BIGINT cast
        // needed per ADR-024 — that rule targets SUM); BOOL_OR over zero rows
        // is NULL, hence the COALESCE.
        let row = sqlx::query!(
            r#"
            SELECT
                COUNT(DISTINCT emoji) AS "count!",
                COALESCE(BOOL_OR(emoji = $2), false) AS "exists!"
            FROM message_reactions
            WHERE message_id = $1
            "#,
            message_id.0,
            emoji,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(EmojiVariety {
            distinct_count: row.count,
            emoji_present: row.exists,
        })
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

        // WHY window functions + `rn <= 10` filter (not a jsonb_agg): the reactor
        // list is bounded to the first 10 per (message, emoji) IN Postgres, so a
        // heavily-reacted message transfers at most 10 reactor rows per emoji —
        // while `COUNT(*) OVER` keeps the authoritative (unbounded) total and
        // `BOOL_OR(...) OVER` reflects the viewer even when they are the 11th+
        // reactor. Rows come back pre-ordered so the same (message, emoji) group
        // is contiguous and we fold it into one `ReactionSummary` in Rust —
        // mirroring `attachment_repository::batch_for_messages` rather than
        // pulling in the sqlx `json` feature.
        let rows = sqlx::query!(
            r#"
            SELECT
                message_id,
                emoji,
                username,
                display_name,
                total_count AS "total_count!",
                reacted_by_me AS "reacted_by_me!"
            FROM (
                SELECT
                    mr.message_id,
                    mr.emoji,
                    p.username,
                    p.display_name,
                    ROW_NUMBER() OVER (
                        PARTITION BY mr.message_id, mr.emoji
                        ORDER BY mr.created_at, mr.user_id
                    ) AS rn,
                    COUNT(*) OVER (PARTITION BY mr.message_id, mr.emoji) AS total_count,
                    BOOL_OR(mr.user_id = $2) OVER (PARTITION BY mr.message_id, mr.emoji)
                        AS reacted_by_me,
                    MIN(mr.created_at) OVER (PARTITION BY mr.message_id, mr.emoji)
                        AS group_created_at
                FROM message_reactions mr
                JOIN profiles p ON p.id = mr.user_id
                WHERE mr.message_id = ANY($1::uuid[])
            ) ranked
            WHERE rn <= 10
            ORDER BY message_id, group_created_at, emoji, rn
            "#,
            &ids,
            viewer_id.0,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(super::db_err)?;

        let mut result: HashMap<MessageId, Vec<ReactionSummary>> = HashMap::new();
        // WHY track the last (message, emoji): rows are ordered so each group's
        // reactor rows are contiguous and the group's summary is always the
        // last one pushed for that message — so we append to it directly.
        let mut current_key: Option<(Uuid, String)> = None;
        for row in rows {
            let msg_id = MessageId::new(row.message_id);
            let reactor = Reactor {
                username: row.username,
                display_name: row.display_name,
            };
            let key = (row.message_id, row.emoji.clone());

            if current_key.as_ref() == Some(&key) {
                if let Some(last) = result.get_mut(&msg_id).and_then(|s| s.last_mut()) {
                    last.reactors.push(reactor);
                } else {
                    // Unreachable given the contiguous ordering, but never drop a
                    // reactor silently (ADR-027).
                    tracing::warn!(
                        message_id = %row.message_id,
                        emoji = %row.emoji,
                        "reactor row had no summary to append to; starting a new group"
                    );
                    result.entry(msg_id).or_default().push(ReactionSummary {
                        emoji: row.emoji,
                        count: row.total_count,
                        reacted_by_me: row.reacted_by_me,
                        reactors: vec![reactor],
                    });
                }
            } else {
                result.entry(msg_id).or_default().push(ReactionSummary {
                    emoji: row.emoji,
                    count: row.total_count,
                    reacted_by_me: row.reacted_by_me,
                    reactors: vec![reactor],
                });
                current_key = Some(key);
            }
        }

        Ok(result)
    }
}
