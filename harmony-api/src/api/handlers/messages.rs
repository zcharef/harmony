//! Message handlers.

use axum::extract::Query;
use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};

use serde::Deserialize;

use tokio::time::{Duration, timeout};

use crate::api::dto::{
    EditMessageRequest, MessageListQuery, MessageListResponse, MessageResponse, MessageSearchQuery,
    MessageSearchResponse, PinnedMessagesResponse, SendMessageRequest,
};
use crate::api::errors::{ApiError, ProblemDetails};
use crate::api::extractors::{ApiJson, ApiPath, AuthUser};
use crate::api::state::AppState;
use crate::domain::errors::DomainError;
use crate::domain::models::server_event::MessagePayload;
use crate::domain::models::{
    AnalyticsEvent, AnalyticsEventName, ChannelId, EmbedId, MessageId, MessageWithAuthor,
    NewAttachment, SYSTEM_MODERATOR_ID, ServerEvent, ServerId, UserId,
};
use crate::domain::ports::{MessageSearchFilters, SearchCursor};
use crate::domain::services::content_moderation::{
    ModerationDecision, SCORE_THRESHOLD, evaluate_moderation,
};
use crate::domain::services::{
    ensure_channel_access, resolve_channel_access, resolve_channel_access_by_id,
};

/// Maximum time to wait for a moderation semaphore permit before dead-lettering.
const SEMAPHORE_TIMEOUT: Duration = Duration::from_secs(30);

/// Default message page size.
const DEFAULT_MESSAGE_LIMIT: i64 = 50;
/// Maximum message page size.
const MAX_MESSAGE_LIMIT: i64 = 100;

