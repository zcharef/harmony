//! Custom server-emoji handlers.

use std::time::Duration;

use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};
use serde::Deserialize;

use crate::api::dto::{CreateEmojiRequest, EmojiListResponse, EmojiResponse};
use crate::api::errors::{ApiError, ProblemDetails};
use crate::api::extractors::{ApiJson, ApiPath, AuthUser};
use crate::api::state::AppState;
use crate::domain::models::{EmojiId, Role, ServerEvent, ServerId};

/// Max custom-emoji creations per user per minute (gentle admin guard, §3.4).
const EMOJI_CREATE_RATE_MAX: usize = 20;
/// Window for the emoji-creation rate limit.
const EMOJI_CREATE_RATE_WINDOW: Duration = Duration::from_secs(60);

/// Path parameters for a single emoji.
#[derive(Debug, Deserialize)]
pub struct EmojiPath {
    pub id: ServerId,
    pub emoji_id: EmojiId,
}

/// List all custom emoji in a server. Requires server membership.
///
/// # Errors
/// Returns `ApiError` if the caller is not a member, or on repository error.
#[utoipa::path(
    get,
    path = "/v1/servers/{id}/emojis",
    tag = "Emoji",
    security(("bearer_auth" = [])),
    params(("id" = ServerId, Path, description = "Server ID")),
    responses(
        (status = 200, description = "Emoji list", body = EmojiListResponse),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Not a server member", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn list_server_emojis(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(server_id): ApiPath<ServerId>,
) -> Result<impl IntoResponse, ApiError> {
    let is_member = state
        .member_repository()
        .is_member(&server_id, &user_id)
        .await?;
    if !is_member {
        return Err(ApiError::forbidden(
            "You must be a server member to view emoji",
        ));
    }

    let emojis = state
        .server_emoji_service()
        .list_for_server(&server_id)
        .await?;

    Ok((StatusCode::OK, Json(EmojiListResponse::from(emojis))))
}

/// Create a custom emoji. Requires admin+ role.
///
/// # Errors
/// Returns `ApiError` on validation failure, insufficient role, plan-limit
/// breach, duplicate name, or repository error.
#[utoipa::path(
    post,
    path = "/v1/servers/{id}/emojis",
    tag = "Emoji",
    security(("bearer_auth" = [])),
    params(("id" = ServerId, Path, description = "Server ID")),
    request_body = CreateEmojiRequest,
    responses(
        (status = 201, description = "Emoji created", body = EmojiResponse),
        (status = 400, description = "Validation error", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Insufficient role or plan limit", body = ProblemDetails),
        (status = 409, description = "Duplicate emoji name", body = ProblemDetails),
        (status = 429, description = "Rate limited", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state, req))]
pub async fn create_server_emoji(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(server_id): ApiPath<ServerId>,
    ApiJson(req): ApiJson<CreateEmojiRequest>,
) -> Result<impl IntoResponse, ApiError> {
    state
        .moderation_service()
        .require_role(&server_id, &user_id, Role::Admin)
        .await?;

    // WHY: admin emoji creation is low-frequency — a gentle per-user guard
    // (20/min) blunts abuse without hindering a legitimate bulk upload.
    state.spam_guard().check_and_record_action(
        &user_id,
        "emoji_create",
        EMOJI_CREATE_RATE_MAX,
        EMOJI_CREATE_RATE_WINDOW,
    )?;

    let emoji = state
        .server_emoji_service()
        .create(&server_id, &req.name, &req.url, req.is_animated, &user_id)
        .await?;

    // Scan-before-reveal: the emoji is staged PENDING and NOT broadcast to other
    // members. The async scan reveals it (emits `emoji.created`) on a clean
    // verdict, or rejects it (deletes the row, notifies the creator) on a flag.
    // The 201 response carries the pending emoji so the creator sees it
    // optimistically; other members only ever receive an approved one.
    crate::api::emoji_image_scan::spawn_emoji_image_scan(&state, &emoji.id);
    tracing::debug!(
        server_id = %server_id,
        emoji_id = %emoji.id,
        "emoji created (pending scan-before-reveal)"
    );

    Ok((StatusCode::CREATED, Json(EmojiResponse::from(emoji))))
}

/// Delete a custom emoji. Requires admin+ role.
///
/// # Errors
/// Returns `ApiError` on insufficient role, a missing emoji, a cross-server id,
/// or repository error.
#[utoipa::path(
    delete,
    path = "/v1/servers/{id}/emojis/{emoji_id}",
    tag = "Emoji",
    security(("bearer_auth" = [])),
    params(
        ("id" = ServerId, Path, description = "Server ID"),
        ("emoji_id" = EmojiId, Path, description = "Emoji ID"),
    ),
    responses(
        (status = 204, description = "Emoji deleted"),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Insufficient role or cross-server id", body = ProblemDetails),
        (status = 404, description = "Emoji not found", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn delete_server_emoji(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(params): ApiPath<EmojiPath>,
) -> Result<impl IntoResponse, ApiError> {
    state
        .moderation_service()
        .require_role(&params.id, &user_id, Role::Admin)
        .await?;

    let emoji = state
        .server_emoji_service()
        .delete(&params.id, &params.emoji_id)
        .await?;

    let receivers = state.event_bus().publish(ServerEvent::EmojiDeleted {
        sender_id: user_id,
        server_id: params.id.clone(),
        emoji_id: emoji.id.clone(),
    });
    tracing::debug!(
        server_id = %params.id,
        emoji_id = %emoji.id,
        receivers,
        "emitted emoji.deleted"
    );

    Ok(StatusCode::NO_CONTENT)
}
