#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Desktop auth exchange — full HTTP flow (E12).
//!
//! Drives `POST /v1/auth/desktop-exchange/create` (behind `require_auth`) and
//! `POST /v1/auth/desktop-exchange/redeem` (public) through the real route
//! wiring via `tower::ServiceExt::oneshot`, with a real DB and a `wiremock`
//! `GoTrue` (ADR-018). Proves the redeem handler:
//!   - mints a FRESH, INDEPENDENT session (the `/verify` tokens), never a
//!     forwarded web refresh token, for the user who created the code;
//!   - is single-use (second redeem 401);
//!   - enforces PKCE (wrong verifier 401);
//!   - rejects unknown codes (401);
//!   - returns 502 when no session minter is configured.
//!
//! DB-backed → `#[ignore]` (run locally: `cargo test --test
//! desktop_auth_flow_test -- --ignored`).

use std::sync::Arc;

use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode, header},
    middleware,
    routing::post,
};
use base64::Engine;
use jsonwebtoken::{Algorithm, EncodingKey, Header as JwtHeader};
use secrecy::SecretString;
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;
use wiremock::matchers::{method, path, path_regex};
use wiremock::{Mock, MockServer, ResponseTemplate};

use harmony_api::api::handlers::desktop_auth;
use harmony_api::api::middleware::auth::require_auth;
use harmony_api::api::state::AppState;
use harmony_api::domain::ports::SessionMinter;
use harmony_api::infra::supabase_admin::SupabaseAdminClient;

const TEST_JWT_SECRET: &str = "test-jwt-secret-for-integration-tests-only-32ch";
const SERVICE_ROLE_KEY: &str = "test-service-role-key";
const MINTED_ACCESS: &str = "minted-access-token-e2e";
const MINTED_REFRESH: &str = "minted-refresh-token-e2e";

fn install_crypto_provider() {
    let _ = jsonwebtoken::crypto::aws_lc::DEFAULT_PROVIDER.install_default();
}

fn sign_test_jwt(user_id: Uuid) -> String {
    install_crypto_provider();
    let now = chrono::Utc::now().timestamp();
    let claims = json!({
        "sub": user_id.to_string(),
        "aud": "authenticated",
        "role": "authenticated",
        "email": "desktop-flow@example.com",
        "iat": now,
        "exp": now + 3600,
        "user_metadata": { "email_verified": true },
    });
    let header = JwtHeader::new(Algorithm::HS256);
    let key = EncodingKey::from_secret(TEST_JWT_SECRET.as_bytes());
    jsonwebtoken::encode(&header, &claims, &key).expect("sign jwt")
}

/// PKCE: base64url(SHA256(verifier)), 43 chars.
fn pkce_pair() -> (String, String) {
    let verifier = "desktop-code-verifier-plaintext-value-123456";
    let hash = Sha256::digest(verifier.as_bytes());
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(hash);
    (verifier.to_string(), challenge)
}

async fn test_pool() -> PgPool {
    dotenvy::dotenv().ok();
    let url =
        std::env::var("DATABASE_URL").expect("DATABASE_URL must be set for integration tests");
    PgPool::connect(&url)
        .await
        .expect("connect to test database")
}

async fn mount_gotrue(server: &MockServer) {
    Mock::given(method("GET"))
        .and(path_regex(r"^/auth/v1/admin/users/.+$"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({ "email": "desktop-flow@example.com" })),
        )
        .mount(server)
        .await;
    Mock::given(method("POST"))
        .and(path("/auth/v1/admin/generate_link"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "hashed_token": "hashed-e2e",
            "verification_type": "magiclink",
        })))
        .mount(server)
        .await;
    Mock::given(method("POST"))
        .and(path("/auth/v1/verify"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "access_token": MINTED_ACCESS,
            "token_type": "bearer",
            "expires_in": 3600,
            "refresh_token": MINTED_REFRESH,
        })))
        .mount(server)
        .await;
}