/// Default search page size.
const DEFAULT_SEARCH_LIMIT: i64 = 25;
/// Maximum search page size.
const MAX_SEARCH_LIMIT: i64 = 50;
/// Max `q` length (chars) — bounds the FTS query cost.
const MAX_SEARCH_QUERY_CHARS: usize = 200;
/// Max search actions per user within [`SEARCH_RATE_WINDOW`]. Search is the
/// heaviest read (GIN scan + access EXISTS across a server), so it gets a
/// dedicated per-user cap on top of Cloudflare's per-IP limit.
const SEARCH_RATE_MAX: usize = 30;
/// Window for the per-user search rate limit.
const SEARCH_RATE_WINDOW: Duration = Duration::from_secs(60);

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
        (status = 429, description = "Message rate limit exceeded", body = ProblemDetails),
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

    // WHY: Resolve the private-channel access scope BEFORE the mutation so a
    // lookup failure fails the request cleanly (no orphaned message with no
    // SSE event). `None` for public channels. The SSE layer gates delivery on
    // this and redacts it before any client sees it.
    let channel_access = resolve_channel_access(state.channel_repository(), &channel).await?;

    // Parse, don't validate — each attachment reference goes through the
    // `try_new` funnel: origin pinned to the configured Supabase origin
    // (fails closed when unconfigured), path-prefix bucket check, sender's
    // `{uid}/` upload-folder ownership, mime allowlist, positive size. Called
    // directly (not via `TryFrom`) because the funnel needs the authenticated
    // author and the configured origin — same pattern as `DeviceId::try_new`.
    // The first invalid entry rejects the whole request with a 400
    // (`ValidationError` → 400 via the exhaustive ADR-021 mapping).
    let attachments: Vec<NewAttachment> = req
        .attachments
        .unwrap_or_default()
        .into_iter()
        .map(|a| {
            NewAttachment::try_new(
                a.url,
                a.mime,
                a.size,
                a.width,
                a.height,
                &user_id,
                state.attachment_url_origin(),
            )
            .map_err(|msg| DomainError::ValidationError(msg.to_string()))
        })
        .collect::<Result<_, DomainError>>()?;

    // Fail-closed CSAM gate (spec §c.3): when the deployment requires a real
    // CSAM scan but none is configured (Noop matcher), image attachments are
    // refused outright. Default false while invite-only, so normally inert.
    if !attachments.is_empty()
        && state.attachments_require_csam_scan()
        && !state.csam_matcher().is_configured()
    {
        return Err(ApiError::service_unavailable(
            "Image attachments unavailable",
            "Image attachments are temporarily unavailable on this server.",
        ));
    }

    let message = state
        .message_service()
        .create(
            &channel_id,
            &user_id,
            req.content,
            req.encrypted.unwrap_or(false),
            req.sender_device_id,
            req.parent_message_id,
            req.mentioned_user_ids,
            attachments,
        )
        .await?;

    let encrypted = message.message.encrypted;
    let event = ServerEvent::MessageCreated {
        sender_id: user_id.clone(),
        server_id: channel.server_id.clone(),
        channel_id: channel_id.clone(),
        message: MessagePayload::from(message.clone()),
        channel_access,
    };
    let receivers = state.event_bus().publish(event);
    tracing::debug!(channel_id = %channel_id, receivers, "emitted message.created");

    // §4.1: one targeted MentionReceived per mentioned user (≤10). Rides the
    // target_user_id SSE path — delivered only to each mentioned user's devices.
    // The persisted list already passed filter_mentionable, so no event ever
    // targets a user who cannot see the channel. Author is stripped server-side,
    // so no self-targeted event is published.
    for target_user_id in &message.message.mentioned_user_ids {
        state.event_bus().publish(ServerEvent::MentionReceived {
            sender_id: user_id.clone(),
            target_user_id: target_user_id.clone(),
            server_id: channel.server_id.clone(),
            channel_id: channel_id.clone(),
            message_id: message.message.id.clone(),
        });
    }
    if !message.message.mentioned_user_ids.is_empty() {
        tracing::debug!(
            channel_id = %channel_id,
            count = message.message.mentioned_user_ids.len(),
            "emitted mention.received"
        );
    }

    // B4: Async content moderation (unencrypted only, ADR-027 compliant).
    // Message is already delivered; background task checks and soft-deletes if flagged.
    if !encrypted {
        spawn_async_moderation(&state, &message, &channel_id, &channel.server_id);
    }

    // Image content-moderation (spec §c.1): attachments were delivered as
    // `pending` (blurred). A background task scans each and flips the status via
    // MessageUpdated. Scan-before-reveal — never blocks the send.
    if !message.attachments.is_empty() {
        spawn_attachment_moderation(&state, &message, &channel_id, &channel.server_id);
    }

    // Link previews: unfurl http(s) URLs asynchronously and fan out a
    // MessageUpdated when embeds resolve. Plaintext only (ciphertext is
    // opaque); the cheap `contains` pre-check skips the spawn for the vast
    // majority of messages.
    if !encrypted && message.message.content.contains("http") {
        spawn_link_unfurl(&state, &message, &channel_id, &channel.server_id);
    }

    // §10 activation funnel: first message ever (fire-and-forget). The DB
    // dedups via a once-per-user unique index — replays are silent no-ops,
    // so no "is this the first?" query on the hot path.
    super::track(
        &state,
        AnalyticsEvent::new(AnalyticsEventName::FirstMessage)
            .user(user_id)
            .server(channel.server_id)
            .channel(channel_id),
    );

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

    // WHY mutually exclusive: `around` centers a window on a target message and
    // `before` pages backward from a cursor — combining them is ambiguous.
    if query.around.is_some() && query.before.is_some() {
        return Err(ApiError::bad_request(
            "`around` and `before` are mutually exclusive",
        ));
    }

    let (messages, next_cursor) = if let Some(anchor_id) = query.around {
        let window = state
            .message_service()
            .list_around(&channel_id, &user_id, &anchor_id, limit)
            .await?;

        // WHY not `rows.len() == limit` for the around window: it is two-sided,
        // so the total is short whenever EITHER half is short. When the newer
        // half is short (anchor near the present) but the older half was capped,
        // older history still exists below the window — a count-based cursor
        // would wrongly null out and break backward (`before`) paging. Drive it
        // from the older-side fill flag instead (§3.2).
        let next_cursor = if window.has_more_older {
            window
                .messages
                .last()
                .map(|m| m.message.created_at.to_rfc3339())
        } else {
            None
        };
        (window.messages, next_cursor)
    } else {
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

        // WHY: If we received exactly `limit` rows, there may be more older
        // history — provide the oldest row's timestamp as the `before` cursor.
        let next_cursor = if i64::try_from(messages.len()).unwrap_or(0) == limit {
            messages.last().map(|m| m.message.created_at.to_rfc3339())
        } else {
            None
        };
        (messages, next_cursor)
    };

    Ok((
        StatusCode::OK,
        Json(MessageListResponse::from_messages(messages, next_cursor)),
    ))
}

