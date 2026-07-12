#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Notifications-system backend integration tests (T1.2) — real DB + real HTTP
//! (tower oneshot).
//!
//! Pins:
//! 1. PREFERENCES FIELDS: `GET /v1/preferences` returns the five new
//!    notification switches (defaults all `true`); `PATCH` flips exactly the
//!    named field (`COALESCE` keeps untouched columns); unknown fields → 400;
//!    missing bearer → 401.
//! 2. BULK OVERRIDES: `GET /v1/notification-settings` returns the ADR-036
//!    envelope with ONLY the caller's rows, ordered `updated_at DESC`,
//!    `nextCursor: null`; level round-trips for all three levels.
//! 3. PATCH AUTHZ GATE: `/v1/channels/{id}/notification-settings` rejects
//!    non-members (403) and members without private-channel access (403);
//!    missing channel → 404 (regression: the handler previously had NO gate).
//!
//! WHY #[ignore]: requires a running Postgres with the Harmony schema (mirrors
//! the voice and mentions integration tests). Run locally with:
//!   `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:64322/postgres \
//!      cargo test --test notification_preferences_test -- --ignored`

use std::sync::Arc;

use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode, header},
    middleware,
    routing::get,
};
use jsonwebtoken::{Algorithm, EncodingKey, Header as JwtHeader};
use secrecy::SecretString;
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

use harmony_api::api::handlers::{notification_settings, user_preferences};
use harmony_api::api::middleware::auth::require_auth;
use harmony_api::api::state::AppState;
use harmony_api::domain::services::{ContentFilter, SpamGuard};
use harmony_api::infra::PgPresenceTracker;
use harmony_api::infra::pg_notify_event_bus::PgNotifyEventBus;
use harmony_api::infra::plan_always_allowed::AlwaysAllowedChecker;
use harmony_api::infra::postgres::{
    PgBanRepository, PgChannelRepository, PgDesktopAuthRepository, PgDmRepository,
    PgInviteRepository, PgKeyRepository, PgMegolmSessionRepository, PgMemberRepository,
    PgMessageRepository, PgModerationRetryRepository, PgNotificationSettingsRepository,
    PgProfileRepository, PgReactionRepository, PgReadStateRepository, PgServerRepository,
    PgUserPreferencesRepository,
};

// ── Test constants ──────────────────────────────────────────────────────
const TEST_JWT_SECRET: &str = "test-jwt-secret-for-integration-tests-only-32ch";

// ── Crypto provider (see voice_endpoint_test.rs WHY) ────────────────────

fn install_crypto_provider() {
    let _ = jsonwebtoken::crypto::aws_lc::DEFAULT_PROVIDER.install_default();
}

// ── JWT helper ──────────────────────────────────────────────────────────

fn sign_test_jwt(user_id: Uuid) -> String {
    install_crypto_provider();
    let now = chrono::Utc::now().timestamp();
    let claims = serde_json::json!({
        "sub": user_id.to_string(),
        "aud": "authenticated",
        "role": "authenticated",
        "email": "notification-prefs-test@example.com",
        "iat": now,
        "exp": now + 3600,
        "user_metadata": { "email_verified": true },
    });
    let header = JwtHeader::new(Algorithm::HS256);
    let key = EncodingKey::from_secret(TEST_JWT_SECRET.as_bytes());
    jsonwebtoken::encode(&header, &claims, &key).expect("JWT encoding should succeed")
}

// ── DB pool ─────────────────────────────────────────────────────────────

async fn test_pool() -> PgPool {
    dotenvy::dotenv().ok();
    let url =
        std::env::var("DATABASE_URL").expect("DATABASE_URL must be set for integration tests");
    PgPool::connect(&url)
        .await
        .expect("Failed to connect to test database")
}

// ── App state builder (mirrors mentions_polish_test.rs) ─────────────────

