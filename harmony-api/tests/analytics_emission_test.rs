#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Analytics funnel emission integration tests — real DB + real HTTP.
//!
//! Pins growth-plan §10 instrumentation at every API-owned funnel point:
//! 1. `POST /v1/servers`               → `server_created`
//! 2. `POST /v1/servers/{id}/invites`  → `invite_created`
//! 3. `POST /v1/servers/{id}/members`  → `invite_redeemed` + `server_joined`
//! 4. `POST /v1/channels/{id}/messages`→ `first_message` (ONCE per user —
//!    a second message must not create a second event)
//! 5. `POST .../reactions`             → `reaction_added`
//! 6. `POST /v1/channels/{id}/voice/join` → `voice_joined` (fake `LiveKit`)
//! 7. RESILIENCE: a recorder that always fails must never fail the user
//!    action (fire-and-forget, ADR-027) — message send still returns 201.
//!
//! (`user_signed_up` is DB-trigger-emitted and covered by
//! `supabase/tests/database/analytics_funnel.test.sql`; `session_connected`
//! rides the SSE handler and shares the same `track` helper asserted here.)
//!
//! WHY #[ignore]: requires a running Postgres with the Harmony schema.
//! Run locally with:
//!   `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:64322/postgres \
//!      cargo test --test analytics_emission_test -- --ignored`

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
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

use harmony_api::api::handlers::{invites, messages, reactions, servers, voice};
use harmony_api::api::middleware::auth::require_auth;
use harmony_api::api::state::AppState;
use harmony_api::domain::errors::DomainError;
use harmony_api::domain::models::{AnalyticsEvent, UserId};
use harmony_api::domain::ports::{AnalyticsRecorder, LiveKitTokenGenerator, VoiceGrants};
use harmony_api::domain::services::{ContentFilter, SpamGuard, VoiceService};
use harmony_api::infra::PgPresenceTracker;
use harmony_api::infra::pg_notify_event_bus::PgNotifyEventBus;
use harmony_api::infra::plan_always_allowed::AlwaysAllowedChecker;
use harmony_api::infra::postgres::{
    PgAnalyticsRecorder, PgBanRepository, PgChannelRepository, PgDesktopAuthRepository,
    PgDmRepository, PgInviteRepository, PgKeyRepository, PgMegolmSessionRepository,
    PgMemberRepository, PgMessageRepository, PgModerationRetryRepository,
    PgNotificationSettingsRepository, PgProfileRepository, PgReactionRepository,
    PgReadStateRepository, PgServerRepository, PgUserPreferencesRepository,
    PgVoiceSessionRepository,
};

// ── Test constants ──────────────────────────────────────────────────────
const TEST_JWT_SECRET: &str = "test-jwt-secret-for-integration-tests-only-32ch";

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
        "email": "analytics-test@example.com",
        "iat": now,
        "exp": now + 3600,
        "user_metadata": { "email_verified": true },
    });
    let header = JwtHeader::new(Algorithm::HS256);
    let key = EncodingKey::from_secret(TEST_JWT_SECRET.as_bytes());
    jsonwebtoken::encode(&header, &claims, &key).expect("JWT encoding should succeed")
}

async fn test_pool() -> PgPool {
    dotenvy::dotenv().ok();
    let url =
        std::env::var("DATABASE_URL").expect("DATABASE_URL must be set for integration tests");
    PgPool::connect(&url)
        .await
        .expect("Failed to connect to test database")
}

// ── Fake LiveKit (see voice_endpoint_test.rs WHY) ───────────────────────

#[derive(Debug)]
struct FakeLiveKitTokenGenerator;

impl LiveKitTokenGenerator for FakeLiveKitTokenGenerator {
    fn generate_token(
        &self,
        _room_name: &str,
        _user_id: &UserId,
        _display_name: &str,
        _grants: VoiceGrants,
    ) -> Result<String, DomainError> {
        Ok("fake-livekit-token-for-testing".to_string())
    }

    fn livekit_url(&self) -> &str {
        "wss://test.livekit.example.com"
    }

    fn max_ttl_secs(&self) -> u64 {
        7200
    }
}

// ── Always-failing recorder (resilience test) ───────────────────────────

/// Recorder that fails every insert. WHY: proves the fire-and-forget
/// contract — a broken analytics path must never fail a user action.
#[derive(Debug)]
struct FailingAnalyticsRecorder;

#[async_trait]
impl AnalyticsRecorder for FailingAnalyticsRecorder {
    async fn record(&self, _event: AnalyticsEvent) -> Result<(), DomainError> {
        Err(DomainError::Internal(
            "analytics deliberately broken for test".to_string(),
        ))
    }
}

// ── App state builder (mirrors mentions_polish_test.rs + voice) ─────────

