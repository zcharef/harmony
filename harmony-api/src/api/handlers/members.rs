//! Member handlers.

use axum::extract::Query;
use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};
use serde::Deserialize;

use crate::api::dto::members::{
    AssignRoleRequest, MemberListQuery, MemberListResponse, TransferOwnershipRequest,
};
use crate::api::dto::{MemberResponse, ServerResponse};
use crate::api::errors::{ApiError, ProblemDetails};
use crate::api::extractors::{ApiJson, ApiPath, AuthUser};
use crate::api::state::AppState;
use crate::domain::models::server_event::{MemberPayload, ServerPayload};
use crate::domain::models::{ServerEvent, ServerId, UserId, VoiceAction};

/// Default member page size.
const DEFAULT_MEMBER_LIMIT: i64 = 50;
/// Maximum member page size.
const MAX_MEMBER_LIMIT: i64 = 100;

/// List members of a server with cursor-based pagination.
///
/// Use `before` (ISO 8601) to paginate backward. Default limit is 50, max is 100.
///
/// # Errors
/// Returns `ApiError` if the cursor is invalid or a repository error occurs.
#[utoipa::path(
    get,
    path = "/v1/servers/{id}/members",
    tag = "Members",
    security(("bearer_auth" = [])),
    params(
        ("id" = ServerId, Path, description = "Server ID"),
        MemberListQuery,
    ),
    responses(
        (status = 200, description = "Member list", body = MemberListResponse),
        (status = 400, description = "Invalid cursor or limit", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 404, description = "Server not found", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn list_members(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(server_id): ApiPath<ServerId>,
    Query(query): Query<MemberListQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let is_member = state
        .member_repository()
        .is_member(&server_id, &user_id)
        .await?;
    if !is_member {
        return Err(ApiError::forbidden(
            "You must be a server member to view the member list",
        ));
    }

    let limit = query
        .limit
        .unwrap_or(DEFAULT_MEMBER_LIMIT)
        .clamp(1, MAX_MEMBER_LIMIT);

    let cursor = query
        .before
        .map(|s| {
            s.parse::<chrono::DateTime<chrono::Utc>>()
                .map_err(|_| "Invalid 'before' cursor: expected ISO 8601 timestamp")
        })
        .transpose()
        .map_err(ApiError::bad_request)?;

    let members = state
        .member_repository()
        .list_by_server_paginated(&server_id, cursor, limit)
        .await?;

    // WHY: If we received exactly `limit` rows, there may be more — provide a cursor.
    let next_cursor = if i64::try_from(members.len()).unwrap_or(0) == limit {
        members.last().map(|m| m.joined_at.to_rfc3339())
    } else {
        None
    };

    Ok((
        StatusCode::OK,
        Json(MemberListResponse::from_members(members, next_cursor)),
    ))
}

/// Leave a server voluntarily. The owner cannot leave (must transfer ownership first).
///
/// # Errors
/// Returns `ApiError` on validation failure or repository error.
#[utoipa::path(
    post,
    path = "/v1/servers/{id}/leave",
    tag = "Members",
    security(("bearer_auth" = [])),
    params(("id" = ServerId, Path, description = "Server ID")),
    responses(
        (status = 204, description = "Left the server"),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Owner cannot leave", body = ProblemDetails),
        (status = 404, description = "Server not found or not a member", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn leave_server(
    AuthUser(caller_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(server_id): ApiPath<ServerId>,
) -> Result<impl IntoResponse, ApiError> {
    state
        .moderation_service()
        .leave_server(&server_id, &caller_id)
        .await?;

    tracing::info!(
        server_id = %server_id,
        user_id = %caller_id,
        "User left server"
    );

    state.event_bus().publish(ServerEvent::MemberRemoved {
        sender_id: caller_id.clone(),
        server_id: server_id.clone(),
        user_id: caller_id.clone(),
    });

    state.event_bus().publish(ServerEvent::ForceDisconnect {
        sender_id: caller_id.clone(),
        server_id: server_id.clone(),
        target_user_id: caller_id.clone(),
        reason: "left".to_string(),
    });

    // WHY: Best-effort voice cleanup — the user's voice session has no FK
    // to server_members, so removing membership alone won't disconnect them.
    if let Some(voice_service) = state.voice_service() {
        match voice_service.leave_voice(&caller_id, None).await {
            Ok(Some(session)) => {
                state.event_bus().publish(ServerEvent::VoiceStateUpdate {
                    sender_id: caller_id.clone(),
                    server_id: session.server_id.clone(),
                    channel_id: session.channel_id.clone(),
                    user_id: caller_id.clone(),
                    action: VoiceAction::Left,
                    display_name: String::new(),
                    is_muted: None,
                    is_deafened: None,
                });
                tracing::debug!(
                    server_id = %session.server_id,
                    channel_id = %session.channel_id,
                    user_id = %caller_id,
                    "User removed from voice channel on server leave"
                );
            }
            Ok(None) => {} // User was not in voice — nothing to clean up.
            Err(e) => {
                tracing::warn!(
                    server_id = %server_id,
                    user_id = %caller_id,
                    error = ?e,
                    "Failed to remove user from voice on server leave (best-effort)"
                );
            }
        }
    }

    // WHY: Best-effort system message — announce the leave in the default channel.
    // Must never fail the leave itself.
    if let Err(e) = super::post_system_message(&state, &server_id, &caller_id, "member_leave").await
    {
        tracing::warn!(
            server_id = %server_id,
            user_id = %caller_id,
            error = ?e,
            "Failed to post leave announcement (best-effort)"
        );
    }

    Ok(StatusCode::NO_CONTENT)
}

/// Path parameters for member-specific operations.
#[derive(Debug, Deserialize)]
pub struct MemberPath {
    pub id: ServerId,
    pub user_id: UserId,
}

/// Kick a member from a server. Requires moderator+ role with hierarchy enforcement.
///
/// # Errors
/// Returns `ApiError` on authorization failure or repository error.
#[utoipa::path(
    delete,
    path = "/v1/servers/{id}/members/{user_id}",
    tag = "Members",
    security(("bearer_auth" = [])),
    params(
        ("id" = ServerId, Path, description = "Server ID"),
        ("user_id" = UserId, Path, description = "User ID to kick"),
    ),
    responses(
        (status = 204, description = "Member kicked"),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Insufficient role or hierarchy violation", body = ProblemDetails),
        (status = 404, description = "Server or member not found", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn kick_member(
    AuthUser(caller_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(path): ApiPath<MemberPath>,
) -> Result<impl IntoResponse, ApiError> {
    state
        .moderation_service()
        .kick_member(&path.id, &path.user_id, &caller_id)
        .await?;

    // WHY: Notify connected clients that a member was removed.
    tracing::debug!(
        server_id = %path.id,
        kicked_user_id = %path.user_id,
        caller_id = %caller_id,
        "Emitting MemberRemoved + ForceDisconnect events"
    );
    let receivers = state.event_bus().publish(ServerEvent::MemberRemoved {
        sender_id: caller_id.clone(),
        server_id: path.id.clone(),
        user_id: path.user_id.clone(),
    });
    tracing::debug!(server_id = %path.id, user_id = %path.user_id, receivers, "emitted member.removed");

    let receivers = state.event_bus().publish(ServerEvent::ForceDisconnect {
        sender_id: caller_id,
        server_id: path.id.clone(),
        target_user_id: path.user_id.clone(),
        reason: "kicked".to_string(),
    });
    tracing::debug!(server_id = %path.id, target_user_id = %path.user_id, receivers, "emitted force.disconnect");

    // WHY: Best-effort voice cleanup — the kicked user's voice session has no FK
    // to server_members, so removing membership alone won't disconnect them.
    if let Some(voice_service) = state.voice_service() {
        match voice_service.leave_voice(&path.user_id, None).await {
            Ok(Some(session)) => {
                state.event_bus().publish(ServerEvent::VoiceStateUpdate {
                    sender_id: path.user_id.clone(),
                    server_id: session.server_id.clone(),
                    channel_id: session.channel_id.clone(),
                    user_id: path.user_id.clone(),
                    action: VoiceAction::Left,
                    display_name: String::new(),
                    is_muted: None,
                    is_deafened: None,
                });
                tracing::debug!(
                    server_id = %session.server_id,
                    channel_id = %session.channel_id,
                    user_id = %path.user_id,
                    "Kicked user removed from voice channel"
                );
            }
            Ok(None) => {} // User was not in voice — nothing to clean up.
            Err(e) => {
                tracing::warn!(
                    server_id = %path.id,
                    user_id = %path.user_id,
                    error = ?e,
                    "Failed to remove kicked user from voice (best-effort)"
                );
            }
        }
    }

    // WHY: Best-effort system message — announce the kick in the default channel.
    // Must never fail the kick itself.
    if let Err(e) = super::post_system_message(&state, &path.id, &path.user_id, "member_kick").await
    {
        tracing::warn!(
            server_id = %path.id,
            user_id = %path.user_id,
            error = ?e,
            "Failed to post kick announcement (best-effort)"
        );
    }

    Ok(StatusCode::NO_CONTENT)
}

/// Assign a role to a server member. Requires admin+ role with hierarchy enforcement.
///
/// # Errors
/// Returns `ApiError` on validation failure, authorization failure, or repository error.
#[utoipa::path(
    patch,
    path = "/v1/servers/{id}/members/{user_id}/role",
    tag = "Members",
    security(("bearer_auth" = [])),
    params(
        ("id" = ServerId, Path, description = "Server ID"),
        ("user_id" = UserId, Path, description = "Target user ID"),
    ),
    request_body = AssignRoleRequest,
    responses(
        (status = 200, description = "Role assigned", body = MemberResponse),
        (status = 400, description = "Invalid role or self-assignment", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Insufficient role or hierarchy violation", body = ProblemDetails),
        (status = 404, description = "Server or member not found", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state, req))]
pub async fn assign_role(
    AuthUser(caller_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(path): ApiPath<MemberPath>,
    ApiJson(req): ApiJson<AssignRoleRequest>,
) -> Result<impl IntoResponse, ApiError> {
    state
        .moderation_service()
        .assign_role(&path.id, &caller_id, &path.user_id, req.role)
        .await?;

    // Return the updated member
    let member = state
        .member_repository()
        .get_member(&path.id, &path.user_id)
        .await?
        .ok_or_else(|| {
            ApiError::not_found(format!(
                "ServerMember with id 'server={}, user={}' not found",
                path.id, path.user_id
            ))
        })?;

    // WHY: Notify connected clients that a member's role changed.
    tracing::debug!(
        server_id = %path.id,
        target_user_id = %path.user_id,
        new_role = ?member.role,
        "Emitting MemberRoleUpdated event"
    );
    state.event_bus().publish(ServerEvent::MemberRoleUpdated {
        sender_id: caller_id,
        server_id: path.id,
        member: MemberPayload {
            user_id: member.user_id.clone(),
            username: member.username.clone(),
            avatar_url: member.avatar_url.clone(),
            nickname: member.nickname.clone(),
            role: member.role,
            joined_at: member.joined_at,
        },
    });

    Ok((StatusCode::OK, Json(MemberResponse::from(member))))
}

/// Transfer server ownership. Only the current owner can do this.
///
/// # Errors
/// Returns `ApiError` on authorization failure or repository error.
#[utoipa::path(
    post,
    path = "/v1/servers/{id}/transfer-ownership",
    tag = "Members",
    security(("bearer_auth" = [])),
    params(("id" = ServerId, Path, description = "Server ID")),
    request_body = TransferOwnershipRequest,
    responses(
        (status = 200, description = "Ownership transferred", body = ServerResponse),
        (status = 400, description = "Cannot transfer to self", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Not server owner", body = ProblemDetails),
        (status = 404, description = "Server or new owner not found", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state, req))]
pub async fn transfer_ownership(
    AuthUser(caller_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(server_id): ApiPath<ServerId>,
    ApiJson(req): ApiJson<TransferOwnershipRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let server = state
        .moderation_service()
        .transfer_ownership(&server_id, &caller_id, &req.new_owner_id)
        .await?;

    // WHY: Ownership transfer is a compound operation (server.owner_id + 2 role
    // changes). Emit three events so all connected members see the full update.
    state.event_bus().publish(ServerEvent::ServerUpdated {
        sender_id: caller_id.clone(),
        server_id: server_id.clone(),
        server: ServerPayload {
            id: server.id.clone(),
            name: server.name.clone(),
            icon_url: server.icon_url.clone(),
            owner_id: server.owner_id.clone(),
        },
    });

    // Fetch updated members for role-change payloads.
    // WHY: The transfer already committed — if these reads fail, the transfer
    // succeeded but clients miss the role events and will resync on reconnect.
    match state
        .member_repository()
        .get_member(&server_id, &caller_id)
        .await
    {
        Ok(Some(old_owner)) => {
            state.event_bus().publish(ServerEvent::MemberRoleUpdated {
                sender_id: caller_id.clone(),
                server_id: server_id.clone(),
                member: MemberPayload {
                    user_id: old_owner.user_id,
                    username: old_owner.username,
                    avatar_url: old_owner.avatar_url,
                    nickname: old_owner.nickname,
                    role: old_owner.role,
                    joined_at: old_owner.joined_at,
                },
            });
        }
        Ok(None) => {
            tracing::warn!(
                server_id = %server_id,
                user_id = %caller_id,
                "Old owner member not found after transfer — skipping MemberRoleUpdated event"
            );
        }
        Err(e) => {
            tracing::warn!(
                server_id = %server_id,
                user_id = %caller_id,
                error = ?e,
                "Failed to fetch old owner for MemberRoleUpdated event"
            );
        }
    }

    match state
        .member_repository()
        .get_member(&server_id, &req.new_owner_id)
        .await
    {
        Ok(Some(new_owner)) => {
            state.event_bus().publish(ServerEvent::MemberRoleUpdated {
                sender_id: caller_id.clone(),
                server_id: server_id.clone(),
                member: MemberPayload {
                    user_id: new_owner.user_id,
                    username: new_owner.username,
                    avatar_url: new_owner.avatar_url,
                    nickname: new_owner.nickname,
                    role: new_owner.role,
                    joined_at: new_owner.joined_at,
                },
            });
        }
        Ok(None) => {
            tracing::warn!(
                server_id = %server_id,
                user_id = %req.new_owner_id,
                "New owner member not found after transfer — skipping MemberRoleUpdated event"
            );
        }
        Err(e) => {
            tracing::warn!(
                server_id = %server_id,
                user_id = %req.new_owner_id,
                error = ?e,
                "Failed to fetch new owner for MemberRoleUpdated event"
            );
        }
    }

    Ok((StatusCode::OK, Json(ServerResponse::from(server))))
}
