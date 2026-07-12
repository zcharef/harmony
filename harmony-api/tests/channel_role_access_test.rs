#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Roles v2 Phase A — `channel_role_access` grant-management endpoint.
//!
//! Proves the new write path (`PUT /v1/servers/{id}/channels/{cid}/role-access`)
//! and its read companion (`GET`) against a real Postgres + the production
//! handlers over HTTP (`tower::ServiceExt::oneshot`, real `PgNotifyEventBus`):
//!
//! - The BLOCKER regression pair: a plain member cannot see a private channel
//!   until an admin grants their role, and loses it again on revoke. `PUT` is
//!   proven equivalent to the enforce path (`list_channels` visibility AND
//!   `has_private_channel_access`) so the write can never drift from the read.
//! - Only `moderator`/`member` are grantable (`admin`/`owner` → 400), preserving
//!   the read path's invariant that the table holds no implicit role.
//! - Admin-only (non-admin → 403), path-integrity (foreign channel → 404),
//!   idempotency (same body twice → one row set), and the `channel.access_updated`
//!   SSE broadcast carrying the granted role set.
//!
//! WHY `#[ignore]`: requires a running Postgres with the Harmony schema (mirrors
//! the SSE-scope, read-state, mentions, DM and voice integration tests). Run:
//!   `DATABASE_URL=... cargo test --test channel_role_access_test -- --ignored`

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

use harmony_api::api::handlers::channels;
use harmony_api::api::middleware::auth::require_auth;
use harmony_api::api::state::AppState;
use harmony_api::domain::models::UserId;
use harmony_api::domain::models::{ChannelId, Role, ServerEvent};
use harmony_api::domain::ports::{ChannelRepository, LiveKitTokenGenerator, VoiceGrants};
use harmony_api::domain::services::{ContentFilter, SpamGuard, VoiceService};
use harmony_api::infra::PgPresenceTracker;
use harmony_api::infra::pg_notify_event_bus::PgNotifyEventBus;
use harmony_api::infra::plan_always_allowed::AlwaysAllowedChecker;
use harmony_api::infra::postgres::{
    PgBanRepository, PgChannelRepository, PgDesktopAuthRepository, PgDmRepository,
    PgInviteRepository, PgKeyRepository, PgMegolmSessionRepository, PgMemberRepository,
    PgMessageRepository, PgModerationRetryRepository, PgNotificationSettingsRepository,
    PgProfileRepository, PgReactionRepository, PgReadStateRepository, PgServerRepository,
    PgUserPreferencesRepository, PgVoiceSessionRepository,
};

const TEST_JWT_SECRET: &str = "test-jwt-secret-for-integration-tests-only-32ch";

// ── DB pool (mirrors sse_channel_voice_scope_test) ───────────────────────

async fn test_pool() -> PgPool {
    dotenvy::dotenv().ok();
    let url =
        std::env::var("DATABASE_URL").expect("DATABASE_URL must be set for integration tests");
    PgPool::connect(&url)
        .await
        .expect("Failed to connect to test database")
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
    .bind(format!("cra-{uid}@example.com"))
    .execute(pool)
    .await
    .expect("seed auth.users");

    let username = format!("cra{}", &uid.simple().to_string()[..10]);
    sqlx::query(
        r#"
        INSERT INTO profiles (id, username, display_name)
        VALUES ($1, $2, 'CRA Test')
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
    sqlx::query("INSERT INTO servers (id, name, owner_id) VALUES ($1, 'CRA Server', $2)")
        .bind(sid)
        .bind(owner)
        .execute(pool)
        .await
        .expect("seed server");
    sid
}

async fn seed_membership(pool: &PgPool, server: Uuid, user: Uuid, role: &str) {
    sqlx::query(
        "INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, $3) \
         ON CONFLICT (server_id, user_id) DO NOTHING",
    )
    .bind(server)
    .bind(user)
    .bind(role)
    .execute(pool)
    .await
    .expect("seed server_members");
}

async fn seed_channel(pool: &PgPool, server: Uuid, name: &str, is_private: bool) -> Uuid {
    let cid = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channels (id, server_id, name, is_private, position) \
         VALUES ($1, $2, $3, $4, 0)",
    )
    .bind(cid)
    .bind(server)
    .bind(name)
    .bind(is_private)
    .execute(pool)
    .await
    .expect("seed channel");
    cid
}