async fn build_app_state(pool: PgPool, analytics_recorder: Arc<dyn AnalyticsRecorder>) -> AppState {
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

    let voice_repo: Arc<dyn harmony_api::domain::ports::VoiceSessionRepository> =
        Arc::new(PgVoiceSessionRepository::new(pool.clone()));
    let voice_service = Arc::new(VoiceService::new(
        voice_repo.clone(),
        channel_repo.clone(),
        member_repo.clone(),
        plan_checker.clone(),
        Arc::new(FakeLiveKitTokenGenerator),
    ));

    let instance_id = uuid::Uuid::new_v4();
    let (event_bus_inner, _event_notify_rx) = PgNotifyEventBus::new(instance_id);
    let event_bus: Arc<dyn harmony_api::domain::ports::EventBus> = Arc::new(event_bus_inner);
    let (presence_inner, _presence_write_rx) = PgPresenceTracker::new(instance_id, pool.clone());
    let presence_tracker = Arc::new(presence_inner);

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
        Some(voice_service),
        Some(voice_repo),
        None, // official_server_id
        analytics_recorder,
        Some("https://test.supabase.co".to_string()), // attachment_url_origin
        None,
    )
}

fn test_router(state: AppState) -> Router {
    let authenticated = Router::new()
        .route("/v1/servers", post(servers::create_server))
        .route("/v1/servers/{id}/invites", post(invites::create_invite))
        .route("/v1/servers/{id}/members", post(invites::join_server))
        .route("/v1/channels/{id}/messages", post(messages::send_message))
        .route(
            "/v1/channels/{channel_id}/messages/{message_id}/reactions",
            post(reactions::add_reaction),
        )
        .route("/v1/channels/{id}/voice/join", post(voice::join_voice))
        .route_layer(middleware::from_fn_with_state(state.clone(), require_auth));

    Router::new().merge(authenticated).with_state(state)
}

// ── Seeding helpers ─────────────────────────────────────────────────────

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
    .bind(format!("anl-{uid}@example.com"))
    .execute(pool)
    .await
    .expect("seed auth.users");

    let username = format!("an{}", &uid.simple().to_string()[..10]);
    sqlx::query("INSERT INTO profiles (id, username) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING")
        .bind(uid)
        .bind(username)
        .execute(pool)
        .await
        .expect("seed profiles");

    uid
}

/// Poll for a fire-and-forget event row (the insert races the HTTP response).
async fn wait_for_event_count(pool: &PgPool, name: &str, user_id: Uuid, expected: i64) -> i64 {
    let mut count: i64 = -1;
    for _ in 0..40 {
        count = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM analytics_events WHERE name = $1 AND user_id = $2",
        )
        .bind(name)
        .bind(user_id)
        .fetch_one(pool)
        .await
        .expect("count analytics_events");
        if count == expected {
            return count;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    count
}

fn authed_post(uri: &str, jwt: &str, body: &serde_json::Value) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(uri)
        .header(header::AUTHORIZATION, format!("Bearer {jwt}"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .expect("request build")
}

async fn body_json(response: axum::response::Response) -> serde_json::Value {
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("read body");
    serde_json::from_slice(&bytes).expect("json body")
}

// ── Tests ───────────────────────────────────────────────────────────────

/// Walks the whole funnel over real HTTP and asserts one event per §10
/// funnel point, with once-per-user dedup for `first_message`.
#[tokio::test]
#[ignore = "requires local Postgres (Supabase) with Harmony schema"]
async fn funnel_points_emit_analytics_events() {
    let pool = test_pool().await;
    let recorder: Arc<dyn AnalyticsRecorder> = Arc::new(PgAnalyticsRecorder::new(pool.clone()));
    let state = build_app_state(pool.clone(), recorder).await;
    let router = test_router(state);

    let owner = seed_user(&pool).await;
    let joiner = seed_user(&pool).await;
    let owner_jwt = sign_test_jwt(owner);
    let joiner_jwt = sign_test_jwt(joiner);

    // 1. server_created
    let response = router
        .clone()
        .oneshot(authed_post(
            "/v1/servers",
            &owner_jwt,
            &serde_json::json!({ "name": "Analytics Test Server" }),
        ))
        .await
        .expect("create server");
    assert_eq!(response.status(), StatusCode::CREATED);
    let server = body_json(response).await;
    let server_id = server["id"].as_str().expect("server id").to_string();
    assert_eq!(
        wait_for_event_count(&pool, "server_created", owner, 1).await,
        1,
        "server_created event should be recorded"
    );

    // 2. invite_created
    let response = router
        .clone()
        .oneshot(authed_post(
            &format!("/v1/servers/{server_id}/invites"),
            &owner_jwt,
            &serde_json::json!({}),
        ))
        .await
        .expect("create invite");
    assert_eq!(response.status(), StatusCode::CREATED);
    let invite = body_json(response).await;
    let code = invite["code"].as_str().expect("invite code").to_string();
    assert_eq!(
        wait_for_event_count(&pool, "invite_created", owner, 1).await,
        1,
        "invite_created event should be recorded"
    );

    // 3. invite_redeemed + server_joined (joiner)
    let response = router
        .clone()
        .oneshot(authed_post(
            &format!("/v1/servers/{server_id}/members"),
            &joiner_jwt,
            &serde_json::json!({ "inviteCode": code }),
        ))
        .await
        .expect("join server");
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        wait_for_event_count(&pool, "invite_redeemed", joiner, 1).await,
        1,
        "invite_redeemed event should be recorded"
    );
    assert_eq!(
        wait_for_event_count(&pool, "server_joined", joiner, 1).await,
        1,
        "server_joined event should be recorded"
    );

    // Find the default channel created with the server.
    let channel_id = sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM channels WHERE server_id = $1::uuid ORDER BY position LIMIT 1",
    )
    .bind(Uuid::parse_str(&server_id).expect("uuid"))
    .fetch_one(&pool)
    .await
    .expect("default channel");

    // 4. first_message — once per user, even after a second message.
    let response = router
        .clone()
        .oneshot(authed_post(
            &format!("/v1/channels/{channel_id}/messages"),
            &joiner_jwt,
            &serde_json::json!({ "content": "first message ever" }),
        ))
        .await
        .expect("send message 1");
    assert_eq!(response.status(), StatusCode::CREATED);
    let message = body_json(response).await;
    let message_id = message["id"].as_str().expect("message id").to_string();
    assert_eq!(
        wait_for_event_count(&pool, "first_message", joiner, 1).await,
        1,
        "first_message event should be recorded"
    );

    let response = router
        .clone()
        .oneshot(authed_post(
            &format!("/v1/channels/{channel_id}/messages"),
            &joiner_jwt,
            &serde_json::json!({ "content": "second message" }),
        ))
        .await
        .expect("send message 2");
    assert_eq!(response.status(), StatusCode::CREATED);
    // Give the spawned insert time to (wrongly) add a row before asserting.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        wait_for_event_count(&pool, "first_message", joiner, 1).await,
        1,
        "first_message must stay once-per-user after a second message"
    );

    // 5. reaction_added
    let response = router
        .clone()
        .oneshot(authed_post(
            &format!("/v1/channels/{channel_id}/messages/{message_id}/reactions"),
            &owner_jwt,
            &serde_json::json!({ "emoji": "👍" }),
        ))
        .await
        .expect("add reaction");
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        wait_for_event_count(&pool, "reaction_added", owner, 1).await,
        1,
        "reaction_added event should be recorded"
    );

    // 6. voice_joined (fake LiveKit; needs a voice channel)
    let voice_channel = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channels (id, server_id, name, channel_type, position) VALUES ($1, $2::uuid, 'voice', 'voice'::channel_type, 9)",
    )
    .bind(voice_channel)
    .bind(Uuid::parse_str(&server_id).expect("uuid"))
    .execute(&pool)
    .await
    .expect("seed voice channel");

    let response = router
        .clone()
        .oneshot(authed_post(
            &format!("/v1/channels/{voice_channel}/voice/join"),
            &joiner_jwt,
            &serde_json::json!({}),
        ))
        .await
        .expect("join voice");
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        wait_for_event_count(&pool, "voice_joined", joiner, 1).await,
        1,
        "voice_joined event should be recorded"
    );
}

