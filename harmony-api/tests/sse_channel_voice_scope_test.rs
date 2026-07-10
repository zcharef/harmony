#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! F5 regression: channel/voice SSE events must be gated on channel access.
//!
//! WHY: `ChannelCreated/Updated/Deleted` and `VoiceStateUpdate` were fanned out
//! by server membership alone, so a member with no grant to a private channel
//! still received its name/topic and voice roster over `/v1/events`. The fix
//! attaches the F3 `channel_access` routing metadata to those four variants at
//! every publish site; the existing SSE Stage-2 gate + redaction then apply.
//!
//! Split of proof (mirrors F3):
//! - The Stage-2 drop/deliver decision per receiver role is unit-tested in
//!   `api/handlers/events.rs` (`private_channel_and_voice_events_dropped_for_
//!   ungranted_member` + the public-channel reactivity control).
//! - Accessor + redaction (wire payload byte-identical) are unit-tested in
//!   `domain/models/server_event.rs`.
//! - THIS file proves (a) the resolver the publish sites rely on against a
//!   real Postgres `channel_role_access` table: public → `None`, private →
//!   the granted role set, missing channel → `None` (why `delete_channel`
//!   must resolve BEFORE deleting); and (b) THE PUBLISH-SITE WIRING itself:
//!   the real handlers are invoked over HTTP (`tower::ServiceExt::oneshot`,
//!   real DB, real `PgNotifyEventBus`) and every published event is asserted
//!   to carry `channel_access() == Some(scope)` for a private channel and
//!   `None` for a public one — including the `delete_channel` pre-delete
//!   snapshot (cascade voice Left + channel.deleted). Reverting a handler to
//!   `channel_access: None`, or resolving after deletion, fails these tests.
//!
//! WHY `#[ignore]`: requires a running Postgres with the Harmony schema (mirrors
//! the read-state, mentions, DM, ban and voice integration tests). Run with:
//!   `DATABASE_URL=... cargo test --test sse_channel_voice_scope_test -- --ignored`

use sqlx::PgPool;
use uuid::Uuid;

use harmony_api::domain::models::{ChannelId, Role};
use harmony_api::domain::services::resolve_channel_access_by_id;
use harmony_api::infra::postgres::PgChannelRepository;

// ── DB pool (mirrors read_state_access_test) ─────────────────────────────

async fn test_pool() -> PgPool {
    dotenvy::dotenv().ok();
    let url =
        std::env::var("DATABASE_URL").expect("DATABASE_URL must be set for integration tests");
    PgPool::connect(&url)
        .await
        .expect("Failed to connect to test database")
}

// ── Seeding (mirrors read_state_access_test) ─────────────────────────────

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
    .bind(format!("f5-{uid}@example.com"))
    .execute(pool)
    .await
    .expect("seed auth.users");

    let username = format!("f5{}", &uid.simple().to_string()[..10]);
    sqlx::query(
        r#"
        INSERT INTO profiles (id, username, display_name)
        VALUES ($1, $2, 'F5 Scope')
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
    sqlx::query("INSERT INTO servers (id, name, owner_id) VALUES ($1, 'F5 Scope Server', $2)")
        .bind(sid)
        .bind(owner)
        .execute(pool)
        .await
        .expect("seed server");
    sid
}

async fn seed_channel(pool: &PgPool, server: Uuid, name: &str, is_private: bool) -> Uuid {
    let cid = Uuid::new_v4();
    sqlx::query("INSERT INTO channels (id, server_id, name, is_private) VALUES ($1, $2, $3, $4)")
        .bind(cid)
        .bind(server)
        .bind(name)
        .bind(is_private)
        .execute(pool)
        .await
        .expect("seed channel");
    cid
}

async fn grant_channel_role(pool: &PgPool, channel: Uuid, role: &str) {
    sqlx::query("INSERT INTO channel_role_access (channel_id, role) VALUES ($1, $2)")
        .bind(channel)
        .bind(role)
        .execute(pool)
        .await
        .expect("grant channel_role_access");
}

