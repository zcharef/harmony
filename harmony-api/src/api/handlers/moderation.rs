//! Moderation Dashboard v2 handlers (T3.3): audit log + reports queue.

use axum::extract::Query;
use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};
use serde::Deserialize;

use crate::api::dto::moderation::{
    ModerationLogListResponse, ModerationLogQuery, ReportListQuery, ReportListResponse,
    ReportMessageRequest, ReportResponse, ResolveReportRequest,
};
use crate::api::errors::{ApiError, ProblemDetails};
use crate::api::extractors::{ApiJson, ApiPath, AuthUser};
use crate::api::state::AppState;
use crate::domain::models::{ChannelId, MessageId, ReportId, ServerId};

/// Default page size for cursor-paginated moderation lists.
const DEFAULT_LIMIT: i64 = 50;
/// Maximum page size.
const MAX_LIMIT: i64 = 100;

/// Parse an optional ISO-8601 `before` cursor into a UTC timestamp.
// WHY allow: `ApiError` is intentionally large (RFC 9457 problem details); the
// same shape is returned by every handler in this crate.
#[allow(clippy::result_large_err)]
fn parse_cursor(before: Option<String>) -> Result<Option<chrono::DateTime<chrono::Utc>>, ApiError> {
    before
        .map(|s| {
            s.parse::<chrono::DateTime<chrono::Utc>>()
                .map_err(|_| "Invalid 'before' cursor: expected ISO 8601 timestamp")
        })
        .transpose()
        .map_err(ApiError::bad_request)
}

// ── Audit log ────────────────────────────────────────────────

/// List the moderation audit log for a server (admin+), newest-first.
///
/// # Errors
/// Returns `ApiError` on invalid cursor, authorization failure, or repo error.
#[utoipa::path(
    get,
    path = "/v1/servers/{id}/moderation-log",
    tag = "Moderation",
    security(("bearer_auth" = [])),
    params(
        ("id" = ServerId, Path, description = "Server ID"),
        ModerationLogQuery,
    ),
    responses(
        (status = 200, description = "Audit log page", body = ModerationLogListResponse),
        (status = 400, description = "Invalid cursor or limit", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Insufficient role (< admin)", body = ProblemDetails),
        (status = 404, description = "Server not found", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn list_moderation_log(
    AuthUser(caller_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(server_id): ApiPath<ServerId>,
    Query(query): Query<ModerationLogQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let cursor = parse_cursor(query.before)?;

    let entries = state
        .moderation_service()
        .list_moderation_log(&server_id, &caller_id, cursor, limit)
        .await?;

    let next_cursor = if i64::try_from(entries.len()).unwrap_or(0) == limit {
        entries.last().map(|e| e.created_at.to_rfc3339())
    } else {
        None
    };

    Ok((
        StatusCode::OK,
        Json(ModerationLogListResponse::new(entries, next_cursor)),
    ))
}

// ── Reports queue ────────────────────────────────────────────

/// Path parameters for the report-create endpoint.
#[derive(Debug, Deserialize)]
pub struct ReportMessagePath {
    pub channel_id: ChannelId,
    pub message_id: MessageId,
}

/// Report a message for moderator review (any member with channel access).
///
/// # Errors
/// Returns `ApiError`: 400 invalid reason · 403 no channel access · 404 message
/// · 409 already reported · 429 rate limited.
#[utoipa::path(
    post,
    path = "/v1/channels/{channel_id}/messages/{message_id}/report",
    tag = "Moderation",
    security(("bearer_auth" = [])),
    params(
        ("channel_id" = ChannelId, Path, description = "Channel ID"),
        ("message_id" = MessageId, Path, description = "Message ID"),
    ),
    request_body = ReportMessageRequest,
    responses(
        (status = 201, description = "Report filed", body = ReportResponse),
        (status = 400, description = "Invalid reason/detail", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "No channel access", body = ProblemDetails),
        (status = 404, description = "Message not found", body = ProblemDetails),
        (status = 409, description = "Already reported", body = ProblemDetails),
        (status = 429, description = "Too many reports", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state, req))]
pub async fn report_message(
    AuthUser(caller_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(path): ApiPath<ReportMessagePath>,
    ApiJson(req): ApiJson<ReportMessageRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let report = state
        .moderation_service()
        .create_report(
            &path.channel_id,
            &path.message_id,
            &caller_id,
            req.reason,
            req.detail,
        )
        .await?;

    Ok((StatusCode::CREATED, Json(ReportResponse::from(report))))
}

/// List a server's OPEN reports (moderator+), newest-first, with open count.
///
/// # Errors
/// Returns `ApiError` on invalid cursor, authorization failure, or repo error.
#[utoipa::path(
    get,
    path = "/v1/servers/{id}/reports",
    tag = "Moderation",
    security(("bearer_auth" = [])),
    params(
        ("id" = ServerId, Path, description = "Server ID"),
        ReportListQuery,
    ),
    responses(
        (status = 200, description = "Reports page", body = ReportListResponse),
        (status = 400, description = "Invalid cursor or limit", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Insufficient role (< moderator)", body = ProblemDetails),
        (status = 404, description = "Server not found", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn list_reports(
    AuthUser(caller_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(server_id): ApiPath<ServerId>,
    Query(query): Query<ReportListQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let cursor = parse_cursor(query.before)?;

    let (reports, open_count) = state
        .moderation_service()
        .list_reports(&server_id, &caller_id, cursor, limit)
        .await?;

    let next_cursor = if i64::try_from(reports.len()).unwrap_or(0) == limit {
        reports.last().map(|r| r.created_at.to_rfc3339())
    } else {
        None
    };

    Ok((
        StatusCode::OK,
        Json(ReportListResponse::new(reports, next_cursor, open_count)),
    ))
}

/// Path parameters for resolving a report.
#[derive(Debug, Deserialize)]
pub struct ReportPath {
    pub id: ServerId,
    pub report_id: ReportId,
}

/// Resolve or dismiss an open report (moderator+).
///
/// # Errors
/// Returns `ApiError`: 400 bad status · 403 < moderator · 404 report/server.
#[utoipa::path(
    patch,
    path = "/v1/servers/{id}/reports/{report_id}",
    tag = "Moderation",
    security(("bearer_auth" = [])),
    params(
        ("id" = ServerId, Path, description = "Server ID"),
        ("report_id" = ReportId, Path, description = "Report ID"),
    ),
    request_body = ResolveReportRequest,
    responses(
        (status = 200, description = "Report resolved", body = ReportResponse),
        (status = 400, description = "Non-terminal status", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Insufficient role (< moderator)", body = ProblemDetails),
        (status = 404, description = "Report or server not found", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state, req))]
pub async fn resolve_report(
    AuthUser(caller_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(path): ApiPath<ReportPath>,
    ApiJson(req): ApiJson<ResolveReportRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let report = state
        .moderation_service()
        .resolve_report(&path.id, &caller_id, &path.report_id, req.status)
        .await?;

    Ok((StatusCode::OK, Json(ReportResponse::from(report))))
}
