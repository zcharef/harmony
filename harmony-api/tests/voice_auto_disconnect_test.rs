#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::doc_markdown,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_possible_wrap
)]
//! Voice auto-disconnect integration tests.
//!
//! Tests the `PgVoiceSessionRepository` methods for alone-in-channel detection,
//! AFK detection, heartbeat activity tracking, `alone_since` lifecycle, and
//! upsert behavior for `last_active_at`.
//!
//! WHY #[ignore]: These tests require a running Postgres instance (local
//! Supabase). CI sets `DATABASE_URL` to a dummy value so `cargo test --all-targets`
//! would panic on connection. Run locally with:
//! `cargo test --test voice_auto_disconnect_test -- --ignored`
//!
//! Test matrix (20 tests):
//!   T8.1-T8.4:   Alone-in-channel (delete_alone_in_channel)
//!   T8.5-T8.8:   alone_since lifecycle (remove_by_user, upsert, update_alone_since)
//!   T8.9-T8.11:  AFK (delete_afk)
//!   T8.12-T8.13: Heartbeat (touch)
//!   T8.14-T8.15: Upsert last_active_at
//!   T8.19:       Handler muted heartbeat (effective_active)
//!   T8.20:       Muted→unmuted→silent transition

use std::sync::Arc;

use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode, header},
    middleware,
    routing::post,
};
use chrono::{Duration, Utc};
use jsonwebtoken::{Algorithm, EncodingKey, Header as JwtHeader};
use secrecy::SecretString;
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

use harmony_api::domain::models::{ChannelId, ServerId, UserId};
use harmony_api::domain::ports::{LiveKitTokenGenerator, VoiceGrants, VoiceSessionRepository};
use harmony_api::infra::postgres::PgVoiceSessionRepository;

// ── Test constants ──────────────────────────────────────────────────────
const TEST_JWT_SECRET: &str = "test-jwt-secret-for-integration-tests-only-32ch";

// ── Crypto provider ─────────────────────────────────────────────────────

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

// ── Fake LiveKit token generator ────────────────────────────────────────

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

// ── Test fixture ────────────────────────────────────────────────────────

struct AutoDisconnectFixture {
    user_ids: Vec<UserId>,
    server_id: ServerId,
    channel_ids: Vec<ChannelId>,
}

/// Seed N users, 1 server, M voice channels, and memberships.
async fn seed_auto_disconnect_fixture(
    pool: &PgPool,
    num_users: usize,
    num_channels: usize,
) -> AutoDisconnectFixture {
    let server_uuid = Uuid::new_v4();
    let mut user_ids = Vec::with_capacity(num_users);
    let mut channel_ids = Vec::with_capacity(num_channels);

    // Seed users
    for i in 0..num_users {
        let user_uuid = Uuid::new_v4();
        sqlx::query(
            r#"
            INSERT INTO auth.users (id, instance_id, role, aud, email, encrypted_password, email_confirmed_at, created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change)
            VALUES ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '', now(), now(), now(), '', '', '', '')
            ON CONFLICT (id) DO NOTHING
            "#,
        )
        .bind(user_uuid)
        .bind(format!("auto-disconnect-test-{}-{}@example.com", user_uuid, i))
        .execute(pool)
        .await
        .expect("seed auth.users");

        sqlx::query(
            r#"
            INSERT INTO profiles (id, username, display_name)
            VALUES ($1, $2, $3)
            ON CONFLICT (id) DO NOTHING
            "#,
        )
        .bind(user_uuid)
        .bind(format!(
            "ad{}",
            user_uuid
                .to_string()
                .replace('-', "")
                .get(..8)
                .unwrap_or("test0001")
        ))
        .bind(format!("Auto Disconnect Tester {i}"))
        .execute(pool)
        .await
        .expect("seed profiles");

        user_ids.push(UserId::new(user_uuid));
    }

    // Seed server
    let owner_uuid = user_ids[0].0;
    sqlx::query(
        r#"
        INSERT INTO servers (id, name, owner_id)
        VALUES ($1, $2, $3)
        ON CONFLICT (id) DO NOTHING
        "#,
    )
    .bind(server_uuid)
    .bind(format!("ADTestServer {}", &server_uuid.to_string()[..8]))
    .bind(owner_uuid)
    .execute(pool)
    .await
    .expect("seed servers");

    // Seed channels
    for i in 0..num_channels {
        let ch_uuid = Uuid::new_v4();
        sqlx::query(
            r#"
            INSERT INTO channels (id, server_id, name, channel_type, position)
            VALUES ($1, $2, $3, 'voice'::channel_type, $4)
            ON CONFLICT (id) DO NOTHING
            "#,
        )
        .bind(ch_uuid)
        .bind(server_uuid)
        .bind(format!("voice-test-{i}"))
        .bind(i as i32)
        .execute(pool)
        .await
        .expect("seed voice channel");

        channel_ids.push(ChannelId::new(ch_uuid));
    }

    // Seed memberships
    for uid in &user_ids {
        sqlx::query(
            r#"
            INSERT INTO server_members (server_id, user_id, role)
            VALUES ($1, $2, 'member')
            ON CONFLICT (server_id, user_id) DO NOTHING
            "#,
        )
        .bind(server_uuid)
        .bind(uid.0)
        .execute(pool)
        .await
        .expect("seed server_members");
    }

    AutoDisconnectFixture {
        user_ids,
        server_id: ServerId::new(server_uuid),
        channel_ids,
    }
}

