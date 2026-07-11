//! Friendship + block handlers (endpoints publish SSE events, like `dms.rs`).

use axum::extract::Query;
use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};
use chrono::{DateTime, Utc};

use crate::api::dto::friends::{
    BlockedListResponse, FriendAcceptedResponse, FriendListResponse, FriendRequestListQuery,
    FriendRequestListResponse, FriendRequestResultResponse, SendFriendRequestRequest,
};
use crate::api::errors::{ApiError, ProblemDetails};
use crate::api::extractors::{ApiJson, ApiPath, AuthUser};
use crate::api::state::AppState;
use crate::domain::models::friendship::{BlockOutcome, RequestDirection, RequestOutcome};
use crate::domain::models::server_event::{FriendPayload, FriendRequestPayload};
use crate::domain::models::{Profile, ServerEvent, UserId, UserStatus};
use crate::domain::services::friendship_service::RequestTarget;

/// Build a `FriendPayload` carrying the counterpart's LIVE presence (§4.1).
fn friend_payload(
    state: &AppState,
    profile: &Profile,
    friends_since: DateTime<Utc>,
) -> FriendPayload {
    let status = state
        .presence_tracker()
        .get_status(&profile.id)
        .unwrap_or(UserStatus::Offline);
    FriendPayload {
        user_id: profile.id.clone(),
        username: profile.username.clone(),
        display_name: profile.display_name.clone(),
        avatar_url: profile.avatar_url.clone(),
        status,
        friends_since,
    }
}

fn request_payload(
    profile: &Profile,
    direction: RequestDirection,
    created_at: DateTime<Utc>,
) -> FriendRequestPayload {
    FriendRequestPayload {
        user_id: profile.id.clone(),
        username: profile.username.clone(),
        display_name: profile.display_name.clone(),
        avatar_url: profile.avatar_url.clone(),
        direction,
        created_at,
    }
}

