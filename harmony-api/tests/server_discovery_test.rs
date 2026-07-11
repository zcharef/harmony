#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Server-directory (opt-in discovery) integration tests — real DB + real HTTP.
//!
//! Pins the directory's security contract:
//! 1. Non-discoverable servers are NEVER listed — under any combination of
//!    search/category/cursor parameters.
//! 2. The category filter returns only matching servers; unknown categories 400.
//! 3. Featured servers order before non-featured ones.
//! 4. Direct join re-checks `discoverable = true` at join time (403 otherwise).
//! 5. Banned users get a clean 403 and never become members.
//! 6. Joining twice is an idempotent no-op (existing member → 204).
//! 7. The public description goes through the hard content filter (400).
//! 8. Discovery settings are admin+ (plain member → 403).
//! 9. `discovery_viewed` / `discovery_join` analytics events are recorded.
//!
//! NOTE on shared-DB isolation: assertions check for the presence/absence of
//! THIS test's server IDs (with unique searchable names), never for exact
//! directory sizes — the local dev DB may contain other discoverable rows.
//!
//! WHY #[ignore]: requires a running Postgres with the Harmony schema.
//! Run locally with:
//!   `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:64322/postgres \
//!      cargo test --test server_discovery_test -- --ignored`

use std::sync::Arc;
use std::time::Duration;

use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode, header},
    middleware,
    routing::{get, patch, post},
};
use jsonwebtoken::{Algorithm, EncodingKey, Header as JwtHeader};
use secrecy::SecretString;
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

use harmony_api::api::handlers::{discovery, servers};
use harmony_api::api::middleware::auth::require_auth;
use harmony_api::api::state::AppState;
use harmony_api::domain::models::UserId;
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
        "email": "discovery-test@example.com",
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
    ) -> Result<String, harmony_api::domain::errors::DomainError> {
        Ok("fake-livekit-token-for-testing".to_string())
    }

    fn livekit_url(&self) -> &str {
        "wss://test.livekit.example.com"
    }

    fn max_ttl_secs(&self) -> u64 {
        7200
    }
}

// ── App state builder (mirrors analytics_emission_test.rs) ──────────────

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

    let attachment_repo_for_scan: std::sync::Arc<
        dyn harmony_api::domain::ports::AttachmentRepository,
    > = std::sync::Arc::new(harmony_api::infra::postgres::PgAttachmentRepository::new(
        pool.clone(),
    ));
    let attachment_scan_retry_repo = std::sync::Arc::new(
        harmony_api::infra::postgres::PgAttachmentScanRetryRepository::new(pool.clone()),
    );
    let analytics_recorder: Arc<dyn AnalyticsRecorder> =
        Arc::new(PgAnalyticsRecorder::new(pool.clone()));
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
        .route(
            "/v1/servers/{id}/discovery",
            patch(discovery::update_server_discovery),
        )
        .route(
            "/v1/discovery/servers",
            get(discovery::list_discovery_servers),
        )
        .route(
            "/v1/discovery/servers/{id}/join",
            post(discovery::join_discovery_server),
        )
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
    .bind(format!("disc-{uid}@example.com"))
    .execute(pool)
    .await
    .expect("seed auth.users");

    let username = format!("dc{}", &uid.simple().to_string()[..10]);
    sqlx::query("INSERT INTO profiles (id, username) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING")
        .bind(uid)
        .bind(username)
        .execute(pool)
        .await
        .expect("seed profiles");

    uid
}

fn authed_request(
    method: &str,
    uri: &str,
    jwt: &str,
    body: Option<&serde_json::Value>,
) -> Request<Body> {
    let builder = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::AUTHORIZATION, format!("Bearer {jwt}"))
        .header(header::CONTENT_TYPE, "application/json");
    match body {
        Some(b) => builder.body(Body::from(b.to_string())).expect("request"),
        None => builder.body(Body::empty()).expect("request"),
    }
}

async fn body_json(response: axum::response::Response) -> serde_json::Value {
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("read body");
    serde_json::from_slice(&bytes).expect("json body")
}

/// Create a server over HTTP and return its id.
async fn create_server(router: &Router, jwt: &str, name: &str) -> String {
    let response = router
        .clone()
        .oneshot(authed_request(
            "POST",
            "/v1/servers",
            jwt,
            Some(&serde_json::json!({ "name": name })),
        ))
        .await
        .expect("create server");
    assert_eq!(response.status(), StatusCode::CREATED);
    body_json(response).await["id"]
        .as_str()
        .expect("server id")
        .to_string()
}

