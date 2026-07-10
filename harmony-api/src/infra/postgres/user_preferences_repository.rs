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
            SELECT user_id, dnd_enabled, hide_profanity, onboarding_completed,
                   notifications_enabled, notify_messages, notify_dms, notify_mentions,
                   notification_sounds_enabled, created_at, updated_at
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
            onboarding_completed: r.onboarding_completed,
            notifications_enabled: r.notifications_enabled,
            notify_messages: r.notify_messages,
            notify_dms: r.notify_dms,
            notify_mentions: r.notify_mentions,
            notification_sounds_enabled: r.notification_sounds_enabled,
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
            INSERT INTO user_preferences (
                user_id, dnd_enabled, hide_profanity, onboarding_completed,
                notifications_enabled, notify_messages, notify_dms, notify_mentions,
                notification_sounds_enabled, updated_at
            )
            VALUES (
                $1, COALESCE($2, false), COALESCE($3, true), COALESCE($4, false),
                COALESCE($5, true), COALESCE($6, true), COALESCE($7, true),
                COALESCE($8, true), COALESCE($9, true), now()
            )
            ON CONFLICT (user_id) DO UPDATE SET
                dnd_enabled = COALESCE($2, user_preferences.dnd_enabled),
                hide_profanity = COALESCE($3, user_preferences.hide_profanity),
                onboarding_completed = COALESCE($4, user_preferences.onboarding_completed),
                notifications_enabled = COALESCE($5, user_preferences.notifications_enabled),
                notify_messages = COALESCE($6, user_preferences.notify_messages),
                notify_dms = COALESCE($7, user_preferences.notify_dms),
                notify_mentions = COALESCE($8, user_preferences.notify_mentions),
                notification_sounds_enabled = COALESCE($9, user_preferences.notification_sounds_enabled),
                updated_at = now()
            RETURNING user_id, dnd_enabled, hide_profanity, onboarding_completed,
                      notifications_enabled, notify_messages, notify_dms, notify_mentions,
                      notification_sounds_enabled, created_at, updated_at
            "#,
            uid,
            patch.dnd_enabled,
            patch.hide_profanity,
            patch.onboarding_completed,
            patch.notifications_enabled,
            patch.notify_messages,
            patch.notify_dms,
            patch.notify_mentions,
            patch.notification_sounds_enabled,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(UserPreferences {
            user_id: UserId(row.user_id),
            dnd_enabled: row.dnd_enabled,
            hide_profanity: row.hide_profanity,
            onboarding_completed: row.onboarding_completed,
            notifications_enabled: row.notifications_enabled,
            notify_messages: row.notify_messages,
            notify_dms: row.notify_dms,
            notify_mentions: row.notify_mentions,
            notification_sounds_enabled: row.notification_sounds_enabled,
            created_at: row.created_at,
            updated_at: row.updated_at,
        })
    }
}
