//! Profile handlers.

use axum::{
    Extension, Json, extract::Query, extract::State, http::StatusCode, response::IntoResponse,
};

use crate::api::dto::{
    CheckUsernameQuery, CheckUsernameResponse, ProfileResponse, UpdateProfileRequest,
};
use crate::api::errors::{ApiError, ProblemDetails};
use crate::api::extractors::{ApiJson, AuthUser};
use crate::api::state::AppState;
use crate::domain::errors::DomainError;
use crate::domain::models::server_event::{MemberPayload, ServerEvent};
use crate::domain::services::ProfileService;
use crate::infra::auth::AuthenticatedUser;

/// Sync (get or create) the authenticated user's profile.
///
/// Called after Supabase login. Creates a profile row if this is the first login,
/// or returns the existing one.
///
/// Username resolution order:
/// 1. `user_metadata.username` from the JWT (set during signup)
/// 2. Fallback: derived from the email prefix
///
/// All username policy (reserved names, content filter, safe fallback for
/// system-derived names) is handled by `ProfileService::upsert_from_auth`.
///
/// # Errors
/// Returns `ApiError` if the JWT lacks an email claim, the username is reserved
/// or offensive (user-chosen only), or the upsert fails.
#[utoipa::path(
    post,
    path = "/v1/auth/me",
    tag = "Auth",
    security(("bearer_auth" = [])),
    responses(
        (status = 200, description = "Profile synced successfully", body = ProfileResponse),
        (status = 400, description = "Username contains prohibited language", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 409, description = "Username reserved", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state, auth_user))]
pub async fn sync_profile(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    Extension(auth_user): Extension<AuthenticatedUser>,
) -> Result<impl IntoResponse, ApiError> {
    let email = auth_user
        .email
        .ok_or_else(|| ApiError::bad_request("JWT must contain an email claim"))?;

    // WHY: Grandfathered users (created before content filter / reserved-name
    // checks existed) may have a username that now fails validation. Since the
    // DB upsert is a no-op for existing profiles, skip the entire validation
    // chain and return the existing profile directly.
    if let Some(existing) = state.profile_service().get_by_id_optional(&user_id).await? {
        // WHY (F7): The signup trigger honors user_metadata.username but cannot
        // run the content filter, so a direct /auth/v1/signup bypasses it. Only
        // a username chosen at THIS signup (metadata == stored) is re-validated
        // and regenerated — grandfathered names are untouched. Runs BEFORE
        // auto-join so MemberJoined broadcasts the corrected username.
        let metadata_username: Option<&str> = auth_user
            .user_metadata
            .as_ref()
            .and_then(|m: &serde_json::Value| m.get("username"))
            .and_then(serde_json::Value::as_str);
        let existing = state
            .profile_service()
            .remediate_bypassed_username(existing, metadata_username)
            .await?;

        // WHY: The DB trigger handle_new_user() creates the profile before
        // sync_profile runs, so new users always land here. Check membership
        // and auto-join if needed — the membership check avoids duplicate
        // system messages on subsequent logins.
        if let Some(official_server_id) = state.official_server_id() {
            let is_member = state
                .member_repository()
                .is_member(official_server_id, &user_id)
                .await
                .unwrap_or(false);
            if !is_member {
                auto_join_official_server(&state, official_server_id, &user_id).await;
            }
        }
        return Ok((StatusCode::OK, Json(ProfileResponse::from(existing))));
    }

    // Extract username from JWT metadata. Format validation happens here because
    // the JWT shape is an HTTP concern; all policy decisions live in the service.
    let username_from_meta: Option<String> = auth_user
        .user_metadata
        .as_ref()
        .and_then(|m: &serde_json::Value| m.get("username"))
        .and_then(serde_json::Value::as_str)
        .map(String::from);

    // Optional display name from signup metadata. Extracted like the username;
    // all validation (fail-soft — never blocks signup) lives in the service.
    let display_name_from_meta: Option<String> = auth_user
        .user_metadata
        .as_ref()
        .and_then(|m: &serde_json::Value| m.get("display_name"))
        .and_then(serde_json::Value::as_str)
        .map(String::from);

    let (username, is_user_chosen) = if let Some(ref meta_username) = username_from_meta {
        if !is_valid_username(meta_username) {
            tracing::warn!(
                meta_username = %meta_username,
                "user_metadata.username failed format validation, falling back to email-derived"
            );
            (derive_username_from_email(&email), false)
        } else {
            (meta_username.clone(), true)
        }
    } else {
        (derive_username_from_email(&email), false)
    };

    let profile = state
        .profile_service()
        .upsert_from_auth(
            user_id.clone(),
            email,
            username,
            is_user_chosen,
            display_name_from_meta,
        )
        .await?;

    // WHY: Auto-join the official server for new users. Membership creation
    // and event emission are co-located here (SSoT) — no DB trigger involved.
    // Skipped when OFFICIAL_SERVER_ID is unset (self-hosted instances).
    if let Some(official_server_id) = state.official_server_id() {
        auto_join_official_server(&state, official_server_id, &user_id).await;
    }

    Ok((StatusCode::OK, Json(ProfileResponse::from(profile))))
}