/// Opt a server into discovery over HTTP (as its owner/admin).
async fn opt_in(router: &Router, jwt: &str, server_id: &str, category: &str, description: &str) {
    let response = router
        .clone()
        .oneshot(authed_request(
            "PATCH",
            &format!("/v1/servers/{server_id}/discovery"),
            jwt,
            Some(&serde_json::json!({
                "discoverable": true,
                "category": category,
                "description": description,
            })),
        ))
        .await
        .expect("opt in");
    assert_eq!(response.status(), StatusCode::OK);
}

/// Fetch a directory page and return the array of items.
async fn list_directory(router: &Router, jwt: &str, query: &str) -> serde_json::Value {
    let response = router
        .clone()
        .oneshot(authed_request(
            "GET",
            &format!("/v1/discovery/servers{query}"),
            jwt,
            None,
        ))
        .await
        .expect("list directory");
    assert_eq!(response.status(), StatusCode::OK);
    body_json(response).await
}

fn item_ids(page: &serde_json::Value) -> Vec<String> {
    page["items"]
        .as_array()
        .expect("items array")
        .iter()
        .map(|i| i["id"].as_str().expect("id").to_string())
        .collect()
}

async fn is_member(pool: &PgPool, server: &str, user: Uuid) -> bool {
    sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM server_members WHERE server_id = $1::uuid AND user_id = $2)",
    )
    .bind(Uuid::parse_str(server).expect("uuid"))
    .bind(user)
    .fetch_one(pool)
    .await
    .expect("is_member")
}

/// Poll for a fire-and-forget analytics row (the insert races the response).
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

// ── Tests ───────────────────────────────────────────────────────────────

/// The core never-leak contract: a server that did not opt in is invisible
/// under EVERY parameter combination (bare, search, category, search+category).
#[tokio::test]
#[ignore = "requires local Postgres (Supabase) with Harmony schema"]
async fn non_discoverable_servers_never_listed() {
    let pool = test_pool().await;
    let state = build_app_state(pool.clone()).await;
    let router = test_router(state);

    let owner = seed_user(&pool).await;
    let viewer = seed_user(&pool).await;
    let owner_jwt = sign_test_jwt(owner);
    let viewer_jwt = sign_test_jwt(viewer);

    // Unique name marker so search assertions only see this test's servers.
    let marker = format!("nvl{}", Uuid::new_v4().simple());
    let public_id = create_server(&router, &owner_jwt, &format!("Public {marker}")).await;
    let private_id = create_server(&router, &owner_jwt, &format!("Private {marker}")).await;
    opt_in(&router, &owner_jwt, &public_id, "gaming", "Open to all").await;

    // Bare listing: public present, private absent.
    let page = list_directory(&router, &viewer_jwt, "").await;
    let ids = item_ids(&page);
    assert!(ids.contains(&public_id), "opted-in server must be listed");
    assert!(!ids.contains(&private_id), "non-discoverable server leaked");

    // Search matching BOTH names: only the discoverable one comes back.
    let page = list_directory(&router, &viewer_jwt, &format!("?q={marker}")).await;
    let ids = item_ids(&page);
    assert_eq!(ids, vec![public_id.clone()], "search must not leak");
    assert_eq!(page["total"].as_i64(), Some(1));

    // Search matching ONLY the private name: nothing.
    let page = list_directory(&router, &viewer_jwt, &format!("?q=Private%20{marker}")).await;
    assert!(item_ids(&page).is_empty(), "private name search leaked");

    // Category + search: still only the public one.
    let page = list_directory(
        &router,
        &viewer_jwt,
        &format!("?q={marker}&category=gaming"),
    )
    .await;
    assert_eq!(item_ids(&page), vec![public_id.clone()]);

    // Directory card exposes the public projection only.
    let item = &page["items"][0];
    assert_eq!(
        item["memberCount"].as_i64(),
        Some(1),
        "owner-only membership"
    );
    assert_eq!(item["category"].as_str(), Some("gaming"));
    assert_eq!(item["description"].as_str(), Some("Open to all"));
    assert!(item.get("ownerId").is_none(), "ownerId must not be exposed");
}

