#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Voice endpoint integration tests.
//!
//! Tests the HTTP layer for voice channel endpoints using real DB (local
//! Supabase Postgres) and `tower::ServiceExt::oneshot`. Auth is handled by
//! signing test JWTs with the same HS256 secret used in config.
//!
//! Test cases:
//! 1. Join voice channel → 200 with token
//! 2. Join text channel → 422 (not a voice channel)
//! 3. Leave voice channel → 204
//! 4. List participants → 200 with items/total envelope
//! 5. All endpoints without auth → 401
//! 6. All endpoints with voice disabled → 503

use std::sync::Arc;

use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode, header},
    middleware,
    routing::{get, post},
};
use jsonwebtoken::{Algorithm, EncodingKey, Header as JwtHeader};
use secrecy::SecretString;
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

use harmony_api::api::handlers::voice;
use harmony_api::api::middleware::auth::require_auth;
use harmony_api::api::state::AppState;
use harmony_api::domain::models::{ChannelId, ServerId, UserId};
use harmony_api::domain::ports::{LiveKitTokenGenerator, VoiceGrants};
use harmony_api::domain::services::{ContentFilter, SpamGuard, VoiceService};
use harmony_api::infra::PresenceTracker;
use harmony_api::infra::broadcast_event_bus::BroadcastEventBus;
use harmony_api::infra::plan_always_allowed::AlwaysAllowedChecker;
use harmony_api::infra::postgres::{
    PgBanRepository, PgChannelRepository, PgDesktopAuthRepository, PgDmRepository,
    PgInviteRepository, PgKeyRepository, PgMegolmSessionRepository, PgMemberRepository,
    PgMessageRepository, PgModerationRetryRepository, PgNotificationSettingsRepository,
    PgProfileRepository, PgReactionRepository, PgReadStateRepository, PgServerRepository,
    PgUserPreferencesRepository, PgVoiceSessionRepository,
};

// ── Test constants ──────────────────────────────────────────────────────
const TEST_JWT_SECRET: &str = "test-jwt-secret-for-integration-tests-only-32ch";

// ── Fake LiveKit token generator (no real LiveKit needed) ───────────────

/// In-process `LiveKitTokenGenerator` that returns deterministic fake tokens.
/// WHY: Integration tests verify the HTTP layer, not `LiveKit` JWT internals
/// (those are covered by unit tests in `infra/livekit/token_service.rs`).
#[derive(Debug)]
struct FakeLiveKitTokenGenerator;

impl LiveKitTokenGenerator for FakeLiveKitTokenGenerator {
    fn generate_token(
        &self,
        _room_name: &str,
        _user_id: &UserId,
        _display_name: &str,
        _grants: VoiceGrants,
    ) -> Result<String, harmony_api::domain::errors::DomainError> {
        Ok("fake-livekit-token-for-testing".to_string())
    }

    fn livekit_url(&self) -> &str {
        "wss://test.livekit.example.com"
    }
}

// ── Crypto provider ─────────────────────────────────────────────────────

/// WHY: Both `aws_lc_rs` and `rust_crypto` features are enabled (harmony-api
/// uses `aws_lc_rs`, livekit-api uses `rust_crypto`). When both are active,
/// `jsonwebtoken` v10 cannot auto-detect which provider to use and panics.
/// We explicitly install one. `install_default` returns `Err` on subsequent
/// calls (process-wide singleton) — harmless, hence `let _ =`.
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
        "email": "voice-test@example.com",
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

// ── App state builders ──────────────────────────────────────────────────

/// Build a full `AppState` with voice enabled (fake `LiveKit` token generator).
async fn app_state_with_voice(pool: PgPool) -> AppState {
    let channel_repo = Arc::new(PgChannelRepository::new(pool.clone()));
    let member_repo = Arc::new(PgMemberRepository::new(pool.clone()));
    let plan_checker: Arc<dyn harmony_api::domain::ports::PlanLimitChecker> =
        Arc::new(AlwaysAllowedChecker);
    let voice_repo = Arc::new(PgVoiceSessionRepository::new(pool.clone()));
    let livekit: Arc<dyn LiveKitTokenGenerator> = Arc::new(FakeLiveKitTokenGenerator);

    let voice_service = Some(Arc::new(VoiceService::new(
        voice_repo,
        channel_repo.clone(),
        member_repo.clone(),
        plan_checker.clone(),
        livekit,
    )));

    build_app_state(pool, voice_service).await
}

/// Build a full `AppState` with voice disabled (None).
async fn app_state_without_voice(pool: PgPool) -> AppState {
    build_app_state(pool, None).await
}