async fn build_app_state(pool: PgPool) -> AppState {
    let profile_repo: Arc<dyn harmony_api::domain::ports::ProfileRepository> =
        Arc::new(PgProfileRepository::new(pool.clone()));
    let server_repo = Arc::new(PgServerRepository::new(pool.clone()));
    let channel_repo = Arc::new(PgChannelRepository::new(pool.clone()));
    let member_repo = Arc::new(PgMemberRepository::new(pool.clone()));
    let message_repo = Arc::new(PgMessageRepository::new(pool.clone()));
    let invite_repo = Arc::new(PgInviteRepository::new(pool.clone()));
    let ban_repo = Arc::new(PgBanRepository::new(pool.clone()));
    let dm_repo = Arc::new(PgDmRepository::new(pool.clone()));
    let key_repo = Arc::new(PgKeyRepository::new(pool.clone()));
    let reaction_repo: Arc<dyn harmony_api::domain::ports::ReactionRepository> =
        Arc::new(PgReactionRepository::new(pool.clone()));
    let attachment_repo: Arc<dyn harmony_api::domain::ports::AttachmentRepository> = Arc::new(
        harmony_api::infra::postgres::PgAttachmentRepository::new(pool.clone()),
    );
    let read_state_repo = Arc::new(PgReadStateRepository::new(pool.clone()));
    let megolm_repo = Arc::new(PgMegolmSessionRepository::new(pool.clone()));
    let desktop_auth_repo = Arc::new(PgDesktopAuthRepository::new(pool.clone()));
    let notification_settings_repo = Arc::new(PgNotificationSettingsRepository::new(pool.clone()));
    let user_preferences_repo = Arc::new(PgUserPreferencesRepository::new(pool.clone()));
    let moderation_retry_repo = Arc::new(PgModerationRetryRepository::new(pool.clone()));
    let plan_checker: Arc<dyn harmony_api::domain::ports::PlanLimitChecker> =
        Arc::new(AlwaysAllowedChecker);
    let content_filter = Arc::new(ContentFilter::new());
    let profile_service = Arc::new(harmony_api::domain::services::ProfileService::new(
        profile_repo.clone(),
        content_filter.clone(),
        false,
    ));
    let spam_guard = Arc::new(SpamGuard::new());
    let server_service = Arc::new(harmony_api::domain::services::ServerService::new(
        server_repo.clone(),
        plan_checker.clone(),
        content_filter.clone(),
    ));
    let friendship_repo = Arc::new(harmony_api::infra::postgres::PgFriendshipRepository::new(
        pool.clone(),
    ));
    let message_service = Arc::new(harmony_api::domain::services::MessageService::new(
        message_repo.clone(),
        channel_repo.clone(),
        member_repo.clone(),
        plan_checker.clone(),
        reaction_repo.clone(),
        attachment_repo.clone(),
        Arc::new(harmony_api::infra::postgres::PgEmbedRepository::new(
            pool.clone(),
        )),
        content_filter.clone(),
        spam_guard.clone(),
        friendship_repo.clone(),
    ));
    let invite_service = Arc::new(harmony_api::domain::services::InviteService::new(
        invite_repo,
        member_repo.clone(),
        ban_repo.clone(),
        server_repo.clone(),
        plan_checker.clone(),
    ));
    let channel_service = Arc::new(harmony_api::domain::services::ChannelService::new(
        channel_repo.clone(),
        server_repo.clone(),
        plan_checker.clone(),
        content_filter,
    ));
    let moderation_service = Arc::new(harmony_api::domain::services::ModerationService::new(
        server_repo.clone(),
        ban_repo.clone(),
        member_repo.clone(),
        channel_repo.clone(),
        message_repo.clone(),
        Arc::new(harmony_api::infra::postgres::PgModerationLogRepository::new(pool.clone())),
        Arc::new(harmony_api::infra::postgres::PgReportRepository::new(
            pool.clone(),
        )),
        spam_guard.clone(),
    ));
    let friendship_service = Arc::new(harmony_api::domain::services::FriendshipService::new(
        friendship_repo.clone(),
        profile_repo.clone(),
        spam_guard.clone(),
    ));
    let dm_service = Arc::new(harmony_api::domain::services::DmService::new(
        dm_repo,
        profile_repo.clone(),
        server_repo.clone(),
        member_repo.clone(),
        plan_checker.clone(),
        friendship_repo.clone(),
    ));
    let key_service = Arc::new(harmony_api::domain::services::KeyService::new(key_repo));
    let reaction_service = Arc::new(harmony_api::domain::services::ReactionService::new(
        reaction_repo,
        channel_repo.clone(),
        member_repo.clone(),
        message_repo.clone(),
        spam_guard.clone(),
    ));
    let read_state_service = Arc::new(harmony_api::domain::services::ReadStateService::new(
        read_state_repo,
        channel_repo.clone(),
        member_repo.clone(),
    ));
    let notification_settings_service = Arc::new(
        harmony_api::domain::services::NotificationSettingsService::new(
            notification_settings_repo,
            channel_repo.clone(),
            member_repo.clone(),
        ),
    );
    let user_preferences_service = Arc::new(
        harmony_api::domain::services::UserPreferencesService::new(user_preferences_repo),
    );

    let instance_id = uuid::Uuid::new_v4();
    let (event_bus_inner, _event_notify_rx) = PgNotifyEventBus::new(instance_id);
    let event_bus: Arc<dyn harmony_api::domain::ports::EventBus> = Arc::new(event_bus_inner);
    let (presence_inner, _presence_write_rx) = PgPresenceTracker::new(instance_id, pool.clone());
    let presence_tracker = Arc::new(presence_inner);

    let analytics_recorder: Arc<dyn harmony_api::domain::ports::AnalyticsRecorder> = Arc::new(
        harmony_api::infra::postgres::PgAnalyticsRecorder::new(pool.clone()),
    );

    let attachment_repo_for_scan: std::sync::Arc<
        dyn harmony_api::domain::ports::AttachmentRepository,
    > = std::sync::Arc::new(harmony_api::infra::postgres::PgAttachmentRepository::new(
        pool.clone(),
    ));
    let attachment_scan_retry_repo = std::sync::Arc::new(
        harmony_api::infra::postgres::PgAttachmentScanRetryRepository::new(pool.clone()),
    );
    AppState::new(
        pool,
        SecretString::from(TEST_JWT_SECRET.to_string()),
        None,
        false,
        profile_service,
        server_service,
        message_service,
        invite_service,
        channel_service,
        moderation_service,
        dm_service,
        friendship_service,
        key_service,
        reaction_service,
        read_state_service,
        notification_settings_service,
        user_preferences_service,
        member_repo,
        channel_repo,
        ban_repo,
        plan_checker,
        event_bus,
        presence_tracker,
        megolm_repo,
        desktop_auth_repo,
        spam_guard,
        None, // content_moderator
        None, // safe_browsing
        None, // klipy
        message_repo,
        server_repo,
        moderation_retry_repo,
        std::sync::Arc::new(harmony_api::infra::NoopImageClassifier),
        std::sync::Arc::new(harmony_api::infra::NoopCsamMatcher),
        attachment_repo_for_scan,
        attachment_scan_retry_repo,
        false, // attachments_require_csam_scan
        None,  // voice_service
        None,  // voice_session_repository
        None,  // official_server_id
        analytics_recorder,
        Some("https://test.supabase.co".to_string()), // attachment_url_origin
        None,
    )
}