/// Best-effort auto-join for the official server.
///
/// Owns the full flow: membership INSERT + system message + SSE event.
/// Replaces the former DB trigger `trg_auto_join_official_server`.
///
/// All failures are logged and swallowed — auto-join must never fail signup.
async fn auto_join_official_server(
    state: &AppState,
    official_server_id: &crate::domain::models::ServerId,
    user_id: &crate::domain::models::UserId,
) {
    // 1. Insert membership (idempotent — ON CONFLICT DO NOTHING).
    match state
        .member_repository()
        .add_member(official_server_id, user_id)
        .await
    {
        Ok(()) => {}
        // WHY: A banned user is deliberately NOT auto-joined — the expected
        // outcome, not a failure. Skip the join announcement + SSE and return
        // quietly (a warn here would fire on every login of a banned user).
        Err(DomainError::Forbidden(_)) => {
            tracing::debug!(
                server_id = %official_server_id,
                user_id = %user_id,
                "Skipping auto-join for banned user"
            );
            return;
        }
        Err(e) => {
            tracing::warn!(
                server_id = %official_server_id,
                user_id = %user_id,
                error = ?e,
                "Failed to auto-join official server (best-effort)"
            );
            return;
        }
    }

    // 2. System message in default channel (best-effort).
    if let Err(e) =
        super::post_system_message(state, official_server_id, user_id, "member_join").await
    {
        tracing::warn!(
            server_id = %official_server_id,
            user_id = %user_id,
            error = ?e,
            "Failed to post auto-join announcement (best-effort)"
        );
    }

    // 3. MemberJoined SSE event (best-effort).
    match state
        .member_repository()
        .get_member(official_server_id, user_id)
        .await
    {
        Ok(Some(member)) => {
            let event = ServerEvent::MemberJoined {
                sender_id: user_id.clone(),
                server_id: official_server_id.clone(),
                member: MemberPayload {
                    user_id: member.user_id,
                    username: member.username,
                    avatar_url: member.avatar_url,
                    nickname: member.nickname,
                    role: member.role,
                    joined_at: member.joined_at,
                },
            };
            state.event_bus().publish(event);
            tracing::info!(
                server_id = %official_server_id,
                user_id = %user_id,
                "Auto-joined official server for new user"
            );
        }
        Ok(None) => {
            tracing::warn!(
                server_id = %official_server_id,
                user_id = %user_id,
                "Member not found after auto-join INSERT — skipping MemberJoined event"
            );
        }
        Err(e) => {
            tracing::warn!(
                server_id = %official_server_id,
                user_id = %user_id,
                error = ?e,
                "Failed to fetch member for MemberJoined event"
            );
        }
    }
}

