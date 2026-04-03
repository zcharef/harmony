//! Message handlers.

use axum::extract::Query;
use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};

use serde::Deserialize;

use tokio::time::{Duration, timeout};

use crate::api::dto::{
    EditMessageRequest, MessageListQuery, MessageListResponse, MessageResponse, SendMessageRequest,
};
use crate::api::errors::{ApiError, ProblemDetails};
use crate::api::extractors::{ApiJson, ApiPath, AuthUser};
use crate::api::state::AppState;
use crate::domain::errors::DomainError;
use crate::domain::models::server_event::MessagePayload;
use crate::domain::models::{
    ChannelId, MessageId, MessageWithAuthor, SYSTEM_MODERATOR_ID, ServerEvent, ServerId,
};
use crate::domain::services::content_moderation::{
    ModerationDecision, SCORE_THRESHOLD, evaluate_moderation,
};

/// Maximum time to wait for a moderation semaphore permit before dead-lettering.
const SEMAPHORE_TIMEOUT: Duration = Duration::from_secs(30);

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
    // WHY: Fetch channel before mutation to capture server_id for the SSE event.
    // The service also validates channel existence internally, but fetching here
    // avoids a redundant post-commit lookup and guarantees event emission.
    let channel = state.channel_service().get_by_id(&channel_id).await?;

    let message = state
        .message_service()
        .create(
            &channel_id,
            &user_id,
            req.content,
            req.encrypted.unwrap_or(false),
            req.sender_device_id,
            req.parent_message_id,
        )
        .await?;

    let encrypted = message.message.encrypted;
    let event = ServerEvent::MessageCreated {
        sender_id: user_id.clone(),
        server_id: channel.server_id.clone(),
        channel_id: channel_id.clone(),
        message: MessagePayload::from(message.clone()),
    };
    let receivers = state.event_bus().publish(event);
    tracing::debug!(channel_id = %channel_id, receivers, "emitted message.created");

    // B4: Async content moderation (unencrypted only, ADR-027 compliant).
    // Message is already delivered; background task checks and soft-deletes if flagged.
    if !encrypted {
        spawn_async_moderation(&state, &message, &channel_id, &channel.server_id);
    }

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
    AuthUser(user_id): AuthUser,
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
                .map_err(|_| "Invalid 'before' cursor: expected ISO 8601 timestamp")
        })
        .transpose()
        .map_err(ApiError::bad_request)?;

    let messages = state
        .message_service()
        .list_for_channel(&channel_id, &user_id, cursor, limit)
        .await?;

    // WHY: If we received exactly `limit` rows, there may be more — provide a cursor.
    let next_cursor = if i64::try_from(messages.len()).unwrap_or(0) == limit {
        messages.last().map(|m| m.message.created_at.to_rfc3339())
    } else {
        None
    };

    Ok((
        StatusCode::OK,
        Json(MessageListResponse::from_messages(messages, next_cursor)),
    ))
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
    // WHY: Fetch channel before mutation to capture server_id for the SSE event.
    // The service also fetches the channel internally (for plan limits), but
    // fetching here avoids a redundant post-commit lookup and guarantees event emission.
    let channel = state.channel_service().get_by_id(&path.channel_id).await?;

    let message = state
        .message_service()
        .edit_message(&path.message_id, &user_id, req.content)
        .await?;

    let encrypted = message.message.encrypted;
    let event = ServerEvent::MessageUpdated {
        sender_id: user_id.clone(),
        server_id: channel.server_id.clone(),
        channel_id: path.channel_id.clone(),
        message: MessagePayload::from(message.clone()),
    };
    let receivers = state.event_bus().publish(event);
    tracing::debug!(
        channel_id = %path.channel_id,
        message_id = %path.message_id,
        receivers,
        "emitted message.updated"
    );

    // B4: Async moderation on edits too (prevent edit-in-bypass).
    if !encrypted {
        spawn_async_moderation(&state, &message, &path.channel_id, &channel.server_id);
    }

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
    // WHY: Fetch channel before mutation to capture server_id for the SSE event.
    // The service also fetches the channel internally (for moderator permission
    // checks), but fetching here avoids a redundant post-commit lookup and
    // guarantees event emission.
    let channel = state.channel_service().get_by_id(&path.channel_id).await?;

    state
        .message_service()
        .delete_message(&path.message_id, &user_id)
        .await?;

    let event = ServerEvent::MessageDeleted {
        sender_id: user_id.clone(),
        server_id: channel.server_id,
        channel_id: path.channel_id.clone(),
        message_id: path.message_id.clone(),
    };
    let receivers = state.event_bus().publish(event);
    tracing::debug!(
        channel_id = %path.channel_id,
        message_id = %path.message_id,
        receivers,
        "emitted message.deleted"
    );

    Ok(StatusCode::NO_CONTENT)
}

