#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Official-badge admin endpoint integration tests — the authorization surface
//! (real DB + real HTTP via `tower::ServiceExt::oneshot`).
//!
//! WHY this file exists separately from `official_badge_test.rs`: that file pins
//! the repo/RLS layer (SQL + service-role writes). The security-critical logic of
//! the grant/revoke admin action lives in the HTTP handler — `require_platform_owner`
//! (owner-only gate) and `resolve_subject` (exactly-one-of `userId`/`username`,
//! plus 404-on-missing). Neither is reachable below the handler, so this harness
//! drives the real endpoints to pin them:
//!
//! 1. NON-OWNER caller           → 403 (no privilege escalation / self-grant)
//! 2. BOTH `userId` + `username` → 400 (mutual exclusion)
//! 3. NEITHER field              → 400 (subject required)
//! 4. UNKNOWN subject            → 404
//! 5. OWNER, valid subject       → 204 (happy path, badge actually lands)
//! 6. NO auth                    → 401
//!
//! WHY #[ignore]: requires a running Postgres (local Supabase). CI sets
//! `DATABASE_URL` to a dummy value so `cargo test --all-targets` would panic on
//! connect. Run locally with:
//!   `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:64322/postgres \
//!      cargo test --test official_badge_endpoint_test -- --ignored`

use std::sync::Arc;

use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode, header},
    middleware,
    routing::post,
};
use jsonwebtoken::{Algorithm, EncodingKey, Header as JwtHeader};
use secrecy::SecretString;
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

use harmony_api::api::handlers::badges;
use harmony_api::api::middleware::auth::require_auth;
use harmony_api::api::state::AppState;
use harmony_api::domain::models::ServerId;

// ── Test constants ──────────────────────────────────────────────────────
const TEST_JWT_SECRET: &str = "test-jwt-secret-for-integration-tests-only-32ch";
const OFFICIAL: &str = "official";

// ── Crypto provider (see voice_endpoint_test for the WHY) ────────────────

fn install_crypto_provider() {
    let _ = jsonwebtoken::crypto::aws_lc::DEFAULT_PROVIDER.install_default();
}

fn sign_test_jwt(user_id: Uuid) -> String {
    install_crypto_provider();
    let now = chrono::Utc::now().timestamp();
    let claims = serde_json::json!({
        "sub": user_id.to_string(),
        "aud": "authenticated",
        "role": "authenticated",
        "email": "badge-test@example.com",
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

// ── App state builder (real Postgres repos; official_server_id wired) ────

/// Build a full `AppState` with `official_server_id` configured so the owner
/// gate has a platform owner to check against.
async fn app_state(pool: PgPool, official_server_id: Option<ServerId>) -> AppState {
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
        None, // klipy
        message_repo,
        server_repo,
        moderation_retry_repo,
        None, // voice_service
        None, // voice_session_repository
        official_server_id,
        analytics_recorder,
        Some("https://test.supabase.co".to_string()),
        None,
    )
}

// ── Router (mirrors production wiring for the badge admin routes) ─────────

fn badge_router(state: AppState) -> Router {
    let authenticated = Router::new()
        .route(
            "/v1/admin/badges/official/grant",
            post(badges::grant_official_badge),
        )
        .route(
            "/v1/admin/badges/official/revoke",
            post(badges::revoke_official_badge),
        )
        .route_layer(middleware::from_fn_with_state(state.clone(), require_auth));

    Router::new().merge(authenticated).with_state(state)
}

// ── Fixtures ──────────────────────────────────────────────────────────────

/// Seed one user (`auth.users` + `profiles`) and return its id + stored handle.
async fn seed_user(pool: &PgPool) -> (Uuid, String) {
    let uid = Uuid::new_v4();

    sqlx::query(
        r#"
        INSERT INTO auth.users (id, instance_id, role, aud, email, encrypted_password, email_confirmed_at, created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change)
        VALUES ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '', now(), now(), now(), '', '', '', '')
        ON CONFLICT (id) DO NOTHING
        "#,
    )
    .bind(uid)
    .bind(format!("badge-ep-{uid}@example.com"))
    .execute(pool)
    .await
    .expect("seed auth.users");

    let username = format!("be{}", &uid.simple().to_string()[..10]);
    sqlx::query(
        "INSERT INTO profiles (id, username, display_name) VALUES ($1, $2, 'Badge EP Tester') ON CONFLICT (id) DO NOTHING",
    )
    .bind(uid)
    .bind(&username)
    .execute(pool)
    .await
    .expect("seed profiles");

    let stored: String = sqlx::query_scalar("SELECT username FROM profiles WHERE id = $1")
        .bind(uid)
        .fetch_one(pool)
        .await
        .expect("read back seeded username");

    (uid, stored)
}

/// Seed a server owned by `owner` — stands in for the official server.
async fn seed_server(pool: &PgPool, owner: Uuid) -> Uuid {
    let sid = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO servers (id, name, owner_id, is_dm, created_at, updated_at) VALUES ($1, $2, $3, false, now(), now())",
    )
    .bind(sid)
    .bind(format!("Official {}", &sid.to_string()[..8]))
    .bind(owner)
    .execute(pool)
    .await
    .expect("seed servers");
    sid
}