// ── Router builder (mirrors the production routes under test) ───────────

fn test_router(state: AppState) -> Router {
    let authenticated = Router::new()
        .route(
            "/v1/preferences",
            get(user_preferences::get_preferences).patch(user_preferences::update_preferences),
        )
        .route(
            "/v1/notification-settings",
            get(notification_settings::list_notification_settings),
        )
        .route(
            "/v1/channels/{id}/notification-settings",
            get(notification_settings::get_notification_settings)
                .patch(notification_settings::update_notification_settings),
        )
        .route_layer(middleware::from_fn_with_state(state.clone(), require_auth));

    Router::new().merge(authenticated).with_state(state)
}

// ── Seeding ──────────────────────────────────────────────────────────────

async fn seed_user(pool: &PgPool) -> Uuid {
    let uid = Uuid::new_v4();
    sqlx::query(
        r#"
        INSERT INTO auth.users (id, instance_id, role, aud, email, encrypted_password, email_confirmed_at, created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change)
        VALUES ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '', now(), now(), now(), '', '', '', '')
        ON CONFLICT (id) DO NOTHING
        "#,
    )
    .bind(uid)
    .bind(format!("ntp-{uid}@example.com"))
    .execute(pool)
    .await
    .expect("seed auth.users");

    let username = format!("np{}", &uid.simple().to_string()[..10]);
    sqlx::query("INSERT INTO profiles (id, username, display_name) VALUES ($1, $2, 'Notif Tester') ON CONFLICT (id) DO NOTHING")
        .bind(uid)
        .bind(username)
        .execute(pool)
        .await
        .expect("seed profiles");

    uid
}