async fn cleanup(pool: &PgPool, server: Uuid, users: &[Uuid]) {
    // Server delete cascades to channels → channel_role_access. Owner FK is
    // ON DELETE RESTRICT, so drop the server before the users.
    let _ = sqlx::query("DELETE FROM servers WHERE id = $1")
        .bind(server)
        .execute(pool)
        .await;
    let _ = sqlx::query("DELETE FROM auth.users WHERE id = ANY($1)")
        .bind(users.to_vec())
        .execute(pool)
        .await;
}

// ── Tests ────────────────────────────────────────────────────────────────

/// The publish-site resolver must produce, from real `channels` +
/// `channel_role_access` rows, exactly the routing scope the Stage-2 gate
/// needs: `None` for public (deliver to all members — the reactivity
/// invariant), `Some(granted roles)` for private (ungranted members dropped).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn resolver_maps_channel_privacy_to_routing_scope() {
    let pool = test_pool().await;
    let repo = PgChannelRepository::new(pool.clone());

    let owner = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    let public_channel = seed_channel(&pool, server, "f5-public", false).await;
    let private_ungranted = seed_channel(&pool, server, "f5-priv-ungranted", true).await;
    let private_granted = seed_channel(&pool, server, "f5-priv-granted", true).await;
    grant_channel_role(&pool, private_granted, "member").await;

    // Public → None: delivered by server membership alone. This is the
    // control guarding against over-gating (public events must keep flowing
    // to every member in real time).
    let scope = resolve_channel_access_by_id(&repo, &ChannelId::new(public_channel))
        .await
        .expect("resolve public");
    assert!(scope.is_none(), "public channel must resolve to None");

    // Private, no grants → Some([]): only Owner/Admin (implicit) receive its
    // events — a fresh private channel's exact state (grants come later).
    let scope = resolve_channel_access_by_id(&repo, &ChannelId::new(private_ungranted))
        .await
        .expect("resolve private ungranted")
        .expect("private channel must carry a scope");
    assert!(
        scope.authorized_roles.is_empty(),
        "ungranted private channel must expose an empty grant set, got {:?}",
        scope.authorized_roles
    );

    // Private with a member grant → Some([Member]): granted members receive
    // events, everything else is dropped by the Stage-2 gate.
    let scope = resolve_channel_access_by_id(&repo, &ChannelId::new(private_granted))
        .await
        .expect("resolve private granted")
        .expect("private channel must carry a scope");
    assert_eq!(scope.authorized_roles, vec![Role::Member]);

    cleanup(&pool, server, &[owner]).await;
}

/// A missing channel resolves to `None` (public). This documents WHY
/// `delete_channel` (and `delete_server`) must resolve the scope BEFORE the
/// row is deleted: resolving after would fail open and broadcast a private
/// channel's deletion + voice roster to the whole server.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn missing_channel_resolves_to_public_hence_pre_delete_snapshot() {
    let pool = test_pool().await;
    let repo = PgChannelRepository::new(pool.clone());

    let owner = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    let private_channel = seed_channel(&pool, server, "f5-priv-doomed", true).await;
    grant_channel_role(&pool, private_channel, "moderator").await;

    let channel_id = ChannelId::new(private_channel);

    // Pre-delete: the snapshot the handlers take — carries the grant set.
    let pre = resolve_channel_access_by_id(&repo, &channel_id)
        .await
        .expect("resolve pre-delete")
        .expect("private channel must carry a scope");
    assert_eq!(pre.authorized_roles, vec![Role::Moderator]);

    sqlx::query("DELETE FROM channels WHERE id = $1")
        .bind(private_channel)
        .execute(&pool)
        .await
        .expect("delete channel");

    // Post-delete: the row (and its grants) are gone → resolves to None
    // (public). Publishing with THIS value would leak — hence the pre-delete
    // snapshot in `delete_channel` / `delete_server`.
    let post = resolve_channel_access_by_id(&repo, &channel_id)
        .await
        .expect("resolve post-delete");
    assert!(
        post.is_none(),
        "missing channel must resolve to None — the leak the pre-delete snapshot prevents"
    );

    cleanup(&pool, server, &[owner]).await;
}

// ═════════════════════════════════════════════════════════════════════════
// Handler-level publish-site wiring (ticket §7.3 floor)
//
// Mirrors the `voice_endpoint_test.rs` harness: full AppState with real
// Postgres repos + a subscribable `PgNotifyEventBus`, real handlers oneshot
// over HTTP. Each test subscribes BEFORE the request and asserts the emitted
// `ServerEvent.channel_access()` — the exact input to the SSE Stage-2 gate.
// ═════════════════════════════════════════════════════════════════════════