/// Fire-and-forget contract (ADR-027): a permanently failing recorder must
/// never fail the user action it instruments.
#[tokio::test]
#[ignore = "requires local Postgres (Supabase) with Harmony schema"]
async fn failing_recorder_never_fails_the_user_action() {
    let pool = test_pool().await;
    let recorder: Arc<dyn AnalyticsRecorder> = Arc::new(FailingAnalyticsRecorder);
    let state = build_app_state(pool.clone(), recorder).await;
    let router = test_router(state);

    let owner = seed_user(&pool).await;
    let owner_jwt = sign_test_jwt(owner);

    // Server creation succeeds even though every analytics insert errors.
    let response = router
        .clone()
        .oneshot(authed_post(
            "/v1/servers",
            &owner_jwt,
            &serde_json::json!({ "name": "Broken Analytics Server" }),
        ))
        .await
        .expect("create server");
    assert_eq!(
        response.status(),
        StatusCode::CREATED,
        "user action must succeed when analytics is down"
    );
    let server = body_json(response).await;
    let server_id = server["id"].as_str().expect("server id").to_string();

    let channel_id = sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM channels WHERE server_id = $1::uuid ORDER BY position LIMIT 1",
    )
    .bind(Uuid::parse_str(&server_id).expect("uuid"))
    .fetch_one(&pool)
    .await
    .expect("default channel");

    // Message send succeeds too — and no event row ever lands.
    let response = router
        .clone()
        .oneshot(authed_post(
            &format!("/v1/channels/{channel_id}/messages"),
            &owner_jwt,
            &serde_json::json!({ "content": "hello despite broken analytics" }),
        ))
        .await
        .expect("send message");
    let status = response.status();
    if status != StatusCode::CREATED {
        let body = body_json(response).await;
        panic!("message send must succeed when analytics is down — got {status}: {body}");
    }

    tokio::time::sleep(Duration::from_millis(300)).await;
    let count =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM analytics_events WHERE user_id = $1")
            .bind(owner)
            .fetch_one(&pool)
            .await
            .expect("count");
    // Only the DB-trigger signup event exists; nothing from the broken recorder.
    assert_eq!(
        count, 1,
        "only the signup trigger event should exist for this user"
    );
}