async fn count_grants(pool: &PgPool, channel: Uuid) -> i64 {
    sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM channel_role_access WHERE channel_id = $1")
        .bind(channel)
        .fetch_one(pool)
        .await
        .expect("count grants")
}

async fn cleanup(pool: &PgPool, server: Uuid, users: &[Uuid]) {
    let _ = sqlx::query("DELETE FROM servers WHERE id = $1")
        .bind(server)
        .execute(pool)
        .await;
    let _ = sqlx::query("DELETE FROM auth.users WHERE id = ANY($1)")
        .bind(users.to_vec())
        .execute(pool)
        .await;
}

// ── HTTP harness (mirrors sse_channel_voice_scope_test) ──────────────────

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
        "email": "cra-test@example.com",
        "iat": now,
        "exp": now + 3600,
        "user_metadata": { "email_verified": true },
    });
    let header = JwtHeader::new(Algorithm::HS256);
    let key = EncodingKey::from_secret(TEST_JWT_SECRET.as_bytes());
    jsonwebtoken::encode(&header, &claims, &key).expect("JWT encoding should succeed")
}

#[allow(clippy::too_many_lines)]
async fn build_handler_app_state(pool: PgPool) -> AppState {
    let channel_repo = Arc::new(PgChannelRepository::new(pool.clone()));
    let member_repo = Arc::new(PgMemberRepository::new(pool.clone()));
    let plan_checker: Arc<dyn harmony_api::domain::ports::PlanLimitChecker> =
        Arc::new(AlwaysAllowedChecker);
    let voice_repo: Arc<dyn harmony_api::domain::ports::VoiceSessionRepository> =
        Arc::new(PgVoiceSessionRepository::new(pool.clone()));
    let livekit: Arc<dyn LiveKitTokenGenerator> = Arc::new(FakeLiveKitTokenGenerator);

    let voice_service = Some(Arc::new(VoiceService::new(
        voice_repo.clone(),
        channel_repo.clone(),
        member_repo.clone(),
        plan_checker.clone(),
        livekit,
        Arc::new(harmony_api::infra::postgres::PgAnalyticsRecorder::new(
            pool.clone(),
        )),
    )));

    let profile_repo: Arc<dyn harmony_api::domain::ports::ProfileRepository> =
        Arc::new(PgProfileRepository::new(pool.clone()));
    let server_repo = Arc::new(PgServerRepository::new(pool.clone()));
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

    let instance_id = Uuid::new_v4();
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
        voice_service,
        Some(voice_repo),
        None, // official_server_id
        analytics_recorder,
        Some("https://test.supabase.co".to_string()),
        None,
    )
}

/// Router with the role-access endpoints + `list_channels` (used to assert
/// end-to-end visibility parity between the write path and the read path).
fn role_access_router(state: AppState) -> Router {
    let authenticated = Router::new()
        .route("/v1/servers/{id}/channels", get(channels::list_channels))
        .route(
            "/v1/servers/{id}/channels/{channel_id}/role-access",
            get(channels::get_channel_role_access).put(channels::set_channel_role_access),
        )
        .route_layer(middleware::from_fn_with_state(state.clone(), require_auth));

    Router::new().merge(authenticated).with_state(state)
}

fn authed_request(
    method: &str,
    uri: &str,
    jwt: &str,
    body: Option<serde_json::Value>,
) -> Request<Body> {
    let builder = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::AUTHORIZATION, format!("Bearer {jwt}"));
    match body {
        Some(json) => builder
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(json.to_string()))
            .expect("build request"),
        None => builder.body(Body::empty()).expect("build request"),
    }
}

async fn body_json(response: axum::response::Response) -> serde_json::Value {
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("read response body");
    serde_json::from_slice(&bytes).expect("parse response body as JSON")
}

fn drain_events(rx: &mut tokio::sync::broadcast::Receiver<ServerEvent>) -> Vec<ServerEvent> {
    let mut events = Vec::new();
    while let Ok(event) = rx.try_recv() {
        events.push(event);
    }
    events
}

