#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Mentions polish (#9) integration tests — real DB + real HTTP (tower oneshot).
//!
//! Pins the two behavior corrections of the mentions-polish ticket:
//! 1. EDIT-BUDGET SKIP: editing a message re-parses mentions, but only mentions
//!    NEWLY ADDED by the edit consume the mention budget and emit a targeted
//!    `mention.received` — pre-existing mentions never re-charge or re-ping.
//!    The reactivity invariant is asserted on the event bus: a genuinely new
//!    mention on edit DOES fire `mention.received` (for the new user only).
//! 2. EMPTY `?q=` REJECT: the members list endpoint rejects an empty or
//!    whitespace-only `q` with 400, while the existing rules (max 32 chars,
//!    `q` + `before` → 400) still hold.
//!
//! WHY #[ignore]: requires a running Postgres with the Harmony schema (mirrors
//! the voice endpoint and mentions integration tests). Run locally with:
//!   `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:64322/postgres \
//!      cargo test --test mentions_polish_test -- --ignored`

use std::sync::Arc;

use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode, header},
    middleware,
    routing::{get, patch},
};
use jsonwebtoken::{Algorithm, EncodingKey, Header as JwtHeader};
use secrecy::SecretString;
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

use harmony_api::api::handlers::{members, messages};
use harmony_api::api::middleware::auth::require_auth;
use harmony_api::api::state::AppState;
use harmony_api::domain::models::{ChannelId, ServerEvent, UserId};
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

/// Mirror of the private `spam_guard::MENTION_BUDGET_MAX` (30/60s per sender
/// per channel). Budget consumption is asserted by probing the remaining
/// budget: `consume_mention_budget(.., usize::MAX-ish)` grants what is left.
const MENTION_BUDGET_MAX: usize = 30;

// ── Crypto provider (see voice_endpoint_test.rs WHY) ────────────────────

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
        "email": "mentions-polish-test@example.com",
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

// ── App state builder (mirrors voice_endpoint_test.rs, no voice) ────────

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
        message_repo,
        server_repo,
        moderation_retry_repo,
        None, // voice_service
        None, // voice_session_repository
        None, // official_server_id
    )
}

// ── Router builder (mirrors the production routes under test) ───────────

fn test_router(state: AppState) -> Router {
    let authenticated = Router::new()
        .route(
            "/v1/channels/{channel_id}/messages/{message_id}",
            patch(messages::edit_message),
        )
        .route("/v1/servers/{id}/members", get(members::list_members))
        .route_layer(middleware::from_fn_with_state(state.clone(), require_auth));

    Router::new().merge(authenticated).with_state(state)
}

// ── Test fixture (DB seeding) ───────────────────────────────────────────

struct Fixture {
    author: Uuid,
    /// Mentioned in the original message.
    existing_target: Uuid,
    /// Mentioned only by the edit.
    new_target: Uuid,
    server: Uuid,
    channel: Uuid,
    jwt: String,
}

async fn seed_user(pool: &PgPool, display_name: &str) -> Uuid {
    let uid = Uuid::new_v4();
    sqlx::query(
        r#"
        INSERT INTO auth.users (id, instance_id, role, aud, email, encrypted_password, email_confirmed_at, created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change)
        VALUES ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '', now(), now(), now(), '', '', '', '')
        ON CONFLICT (id) DO NOTHING
        "#,
    )
    .bind(uid)
    .bind(format!("mnp-{uid}@example.com"))
    .execute(pool)
    .await
    .expect("seed auth.users");

    let username = format!("mp{}", &uid.simple().to_string()[..10]);
    sqlx::query("INSERT INTO profiles (id, username, display_name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING")
        .bind(uid)
        .bind(username)
        .bind(display_name)
        .execute(pool)
        .await
        .expect("seed profiles");

    uid
}

