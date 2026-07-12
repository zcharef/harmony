#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Private-channel access matrix — every enforcement surface, end to end.
//!
//! Proves the access rule (owner/admin always; otherwise not-private OR the
//! member holds a granted role) against a real Postgres and the production
//! handlers over HTTP (`tower::ServiceExt::oneshot`, real `PgNotifyEventBus`),
//! including the REAL `/v1/events` SSE stream:
//!
//! - HTTP matrix: an ungranted member gets the private channel hidden from
//!   `list_channels`, 403 on message read/send, reactions and pins, and no
//!   search hits; a granted role, admin and owner get full access.
//! - SSE matrix: `message.created` in a private channel reaches granted role +
//!   admin connections and never an ungranted member's connection.
//! - Live revocation: demoting a granted member mid-stream cuts off private
//!   events on the SAME connection — no reconnect.
//! - Privacy flip: making a public channel private mid-stream cuts off its
//!   events AND fans out `channel.access_updated` server-wide so every sidebar
//!   re-evaluates (the ungranted member's eviction signal), while the gated
//!   `channel.updated` stays private-scoped.
//!
//! The SSE assertions avoid sleep-based "nothing arrived" checks: after each
//! private-channel action the owner posts a SENTINEL message in a public
//! channel. Broadcast channels preserve publish order per connection, so once
//! the sentinel arrives, any private event that was going to be delivered
//! would already have been observed.
//!
//! WHY `#[ignore]`: requires a running Postgres with the Harmony schema
//! (mirrors the SSE-scope, role-access, read-state and voice integration
//! tests). Run:
//!   `DATABASE_URL=... cargo test --test private_channel_access_matrix_test -- --ignored`

use std::sync::Arc;
use std::time::Duration;

use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode, header},
    middleware,
    routing::{get, patch, post, put},
};
use http_body_util::BodyExt;
use jsonwebtoken::{Algorithm, EncodingKey, Header as JwtHeader};
use secrecy::SecretString;
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

use harmony_api::api::handlers::{channels, events, members, messages, reactions};
use harmony_api::api::middleware::auth::require_auth;
use harmony_api::api::state::AppState;
use harmony_api::domain::models::UserId;
use harmony_api::domain::ports::{LiveKitTokenGenerator, VoiceGrants};
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

/// Upper bound for "the expected event should arrive well before this".
const SSE_WAIT: Duration = Duration::from_secs(10);

// ── DB pool (mirrors channel_role_access_test) ───────────────────────────

async fn test_pool() -> PgPool {
    dotenvy::dotenv().ok();
    let url =
        std::env::var("DATABASE_URL").expect("DATABASE_URL must be set for integration tests");
    PgPool::connect(&url)
        .await
        .expect("Failed to connect to test database")
}