/// Category filter + unknown category 400 + featured-first ordering.
#[tokio::test]
#[ignore = "requires local Postgres (Supabase) with Harmony schema"]
async fn category_filter_and_featured_ordering() {
    let pool = test_pool().await;
    let state = build_app_state(pool.clone()).await;
    let router = test_router(state);

    let owner = seed_user(&pool).await;
    let owner_jwt = sign_test_jwt(owner);

    let marker = format!("cat{}", Uuid::new_v4().simple());
    let gaming_id = create_server(&router, &owner_jwt, &format!("Gaming {marker}")).await;
    let tech_id = create_server(&router, &owner_jwt, &format!("Tech {marker}")).await;
    opt_in(&router, &owner_jwt, &gaming_id, "gaming", "").await;
    opt_in(&router, &owner_jwt, &tech_id, "tech", "").await;

    // Category filter: only the matching server (scoped by the marker).
    let page = list_directory(&router, &owner_jwt, &format!("?q={marker}&category=tech")).await;
    assert_eq!(item_ids(&page), vec![tech_id.clone()]);

    // Feature the tech server directly in the DB (no UI by design).
    sqlx::query("UPDATE servers SET discovery_featured = true WHERE id = $1::uuid")
        .bind(Uuid::parse_str(&tech_id).expect("uuid"))
        .execute(&pool)
        .await
        .expect("feature server");

    let page = list_directory(&router, &owner_jwt, &format!("?q={marker}")).await;
    assert_eq!(
        item_ids(&page),
        vec![tech_id, gaming_id],
        "featured server must order first"
    );

    // Unknown category is a validation error, not an empty leak-prone filter.
    let response = router
        .clone()
        .oneshot(authed_request(
            "GET",
            "/v1/discovery/servers?category=not-a-category",
            &owner_jwt,
            None,
        ))
        .await
        .expect("bad category");
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

/// Direct join re-checks discoverable at join time: 403 on a private server.
#[tokio::test]
#[ignore = "requires local Postgres (Supabase) with Harmony schema"]
async fn direct_join_non_discoverable_server_403() {
    let pool = test_pool().await;
    let state = build_app_state(pool.clone()).await;
    let router = test_router(state);

    let owner = seed_user(&pool).await;
    let joiner = seed_user(&pool).await;
    let owner_jwt = sign_test_jwt(owner);
    let joiner_jwt = sign_test_jwt(joiner);

    let server_id = create_server(&router, &owner_jwt, "Not Listed Anywhere").await;

    let response = router
        .clone()
        .oneshot(authed_request(
            "POST",
            &format!("/v1/discovery/servers/{server_id}/join"),
            &joiner_jwt,
            None,
        ))
        .await
        .expect("join");
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert!(!is_member(&pool, &server_id, joiner).await);

    // Opt in, then opt back out: the join door must close again.
    opt_in(&router, &owner_jwt, &server_id, "community", "").await;
    let response = router
        .clone()
        .oneshot(authed_request(
            "PATCH",
            &format!("/v1/servers/{server_id}/discovery"),
            &owner_jwt,
            Some(&serde_json::json!({ "discoverable": false })),
        ))
        .await
        .expect("opt out");
    assert_eq!(response.status(), StatusCode::OK);

    let response = router
        .clone()
        .oneshot(authed_request(
            "POST",
            &format!("/v1/discovery/servers/{server_id}/join"),
            &joiner_jwt,
            None,
        ))
        .await
        .expect("join after opt-out");
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert!(!is_member(&pool, &server_id, joiner).await);
}

/// Banned users get a clean 403 and never become members through discovery.
#[tokio::test]
#[ignore = "requires local Postgres (Supabase) with Harmony schema"]
async fn banned_user_cannot_join_through_discovery() {
    let pool = test_pool().await;
    let state = build_app_state(pool.clone()).await;
    let router = test_router(state);

    let owner = seed_user(&pool).await;
    let banned = seed_user(&pool).await;
    let owner_jwt = sign_test_jwt(owner);
    let banned_jwt = sign_test_jwt(banned);

    let server_id = create_server(&router, &owner_jwt, "Ban Respecting Server").await;
    opt_in(&router, &owner_jwt, &server_id, "community", "").await;

    sqlx::query("INSERT INTO server_bans (server_id, user_id) VALUES ($1::uuid, $2)")
        .bind(Uuid::parse_str(&server_id).expect("uuid"))
        .bind(banned)
        .execute(&pool)
        .await
        .expect("seed ban");

    let response = router
        .clone()
        .oneshot(authed_request(
            "POST",
            &format!("/v1/discovery/servers/{server_id}/join"),
            &banned_jwt,
            None,
        ))
        .await
        .expect("join");
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert!(!is_member(&pool, &server_id, banned).await);
}

/// Joining twice is idempotent: second join is a 204 no-op, one membership row.
#[tokio::test]
#[ignore = "requires local Postgres (Supabase) with Harmony schema"]
async fn direct_join_is_idempotent_for_existing_members() {
    let pool = test_pool().await;
    let state = build_app_state(pool.clone()).await;
    let router = test_router(state);

    let owner = seed_user(&pool).await;
    let joiner = seed_user(&pool).await;
    let owner_jwt = sign_test_jwt(owner);
    let joiner_jwt = sign_test_jwt(joiner);

    let server_id = create_server(&router, &owner_jwt, "Idempotent Join Server").await;
    opt_in(&router, &owner_jwt, &server_id, "music", "").await;

    for _ in 0..2 {
        let response = router
            .clone()
            .oneshot(authed_request(
                "POST",
                &format!("/v1/discovery/servers/{server_id}/join"),
                &joiner_jwt,
                None,
            ))
            .await
            .expect("join");
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
    }

    let memberships = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM server_members WHERE server_id = $1::uuid AND user_id = $2",
    )
    .bind(Uuid::parse_str(&server_id).expect("uuid"))
    .bind(joiner)
    .fetch_one(&pool)
    .await
    .expect("count memberships");
    assert_eq!(memberships, 1);
}

