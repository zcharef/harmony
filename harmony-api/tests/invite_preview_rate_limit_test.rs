#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Invite preview rate limit (HTTP layer, real DB).
//!
//! WHY: `GET /v1/invites/{code}` is UNAUTHENTICATED (invite landing page) —
//! the ticket locks it to "same limiter family as auth endpoints — unauth
//! surface, treat as hostile". These tests pin the contract:
//! 1. Per-client budget: the 21st preview within a minute from one IP → 429
//!    (Retry-After present), while a different IP keeps a fresh budget.
//! 2. The Pages Function's forwarded IP (`x-harmony-client-ip`) partitions
//!    buckets ONLY when the shared proxy secret matches.
//! 3. Without a valid secret the forwarded header is ignored — unattributed
//!    traffic shares one fail-closed bucket.
//!
//! WHY #[ignore]: requires a running Postgres with the Harmony schema
//! (mirrors `voice_endpoint_test`). Run locally with:
//!   `DATABASE_URL=... cargo test --test invite_preview_rate_limit_test -- --ignored`

use std::sync::Arc;

use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode, header},
    routing::get,
};
use secrecy::SecretString;
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

use harmony_api::api::handlers::invites;
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

/// Mirrors `INVITE_PREVIEW_RATE_MAX` / `INVITE_PREVIEW_RATE_WINDOW` in
/// `handlers/invites.rs` — the contract under test, deliberately restated so
/// a silent limit change breaks this pin.
const PREVIEW_MAX_PER_MINUTE: usize = 20;

const PROXY_SECRET: &str = "test-proxy-secret-for-invite-preview";

// ── DB pool ─────────────────────────────────────────────────────────────

async fn test_pool() -> PgPool {
    dotenvy::dotenv().ok();
    let url =
        std::env::var("DATABASE_URL").expect("DATABASE_URL must be set for integration tests");
    PgPool::connect(&url)
        .await
        .expect("Failed to connect to test database")
}

// ── App state builder (mirrors voice_endpoint_test) ─────────────────────

async fn app_state(pool: PgPool, trusted_proxy_secret: Option<SecretString>) -> AppState {
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
    ));
    // WHY enabled: this suite tests the rate limiter itself — the E2E-style
    // `SPAM_GUARD_ENABLED=false` bypass must NOT apply here.
    let spam_guard = Arc::new(SpamGuard::new());
    let server_service = Arc::new(harmony_api::domain::services::ServerService::new(
        server_repo.clone(),
        plan_checker.clone(),
        content_filter.clone(),
    ));
    let message_service = Arc::new(harmony_api::domain::services::MessageService::new(
        message_repo.clone(),
        channel_repo.clone(),
        member_repo.clone(),
        plan_checker.clone(),
        reaction_repo.clone(),
        attachment_repo.clone(),
        content_filter.clone(),
        spam_guard.clone(),
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
    ));
    let dm_service = Arc::new(harmony_api::domain::services::DmService::new(
        dm_repo,
        profile_repo.clone(),
        server_repo.clone(),
        member_repo.clone(),
        plan_checker.clone(),
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
        harmony_api::domain::services::NotificationSettingsService::new(notification_settings_repo),
    );
    let user_preferences_service = Arc::new(
        harmony_api::domain::services::UserPreferencesService::new(user_preferences_repo),
    );

    let instance_id = Uuid::new_v4();
    let (event_bus_inner, _event_notify_rx) = PgNotifyEventBus::new(instance_id);
    let event_bus: Arc<dyn harmony_api::domain::ports::EventBus> = Arc::new(event_bus_inner);
    let (presence_inner, _presence_write_rx) = PgPresenceTracker::new(instance_id, pool.clone());
    let presence_tracker = Arc::new(presence_inner);

    let analytics_recorder: Arc<dyn harmony_api::domain::ports::AnalyticsRecorder> = Arc::new(
        harmony_api::infra::postgres::PgAnalyticsRecorder::new(pool.clone()),
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
        message_repo,
        server_repo,
        moderation_retry_repo,
        None, // voice_service
        None, // voice_session_repository
        None, // official_server_id
        analytics_recorder,
        Some("https://test.supabase.co".to_string()), // attachment_url_origin
        trusted_proxy_secret,
    )
}

/// Mirrors the production public route (router.rs `public_routes`) — no auth.
fn preview_router(state: AppState) -> Router {
    Router::new()
        .route("/v1/invites/{code}", get(invites::preview_invite))
        .with_state(state)
}

// ── Seeding (mirrors invite_preview_test) ───────────────────────────────

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
    .bind(format!("inv-rate-{uid}@example.com"))
    .execute(pool)
    .await
    .expect("seed auth.users");

    let username = format!("ir{}", &uid.simple().to_string()[..10]);
    sqlx::query(
        r#"
        INSERT INTO profiles (id, username, display_name)
        VALUES ($1, $2, 'Rate Limit Tester')
        ON CONFLICT (id) DO NOTHING
        "#,
    )
    .bind(uid)
    .bind(username)
    .execute(pool)
    .await
    .expect("seed profiles");

    uid
}

async fn seed_server(pool: &PgPool, owner: Uuid) -> Uuid {
    let sid = Uuid::new_v4();
    sqlx::query("INSERT INTO servers (id, name, owner_id) VALUES ($1, $2, $3)")
        .bind(sid)
        .bind("Invite Rate Limit Server")
        .bind(owner)
        .execute(pool)
        .await
        .expect("seed server");
    sid
}

