//! `PostgreSQL` adapter for the moderation audit log (append-only).

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::PgPool;

use crate::domain::errors::DomainError;
use crate::domain::models::{
    ModerationAction, ModerationLogEntry, ModerationLogId, NewModerationLogEntry, ServerId, UserId,
};
use crate::domain::ports::ModerationLogRepository;

/// PostgreSQL-backed moderation-log repository.
#[derive(Debug, Clone)]
pub struct PgModerationLogRepository {
    pool: PgPool,
}

impl PgModerationLogRepository {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl ModerationLogRepository for PgModerationLogRepository {
    async fn record(&self, entry: NewModerationLogEntry) -> Result<(), DomainError> {
        sqlx::query!(
            r#"
            INSERT INTO moderation_log
                (server_id, action, actor_id, target_user_id, target_message_id, reason, metadata)
            VALUES ($1, ($2::text)::moderation_action, $3, $4, $5, $6, $7)
            "#,
            entry.server_id.0,
            entry.action.as_db_str(),
            entry.actor_id.0,
            entry.target_user_id.as_ref().map(|u| u.0),
            entry.target_message_id,
            entry.reason,
            entry.metadata,
        )
        .execute(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(())
    }

    async fn list_paginated(
        &self,
        server_id: &ServerId,
        cursor: Option<DateTime<Utc>>,
        limit: i64,
    ) -> Result<Vec<ModerationLogEntry>, DomainError> {
        // Cursor pagination (ADR-036): created_at DESC, id DESC tiebreak matches
        // the idx_moderation_log_server_created index.
        let rows = sqlx::query!(
            r#"
            SELECT ml.id,
                   ml.server_id,
                   ml.action::text                     AS "action!",
                   ml.actor_id,
                   COALESCE(actor.username, '')        AS "actor_username!",
                   actor.avatar_url                    AS actor_avatar_url,
                   ml.target_user_id,
                   target.username                     AS "target_username?",
                   ml.target_message_id,
                   ml.reason,
                   ml.metadata                         AS "metadata!",
                   ml.created_at
            FROM moderation_log ml
            LEFT JOIN profiles actor  ON actor.id  = ml.actor_id
            LEFT JOIN profiles target ON target.id = ml.target_user_id
            WHERE ml.server_id = $1
              AND ($2::timestamptz IS NULL OR ml.created_at < $2)
            ORDER BY ml.created_at DESC, ml.id DESC
            LIMIT $3
            "#,
            server_id.0,
            cursor,
            limit,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(super::db_err)?;

        let mut entries = Vec::with_capacity(rows.len());
        for row in rows {
            // WHY hard error, not silent skip: an unknown action string means the
            // DB enum drifted ahead of the Rust enum — surfacing it (500) beats
            // dropping audit rows (ADR-027: no silent data loss).
            let action = ModerationAction::from_db_str(&row.action).ok_or_else(|| {
                DomainError::Internal(format!("Unknown moderation_action in DB: {}", row.action))
            })?;

            entries.push(ModerationLogEntry {
                id: ModerationLogId::new(row.id),
                server_id: ServerId::new(row.server_id),
                action,
                actor_id: UserId::new(row.actor_id),
                actor_username: row.actor_username,
                actor_avatar_url: row.actor_avatar_url,
                target_user_id: row.target_user_id.map(UserId::new),
                target_username: row.target_username,
                target_message_id: row.target_message_id,
                reason: row.reason,
                metadata: row.metadata,
                created_at: row.created_at,
            });
        }

        Ok(entries)
    }
}
