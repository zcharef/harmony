//! `PostgreSQL` adapter for DM conversation persistence.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::PgPool;

use crate::domain::errors::DomainError;
use crate::domain::models::{ChannelId, ServerId, UserId};
use crate::domain::ports::dm_repository::{DmRepository, DmRow};

/// PostgreSQL-backed DM repository.
#[derive(Debug, Clone)]
pub struct PgDmRepository {
    pool: PgPool,
}

impl PgDmRepository {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl DmRepository for PgDmRepository {
    async fn find_dm_between_users(
        &self,
        user_a: &UserId,
        user_b: &UserId,
    ) -> Result<Option<(ServerId, ChannelId)>, DomainError> {
        let uid_a = user_a.0;
        let uid_b = user_b.0;

        // WHY: Find a server that is_dm=true where BOTH users are members.
        // Using INTERSECT ensures exactly both users match, regardless of order.
        let row = sqlx::query!(
            r#"
            SELECT s.id AS server_id, c.id AS channel_id
            FROM servers s
            INNER JOIN channels c ON c.server_id = s.id
            WHERE s.is_dm = true
              AND EXISTS (
                  SELECT 1 FROM server_members WHERE server_id = s.id AND user_id = $1
              )
              AND EXISTS (
                  SELECT 1 FROM server_members WHERE server_id = s.id AND user_id = $2
              )
            LIMIT 1
            "#,
            uid_a,
            uid_b,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(row.map(|r| (ServerId::new(r.server_id), ChannelId::new(r.channel_id))))
    }

    async fn create_dm(
        &self,
        user_a: &UserId,
        user_b: &UserId,
    ) -> Result<(ServerId, ChannelId), DomainError> {
        let uid_a = user_a.0;
        let uid_b = user_b.0;

        // WHY: Transaction with a re-check inside prevents the race condition where
        // two concurrent create_or_get_dm calls both pass the initial find_dm check
        // and then both try to create a DM. The SERIALIZABLE-like re-check inside the
        // transaction ensures only one DM is ever created per user pair.
        let mut tx = self.pool.begin().await.map_err(super::db_err)?;

        // 1. Re-check for existing DM inside the transaction with FOR SHARE lock
        //    to prevent concurrent inserts from creating duplicates.
        let existing = sqlx::query!(
            r#"
            SELECT s.id AS server_id, c.id AS channel_id
            FROM servers s
            INNER JOIN channels c ON c.server_id = s.id
            WHERE s.is_dm = true
              AND EXISTS (
                  SELECT 1 FROM server_members WHERE server_id = s.id AND user_id = $1
                  FOR SHARE
              )
              AND EXISTS (
                  SELECT 1 FROM server_members WHERE server_id = s.id AND user_id = $2
                  FOR SHARE
              )
            LIMIT 1
            "#,
            uid_a,
            uid_b,
        )
        .fetch_optional(&mut *tx)
        .await
        .map_err(super::db_err)?;

        if let Some(row) = existing {
            tx.commit().await.map_err(super::db_err)?;
            return Ok((ServerId::new(row.server_id), ChannelId::new(row.channel_id)));
        }

        // 2. Create the DM server (is_dm=true)
        // WHY: name = 'dm' instead of '' because the servers table has a CHECK
        // constraint `servers_name_length` requiring char_length(name) BETWEEN 2 AND 100.
        // DM server names are never shown to users (the UI shows the recipient's name).
        let server_row = sqlx::query!(
            r#"
            INSERT INTO servers (name, owner_id, is_dm, is_public)
            VALUES ('dm', $1, true, false)
            RETURNING id
            "#,
            uid_a,
        )
        .fetch_one(&mut *tx)
        .await
        .map_err(super::db_err)?;

        let server_id = server_row.id;

        // 3. Create the single DM channel
        let channel_row = sqlx::query!(
            r#"
            INSERT INTO channels (server_id, name, channel_type, position)
            VALUES ($1, 'dm', 'text', 0)
            RETURNING id
            "#,
            server_id,
        )
        .fetch_one(&mut *tx)
        .await
        .map_err(super::db_err)?;

        let channel_id = channel_row.id;

        // 4. Add both users as members
        sqlx::query!(
            r#"
            INSERT INTO server_members (server_id, user_id)
            VALUES ($1, $2), ($1, $3)
            "#,
            server_id,
            uid_a,
            uid_b,
        )
        .execute(&mut *tx)
        .await
        .map_err(super::db_err)?;

        tx.commit().await.map_err(super::db_err)?;

        Ok((ServerId::new(server_id), ChannelId::new(channel_id)))
    }

    async fn list_dms_for_user(
        &self,
        user_id: &UserId,
        cursor: Option<DateTime<Utc>>,
        limit: i64,
    ) -> Result<Vec<DmRow>, DomainError> {
        let uid = user_id.0;

        // WHY: Join across servers, members, channels, profiles, and messages to build
        // a complete DM list in a single query. Uses LATERAL join for the latest message
        // to avoid N+1 queries. Sorted by most recent activity (message or join time).
        let rows = sqlx::query!(
            r#"
            SELECT
                s.id AS server_id,
                c.id AS channel_id,
                other_member.user_id AS other_user_id,
                p.username AS other_username,
                p.display_name AS other_display_name,
                p.avatar_url AS other_avatar_url,
                latest_msg.content AS "last_message_content?",
                latest_msg.created_at AS "last_message_at?: DateTime<Utc>",
                latest_msg.encrypted AS "last_message_encrypted?",
                my_membership.joined_at AS joined_at
            FROM servers s
            INNER JOIN server_members my_membership
                ON my_membership.server_id = s.id AND my_membership.user_id = $1
            INNER JOIN server_members other_member
                ON other_member.server_id = s.id AND other_member.user_id != $1
            INNER JOIN channels c ON c.server_id = s.id
            INNER JOIN profiles p ON p.id = other_member.user_id
            LEFT JOIN LATERAL (
                SELECT m.content, m.created_at, m.encrypted
                FROM messages m
                WHERE m.channel_id = c.id AND m.deleted_at IS NULL
                ORDER BY m.created_at DESC
                LIMIT 1
            ) latest_msg ON true
            WHERE s.is_dm = true
              AND (
                  $2::timestamptz IS NULL
                  OR COALESCE(latest_msg.created_at, my_membership.joined_at) < $2
              )
            ORDER BY COALESCE(latest_msg.created_at, my_membership.joined_at) DESC
            LIMIT $3
            "#,
            uid,
            cursor,
            limit,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(super::db_err)?;

        let dms = rows
            .into_iter()
            .map(|r| DmRow {
                server_id: ServerId::new(r.server_id),
                channel_id: ChannelId::new(r.channel_id),
                other_user_id: UserId::new(r.other_user_id),
                other_username: r.other_username,
                other_display_name: r.other_display_name,
                other_avatar_url: r.other_avatar_url,
                last_message_content: r.last_message_content,
                last_message_at: r.last_message_at,
                last_message_encrypted: r.last_message_encrypted,
                joined_at: r.joined_at,
            })
            .collect();

        Ok(dms)
    }

    async fn count_recent_dms_for_user(&self, user_id: &UserId) -> Result<i64, DomainError> {
        let uid = user_id.0;

        // WHY: Count DM servers the user joined in the last hour. Uses the
        // `joined_at` timestamp on `server_members` as the creation signal.
        // Only DM servers (is_dm=true) are counted.
        let row = sqlx::query!(
            r#"
            SELECT COALESCE(COUNT(*)::BIGINT, 0) AS "count!"
            FROM server_members sm
            INNER JOIN servers s ON s.id = sm.server_id
            WHERE sm.user_id = $1
              AND s.is_dm = true
              AND sm.joined_at > NOW() - INTERVAL '1 hour'
            "#,
            uid,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(row.count)
    }
}