async fn cleanup(pool: &PgPool, users: &[Uuid], server: Uuid) {
    // auth.users delete cascades to profiles → user_badges. Server owned by the
    // owner must go before the owner row, so drop it first.
    let _ = sqlx::query("DELETE FROM servers WHERE id = $1")
        .bind(server)
        .execute(pool)
        .await;
    let _ = sqlx::query("DELETE FROM auth.users WHERE id = ANY($1)")
        .bind(users.to_vec())
        .execute(pool)
        .await;
}

async fn body_json(response: axum::response::Response) -> serde_json::Value {
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("read response body");
    serde_json::from_slice(&bytes).expect("parse response body as JSON")
}

async fn holds_official(pool: &PgPool, user: Uuid) -> bool {
    let count: i64 = sqlx::query_scalar(
        "SELECT COALESCE(COUNT(*)::BIGINT, 0) FROM user_badges WHERE user_id = $1 AND badge = $2",
    )
    .bind(user)
    .bind(OFFICIAL)
    .fetch_one(pool)
    .await
    .expect("count official badge");
    count > 0
}

// ── Tests ───────────────────────────────────────────────────────────────

/// A non-owner (authenticated, but not the platform owner) is refused — the gate
/// that stops any user self-granting the verified badge. Deleting the owner check
/// would flip this to 204.
#[tokio::test]
#[ignore = "requires local Supabase Postgres"]
async fn grant_by_non_owner_returns_403() {
    let pool = test_pool().await;
    let (owner, _) = seed_user(&pool).await;
    let (intruder, _) = seed_user(&pool).await;
    let (subject, _) = seed_user(&pool).await;
    let official = seed_server(&pool, owner).await;

    let state = app_state(pool.clone(), Some(ServerId::new(official))).await;
    let app = badge_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/admin/badges/official/grant")
                .header(
                    header::AUTHORIZATION,
                    format!("Bearer {}", sign_test_jwt(intruder)),
                )
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(format!(r#"{{"userId":"{subject}"}}"#)))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let json = body_json(response).await;
    assert_eq!(json["status"], 403);
    assert!(
        !holds_official(&pool, subject).await,
        "a forbidden grant must NOT persist the badge"
    );

    cleanup(&pool, &[owner, intruder, subject], official).await;
}

/// Owner supplies BOTH `userId` and `username` → 400 (mutual exclusion). Uses the
/// owner's token so the 403 gate cannot mask the 400.
#[tokio::test]
#[ignore = "requires local Supabase Postgres"]
async fn grant_with_both_identifiers_returns_400() {
    let pool = test_pool().await;
    let (owner, _) = seed_user(&pool).await;
    let (subject, subject_handle) = seed_user(&pool).await;
    let official = seed_server(&pool, owner).await;

    let state = app_state(pool.clone(), Some(ServerId::new(official))).await;
    let app = badge_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/admin/badges/official/grant")
                .header(
                    header::AUTHORIZATION,
                    format!("Bearer {}", sign_test_jwt(owner)),
                )
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(format!(
                    r#"{{"userId":"{subject}","username":"{subject_handle}"}}"#
                )))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let json = body_json(response).await;
    assert_eq!(json["status"], 400);
    assert!(
        !holds_official(&pool, subject).await,
        "an over-specified grant must NOT persist the badge"
    );

    cleanup(&pool, &[owner, subject], official).await;
}

/// Owner supplies NEITHER identifier → 400 (subject required).
#[tokio::test]
#[ignore = "requires local Supabase Postgres"]
async fn grant_with_no_identifier_returns_400() {
    let pool = test_pool().await;
    let (owner, _) = seed_user(&pool).await;
    let official = seed_server(&pool, owner).await;

    let state = app_state(pool.clone(), Some(ServerId::new(official))).await;
    let app = badge_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/admin/badges/official/grant")
                .header(
                    header::AUTHORIZATION,
                    format!("Bearer {}", sign_test_jwt(owner)),
                )
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let json = body_json(response).await;
    assert_eq!(json["status"], 400);

    cleanup(&pool, &[owner], official).await;
}

/// Owner names a subject that does not exist → 404.
#[tokio::test]
#[ignore = "requires local Supabase Postgres"]
async fn grant_unknown_subject_returns_404() {
    let pool = test_pool().await;
    let (owner, _) = seed_user(&pool).await;
    let official = seed_server(&pool, owner).await;
    let ghost = Uuid::new_v4();

    let state = app_state(pool.clone(), Some(ServerId::new(official))).await;
    let app = badge_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/admin/badges/official/grant")
                .header(
                    header::AUTHORIZATION,
                    format!("Bearer {}", sign_test_jwt(owner)),
                )
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(format!(r#"{{"userId":"{ghost}"}}"#)))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let json = body_json(response).await;
    assert_eq!(json["status"], 404);

    cleanup(&pool, &[owner], official).await;
}

/// Owner grants a valid subject by id → 204 and the badge actually lands. Revoke
/// then removes it. Proves the gate admits the legitimate path, not just refuses.
#[tokio::test]
#[ignore = "requires local Supabase Postgres"]
async fn owner_grant_then_revoke_roundtrip() {
    let pool = test_pool().await;
    let (owner, _) = seed_user(&pool).await;
    let (subject, _) = seed_user(&pool).await;
    let official = seed_server(&pool, owner).await;

    let state = app_state(pool.clone(), Some(ServerId::new(official))).await;

    let grant = badge_router(state.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/admin/badges/official/grant")
                .header(
                    header::AUTHORIZATION,
                    format!("Bearer {}", sign_test_jwt(owner)),
                )
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(format!(r#"{{"userId":"{subject}"}}"#)))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(grant.status(), StatusCode::NO_CONTENT);
    assert!(
        holds_official(&pool, subject).await,
        "owner grant must persist the badge"
    );

    let revoke = badge_router(state)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/admin/badges/official/revoke")
                .header(
                    header::AUTHORIZATION,
                    format!("Bearer {}", sign_test_jwt(owner)),
                )
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(format!(r#"{{"userId":"{subject}"}}"#)))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(revoke.status(), StatusCode::NO_CONTENT);
    assert!(
        !holds_official(&pool, subject).await,
        "owner revoke must remove the badge"
    );

    cleanup(&pool, &[owner, subject], official).await;
}

/// No bearer token → 401 (auth middleware short-circuits before the handler).
#[tokio::test]
#[ignore = "requires local Supabase Postgres"]
async fn grant_without_auth_returns_401() {
    let pool = test_pool().await;
    let (owner, _) = seed_user(&pool).await;
    let official = seed_server(&pool, owner).await;

    let state = app_state(pool.clone(), Some(ServerId::new(official))).await;
    let app = badge_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/admin/badges/official/grant")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    r#"{"userId":"00000000-0000-0000-0000-000000000000"}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let json = body_json(response).await;
    assert_eq!(json["status"], 401);

    cleanup(&pool, &[owner], official).await;
}
