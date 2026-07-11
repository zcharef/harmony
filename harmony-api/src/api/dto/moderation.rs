//! Moderation Dashboard v2 DTOs (T3.3): audit log + reports queue.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};
use uuid::Uuid;

use crate::domain::models::{
    MessageReport, ModerationAction, ModerationLogEntry, ReportReason, ReportStatus, UserId,
};

// ── Audit log ────────────────────────────────────────────────

/// Query parameters for listing the moderation audit log (cursor pagination).
#[derive(Debug, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "camelCase")]
#[into_params(parameter_in = Query)]
pub struct ModerationLogQuery {
    /// ISO 8601 timestamp cursor — fetch entries created before this time.
    pub before: Option<String>,
    /// Maximum number of entries to return (1-100, default 50).
    pub limit: Option<i64>,
}

/// A single moderation audit-log entry.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModerationLogResponse {
    pub id: Uuid,
    pub action: ModerationAction,
    pub actor_id: UserId,
    /// Actor display name. Empty when the actor profile was removed.
    pub actor_username: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor_avatar_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_user_id: Option<UserId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_message_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Action-specific extras (`{"count":12}` etc). Always a JSON object.
    pub metadata: serde_json::Value,
    pub created_at: DateTime<Utc>,
}

impl From<ModerationLogEntry> for ModerationLogResponse {
    fn from(e: ModerationLogEntry) -> Self {
        Self {
            id: e.id.0,
            action: e.action,
            actor_id: e.actor_id,
            actor_username: e.actor_username,
            actor_avatar_url: e.actor_avatar_url,
            target_user_id: e.target_user_id,
            target_username: e.target_username,
            target_message_id: e.target_message_id,
            reason: e.reason,
            metadata: e.metadata,
            created_at: e.created_at,
        }
    }
}

/// Cursor-paginated envelope for the audit log (ADR-036).
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModerationLogListResponse {
    pub items: Vec<ModerationLogResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

impl ModerationLogListResponse {
    #[must_use]
    pub fn new(entries: Vec<ModerationLogEntry>, next_cursor: Option<String>) -> Self {
        Self {
            items: entries
                .into_iter()
                .map(ModerationLogResponse::from)
                .collect(),
            next_cursor,
        }
    }
}

// ── Reports queue ────────────────────────────────────────────

/// Request body for reporting a message.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReportMessageRequest {
    pub reason: ReportReason,
    /// Free-text context. Required when `reason` is `other`; capped at 512.
    #[serde(default)]
    pub detail: Option<String>,
}

/// Query parameters for listing reports.
#[derive(Debug, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "camelCase")]
#[into_params(parameter_in = Query)]
pub struct ReportListQuery {
    /// Only `open` is supported in v1 (the queue lists open reports). Accepted
    /// for forward-compatibility; other values yield an empty page.
    pub status: Option<String>,
    /// ISO 8601 timestamp cursor — fetch reports created before this time.
    pub before: Option<String>,
    /// Maximum number of reports to return (1-100, default 50).
    pub limit: Option<i64>,
}

/// Reported-message snapshot shown in the queue.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReportedMessageDto {
    /// Plaintext preview. Absent when the message is deleted/encrypted/purged.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
    pub deleted: bool,
    pub encrypted: bool,
}

/// A single report as shown in the moderator queue.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReportResponse {
    pub id: Uuid,
    pub server_id: Uuid,
    pub channel_id: Uuid,
    pub message_id: Uuid,
    pub reporter_id: UserId,
    pub reporter_username: String,
    pub reported_user_id: UserId,
    pub reported_username: String,
    /// Stored reason: a taxonomy label (spam/harassment/nsfw/violence) or the
    /// free-text detail when the reporter chose `other`.
    pub reason: String,
    pub status: ReportStatus,
    pub message: ReportedMessageDto,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_by: Option<UserId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

impl From<MessageReport> for ReportResponse {
    fn from(r: MessageReport) -> Self {
        Self {
            id: r.id.0,
            server_id: r.server_id.0,
            channel_id: r.channel_id.0,
            message_id: r.message_id,
            reporter_id: r.reporter_id,
            reporter_username: r.reporter_username,
            reported_user_id: r.reported_user_id,
            reported_username: r.reported_username,
            reason: r.reason,
            status: r.status,
            message: ReportedMessageDto {
                snippet: r.message.snippet,
                deleted: r.message.deleted,
                encrypted: r.message.encrypted,
            },
            resolved_by: r.resolved_by,
            resolved_at: r.resolved_at,
            created_at: r.created_at,
        }
    }
}

/// Cursor-paginated envelope for the reports queue, plus the open badge count.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReportListResponse {
    pub items: Vec<ReportResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    /// Total OPEN reports for the server (drives the tab badge).
    pub open_count: i64,
}

impl ReportListResponse {
    #[must_use]
    pub fn new(reports: Vec<MessageReport>, next_cursor: Option<String>, open_count: i64) -> Self {
        Self {
            items: reports.into_iter().map(ReportResponse::from).collect(),
            next_cursor,
            open_count,
        }
    }
}

/// Request body for resolving/dismissing a report.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolveReportRequest {
    /// Terminal status to transition the report into: `resolved` or `dismissed`.
    pub status: ReportStatus,
}