use std::sync::Arc;

use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode, header},
    middleware,
    routing::{patch, post},
};
use jsonwebtoken::{Algorithm, EncodingKey, Header as JwtHeader};
use secrecy::SecretString;
use tower::ServiceExt;

use harmony_api::api::handlers::{channels, voice};
use harmony_api::api::middleware::auth::require_auth;
use harmony_api::api::state::AppState;
use harmony_api::domain::models::{ChannelAccessScope, ServerEvent, UserId};
use harmony_api::domain::ports::{LiveKitTokenGenerator, VoiceGrants};
use harmony_api::domain::services::{ContentFilter, SpamGuard, VoiceService};
use harmony_api::infra::PgPresenceTracker;
use harmony_api::infra::pg_notify_event_bus::PgNotifyEventBus;
use harmony_api::infra::plan_always_allowed::AlwaysAllowedChecker;
use harmony_api::infra::postgres::{
    PgBanRepository, PgDesktopAuthRepository, PgDmRepository, PgInviteRepository, PgKeyRepository,
    PgMegolmSessionRepository, PgMemberRepository, PgMessageRepository,
    PgModerationRetryRepository, PgNotificationSettingsRepository, PgProfileRepository,
    PgReactionRepository, PgReadStateRepository, PgServerRepository, PgUserPreferencesRepository,
    PgVoiceSessionRepository,
};

const TEST_JWT_SECRET: &str = "test-jwt-secret-for-integration-tests-only-32ch";

/// In-process `LiveKitTokenGenerator` returning deterministic fake tokens.
/// WHY: These tests verify SSE routing metadata, not `LiveKit` JWT internals.
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

/// WHY: Both `aws_lc_rs` and `rust_crypto` jsonwebtoken providers are enabled
/// crate-wide; auto-detection panics. Install one explicitly (process-wide
/// singleton — `let _ =` swallows the harmless second-call `Err`).
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
        "email": "f5-scope-test@example.com",
        "iat": now,
        "exp": now + 3600,
        "user_metadata": { "email_verified": true },
    });
    let header = JwtHeader::new(Algorithm::HS256);
    let key = EncodingKey::from_secret(TEST_JWT_SECRET.as_bytes());
    jsonwebtoken::encode(&header, &claims, &key).expect("JWT encoding should succeed")
}

/// Full `AppState` with voice enabled — same wiring as `voice_endpoint_test.rs`.
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
        voice_service,
        Some(voice_repo),
        None, // official_server_id
        analytics_recorder,
        Some("https://test.supabase.co".to_string()), // attachment_url_origin
        None,
    )
}