/// Clean up all test data. Best-effort — does not panic on failure.
async fn cleanup_auto_disconnect_fixture(pool: &PgPool, fixture: &AutoDisconnectFixture) {
    let server_uuid = fixture.server_id.0;

    // Clean voice_sessions for all users
    for uid in &fixture.user_ids {
        let _ = sqlx::query("DELETE FROM voice_sessions WHERE user_id = $1")
            .bind(uid.0)
            .execute(pool)
            .await;
    }

    // Clean memberships
    for uid in &fixture.user_ids {
        let _ = sqlx::query("DELETE FROM server_members WHERE server_id = $1 AND user_id = $2")
            .bind(server_uuid)
            .bind(uid.0)
            .execute(pool)
            .await;
    }

    // Clean channels
    for cid in &fixture.channel_ids {
        let _ = sqlx::query("DELETE FROM channels WHERE id = $1")
            .bind(cid.0)
            .execute(pool)
            .await;
    }

    // Clean server
    let _ = sqlx::query("DELETE FROM servers WHERE id = $1")
        .bind(server_uuid)
        .execute(pool)
        .await;

    // Clean profiles & auth.users
    for uid in &fixture.user_ids {
        let _ = sqlx::query("DELETE FROM profiles WHERE id = $1")
            .bind(uid.0)
            .execute(pool)
            .await;
        let _ = sqlx::query("DELETE FROM auth.users WHERE id = $1")
            .bind(uid.0)
            .execute(pool)
            .await;
    }
}

/// Insert a raw voice session directly into the database.
async fn insert_raw_session(
    pool: &PgPool,
    user_id: &UserId,
    channel_id: &ChannelId,
    server_id: &ServerId,
    session_id: &str,
) {
    sqlx::query(
        r#"
        INSERT INTO voice_sessions (user_id, channel_id, server_id, session_id)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (user_id) DO UPDATE
            SET channel_id = EXCLUDED.channel_id,
                server_id  = EXCLUDED.server_id,
                session_id = EXCLUDED.session_id,
                joined_at  = now(),
                last_seen_at = now(),
                last_active_at = now(),
                alone_since = NULL
        "#,
    )
    .bind(user_id.0)
    .bind(channel_id.0)
    .bind(server_id.0)
    .bind(session_id)
    .execute(pool)
    .await
    .expect("insert raw voice session");
}

// ── App state builder for handler tests (T8.19) ─────────────────────────

use harmony_api::api::handlers::voice;
use harmony_api::api::middleware::auth::require_auth;
use harmony_api::api::state::AppState;
use harmony_api::domain::services::{ContentFilter, SpamGuard, VoiceService};
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

async fn build_app_state_with_voice(pool: PgPool) -> AppState {
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

    // WHY: Rebuild repos for AppState — follows same pattern as voice_endpoint_test.rs.
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
    )
}

fn heartbeat_router(state: AppState) -> Router {
    let authenticated = Router::new()
        .route("/v1/voice/heartbeat", post(voice::voice_heartbeat))
        .route_layer(middleware::from_fn_with_state(state.clone(), require_auth));

    Router::new().merge(authenticated).with_state(state)
}

// ══════════════════════════════════════════════════════════════════════════
// T8.1-T8.4: Alone-in-channel tests
// ══════════════════════════════════════════════════════════════════════════

/// T8.1: delete_alone_in_channel removes solo session with alone_since > 3 min.
#[tokio::test]
#[ignore = "requires local Supabase Postgres"]
async fn t8_1_delete_alone_removes_solo_session_beyond_threshold() {
    let pool = test_pool().await;
    let fixture = seed_auto_disconnect_fixture(&pool, 1, 1).await;
    let repo = PgVoiceSessionRepository::new(pool.clone());

    let uid = &fixture.user_ids[0];
    let cid = &fixture.channel_ids[0];
    let sid = &fixture.server_id;

    // Insert session, then backdate alone_since to 4 minutes ago.
    insert_raw_session(&pool, uid, cid, sid, "sess-alone-1").await;
    let four_min_ago = Utc::now() - Duration::minutes(4);
    sqlx::query!(
        "UPDATE voice_sessions SET alone_since = $1 WHERE user_id = $2",
        four_min_ago,
        uid.0,
    )
    .execute(&pool)
    .await
    .expect("backdate alone_since");

    // Threshold = 3 minutes ago. Session has alone_since 4 min ago → should be removed.
    let threshold = Utc::now() - Duration::minutes(3);
    let removed = repo
        .delete_alone_in_channel(threshold)
        .await
        .expect("delete_alone_in_channel should succeed");

    // WHY: delete_alone_in_channel operates globally. Check our session was removed
    // (either by this call or a concurrent test's call).
    let our_removed = removed.iter().any(|s| s.user_id == *uid);
    let exists_after = sqlx::query_scalar!(
        "SELECT COUNT(*) as \"count!\" FROM voice_sessions WHERE user_id = $1",
        uid.0,
    )
    .fetch_one(&pool)
    .await
    .expect("check session after delete");

    assert!(
        our_removed || exists_after == 0,
        "Session should be removed: our_removed={our_removed}, exists_after={exists_after}"
    );

    cleanup_auto_disconnect_fixture(&pool, &fixture).await;
}

