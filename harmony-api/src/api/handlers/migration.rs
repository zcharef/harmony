//! Member-migration command-center handlers (growth-plan §14.1).
//!
//! An owner-only dashboard surface that makes the migration follow-through gap
//! visible and actionable: the honest "alive server" progress, the all-time
//! follow-through counts, and the not-yet-active member cohort to intervene on.

use axum::extract::Query;
use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};

use crate::api::dto::migration::{CohortQuery, MemberCohortResponse, MigrationProgressResponse};
use crate::api::errors::{ApiError, ProblemDetails};
use crate::api::extractors::{ApiPath, AuthUser};
use crate::api::state::AppState;
use crate::domain::models::ServerId;

/// Default cohort page size.
const DEFAULT_COHORT_LIMIT: i64 = 25;
/// Maximum cohort page size.
const MAX_COHORT_LIMIT: i64 = 100;

/// Owner-facing migration progress for a server.
///
/// Returns the §5 "alive server" snapshot (the honest, alt-account-resistant
/// signal), all-time member follow-through counts, and the single recommended
/// next action. Owner-only.
///
/// # Errors
/// `403` if the caller is not the server owner, `404` if the server does not
/// exist, `5xx` on repository failure.
#[utoipa::path(
    get,
    path = "/v1/servers/{id}/migration/progress",
    tag = "Migration",
    security(("bearer_auth" = [])),
    params(("id" = ServerId, Path, description = "Server ID")),
    responses(
        (status = 200, description = "Migration progress", body = MigrationProgressResponse),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Not the server owner", body = ProblemDetails),
        (status = 404, description = "Server not found", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn get_migration_progress(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(server_id): ApiPath<ServerId>,
) -> Result<impl IntoResponse, ApiError> {
    let progress = state
        .migration_service()
        .progress(&server_id, &user_id)
        .await?;

    tracing::info!(
        server_id = %server_id,
        recommended_action = progress.recommended_action.as_str(),
        "Served migration progress"
    );

    Ok((
        StatusCode::OK,
        Json(MigrationProgressResponse::from(progress)),
    ))
}

/// The not-yet-active member cohort for a server — members who joined but have
/// not performed a genuine action yet (the intervention targets). Cursor
/// pagination on `joined_at`, newest joiners first. Owner-only.
///
/// # Errors
/// `400` on an invalid cursor, `403` if the caller is not the server owner,
/// `404` if the server does not exist, `5xx` on repository failure.
#[utoipa::path(
    get,
    path = "/v1/servers/{id}/migration/cohort",
    tag = "Migration",
    security(("bearer_auth" = [])),
    params(
        ("id" = ServerId, Path, description = "Server ID"),
        CohortQuery,
    ),
    responses(
        (status = 200, description = "Not-yet-active member cohort", body = MemberCohortResponse),
        (status = 400, description = "Invalid cursor or limit", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Not the server owner", body = ProblemDetails),
        (status = 404, description = "Server not found", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn list_not_yet_active_cohort(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(server_id): ApiPath<ServerId>,
    Query(query): Query<CohortQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let limit = query
        .limit
        .unwrap_or(DEFAULT_COHORT_LIMIT)
        .clamp(1, MAX_COHORT_LIMIT);

    let before = query
        .before
        .map(|s| {
            s.parse::<chrono::DateTime<chrono::Utc>>()
                .map_err(|_| "Invalid 'before' cursor: expected ISO 8601 timestamp")
        })
        .transpose()
        .map_err(ApiError::bad_request)?;

    let page = state
        .migration_service()
        .not_yet_active_cohort(&server_id, &user_id, before, limit)
        .await?;

    Ok((
        StatusCode::OK,
        Json(MemberCohortResponse::from_page(page, limit)),
    ))
}