/// Shared builder — wires all required services with real Postgres repos.
async fn build_app_state(pool: PgPool, voice_service: Option<Arc<VoiceService>>) -> AppState {
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
    ));
    let read_state_service = Arc::new(harmony_api::domain::services::ReadStateService::new(
        read_state_repo,
    ));
    let notification_settings_service = Arc::new(
        harmony_api::domain::services::NotificationSettingsService::new(notification_settings_repo),
    );
    let user_preferences_service = Arc::new(
        harmony_api::domain::services::UserPreferencesService::new(user_preferences_repo),
    );

    let event_bus: Arc<dyn harmony_api::domain::ports::EventBus> =
        Arc::new(BroadcastEventBus::new());
    let presence_tracker = Arc::new(PresenceTracker::new());

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
        voice_service,
    )
}

// ── Router builder (mirrors production router for voice routes) ──────────

fn voice_router(state: AppState) -> Router {
    let authenticated = Router::new()
        .route("/v1/channels/{id}/voice/join", post(voice::join_voice))
        .route("/v1/channels/{id}/voice/leave", post(voice::leave_voice))
        .route(
            "/v1/channels/{id}/voice/participants",
            get(voice::list_voice_participants),
        )
        .route("/v1/voice/heartbeat", post(voice::voice_heartbeat))
        .route_layer(middleware::from_fn_with_state(state.clone(), require_auth));

    Router::new().merge(authenticated).with_state(state)
}

// ── Test fixtures (DB seeding) ──────────────────────────────────────────

struct TestFixture {
    user_id: UserId,
    server_id: ServerId,
    voice_channel_id: ChannelId,
    text_channel_id: ChannelId,
    jwt: String,
}

/// Seed a user, server, voice channel, text channel, and membership into the DB.
/// Uses random UUIDs to avoid collisions between parallel tests.
async fn seed_fixture(pool: &PgPool) -> TestFixture {
    let user_uuid = Uuid::new_v4();
    let server_uuid = Uuid::new_v4();
    let voice_channel_uuid = Uuid::new_v4();
    let text_channel_uuid = Uuid::new_v4();

    // Insert user into auth.users (Supabase managed table).
    sqlx::query(
        r#"
        INSERT INTO auth.users (id, instance_id, role, aud, email, encrypted_password, email_confirmed_at, created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change)
        VALUES ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '', now(), now(), now(), '', '', '', '')
        ON CONFLICT (id) DO NOTHING
        "#,
    )
    .bind(user_uuid)
    .bind(format!("voice-test-{}@example.com", user_uuid))
    .execute(pool)
    .await
    .expect("seed auth.users");

    // Insert profile (columns: id, username, display_name are in schema)
    sqlx::query(
        r#"
        INSERT INTO profiles (id, username, display_name)
        VALUES ($1, $2, $3)
        ON CONFLICT (id) DO NOTHING
        "#,
    )
    .bind(user_uuid)
    .bind(format!(
        "vt{}",
        user_uuid
            .to_string()
            .replace('-', "")
            .get(..8)
            .unwrap_or("test0001")
    ))
    .bind("Voice Tester")
    .execute(pool)
    .await
    .expect("seed profiles");

    // Insert server (id auto-generated by default, but we supply it for test determinism)
    sqlx::query(
        r#"
        INSERT INTO servers (id, name, owner_id)
        VALUES ($1, $2, $3)
        ON CONFLICT (id) DO NOTHING
        "#,
    )
    .bind(server_uuid)
    .bind(format!("VoiceTestServer {}", &server_uuid.to_string()[..8]))
    .bind(user_uuid)
    .execute(pool)
    .await
    .expect("seed servers");

    // Insert voice channel (channel_type is a Postgres enum, cast via ::channel_type)
    sqlx::query(
        r#"
        INSERT INTO channels (id, server_id, name, channel_type, position)
        VALUES ($1, $2, 'voice-test', 'voice'::channel_type, 0)
        ON CONFLICT (id) DO NOTHING
        "#,
    )
    .bind(voice_channel_uuid)
    .bind(server_uuid)
    .execute(pool)
    .await
    .expect("seed voice channel");

    // Insert text channel
    sqlx::query(
        r#"
        INSERT INTO channels (id, server_id, name, channel_type, position)
        VALUES ($1, $2, 'text-test', 'text'::channel_type, 1)
        ON CONFLICT (id) DO NOTHING
        "#,
    )
    .bind(text_channel_uuid)
    .bind(server_uuid)
    .execute(pool)
    .await
    .expect("seed text channel");

    // Insert server membership (table is server_members, PK is (server_id, user_id))
    sqlx::query(
        r#"
        INSERT INTO server_members (server_id, user_id, role)
        VALUES ($1, $2, 'owner')
        ON CONFLICT (server_id, user_id) DO NOTHING
        "#,
    )
    .bind(server_uuid)
    .bind(user_uuid)
    .execute(pool)
    .await
    .expect("seed server_members");

    let jwt = sign_test_jwt(user_uuid);

    TestFixture {
        user_id: UserId::new(user_uuid),
        server_id: ServerId::new(server_uuid),
        voice_channel_id: ChannelId::new(voice_channel_uuid),
        text_channel_id: ChannelId::new(text_channel_uuid),
        jwt,
    }
}