/// T8.2: delete_alone_in_channel preserves solo session with alone_since < 3 min.
#[tokio::test]
#[ignore = "requires local Supabase Postgres"]
async fn t8_2_delete_alone_preserves_recent_solo_session() {
    let pool = test_pool().await;
    let fixture = seed_auto_disconnect_fixture(&pool, 1, 1).await;
    let repo = PgVoiceSessionRepository::new(pool.clone());

    let uid = &fixture.user_ids[0];
    let cid = &fixture.channel_ids[0];
    let sid = &fixture.server_id;

    // Insert session, set alone_since to 1 minute ago.
    insert_raw_session(&pool, uid, cid, sid, "sess-alone-2").await;
    let one_min_ago = Utc::now() - Duration::minutes(1);
    sqlx::query!(
        "UPDATE voice_sessions SET alone_since = $1 WHERE user_id = $2",
        one_min_ago,
        uid.0,
    )
    .execute(&pool)
    .await
    .expect("set recent alone_since");

    // Threshold = 3 minutes ago. Session has alone_since 1 min ago → should be preserved.
    let threshold = Utc::now() - Duration::minutes(3);
    let removed = repo
        .delete_alone_in_channel(threshold)
        .await
        .expect("delete_alone_in_channel should succeed");

    // WHY: delete_alone_in_channel operates globally. Assert OUR session was NOT removed.
    let our_removed = removed.iter().any(|s| s.user_id == *uid);
    assert!(
        !our_removed,
        "Our recent session should NOT be removed by delete_alone_in_channel"
    );

    cleanup_auto_disconnect_fixture(&pool, &fixture).await;
}

/// T8.3: delete_alone_in_channel preserves solo session with alone_since = NULL.
#[tokio::test]
#[ignore = "requires local Supabase Postgres"]
async fn t8_3_delete_alone_preserves_null_alone_since() {
    let pool = test_pool().await;
    let fixture = seed_auto_disconnect_fixture(&pool, 1, 1).await;
    let repo = PgVoiceSessionRepository::new(pool.clone());

    let uid = &fixture.user_ids[0];
    let cid = &fixture.channel_ids[0];
    let sid = &fixture.server_id;

    // Insert session — alone_since defaults to NULL via insert_raw_session.
    insert_raw_session(&pool, uid, cid, sid, "sess-alone-3").await;

    // Threshold = 3 minutes ago. alone_since is NULL → should be preserved.
    let threshold = Utc::now() - Duration::minutes(3);
    let removed = repo
        .delete_alone_in_channel(threshold)
        .await
        .expect("delete_alone_in_channel should succeed");

    // WHY: delete_alone_in_channel operates globally. Assert OUR session was NOT removed.
    let our_removed = removed.iter().any(|s| s.user_id == *uid);
    assert!(
        !our_removed,
        "Our NULL alone_since session should NOT be removed by delete_alone_in_channel"
    );

    cleanup_auto_disconnect_fixture(&pool, &fixture).await;
}

/// T8.4: delete_alone_in_channel preserves channel with 2+ participants.
#[tokio::test]
#[ignore = "requires local Supabase Postgres"]
async fn t8_4_delete_alone_preserves_multi_participant_channel() {
    let pool = test_pool().await;
    let fixture = seed_auto_disconnect_fixture(&pool, 2, 1).await;
    let repo = PgVoiceSessionRepository::new(pool.clone());

    let uid_a = &fixture.user_ids[0];
    let uid_b = &fixture.user_ids[1];
    let cid = &fixture.channel_ids[0];
    let sid = &fixture.server_id;

    // Insert 2 sessions in the same channel.
    insert_raw_session(&pool, uid_a, cid, sid, "sess-multi-a").await;
    insert_raw_session(&pool, uid_b, cid, sid, "sess-multi-b").await;

    // Even if alone_since is set on one, COUNT(*) = 2 → not solo → not removed.
    let four_min_ago = Utc::now() - Duration::minutes(4);
    sqlx::query!(
        "UPDATE voice_sessions SET alone_since = $1 WHERE user_id = $2",
        four_min_ago,
        uid_a.0,
    )
    .execute(&pool)
    .await
    .expect("backdate alone_since on uid_a");

    let threshold = Utc::now() - Duration::minutes(3);
    let removed = repo
        .delete_alone_in_channel(threshold)
        .await
        .expect("delete_alone_in_channel should succeed");

    // WHY: delete_alone_in_channel operates globally. Assert NEITHER of our
    // sessions was removed (channel has 2 users → not solo).
    let our_removed = removed
        .iter()
        .any(|s| s.user_id == *uid_a || s.user_id == *uid_b);
    assert!(
        !our_removed,
        "Neither session should be removed from a multi-participant channel"
    );

    cleanup_auto_disconnect_fixture(&pool, &fixture).await;
}

// ══════════════════════════════════════════════════════════════════════════
// T8.5-T8.8: alone_since lifecycle tests
// ══════════════════════════════════════════════════════════════════════════