/// Build an `AppState` wired for the desktop routes. Every non-desktop
/// dependency is a real Postgres-backed repo/service over `pool` (mirrors
/// `profile_endpoint_test`); `minter` is the only variant.
async fn build_app_state(pool: PgPool, minter: Option<Arc<dyn SessionMinter>>) -> AppState {
    use harmony_api::domain::services::{ContentFilter, SpamGuard};
    use harmony_api::infra::PgPresenceTracker;
    use harmony_api::infra::pg_notify_event_bus::PgNotifyEventBus;
    use harmony_api::infra::plan_always_allowed::AlwaysAllowedChecker;
    use harmony_api::infra::postgres::{
        PgAnalyticsRecorder, PgAttachmentRepository, PgAttachmentScanRetryRepository,
        PgBanRepository, PgChannelRepository, PgDesktopAuthRepository, PgDmRepository,
        PgEmbedRepository, PgFriendshipRepository, PgInviteRepository, PgKeyRepository,
        PgMegolmSessionRepository, PgMemberRepository, PgMessageRepository,
        PgModerationLogRepository, PgModerationRetryRepository, PgNotificationSettingsRepository,
        PgProfileRepository, PgReactionRepository, PgReadStateRepository, PgReportRepository,
        PgServerRepository, PgUserPreferencesRepository,
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
    let attachment_repo: Arc<dyn harmony_api::domain::ports::AttachmentRepository> =
        Arc::new(PgAttachmentRepository::new(pool.clone()));
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
    let friendship_repo = Arc::new(PgFriendshipRepository::new(pool.clone()));
    let message_service = Arc::new(harmony_api::domain::services::MessageService::new(
        message_repo.clone(),
        channel_repo.clone(),
        member_repo.clone(),
        plan_checker.clone(),
        reaction_repo.clone(),
        attachment_repo.clone(),
        Arc::new(PgEmbedRepository::new(pool.clone())),
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
        Arc::new(PgModerationLogRepository::new(pool.clone())),
        Arc::new(PgReportRepository::new(pool.clone())),
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

    let instance_id = Uuid::new_v4();
    let (event_bus_inner, _rx) = PgNotifyEventBus::new(instance_id);
    let event_bus: Arc<dyn harmony_api::domain::ports::EventBus> = Arc::new(event_bus_inner);
    let (presence_inner, _prx) = PgPresenceTracker::new(instance_id, pool.clone());
    let presence_tracker = Arc::new(presence_inner);
    let analytics_recorder: Arc<dyn harmony_api::domain::ports::AnalyticsRecorder> =
        Arc::new(PgAnalyticsRecorder::new(pool.clone()));
    let attachment_repo_for_scan: Arc<dyn harmony_api::domain::ports::AttachmentRepository> =
        Arc::new(PgAttachmentRepository::new(pool.clone()));
    let attachment_scan_retry_repo = Arc::new(PgAttachmentScanRetryRepository::new(pool.clone()));

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
        None,
        None,
        None,
        message_repo,
        server_repo,
        moderation_retry_repo,
        Arc::new(harmony_api::infra::NoopImageClassifier),
        Arc::new(harmony_api::infra::NoopCsamMatcher),
        attachment_repo_for_scan,
        attachment_scan_retry_repo,
        false,
        None,
        None,
        None,
        analytics_recorder,
        Some("https://test.supabase.co".to_string()),
        None,
    )
    .with_session_minter(minter)
}

fn desktop_router(state: AppState) -> Router {
    let authenticated = Router::new()
        .route(
            "/v1/auth/desktop-exchange/create",
            post(desktop_auth::create_desktop_auth_code),
        )
        .route_layer(middleware::from_fn_with_state(state.clone(), require_auth));
    let public = Router::new().route(
        "/v1/auth/desktop-exchange/redeem",
        post(desktop_auth::redeem_desktop_auth_code),
    );
    Router::new()
        .merge(authenticated)
        .merge(public)
        .with_state(state)
}

async fn body_json(response: axum::response::Response) -> serde_json::Value {
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("read body");
    serde_json::from_slice(&bytes).expect("parse json")
}

/// Call create with a signed JWT, returning the issued auth code.
async fn create_code(app: &Router, jwt: &str, challenge: &str) -> String {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/auth/desktop-exchange/create")
                .header(header::AUTHORIZATION, format!("Bearer {jwt}"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "codeChallenge": challenge }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK, "create should succeed");
    let json = body_json(response).await;
    json["authCode"].as_str().expect("authCode").to_string()
}

async fn redeem(app: &Router, auth_code: &str, verifier: &str) -> axum::response::Response {
    app.clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/auth/desktop-exchange/redeem")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "authCode": auth_code, "codeVerifier": verifier }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap()
}

#[tokio::test]
#[ignore = "requires local Postgres"]
async fn create_redeem_mints_independent_session_and_is_single_use() {
    let server = MockServer::start().await;
    mount_gotrue(&server).await;
    let minter: Arc<dyn SessionMinter> = Arc::new(
        SupabaseAdminClient::new(
            &server.uri(),
            SecretString::from(SERVICE_ROLE_KEY.to_string()),
        )
        .unwrap(),
    );

    let state = build_app_state(test_pool().await, Some(minter)).await;
    let app = desktop_router(state);

    let user_id = Uuid::new_v4();
    let jwt = sign_test_jwt(user_id);
    let (verifier, challenge) = pkce_pair();

    let code = create_code(&app, &jwt, &challenge).await;

    // Redeem → the freshly minted, independent session (NOT any web token).
    let response = redeem(&app, &code, &verifier).await;
    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["accessToken"], MINTED_ACCESS);
    assert_eq!(json["refreshToken"], MINTED_REFRESH);

    // Second redeem of the same code → 401 (single-use).
    let second = redeem(&app, &code, &verifier).await;
    assert_eq!(second.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
#[ignore = "requires local Postgres"]
async fn redeem_rejects_wrong_pkce_verifier() {
    let server = MockServer::start().await;
    mount_gotrue(&server).await;
    let minter: Arc<dyn SessionMinter> = Arc::new(
        SupabaseAdminClient::new(
            &server.uri(),
            SecretString::from(SERVICE_ROLE_KEY.to_string()),
        )
        .unwrap(),
    );
    let state = build_app_state(test_pool().await, Some(minter)).await;
    let app = desktop_router(state);

    let jwt = sign_test_jwt(Uuid::new_v4());
    let (_verifier, challenge) = pkce_pair();
    let code = create_code(&app, &jwt, &challenge).await;

    // Wrong verifier → PKCE mismatch → 401 (and the code is consumed).
    let response = redeem(&app, &code, "the-wrong-verifier-entirely").await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
#[ignore = "requires local Postgres"]
async fn redeem_unknown_code_returns_401() {
    let server = MockServer::start().await;
    mount_gotrue(&server).await;
    let minter: Arc<dyn SessionMinter> = Arc::new(
        SupabaseAdminClient::new(
            &server.uri(),
            SecretString::from(SERVICE_ROLE_KEY.to_string()),
        )
        .unwrap(),
    );
    let state = build_app_state(test_pool().await, Some(minter)).await;
    let app = desktop_router(state);

    let unknown = format!("{:064x}", rand::random::<u128>());
    let response = redeem(&app, &unknown, "any-verifier").await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
#[ignore = "requires local Postgres"]
async fn redeem_without_minter_returns_502() {
    // No session minter configured (service-role key unset).
    let state = build_app_state(test_pool().await, None).await;
    let app = desktop_router(state);

    let jwt = sign_test_jwt(Uuid::new_v4());
    let (verifier, challenge) = pkce_pair();
    let code = create_code(&app, &jwt, &challenge).await;

    let response = redeem(&app, &code, &verifier).await;
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
}
