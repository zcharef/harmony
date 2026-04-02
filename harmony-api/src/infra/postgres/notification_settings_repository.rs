//! `PostgreSQL` adapter for notification settings persistence.

use async_trait::async_trait;
use sqlx::PgPool;

use crate::domain::errors::DomainError;
use crate::domain::models::{ChannelId, UserId};
use crate::domain::ports::{NotificationLevel, NotificationSettingsRepository};

/// PostgreSQL-backed notification settings repository.
#[derive(Debug, Clone)]
pub struct PgNotificationSettingsRepository {
    pool: PgPool,
}

impl PgNotificationSettingsRepository {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

/// Parse the Postgres `level` text into the domain enum.
fn parse_level(value: &str) -> NotificationLevel {
    match value {
        "all" => NotificationLevel::All,
        "mentions" => NotificationLevel::Mentions,
        "none" => NotificationLevel::None,
        unknown => {
            tracing::warn!(
                level = unknown,
                "Unknown notification level from database, defaulting to All"
            );
            NotificationLevel::All
        }
    }
}

/// Convert domain enum to Postgres text value.
fn level_to_str(level: &NotificationLevel) -> &'static str {
    match level {
        NotificationLevel::All => "all",
        NotificationLevel::Mentions => "mentions",
        NotificationLevel::None => "none",
    }
}

#[async_trait]
impl NotificationSettingsRepository for PgNotificationSettingsRepository {
    async fn get(
        &self,
        channel_id: &ChannelId,
        user_id: &UserId,
    ) -> Result<Option<NotificationLevel>, DomainError> {
        let cid = channel_id.0;
        let uid = user_id.0;

        let row = sqlx::query!(
            r#"
            SELECT level
            FROM channel_notification_settings
            WHERE channel_id = $1 AND user_id = $2
            "#,
            cid,
            uid,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(row.map(|r| parse_level(&r.level)))
    }

    async fn upsert(
        &self,
        channel_id: &ChannelId,
        user_id: &UserId,
        level: NotificationLevel,
    ) -> Result<(), DomainError> {
        let cid = channel_id.0;
        let uid = user_id.0;
        let level_str = level_to_str(&level);

        sqlx::query!(
            r#"
            INSERT INTO channel_notification_settings (channel_id, user_id, level, updated_at)
            VALUES ($1, $2, $3, now())
            ON CONFLICT (channel_id, user_id) DO UPDATE SET level = $3, updated_at = now()
            "#,
            cid,
            uid,
            level_str,
        )
        .execute(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(())
    }
}