/// T8.5: remove_by_user sets alone_since = now() when 1 user remains in channel.
#[tokio::test]
#[ignore = "requires local Supabase Postgres"]
async fn t8_5_remove_sets_alone_since_when_one_remains() {
    let pool = test_pool().await;
    let fixture = seed_auto_disconnect_fixture(&pool, 2, 1).await;
    let repo = PgVoiceSessionRepository::new(pool.clone());

    let uid_a = &fixture.user_ids[0];
    let uid_b = &fixture.user_ids[1];
    let cid = &fixture.channel_ids[0];
    let sid = &fixture.server_id;

    // Both users in the same channel.
    insert_raw_session(&pool, uid_a, cid, sid, "sess-lifecycle-a").await;
    insert_raw_session(&pool, uid_b, cid, sid, "sess-lifecycle-b").await;

    // Verify alone_since is NULL for both.
    let before: Option<chrono::DateTime<Utc>> = sqlx::query_scalar!(
        "SELECT alone_since FROM voice_sessions WHERE user_id = $1",
        uid_b.0,
    )
    .fetch_one(&pool)
    .await
    .expect("query alone_since before");
    assert!(before.is_none(), "alone_since should be NULL before remove");

    // Remove user A → user B is now alone.
    repo.remove_by_user(uid_a)
        .await
        .expect("remove_by_user should succeed");

    // Verify alone_since is now set for user B.
    let after: Option<chrono::DateTime<Utc>> = sqlx::query_scalar!(
        "SELECT alone_since FROM voice_sessions WHERE user_id = $1",
        uid_b.0,
    )
    .fetch_one(&pool)
    .await
    .expect("query alone_since after");
    assert!(
        after.is_some(),
        "alone_since should be set after other user left"
    );

    cleanup_auto_disconnect_fixture(&pool, &fixture).await;
}

/// T8.6: remove_by_user does NOT set alone_since when 2+ users remain.
#[tokio::test]
#[ignore = "requires local Supabase Postgres"]
async fn t8_6_remove_does_not_set_alone_since_when_multiple_remain() {
    let pool = test_pool().await;
    let fixture = seed_auto_disconnect_fixture(&pool, 3, 1).await;
    let repo = PgVoiceSessionRepository::new(pool.clone());

    let uid_a = &fixture.user_ids[0];
    let uid_b = &fixture.user_ids[1];
    let uid_c = &fixture.user_ids[2];
    let cid = &fixture.channel_ids[0];
    let sid = &fixture.server_id;

    // Three users in the same channel.
    insert_raw_session(&pool, uid_a, cid, sid, "sess-3a").await;
    insert_raw_session(&pool, uid_b, cid, sid, "sess-3b").await;
    insert_raw_session(&pool, uid_c, cid, sid, "sess-3c").await;

    // Remove user A → 2 remain → alone_since should NOT be set.
    repo.remove_by_user(uid_a)
        .await
        .expect("remove_by_user should succeed");

    let alone_b: Option<chrono::DateTime<Utc>> = sqlx::query_scalar!(
        "SELECT alone_since FROM voice_sessions WHERE user_id = $1",
        uid_b.0,
    )
    .fetch_one(&pool)
    .await
    .expect("query alone_since for uid_b");
    assert!(
        alone_b.is_none(),
        "alone_since should remain NULL when 2+ users remain"
    );

    let alone_c: Option<chrono::DateTime<Utc>> = sqlx::query_scalar!(
        "SELECT alone_since FROM voice_sessions WHERE user_id = $1",
        uid_c.0,
    )
    .fetch_one(&pool)
    .await
    .expect("query alone_since for uid_c");
    assert!(
        alone_c.is_none(),
        "alone_since should remain NULL when 2+ users remain"
    );

    cleanup_auto_disconnect_fixture(&pool, &fixture).await;
}

/// T8.7: upsert resets alone_since = NULL when channel goes from 1→2 users.
#[tokio::test]
#[ignore = "requires local Supabase Postgres"]
async fn t8_7_upsert_resets_alone_since_when_second_user_joins() {
    let pool = test_pool().await;
    let fixture = seed_auto_disconnect_fixture(&pool, 2, 1).await;
    let repo = PgVoiceSessionRepository::new(pool.clone());

    let uid_a = &fixture.user_ids[0];
    let uid_b = &fixture.user_ids[1];
    let cid = &fixture.channel_ids[0];
    let sid = &fixture.server_id;

    // User A is alone in the channel with alone_since set.
    insert_raw_session(&pool, uid_a, cid, sid, "sess-reset-a").await;
    let two_min_ago = Utc::now() - Duration::minutes(2);
    sqlx::query!(
        "UPDATE voice_sessions SET alone_since = $1 WHERE user_id = $2",
        two_min_ago,
        uid_a.0,
    )
    .execute(&pool)
    .await
    .expect("set alone_since for uid_a");

    // Verify alone_since is set.
    let before: Option<chrono::DateTime<Utc>> = sqlx::query_scalar!(
        "SELECT alone_since FROM voice_sessions WHERE user_id = $1",
        uid_a.0,
    )
    .fetch_one(&pool)
    .await
    .expect("query alone_since before upsert");
    assert!(before.is_some(), "alone_since should be set before upsert");

    // User B joins the same channel via upsert.
    let new_session = harmony_api::domain::models::NewVoiceSession {
        user_id: uid_b.clone(),
        channel_id: cid.clone(),
        server_id: sid.clone(),
        session_id: "sess-reset-b".to_string(),
    };
    repo.upsert(&new_session)
        .await
        .expect("upsert should succeed");

    // Verify alone_since is now NULL for user A.
    let after: Option<chrono::DateTime<Utc>> = sqlx::query_scalar!(
        "SELECT alone_since FROM voice_sessions WHERE user_id = $1",
        uid_a.0,
    )
    .fetch_one(&pool)
    .await
    .expect("query alone_since after upsert");
    assert!(
        after.is_none(),
        "alone_since should be reset to NULL when second user joins"
    );

    cleanup_auto_disconnect_fixture(&pool, &fixture).await;
}

