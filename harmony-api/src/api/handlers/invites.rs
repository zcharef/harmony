//! Invite handlers.

use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};
use chrono::{Duration, Utc};

use crate::api::dto::invites::{
    CreateInviteRequest, InvitePreviewResponse, InviteResponse, JoinServerRequest,
};
use crate::api::errors::{ApiError, ProblemDetails};
use crate::api::extractors::{ApiJson, ApiPath, AuthUser};
use crate::api::state::AppState;
use crate::domain::models::server_event::MemberPayload;
use crate::domain::models::{InviteCode, ServerEvent, ServerId};

/// Create a new invite for a server.
///
/// The authenticated user must be a member of the server. Returns a shareable
/// invite code that can be used by others to join.
///
/// # Errors
/// Returns `ApiError` on validation failure, permission denial, or repository error.
#[utoipa::path(
    post,
    path = "/v1/servers/{id}/invites",
    tag = "Invites",
    security(("bearer_auth" = [])),
    params(("id" = ServerId, Path, description = "Server ID")),
    request_body = CreateInviteRequest,
    responses(
        (status = 201, description = "Invite created", body = InviteResponse),
        (status = 400, description = "Validation error", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Not a server member", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state, req))]
pub async fn create_invite(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(server_id): ApiPath<ServerId>,
    ApiJson(req): ApiJson<CreateInviteRequest>,
) -> Result<impl IntoResponse, ApiError> {
    if let Some(m) = req.max_uses
        && !(1..=10000).contains(&m)
    {
        return Err(ApiError::bad_request(
            "max_uses must be between 1 and 10000",
        ));
    }
    if let Some(h) = req.expires_in_hours
        && !(1..=8760).contains(&h)
    {
        return Err(ApiError::bad_request(
            "expires_in_hours must be between 1 and 8760",
        ));
    }

    // WHY: Convert hours to an absolute expiry timestamp so the domain layer
    // deals only with DateTime, not relative durations.
    let expires_at = req
        .expires_in_hours
        .map(|h| Utc::now() + Duration::hours(i64::from(h)));

    let invite = state
        .invite_service()
        .create_invite(server_id, user_id, req.max_uses, expires_at)
        .await?;

    Ok((StatusCode::CREATED, Json(InviteResponse::from(invite))))
}

/// Preview an invite by code (no authentication required).
///
/// Returns the server name and member count so a user can decide whether to join.
///
/// # Errors
/// Returns `ApiError` if the invite is not found or a repository error occurs.
#[utoipa::path(
    get,
    path = "/v1/invites/{code}",
    tag = "Invites",
    params(("code" = InviteCode, Path, description = "Invite code")),
    responses(
        (status = 200, description = "Invite preview", body = InvitePreviewResponse),
        (status = 404, description = "Invite not found", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn preview_invite(
    State(state): State<AppState>,
    ApiPath(code): ApiPath<InviteCode>,
) -> Result<impl IntoResponse, ApiError> {
    let invite = state.invite_service().preview_invite(&code).await?;

    let server = state.server_service().get_by_id(&invite.server_id).await?;

    let member_count = state
        .member_repository()
        .count_by_server(&invite.server_id)
        .await?;

    let preview = InvitePreviewResponse::new(&invite, server.name, member_count);

    Ok((StatusCode::OK, Json(preview)))
}

/// Join a server via an invite code.
///
/// Validates the invite, checks that the user is not already a member,
/// and adds them to the server.
///
/// # Errors
/// Returns `ApiError` on invalid invite, expired invite, or conflict.
#[utoipa::path(
    post,
    path = "/v1/servers/{id}/members",
    tag = "Members",
    security(("bearer_auth" = [])),
    params(("id" = ServerId, Path, description = "Server ID")),
    request_body = JoinServerRequest,
    responses(
        (status = 204, description = "Joined successfully"),
        (status = 400, description = "Invalid or expired invite", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 409, description = "Already a member", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state, req))]
pub async fn join_server(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(server_id): ApiPath<ServerId>,
    ApiJson(req): ApiJson<JoinServerRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let code = InviteCode::new(req.invite_code);

    // WHY: Validate the invite belongs to the server in the URL path.
    // Without this, a client could POST to /v1/servers/WRONG_ID/members
    // with a valid invite for a different server and succeed.
    let invite = state.invite_service().preview_invite(&code).await?;
    if invite.server_id != server_id {
        return Err(ApiError::bad_request(
            "Invite code does not belong to this server",
        ));
    }

    state
        .invite_service()
        .join_via_invite(&code, &user_id)
        .await?;

    // WHY: Best-effort system message — announce the join in the default channel.
    // Must never fail the join itself. If the announcement fails (e.g. no default
    // channel, DB error), we log and move on.
    if let Err(e) = post_join_announcement(&state, &server_id, &user_id).await {
        tracing::warn!(
            server_id = %server_id,
            user_id = %user_id,
            error = ?e,
            "Failed to post join announcement (best-effort)"
        );
    }

    // WHY: Emit MemberJoined so connected SSE clients update their member lists.
    // Best-effort — the join already succeeded, so event emission failure is logged, not propagated.
    match state
        .member_repository()
        .get_member(&server_id, &user_id)
        .await
    {
        Ok(Some(member)) => {
            let event = ServerEvent::MemberJoined {
                sender_id: user_id.clone(),
                server_id: server_id.clone(),
                member: MemberPayload {
                    user_id: member.user_id,
                    username: member.username,
                    avatar_url: member.avatar_url,
                    nickname: member.nickname,
                    role: member.role,
                    joined_at: member.joined_at,
                },
            };
            tracing::debug!(
                server_id = %server_id,
                user_id = %user_id,
                "Emitting MemberJoined event"
            );
            state.event_bus().publish(event);
        }
        Ok(None) => {
            tracing::warn!(
                server_id = %server_id,
                user_id = %user_id,
                "Member not found after join — skipping MemberJoined event"
            );
        }
        Err(e) => {
            tracing::warn!(
                server_id = %server_id,
                user_id = %user_id,
                error = ?e,
                "Failed to fetch member for MemberJoined event"
            );
        }
    }

    Ok(StatusCode::NO_CONTENT)
}

/// Post a `member_join` system message in the server's default channel.
async fn post_join_announcement(
    state: &AppState,
    server_id: &ServerId,
    user_id: &crate::domain::models::UserId,
) -> anyhow::Result<()> {
    super::post_system_message(state, server_id, user_id, "member_join").await
}