/// Production-shaped router for the six F5 publish-site handlers.
fn f5_router(state: AppState) -> Router {
    let authenticated = Router::new()
        .route("/v1/servers/{id}/channels", post(channels::create_channel))
        .route(
            "/v1/servers/{id}/channels/{channel_id}",
            patch(channels::update_channel).delete(channels::delete_channel),
        )
        .route("/v1/channels/{id}/voice/join", post(voice::join_voice))
        .route("/v1/channels/{id}/voice/leave", post(voice::leave_voice))
        .route("/v1/voice/state", patch(voice::update_voice_state))
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

/// Collect every event the handler published during the oneshot call.
/// WHY sync drain: `EventBus::publish` sends on the local broadcast channel
/// before the handler returns, so all events are already buffered here.
fn drain_events(rx: &mut tokio::sync::broadcast::Receiver<ServerEvent>) -> Vec<ServerEvent> {
    let mut events = Vec::new();
    while let Ok(event) = rx.try_recv() {
        events.push(event);
    }
    events
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

async fn seed_voice_channel(pool: &PgPool, server: Uuid, name: &str, is_private: bool) -> Uuid {
    let cid = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channels (id, server_id, name, channel_type, is_private, position) \
         VALUES ($1, $2, $3, 'voice'::channel_type, $4, 0)",
    )
    .bind(cid)
    .bind(server)
    .bind(name)
    .bind(is_private)
    .execute(pool)
    .await
    .expect("seed voice channel");
    cid
}

/// `create_channel`/`update_channel` must publish `channel.created`/`.updated`
/// carrying the resolved scope: `Some` (with the real grant set) for a private
/// channel, `None` for a public one (over-gating control). Reverting the
/// handler wiring to `channel_access: None` fails this test.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn channel_handlers_publish_events_with_resolved_scope() {
    let pool = test_pool().await;
    let owner = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    seed_membership(&pool, server, owner, "owner").await;

    let state = build_handler_app_state(pool.clone()).await;
    let mut rx = state.event_bus().subscribe();
    let router = f5_router(state);
    let jwt = sign_test_jwt(owner);

    // Private create → scope present (fresh private channel = empty grant set:
    // only Owner/Admin receive it — Discord parity).
    let res = router
        .clone()
        .oneshot(authed_request(
            "POST",
            &format!("/v1/servers/{server}/channels"),
            &jwt,
            Some(serde_json::json!({"name": "f5-priv-live", "isPrivate": true})),
        ))
        .await
        .expect("create private channel");
    assert_eq!(res.status(), StatusCode::CREATED);
    let private_id = body_json(res).await["id"]
        .as_str()
        .expect("channel id")
        .to_string();
    let events = drain_events(&mut rx);
    assert_eq!(events.len(), 1, "exactly one event per create");
    assert_eq!(events[0].event_name(), "channel.created");
    assert_eq!(
        events[0].channel_access(),
        Some(&ChannelAccessScope {
            authorized_roles: vec![]
        }),
        "private channel.created must carry its (empty) grant scope"
    );

    // Public create → no scope (delivered to every member — the reactivity
    // control against over-gating).
    let res = router
        .clone()
        .oneshot(authed_request(
            "POST",
            &format!("/v1/servers/{server}/channels"),
            &jwt,
            Some(serde_json::json!({"name": "f5-public-live"})),
        ))
        .await
        .expect("create public channel");
    assert_eq!(res.status(), StatusCode::CREATED);
    let events = drain_events(&mut rx);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].event_name(), "channel.created");
    assert!(
        events[0].channel_access().is_none(),
        "public channel.created must carry no scope"
    );

    // Grant Member, then PATCH → channel.updated carries the granted role set.
    grant_channel_role(&pool, Uuid::parse_str(&private_id).expect("uuid"), "member").await;
    let res = router
        .clone()
        .oneshot(authed_request(
            "PATCH",
            &format!("/v1/servers/{server}/channels/{private_id}"),
            &jwt,
            Some(serde_json::json!({"topic": "war room"})),
        ))
        .await
        .expect("update private channel");
    assert_eq!(res.status(), StatusCode::OK);
    let events = drain_events(&mut rx);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].event_name(), "channel.updated");
    assert_eq!(
        events[0].channel_access(),
        Some(&ChannelAccessScope {
            authorized_roles: vec![Role::Member]
        }),
        "private channel.updated must carry the granted role set"
    );

    cleanup(&pool, server, &[owner]).await;
}

