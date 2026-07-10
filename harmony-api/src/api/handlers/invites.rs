//! Invite handlers.

use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
};
use chrono::{Duration, Utc};

use crate::api::client_ip::resolve_client_key;
use crate::api::dto::invites::{
    CreateInviteRequest, InvitePreviewResponse, InviteResponse, JoinServerRequest,
};
use crate::api::errors::{ApiError, ProblemDetails};
use crate::api::extractors::{ApiJson, ApiPath, AuthUser};
use crate::api::state::AppState;
use crate::domain::models::server_event::MemberPayload;
use crate::domain::models::{
    AnalyticsEvent, AnalyticsEventName, InviteCode, ServerEvent, ServerId,
};

/// Maximum invite previews per client IP within [`INVITE_PREVIEW_RATE_WINDOW`].
/// WHY 20/min: a human landing on an invite triggers ONE preview (crawlers are
/// absorbed by the Pages Function's 60s cache) — generous for legitimate use,
/// hostile to code enumeration on this unauth surface (ticket decision #1).
const INVITE_PREVIEW_RATE_MAX: usize = 20;

/// Window for the per-client invite preview rate limit.
const INVITE_PREVIEW_RATE_WINDOW: std::time::Duration = std::time::Duration::from_secs(60);

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
        .create_invite(server_id.clone(), user_id.clone(), req.max_uses, expires_at)
        .await?;

    // §10 referral funnel: K-factor numerator (fire-and-forget).
    super::track(
        &state,
        AnalyticsEvent::new(AnalyticsEventName::InviteCreated)
            .user(user_id)
            .server(server_id)
            .properties(serde_json::json!({ "code": invite.code.clone() })),
    );

    Ok((StatusCode::CREATED, Json(InviteResponse::from(invite))))
}

/// Preview an invite by code (no authentication required).
///
/// Returns the server name/icon, member count, and inviter identity so a
/// user can decide whether to join. Expired or exhausted invites are
/// indistinguishable from nonexistent ones (404).
///
/// # Errors
/// Returns `ApiError` if the invite is not found, expired, exhausted, or a
/// repository error occurs.
#[utoipa::path(
    get,
    path = "/v1/invites/{code}",
    tag = "Invites",
    params(("code" = InviteCode, Path, description = "Invite code")),
    responses(
        (status = 200, description = "Invite preview", body = InvitePreviewResponse),
        (status = 404, description = "Invite not found or no longer valid", body = ProblemDetails),
        (status = 429, description = "Invite preview rate limit exceeded", body = ProblemDetails),
    )
)]
// WHY skip(code): the raw invite code is a join capability — it must never
// land in span fields. The handler logs only its hash (hash_invite_code).
#[tracing::instrument(skip(state, headers, code))]
pub async fn preview_invite(
    State(state): State<AppState>,
    headers: HeaderMap,
    ApiPath(code): ApiPath<InviteCode>,
) -> Result<impl IntoResponse, ApiError> {
    // WHY per-IP and BEFORE any lookup: this is the unauth hostile surface
    // (ticket decision #1) — enumeration attempts must burn the attacker's
    // budget, not our DB. The Pages Function forwards the original client IP
    // (secret-gated) because its server-side fetch would otherwise collapse
    // all crawlers into the Cloudflare egress bucket (see api::client_ip).
    let client_key = resolve_client_key(&headers, state.trusted_proxy_secret());
    state.spam_guard().check_and_record_unauth_action(
        &client_key,
        "invite preview",
        INVITE_PREVIEW_RATE_MAX,
        INVITE_PREVIEW_RATE_WINDOW,
    )?;

    let invite = state.invite_service().preview_public_invite(&code).await?;

    let server = state.server_service().get_by_id(&invite.server_id).await?;

    let member_count = state
        .member_repository()
        .count_by_server(&invite.server_id)
        .await?;

    // WHY: Missing inviter profile (account deleted) degrades to null fields,
    // it must not kill the preview — the server context is the value here.
    let inviter = state
        .profile_service()
        .get_by_id_optional(&invite.creator_id)
        .await?;

    // WHY: Funnel instrumentation for invite→join conversion (growth-plan §7).
    // The analytics `funnel_events` table has not landed yet, so this degrades
    // to a structured log per the invite-landing ticket. The raw code is a
    // join capability — log only its hash.
    tracing::info!(
        event = "invite_preview_viewed",
        invite_code_hash = %hash_invite_code(&code),
        server_id = %invite.server_id,
        "Invite preview viewed"
    );

    let preview = InvitePreviewResponse::new(&invite, &server, member_count, inviter.as_ref());

    Ok((StatusCode::OK, Json(preview)))
}

/// SHA-256 hash of an invite code, truncated to 16 hex chars.
///
/// WHY: enough entropy to correlate funnel events for one invite without
/// storing the code itself (the code grants server access).
fn hash_invite_code(code: &InviteCode) -> String {
    use sha2::{Digest, Sha256};

    let digest = Sha256::digest(code.0.as_bytes());
    hex::encode(&digest[..8])
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

    // §10 referral + activation funnel: invite conversion and the joined-a-
    // server milestone (fire-and-forget). The inviter is derivable from the
    // code via the invites/events log — no duplication here.
    super::track(
        &state,
        AnalyticsEvent::new(AnalyticsEventName::InviteRedeemed)
            .user(user_id.clone())
            .server(server_id.clone())
            .properties(serde_json::json!({ "code": code })),
    );
    super::track(
        &state,
        AnalyticsEvent::new(AnalyticsEventName::ServerJoined)
            .user(user_id.clone())
            .server(server_id.clone())
            .properties(serde_json::json!({ "via": "invite" })),
    );

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
                    is_founding: member.is_founding,
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
