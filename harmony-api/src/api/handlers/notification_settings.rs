//! Notification settings handlers.

use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};

use crate::api::dto::notification_settings::{
    ListNotificationSettingsResponse, NotificationSettingsResponse,
    UpdateNotificationSettingsRequest,
};
use crate::api::errors::{ApiError, ProblemDetails};
use crate::api::extractors::{ApiJson, ApiPath, AuthUser};
use crate::api::state::AppState;
use crate::domain::models::ChannelId;

/// WHY 1000: mirror of the repository cap — when the list is exactly at the
/// cap, stalest overrides were silently dropped and that must be observable.
const LIST_CAP: usize = 1000;

/// Get notification settings for a channel.
///
/// Returns the default level (`all`) when no explicit setting exists.
///
/// # Errors
/// Returns `ApiError` on repository error.
#[utoipa::path(
    get,
    path = "/v1/channels/{id}/notification-settings",
    tag = "NotificationSettings",
    security(("bearer_auth" = [])),
    params(("id" = ChannelId, Path, description = "Channel ID")),
    responses(
        (status = 200, description = "Notification settings", body = NotificationSettingsResponse),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn get_notification_settings(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(channel_id): ApiPath<ChannelId>,
) -> Result<impl IntoResponse, ApiError> {
    let level = state
        .notification_settings_service()
        .get(&channel_id, &user_id)
        .await?;

    Ok((
        StatusCode::OK,
        Json(NotificationSettingsResponse::new(channel_id, level.into())),
    ))
}

/// List ALL channel notification overrides for the authenticated user.
///
/// WHY bulk: per-channel reads only cover visited channels — respecting a
/// muted level for never-visited channels requires knowing all overrides
/// up front.
///
/// # Errors
/// Returns `ApiError` on repository error.
#[utoipa::path(
    get,
    path = "/v1/notification-settings",
    tag = "NotificationSettings",
    security(("bearer_auth" = [])),
    responses(
        (status = 200, description = "All channel notification overrides for the user",
         body = ListNotificationSettingsResponse),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn list_notification_settings(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, ApiError> {
    let overrides = state
        .notification_settings_service()
        .list_for_user(&user_id)
        .await?;

    // WHY: a muted channel ringing again because its override was dropped at
    // the cap must never be invisible (no silent data drops).
    if overrides.len() == LIST_CAP {
        tracing::warn!(user_id = %user_id, "notification_settings_limit_hit");
    }

    let response = ListNotificationSettingsResponse::from(overrides);

    Ok((StatusCode::OK, Json(response)))
}

/// Update notification settings for a channel.
///
/// # Errors
/// Returns `ApiError` on validation failure, missing channel, missing
/// channel access, or repository error.
#[utoipa::path(
    patch,
    path = "/v1/channels/{id}/notification-settings",
    tag = "NotificationSettings",
    security(("bearer_auth" = [])),
    params(("id" = ChannelId, Path, description = "Channel ID")),
    request_body = UpdateNotificationSettingsRequest,
    responses(
        (status = 204, description = "Settings updated"),
        (status = 400, description = "Validation error", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Not a server member or no private-channel access", body = ProblemDetails),
        (status = 404, description = "Channel not found", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state, req))]
pub async fn update_notification_settings(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(channel_id): ApiPath<ChannelId>,
    ApiJson(req): ApiJson<UpdateNotificationSettingsRequest>,
) -> Result<impl IntoResponse, ApiError> {
    state
        .notification_settings_service()
        .upsert(&channel_id, &user_id, req.level.into())
        .await?;

    Ok(StatusCode::NO_CONTENT)
}