async fn seed_invite(pool: &PgPool, server: Uuid, creator: Uuid) -> String {
    let raw = Uuid::new_v4().simple().to_string();
    let code = raw[..8].to_string();
    sqlx::query(
        r#"
        INSERT INTO invites (code, server_id, creator_id, max_uses, use_count, expires_at)
        VALUES ($1, $2, $3, NULL, 0, now() + interval '1 hour')
        "#,
    )
    .bind(&code)
    .bind(server)
    .bind(creator)
    .execute(pool)
    .await
    .expect("seed invite");
    code
}

async fn cleanup(pool: &PgPool, server: Uuid, owner: Uuid) {
    for stmt in [
        "DELETE FROM server_members WHERE server_id = $1",
        "DELETE FROM invites WHERE server_id = $1",
        "DELETE FROM channels WHERE server_id = $1",
        "DELETE FROM servers WHERE id = $1",
    ] {
        let _ = sqlx::query(stmt).bind(server).execute(pool).await;
    }
    let _ = sqlx::query("DELETE FROM auth.users WHERE id = $1")
        .bind(owner)
        .execute(pool)
        .await;
}

// ── Request helper ──────────────────────────────────────────────────────

async fn preview_with_headers(
    app: &Router,
    code: &str,
    headers: &[(&str, &str)],
) -> axum::http::Response<Body> {
    let mut builder = Request::builder()
        .method("GET")
        .uri(format!("/v1/invites/{code}"));
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    app.clone()
        .oneshot(builder.body(Body::empty()).unwrap())
        .await
        .unwrap()
}

// ── Tests ───────────────────────────────────────────────────────────────

/// One client IP exhausts its budget → 429 with Retry-After; a different IP
/// keeps an independent budget (per-IP partitioning).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn preview_rate_limited_per_client_ip() {
    let pool = test_pool().await;
    let owner = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    let code = seed_invite(&pool, server, owner).await;

    let app = preview_router(app_state(pool.clone(), None).await);

    for i in 0..PREVIEW_MAX_PER_MINUTE {
        let response =
            preview_with_headers(&app, &code, &[("cf-connecting-ip", "203.0.113.7")]).await;
        assert_eq!(
            response.status(),
            StatusCode::OK,
            "request {i} within budget must succeed"
        );
    }

    let limited = preview_with_headers(&app, &code, &[("cf-connecting-ip", "203.0.113.7")]).await;
    assert_eq!(
        limited.status(),
        StatusCode::TOO_MANY_REQUESTS,
        "request over budget must be 429"
    );
    assert!(
        limited.headers().contains_key(header::RETRY_AFTER),
        "429 must carry Retry-After (RFC 9110)"
    );

    // A different client IP is NOT affected by the exhausted bucket.
    let other_ip = preview_with_headers(&app, &code, &[("cf-connecting-ip", "203.0.113.8")]).await;
    assert_eq!(
        other_ip.status(),
        StatusCode::OK,
        "a different IP keeps its own budget"
    );

    cleanup(&pool, server, owner).await;
}

/// The Pages Function's forwarded client IP partitions buckets when the
/// shared proxy secret matches — more requests than one bucket allows all
/// succeed because each forwarded IP is its own bucket.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn trusted_forwarded_ip_partitions_buckets() {
    let pool = test_pool().await;
    let owner = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    let code = seed_invite(&pool, server, owner).await;

    let state = app_state(
        pool.clone(),
        Some(SecretString::from(PROXY_SECRET.to_string())),
    )
    .await;
    let app = preview_router(state);

    for i in 0..(PREVIEW_MAX_PER_MINUTE + 5) {
        let forwarded = format!("203.0.113.{}", i + 1);
        let response = preview_with_headers(
            &app,
            &code,
            &[
                ("x-harmony-proxy-secret", PROXY_SECRET),
                ("x-harmony-client-ip", forwarded.as_str()),
            ],
        )
        .await;
        assert_eq!(
            response.status(),
            StatusCode::OK,
            "distinct forwarded IPs must not share a bucket (request {i})"
        );
    }

    cleanup(&pool, server, owner).await;
}

/// Without a valid proxy secret the forwarded header is IGNORED: all such
/// requests collapse into the shared fail-closed bucket and get limited,
/// no matter how many distinct IPs they claim to be.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn forwarded_ip_ignored_without_valid_secret() {
    let pool = test_pool().await;
    let owner = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    let code = seed_invite(&pool, server, owner).await;

    let state = app_state(
        pool.clone(),
        Some(SecretString::from(PROXY_SECRET.to_string())),
    )
    .await;
    let app = preview_router(state);

    let mut saw_429 = false;
    for i in 0..(PREVIEW_MAX_PER_MINUTE + 1) {
        let forwarded = format!("203.0.113.{}", i + 1);
        let response = preview_with_headers(
            &app,
            &code,
            &[
                ("x-harmony-proxy-secret", "wrong-secret"),
                ("x-harmony-client-ip", forwarded.as_str()),
            ],
        )
        .await;
        if response.status() == StatusCode::TOO_MANY_REQUESTS {
            saw_429 = true;
            assert!(
                i >= PREVIEW_MAX_PER_MINUTE,
                "must not limit before the shared budget is exhausted (got 429 at request {i})"
            );
        }
    }
    assert!(
        saw_429,
        "spoofed forwarded IPs with a wrong secret must collapse into one limited bucket"
    );

    cleanup(&pool, server, owner).await;
}