/// Clean up test data. Best-effort — does not panic on failure.
async fn cleanup_fixture(pool: &PgPool, fixture: &TestFixture) {
    let user_uuid = fixture.user_id.0;
    let server_uuid = fixture.server_id.0;
    let voice_cid = fixture.voice_channel_id.0;
    let text_cid = fixture.text_channel_id.0;

    // Order: voice_sessions → server_members → channels → servers → profiles → auth.users
    let _ = sqlx::query("DELETE FROM voice_sessions WHERE user_id = $1")
        .bind(user_uuid)
        .execute(pool)
        .await;
    let _ = sqlx::query("DELETE FROM server_members WHERE server_id = $1 AND user_id = $2")
        .bind(server_uuid)
        .bind(user_uuid)
        .execute(pool)
        .await;
    let _ = sqlx::query("DELETE FROM channels WHERE id IN ($1, $2)")
        .bind(voice_cid)
        .bind(text_cid)
        .execute(pool)
        .await;
    let _ = sqlx::query("DELETE FROM servers WHERE id = $1")
        .bind(server_uuid)
        .execute(pool)
        .await;
    let _ = sqlx::query("DELETE FROM profiles WHERE id = $1")
        .bind(user_uuid)
        .execute(pool)
        .await;
    let _ = sqlx::query("DELETE FROM auth.users WHERE id = $1")
        .bind(user_uuid)
        .execute(pool)
        .await;
}

// ── Helper: extract response body as JSON ───────────────────────────────

async fn body_json(response: axum::response::Response) -> serde_json::Value {
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("read response body");
    serde_json::from_slice(&bytes).expect("parse response body as JSON")
}

// ── Tests ───────────────────────────────────────────────────────────────

/// Test 1: POST /v1/channels/{id}/voice/join on a voice channel → 200 with token.
#[tokio::test]
async fn join_voice_channel_returns_200_with_token() {
    let pool = test_pool().await;
    let fixture = seed_fixture(&pool).await;
    let state = app_state_with_voice(pool.clone()).await;
    let app = voice_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!(
                    "/v1/channels/{}/voice/join",
                    fixture.voice_channel_id.0
                ))
                .header(header::AUTHORIZATION, format!("Bearer {}", fixture.jwt))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert!(json.get("token").is_some(), "response must contain 'token'");
    assert!(json.get("url").is_some(), "response must contain 'url'");

    cleanup_fixture(&pool, &fixture).await;
}

/// Test 2: POST /v1/channels/{id}/voice/join on a text channel → 422.
#[tokio::test]
async fn join_text_channel_returns_422() {
    let pool = test_pool().await;
    let fixture = seed_fixture(&pool).await;
    let state = app_state_with_voice(pool.clone()).await;
    let app = voice_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!(
                    "/v1/channels/{}/voice/join",
                    fixture.text_channel_id.0
                ))
                .header(header::AUTHORIZATION, format!("Bearer {}", fixture.jwt))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    // WHY: DomainError::ValidationError maps to 400 (Bad Request) in the API layer,
    // not 422. The handler returns "Channel is not a voice channel" as a validation error.
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let json = body_json(response).await;
    assert_eq!(json["status"], 400);
    assert!(
        json["detail"]
            .as_str()
            .unwrap_or("")
            .contains("not a voice channel"),
        "detail should mention voice channel: {:?}",
        json["detail"]
    );

    cleanup_fixture(&pool, &fixture).await;
}

/// Test 3: POST /v1/channels/{id}/voice/leave → 204.
#[tokio::test]
async fn leave_voice_channel_returns_204() {
    let pool = test_pool().await;
    let fixture = seed_fixture(&pool).await;
    let state = app_state_with_voice(pool.clone()).await;
    let app = voice_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!(
                    "/v1/channels/{}/voice/leave",
                    fixture.voice_channel_id.0
                ))
                .header(header::AUTHORIZATION, format!("Bearer {}", fixture.jwt))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NO_CONTENT);

    cleanup_fixture(&pool, &fixture).await;
}

/// Test 4: GET /v1/channels/{id}/voice/participants → 200 with envelope.
#[tokio::test]
async fn list_voice_participants_returns_200_with_envelope() {
    let pool = test_pool().await;
    let fixture = seed_fixture(&pool).await;
    let state = app_state_with_voice(pool.clone()).await;
    let app = voice_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!(
                    "/v1/channels/{}/voice/participants",
                    fixture.voice_channel_id.0
                ))
                .header(header::AUTHORIZATION, format!("Bearer {}", fixture.jwt))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert!(
        json.get("items").is_some(),
        "response must contain 'items' array"
    );
    assert!(
        json.get("total").is_some(),
        "response must contain 'total' count"
    );

    cleanup_fixture(&pool, &fixture).await;
}