/// Get the authenticated user's own profile.
///
/// # Errors
/// Returns `ApiError` if the profile is not found or a repository error occurs.
#[utoipa::path(
    get,
    path = "/v1/profiles/me",
    tag = "Profiles",
    security(("bearer_auth" = [])),
    responses(
        (status = 200, description = "Profile found", body = ProfileResponse),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 404, description = "Profile not found", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn get_my_profile(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, ApiError> {
    let profile = state.profile_service().get_by_id(&user_id).await?;

    Ok((StatusCode::OK, Json(ProfileResponse::from(profile))))
}

/// Update the authenticated user's profile fields (avatar, display name, custom status).
///
/// Patch semantics: omitted fields remain unchanged; an explicit `null` clears
/// the field (e.g. `{"avatarUrl": null}` removes the avatar).
///
/// # Errors
/// Returns `ApiError` on validation failure or repository error.
#[utoipa::path(
    patch,
    path = "/v1/profiles/me",
    tag = "Profiles",
    security(("bearer_auth" = [])),
    request_body = UpdateProfileRequest,
    responses(
        (status = 200, description = "Profile updated", body = ProfileResponse),
        (status = 400, description = "Validation error", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state, req))]
pub async fn update_my_profile(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiJson(req): ApiJson<UpdateProfileRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let profile = state
        .profile_service()
        .update_profile(
            &user_id,
            req.avatar_url,
            req.display_name,
            req.custom_status,
        )
        .await?;

    // WHY: Routing metadata so the SSE layer delivers this only to users
    // sharing a server or DM with the subject (redacted before it reaches
    // clients). Queried here because the handler, unlike the SSE stream, has no
    // live membership snapshot.
    // WHY not `?`: the profile is already persisted — failing the request here
    // would leave the DB updated but the event unpublished (ADR-027: never
    // silently lose the signal). On lookup failure the event still goes out
    // with an EMPTY scope, which the SSE layer fails CLOSED to the subject's
    // own tabs/devices (F8) — never a broadcast of the semi-public profile to
    // strangers. Other members catch up on their next fetch.
    let server_ids = match state.server_service().list_all_memberships(&user_id).await {
        Ok(ids) => ids,
        Err(e) => {
            tracing::warn!(
                error = %e,
                "profile update: membership lookup failed — delivering profile event to self only"
            );
            Vec::new()
        }
    };

    // WHY: The event carries the NEW current values (a full snapshot) so every
    // observer rehydrates the subject's identity everywhere it is cached.
    state.event_bus().publish(ServerEvent::ProfileUpdated {
        sender_id: user_id.clone(),
        user_id,
        display_name: profile.display_name.clone(),
        avatar_url: profile.avatar_url.clone(),
        custom_status: profile.custom_status.clone(),
        server_ids,
    });

    Ok((StatusCode::OK, Json(ProfileResponse::from(profile))))
}

/// Check whether a username is available for registration.
///
/// Public endpoint (no auth required) — used during signup to give instant feedback.
/// Validates format, checks reserved list, content filter, and queries the database.
///
/// # Errors
/// Returns `ApiError` on database failure.
#[utoipa::path(
    get,
    path = "/v1/auth/check-username",
    tag = "Auth",
    params(CheckUsernameQuery),
    responses(
        (status = 200, description = "Availability check result", body = CheckUsernameResponse),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn check_username(
    State(state): State<AppState>,
    Query(query): Query<CheckUsernameQuery>,
) -> Result<impl IntoResponse, ApiError> {
    // WHY: Fast-reject invalid format and reserved names without hitting the DB.
    // From<bool> treats the bool as is_taken, so `true` → available: false.
    if !is_valid_username(&query.username) || ProfileService::is_username_reserved(&query.username)
    {
        return Ok(Json(CheckUsernameResponse::from(true)));
    }

    // WHY: Reject offensive usernames before hitting the DB. Treats "banned" the
    // same as "taken" from the client's perspective — the frontend shows "unavailable".
    if state
        .profile_service()
        .validate_username_content(&query.username)
        .is_err()
    {
        return Ok(Json(CheckUsernameResponse::from(true)));
    }

    let taken = state
        .profile_service()
        .is_username_taken(&query.username)
        .await?;

    Ok(Json(CheckUsernameResponse::from(taken)))
}

/// Validate username format: `^[a-z0-9_]{3,32}$` without pulling in the `regex` crate.
fn is_valid_username(s: &str) -> bool {
    let len = s.len();
    (3..=32).contains(&len)
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/// Derive a DB-safe username from an email prefix.
///
/// Sanitizes to match the DB constraint `^[a-z0-9_]{3,32}$`:
/// non-alphanumeric chars become underscores, min-padded to 3 chars.
fn derive_username_from_email(email: &str) -> String {
    let raw_prefix = email.split('@').next().unwrap_or("user");
    let sanitized: String = raw_prefix
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(32)
        .collect();
    if sanitized.len() < 3 {
        format!("{sanitized}{}", "_".repeat(3 - sanitized.len()))
    } else {
        sanitized
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn valid_usernames_accepted() {
        assert!(is_valid_username("abc"));
        assert!(is_valid_username("user_123"));
        assert!(is_valid_username("a".repeat(32).as_str()));
    }

    #[test]
    fn invalid_usernames_rejected() {
        // Too short
        assert!(!is_valid_username("ab"));
        // Too long
        assert!(!is_valid_username(&"a".repeat(33)));
        // Uppercase
        assert!(!is_valid_username("Abc"));
        // Special chars
        assert!(!is_valid_username("user@name"));
        // Empty
        assert!(!is_valid_username(""));
    }

    #[test]
    fn derive_username_sanitizes_email() {
        assert_eq!(
            derive_username_from_email("John.Doe@example.com"),
            "john_doe"
        );
        assert_eq!(derive_username_from_email("ab@x.com"), "ab_");
        assert_eq!(derive_username_from_email("a@x.com"), "a__");
    }
}
