//! `PostgreSQL` adapter for channel read state persistence.

use async_trait::async_trait;
use sqlx::PgPool;

use crate::domain::errors::DomainError;
use crate::domain::models::{ChannelId, ChannelReadState, MessageId, Role, UserId};
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

    async fn list_all_for_user(
        &self,
        user_id: &UserId,
    ) -> Result<Vec<ChannelReadState>, DomainError> {
        // WHY single query across all servers: eliminates N per-server REST calls.
        // The SSE handler sends this snapshot once on connect/reconnect.
        // WHY LEAST(..., 999): caps the COUNT scan to bound query cost at scale.
        // Discord caps unread at "999+" — same UX pattern.
        // WHY message_type != 'system': system messages (join/leave announcements)
        // should not count as unread — matches Discord behavior.
        // WHY HAVING: only return channels with unread > 0 to minimize payload size.
        // WHY the private-channel access predicate: channel access = membership +
        // (for private channels) admin/owner or a channel_role_access grant. Without
        // it this query leaks phantom unread counts for private channels a member
        // cannot open — and mark_read 403s on those channels (ensure_channel_access),
        // so the badge would be permanently unclearable. Mirrors the inline predicate
        // in channel_repository.rs list_for_server. $2 = 'owner', $3 = 'admin'
        // (Role::as_str, same style as list_for_server).
        // WHY mention_count is a computed FILTER, not a stored counter: mentions
        // are a strict subset of unreads, so the same scan yields both with one
        // extra aggregate — zero extra writes on send, zero drift on soft-delete,
        // and mark_read (moving last_read_at) resets it for free. Mention-equivalence
        // (§1/§2.2): a message counts when it mentions $1 OR the server is a DM
        // (s.is_dm) — the DM disjunct is why the DM home button shows a count.
        let rows = sqlx::query!(
            r#"
            SELECT
                c.id AS "channel_id!",
                crs.last_read_at AS "last_read_at?",
                crs.last_message_id,
                LEAST(COALESCE(COUNT(m.id)::BIGINT, 0), 999) AS "unread_count!",
                LEAST(COALESCE((COUNT(m.id) FILTER (
                    WHERE s.is_dm OR m.mentioned_user_ids @> ARRAY[$1]::uuid[]
                ))::BIGINT, 0), 999) AS "mention_count!"
            FROM server_members sm
            JOIN servers s ON s.id = sm.server_id
            JOIN channels c ON c.server_id = sm.server_id
            LEFT JOIN channel_read_states crs
                ON crs.channel_id = c.id AND crs.user_id = $1
            LEFT JOIN messages m
                ON m.channel_id = c.id
                AND m.deleted_at IS NULL
                AND m.author_id != $1
                AND m.message_type != 'system'
                AND (crs.last_read_at IS NULL OR m.created_at > crs.last_read_at)
            WHERE sm.user_id = $1
              AND (
                  c.is_private = false
                  OR sm.role IN ($2, $3)
                  OR EXISTS (
                      SELECT 1 FROM channel_role_access cra
                      WHERE cra.channel_id = c.id AND cra.role = sm.role
                  )
              )
            GROUP BY c.id, crs.last_read_at, crs.last_message_id
            HAVING COALESCE(COUNT(m.id)::BIGINT, 0) > 0
            "#,
            user_id.0,
            Role::Owner.as_str(),
            Role::Admin.as_str(),
        )
        .fetch_all(&self.pool)
        .await
        .map_err(super::db_err)?;

        let states = rows
            .into_iter()
            .map(|r| ChannelReadState {
                channel_id: ChannelId::new(r.channel_id),
                unread_count: r.unread_count,
                mention_count: r.mention_count,
                last_read_at: r.last_read_at,
                last_message_id: r.last_message_id.map(MessageId::new),
            })
            .collect();

        Ok(states)
    }
}
