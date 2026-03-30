//! Notification settings handlers.

use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};

use crate::api::dto::notification_settings::{
    NotificationSettingsResponse, UpdateNotificationSettingsRequest,
};
use crate::api::errors::{ApiError, ProblemDetails};
use crate::api::extractors::{ApiJson, ApiPath, AuthUser};
use crate::api::state::AppState;
use crate::domain::models::ChannelId;

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

/// Update notification settings for a channel.
///
/// # Errors
/// Returns `ApiError` on validation failure or repository error.
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