/// True when the caller's `list_channels` response contains `channel`.
async fn member_sees_channel(router: &Router, server: Uuid, jwt: &str, channel: Uuid) -> bool {
    let res = router
        .clone()
        .oneshot(authed_request(
            "GET",
            &format!("/v1/servers/{server}/channels"),
            jwt,
            None,
        ))
        .await
        .expect("list channels");
    assert_eq!(res.status(), StatusCode::OK);
    let json = body_json(res).await;
    json["items"]
        .as_array()
        .expect("items array")
        .iter()
        .any(|c| c["id"].as_str() == Some(&channel.to_string()))
}

// ── Tests ────────────────────────────────────────────────────────────────

/// THE BLOCKER regression pair + enforce-path parity: an admin PUT granting the
/// `member` role makes a private channel visible to a plain member (and to the
/// read-path helper), and an empty PUT revokes it. Reverting either direction —
/// or letting the write path drift from `list_channels` — fails this test.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn grant_then_revoke_toggles_member_visibility_and_enforce_path() {
    let pool = test_pool().await;
    let owner = seed_user(&pool).await;
    let member = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    seed_membership(&pool, server, owner, "owner").await;
    seed_membership(&pool, server, member, "member").await;
    let channel = seed_channel(&pool, server, "cra-private", true).await;

    let state = build_handler_app_state(pool.clone()).await;
    let repo = PgChannelRepository::new(pool.clone());
    let mut rx = state.event_bus().subscribe();
    let router = role_access_router(state);
    let owner_jwt = sign_test_jwt(owner);
    let member_jwt = sign_test_jwt(member);
    let cid = ChannelId::new(channel);

    // Before any grant: member cannot see it, and neither can the enforce path.
    assert!(!member_sees_channel(&router, server, &member_jwt, channel).await);
    assert!(
        !repo
            .has_private_channel_access(&cid, Role::Member)
            .await
            .unwrap()
    );

    // Admin grants the member role.
    let res = router
        .clone()
        .oneshot(authed_request(
            "PUT",
            &format!("/v1/servers/{server}/channels/{channel}/role-access"),
            &owner_jwt,
            Some(serde_json::json!({ "roles": ["member"] })),
        ))
        .await
        .expect("grant");
    assert_eq!(res.status(), StatusCode::OK);
    let body = body_json(res).await;
    assert_eq!(body["roles"], serde_json::json!(["member"]));

    // The grant fanned out as channel.access_updated with the granted role set.
    let events = drain_events(&mut rx);
    assert_eq!(events.len(), 1, "exactly one event per grant write");
    assert_eq!(events[0].event_name(), "channel.access_updated");
    let json = serde_json::to_value(&events[0]).unwrap();
    assert_eq!(json["channelId"], channel.to_string());
    assert_eq!(json["authorizedRoles"], serde_json::json!(["member"]));

    // Write ≡ read: member now sees it AND the enforce helper agrees.
    assert!(member_sees_channel(&router, server, &member_jwt, channel).await);
    assert!(
        repo.has_private_channel_access(&cid, Role::Member)
            .await
            .unwrap()
    );

    // Empty PUT revokes every grant.
    let res = router
        .clone()
        .oneshot(authed_request(
            "PUT",
            &format!("/v1/servers/{server}/channels/{channel}/role-access"),
            &owner_jwt,
            Some(serde_json::json!({ "roles": [] })),
        ))
        .await
        .expect("revoke");
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(count_grants(&pool, channel).await, 0);
    assert!(!member_sees_channel(&router, server, &member_jwt, channel).await);
    assert!(
        !repo
            .has_private_channel_access(&cid, Role::Member)
            .await
            .unwrap()
    );

    cleanup(&pool, server, &[owner, member]).await;
}