/// T8.8: update_alone_since marks solo users across multiple channels.
#[tokio::test]
#[ignore = "requires local Supabase Postgres"]
async fn t8_8_update_alone_since_marks_solo_users() {
    let pool = test_pool().await;
    let fixture = seed_auto_disconnect_fixture(&pool, 2, 2).await;
    let repo = PgVoiceSessionRepository::new(pool.clone());

    let uid_a = &fixture.user_ids[0];
    let uid_b = &fixture.user_ids[1];
    let cid_1 = &fixture.channel_ids[0];
    let cid_2 = &fixture.channel_ids[1];
    let sid = &fixture.server_id;

    // User A alone in channel 1, user B alone in channel 2.
    insert_raw_session(&pool, uid_a, cid_1, sid, "sess-mark-a").await;
    insert_raw_session(&pool, uid_b, cid_2, sid, "sess-mark-b").await;

    // Both should have alone_since = NULL initially.
    let a_before: Option<chrono::DateTime<Utc>> = sqlx::query_scalar!(
        "SELECT alone_since FROM voice_sessions WHERE user_id = $1",
        uid_a.0,
    )
    .fetch_one(&pool)
    .await
    .expect("query alone_since for uid_a");
    assert!(a_before.is_none(), "alone_since should be NULL initially");

    // Run update_alone_since — should mark both as alone (and possibly others
    // from parallel tests, so we check >= 2 rather than == 2).
    let updated = repo
        .update_alone_since()
        .await
        .expect("update_alone_since should succeed");

    assert!(
        updated >= 2,
        "Expected at least 2 rows updated, got {updated}"
    );

    // Verify both now have alone_since set.
    let a_after: Option<chrono::DateTime<Utc>> = sqlx::query_scalar!(
        "SELECT alone_since FROM voice_sessions WHERE user_id = $1",
        uid_a.0,
    )
    .fetch_one(&pool)
    .await
    .expect("query alone_since for uid_a after");
    assert!(a_after.is_some(), "alone_since should be set for uid_a");

    let b_after: Option<chrono::DateTime<Utc>> = sqlx::query_scalar!(
        "SELECT alone_since FROM voice_sessions WHERE user_id = $1",
        uid_b.0,
    )
    .fetch_one(&pool)
    .await
    .expect("query alone_since for uid_b after");
    assert!(b_after.is_some(), "alone_since should be set for uid_b");

    cleanup_auto_disconnect_fixture(&pool, &fixture).await;
}

// ══════════════════════════════════════════════════════════════════════════
// T8.9-T8.11: AFK tests
// ══════════════════════════════════════════════════════════════════════════

/// T8.9: delete_afk removes session with last_active_at > 30 min.
#[tokio::test]
#[ignore = "requires local Supabase Postgres"]
async fn t8_9_delete_afk_removes_inactive_session() {
    let pool = test_pool().await;
    let fixture = seed_auto_disconnect_fixture(&pool, 1, 1).await;
    let repo = PgVoiceSessionRepository::new(pool.clone());

    let uid = &fixture.user_ids[0];
    let cid = &fixture.channel_ids[0];
    let sid = &fixture.server_id;

    // Insert session, backdate last_active_at to 31 minutes ago.
    insert_raw_session(&pool, uid, cid, sid, "sess-afk-1").await;
    let thirty_one_min_ago = Utc::now() - Duration::minutes(31);
    sqlx::query!(
        "UPDATE voice_sessions SET last_active_at = $1 WHERE user_id = $2",
        thirty_one_min_ago,
        uid.0,
    )
    .execute(&pool)
    .await
    .expect("backdate last_active_at");

    // Threshold = 30 min ago, stale_threshold = 2 min ago (session is still "connected").
    let threshold = Utc::now() - Duration::minutes(30);
    let stale_threshold = Utc::now() - Duration::minutes(2);
    let removed = repo
        .delete_afk(threshold, stale_threshold)
        .await
        .expect("delete_afk should succeed");

    // WHY: delete_afk operates globally. Check our session was removed.
    let our_removed = removed.iter().any(|s| s.user_id == *uid);
    let exists_after = sqlx::query_scalar!(
        "SELECT COUNT(*) as \"count!\" FROM voice_sessions WHERE user_id = $1",
        uid.0,
    )
    .fetch_one(&pool)
    .await
    .expect("check session after delete_afk");

    assert!(
        our_removed || exists_after == 0,
        "AFK session should be removed: our_removed={our_removed}, exists_after={exists_after}"
    );

    cleanup_auto_disconnect_fixture(&pool, &fixture).await;
}

