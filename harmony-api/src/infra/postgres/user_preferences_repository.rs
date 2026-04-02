//! `PostgreSQL` adapter for user preferences persistence.

use async_trait::async_trait;
use sqlx::PgPool;

use crate::domain::errors::DomainError;
use crate::domain::models::{UserId, UserPreferences};
use crate::domain::ports::{UpdatePreferences, UserPreferencesRepository};

/// PostgreSQL-backed user preferences repository.
#[derive(Debug, Clone)]
pub struct PgUserPreferencesRepository {
    pool: PgPool,
}

impl PgUserPreferencesRepository {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl UserPreferencesRepository for PgUserPreferencesRepository {
    async fn get(&self, user_id: &UserId) -> Result<Option<UserPreferences>, DomainError> {
        let uid = user_id.0;

        let row = sqlx::query!(
            r#"
            SELECT user_id, dnd_enabled, hide_profanity, created_at, updated_at
            FROM user_preferences
            WHERE user_id = $1
            "#,
            uid,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(row.map(|r| UserPreferences {
            user_id: UserId(r.user_id),
            dnd_enabled: r.dnd_enabled,
            hide_profanity: r.hide_profanity,
            created_at: r.created_at,
            updated_at: r.updated_at,
        }))
    }

    async fn upsert(
        &self,
        user_id: &UserId,
        patch: UpdatePreferences,
    ) -> Result<UserPreferences, DomainError> {
        let uid = user_id.0;

        let row = sqlx::query!(
            r#"
            INSERT INTO user_preferences (user_id, dnd_enabled, hide_profanity, updated_at)
            VALUES ($1, COALESCE($2, false), COALESCE($3, true), now())
            ON CONFLICT (user_id) DO UPDATE SET
                dnd_enabled = COALESCE($2, user_preferences.dnd_enabled),
                hide_profanity = COALESCE($3, user_preferences.hide_profanity),
                updated_at = now()
            RETURNING user_id, dnd_enabled, hide_profanity, created_at, updated_at
            "#,
            uid,
            patch.dnd_enabled,
            patch.hide_profanity,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(UserPreferences {
            user_id: UserId(row.user_id),
            dnd_enabled: row.dnd_enabled,
            hide_profanity: row.hide_profanity,
            created_at: row.created_at,
            updated_at: row.updated_at,
        })
    }
}
