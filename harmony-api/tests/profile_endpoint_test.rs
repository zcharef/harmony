#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Profile endpoint integration tests (T1.6, ticket §7.2).
//!
//! Exercises `GET /v1/profiles/{id}` through the real route wiring
//! (`get_profile_by_id` behind the `require_auth` route layer) using
//! `tower::ServiceExt::oneshot`, mirroring `voice_endpoint_test.rs`. This pins
//! the auth gate and route wiring that the service-level tests in
//! `profile_bio_banner_test.rs` cannot reach.
//!
//! The 401 test runs in CI: `require_auth` rejects the unauthenticated request
//! before any query executes, so a lazy pool never connects to Postgres. The
//! 404 and 200 tests need a real profile row and are therefore `#[ignore]`
//! (run locally with `cargo test --test profile_endpoint_test -- --ignored`).

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

use harmony_api::api::handlers::profiles;
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

// ── Crypto provider ─────────────────────────────────────────────────────

/// WHY: Both `aws_lc_rs` and `rust_crypto` features are enabled in the build.
/// When both are active, `jsonwebtoken` v10 cannot auto-detect a provider and
/// panics. We explicitly install one. `install_default` returns `Err` on
/// subsequent calls (process-wide singleton) — harmless, hence `let _ =`.
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
        "email": "profile-test@example.com",
        "iat": now,
        "exp": now + 3600,
        "user_metadata": { "email_verified": true },
    });
    let header = JwtHeader::new(Algorithm::HS256);
    let key = EncodingKey::from_secret(TEST_JWT_SECRET.as_bytes());
    jsonwebtoken::encode(&header, &claims, &key).expect("JWT encoding should succeed")
}

// ── DB pools ────────────────────────────────────────────────────────────

async fn test_pool() -> PgPool {
    dotenvy::dotenv().ok();
    let url =
        std::env::var("DATABASE_URL").expect("DATABASE_URL must be set for integration tests");
    PgPool::connect(&url)
        .await
        .expect("Failed to connect to test database")
}

/// A lazy pool that never establishes a TCP connection until a query runs.
/// WHY: the 401 path is rejected by `require_auth` before any query executes,
/// so the unauthenticated test needs no live database (mirrors the
/// `connect_lazy` pattern in `infra/pg_presence_tracker.rs` unit tests).
fn lazy_pool() -> PgPool {
    PgPool::connect_lazy("postgres://unused").expect("build lazy pool")
}

// ── App state builder (mirrors voice_endpoint_test.rs; voice disabled) ────

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

// ── Router builder (mirrors production wiring for the profile-by-id route) ─

fn profile_router(state: AppState) -> Router {
    let authenticated = Router::new()
        .route("/v1/profiles/{id}", get(profiles::get_profile_by_id))
        .route_layer(middleware::from_fn_with_state(state.clone(), require_auth));

    Router::new().merge(authenticated).with_state(state)
}

// ── Seeding ───────────────────────────────────────────────────────────────

/// Seed one user (`auth.users` + `profiles`) with a bio and banner, returning
/// its id so the 200 test can fetch it.
async fn seed_profile_with_bio_banner(pool: &PgPool) -> Uuid {
    let uid = Uuid::new_v4();

    sqlx::query(
        r#"
        INSERT INTO auth.users (id, instance_id, role, aud, email, encrypted_password, email_confirmed_at, created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change)
        VALUES ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '', now(), now(), now(), '', '', '', '')
        ON CONFLICT (id) DO NOTHING
        "#,
    )
    .bind(uid)
    .bind(format!("profile-endpoint-{uid}@example.com"))
    .execute(pool)
    .await
    .expect("seed auth.users");

    // WHY DO UPDATE: inserting into auth.users fires a Supabase trigger that
    // auto-creates the profiles row, so a plain INSERT ... DO NOTHING would
    // no-op and leave bio/banner unset. DO UPDATE guarantees both are written.
    // Username must match profiles_username_format: ^[a-z0-9_]{3,32}$
    let username = format!("pe{}", &uid.simple().to_string()[..10]);
    sqlx::query(
        r#"
        INSERT INTO profiles (id, username, display_name, bio, banner_url)
        VALUES ($1, $2, 'Profile Endpoint Tester', $3, $4)
        ON CONFLICT (id) DO UPDATE
        SET bio = EXCLUDED.bio, banner_url = EXCLUDED.banner_url
        "#,
    )
    .bind(uid)
    .bind(username)
    .bind("Building Harmony.")
    .bind("https://cdn.example.com/banner.png")
    .execute(pool)
    .await
    .expect("seed profiles");

    uid
}

async fn cleanup(pool: &PgPool, user_id: Uuid) {
    let _ = sqlx::query("DELETE FROM profiles WHERE id = $1")
        .bind(user_id)
        .execute(pool)
        .await;
    let _ = sqlx::query("DELETE FROM auth.users WHERE id = $1")
        .bind(user_id)
        .execute(pool)
        .await;
}

// ── Helper: extract response body as JSON ─────────────────────────────────

async fn body_json(response: axum::response::Response) -> serde_json::Value {
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("read response body");
    serde_json::from_slice(&bytes).expect("parse response body as JSON")
}

// ── Tests ─────────────────────────────────────────────────────────────────

/// GET /v1/profiles/{id} without a token → 401. Pins the auth gate. Runs in CI:
/// `require_auth` rejects before any query, so the lazy pool never connects.
#[tokio::test]
async fn get_profile_without_auth_returns_401() {
    let state = build_app_state(lazy_pool()).await;
    let app = profile_router(state);
    let target = Uuid::new_v4();

    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/v1/profiles/{target}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let json = body_json(response).await;
    assert_eq!(json["status"], 401);
}

/// GET /v1/profiles/{id} with a valid token but an unknown UUID → 404.
#[tokio::test]
#[ignore = "requires local Supabase Postgres"]
async fn get_profile_unknown_uuid_returns_404() {
    let pool = test_pool().await;
    let state = build_app_state(pool.clone()).await;
    let app = profile_router(state);

    // The caller need not exist in the DB — auth only verifies the JWT, and the
    // handler does not gate on the caller. The target is a random UUID with no row.
    let jwt = sign_test_jwt(Uuid::new_v4());
    let target = Uuid::new_v4();

    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/v1/profiles/{target}"))
                .header(header::AUTHORIZATION, format!("Bearer {jwt}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let json = body_json(response).await;
    assert_eq!(json["status"], 404);
}

/// GET /v1/profiles/{id} for a seeded profile → 200 with bio + bannerUrl.
#[tokio::test]
#[ignore = "requires local Supabase Postgres"]
async fn get_profile_returns_200_with_bio_and_banner() {
    let pool = test_pool().await;
    let target = seed_profile_with_bio_banner(&pool).await;
    let state = build_app_state(pool.clone()).await;
    let app = profile_router(state);

    let jwt = sign_test_jwt(Uuid::new_v4());

    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/v1/profiles/{target}"))
                .header(header::AUTHORIZATION, format!("Bearer {jwt}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["id"], target.to_string());
    assert_eq!(json["bio"], "Building Harmony.");
    assert_eq!(json["bannerUrl"], "https://cdn.example.com/banner.png");

    cleanup(&pool, target).await;
}