/// T8.10: delete_afk preserves session with recent last_active_at.
#[tokio::test]
#[ignore = "requires local Supabase Postgres"]
async fn t8_10_delete_afk_preserves_active_session() {
    let pool = test_pool().await;
    let fixture = seed_auto_disconnect_fixture(&pool, 1, 1).await;
    let repo = PgVoiceSessionRepository::new(pool.clone());

    let uid = &fixture.user_ids[0];
    let cid = &fixture.channel_ids[0];
    let sid = &fixture.server_id;

    // Insert session — last_active_at defaults to now() (recent).
    insert_raw_session(&pool, uid, cid, sid, "sess-afk-2").await;

    let threshold = Utc::now() - Duration::minutes(30);
    let stale_threshold = Utc::now() - Duration::minutes(2);
    let removed = repo
        .delete_afk(threshold, stale_threshold)
        .await
        .expect("delete_afk should succeed");

    // WHY: delete_afk operates globally. Assert OUR active session was NOT removed.
    let our_removed = removed.iter().any(|s| s.user_id == *uid);
    assert!(
        !our_removed,
        "Active session should NOT be removed by delete_afk"
    );

    cleanup_auto_disconnect_fixture(&pool, &fixture).await;
}

/// T8.11: delete_afk does NOT double-delete stale sessions.
/// A session with last_seen_at < stale_threshold is already stale (handled
/// by delete_stale) and should NOT be re-deleted by delete_afk.
#[tokio::test]
#[ignore = "requires local Supabase Postgres"]
async fn t8_11_delete_afk_excludes_stale_sessions() {
    let pool = test_pool().await;
    let fixture = seed_auto_disconnect_fixture(&pool, 1, 1).await;
    let repo = PgVoiceSessionRepository::new(pool.clone());

    let uid = &fixture.user_ids[0];
    let cid = &fixture.channel_ids[0];
    let sid = &fixture.server_id;

    // Insert session, backdate both last_active_at and last_seen_at to 35 min ago.
    insert_raw_session(&pool, uid, cid, sid, "sess-afk-3").await;
    let thirty_five_min_ago = Utc::now() - Duration::minutes(35);
    sqlx::query!(
        "UPDATE voice_sessions SET last_active_at = $1, last_seen_at = $1 WHERE user_id = $2",
        thirty_five_min_ago,
        uid.0,
    )
    .execute(&pool)
    .await
    .expect("backdate both timestamps");

    // Threshold = 30 min ago, stale_threshold = 2 min ago.
    // last_seen_at (35 min ago) < stale_threshold (2 min ago) → excluded by the
    // `last_seen_at >= stale_threshold` guard.
    let threshold = Utc::now() - Duration::minutes(30);
    let stale_threshold = Utc::now() - Duration::minutes(2);
    let removed = repo
        .delete_afk(threshold, stale_threshold)
        .await
        .expect("delete_afk should succeed");

    // WHY: delete_afk operates globally. Other parallel tests may have sessions
    // matching the criteria. Assert that OUR specific session was NOT removed.
    let our_removed = removed.iter().any(|s| s.user_id == *uid);
    assert!(
        !our_removed,
        "Our stale session should NOT be removed by delete_afk (last_seen_at < stale_threshold)"
    );

    // Double-check: our session should still exist in the DB.
    let still_exists = sqlx::query_scalar!(
        "SELECT COUNT(*) as \"count!\" FROM voice_sessions WHERE user_id = $1",
        uid.0,
    )
    .fetch_one(&pool)
    .await
    .expect("check session still exists");
    assert_eq!(
        still_exists, 1,
        "Stale session should still exist in DB after delete_afk"
    );

    cleanup_auto_disconnect_fixture(&pool, &fixture).await;
}

// ══════════════════════════════════════════════════════════════════════════
// T8.12-T8.13: Heartbeat tests (touch)
// ══════════════════════════════════════════════════════════════════════════

/// T8.12: touch(is_active=true) updates last_active_at.
#[tokio::test]
#[ignore = "requires local Supabase Postgres"]
async fn t8_12_touch_active_updates_last_active_at() {
    let pool = test_pool().await;
    let fixture = seed_auto_disconnect_fixture(&pool, 1, 1).await;
    let repo = PgVoiceSessionRepository::new(pool.clone());

    let uid = &fixture.user_ids[0];
    let cid = &fixture.channel_ids[0];
    let sid = &fixture.server_id;
    let session_id = "sess-touch-active";

    // Insert session, backdate last_active_at to 10 minutes ago.
    insert_raw_session(&pool, uid, cid, sid, session_id).await;
    let ten_min_ago = Utc::now() - Duration::minutes(10);
    sqlx::query!(
        "UPDATE voice_sessions SET last_active_at = $1 WHERE user_id = $2",
        ten_min_ago,
        uid.0,
    )
    .execute(&pool)
    .await
    .expect("backdate last_active_at");

    let before: chrono::DateTime<Utc> = sqlx::query_scalar!(
        "SELECT last_active_at FROM voice_sessions WHERE user_id = $1",
        uid.0,
    )
    .fetch_one(&pool)
    .await
    .expect("query last_active_at before");

    // Touch with is_active=true.
    let updated = repo
        .touch(uid, session_id, true)
        .await
        .expect("touch should succeed");
    assert!(updated, "touch should return true for matching session");

    let after: chrono::DateTime<Utc> = sqlx::query_scalar!(
        "SELECT last_active_at FROM voice_sessions WHERE user_id = $1",
        uid.0,
    )
    .fetch_one(&pool)
    .await
    .expect("query last_active_at after");

    assert!(
        after > before,
        "last_active_at should be updated: before={before}, after={after}"
    );

    cleanup_auto_disconnect_fixture(&pool, &fixture).await;
}