/// `admin`/`owner` are never grantable (they hold implicit access): each is
/// rejected with 400, and NO row is written — preserving the read-path invariant
/// that the grant table only ever stores `moderator`/`member`.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn implicit_roles_are_rejected() {
    let pool = test_pool().await;
    let owner = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    seed_membership(&pool, server, owner, "owner").await;
    let channel = seed_channel(&pool, server, "cra-implicit", true).await;

    let state = build_handler_app_state(pool.clone()).await;
    let router = role_access_router(state);
    let owner_jwt = sign_test_jwt(owner);

    for bad in ["admin", "owner"] {
        let res = router
            .clone()
            .oneshot(authed_request(
                "PUT",
                &format!("/v1/servers/{server}/channels/{channel}/role-access"),
                &owner_jwt,
                Some(serde_json::json!({ "roles": [bad] })),
            ))
            .await
            .expect("put");
        assert_eq!(
            res.status(),
            StatusCode::BAD_REQUEST,
            "{bad} must be rejected"
        );
    }
    assert_eq!(
        count_grants(&pool, channel).await,
        0,
        "no row must be written"
    );

    cleanup(&pool, server, &[owner]).await;
}

/// Non-admins cannot manage grants (403), and idempotency holds: the same body
/// twice yields one row set; GET returns exactly the stored grantable roles.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn non_admin_forbidden_and_put_is_idempotent() {
    let pool = test_pool().await;
    let owner = seed_user(&pool).await;
    let member = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    seed_membership(&pool, server, owner, "owner").await;
    seed_membership(&pool, server, member, "member").await;
    let channel = seed_channel(&pool, server, "cra-idem", true).await;

    let state = build_handler_app_state(pool.clone()).await;
    let router = role_access_router(state);
    let owner_jwt = sign_test_jwt(owner);
    let member_jwt = sign_test_jwt(member);

    // A plain member forging the request is forbidden (PUT and GET).
    for method in ["PUT", "GET"] {
        let body = (method == "PUT").then(|| serde_json::json!({ "roles": ["member"] }));
        let res = router
            .clone()
            .oneshot(authed_request(
                method,
                &format!("/v1/servers/{server}/channels/{channel}/role-access"),
                &member_jwt,
                body,
            ))
            .await
            .expect("member request");
        assert_eq!(res.status(), StatusCode::FORBIDDEN, "{method} by member");
    }

    // Idempotent: same body twice → 200 both, single row set.
    for _ in 0..2 {
        let res = router
            .clone()
            .oneshot(authed_request(
                "PUT",
                &format!("/v1/servers/{server}/channels/{channel}/role-access"),
                &owner_jwt,
                Some(serde_json::json!({ "roles": ["member", "moderator"] })),
            ))
            .await
            .expect("put");
        assert_eq!(res.status(), StatusCode::OK);
    }
    assert_eq!(count_grants(&pool, channel).await, 2);

    // GET returns exactly the stored grantable roles (never admin/owner).
    let res = router
        .clone()
        .oneshot(authed_request(
            "GET",
            &format!("/v1/servers/{server}/channels/{channel}/role-access"),
            &owner_jwt,
            None,
        ))
        .await
        .expect("get");
    assert_eq!(res.status(), StatusCode::OK);
    let mut roles = body_json(res).await["roles"]
        .as_array()
        .expect("roles array")
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    roles.sort();
    assert_eq!(roles, vec!["member".to_string(), "moderator".to_string()]);

    cleanup(&pool, server, &[owner, member]).await;
}

/// Path integrity: a `channel_id` from another server is a 404, even for an
/// admin of the path server — the endpoint must never act on / leak a foreign
/// channel's grants.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn foreign_channel_is_not_found() {
    let pool = test_pool().await;
    let owner = seed_user(&pool).await;
    let server_a = seed_server(&pool, owner).await;
    let server_b = seed_server(&pool, owner).await;
    seed_membership(&pool, server_a, owner, "owner").await;
    seed_membership(&pool, server_b, owner, "owner").await;
    let channel_b = seed_channel(&pool, server_b, "cra-foreign", true).await;

    let state = build_handler_app_state(pool.clone()).await;
    let router = role_access_router(state);
    let owner_jwt = sign_test_jwt(owner);

    // Path says server_a, but the channel belongs to server_b → 404.
    let res = router
        .clone()
        .oneshot(authed_request(
            "PUT",
            &format!("/v1/servers/{server_a}/channels/{channel_b}/role-access"),
            &owner_jwt,
            Some(serde_json::json!({ "roles": ["member"] })),
        ))
        .await
        .expect("put");
    assert_eq!(res.status(), StatusCode::NOT_FOUND);

    cleanup(&pool, server_a, &[]).await;
    cleanup(&pool, server_b, &[owner]).await;
}