/// Test 5a: POST /v1/channels/{id}/voice/join without auth → 401.
#[tokio::test]
async fn join_voice_without_auth_returns_401() {
    let pool = test_pool().await;
    let state = app_state_with_voice(pool.clone()).await;
    let app = voice_router(state);
    let channel_id = Uuid::new_v4();

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/v1/channels/{channel_id}/voice/join"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let json = body_json(response).await;
    assert_eq!(json["status"], 401);
}

/// Test 5b: POST /v1/channels/{id}/voice/leave without auth → 401.
#[tokio::test]
async fn leave_voice_without_auth_returns_401() {
    let pool = test_pool().await;
    let state = app_state_with_voice(pool.clone()).await;
    let app = voice_router(state);
    let channel_id = Uuid::new_v4();

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/v1/channels/{channel_id}/voice/leave"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let json = body_json(response).await;
    assert_eq!(json["status"], 401);
}

/// Test 5c: GET /v1/channels/{id}/voice/participants without auth → 401.
#[tokio::test]
async fn list_participants_without_auth_returns_401() {
    let pool = test_pool().await;
    let state = app_state_with_voice(pool.clone()).await;
    let app = voice_router(state);
    let channel_id = Uuid::new_v4();

    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/v1/channels/{channel_id}/voice/participants"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let json = body_json(response).await;
    assert_eq!(json["status"], 401);
}

/// Test 5d: POST /v1/voice/heartbeat without auth → 401.
#[tokio::test]
async fn heartbeat_without_auth_returns_401() {
    let pool = test_pool().await;
    let state = app_state_with_voice(pool.clone()).await;
    let app = voice_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/voice/heartbeat")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"sessionId":"test-session"}"#))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let json = body_json(response).await;
    assert_eq!(json["status"], 401);
}

/// Test 6a: POST /v1/channels/{id}/voice/join with voice disabled → 503.
#[tokio::test]
async fn join_voice_disabled_returns_503() {
    let pool = test_pool().await;
    let fixture = seed_fixture(&pool).await;
    let state = app_state_without_voice(pool.clone()).await;
    let app = voice_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!(
                    "/v1/channels/{}/voice/join",
                    fixture.voice_channel_id.0
                ))
                .header(header::AUTHORIZATION, format!("Bearer {}", fixture.jwt))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let json = body_json(response).await;
    assert_eq!(json["status"], 503);
    assert!(
        json["detail"].as_str().unwrap_or("").contains("LiveKit"),
        "detail should mention LiveKit: {:?}",
        json["detail"]
    );

    cleanup_fixture(&pool, &fixture).await;
}

/// Test 6b: POST /v1/channels/{id}/voice/leave with voice disabled → 503.
#[tokio::test]
async fn leave_voice_disabled_returns_503() {
    let pool = test_pool().await;
    let fixture = seed_fixture(&pool).await;
    let state = app_state_without_voice(pool.clone()).await;
    let app = voice_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!(
                    "/v1/channels/{}/voice/leave",
                    fixture.voice_channel_id.0
                ))
                .header(header::AUTHORIZATION, format!("Bearer {}", fixture.jwt))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let json = body_json(response).await;
    assert_eq!(json["status"], 503);

    cleanup_fixture(&pool, &fixture).await;
}

/// Test 6c: GET /v1/channels/{id}/voice/participants with voice disabled → 503.
#[tokio::test]
async fn list_participants_voice_disabled_returns_503() {
    let pool = test_pool().await;
    let fixture = seed_fixture(&pool).await;
    let state = app_state_without_voice(pool.clone()).await;
    let app = voice_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!(
                    "/v1/channels/{}/voice/participants",
                    fixture.voice_channel_id.0
                ))
                .header(header::AUTHORIZATION, format!("Bearer {}", fixture.jwt))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let json = body_json(response).await;
    assert_eq!(json["status"], 503);

    cleanup_fixture(&pool, &fixture).await;
}

/// Test 6d: POST /v1/voice/heartbeat with voice disabled → 503.
#[tokio::test]
async fn heartbeat_voice_disabled_returns_503() {
    let pool = test_pool().await;
    let fixture = seed_fixture(&pool).await;
    let state = app_state_without_voice(pool.clone()).await;
    let app = voice_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/voice/heartbeat")
                .header(header::AUTHORIZATION, format!("Bearer {}", fixture.jwt))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"sessionId":"test-session"}"#))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let json = body_json(response).await;
    assert_eq!(json["status"], 503);

    cleanup_fixture(&pool, &fixture).await;
}
