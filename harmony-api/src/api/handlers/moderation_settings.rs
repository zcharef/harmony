//! Moderation settings handlers.

use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};

use crate::api::dto::moderation_settings::{
    ModerationSettingsResponse, UpdateModerationSettingsRequest,
};
use crate::api::errors::{ApiError, ProblemDetails};
use crate::api::extractors::{ApiJson, ApiPath, AuthUser};
use crate::api::state::AppState;
use crate::domain::models::{ServerEvent, ServerId};
use crate::domain::services::{TIER1_CATEGORIES, TIER2_CATEGORIES};

/// Get moderation settings for a server.
///
/// Returns current Tier 2 category toggles and informational tier lists.
/// Any server member can read settings.
///
/// # Errors
/// Returns `ApiError` on authorization failure or repository error.
#[utoipa::path(
    get,
    path = "/v1/servers/{id}/moderation",
    tag = "Moderation",
    security(("bearer_auth" = [])),
    params(("id" = ServerId, Path, description = "Server ID")),
    responses(
        (status = 200, description = "Moderation settings", body = ModerationSettingsResponse),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Not a server member", body = ProblemDetails),
        (status = 404, description = "Server not found", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn get_moderation_settings(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(id): ApiPath<ServerId>,
) -> Result<impl IntoResponse, ApiError> {
    let categories = state
        .moderation_service()
        .get_moderation_categories(&id, &user_id)
        .await?;

    let response = ModerationSettingsResponse::new(
        id,
        categories,
        TIER1_CATEGORIES.iter().map(|&s| s.to_string()).collect(),
        TIER2_CATEGORIES.iter().map(|&s| s.to_string()).collect(),
    );

    Ok((StatusCode::OK, Json(response)))
}

/// Update moderation settings for a server.
///
/// Replaces Tier 2 category toggles. Requires server owner role.
///
/// # Errors
/// Returns `ApiError` on validation failure, authorization failure, or repository error.
#[utoipa::path(
    patch,
    path = "/v1/servers/{id}/moderation",
    tag = "Moderation",
    security(("bearer_auth" = [])),
    params(("id" = ServerId, Path, description = "Server ID")),
    request_body = UpdateModerationSettingsRequest,
    responses(
        (status = 200, description = "Moderation settings updated", body = ModerationSettingsResponse),
        (status = 400, description = "Validation error", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Not a server owner", body = ProblemDetails),
        (status = 404, description = "Server not found", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state, req))]
pub async fn update_moderation_settings(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(id): ApiPath<ServerId>,
    ApiJson(req): ApiJson<UpdateModerationSettingsRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let updated = state
        .moderation_service()
        .update_moderation_categories(&id, &user_id, req.categories)
        .await?;

    let receivers = state
        .event_bus()
        .publish(ServerEvent::ModerationSettingsUpdated {
            sender_id: user_id,
            server_id: id.clone(),
            categories: updated.clone(),
        });
    tracing::debug!(
        server_id = %id,
        receivers,
        "emitted server.moderation_settings_updated"
    );

    let response = ModerationSettingsResponse::new(
        id,
        updated,
        TIER1_CATEGORIES.iter().map(|&s| s.to_string()).collect(),
        TIER2_CATEGORIES.iter().map(|&s| s.to_string()).collect(),
    );

    Ok((StatusCode::OK, Json(response)))
}
