//! Server-directory handlers (opt-in discovery).

use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
};

use crate::api::dto::{
    DiscoveryListQuery, DiscoveryListResponse, ServerResponse, UpdateServerDiscoveryRequest,
};
use crate::api::errors::{ApiError, ProblemDetails};
use crate::api::extractors::{ApiJson, ApiPath, AuthUser};
use crate::api::state::AppState;
use crate::domain::models::server_event::ServerPayload;
use crate::domain::models::{AnalyticsEvent, AnalyticsEventName, Role, ServerEvent, ServerId};
use crate::domain::services::DiscoveryJoinOutcome;

/// Update a server's directory settings. Requires admin+ role.
///
/// The public description goes through the same hard content-moderation
/// gate as server names.
///
/// # Errors
/// Returns `ApiError` on validation/moderation failure, insufficient role,
/// or repository error.
#[utoipa::path(
    patch,
    path = "/v1/servers/{id}/discovery",
    tag = "Discovery",
    security(("bearer_auth" = [])),
    params(("id" = ServerId, Path, description = "Server ID")),
    request_body = UpdateServerDiscoveryRequest,
    responses(
        (status = 200, description = "Discovery settings updated", body = ServerResponse),
        (status = 400, description = "Validation or moderation error", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Insufficient role", body = ProblemDetails),
        (status = 404, description = "Server not found", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state, req))]
pub async fn update_server_discovery(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(id): ApiPath<ServerId>,
    ApiJson(req): ApiJson<UpdateServerDiscoveryRequest>,
) -> Result<impl IntoResponse, ApiError> {
    state
        .moderation_service()
        .require_role(&id, &user_id, Role::Admin)
        .await?;

    let server = state
        .discovery_service()
        .update_discovery_settings(&id, req.discoverable, req.category, req.description)
        .await?;

    // Fan out through the existing server.updated event so admin settings
    // screens rehydrate live (same channel as a server rename).
    let receivers = state.event_bus().publish(ServerEvent::ServerUpdated {
        sender_id: user_id,
        server_id: server.id.clone(),
        server: ServerPayload {
            id: server.id.clone(),
            name: server.name.clone(),
            icon_url: server.icon_url.clone(),
            owner_id: server.owner_id.clone(),
            discoverable: server.discoverable,
            discovery_category: server.discovery_category.clone(),
            discovery_description: server.discovery_description.clone(),
        },
    });
    tracing::debug!(
        server_id = %server.id,
        discoverable = server.discoverable,
        receivers,
        "emitted server.updated (discovery settings)"
    );

    Ok((StatusCode::OK, Json(ServerResponse::from(server))))
}

/// List the public server directory (authenticated).
///
/// Only servers that opted in (`discoverable = true`) are ever returned,
/// featured entries first, then by member count.
///
/// # Errors
/// Returns `ApiError` on an unknown category, malformed cursor, or
/// repository error.
#[utoipa::path(
    get,
    path = "/v1/discovery/servers",
    tag = "Discovery",
    security(("bearer_auth" = [])),
    params(DiscoveryListQuery),
    responses(
        (status = 200, description = "Directory page", body = DiscoveryListResponse),
        (status = 400, description = "Validation error", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn list_discovery_servers(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    Query(query): Query<DiscoveryListQuery>,
) -> Result<impl IntoResponse, ApiError> {
    // WHY before the query: a directory "view" is the first page load —
    // follow-up cursor pages are the same view, not new funnel entries.
    let is_first_page = query.cursor.is_none();

    let page = state
        .discovery_service()
        .list_directory(query.category, query.q, query.cursor, query.limit)
        .await?;

    if is_first_page {
        // §10 discovery funnel (fire-and-forget). IDs only, no PII.
        super::track(
            &state,
            AnalyticsEvent::new(AnalyticsEventName::DiscoveryViewed).user(user_id),
        );
    }

    Ok((StatusCode::OK, Json(DiscoveryListResponse::from(page))))
}

/// One-click join of a discoverable server.
///
/// Re-checks `discoverable = true` at join time and respects existing bans
/// (banned users get a clean 403). Joining a server the user is already a
/// member of is an idempotent no-op.
///
/// # Errors
/// Returns `ApiError` if the server is not discoverable, the user is
/// banned, a plan limit is reached, or on repository error.
#[utoipa::path(
    post,
    path = "/v1/discovery/servers/{id}/join",
    tag = "Discovery",
    security(("bearer_auth" = [])),
    params(("id" = ServerId, Path, description = "Server ID")),
    responses(
        (status = 204, description = "Joined (or already a member)"),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Not discoverable or user banned", body = ProblemDetails),
        (status = 404, description = "Server not found", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn join_discovery_server(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(id): ApiPath<ServerId>,
) -> Result<impl IntoResponse, ApiError> {
    let outcome = state.discovery_service().join(&id, &user_id).await?;

    if outcome == DiscoveryJoinOutcome::AlreadyMember {
        // Idempotent no-op: no events, no announcement, no analytics.
        return Ok(StatusCode::NO_CONTENT);
    }

    // §10 discovery + activation funnel (fire-and-forget, IDs only).
    super::track(
        &state,
        AnalyticsEvent::new(AnalyticsEventName::DiscoveryJoin)
            .user(user_id.clone())
            .server(id.clone()),
    );
    super::track(
        &state,
        AnalyticsEvent::new(AnalyticsEventName::ServerJoined)
            .user(user_id.clone())
            .server(id.clone())
            .properties(serde_json::json!({ "via": "discovery" })),
    );

    // WHY: Best-effort system message — same announcement as invite joins.
    if let Err(e) = super::post_system_message(&state, &id, &user_id, "member_join").await {
        tracing::warn!(
            server_id = %id,
            user_id = %user_id,
            error = ?e,
            "Failed to post join announcement (best-effort)"
        );
    }

    // Member lists update live via the existing member.joined fan-out —
    // shared with the invite join path, not duplicated.
    super::emit_member_joined(&state, &id, &user_id).await;

    Ok(StatusCode::NO_CONTENT)
}