async fn seed_fixture(pool: &PgPool) -> Fixture {
    let author = seed_user(pool, "Polish Author").await;
    let existing_target = seed_user(pool, "Existing Target").await;
    let new_target = seed_user(pool, "New Target").await;

    let server = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO servers (id, name, owner_id) VALUES ($1, 'Mentions Polish Server', $2)",
    )
    .bind(server)
    .bind(author)
    .execute(pool)
    .await
    .expect("seed server");

    for (user, role) in [
        (author, "owner"),
        (existing_target, "member"),
        (new_target, "member"),
    ] {
        sqlx::query("INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, $3)")
            .bind(server)
            .bind(user)
            .bind(role)
            .execute(pool)
            .await
            .expect("seed server_members");
    }

    let channel = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channels (id, server_id, name, channel_type, position) VALUES ($1, $2, 'polish', 'text'::channel_type, 0)",
    )
    .bind(channel)
    .bind(server)
    .execute(pool)
    .await
    .expect("seed channel");

    let jwt = sign_test_jwt(author);
    Fixture {
        author,
        existing_target,
        new_target,
        server,
        channel,
        jwt,
    }
}

async fn cleanup_fixture(pool: &PgPool, f: &Fixture) {
    let _ = sqlx::query("DELETE FROM servers WHERE id = $1")
        .bind(f.server)
        .execute(pool)
        .await;
    let _ = sqlx::query("DELETE FROM auth.users WHERE id = ANY($1)")
        .bind(vec![f.author, f.existing_target, f.new_target])
        .execute(pool)
        .await;
}

// ── HTTP helpers ────────────────────────────────────────────────────────

async fn body_json(response: axum::response::Response) -> serde_json::Value {
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("read response body");
    serde_json::from_slice(&bytes).expect("parse response body as JSON")
}

/// Seed the pre-edit message directly in the DB (the exact state PR #70/#75
/// persist on send: content markers + `mentioned_user_ids` column).
///
/// WHY not POST via HTTP: `MessageService::create` under `AlwaysAllowedChecker`
/// hits a pre-existing self-hosted rate-limit wrap (`u64::MAX as i64` == -1 →
/// unconditional 429) that is out of this ticket's scope; the edit path under
/// test has no such check. Seeding the row keeps these tests focused on EDIT
/// semantics — and makes the budget math exact (the seed charges no budget).
async fn seed_message(pool: &PgPool, f: &Fixture, content: &str, mentions: &[Uuid]) -> Uuid {
    let message_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO messages (id, channel_id, author_id, content, mentioned_user_ids) VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(message_id)
    .bind(f.channel)
    .bind(f.author)
    .bind(content)
    .bind(mentions)
    .execute(pool)
    .await
    .expect("seed message");
    message_id
}

async fn edit_message(
    app: &Router,
    f: &Fixture,
    message_id: &str,
    content: &str,
) -> serde_json::Value {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(format!(
                    "/v1/channels/{}/messages/{}",
                    f.channel, message_id
                ))
                .header(header::AUTHORIZATION, format!("Bearer {}", f.jwt))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    serde_json::json!({ "content": content }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK, "edit should be 200");
    body_json(response).await
}

/// Drain every event currently buffered on the subscription (publish is a
/// synchronous local broadcast, so by the time the response resolved all
/// events of that request are already in the channel).
fn drain_events(rx: &mut tokio::sync::broadcast::Receiver<ServerEvent>) -> Vec<ServerEvent> {
    let mut events = Vec::new();
    while let Ok(event) = rx.try_recv() {
        events.push(event);
    }
    events
}

/// Remaining mention budget for (author, channel): probe by requesting the
/// whole window — what is granted is exactly what was left. NOTE: the probe
/// itself exhausts the budget, so call it only as the LAST assertion.
fn remaining_budget(state: &AppState, author: Uuid, channel: Uuid) -> usize {
    state.spam_guard().consume_mention_budget(
        &UserId::new(author),
        &ChannelId::new(channel),
        MENTION_BUDGET_MAX,
    )
}

// ── Tests: edit-budget skip + reactivity invariant ──────────────────────

