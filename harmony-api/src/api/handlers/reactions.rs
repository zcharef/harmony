//! Reaction handlers.

use axum::{extract::State, http::StatusCode, response::IntoResponse};
use serde::Deserialize;
use utoipa::ToSchema;

use crate::api::errors::{ApiError, ProblemDetails};
use crate::api::extractors::{ApiJson, ApiPath, AuthUser};
use crate::api::state::AppState;
use crate::domain::models::{ChannelId, MessageId, ServerEvent};

/// Path parameters for reaction operations.
#[derive(Debug, Deserialize)]
pub struct ReactionPath {
    pub channel_id: ChannelId,
    pub message_id: MessageId,
}

/// Path parameters for removing a specific reaction.
#[derive(Debug, Deserialize)]
pub struct ReactionRemovePath {
    pub channel_id: ChannelId,
    pub message_id: MessageId,
    pub emoji: String,
}

/// Request body for adding a reaction.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AddReactionRequest {
    /// The emoji to react with (e.g., "👍").
    pub emoji: String,
}

/// Add a reaction to a message.
///
/// # Errors
/// Returns `ApiError` on validation failure, authorization failure, or repository error.
#[utoipa::path(
    post,
    path = "/v1/channels/{channel_id}/messages/{message_id}/reactions",
    tag = "Reactions",
    security(("bearer_auth" = [])),
    params(
        ("channel_id" = ChannelId, Path, description = "Channel ID"),
        ("message_id" = MessageId, Path, description = "Message ID"),
    ),
    request_body = AddReactionRequest,
    responses(
        (status = 204, description = "Reaction added"),
        (status = 400, description = "Validation error", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Not a server member", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state, req))]
pub async fn add_reaction(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(path): ApiPath<ReactionPath>,
    ApiJson(req): ApiJson<AddReactionRequest>,
) -> Result<impl IntoResponse, ApiError> {
    // WHY: Fetch channel before mutation to capture server_id for the SSE event.
    let channel = state.channel_service().get_by_id(&path.channel_id).await?;

    state
        .reaction_service()
        .add_reaction(&path.channel_id, &path.message_id, &user_id, &req.emoji)
        .await?;

    // WHY: Fetch profile for the username included in the SSE event payload,
    // so clients can display "Alice reacted with 👍" without a separate lookup.
    let profile = state.profile_service().get_by_id(&user_id).await?;

    let event = ServerEvent::ReactionAdded {
        sender_id: user_id.clone(),
        server_id: channel.server_id,
        channel_id: path.channel_id.clone(),
        message_id: path.message_id.clone(),
        emoji: req.emoji,
        user_id,
        username: profile.username,
    };
    let receivers = state.event_bus().publish(event);
    tracing::debug!(
        channel_id = %path.channel_id,
        message_id = %path.message_id,
        receivers,
        "emitted reaction.added"
    );

    Ok(StatusCode::NO_CONTENT)
}

/// Remove a reaction from a message.
///
/// # Errors
/// Returns `ApiError` on authorization failure or repository error.
#[utoipa::path(
    delete,
    path = "/v1/channels/{channel_id}/messages/{message_id}/reactions/{emoji}",
    tag = "Reactions",
    security(("bearer_auth" = [])),
    params(
        ("channel_id" = ChannelId, Path, description = "Channel ID"),
        ("message_id" = MessageId, Path, description = "Message ID"),
        ("emoji" = String, Path, description = "Emoji to remove"),
    ),
    responses(
        (status = 204, description = "Reaction removed"),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Not a server member", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn remove_reaction(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(path): ApiPath<ReactionRemovePath>,
) -> Result<impl IntoResponse, ApiError> {
    let channel = state.channel_service().get_by_id(&path.channel_id).await?;

    state
        .reaction_service()
        .remove_reaction(&path.channel_id, &path.message_id, &user_id, &path.emoji)
        .await?;

    let event = ServerEvent::ReactionRemoved {
        sender_id: user_id.clone(),
        server_id: channel.server_id,
        channel_id: path.channel_id.clone(),
        message_id: path.message_id.clone(),
        emoji: path.emoji,
        user_id,
    };
    let receivers = state.event_bus().publish(event);
    tracing::debug!(
        channel_id = %path.channel_id,
        message_id = %path.message_id,
        receivers,
        "emitted reaction.removed"
    );

    Ok(StatusCode::NO_CONTENT)
}
