//! Founder-only platform-admin handlers.
//!
//! Every handler here is gated by [`require_platform_founder`] (defense-in-depth
//! over the resolved founder identity — NOT a badge) and writes an append-only
//! audit row. Scope is deliberately narrow: user search, plan management, and a
//! read-only quota view. There is no membership or SSE side effect — the founder
//! never joins a server here.

use axum::{Json, extract::Query, extract::State, http::StatusCode, response::IntoResponse};

use crate::api::dto::{
    AdminUserQuotaResponse, AdminUserSearchQuery, AdminUserSearchResponse,
    AdminUserSummaryResponse, SetUserPlanRequest,
};
use crate::api::errors::{ApiError, ProblemDetails};
use crate::api::extractors::{ApiJson, ApiPath, AuthUser};
use crate::api::founder::require_platform_founder;
use crate::api::state::AppState;
use crate::domain::models::{AdminUserQuota, PlanLimits, UserId};

/// Maximum users returned by a single search (bounds the payload).
const USER_SEARCH_LIMIT: i64 = 25;

/// Best-effort audit write for a founder action.
///
/// Never fails the request: the endpoint's effect (a read, or an already-
/// committed plan change) is the source of truth; a lost audit row is logged at
/// `warn!` (ADR-027) but must not surface to the founder as an error.
async fn audit(
    state: &AppState,
    actor: &UserId,
    action: &str,
    target: Option<&UserId>,
    detail: serde_json::Value,
) {
    if let Err(e) = state
        .admin_repository()
        .record_action(actor, action, target, detail)
        .await
    {
        tracing::warn!(action, error = %e, "platform_admin_audit write failed — action succeeded, audit lost");
    }
}

/// Search users by username substring. Founder-only.
///
/// # Errors
/// Returns `ApiError` 403 if the caller is not the founder, or a repository error.
#[utoipa::path(
    get,
    path = "/v1/admin/users",
    tag = "Admin",
    security(("bearer_auth" = [])),
    params(AdminUserSearchQuery),
    responses(
        (status = 200, description = "Matching users", body = AdminUserSearchResponse),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Not the platform founder", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn search_users(
    AuthUser(caller_id): AuthUser,
    State(state): State<AppState>,
    Query(query): Query<AdminUserSearchQuery>,
) -> Result<impl IntoResponse, ApiError> {
    require_platform_founder(&state, &caller_id)?;

    let users = state
        .admin_repository()
        .search_users(&query.q, USER_SEARCH_LIMIT)
        .await?;

    audit(
        &state,
        &caller_id,
        "user_search",
        None,
        serde_json::json!({ "matches": users.len() }),
    )
    .await;

    Ok((StatusCode::OK, Json(AdminUserSearchResponse::from(users))))
}

/// Set a user's plan (Free/Supporter/Creator). Founder-only.
///
/// This is how Supporter/Creator are granted until Stripe billing exists.
///
/// # Errors
/// Returns `ApiError` 403 if the caller is not the founder, 404 if the target
/// user does not exist, or a repository error.
#[utoipa::path(
    patch,
    path = "/v1/admin/users/{id}/plan",
    tag = "Admin",
    security(("bearer_auth" = [])),
    params(("id" = String, Path, description = "Target user ID")),
    request_body = SetUserPlanRequest,
    responses(
        (status = 200, description = "Updated user", body = AdminUserSummaryResponse),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Not the platform founder", body = ProblemDetails),
        (status = 404, description = "User not found", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state, req))]
pub async fn set_user_plan(
    AuthUser(caller_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(target_id): ApiPath<UserId>,
    ApiJson(req): ApiJson<SetUserPlanRequest>,
) -> Result<impl IntoResponse, ApiError> {
    require_platform_founder(&state, &caller_id)?;

    // Capture the prior plan for the audit trail (best-effort — a missing user
    // surfaces below as a 404 from set_user_plan).
    let previous = state
        .admin_repository()
        .get_user_summary(&target_id)
        .await?;

    let updated = state
        .admin_repository()
        .set_user_plan(&target_id, req.plan)
        .await?;

    audit(
        &state,
        &caller_id,
        "user_plan_set",
        Some(&target_id),
        serde_json::json!({
            "fromPlan": previous.map(|p| p.plan.as_str()),
            "toPlan": req.plan.as_str(),
        }),
    )
    .await;

    tracing::info!(actor = %caller_id, target = %target_id, plan = req.plan.as_str(), "founder set user plan");

    Ok((
        StatusCode::OK,
        Json(AdminUserSummaryResponse::from(updated)),
    ))
}

/// Read a user's plan, per-user caps, and current usage. Founder-only.
///
/// # Errors
/// Returns `ApiError` 403 if the caller is not the founder, 404 if the target
/// user does not exist, or a repository error.
#[utoipa::path(
    get,
    path = "/v1/admin/users/{id}/quota",
    tag = "Admin",
    security(("bearer_auth" = [])),
    params(("id" = String, Path, description = "Target user ID")),
    responses(
        (status = 200, description = "User quota", body = AdminUserQuotaResponse),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Not the platform founder", body = ProblemDetails),
        (status = 404, description = "User not found", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn get_user_quota(
    AuthUser(caller_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(target_id): ApiPath<UserId>,
) -> Result<impl IntoResponse, ApiError> {
    require_platform_founder(&state, &caller_id)?;

    let summary = state
        .admin_repository()
        .get_user_summary(&target_id)
        .await?
        .ok_or_else(|| ApiError::not_found(format!("No user with id '{target_id}'")))?;

    let usage = state.admin_repository().get_user_usage(&target_id).await?;

    let quota = AdminUserQuota {
        plan: summary.plan,
        limits: PlanLimits::for_plan(summary.plan),
        usage,
    };

    audit(
        &state,
        &caller_id,
        "user_quota_view",
        Some(&target_id),
        serde_json::json!({}),
    )
    .await;

    Ok((StatusCode::OK, Json(AdminUserQuotaResponse::from(quota))))
}