struct Fixture {
    owner: Uuid,
    member: Uuid,
    outsider: Uuid,
    server: Uuid,
    public_channel: Uuid,
    private_channel: Uuid,
}

async fn seed_fixture(pool: &PgPool) -> Fixture {
    let owner = seed_user(pool).await;
    let member = seed_user(pool).await;
    let outsider = seed_user(pool).await;

    let server = Uuid::new_v4();
    sqlx::query("INSERT INTO servers (id, name, owner_id) VALUES ($1, 'Notif Test Server', $2)")
        .bind(server)
        .bind(owner)
        .execute(pool)
        .await
        .expect("seed server");

    for (user, role) in [(owner, "owner"), (member, "member")] {
        sqlx::query("INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, $3)")
            .bind(server)
            .bind(user)
            .bind(role)
            .execute(pool)
            .await
            .expect("seed server_members");
    }

    let public_channel = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channels (id, server_id, name, channel_type, position) VALUES ($1, $2, 'general', 'text'::channel_type, 0)",
    )
    .bind(public_channel)
    .bind(server)
    .execute(pool)
    .await
    .expect("seed public channel");

    let private_channel = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channels (id, server_id, name, channel_type, position, is_private) VALUES ($1, $2, 'secret', 'text'::channel_type, 1, true)",
    )
    .bind(private_channel)
    .bind(server)
    .execute(pool)
    .await
    .expect("seed private channel");

    Fixture {
        owner,
        member,
        outsider,
        server,
        public_channel,
        private_channel,
    }
}

async fn cleanup_fixture(pool: &PgPool, f: &Fixture) {
    let _ = sqlx::query("DELETE FROM servers WHERE id = $1")
        .bind(f.server)
        .execute(pool)
        .await;
    let _ = sqlx::query("DELETE FROM auth.users WHERE id = ANY($1)")
        .bind(vec![f.owner, f.member, f.outsider])
        .execute(pool)
        .await;
}

// ── HTTP helpers ────────────────────────────────────────────────────────

async fn body_json(response: axum::response::Response) -> serde_json::Value {
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("read response body");
    serde_json::from_slice(&bytes).expect("parse response body as JSON")
}