/// `join_voice`/`update_voice_state`/`leave_voice` must publish
/// `voice.state_update` carrying the private voice channel's scope — the
/// roster (userId, displayName, mute/deaf) only reaches authorized roles.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn voice_handlers_publish_events_with_resolved_scope() {
    let pool = test_pool().await;
    let owner = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    seed_membership(&pool, server, owner, "owner").await;
    let voice_channel = seed_voice_channel(&pool, server, "f5-voice-priv", true).await;
    grant_channel_role(&pool, voice_channel, "moderator").await;

    let state = build_handler_app_state(pool.clone()).await;
    let mut rx = state.event_bus().subscribe();
    let router = f5_router(state);
    let jwt = sign_test_jwt(owner);
    let expected_scope = ChannelAccessScope {
        authorized_roles: vec![Role::Moderator],
    };

    // Join → voice.state_update (joined) carries the scope.
    let res = router
        .clone()
        .oneshot(authed_request(
            "POST",
            &format!("/v1/channels/{voice_channel}/voice/join"),
            &jwt,
            None,
        ))
        .await
        .expect("join voice");
    assert_eq!(res.status(), StatusCode::OK);
    let session_id = body_json(res).await["sessionId"]
        .as_str()
        .expect("session id")
        .to_string();
    let events = drain_events(&mut rx);
    assert_eq!(events.len(), 1, "exactly one event per join");
    assert_eq!(events[0].event_name(), "voice.state_update");
    assert_eq!(
        events[0].channel_access(),
        Some(&expected_scope),
        "voice join must carry the private channel's scope"
    );

    // Mute → voice.state_update (muted) carries the scope.
    let res = router
        .clone()
        .oneshot(authed_request(
            "PATCH",
            "/v1/voice/state",
            &jwt,
            Some(serde_json::json!({
                "sessionId": session_id,
                "isMuted": true,
                "isDeafened": false,
            })),
        ))
        .await
        .expect("update voice state");
    assert_eq!(res.status(), StatusCode::NO_CONTENT);
    let events = drain_events(&mut rx);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].event_name(), "voice.state_update");
    assert_eq!(
        events[0].channel_access(),
        Some(&expected_scope),
        "voice mute/deaf must carry the private channel's scope"
    );

    // Leave → voice.state_update (left) carries the scope.
    let res = router
        .clone()
        .oneshot(authed_request(
            "POST",
            &format!("/v1/channels/{voice_channel}/voice/leave"),
            &jwt,
            None,
        ))
        .await
        .expect("leave voice");
    assert_eq!(res.status(), StatusCode::NO_CONTENT);
    let events = drain_events(&mut rx);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].event_name(), "voice.state_update");
    assert_eq!(
        events[0].channel_access(),
        Some(&expected_scope),
        "voice leave must carry the private channel's scope"
    );

    cleanup(&pool, server, &[owner]).await;
}

/// THE SUBTLE SITE (ticket §4.3 / decision #4): `delete_channel` must resolve
/// the scope from a PRE-delete snapshot and reuse it for BOTH the cascade
/// voice Left events and `channel.deleted`. Resolving after deletion returns
/// `None` (missing channel = public) and would broadcast a private voice
/// channel's roster + deletion to the whole server — this test fails then.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn delete_channel_uses_pre_delete_scope_snapshot() {
    let pool = test_pool().await;
    let owner = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    seed_membership(&pool, server, owner, "owner").await;
    let voice_channel = seed_voice_channel(&pool, server, "f5-voice-doomed", true).await;
    grant_channel_role(&pool, voice_channel, "moderator").await;
    // WHY: a server's last channel cannot be deleted — keep one more around.
    let _keeper = seed_channel(&pool, server, "f5-keeper", false).await;

    let state = build_handler_app_state(pool.clone()).await;
    let mut rx = state.event_bus().subscribe();
    let router = f5_router(state);
    let jwt = sign_test_jwt(owner);
    let expected_scope = ChannelAccessScope {
        authorized_roles: vec![Role::Moderator],
    };

    // Put an active voice session in the doomed channel so the delete cascades.
    let res = router
        .clone()
        .oneshot(authed_request(
            "POST",
            &format!("/v1/channels/{voice_channel}/voice/join"),
            &jwt,
            None,
        ))
        .await
        .expect("join voice");
    assert_eq!(res.status(), StatusCode::OK);
    drain_events(&mut rx); // Discard the join event — covered above.

    let res = router
        .clone()
        .oneshot(authed_request(
            "DELETE",
            &format!("/v1/servers/{server}/channels/{voice_channel}"),
            &jwt,
            None,
        ))
        .await
        .expect("delete channel");
    assert_eq!(res.status(), StatusCode::NO_CONTENT);

    let events = drain_events(&mut rx);
    let left = events
        .iter()
        .find(|e| e.event_name() == "voice.state_update")
        .expect("cascade voice Left event must be published");
    assert_eq!(
        left.channel_access(),
        Some(&expected_scope),
        "cascade voice Left must carry the PRE-delete private scope"
    );
    let deleted = events
        .iter()
        .find(|e| e.event_name() == "channel.deleted")
        .expect("channel.deleted event must be published");
    assert_eq!(
        deleted.channel_access(),
        Some(&expected_scope),
        "channel.deleted must carry the PRE-delete private scope"
    );

    cleanup(&pool, server, &[owner]).await;
}