/// Validate and trim the `q` search param. `q` is required in v1.
///
/// Returns the trimmed query on success, or the (stable) 400 detail string.
fn validate_search_query(q: Option<&str>) -> Result<&str, &'static str> {
    match q.map(str::trim) {
        Some(trimmed) if !trimmed.is_empty() => {
            if trimmed.chars().count() > MAX_SEARCH_QUERY_CHARS {
                Err("Search query 'q' must not exceed 200 characters")
            } else {
                Ok(trimmed)
            }
        }
        _ => Err("Search query 'q' is required"),
    }
}

/// Map the `has` param into the two structured filter booleans. Splits on `,`,
/// maps `link`/`image`, and ignores any unknown token (forward-compat, §3.2b).
fn parse_has_filters(has: Option<&str>) -> (bool, bool) {
    let mut has_link = false;
    let mut has_image = false;
    if let Some(has) = has {
        for token in has.split(',') {
            match token.trim() {
                "link" => has_link = true,
                "image" => has_image = true,
                _ => {}
            }
        }
    }
    (has_link, has_image)
}

/// Clamp the search `limit` to `1..=50`, defaulting to 25.
fn clamp_search_limit(limit: Option<i64>) -> i64 {
    limit
        .unwrap_or(DEFAULT_SEARCH_LIMIT)
        .clamp(1, MAX_SEARCH_LIMIT)
}

/// Encode a relevance keyset cursor as an opaque base64 token.
///
/// Layout `score_bits|created_at_rfc3339|uuid` (`score` as its IEEE-754 bit
/// pattern so it round-trips exactly), then URL-safe base64. The layout is
/// server-owned — clients must treat the token as opaque.
fn encode_search_cursor(cursor: &SearchCursor) -> String {
    use base64::Engine;
    let raw = format!(
        "{}|{}|{}",
        cursor.score.to_bits(),
        cursor.created_at.to_rfc3339(),
        cursor.id
    );
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw)
}

/// Decode an opaque base64 relevance cursor back into its three components.
/// Any malformed token is a 400 (stable detail) — never a 500.
fn decode_search_cursor(token: &str) -> Result<SearchCursor, &'static str> {
    use base64::Engine;
    const BAD: &str = "Invalid 'cursor': not a valid pagination token";

    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(token)
        .map_err(|_| BAD)?;
    let raw = std::str::from_utf8(&bytes).map_err(|_| BAD)?;
    let mut parts = raw.splitn(3, '|');
    let (Some(score), Some(created_at), Some(id)) = (parts.next(), parts.next(), parts.next())
    else {
        return Err(BAD);
    };
    let score = f64::from_bits(score.parse::<u64>().map_err(|_| BAD)?);
    let created_at = created_at
        .parse::<chrono::DateTime<chrono::Utc>>()
        .map_err(|_| BAD)?;
    let id = id.parse::<uuid::Uuid>().map_err(|_| BAD)?;
    Ok(SearchCursor {
        score,
        created_at,
        id,
    })
}

/// Full-text search messages within a server, gated by per-channel access.
///
/// Takes only structured params (the filter grammar is parsed client-side).
/// Matching is a hybrid of full-text search and trigram similarity (partial
/// words + typo tolerance); results are ordered best-match-first with an opaque
/// relevance keyset `cursor`. A per-user rate limit (30 / 60s) guards the
/// heaviest read in the app.
///
/// # Errors
/// Returns `ApiError` for a missing/oversized `q` (400), an invalid `cursor`
/// (400), a non-member caller or an inaccessible explicit `channelId` (403), or
/// when the per-user search rate limit is exceeded (429).
#[utoipa::path(
    get,
    path = "/v1/servers/{id}/messages/search",
    tag = "Messages",
    security(("bearer_auth" = [])),
    params(
        ("id" = ServerId, Path, description = "Server ID"),
        MessageSearchQuery,
    ),
    responses(
        (status = 200, description = "Search results", body = MessageSearchResponse),
        (status = 400, description = "Invalid query, cursor, or limit", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Not a server member or channel forbidden", body = ProblemDetails),
        (status = 429, description = "Search rate limit exceeded", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state, query))]