// ── Seeding (mirrors channel_role_access_test) ───────────────────────────

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
    .bind(format!("pam-{uid}@example.com"))
    .execute(pool)
    .await
    .expect("seed auth.users");

    let username = format!("pam{}", &uid.simple().to_string()[..10]);
    sqlx::query(
        r#"
        INSERT INTO profiles (id, username, display_name)
        VALUES ($1, $2, 'PAM Test')
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
    sqlx::query("INSERT INTO servers (id, name, owner_id) VALUES ($1, 'PAM Server', $2)")
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

async fn grant_channel_role(pool: &PgPool, channel: Uuid, role: &str) {
    sqlx::query(
        "INSERT INTO channel_role_access (channel_id, role) VALUES ($1, $2) \
         ON CONFLICT DO NOTHING",
    )
    .bind(channel)
    .bind(role)
    .execute(pool)
    .await
    .expect("seed channel_role_access");
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

// ── HTTP harness (mirrors channel_role_access_test) ──────────────────────

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
        "email": "pam-test@example.com",
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

/// Router with every surface the access matrix exercises, including the real
/// SSE endpoint.
fn matrix_router(state: AppState) -> Router {
    let authenticated = Router::new()
        .route("/v1/events", get(events::sse_events))
        .route("/v1/servers/{id}/channels", get(channels::list_channels))
        .route(
            "/v1/servers/{id}/channels/{channel_id}",
            patch(channels::update_channel),
        )
        .route(
            "/v1/servers/{id}/channels/{channel_id}/role-access",
            put(channels::set_channel_role_access),
        )
        .route(
            "/v1/servers/{id}/members/{user_id}/role",
            patch(members::assign_role),
        )
        .route(
            "/v1/servers/{id}/messages/search",
            get(messages::search_messages),
        )
        .route(
            "/v1/channels/{id}/messages",
            post(messages::send_message).get(messages::list_messages),
        )
        .route("/v1/channels/{channel_id}/pins", get(messages::list_pins))
        .route(
            "/v1/channels/{channel_id}/messages/{message_id}/reactions",
            post(reactions::add_reaction),
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

/// POST a message as `jwt` and return the created message id.
async fn post_message(router: &Router, channel: Uuid, jwt: &str, content: &str) -> String {
    let res = router
        .clone()
        .oneshot(authed_request(
            "POST",
            &format!("/v1/channels/{channel}/messages"),
            jwt,
            Some(serde_json::json!({ "content": content })),
        ))
        .await
        .expect("send message");
    assert_eq!(
        res.status(),
        StatusCode::CREATED,
        "message send must succeed"
    );
    body_json(res).await["id"]
        .as_str()
        .expect("message id")
        .to_string()
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

/// Message contents returned by a server-wide search for `query`.
async fn search_hits(router: &Router, server: Uuid, jwt: &str, query: &str) -> Vec<String> {
    let res = router
        .clone()
        .oneshot(authed_request(
            "GET",
            &format!("/v1/servers/{server}/messages/search?q={query}"),
            jwt,
            None,
        ))
        .await
        .expect("search messages");
    assert_eq!(res.status(), StatusCode::OK);
    let json = body_json(res).await;
    json["items"]
        .as_array()
        .expect("items array")
        .iter()
        .filter_map(|m| m["content"].as_str().map(ToString::to_string))
        .collect()
}

// ── SSE client over the real `/v1/events` response body ─────────────────

/// Minimal SSE reader on the raw response body. Parses `event:`/`data:`
/// frames, skips keep-alive comments.
struct SseClient {
    body: Body,
    buf: String,
}

impl SseClient {
    async fn connect(router: &Router, jwt: &str) -> Self {
        let res = router
            .clone()
            .oneshot(authed_request("GET", "/v1/events", jwt, None))
            .await
            .expect("connect SSE");
        assert_eq!(res.status(), StatusCode::OK, "SSE connect must succeed");
        Self {
            body: res.into_body(),
            buf: String::new(),
        }
    }

    /// Next `(event_name, data)` frame within `wait`, or `None` on timeout /
    /// stream end.
    async fn next_event(&mut self, wait: Duration) -> Option<(String, serde_json::Value)> {
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            if let Some(frame) = self.pop_frame() {
                return Some(frame);
            }
            let remaining = deadline.checked_duration_since(tokio::time::Instant::now())?;
            match tokio::time::timeout(remaining, self.body.frame()).await {
                Ok(Some(Ok(frame))) => {
                    if let Ok(data) = frame.into_data() {
                        self.buf.push_str(&String::from_utf8_lossy(&data));
                    }
                }
                // Stream ended or errored — no further events will arrive.
                Ok(Some(Err(_)) | None) => return None,
                // Timeout.
                Err(_) => return None,
            }
        }
    }

    /// Pop the next complete, named frame from the buffer (skipping keep-alive
    /// comments, which carry no `event:` line).
    fn pop_frame(&mut self) -> Option<(String, serde_json::Value)> {
        loop {
            let end = self.buf.find("\n\n")?;
            let raw: String = self.buf[..end].to_string();
            self.buf.drain(..=end + 1);

            let mut name: Option<String> = None;
            let mut data = String::new();
            for line in raw.lines() {
                if let Some(v) = line.strip_prefix("event:") {
                    name = Some(v.trim().to_string());
                } else if let Some(v) = line.strip_prefix("data:") {
                    data.push_str(v.trim());
                }
            }
            if let (Some(n), Ok(json)) = (name, serde_json::from_str(&data)) {
                return Some((n, json));
            }
            // Comment / unnamed frame — keep scanning.
        }
    }

    /// Collect frames (inclusive) until `stop` matches. Panics on timeout —
    /// the sentinel MUST arrive on a healthy stream.
    async fn collect_until(
        &mut self,
        stop: impl Fn(&str, &serde_json::Value) -> bool,
    ) -> Vec<(String, serde_json::Value)> {
        let mut seen = Vec::new();
        loop {
            let Some((name, data)) = self.next_event(SSE_WAIT).await else {
                panic!("sentinel event never arrived; saw: {seen:?}")
            };
            let is_stop = stop(&name, &data);
            seen.push((name, data));
            if is_stop {
                return seen;
            }
        }
    }
}

/// True when the frame is `message.created` in `channel`.
fn is_message_in(name: &str, data: &serde_json::Value, channel: Uuid) -> bool {
    name == "message.created" && data["channelId"].as_str() == Some(&channel.to_string())
}

// ── Tests ────────────────────────────────────────────────────────────────

/// HTTP access matrix on every REST surface. The access rule under test:
/// owner/admin always; otherwise not-private OR a granted role.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn http_access_matrix() {
    let pool = test_pool().await;

    let owner = seed_user(&pool).await;
    let admin = seed_user(&pool).await;
    let granted_mod = seed_user(&pool).await;
    let plain_member = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    seed_membership(&pool, server, owner, "owner").await;
    seed_membership(&pool, server, admin, "admin").await;
    seed_membership(&pool, server, granted_mod, "moderator").await;
    seed_membership(&pool, server, plain_member, "member").await;

    let private = seed_channel(&pool, server, "matrix-private", true).await;
    grant_channel_role(&pool, private, "moderator").await;

    let state = build_handler_app_state(pool.clone()).await;
    let router = matrix_router(state);

    let owner_jwt = sign_test_jwt(owner);
    let admin_jwt = sign_test_jwt(admin);
    let mod_jwt = sign_test_jwt(granted_mod);
    let member_jwt = sign_test_jwt(plain_member);

    // Owner seeds a message in the private channel (also proves owner send).
    let secret_msg = post_message(&router, private, &owner_jwt, "classified quartz").await;

    // ── Channel list ──────────────────────────────────────────────
    assert!(
        !member_sees_channel(&router, server, &member_jwt, private).await,
        "ungranted member must NOT see the private channel in list_channels"
    );
    for (jwt, who) in [
        (&mod_jwt, "granted moderator"),
        (&admin_jwt, "admin"),
        (&owner_jwt, "owner"),
    ] {
        assert!(
            member_sees_channel(&router, server, jwt, private).await,
            "{who} must see the private channel in list_channels"
        );
    }

    // ── Message read ──────────────────────────────────────────────
    for (jwt, expected, who) in [
        (&member_jwt, StatusCode::FORBIDDEN, "ungranted member"),
        (&mod_jwt, StatusCode::OK, "granted moderator"),
        (&admin_jwt, StatusCode::OK, "admin"),
        (&owner_jwt, StatusCode::OK, "owner"),
    ] {
        let res = router
            .clone()
            .oneshot(authed_request(
                "GET",
                &format!("/v1/channels/{private}/messages"),
                jwt,
                None,
            ))
            .await
            .expect("list messages");
        assert_eq!(res.status(), expected, "message read as {who}");
    }

    // ── Message send ──────────────────────────────────────────────
    let res = router
        .clone()
        .oneshot(authed_request(
            "POST",
            &format!("/v1/channels/{private}/messages"),
            &member_jwt,
            Some(serde_json::json!({ "content": "should never land" })),
        ))
        .await
        .expect("send message");
    assert_eq!(
        res.status(),
        StatusCode::FORBIDDEN,
        "ungranted member must not send into the private channel"
    );
    let _ = post_message(&router, private, &mod_jwt, "granted mod can post").await;

    // ── Reactions ─────────────────────────────────────────────────
    for (jwt, expected, who) in [
        (&member_jwt, StatusCode::FORBIDDEN, "ungranted member"),
        (&mod_jwt, StatusCode::NO_CONTENT, "granted moderator"),
    ] {
        let res = router
            .clone()
            .oneshot(authed_request(
                "POST",
                &format!("/v1/channels/{private}/messages/{secret_msg}/reactions"),
                jwt,
                Some(serde_json::json!({ "emoji": "👍" })),
            ))
            .await
            .expect("add reaction");
        assert_eq!(res.status(), expected, "reaction as {who}");
    }

    // ── Pins ──────────────────────────────────────────────────────
    for (jwt, expected, who) in [
        (&member_jwt, StatusCode::FORBIDDEN, "ungranted member"),
        (&mod_jwt, StatusCode::OK, "granted moderator"),
        (&admin_jwt, StatusCode::OK, "admin"),
    ] {
        let res = router
            .clone()
            .oneshot(authed_request(
                "GET",
                &format!("/v1/channels/{private}/pins"),
                jwt,
                None,
            ))
            .await
            .expect("list pins");
        assert_eq!(res.status(), expected, "pins list as {who}");
    }

    // ── Search (must not leak private-channel content) ────────────
    assert!(
        search_hits(&router, server, &member_jwt, "quartz")
            .await
            .is_empty(),
        "ungranted member must get NO search hits from the private channel"
    );
    for (jwt, who) in [
        (&mod_jwt, "granted moderator"),
        (&admin_jwt, "admin"),
        (&owner_jwt, "owner"),
    ] {
        assert!(
            search_hits(&router, server, jwt, "quartz")
                .await
                .iter()
                .any(|c| c.contains("quartz")),
            "{who} must find the private-channel message via search"
        );
    }

    cleanup(&pool, server, &[owner, admin, granted_mod, plain_member]).await;
}

/// SSE delivery matrix + LIVE revocation cutoff on the same connection.
///
/// Uses public-channel sentinel messages for deterministic "not delivered"
/// assertions (broadcast order is preserved per connection).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn sse_delivery_matrix_and_live_revocation_cutoff() {
    let pool = test_pool().await;

    let owner = seed_user(&pool).await;
    let admin = seed_user(&pool).await;
    let granted_mod = seed_user(&pool).await;
    let plain_member = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    seed_membership(&pool, server, owner, "owner").await;
    seed_membership(&pool, server, admin, "admin").await;
    seed_membership(&pool, server, granted_mod, "moderator").await;
    seed_membership(&pool, server, plain_member, "member").await;

    let private = seed_channel(&pool, server, "sse-private", true).await;
    let public = seed_channel(&pool, server, "sse-public", false).await;
    grant_channel_role(&pool, private, "moderator").await;

    let state = build_handler_app_state(pool.clone()).await;
    let router = matrix_router(state);

    let owner_jwt = sign_test_jwt(owner);
    let admin_jwt = sign_test_jwt(admin);
    let mod_jwt = sign_test_jwt(granted_mod);
    let member_jwt = sign_test_jwt(plain_member);

    let mut member_sse = SseClient::connect(&router, &member_jwt).await;
    let mut mod_sse = SseClient::connect(&router, &mod_jwt).await;
    let mut admin_sse = SseClient::connect(&router, &admin_jwt).await;

    // Owner posts into the private channel, then the public sentinel.
    let _ = post_message(&router, private, &owner_jwt, "secret alpha").await;
    let _ = post_message(&router, public, &owner_jwt, "sentinel one").await;

    // Granted moderator and admin both receive the private message.
    for (sse, who) in [
        (&mut mod_sse, "granted moderator"),
        (&mut admin_sse, "admin"),
    ] {
        let seen = sse.collect_until(|n, d| is_message_in(n, d, public)).await;
        assert!(
            seen.iter().any(|(n, d)| is_message_in(n, d, private)),
            "{who} must receive the private-channel message.created; saw: {seen:?}"
        );
    }

    // Ungranted member sees the sentinel but NEVER the private message.
    let seen = member_sse
        .collect_until(|n, d| is_message_in(n, d, public))
        .await;
    assert!(
        !seen.iter().any(|(n, d)| is_message_in(n, d, private)),
        "ungranted member must NOT receive private-channel events; saw: {seen:?}"
    );

    // ── LIVE revocation: demote the moderator mid-stream ──────────
    let res = router
        .clone()
        .oneshot(authed_request(
            "PATCH",
            &format!("/v1/servers/{server}/members/{granted_mod}/role"),
            &owner_jwt,
            Some(serde_json::json!({ "role": "member" })),
        ))
        .await
        .expect("demote moderator");
    assert_eq!(res.status(), StatusCode::OK, "role demotion must succeed");

    let _ = post_message(&router, private, &owner_jwt, "secret bravo").await;
    let _ = post_message(&router, public, &owner_jwt, "sentinel two").await;

    // The demoted member's SAME connection: role_updated + sentinel arrive,
    // the post-revocation private message does not — cutoff without reconnect.
    let seen = mod_sse
        .collect_until(|n, d| {
            is_message_in(n, d, public) && d["message"]["content"].as_str() == Some("sentinel two")
        })
        .await;
    assert!(
        seen.iter().any(|(n, _)| n == "member.role_updated"),
        "demoted member must receive their member.role_updated; saw: {seen:?}"
    );
    assert!(
        !seen.iter().any(|(n, d)| is_message_in(n, d, private)
            && d["message"]["content"].as_str() == Some("secret bravo")),
        "demoted member must be cut off from private-channel events live; saw: {seen:?}"
    );

    // Admin keeps receiving (implicit access is untouched by grants).
    let seen = admin_sse
        .collect_until(|n, d| {
            is_message_in(n, d, public) && d["message"]["content"].as_str() == Some("sentinel two")
        })
        .await;
    assert!(
        seen.iter().any(|(n, d)| is_message_in(n, d, private)
            && d["message"]["content"].as_str() == Some("secret bravo")),
        "admin must keep receiving private-channel events; saw: {seen:?}"
    );

    cleanup(&pool, server, &[owner, admin, granted_mod, plain_member]).await;
}

/// Making a public channel private mid-stream: the now-ungranted member is cut
/// off live AND receives the server-scoped `channel.access_updated` (the
/// sidebar-eviction signal), while the gated `channel.updated` never reaches
/// them.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn making_channel_private_cuts_off_members_live() {
    let pool = test_pool().await;

    let owner = seed_user(&pool).await;
    let plain_member = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    seed_membership(&pool, server, owner, "owner").await;
    seed_membership(&pool, server, plain_member, "member").await;

    let flipping = seed_channel(&pool, server, "sse-flip", false).await;
    let public = seed_channel(&pool, server, "sse-stays-public", false).await;

    let state = build_handler_app_state(pool.clone()).await;
    let router = matrix_router(state);

    let owner_jwt = sign_test_jwt(owner);
    let member_jwt = sign_test_jwt(plain_member);

    let mut member_sse = SseClient::connect(&router, &member_jwt).await;

    // While public, the member receives the channel's messages.
    let _ = post_message(&router, flipping, &owner_jwt, "before flip").await;
    let seen = member_sse
        .collect_until(|n, d| is_message_in(n, d, flipping))
        .await;
    assert!(
        seen.iter().any(|(n, d)| is_message_in(n, d, flipping)),
        "member must receive public-channel messages; saw: {seen:?}"
    );

    // Owner flips the channel private (no grants → admins/owner only).
    let res = router
        .clone()
        .oneshot(authed_request(
            "PATCH",
            &format!("/v1/servers/{server}/channels/{flipping}"),
            &owner_jwt,
            Some(serde_json::json!({ "isPrivate": true })),
        ))
        .await
        .expect("flip channel private");
    assert_eq!(res.status(), StatusCode::OK, "privacy flip must succeed");

    let _ = post_message(&router, flipping, &owner_jwt, "after flip").await;
    let _ = post_message(&router, public, &owner_jwt, "flip sentinel").await;

    let seen = member_sse
        .collect_until(|n, d| is_message_in(n, d, public))
        .await;

    // The eviction signal reaches the member (server-scoped, bounded payload).
    let access_updated = seen
        .iter()
        .find(|(n, _)| n == "channel.access_updated")
        .unwrap_or_else(|| panic!("member must receive channel.access_updated; saw: {seen:?}"));
    assert_eq!(
        access_updated.1["channelId"].as_str(),
        Some(flipping.to_string().as_str()),
        "access_updated must reference the flipped channel"
    );
    assert_eq!(
        access_updated.1["authorizedRoles"],
        serde_json::json!([]),
        "no grants were made — the granted set must be empty"
    );

    // The gated channel.updated must NOT reach the ungranted member, and the
    // post-flip message must be cut off — live, same connection.
    assert!(
        !seen.iter().any(|(n, d)| n == "channel.updated"
            && d["channel"]["id"].as_str() == Some(&flipping.to_string())),
        "gated channel.updated must not reach an ungranted member; saw: {seen:?}"
    );
    assert!(
        !seen.iter().any(|(n, d)| is_message_in(n, d, flipping)
            && d["message"]["content"].as_str() == Some("after flip")),
        "member must be cut off from the now-private channel live; saw: {seen:?}"
    );

    cleanup(&pool, server, &[owner, plain_member]).await;
}