/// List the authenticated user's friends (username order, whole list).
///
/// # Errors
/// Returns `ApiError` on repository failure.
#[utoipa::path(
    get,
    path = "/v1/friends",
    tag = "Friends",
    security(("bearer_auth" = [])),
    responses(
        (status = 200, description = "Friends list", body = FriendListResponse),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn list_friends(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, ApiError> {
    let friends = state.friendship_service().list_friends(&user_id).await?;
    let response: FriendListResponse = friends.into_iter().collect();
    Ok((StatusCode::OK, Json(response)))
}

/// List the authenticated user's pending friend requests in one direction.
///
/// # Errors
/// Returns `ApiError` on repository failure.
#[utoipa::path(
    get,
    path = "/v1/friends/requests",
    tag = "Friends",
    security(("bearer_auth" = [])),
    params(FriendRequestListQuery),
    responses(
        (status = 200, description = "Pending requests", body = FriendRequestListResponse),
        (status = 400, description = "Bad direction", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn list_requests(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    Query(query): Query<FriendRequestListQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let requests = state
        .friendship_service()
        .list_requests(&user_id, query.direction)
        .await?;
    let response: FriendRequestListResponse = requests.into_iter().collect();
    Ok((StatusCode::OK, Json(response)))
}

/// Send a friend request (by user id or exact username).
///
/// # Errors
/// Returns `ApiError` on validation, block, cap, rate-limit, or not-found.
#[utoipa::path(
    post,
    path = "/v1/friends/requests",
    tag = "Friends",
    security(("bearer_auth" = [])),
    request_body = SendFriendRequestRequest,
    responses(
        (status = 201, description = "Request sent", body = FriendRequestResultResponse),
        (status = 200, description = "Idempotent replay or auto-accept", body = FriendRequestResultResponse),
        (status = 400, description = "Self-request / bad body", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Blocked", body = ProblemDetails),
        (status = 404, description = "User not found", body = ProblemDetails),
        (status = 409, description = "Cap reached", body = ProblemDetails),
        (status = 429, description = "Rate limited", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state, req))]
pub async fn send_request(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiJson(req): ApiJson<SendFriendRequestRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let target = RequestTarget::try_from(req).map_err(ApiError::bad_request)?;

    let (outcome, profile) = state
        .friendship_service()
        .send_request(&user_id, target)
        .await?;

    let now = Utc::now();

    match &outcome {
        RequestOutcome::Requested => {
            // Publish the incoming event to the addressee and the outgoing echo
            // to the requester's other tabs.
            let caller_profile = state.profile_service().get_by_id(&user_id).await?;
            state
                .event_bus()
                .publish(ServerEvent::FriendRequestCreated {
                    sender_id: user_id.clone(),
                    target_user_id: profile.id.clone(),
                    request: request_payload(&caller_profile, RequestDirection::Incoming, now),
                });
            state
                .event_bus()
                .publish(ServerEvent::FriendRequestCreated {
                    sender_id: user_id.clone(),
                    target_user_id: user_id.clone(),
                    request: request_payload(&profile, RequestDirection::Outgoing, now),
                });
        }
        RequestOutcome::AutoAccepted => {
            let caller_profile = state.profile_service().get_by_id(&user_id).await?;
            // target = caller: friend is the addressee; target = addressee: friend is caller.
            state.event_bus().publish(ServerEvent::FriendAdded {
                sender_id: user_id.clone(),
                target_user_id: user_id.clone(),
                friend: friend_payload(&state, &profile, now),
            });
            state.event_bus().publish(ServerEvent::FriendAdded {
                sender_id: user_id.clone(),
                target_user_id: profile.id.clone(),
                friend: friend_payload(&state, &caller_profile, now),
            });
        }
        RequestOutcome::AlreadyRequested | RequestOutcome::AlreadyFriends => {}
    }

    // 201 for a fresh request, 200 for every idempotent / terminal replay.
    let status = if matches!(outcome, RequestOutcome::Requested) {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };

    let response = FriendRequestResultResponse::from((outcome, profile, now));
    Ok((status, Json(response)))
}

/// Accept a pending incoming friend request.
///
/// # Errors
/// Returns `ApiError` on not-found (no pending request) or cap.
#[utoipa::path(
    post,
    path = "/v1/friends/requests/{user_id}/accept",
    tag = "Friends",
    security(("bearer_auth" = [])),
    params(("user_id" = UserId, Path, description = "Requester user ID")),
    responses(
        (status = 200, description = "Accepted", body = FriendAcceptedResponse),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 404, description = "No pending request", body = ProblemDetails),
        (status = 409, description = "Friends cap reached", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn accept_request(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(requester_id): ApiPath<UserId>,
) -> Result<impl IntoResponse, ApiError> {
    let (friendship, requester_profile) = state
        .friendship_service()
        .accept_request(&user_id, &requester_id)
        .await?;
    let friends_since = friendship.updated_at;

    let accepter_profile = state.profile_service().get_by_id(&user_id).await?;

    // target = accepter: friend is the requester; target = requester: friend is accepter.
    state.event_bus().publish(ServerEvent::FriendAdded {
        sender_id: user_id.clone(),
        target_user_id: user_id.clone(),
        friend: friend_payload(&state, &requester_profile, friends_since),
    });
    state.event_bus().publish(ServerEvent::FriendAdded {
        sender_id: user_id.clone(),
        target_user_id: requester_id.clone(),
        friend: friend_payload(&state, &accepter_profile, friends_since),
    });

    let response = FriendAcceptedResponse::from((requester_profile, friends_since));
    Ok((StatusCode::OK, Json(response)))
}

/// Decline (incoming) or cancel (outgoing) a pending request.
///
/// # Errors
/// Returns `ApiError` on not-found (no pending request with that user).
#[utoipa::path(
    delete,
    path = "/v1/friends/requests/{user_id}",
    tag = "Friends",
    security(("bearer_auth" = [])),
    params(("user_id" = UserId, Path, description = "Counterpart user ID")),
    responses(
        (status = 204, description = "Removed"),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 404, description = "No pending request", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn remove_request(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(other_id): ApiPath<UserId>,
) -> Result<impl IntoResponse, ApiError> {
    state
        .friendship_service()
        .remove_request(&user_id, &other_id)
        .await?;

    // The requester's UI drops the entry silently, no toast (decline must not notify).
    state
        .event_bus()
        .publish(ServerEvent::FriendRequestRemoved {
            sender_id: user_id.clone(),
            target_user_id: other_id.clone(),
            user_id: user_id.clone(),
        });
    state
        .event_bus()
        .publish(ServerEvent::FriendRequestRemoved {
            sender_id: user_id.clone(),
            target_user_id: user_id.clone(),
            user_id: other_id.clone(),
        });

    Ok(StatusCode::NO_CONTENT)
}

/// Unfriend (idempotent — 204 even when not friends).
///
/// # Errors
/// Returns `ApiError` on repository failure.
#[utoipa::path(
    delete,
    path = "/v1/friends/{user_id}",
    tag = "Friends",
    security(("bearer_auth" = [])),
    params(("user_id" = UserId, Path, description = "Friend user ID")),
    responses(
        (status = 204, description = "Unfriended"),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn unfriend(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(other_id): ApiPath<UserId>,
) -> Result<impl IntoResponse, ApiError> {
    let removed = state
        .friendship_service()
        .unfriend(&user_id, &other_id)
        .await?;

    // Conditional publish: only when a friendship was actually removed (§4.2).
    if removed {
        state.event_bus().publish(ServerEvent::FriendRemoved {
            sender_id: user_id.clone(),
            target_user_id: other_id.clone(),
            user_id: user_id.clone(),
        });
        state.event_bus().publish(ServerEvent::FriendRemoved {
            sender_id: user_id.clone(),
            target_user_id: user_id.clone(),
            user_id: other_id.clone(),
        });
    }

    Ok(StatusCode::NO_CONTENT)
}

/// List the authenticated user's blocked users (newest first).
///
/// # Errors
/// Returns `ApiError` on repository failure.
#[utoipa::path(
    get,
    path = "/v1/blocks",
    tag = "Friends",
    security(("bearer_auth" = [])),
    responses(
        (status = 200, description = "Blocked users", body = BlockedListResponse),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn list_blocks(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, ApiError> {
    let blocks = state.friendship_service().list_blocks(&user_id).await?;
    let response: BlockedListResponse = blocks.into_iter().collect();
    Ok((StatusCode::OK, Json(response)))
}

/// Block a user (idempotent PUT).
///
/// # Errors
/// Returns `ApiError` on self-block, not-found, cap, or rate-limit.
#[utoipa::path(
    put,
    path = "/v1/blocks/{user_id}",
    tag = "Friends",
    security(("bearer_auth" = [])),
    params(("user_id" = UserId, Path, description = "User to block")),
    responses(
        (status = 204, description = "Blocked"),
        (status = 400, description = "Self-block", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 404, description = "User not found", body = ProblemDetails),
        (status = 409, description = "Blocks cap reached", body = ProblemDetails),
        (status = 429, description = "Rate limited", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn block_user(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(target_id): ApiPath<UserId>,
) -> Result<impl IntoResponse, ApiError> {
    let (outcome, _profile) = state
        .friendship_service()
        .block(&user_id, &target_id)
        .await?;

    // The teardown looks exactly like an unfriend / cancel to the blocked user
    // (they NEVER receive a block event). The blocker self-syncs via block.created.
    match outcome {
        BlockOutcome::BlockedWasFriends => {
            state.event_bus().publish(ServerEvent::FriendRemoved {
                sender_id: user_id.clone(),
                target_user_id: target_id.clone(),
                user_id: user_id.clone(),
            });
            state.event_bus().publish(ServerEvent::FriendRemoved {
                sender_id: user_id.clone(),
                target_user_id: user_id.clone(),
                user_id: target_id.clone(),
            });
        }
        BlockOutcome::BlockedWasPending => {
            state
                .event_bus()
                .publish(ServerEvent::FriendRequestRemoved {
                    sender_id: user_id.clone(),
                    target_user_id: target_id.clone(),
                    user_id: user_id.clone(),
                });
            state
                .event_bus()
                .publish(ServerEvent::FriendRequestRemoved {
                    sender_id: user_id.clone(),
                    target_user_id: user_id.clone(),
                    user_id: target_id.clone(),
                });
        }
        BlockOutcome::Blocked | BlockOutcome::AlreadyBlocked => {}
    }

    // Self-sync so the blocker's other tabs learn about the block. Never sent to
    // the blocked user, and only on a fresh block (idempotent re-block is a no-op).
    if !matches!(outcome, BlockOutcome::AlreadyBlocked) {
        state.event_bus().publish(ServerEvent::BlockCreated {
            sender_id: user_id.clone(),
            target_user_id: user_id.clone(),
            user_id: target_id.clone(),
        });
    }

    Ok(StatusCode::NO_CONTENT)
}

/// Unblock a user (idempotent).
///
/// # Errors
/// Returns `ApiError` on repository failure.
#[utoipa::path(
    delete,
    path = "/v1/blocks/{user_id}",
    tag = "Friends",
    security(("bearer_auth" = [])),
    params(("user_id" = UserId, Path, description = "User to unblock")),
    responses(
        (status = 204, description = "Unblocked"),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn unblock_user(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(target_id): ApiPath<UserId>,
) -> Result<impl IntoResponse, ApiError> {
    let removed = state
        .friendship_service()
        .unblock(&user_id, &target_id)
        .await?;

    // Self-sync only, and only when a block was actually removed (§4.2).
    if removed {
        state.event_bus().publish(ServerEvent::BlockRemoved {
            sender_id: user_id.clone(),
            target_user_id: user_id.clone(),
            user_id: target_id.clone(),
        });
    }

    Ok(StatusCode::NO_CONTENT)
}
