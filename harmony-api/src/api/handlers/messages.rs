//! Message handlers.

use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};
use axum::extract::Query;

use serde::Deserialize;

use crate::api::dto::{
    EditMessageRequest, MessageListQuery, MessageListResponse, MessageResponse, SendMessageRequest,
};
use crate::api::errors::{ApiError, ProblemDetails};
use crate::api::extractors::{ApiJson, ApiPath, AuthUser};
use crate::api::state::AppState;
use crate::domain::models::{ChannelId, MessageId};

/// Default message page size.
const DEFAULT_MESSAGE_LIMIT: i64 = 50;
/// Maximum message page size.
const MAX_MESSAGE_LIMIT: i64 = 100;

/// Send a message to a channel.
///
/// # Errors
/// Returns `ApiError` on validation failure or repository error.
#[utoipa::path(
    post,
    path = "/v1/channels/{id}/messages",
    tag = "Messages",
    security(("bearer_auth" = [])),
    params(("id" = ChannelId, Path, description = "Channel ID")),
    request_body = SendMessageRequest,
    responses(
        (status = 201, description = "Message sent", body = MessageResponse),
        (status = 400, description = "Validation error", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state, req))]
pub async fn send_message(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(channel_id): ApiPath<ChannelId>,
    ApiJson(req): ApiJson<SendMessageRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let message = state
        .message_service()
        .create(&channel_id, &user_id, req.content)
        .await?;

    Ok((StatusCode::CREATED, Json(MessageResponse::from(message))))
}

/// List messages in a channel with cursor-based pagination.
///
/// Use `before` (ISO 8601) to paginate backward. Default limit is 50, max is 100.
///
/// # Errors
/// Returns `ApiError` if the cursor is invalid or a repository error occurs.
#[utoipa::path(
    get,
    path = "/v1/channels/{id}/messages",
    tag = "Messages",
    security(("bearer_auth" = [])),
    params(
        ("id" = ChannelId, Path, description = "Channel ID"),
        MessageListQuery,
    ),
    responses(
        (status = 200, description = "Message list", body = MessageListResponse),
        (status = 400, description = "Invalid cursor or limit", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn list_messages(
    AuthUser(_user_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(channel_id): ApiPath<ChannelId>,
    Query(query): Query<MessageListQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let limit = query
        .limit
        .unwrap_or(DEFAULT_MESSAGE_LIMIT)
        .clamp(1, MAX_MESSAGE_LIMIT);

    let cursor = query
        .before
        .map(|s| {
            s.parse::<chrono::DateTime<chrono::Utc>>()
                .map_err(|_| ApiError::bad_request("Invalid 'before' cursor: expected ISO 8601 timestamp"))
        })
        .transpose()?;

    let messages = state
        .message_service()
        .list_for_channel(&channel_id, cursor, limit)
        .await?;

    // WHY: If we received exactly `limit` rows, there may be more — provide a cursor.
    let next_cursor = if i64::try_from(messages.len()).unwrap_or(0) == limit {
        messages.last().map(|m| m.created_at.to_rfc3339())
    } else {
        None
    };

    Ok((StatusCode::OK, Json(MessageListResponse::from_messages(messages, next_cursor))))
}

/// Path parameters for message-specific operations.
#[derive(Debug, Deserialize)]
pub struct MessagePath {
    pub channel_id: ChannelId,
    pub message_id: MessageId,
}

/// Edit a message's content. Only the author can edit.
///
/// # Errors
/// Returns `ApiError` on validation failure, authorization failure, or repository error.
#[utoipa::path(
    patch,
    path = "/v1/channels/{channel_id}/messages/{message_id}",
    tag = "Messages",
    security(("bearer_auth" = [])),
    params(
        ("channel_id" = ChannelId, Path, description = "Channel ID"),
        ("message_id" = MessageId, Path, description = "Message ID"),
    ),
    request_body = EditMessageRequest,
    responses(
        (status = 200, description = "Message edited", body = MessageResponse),
        (status = 400, description = "Validation error", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Not the message author", body = ProblemDetails),
        (status = 404, description = "Message not found", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state, req))]
pub async fn edit_message(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(path): ApiPath<MessagePath>,
    ApiJson(req): ApiJson<EditMessageRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let message = state
        .message_service()
        .edit_message(&path.message_id, &user_id, req.content)
        .await?;

    Ok((StatusCode::OK, Json(MessageResponse::from(message))))
}

/// Soft-delete a message. Only the author can delete (ADR-038).
///
/// # Errors
/// Returns `ApiError` on authorization failure or repository error.
#[utoipa::path(
    delete,
    path = "/v1/channels/{channel_id}/messages/{message_id}",
    tag = "Messages",
    security(("bearer_auth" = [])),
    params(
        ("channel_id" = ChannelId, Path, description = "Channel ID"),
        ("message_id" = MessageId, Path, description = "Message ID"),
    ),
    responses(
        (status = 204, description = "Message deleted"),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Not the message author", body = ProblemDetails),
        (status = 404, description = "Message not found", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn delete_message(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(path): ApiPath<MessagePath>,
) -> Result<impl IntoResponse, ApiError> {
    state
        .message_service()
        .delete_message(&path.message_id, &user_id)
        .await?;

    Ok(StatusCode::NO_CONTENT)
}
