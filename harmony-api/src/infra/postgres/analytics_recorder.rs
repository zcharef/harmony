//! `PostgreSQL` adapter for the analytics event recorder.

use async_trait::async_trait;
use sqlx::PgPool;

use crate::domain::errors::DomainError;
use crate::domain::models::AnalyticsEvent;
use crate::domain::ports::AnalyticsRecorder;

/// PostgreSQL-backed analytics recorder (append-only `analytics_events`).
#[derive(Debug, Clone)]
pub struct PgAnalyticsRecorder {
    pool: PgPool,
}

impl PgAnalyticsRecorder {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl AnalyticsRecorder for PgAnalyticsRecorder {
    async fn record(&self, event: AnalyticsEvent) -> Result<(), DomainError> {
        // WHY ON CONFLICT DO NOTHING: once-per-user events (first_message)
        // have a partial unique index on (name, user_id); replays are
        // expected and must be silent no-ops, not errors.
        sqlx::query!(
            r#"
            INSERT INTO analytics_events (name, user_id, server_id, channel_id, properties)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT DO NOTHING
            "#,
            event.name.as_str(),
            event.user_id.map(|id| id.0),
            event.server_id.map(|id| id.0),
            event.channel_id.map(|id| id.0),
            event.properties,
        )
        .execute(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(())
    }
}
