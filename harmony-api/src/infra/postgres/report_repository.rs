//! `PostgreSQL` adapter for user-filed message reports.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use crate::domain::errors::DomainError;
use crate::domain::models::{
    ChannelId, MessageReport, NewMessageReport, ReportId, ReportStatus, ReportedMessageSnapshot,
    ServerId, UserId,
};
use crate::domain::ports::ReportRepository;

/// Character cap for the reported-message plaintext preview shown in the queue.
const SNIPPET_MAX_CHARS: usize = 140;

/// PostgreSQL-backed report repository.
#[derive(Debug, Clone)]
pub struct PgReportRepository {
    pool: PgPool,
}

impl PgReportRepository {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

/// Flat join row decoded by sqlx before mapping to the domain model.
struct ReportJoinRow {
    id: Uuid,
    server_id: Uuid,
    channel_id: Uuid,
    message_id: Uuid,
    reporter_id: Uuid,
    reporter_username: String,
    reported_user_id: Uuid,
    reported_username: String,
    reason: String,
    status: String,
    message_row_id: Option<Uuid>,
    message_content: Option<String>,
    message_deleted_at: Option<DateTime<Utc>>,
    message_encrypted: Option<bool>,
    resolved_by: Option<Uuid>,
    resolved_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
}

/// Truncate on a char boundary for the queue preview.
fn truncate_snippet(content: &str) -> String {
    content.chars().take(SNIPPET_MAX_CHARS).collect()
}

impl ReportJoinRow {
    fn into_report(self) -> Result<MessageReport, DomainError> {
        let status = ReportStatus::from_db_str(&self.status).ok_or_else(|| {
            DomainError::Internal(format!("Unknown report_status in DB: {}", self.status))
        })?;

        // Reported-message snapshot. Guard order matters: encrypted content must
        // never leak, and a deleted/purged row shows a tombstone, not content.
        let snapshot = match self.message_row_id {
            None => ReportedMessageSnapshot {
                snippet: None,
                deleted: true,
                encrypted: false,
            },
            Some(_) => {
                let encrypted = self.message_encrypted.unwrap_or(false);
                let deleted = self.message_deleted_at.is_some();
                if deleted {
                    ReportedMessageSnapshot {
                        snippet: None,
                        deleted: true,
                        encrypted,
                    }
                } else if encrypted {
                    ReportedMessageSnapshot {
                        snippet: None,
                        deleted: false,
                        encrypted: true,
                    }
                } else {
                    ReportedMessageSnapshot {
                        snippet: self.message_content.as_deref().map(truncate_snippet),
                        deleted: false,
                        encrypted: false,
                    }
                }
            }
        };

        Ok(MessageReport {
            id: ReportId::new(self.id),
            server_id: ServerId::new(self.server_id),
            channel_id: ChannelId::new(self.channel_id),
            message_id: self.message_id,
            reporter_id: UserId::new(self.reporter_id),
            reporter_username: self.reporter_username,
            reported_user_id: UserId::new(self.reported_user_id),
            reported_username: self.reported_username,
            reason: self.reason,
            status,
            message: snapshot,
            resolved_by: self.resolved_by.map(UserId::new),
            resolved_at: self.resolved_at,
            created_at: self.created_at,
        })
    }
}

impl PgReportRepository {
    /// Fetch one report (any status) scoped to its server.
    async fn fetch_by_id(
        &self,
        server_id: &ServerId,
        report_id: &ReportId,
    ) -> Result<Option<MessageReport>, DomainError> {
        let row = sqlx::query_as!(
            ReportJoinRow,
            r#"
            SELECT r.id,
                   r.server_id,
                   r.channel_id,
                   r.message_id,
                   r.reporter_id,
                   COALESCE(reporter.username, '') AS "reporter_username!",
                   r.reported_user_id,
                   COALESCE(reported.username, '') AS "reported_username!",
                   r.reason,
                   r.status::text                  AS "status!",
                   m.id                            AS "message_row_id?",
                   m.content                       AS "message_content?",
                   m.deleted_at                    AS "message_deleted_at?",
                   m.encrypted                     AS "message_encrypted?",
                   r.resolved_by,
                   r.resolved_at,
                   r.created_at
            FROM message_reports r
            LEFT JOIN profiles reporter ON reporter.id = r.reporter_id
            LEFT JOIN profiles reported ON reported.id = r.reported_user_id
            LEFT JOIN messages m        ON m.id        = r.message_id
            WHERE r.id = $2 AND r.server_id = $1
            "#,
            server_id.0,
            report_id.0,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(super::db_err)?;

        row.map(ReportJoinRow::into_report).transpose()
    }
}

#[async_trait]
impl ReportRepository for PgReportRepository {
    async fn create(&self, report: NewMessageReport) -> Result<MessageReport, DomainError> {
        let inserted = sqlx::query!(
            r#"
            INSERT INTO message_reports
                (server_id, channel_id, message_id, reporter_id, reported_user_id, reason)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id
            "#,
            report.server_id.0,
            report.channel_id.0,
            report.message_id,
            report.reporter_id.0,
            report.reported_user_id.0,
            report.reason,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(|e| match e {
            sqlx::Error::Database(ref db_err) if db_err.is_unique_violation() => {
                DomainError::Conflict("You already reported this message".to_string())
            }
            other => super::db_err(other),
        })?;

        self.fetch_by_id(&report.server_id, &ReportId::new(inserted.id))
            .await?
            .ok_or_else(|| {
                DomainError::Internal("Report vanished immediately after insert".to_string())
            })
    }

    async fn list_open_paginated(
        &self,
        server_id: &ServerId,
        cursor: Option<DateTime<Utc>>,
        limit: i64,
    ) -> Result<Vec<MessageReport>, DomainError> {
        let rows = sqlx::query_as!(
            ReportJoinRow,
            r#"
            SELECT r.id,
                   r.server_id,
                   r.channel_id,
                   r.message_id,
                   r.reporter_id,
                   COALESCE(reporter.username, '') AS "reporter_username!",
                   r.reported_user_id,
                   COALESCE(reported.username, '') AS "reported_username!",
                   r.reason,
                   r.status::text                  AS "status!",
                   m.id                            AS "message_row_id?",
                   m.content                       AS "message_content?",
                   m.deleted_at                    AS "message_deleted_at?",
                   m.encrypted                     AS "message_encrypted?",
                   r.resolved_by,
                   r.resolved_at,
                   r.created_at
            FROM message_reports r
            LEFT JOIN profiles reporter ON reporter.id = r.reporter_id
            LEFT JOIN profiles reported ON reported.id = r.reported_user_id
            LEFT JOIN messages m        ON m.id        = r.message_id
            WHERE r.server_id = $1
              AND r.status = 'open'
              AND ($2::timestamptz IS NULL OR r.created_at < $2)
            ORDER BY r.created_at DESC, r.id DESC
            LIMIT $3
            "#,
            server_id.0,
            cursor,
            limit,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(super::db_err)?;

        rows.into_iter().map(ReportJoinRow::into_report).collect()
    }

    async fn get(
        &self,
        server_id: &ServerId,
        report_id: &ReportId,
    ) -> Result<Option<MessageReport>, DomainError> {
        self.fetch_by_id(server_id, report_id).await
    }

    async fn resolve(
        &self,
        server_id: &ServerId,
        report_id: &ReportId,
        status: ReportStatus,
        resolved_by: &UserId,
    ) -> Result<MessageReport, DomainError> {
        // WHY status='open' guard: only an OPEN report may transition, and the
        // guard makes a double-resolve a NotFound rather than silently
        // re-stamping resolved_by/resolved_at.
        let updated = sqlx::query!(
            r#"
            UPDATE message_reports
            SET status      = ($3::text)::report_status,
                resolved_by = $4,
                resolved_at = now()
            WHERE id = $2 AND server_id = $1 AND status = 'open'
            RETURNING id
            "#,
            server_id.0,
            report_id.0,
            status.as_db_str(),
            resolved_by.0,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(super::db_err)?;

        if updated.is_none() {
            return Err(DomainError::NotFound {
                resource_type: "MessageReport",
                id: report_id.to_string(),
            });
        }

        self.fetch_by_id(server_id, report_id)
            .await?
            .ok_or_else(|| {
                DomainError::Internal("Report vanished immediately after resolve".to_string())
            })
    }

    async fn count_open(&self, server_id: &ServerId) -> Result<i64, DomainError> {
        let row = sqlx::query!(
            r#"
            SELECT COUNT(*) AS "count!"
            FROM message_reports
            WHERE server_id = $1 AND status = 'open'
            "#,
            server_id.0,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(row.count)
    }
}