async fn get_json(app: &Router, uri: &str, jwt: &str) -> (StatusCode, serde_json::Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(uri)
                .header(header::AUTHORIZATION, format!("Bearer {jwt}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let json = if status == StatusCode::NO_CONTENT {
        serde_json::Value::Null
    } else {
        body_json(response).await
    };
    (status, json)
}

async fn patch_status(app: &Router, uri: &str, jwt: &str, body: serde_json::Value) -> StatusCode {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(uri)
                .header(header::AUTHORIZATION, format!("Bearer {jwt}"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    response.status()
}

// ── Tests: preferences endpoints ────────────────────────────────────────

/// A fresh user's GET synthesizes defaults: the five notification switches
/// all `true`, DND `false`.
#[tokio::test]
#[ignore]
async fn get_preferences_returns_notification_defaults() {
    let pool = test_pool().await;
    let app = test_router(build_app_state(pool.clone()).await);
    let f = seed_fixture(&pool).await;
    let jwt = sign_test_jwt(f.member);

    let (status, json) = get_json(&app, "/v1/preferences", &jwt).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["dndEnabled"], false);
    assert_eq!(json["notificationsEnabled"], true);
    assert_eq!(json["notifyMessages"], true);
    assert_eq!(json["notifyDms"], true);
    assert_eq!(json["notifyMentions"], true);
    assert_eq!(json["notificationSoundsEnabled"], true);

    cleanup_fixture(&pool, &f).await;
}

/// Patching one switch flips ONLY that switch (`COALESCE` keeps the rest),
/// across two sequential single-field patches.
#[tokio::test]
#[ignore]
async fn patch_single_field_flips_only_that_field() {
    let pool = test_pool().await;
    let app = test_router(build_app_state(pool.clone()).await);
    let f = seed_fixture(&pool).await;
    let jwt = sign_test_jwt(f.member);

    let status = patch_status(
        &app,
        "/v1/preferences",
        &jwt,
        serde_json::json!({ "notifyDms": false }),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (_, json) = get_json(&app, "/v1/preferences", &jwt).await;
    assert_eq!(json["notifyDms"], false);
    assert_eq!(json["notifyMessages"], true);
    assert_eq!(json["notificationsEnabled"], true);
    assert_eq!(json["notificationSoundsEnabled"], true);

    // Second patch must not resurrect the first field.
    let status = patch_status(
        &app,
        "/v1/preferences",
        &jwt,
        serde_json::json!({ "notificationSoundsEnabled": false }),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (_, json) = get_json(&app, "/v1/preferences", &jwt).await;
    assert_eq!(json["notifyDms"], false, "COALESCE must keep prior patch");
    assert_eq!(json["notificationSoundsEnabled"], false);
    assert_eq!(json["notifyMentions"], true);

    cleanup_fixture(&pool, &f).await;
}

/// `deny_unknown_fields` rejects unknown keys (ADR-026). WHY 422: `ApiJson`
/// preserves Axum semantics — 400 syntax, 422 data (extractors.rs:46), and an
/// unknown field is a data error.
#[tokio::test]
#[ignore]
async fn patch_unknown_field_is_rejected() {
    let pool = test_pool().await;
    let app = test_router(build_app_state(pool.clone()).await);
    let f = seed_fixture(&pool).await;
    let jwt = sign_test_jwt(f.member);

    let status = patch_status(
        &app,
        "/v1/preferences",
        &jwt,
        serde_json::json!({ "notifyEverything": true }),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

    cleanup_fixture(&pool, &f).await;
}

/// Both preference endpoints and the bulk list require a bearer token.
#[tokio::test]
#[ignore]
async fn endpoints_require_auth() {
    let pool = test_pool().await;
    let app = test_router(build_app_state(pool.clone()).await);

    for uri in ["/v1/preferences", "/v1/notification-settings"] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(uri)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{uri}");
    }
}

// ── Tests: bulk overrides list ──────────────────────────────────────────

/// The bulk list returns the ADR-036 envelope with ONLY the caller's rows
/// (another user's overrides are invisible — API-layer equivalent of the
/// own-row RLS policy), ordered `updated_at DESC`, and round-trips all
/// three levels.
#[tokio::test]
#[ignore]
async fn bulk_list_returns_only_own_rows_ordered_desc() {
    let pool = test_pool().await;
    let app = test_router(build_app_state(pool.clone()).await);
    let f = seed_fixture(&pool).await;
    let owner_jwt = sign_test_jwt(f.owner);
    let member_jwt = sign_test_jwt(f.member);

    // Owner overrides BOTH channels; member overrides one.
    assert_eq!(
        patch_status(
            &app,
            &format!("/v1/channels/{}/notification-settings", f.public_channel),
            &owner_jwt,
            serde_json::json!({ "level": "none" }),
        )
        .await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        patch_status(
            &app,
            &format!("/v1/channels/{}/notification-settings", f.private_channel),
            &owner_jwt,
            serde_json::json!({ "level": "mentions" }),
        )
        .await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        patch_status(
            &app,
            &format!("/v1/channels/{}/notification-settings", f.public_channel),
            &member_jwt,
            serde_json::json!({ "level": "all" }),
        )
        .await,
        StatusCode::NO_CONTENT
    );

    // WHY explicit timestamps: both owner upserts landed within the same
    // millisecond — pin distinct updated_at values so DESC order is
    // deterministic (private_channel is the stalest).
    sqlx::query(
        "UPDATE channel_notification_settings SET updated_at = now() - interval '1 hour' WHERE user_id = $1 AND channel_id = $2",
    )
    .bind(f.owner)
    .bind(f.private_channel)
    .execute(&pool)
    .await
    .expect("age private row");

    let (status, json) = get_json(&app, "/v1/notification-settings", &owner_jwt).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["total"], 2);
    assert_eq!(json["nextCursor"], serde_json::Value::Null);
    let items = json["items"].as_array().expect("items array");
    assert_eq!(items.len(), 2);
    // Newest-updated first.
    assert_eq!(items[0]["channelId"], f.public_channel.to_string());
    assert_eq!(items[0]["level"], "none");
    assert_eq!(items[1]["channelId"], f.private_channel.to_string());
    assert_eq!(items[1]["level"], "mentions");

    // Member sees ONLY their own row.
    let (_, json) = get_json(&app, "/v1/notification-settings", &member_jwt).await;
    assert_eq!(json["total"], 1);
    assert_eq!(json["items"][0]["channelId"], f.public_channel.to_string());
    assert_eq!(json["items"][0]["level"], "all");

    cleanup_fixture(&pool, &f).await;
}

// ── Tests: PATCH authz gate ─────────────────────────────────────────────

/// Non-members and members without private-channel access are rejected with
/// 403; a missing channel is 404. Regression: the handler previously
/// accepted ANY authed user + ANY existing channel UUID.
#[tokio::test]
#[ignore]
async fn patch_notification_settings_enforces_channel_access() {
    let pool = test_pool().await;
    let app = test_router(build_app_state(pool.clone()).await);
    let f = seed_fixture(&pool).await;
    let owner_jwt = sign_test_jwt(f.owner);
    let member_jwt = sign_test_jwt(f.member);
    let outsider_jwt = sign_test_jwt(f.outsider);
    let body = serde_json::json!({ "level": "none" });

    // Non-member → 403 on a public channel.
    assert_eq!(
        patch_status(
            &app,
            &format!("/v1/channels/{}/notification-settings", f.public_channel),
            &outsider_jwt,
            body.clone(),
        )
        .await,
        StatusCode::FORBIDDEN
    );

    // Plain member without a grant → 403 on a private channel.
    assert_eq!(
        patch_status(
            &app,
            &format!("/v1/channels/{}/notification-settings", f.private_channel),
            &member_jwt,
            body.clone(),
        )
        .await,
        StatusCode::FORBIDDEN
    );

    // Owner → 204 on the private channel; member → 204 on the public one.
    assert_eq!(
        patch_status(
            &app,
            &format!("/v1/channels/{}/notification-settings", f.private_channel),
            &owner_jwt,
            body.clone(),
        )
        .await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        patch_status(
            &app,
            &format!("/v1/channels/{}/notification-settings", f.public_channel),
            &member_jwt,
            body.clone(),
        )
        .await,
        StatusCode::NO_CONTENT
    );

    // Nonexistent channel → 404.
    assert_eq!(
        patch_status(
            &app,
            &format!("/v1/channels/{}/notification-settings", Uuid::new_v4()),
            &member_jwt,
            body,
        )
        .await,
        StatusCode::NOT_FOUND
    );

    cleanup_fixture(&pool, &f).await;
}