pub async fn search_messages(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(server_id): ApiPath<ServerId>,
    Query(query): Query<MessageSearchQuery>,
) -> Result<impl IntoResponse, ApiError> {
    // WHY first (before any DB work): search is the heaviest read — reject a
    // flooding client with 429 + Retry-After before touching the GIN index.
    state.spam_guard().check_and_record_action(
        &user_id,
        "search",
        SEARCH_RATE_MAX,
        SEARCH_RATE_WINDOW,
    )?;

    // `q` is required in v1 (a bare `from:@x` browse is out of scope §10).
    let query_text = validate_search_query(query.q.as_deref()).map_err(ApiError::bad_request)?;

    let (has_link, has_image) = parse_has_filters(query.has.as_deref());
    let limit = clamp_search_limit(query.limit);

    let cursor = query
        .cursor
        .as_deref()
        .map(decode_search_cursor)
        .transpose()
        .map_err(ApiError::bad_request)?;

    // WHY move (not clone): `query` is not used past this point — only the
    // already-derived `query_text`/`has_*`/`limit`/`cursor` are.
    let filters = MessageSearchFilters {
        channel_id: query.channel_id,
        author_id: query.author_id,
        has_link,
        has_image,
    };
    let has_channel_filter = filters.channel_id.is_some();
    let has_author_filter = filters.author_id.is_some();

    let started = std::time::Instant::now();
    let page = state
        .message_service()
        .search_messages(&server_id, &user_id, query_text, filters, cursor, limit)
        .await?;

    // The repository owns "is there a next page" (it filled `limit`) and built
    // the composite relevance cursor from the last row's score; encode it opaque.
    let next_cursor = page.next_cursor.as_ref().map(encode_search_cursor);

    // WHY IDs + counts only, NEVER the query text: `q` is user content / PII.
    tracing::debug!(
        server_id = %server_id,
        result_count = page.messages.len(),
        has_channel_filter,
        has_author_filter,
        elapsed_ms = started.elapsed().as_millis(),
        "message search"
    );

    Ok((
        StatusCode::OK,
        Json(MessageSearchResponse::from_messages(
            page.messages,
            next_cursor,
        )),
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
/// Plaintext edits re-parse `<@user_id>` markers and persist the new mention
/// list (>10 valid markers is a 400), but edits never emit `mention.received`
/// (Discord parity: edit-in mentions don't ping). Editing a message through a
/// channel it does not belong to is a 404. Encrypted edits leave the mention
/// list untouched.
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

    // WHY: Resolve private-channel scope before mutation (see `send_message`).
    let channel_access = resolve_channel_access(state.channel_repository(), &channel).await?;

    // WHY pass the path channel id: the service 404s when the message does not
    // belong to `path.channel_id` — without that binding, an author could PATCH
    // their message through ANY channel path and the events below would fan out
    // with an attacker-chosen channel/server scope.
    let message = state
        .message_service()
        .edit_message(&path.channel_id, &path.message_id, &user_id, req.content)
        .await?;

    let encrypted = message.message.encrypted;
    let event = ServerEvent::MessageUpdated {
        sender_id: user_id.clone(),
        server_id: channel.server_id.clone(),
        channel_id: path.channel_id.clone(),
        message: MessagePayload::from(message.clone()),
        channel_access,
    };
    let receivers = state.event_bus().publish(event);
    tracing::debug!(
        channel_id = %path.channel_id,
        message_id = %path.message_id,
        receivers,
        "emitted message.updated"
    );

    // §2.4: NO mention.received on edits (Discord parity — edit-in mentions
    // don't ping). Newly-added mentions still consume budget in the service
    // and land in the persisted list; badges converge on reconnect (§6.17).

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

    // WHY: Resolve private-channel scope before mutation (see `send_message`).
    // A delete for a private channel must be gated too — a non-granted member
    // must not learn a message existed or was removed.
    let channel_access = resolve_channel_access(state.channel_repository(), &channel).await?;

    let was_moderator_delete = state
        .message_service()
        .delete_message(&path.message_id, &user_id)
        .await?;

    // WHY: Only a moderator deleting another member's message is a moderation
    // action worth auditing; a self-delete is not. Best-effort (§3.2).
    if was_moderator_delete {
        state
            .moderation_service()
            .log_message_delete(&channel.server_id, &user_id, &path.message_id, None)
            .await;
    }

    let event = ServerEvent::MessageDeleted {
        sender_id: user_id.clone(),
        server_id: channel.server_id,
        channel_id: path.channel_id.clone(),
        message_id: path.message_id.clone(),
        deleted_by: user_id,
        channel_access,
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

/// Pin a message (moderator+). Idempotent: pinning an already-pinned message is
/// a 204 no-op (Discord parity).
///
/// # Errors
/// Returns `ApiError`: 403 (not a moderator / no channel access), 404 (message
/// or channel not found), 409 (channel pin cap reached), or a repository error.
#[utoipa::path(
    put,
    path = "/v1/channels/{channel_id}/messages/{message_id}/pin",
    tag = "Messages",
    security(("bearer_auth" = [])),
    params(
        ("channel_id" = ChannelId, Path, description = "Channel ID"),
        ("message_id" = MessageId, Path, description = "Message ID"),
    ),
    responses(
        (status = 204, description = "Message pinned"),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Not a moderator or channel forbidden", body = ProblemDetails),
        (status = 404, description = "Message or channel not found", body = ProblemDetails),
        (status = 409, description = "Channel pin limit reached", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn pin_message(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(path): ApiPath<MessagePath>,
) -> Result<impl IntoResponse, ApiError> {
    set_message_pin(state, user_id, path, true).await
}

/// Unpin a message (moderator+). Idempotent: unpinning a non-pinned message is a
/// 204 no-op (Discord parity).
///
/// # Errors
/// Returns `ApiError`: 403 (not a moderator / no channel access), 404 (message
/// or channel not found), or a repository error.
#[utoipa::path(
    delete,
    path = "/v1/channels/{channel_id}/messages/{message_id}/pin",
    tag = "Messages",
    security(("bearer_auth" = [])),
    params(
        ("channel_id" = ChannelId, Path, description = "Channel ID"),
        ("message_id" = MessageId, Path, description = "Message ID"),
    ),
    responses(
        (status = 204, description = "Message unpinned"),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Not a moderator or channel forbidden", body = ProblemDetails),
        (status = 404, description = "Message or channel not found", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn unpin_message(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(path): ApiPath<MessagePath>,
) -> Result<impl IntoResponse, ApiError> {
    set_message_pin(state, user_id, path, false).await
}

/// Shared pin/unpin body: gate channel access, flip the flag (moderator+), and
/// emit the channel-access-scoped SSE event. Skips the event on an idempotent
/// no-op to avoid redundant traffic (spec decision D8).
async fn set_message_pin(
    state: AppState,
    user_id: UserId,
    path: MessagePath,
    pinned: bool,
) -> Result<StatusCode, ApiError> {
    // Fetch the channel first (server_id for the event, scope for routing).
    let channel = state.channel_service().get_by_id(&path.channel_id).await?;

    // Resolve the private-channel routing scope BEFORE the mutation (see
    // `send_message`); the SSE layer gates delivery on it and redacts it.
    let channel_access = resolve_channel_access(state.channel_repository(), &channel).await?;

    // Membership + private-channel grant gate BEFORE the role check — a member
    // without access must not learn the message exists (matches read/delete).
    ensure_channel_access(
        state.channel_repository(),
        state.member_repository(),
        &channel,
        &user_id,
    )
    .await?;

    let Some(message) = state
        .message_service()
        .set_pinned(&path.message_id, &user_id, &channel, pinned)
        .await?
    else {
        // Idempotent no-op — already in the target state. No event, still 204.
        return Ok(StatusCode::NO_CONTENT);
    };

    let event = if pinned {
        ServerEvent::MessagePinned {
            sender_id: user_id.clone(),
            server_id: channel.server_id.clone(),
            channel_id: path.channel_id.clone(),
            message: MessagePayload::from(message),
            pinned_by: user_id,
            channel_access,
        }
    } else {
        ServerEvent::MessageUnpinned {
            sender_id: user_id.clone(),
            server_id: channel.server_id.clone(),
            channel_id: path.channel_id.clone(),
            message_id: path.message_id.clone(),
            channel_access,
        }
    };
    let receivers = state.event_bus().publish(event);
    tracing::debug!(
        channel_id = %path.channel_id,
        message_id = %path.message_id,
        pinned,
        receivers,
        "emitted pin event"
    );

    Ok(StatusCode::NO_CONTENT)
}

/// List a channel's pinned messages, most-recently-pinned first. Any member with
/// channel access may read; the bounded list is not paginated (capped at the
/// per-channel pin cap).
///
/// # Errors
/// Returns `ApiError`: 403 (no channel access), 404 (channel not found), or a
/// repository error.
#[utoipa::path(
    get,
    path = "/v1/channels/{channel_id}/pins",
    tag = "Messages",
    security(("bearer_auth" = [])),
    params(("channel_id" = ChannelId, Path, description = "Channel ID")),
    responses(
        (status = 200, description = "Pinned messages", body = PinnedMessagesResponse),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "No channel access", body = ProblemDetails),
        (status = 404, description = "Channel not found", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn list_pins(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(channel_id): ApiPath<ChannelId>,
) -> Result<impl IntoResponse, ApiError> {
    let messages = state
        .message_service()
        .list_pinned(&channel_id, &user_id)
        .await?;

    Ok((
        StatusCode::OK,
        Json(PinnedMessagesResponse::from_messages(messages)),
    ))
}

/// Path parameters for embed-specific operations.
#[derive(Debug, Deserialize)]
pub struct EmbedPath {
    pub channel_id: ChannelId,
    pub message_id: MessageId,
    pub embed_id: EmbedId,
}

/// Remove (suppress) a link preview from a message. Allowed for the message
/// author or a moderator+. The suppression is persisted — the URL never
/// re-unfurls for this message — and a `message.updated` carrying the full
/// message fans out so the card disappears live for everyone.
///
/// # Errors
/// Returns `ApiError`: 403 (neither author nor moderator), 404 (channel,
/// message, or embed not found / already removed), or a repository error.
#[utoipa::path(
    delete,
    path = "/v1/channels/{channel_id}/messages/{message_id}/embeds/{embed_id}",
    tag = "Messages",
    security(("bearer_auth" = [])),
    params(
        ("channel_id" = ChannelId, Path, description = "Channel ID"),
        ("message_id" = MessageId, Path, description = "Message ID"),
        ("embed_id" = EmbedId, Path, description = "Embed ID"),
    ),
    responses(
        (status = 204, description = "Preview removed"),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Not the author or a moderator", body = ProblemDetails),
        (status = 404, description = "Channel, message, or embed not found", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn remove_message_embed(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(path): ApiPath<EmbedPath>,
) -> Result<impl IntoResponse, ApiError> {
    // WHY: Fetch channel before mutation to capture server_id for the SSE
    // event (same pattern as send/edit/delete).
    let channel = state.channel_service().get_by_id(&path.channel_id).await?;

    // WHY: Resolve private-channel scope before mutation (see `send_message`).
    let channel_access = resolve_channel_access(state.channel_repository(), &channel).await?;

    let Some(message) = state
        .message_service()
        .suppress_embed(&path.channel_id, &path.message_id, &path.embed_id, &user_id)
        .await?
    else {
        // Message vanished (soft-deleted) between the write and the reload —
        // the suppression persisted; nothing to fan out.
        return Ok(StatusCode::NO_CONTENT);
    };

    // WHY the FULL message payload: a partial fan-out on message.updated once
    // wiped reactions client-side — the payload is always the complete shape.
    let event = ServerEvent::MessageUpdated {
        sender_id: user_id,
        server_id: channel.server_id,
        channel_id: path.channel_id.clone(),
        message: MessagePayload::from(message),
        channel_access,
    };
    let receivers = state.event_bus().publish(event);
    tracing::debug!(
        channel_id = %path.channel_id,
        message_id = %path.message_id,
        receivers,
        "emitted embed-removal message.updated"
    );

    Ok(StatusCode::NO_CONTENT)
}

/// Spawn the async link-unfurl task for a freshly-sent plaintext message.
/// Bounded by the shared moderation semaphore (same pool as the AI/image
/// scans) so a message flood cannot fan out unbounded outbound fetches.
fn spawn_link_unfurl(
    state: &AppState,
    message: &MessageWithAuthor,
    channel_id: &ChannelId,
    server_id: &ServerId,
) {
    let deps = crate::api::link_unfurl::LinkUnfurlDeps::from_state(state);
    let message_id = message.message.id.clone();
    let content = message.message.content.clone();
    let channel_id = channel_id.clone();
    let server_id = server_id.clone();
    let semaphore = state.moderation_semaphore().clone();

    tokio::spawn(async move {
        let _permit = match timeout(SEMAPHORE_TIMEOUT, semaphore.acquire_owned()).await {
            Ok(Ok(permit)) => permit,
            Ok(Err(_closed)) => {
                tracing::warn!(message_id = %message_id, "link unfurl: semaphore closed — skipping");
                return;
            }
            Err(_elapsed) => {
                // Previews are best-effort — no dead-letter queue; the message
                // simply renders without a card.
                tracing::warn!(message_id = %message_id, "link unfurl: semaphore timeout — skipping");
                return;
            }
        };

        crate::api::link_unfurl::unfurl_message_links(
            &deps,
            &message_id,
            &channel_id,
            &server_id,
            &content,
        )
        .await;
    });
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
    // WHY: append an audit-log row for the system delete (actor = system
    // sentinel). Best-effort — a log failure never blocks the moderation delete.
    let mod_log_repo = state.moderation_log_repository().clone();
    // WHY: Needed to resolve the private-channel access scope for the delete
    // event (the moderation path holds only IDs, not the `Channel`).
    let channel_repo = state.channel_repository_arc().clone();
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

        // WHY: Append an audit-log row for the system delete (actor = system
        // sentinel). Best-effort with error! on failure (§3.2) — the delete
        // already committed; a lost audit row must never re-raise here.
        if let Err(e) = mod_log_repo
            .record(crate::domain::models::NewModerationLogEntry::new(
                server_id.clone(),
                crate::domain::models::ModerationAction::MessageDelete,
                SYSTEM_MODERATOR_ID,
                None,
                Some(msg_id.0),
                Some(reason.clone()),
            ))
            .await
        {
            tracing::error!(
                message_id = %msg_id,
                server_id = %server_id,
                error = ?e,
                "moderation_log write failed for automod delete — action succeeded, audit lost"
            );
        }

        // WHY: Resolve the channel-access scope so a moderation delete in a
        // private channel is gated identically to a user delete. Fail OPEN on
        // lookup error (ADR-027) — losing the delete is worse than it reaching
        // a few extra members.
        let channel_access = resolve_channel_access_by_id(channel_repo.as_ref(), &channel_id)
            .await
            .unwrap_or_else(|e| {
                tracing::warn!(
                    message_id = %msg_id,
                    channel_id = %channel_id,
                    error = %e,
                    "Failed to resolve channel access for moderation delete — failing open (public)"
                );
                None
            });

        // M5: Use SYSTEM_MODERATOR_ID as sender_id in the SSE event so clients
        // know this deletion was by the moderation system, not a user.
        let event = ServerEvent::MessageDeleted {
            sender_id: SYSTEM_MODERATOR_ID,
            server_id,
            channel_id,
            message_id: msg_id.clone(),
            deleted_by: SYSTEM_MODERATOR_ID,
            channel_access,
        };
        let receivers = event_bus.publish(event);
        tracing::debug!(message_id = %msg_id, receivers, "emitted moderation message.deleted");
    });
}

/// Spawn the async image content-moderation scan for a freshly-sent message
/// (spec §c.1). The attachments were delivered `pending` (blurred); the task
/// scans each, writes the verdict, and emits `MessageUpdated` so every reader's
/// tile flips. Scan-before-reveal, fail-closed — an unscanned image is never
/// revealed.
fn spawn_attachment_moderation(
    state: &AppState,
    message: &MessageWithAuthor,
    channel_id: &ChannelId,
    server_id: &ServerId,
) {
    let deps = crate::api::attachment_scan::AttachmentScanDeps::from_state(state);
    let message_id = message.message.id.clone();
    let author_id = message.message.author_id.clone();
    let channel_id = channel_id.clone();
    let server_id = server_id.clone();
    let semaphore = state.moderation_semaphore().clone();

    tokio::spawn(async move {
        // Bound concurrent scans on the shared moderation permit pool.
        let _permit = match timeout(SEMAPHORE_TIMEOUT, semaphore.acquire_owned()).await {
            Ok(Ok(permit)) => permit,
            Ok(Err(_closed)) => {
                tracing::warn!(message_id = %message_id, "attachment scan: semaphore closed — skipping");
                return;
            }
            Err(_elapsed) => {
                // Leave attachments pending; the retry sweep re-scans stragglers.
                tracing::warn!(message_id = %message_id, "attachment scan: semaphore timeout — leaving pending for sweep");
                return;
            }
        };

        crate::api::attachment_scan::scan_message_attachments(
            &deps,
            &message_id,
            &author_id,
            &channel_id,
            &server_id,
        )
        .await;
    });
}

#[cfg(test)]
mod search_param_tests {
    use super::{clamp_search_limit, parse_has_filters, validate_search_query};

    // ── validate_search_query (§7.1) ──────────────────────────────────

    #[test]
    fn missing_q_is_rejected() {
        assert!(validate_search_query(None).is_err());
    }

    #[test]
    fn empty_and_whitespace_q_is_rejected() {
        assert!(validate_search_query(Some("")).is_err());
        assert!(validate_search_query(Some("   \t")).is_err());
    }

    #[test]
    fn q_is_trimmed() {
        assert_eq!(validate_search_query(Some("  hello  ")), Ok("hello"));
    }

    #[test]
    fn q_at_200_chars_is_accepted_over_200_rejected() {
        let at_limit = "a".repeat(200);
        assert_eq!(
            validate_search_query(Some(&at_limit)),
            Ok(at_limit.as_str())
        );
        let over = "a".repeat(201);
        assert!(validate_search_query(Some(&over)).is_err());
    }

    #[test]
    fn q_length_counts_chars_not_bytes() {
        // 200 multi-byte chars is within the limit (char count, not byte count).
        let emoji = "\u{1f600}".repeat(200);
        assert!(validate_search_query(Some(&emoji)).is_ok());
        let over = "\u{1f600}".repeat(201);
        assert!(validate_search_query(Some(&over)).is_err());
    }

    // ── parse_has_filters (§7.1) ──────────────────────────────────────

    #[test]
    fn has_none_is_all_false() {
        assert_eq!(parse_has_filters(None), (false, false));
    }

    #[test]
    fn has_link_and_image_with_unknown_ignored() {
        // `has=link,image,bogus` → both true, unknown ignored (forward-compat).
        assert_eq!(parse_has_filters(Some("link,image,bogus")), (true, true));
    }

    #[test]
    fn has_single_tokens() {
        assert_eq!(parse_has_filters(Some("link")), (true, false));
        assert_eq!(parse_has_filters(Some("image")), (false, true));
    }

    #[test]
    fn has_tokens_are_trimmed() {
        assert_eq!(parse_has_filters(Some(" link , image ")), (true, true));
    }

    #[test]
    fn has_unknown_only_is_all_false() {
        assert_eq!(parse_has_filters(Some("embed,video")), (false, false));
    }

    // ── clamp_search_limit (§7.1) ─────────────────────────────────────

    #[test]
    fn limit_defaults_to_25() {
        assert_eq!(clamp_search_limit(None), 25);
    }

    #[test]
    fn limit_is_clamped_to_1_50() {
        assert_eq!(clamp_search_limit(Some(0)), 1);
        assert_eq!(clamp_search_limit(Some(-5)), 1);
        assert_eq!(clamp_search_limit(Some(1)), 1);
        assert_eq!(clamp_search_limit(Some(25)), 25);
        assert_eq!(clamp_search_limit(Some(50)), 50);
        assert_eq!(clamp_search_limit(Some(999)), 50);
    }
}