/// T8.13: touch(is_active=false) does NOT update last_active_at.
#[tokio::test]
#[ignore = "requires local Supabase Postgres"]
async fn t8_13_touch_inactive_does_not_update_last_active_at() {
    let pool = test_pool().await;
    let fixture = seed_auto_disconnect_fixture(&pool, 1, 1).await;
    let repo = PgVoiceSessionRepository::new(pool.clone());

    let uid = &fixture.user_ids[0];
    let cid = &fixture.channel_ids[0];
    let sid = &fixture.server_id;
    let session_id = "sess-touch-inactive";

    // Insert session, backdate last_active_at to 10 minutes ago.
    insert_raw_session(&pool, uid, cid, sid, session_id).await;
    let ten_min_ago = Utc::now() - Duration::minutes(10);
    sqlx::query!(
        "UPDATE voice_sessions SET last_active_at = $1 WHERE user_id = $2",
        ten_min_ago,
        uid.0,
    )
    .execute(&pool)
    .await
    .expect("backdate last_active_at");

    let before: chrono::DateTime<Utc> = sqlx::query_scalar!(
        "SELECT last_active_at FROM voice_sessions WHERE user_id = $1",
        uid.0,
    )
    .fetch_one(&pool)
    .await
    .expect("query last_active_at before");

    // Touch with is_active=false.
    let updated = repo
        .touch(uid, session_id, false)
        .await
        .expect("touch should succeed");
    assert!(updated, "touch should return true for matching session");

    let after: chrono::DateTime<Utc> = sqlx::query_scalar!(
        "SELECT last_active_at FROM voice_sessions WHERE user_id = $1",
        uid.0,
    )
    .fetch_one(&pool)
    .await
    .expect("query last_active_at after");

    assert_eq!(
        before, after,
        "last_active_at should NOT change with is_active=false"
    );

    cleanup_auto_disconnect_fixture(&pool, &fixture).await;
}

// ══════════════════════════════════════════════════════════════════════════
// T8.14-T8.15: Upsert last_active_at tests
// ══════════════════════════════════════════════════════════════════════════

/// T8.14: upsert sets last_active_at = now() on new session.
#[tokio::test]
#[ignore = "requires local Supabase Postgres"]
async fn t8_14_upsert_sets_last_active_at_on_new_session() {
    let pool = test_pool().await;
    let fixture = seed_auto_disconnect_fixture(&pool, 1, 1).await;
    let repo = PgVoiceSessionRepository::new(pool.clone());

    let uid = &fixture.user_ids[0];
    let cid = &fixture.channel_ids[0];
    let sid = &fixture.server_id;

    let before = Utc::now();

    let new_session = harmony_api::domain::models::NewVoiceSession {
        user_id: uid.clone(),
        channel_id: cid.clone(),
        server_id: sid.clone(),
        session_id: "sess-upsert-new".to_string(),
    };
    repo.upsert(&new_session)
        .await
        .expect("upsert should succeed");

    let last_active: chrono::DateTime<Utc> = sqlx::query_scalar!(
        "SELECT last_active_at FROM voice_sessions WHERE user_id = $1",
        uid.0,
    )
    .fetch_one(&pool)
    .await
    .expect("query last_active_at");

    // last_active_at should be >= before (approximately now()).
    assert!(
        last_active >= before - Duration::seconds(2),
        "last_active_at should be approximately now(): last_active={last_active}, before={before}"
    );

    cleanup_auto_disconnect_fixture(&pool, &fixture).await;
}

/// T8.15: upsert resets last_active_at = now() on channel switch (ON CONFLICT).
#[tokio::test]
#[ignore = "requires local Supabase Postgres"]
async fn t8_15_upsert_resets_last_active_at_on_conflict() {
    let pool = test_pool().await;
    let fixture = seed_auto_disconnect_fixture(&pool, 1, 2).await;
    let repo = PgVoiceSessionRepository::new(pool.clone());

    let uid = &fixture.user_ids[0];
    let cid_1 = &fixture.channel_ids[0];
    let cid_2 = &fixture.channel_ids[1];
    let sid = &fixture.server_id;

    // Insert initial session in channel 1, backdate last_active_at.
    insert_raw_session(&pool, uid, cid_1, sid, "sess-upsert-switch-1").await;
    let twenty_min_ago = Utc::now() - Duration::minutes(20);
    sqlx::query!(
        "UPDATE voice_sessions SET last_active_at = $1 WHERE user_id = $2",
        twenty_min_ago,
        uid.0,
    )
    .execute(&pool)
    .await
    .expect("backdate last_active_at");

    let before = Utc::now();

    // Upsert into channel 2 — triggers ON CONFLICT → resets last_active_at.
    let new_session = harmony_api::domain::models::NewVoiceSession {
        user_id: uid.clone(),
        channel_id: cid_2.clone(),
        server_id: sid.clone(),
        session_id: "sess-upsert-switch-2".to_string(),
    };
    repo.upsert(&new_session)
        .await
        .expect("upsert should succeed");

    let last_active: chrono::DateTime<Utc> = sqlx::query_scalar!(
        "SELECT last_active_at FROM voice_sessions WHERE user_id = $1",
        uid.0,
    )
    .fetch_one(&pool)
    .await
    .expect("query last_active_at after conflict");

    assert!(
        last_active >= before - Duration::seconds(2),
        "last_active_at should be reset to now() on conflict: last_active={last_active}, before={before}"
    );
    assert!(
        last_active > twenty_min_ago,
        "last_active_at should be newer than the backdated value"
    );

    cleanup_auto_disconnect_fixture(&pool, &fixture).await;
}