/// The public description goes through `ContentFilter::check_hard` — the same
/// gate as server names (`server_service.rs`) — and rejects banned words.
#[tokio::test]
#[ignore = "requires local Postgres (Supabase) with Harmony schema"]
async fn moderation_rejects_banned_word_description() {
    let pool = test_pool().await;
    let state = build_app_state(pool.clone()).await;
    let router = test_router(state);

    let owner = seed_user(&pool).await;
    let owner_jwt = sign_test_jwt(owner);
    let server_id = create_server(&router, &owner_jwt, "Moderated Description").await;

    // "beaner" is on the embedded en_abuse list the hard filter loads.
    let response = router
        .clone()
        .oneshot(authed_request(
            "PATCH",
            &format!("/v1/servers/{server_id}/discovery"),
            &owner_jwt,
            Some(&serde_json::json!({
                "discoverable": true,
                "category": "other",
                "description": "welcome to beaner country",
            })),
        ))
        .await
        .expect("opt in with slur");
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    // The rejected update must not have flipped the flag.
    let discoverable =
        sqlx::query_scalar::<_, bool>("SELECT discoverable FROM servers WHERE id = $1::uuid")
            .bind(Uuid::parse_str(&server_id).expect("uuid"))
            .fetch_one(&pool)
            .await
            .expect("discoverable");
    assert!(!discoverable);
}

/// Discovery settings are admin+: a plain member gets 403.
#[tokio::test]
#[ignore = "requires local Postgres (Supabase) with Harmony schema"]
async fn discovery_settings_require_admin_role() {
    let pool = test_pool().await;
    let state = build_app_state(pool.clone()).await;
    let router = test_router(state);

    let owner = seed_user(&pool).await;
    let member = seed_user(&pool).await;
    let owner_jwt = sign_test_jwt(owner);
    let member_jwt = sign_test_jwt(member);

    let server_id = create_server(&router, &owner_jwt, "Admin Gated Discovery").await;
    sqlx::query(
        "INSERT INTO server_members (server_id, user_id, role) VALUES ($1::uuid, $2, 'member')",
    )
    .bind(Uuid::parse_str(&server_id).expect("uuid"))
    .bind(member)
    .execute(&pool)
    .await
    .expect("seed member");

    let response = router
        .clone()
        .oneshot(authed_request(
            "PATCH",
            &format!("/v1/servers/{server_id}/discovery"),
            &member_jwt,
            Some(&serde_json::json!({ "discoverable": true, "category": "art" })),
        ))
        .await
        .expect("member patch");
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

/// Funnel instrumentation: `discovery_viewed` on the first page load and
/// `discovery_join` (+ `server_joined` via=discovery) on a successful join.
#[tokio::test]
#[ignore = "requires local Postgres (Supabase) with Harmony schema"]
async fn discovery_analytics_events_are_recorded() {
    let pool = test_pool().await;
    let state = build_app_state(pool.clone()).await;
    let router = test_router(state);

    let owner = seed_user(&pool).await;
    let viewer = seed_user(&pool).await;
    let owner_jwt = sign_test_jwt(owner);
    let viewer_jwt = sign_test_jwt(viewer);

    let server_id = create_server(&router, &owner_jwt, "Analytics Discovery Server").await;
    opt_in(&router, &owner_jwt, &server_id, "science", "").await;

    let _ = list_directory(&router, &viewer_jwt, "").await;
    assert_eq!(
        wait_for_event_count(&pool, "discovery_viewed", viewer, 1).await,
        1,
        "discovery_viewed event should be recorded"
    );

    let response = router
        .clone()
        .oneshot(authed_request(
            "POST",
            &format!("/v1/discovery/servers/{server_id}/join"),
            &viewer_jwt,
            None,
        ))
        .await
        .expect("join");
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        wait_for_event_count(&pool, "discovery_join", viewer, 1).await,
        1,
        "discovery_join event should be recorded"
    );
    assert_eq!(
        wait_for_event_count(&pool, "server_joined", viewer, 1).await,
        1,
        "server_joined (via discovery) event should be recorded"
    );

    // A second (idempotent) join must NOT double-count the funnel.
    let response = router
        .clone()
        .oneshot(authed_request(
            "POST",
            &format!("/v1/discovery/servers/{server_id}/join"),
            &viewer_jwt,
            None,
        ))
        .await
        .expect("second join");
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        wait_for_event_count(&pool, "discovery_join", viewer, 1).await,
        1,
        "idempotent join must not emit a second discovery_join"
    );
}