/// Editing a message WITHOUT changing its mentions must not re-charge the
/// mention budget and must not emit any `mention.received`.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires local Supabase Postgres"]
async fn edit_with_unchanged_mentions_charges_no_budget_and_notifies_nobody() {
    let pool = test_pool().await;
    let fixture = seed_fixture(&pool).await;
    let state = build_app_state(pool.clone()).await;
    let app = test_router(state.clone());

    let message_id = seed_message(
        &pool,
        &fixture,
        &format!("hello <@{}>", fixture.existing_target),
        &[fixture.existing_target],
    )
    .await
    .to_string();

    let mut rx = state.event_bus().subscribe();

    edit_message(
        &app,
        &fixture,
        &message_id,
        &format!("hello again <@{}>", fixture.existing_target),
    )
    .await;

    let events = drain_events(&mut rx);
    assert!(
        events
            .iter()
            .any(|e| matches!(e, ServerEvent::MessageUpdated { .. })),
        "edit must still emit message.updated"
    );
    let mention_events: Vec<_> = events
        .iter()
        .filter(|e| matches!(e, ServerEvent::MentionReceived { .. }))
        .collect();
    assert!(
        mention_events.is_empty(),
        "an edit that keeps the same mentions must re-notify NOBODY, got {mention_events:?}"
    );

    // The seeded message charged nothing; the edit must have charged 0 too,
    // so the FULL budget is still available.
    assert_eq!(
        remaining_budget(&state, fixture.author, fixture.channel),
        MENTION_BUDGET_MAX,
        "edit with unchanged mentions must consume NO mention budget"
    );

    cleanup_fixture(&pool, &fixture).await;
}

/// Editing a message to ADD a mention must emit `mention.received` for the
/// newly-added user ONLY (reactivity invariant), and charge budget for that
/// one mention only.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires local Supabase Postgres"]
async fn edit_adding_new_mention_notifies_only_the_new_user() {
    let pool = test_pool().await;
    let fixture = seed_fixture(&pool).await;
    let state = build_app_state(pool.clone()).await;
    let app = test_router(state.clone());

    let message_id = seed_message(
        &pool,
        &fixture,
        &format!("hi <@{}>", fixture.existing_target),
        &[fixture.existing_target],
    )
    .await
    .to_string();

    let mut rx = state.event_bus().subscribe();

    let edited = edit_message(
        &app,
        &fixture,
        &message_id,
        &format!(
            "hi <@{}> and welcome <@{}>",
            fixture.existing_target, fixture.new_target
        ),
    )
    .await;

    // Both mentions persist on the message (rendering stays correct)...
    let mention_ids: Vec<&str> = edited["mentions"]
        .as_array()
        .expect("mentions array")
        .iter()
        .map(|m| m["userId"].as_str().unwrap())
        .collect();
    assert!(
        mention_ids.contains(&fixture.existing_target.to_string().as_str()),
        "pre-existing mention still persisted after edit"
    );
    assert!(
        mention_ids.contains(&fixture.new_target.to_string().as_str()),
        "newly-added mention persisted after edit"
    );

    // ...but only the NEW user is notified (reactivity invariant: the
    // mention.received SSE event fires for genuinely new mentions on edit).
    let events = drain_events(&mut rx);
    let mention_targets: Vec<Uuid> = events
        .iter()
        .filter_map(|e| match e {
            ServerEvent::MentionReceived {
                sender_id,
                target_user_id,
                channel_id,
                message_id: event_message_id,
                ..
            } => {
                assert_eq!(sender_id.0, fixture.author, "sender is the editor");
                assert_eq!(channel_id.0, fixture.channel, "channel matches");
                assert_eq!(
                    event_message_id.to_string(),
                    message_id,
                    "message id matches the edited message"
                );
                Some(target_user_id.0)
            }
            _ => None,
        })
        .collect();
    assert_eq!(
        mention_targets,
        vec![fixture.new_target],
        "exactly ONE mention.received, targeting the newly-added user only"
    );

    // Budget: the seed charged nothing; the edit charged exactly 1 (the NEW
    // mention) — the pre-existing mention was not re-charged.
    assert_eq!(
        remaining_budget(&state, fixture.author, fixture.channel),
        MENTION_BUDGET_MAX - 1,
        "edit must charge budget only for the newly-added mention"
    );

    cleanup_fixture(&pool, &fixture).await;
}