// ══════════════════════════════════════════════════════════════════════════
// T8.19: Handler — muted user heartbeat updates last_active_at
// ══════════════════════════════════════════════════════════════════════════

/// T8.19: handler — muted user heartbeat updates last_active_at because
/// effective_active = true (is_muted=true overrides is_active=false).
#[tokio::test]
#[ignore = "requires local Supabase Postgres"]
async fn t8_19_handler_muted_heartbeat_updates_last_active_at() {
    let pool = test_pool().await;
    let fixture = seed_auto_disconnect_fixture(&pool, 1, 1).await;
    let state = build_app_state_with_voice(pool.clone()).await;
    let app = heartbeat_router(state);

    let uid = &fixture.user_ids[0];
    let cid = &fixture.channel_ids[0];
    let sid = &fixture.server_id;
    let session_id = "sess-handler-muted";

    // Insert session, backdate last_active_at.
    insert_raw_session(&pool, uid, cid, sid, session_id).await;
    let ten_min_ago = Utc::now() - Duration::minutes(10);
    sqlx::query!(
        "UPDATE voice_sessions SET last_active_at = $1 WHERE user_id = $2",
        ten_min_ago,
        uid.0,
    )
    .execute(&pool)
    .await
    .expect("backdate last_active_at");

    let jwt = sign_test_jwt(uid.0);

    // Send heartbeat with is_active=false, is_muted=true.
    // WHY: effective_active = false || true = true → last_active_at should update.
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/voice/heartbeat")
                .header(header::AUTHORIZATION, format!("Bearer {jwt}"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(format!(
                    r#"{{"sessionId":"{session_id}","isActive":false,"isMuted":true}}"#
                )))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(
        response.status(),
        StatusCode::NO_CONTENT,
        "Muted heartbeat should succeed"
    );

    let after: chrono::DateTime<Utc> = sqlx::query_scalar!(
        "SELECT last_active_at FROM voice_sessions WHERE user_id = $1",
        uid.0,
    )
    .fetch_one(&pool)
    .await
    .expect("query last_active_at after heartbeat");

    assert!(
        after > ten_min_ago,
        "last_active_at should be updated because muted user counts as active: after={after}"
    );

    cleanup_auto_disconnect_fixture(&pool, &fixture).await;
}

// ══════════════════════════════════════════════════════════════════════════
// T8.20: Transition test — muted→unmuted→silent for 30 min → AFK kicks
// ══════════════════════════════════════════════════════════════════════════

/// T8.20: Full transition test.
/// Setup: session exists, last_active_at was kept fresh by muted heartbeats.
/// Transition: user unmutes but stays silent (is_active=false, is_muted=false).
/// After 31 min of silence, delete_afk removes the session.
#[tokio::test]
#[ignore = "requires local Supabase Postgres"]
async fn t8_20_muted_to_unmuted_silent_transition_causes_afk_kick() {
    let pool = test_pool().await;
    let fixture = seed_auto_disconnect_fixture(&pool, 1, 1).await;
    let repo = PgVoiceSessionRepository::new(pool.clone());

    let uid = &fixture.user_ids[0];
    let cid = &fixture.channel_ids[0];
    let sid = &fixture.server_id;
    let session_id = "sess-transition";

    // Phase 1: Session exists, simulate muted heartbeats keeping it fresh.
    insert_raw_session(&pool, uid, cid, sid, session_id).await;

    // Phase 2: User unmutes but stays silent. Simulate: no active heartbeats
    // for 31 minutes by backdating last_active_at.
    let thirty_one_min_ago = Utc::now() - Duration::minutes(31);
    sqlx::query!(
        "UPDATE voice_sessions SET last_active_at = $1 WHERE user_id = $2",
        thirty_one_min_ago,
        uid.0,
    )
    .execute(&pool)
    .await
    .expect("backdate last_active_at to simulate unmuted silence");

    // Phase 3: AFK check should remove this session.
    let threshold = Utc::now() - Duration::minutes(30);
    let stale_threshold = Utc::now() - Duration::minutes(2);
    let removed = repo
        .delete_afk(threshold, stale_threshold)
        .await
        .expect("delete_afk should succeed");

    // WHY: delete_afk operates globally. The session may have been removed
    // by a concurrent test's delete_afk. Verify the session is gone.
    let our_removed = removed.iter().any(|s| s.user_id == *uid);
    let exists_after = sqlx::query_scalar!(
        "SELECT COUNT(*) as \"count!\" FROM voice_sessions WHERE user_id = $1",
        uid.0,
    )
    .fetch_one(&pool)
    .await
    .expect("check session after delete_afk");

    assert!(
        our_removed || exists_after == 0,
        "Session should be removed by delete_afk: our_removed={our_removed}, exists_after={exists_after}"
    );

    cleanup_auto_disconnect_fixture(&pool, &fixture).await;
}