/// Spawn an async background task for AI content moderation (B4) and URL scanning (B3).
///
/// The message is already delivered via SSE. If either check flags it,
/// the task soft-deletes the message and emits a `MessageDeleted` event.
/// Both checks run in parallel. ADR-027 compliant: every failure path has `tracing::warn!`.
fn spawn_async_moderation(
    state: &AppState,
    message: &MessageWithAuthor,
    channel_id: &ChannelId,
    server_id: &ServerId,
) {
    let moderator = state.content_moderator().cloned();
    let safe_browsing = state.safe_browsing().cloned();

    // Nothing to do if neither is configured
    if moderator.is_none() && safe_browsing.is_none() {
        return;
    }

    let msg_id = message.message.id.clone();
    // WHY: Use pre-mask original content for AI check. When the sync word filter
    // masks profanity (e.g. "k*** yourself"), the masked text may not trigger
    // OpenAI's moderation. Fall back to stored content when the sync filter
    // didn't mask anything (original_content is None).
    let content = message
        .message
        .original_content
        .clone()
        .unwrap_or_else(|| message.message.content.clone());
    let channel_id = channel_id.clone();
    let server_id = server_id.clone();
    // C2: Capture edit timestamp at spawn time for stale-content guard.
    let checked_at = message
        .message
        .edited_at
        .unwrap_or(message.message.created_at);
    let repo = state.message_repository_for_moderation().clone();
    let server_repo = state.server_repository_for_moderation().clone();
    let event_bus = state.event_bus_arc().clone();
    // H2: Acquire semaphore inside the spawned task, not before spawn.
    let semaphore = state.moderation_semaphore().clone();
    // C3: Dead-letter queue for failed Tier 1 moderation checks.
    let retry_repo = state.moderation_retry_repository().clone();

    tokio::spawn(async move {
        // H2: Bound concurrent moderation tasks via semaphore permit.
        // P4: Timeout prevents unbounded queueing when all permits are held
        // (e.g. sustained OpenAI 429s holding permits for the full retry window).
        let _permit = match timeout(SEMAPHORE_TIMEOUT, semaphore.acquire_owned()).await {
            Ok(Ok(permit)) => permit,
            Ok(Err(_closed)) => {
                // Semaphore closed (shutdown) — skip moderation
                tracing::warn!(
                    message_id = %msg_id,
                    "Moderation semaphore closed — skipping moderation"
                );
                return;
            }
            Err(_elapsed) => {
                // Timeout — queue for retry instead of blocking indefinitely
                tracing::warn!(
                    message_id = %msg_id,
                    timeout_secs = SEMAPHORE_TIMEOUT.as_secs(),
                    "Moderation semaphore timeout — queueing for retry"
                );
                if let Err(e) = retry_repo
                    .insert(
                        &msg_id,
                        &server_id,
                        &channel_id,
                        &content,
                        "semaphore_timeout",
                    )
                    .await
                {
                    tracing::error!(
                        message_id = %msg_id,
                        error = %e,
                        "Failed to insert moderation retry after semaphore timeout"
                    );
                }
                return;
            }
        };

        // M1: Fetch server moderation categories inside the spawned task,
        // not in the handler hot path.
        let server_categories = match server_repo.get_moderation_categories(&server_id).await {
            Ok(cats) => cats,
            Err(e) => {
                tracing::warn!(
                    message_id = %msg_id,
                    server_id = %server_id,
                    error = %e,
                    "Failed to fetch server moderation categories — using empty (Tier 2 OFF)"
                );
                std::collections::HashMap::new()
            }
        };

        let mut should_delete = false;
        let mut reason = String::new();

        // B4: AI text moderation (OpenAI) — runs concurrently with B3
        let ai_check = async {
            let moderator = moderator.as_ref()?;
            match moderator.check_text(&content).await {
                Ok(result) => {
                    // 7: Use tiered evaluate_moderation instead of raw `result.flagged`.
                    let decision = evaluate_moderation(
                        &result.category_scores,
                        &result.category_flags,
                        &server_categories,
                        SCORE_THRESHOLD,
                    );
                    match decision {
                        ModerationDecision::Delete { reason, is_tier1 } => Some((reason, is_tier1)),
                        ModerationDecision::Pass => None,
                    }
                }
                Err(e) => {
                    // C3: Insert into dead-letter queue so background sweep
                    // retries Tier 1 checks. The message passes unmoderated
                    // for now but will be re-evaluated.
                    tracing::warn!(
                        message_id = %msg_id,
                        error = %e,
                        "Async AI moderation failed — queueing for retry"
                    );
                    if let Err(insert_err) = retry_repo
                        .insert(&msg_id, &server_id, &channel_id, &content, &e.to_string())
                        .await
                    {
                        // WHY: Failed to persist the retry record. The message
                        // remains unmoderated AND we have no retry path.
                        // This is a safety-critical failure for Tier 1 content.
                        tracing::error!(
                            message_id = %msg_id,
                            error = %insert_err,
                            "Failed to insert moderation retry — message unmoderated with no retry path"
                        );
                    }
                    None
                }
            }
        };

        // B3: URL scanning (Google Safe Browsing) — runs concurrently with B4
        let url_check = async {
            let client = safe_browsing.as_ref()?;
            let urls = crate::infra::safe_browsing::extract_urls(&content);
            if urls.is_empty() {
                return None;
            }
            match client.check_urls(&urls).await {
                Ok(result) if result.has_threats => {
                    Some(format!("dangerous URL: {}", result.threat_types.join(", ")))
                }
                Ok(_) => None,
                Err(e) => {
                    tracing::warn!(
                        message_id = %msg_id,
                        error = %e,
                        "Safe Browsing URL check failed — URLs unscanned"
                    );
                    None
                }
            }
        };

        // WHY: Run both checks concurrently — they're independent HTTP calls.
        let (ai_result, url_result) = tokio::join!(ai_check, url_check);

        if let Some((ai_reason, _is_tier1)) = &ai_result {
            should_delete = true;
            reason = ai_reason.clone();
        }
        if let Some(url_reason) = &url_result {
            should_delete = true;
            if reason.is_empty() {
                reason = url_reason.clone();
            } else {
                reason = format!("{reason}; {url_reason}");
            }
        }

        if !should_delete {
            return;
        }

        // M6: Log verdict BEFORE attempting soft_delete to ensure audit trail
        // exists even if the DB call fails.
        let tier_label = if ai_result.as_ref().is_some_and(|(_, t1)| *t1) {
            "tier1"
        } else {
            "tier2"
        };
        tracing::info!(
            message_id = %msg_id,
            server_id = %server_id,
            tier = tier_label,
            reason = %reason,
            "Message flagged by async moderation — attempting soft-delete"
        );

        // C2: Atomic stale-content guard — the checked_at timestamp is passed
        // into soft_delete's SQL WHERE clause so the read+delete is a single
        // atomic UPDATE. No TOCTOU race between find_by_id and soft_delete.
        // M5: Use SYSTEM_MODERATOR_ID for deleted_by (distinguishes user-delete
        // from system moderation in audit trail).
        if let Err(e) = repo
            .soft_delete(&msg_id, &SYSTEM_MODERATOR_ID, Some(checked_at))
            .await
        {
            // H4: Typed error matching instead of `e.to_string().contains("not found")`.
            if matches!(e, DomainError::NotFound { .. }) {
                tracing::debug!(
                    message_id = %msg_id,
                    "Moderated message already deleted by user — no action needed"
                );
            } else {
                // WHY: A message flagged by moderation couldn't be removed —
                // dangerous content remains visible. This is a safety incident.
                tracing::error!(
                    message_id = %msg_id,
                    error = %e,
                    "Failed to soft-delete moderated message — flagged content remains visible"
                );
            }
            return;
        }

        // M5: Use SYSTEM_MODERATOR_ID as sender_id in the SSE event so clients
        // know this deletion was by the moderation system, not a user.
        let event = ServerEvent::MessageDeleted {
            sender_id: SYSTEM_MODERATOR_ID,
            server_id,
            channel_id,
            message_id: msg_id.clone(),
        };
        let receivers = event_bus.publish(event);
        tracing::debug!(message_id = %msg_id, receivers, "emitted moderation message.deleted");
    });
}