// ── Tests: members `?q=` validation ─────────────────────────────────────

async fn get_members(app: &Router, f: &Fixture, query: &str) -> (StatusCode, serde_json::Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/v1/servers/{}/members{}", f.server, query))
                .header(header::AUTHORIZATION, format!("Bearer {}", f.jwt))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    (status, body_json(response).await)
}

/// Empty and whitespace-only `q` → 400; the existing `q` rules (max 32 chars,
/// `q` + `before` → 400) still hold; a valid `q` still searches.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires local Supabase Postgres"]
async fn members_q_rejects_empty_and_keeps_existing_rules() {
    let pool = test_pool().await;
    let fixture = seed_fixture(&pool).await;
    let state = build_app_state(pool.clone()).await;
    let app = test_router(state);

    // Empty q → 400.
    let (status, body) = get_members(&app, &fixture, "?q=").await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "empty q must be rejected: {body:?}"
    );
    assert!(
        body["detail"]
            .as_str()
            .unwrap_or("")
            .contains("must not be empty"),
        "detail names the empty-q rule: {body:?}"
    );

    // Whitespace-only q (URL-encoded spaces + tab) → 400.
    for whitespace_q in ["?q=%20", "?q=%20%20%20", "?q=%09"] {
        let (status, body) = get_members(&app, &fixture, whitespace_q).await;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "whitespace-only q counts as empty ({whitespace_q})"
        );
        assert!(
            body["detail"]
                .as_str()
                .unwrap_or("")
                .contains("must not be empty"),
            "detail names the empty-q rule: {body:?}"
        );
    }

    // Existing rule: q longer than 32 chars → 400.
    let long_q = "a".repeat(33);
    let (status, body) = get_members(&app, &fixture, &format!("?q={long_q}")).await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "33-char q must be rejected"
    );
    assert!(
        body["detail"]
            .as_str()
            .unwrap_or("")
            .contains("32 characters"),
        "detail names the length rule: {body:?}"
    );

    // Boundary: exactly 32 chars is still a valid search.
    let boundary_q = "a".repeat(32);
    let (status, _) = get_members(&app, &fixture, &format!("?q={boundary_q}")).await;
    assert_eq!(status, StatusCode::OK, "32-char q is accepted");

    // Existing rule: q + before → 400.
    let (status, body) =
        get_members(&app, &fixture, "?q=abc&before=2026-01-01T00%3A00%3A00Z").await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "q combined with before must be rejected"
    );
    assert!(
        body["detail"]
            .as_str()
            .unwrap_or("")
            .contains("Cannot combine"),
        "detail names the q+before rule: {body:?}"
    );

    // A valid q still searches. WHY read the username back: the signup trigger
    // derives the profile username from the auth email, overriding the seeded
    // one — search for the ACTUAL username prefix so the assertion is robust.
    let author_username: String = sqlx::query_scalar("SELECT username FROM profiles WHERE id = $1")
        .bind(fixture.author)
        .fetch_one(&pool)
        .await
        .expect("author profile exists");
    let prefix: String = author_username.chars().take(4).collect();
    let (status, body) = get_members(&app, &fixture, &format!("?q={prefix}")).await;
    assert_eq!(status, StatusCode::OK, "valid q still searches");
    assert!(
        !body["items"].as_array().expect("items array").is_empty(),
        "search returns the seeded members (q={prefix})"
    );
    assert!(
        body.get("nextCursor").is_none(),
        "nextCursor is always null (omitted) for search results"
    );

    cleanup_fixture(&pool, &fixture).await;
}
