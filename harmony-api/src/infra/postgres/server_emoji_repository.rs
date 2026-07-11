//! `PostgreSQL` adapter for custom server-emoji persistence.

use async_trait::async_trait;
use sqlx::PgPool;

use crate::domain::errors::DomainError;
use crate::domain::models::{
    EmojiId, IdentityImageModerationStatus, ServerEmoji, ServerId, UserId,
};
use crate::domain::ports::ServerEmojiRepository;

/// PostgreSQL-backed custom server-emoji repository.
#[derive(Debug, Clone)]
pub struct PgServerEmojiRepository {
    pool: PgPool,
}

impl PgServerEmojiRepository {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl ServerEmojiRepository for PgServerEmojiRepository {
    async fn create(
        &self,
        server_id: &ServerId,
        name: &str,
        url: &str,
        is_animated: bool,
        created_by: &UserId,
    ) -> Result<ServerEmoji, DomainError> {
        // WHY explicit 'pending': the column DEFAULTs to 'approved' (grandfathers
        // pre-scan rows), but a freshly-created emoji must be held for scan and
        // NOT revealed to other members until the async scan promotes it.
        let row = sqlx::query!(
            r#"
            INSERT INTO server_emojis (server_id, name, url, is_animated, created_by, moderation_status)
            VALUES ($1, $2, $3, $4, $5, 'pending'::identity_image_moderation_status)
            RETURNING id, server_id, name, url, is_animated, created_by,
                      moderation_status::text AS "moderation_status!", created_at
            "#,
            server_id.0,
            name,
            url,
            is_animated,
            created_by.0,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(|e| {
            // WHY: the unique (server_id, name) constraint is the concurrency
            // backstop for two admins racing the same name — surface it as a
            // Conflict (409), not a 500.
            if let sqlx::Error::Database(ref db) = e
                && db.code().as_deref() == Some("23505")
            {
                return DomainError::Conflict(
                    "An emoji with this name already exists on the server".to_string(),
                );
            }
            super::db_err(e)
        })?;

        Ok(ServerEmoji {
            id: EmojiId::new(row.id),
            server_id: ServerId::new(row.server_id),
            name: row.name,
            url: row.url,
            is_animated: row.is_animated,
            created_by: UserId::new(row.created_by),
            moderation_status: IdentityImageModerationStatus::from_db_str(&row.moderation_status),
            created_at: row.created_at,
        })
    }

    async fn list_for_server(&self, server_id: &ServerId) -> Result<Vec<ServerEmoji>, DomainError> {
        // WHY 'approved' only: pending (unscanned) and rejected emoji are never
        // shown to members — the async scan reveals a clean emoji by promoting it.
        let rows = sqlx::query!(
            r#"
            SELECT id, server_id, name, url, is_animated, created_by,
                   moderation_status::text AS "moderation_status!", created_at
            FROM server_emojis
            WHERE server_id = $1
              AND moderation_status = 'approved'::identity_image_moderation_status
            ORDER BY created_at ASC
            "#,
            server_id.0,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(rows
            .into_iter()
            .map(|row| ServerEmoji {
                id: EmojiId::new(row.id),
                server_id: ServerId::new(row.server_id),
                name: row.name,
                url: row.url,
                is_animated: row.is_animated,
                created_by: UserId::new(row.created_by),
                moderation_status: IdentityImageModerationStatus::from_db_str(
                    &row.moderation_status,
                ),
                created_at: row.created_at,
            })
            .collect())
    }

    async fn get_by_id(&self, emoji_id: &EmojiId) -> Result<Option<ServerEmoji>, DomainError> {
        let row = sqlx::query!(
            r#"
            SELECT id, server_id, name, url, is_animated, created_by,
                   moderation_status::text AS "moderation_status!", created_at
            FROM server_emojis
            WHERE id = $1
            "#,
            emoji_id.0,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(row.map(|row| ServerEmoji {
            id: EmojiId::new(row.id),
            server_id: ServerId::new(row.server_id),
            name: row.name,
            url: row.url,
            is_animated: row.is_animated,
            created_by: UserId::new(row.created_by),
            moderation_status: IdentityImageModerationStatus::from_db_str(&row.moderation_status),
            created_at: row.created_at,
        }))
    }

    async fn promote(
        &self,
        emoji_id: &EmojiId,
        nsfw_score: Option<f32>,
    ) -> Result<Option<ServerEmoji>, DomainError> {
        // WHY the `moderation_status = 'pending'` guard: only a pending emoji may
        // be promoted. A stale verdict for an emoji already resolved (or deleted)
        // matches 0 rows → None → no-op, never re-revealing a gone emoji.
        let row = sqlx::query!(
            r#"
            UPDATE server_emojis
            SET moderation_status = 'approved'::identity_image_moderation_status,
                nsfw_score = $2,
                scanned_at = now()
            WHERE id = $1
              AND moderation_status = 'pending'::identity_image_moderation_status
            RETURNING id, server_id, name, url, is_animated, created_by,
                      moderation_status::text AS "moderation_status!", created_at
            "#,
            emoji_id.0,
            nsfw_score,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(row.map(|row| ServerEmoji {
            id: EmojiId::new(row.id),
            server_id: ServerId::new(row.server_id),
            name: row.name,
            url: row.url,
            is_animated: row.is_animated,
            created_by: UserId::new(row.created_by),
            moderation_status: IdentityImageModerationStatus::from_db_str(&row.moderation_status),
            created_at: row.created_at,
        }))
    }

    async fn reject(&self, emoji_id: &EmojiId) -> Result<Option<ServerEmoji>, DomainError> {
        // WHY DELETE (not a status flip): a flagged emoji never goes live and has
        // no "previous approved" to fall back to — the cleanest terminal state is
        // to drop the row entirely (the `emoji_image_scan_retry` FK cascades). The
        // returned row carries the url for best-effort object cleanup.
        let row = sqlx::query!(
            r#"
            DELETE FROM server_emojis
            WHERE id = $1
              AND moderation_status = 'pending'::identity_image_moderation_status
            RETURNING id, server_id, name, url, is_animated, created_by,
                      moderation_status::text AS "moderation_status!", created_at
            "#,
            emoji_id.0,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(row.map(|row| ServerEmoji {
            id: EmojiId::new(row.id),
            server_id: ServerId::new(row.server_id),
            name: row.name,
            url: row.url,
            is_animated: row.is_animated,
            created_by: UserId::new(row.created_by),
            moderation_status: IdentityImageModerationStatus::from_db_str(&row.moderation_status),
            created_at: row.created_at,
        }))
    }

    async fn delete(&self, emoji_id: &EmojiId) -> Result<(), DomainError> {
        sqlx::query!(r#"DELETE FROM server_emojis WHERE id = $1"#, emoji_id.0)
            .execute(&self.pool)
            .await
            .map_err(super::db_err)?;
        Ok(())
    }

    async fn count_for_server(&self, server_id: &ServerId) -> Result<i64, DomainError> {
        let count = sqlx::query_scalar!(
            r#"SELECT COALESCE(COUNT(*)::BIGINT, 0) as "count!" FROM server_emojis WHERE server_id = $1"#,
            server_id.0,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(super::db_err)?;
        Ok(count)
    }
}
