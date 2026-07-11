//! `PostgreSQL` adapter for custom server-emoji persistence.

use async_trait::async_trait;
use sqlx::PgPool;

use crate::domain::errors::DomainError;
use crate::domain::models::{EmojiId, ServerEmoji, ServerId, UserId};
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
        let row = sqlx::query!(
            r#"
            INSERT INTO server_emojis (server_id, name, url, is_animated, created_by)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id, server_id, name, url, is_animated, created_by, created_at
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
            created_at: row.created_at,
        })
    }

    async fn list_for_server(&self, server_id: &ServerId) -> Result<Vec<ServerEmoji>, DomainError> {
        let rows = sqlx::query!(
            r#"
            SELECT id, server_id, name, url, is_animated, created_by, created_at
            FROM server_emojis
            WHERE server_id = $1
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
                created_at: row.created_at,
            })
            .collect())
    }

    async fn get_by_id(&self, emoji_id: &EmojiId) -> Result<Option<ServerEmoji>, DomainError> {
        let row = sqlx::query!(
            r#"
            SELECT id, server_id, name, url, is_animated, created_by, created_at
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
