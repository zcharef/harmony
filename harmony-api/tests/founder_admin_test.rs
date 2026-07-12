#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Founder platform-admin integration tests — the privilege-escalation surface
//! (real DB + real HTTP via `tower::ServiceExt::oneshot`, plus direct domain/
//! infra calls for the authz + plan-bypass short-circuits).
//!
//! SECURITY invariants pinned here:
//! 1. Every admin endpoint 403s for a non-founder.
//! 2. A user who merely holds the `official`/`founding` BADGE is NOT the founder
//!    (badges ≠ powers) — the gate keys ONLY off the resolved founder `UserId`.
//! 3. The founder is admin on a server he is NOT a member of (admin-everywhere),
//!    while a normal non-member is still Forbidden.
//! 4. The founder bypasses a plan limit that would block a normal user.
//! 5. PATCH plan actually changes `profiles.plan` and is founder-gated.
//! 6. The quota endpoint returns the user's real usage.
//!
//! WHY #[ignore]: requires a running Postgres (local Supabase). Run with:
//!   `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:64322/postgres \
//!      cargo test --test founder_admin_test -- --ignored`

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

use harmony_api::api::handlers::admin;
use harmony_api::api::middleware::auth::require_auth;
use harmony_api::api::state::AppState;
use harmony_api::domain::models::{Role, ServerId, UserId};

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
        "email": "founder-admin-test@example.com",
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

/// Build a full `AppState` with the founder identity wired (via `with_founder`),
/// mirroring production. The plan checker is `AlwaysAllowed` — the plan-bypass
/// short-circuit is exercised separately against a real `PgPlanLimitChecker`.
async fn app_state(
    pool: PgPool,
    official_server_id: Option<ServerId>,
    founder: Option<UserId>,
) -> AppState {
    use harmony_api::domain::services::{ContentFilter, SpamGuard};
    use harmony_api::infra::PgPresenceTracker;
    use harmony_api::infra::pg_notify_event_bus::PgNotifyEventBus;
    use harmony_api::infra::plan_always_allowed::AlwaysAllowedChecker;
    use harmony_api::infra::postgres::{
        PgBanRepository, PgChannelRepository, PgDesktopAuthRepository, PgDmRepository,
        PgFriendshipRepository, PgInviteRepository, PgKeyRepository, PgMegolmSessionRepository,
        PgMemberRepository, PgMessageRepository, PgModerationRetryRepository,
        PgNotificationSettingsRepository, PgProfileRepository, PgReactionRepository,
        PgReadStateRepository, PgServerRepository, PgUserPreferencesRepository,
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
    let attachment_scan_retry_repo =
        Arc::new(harmony_api::infra::postgres::PgAttachmentScanRetryRepository::new(pool.clone()));
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
    let moderation_service = Arc::new(
        harmony_api::domain::services::ModerationService::new(
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
        )
        .with_founder(founder.clone()),
    );
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
        std::sync::Arc::new(harmony_api::infra::NoopImageClassifier),
        std::sync::Arc::new(harmony_api::infra::NoopCsamMatcher),
        attachment_repo.clone(),
        attachment_scan_retry_repo,
        false,
        None,
        None,
        official_server_id,
        analytics_recorder,
        Some("https://test.supabase.co".to_string()),
        None,
    )
    .with_founder(founder)
}

fn admin_router(state: AppState) -> Router {
    let authenticated = Router::new()
        .route("/v1/admin/users", get(admin::search_users))
        .route("/v1/admin/users/{id}/plan", patch(admin::set_user_plan))
        .route("/v1/admin/users/{id}/quota", get(admin::get_user_quota))
        .route_layer(middleware::from_fn_with_state(state.clone(), require_auth));
    Router::new().merge(authenticated).with_state(state)
}

// ── Fixtures ──────────────────────────────────────────────────────────────

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
    .bind(format!("fa-{uid}@example.com"))
    .execute(pool)
    .await
    .expect("seed auth.users");

    let username = format!("fa{}", &uid.simple().to_string()[..10]);
    sqlx::query(
        "INSERT INTO profiles (id, username, display_name) VALUES ($1, $2, 'Founder Admin Tester') ON CONFLICT (id) DO NOTHING",
    )
    .bind(uid)
    .bind(&username)
    .execute(pool)
    .await
    .expect("seed profiles");

    // WHY read back: a DB trigger (`handle_new_user`) may create the profile row
    // from the auth.users insert BEFORE this INSERT, making it a no-op. The
    // stored username (trigger-derived from the email) is then the real handle.
    let stored: String = sqlx::query_scalar("SELECT username FROM profiles WHERE id = $1")
        .bind(uid)
        .fetch_one(pool)
        .await
        .expect("read back seeded username");
    (uid, stored)
}

async fn seed_server(pool: &PgPool, owner: Uuid) -> Uuid {
    let sid = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO servers (id, name, owner_id, is_dm, created_at, updated_at) VALUES ($1, $2, $3, false, now(), now())",
    )
    .bind(sid)
    .bind(format!("Srv {}", &sid.to_string()[..8]))
    .bind(owner)
    .execute(pool)
    .await
    .expect("seed servers");
    sid
}

async fn grant_badge(pool: &PgPool, user: Uuid, badge: &str) {
    sqlx::query("INSERT INTO user_badges (user_id, badge) VALUES ($1, $2) ON CONFLICT DO NOTHING")
        .bind(user)
        .bind(badge)
        .execute(pool)
        .await
        .expect("grant badge");
}

async fn plan_of(pool: &PgPool, user: Uuid) -> String {
    sqlx::query_scalar("SELECT plan FROM profiles WHERE id = $1")
        .bind(user)
        .fetch_one(pool)
        .await
        .expect("read plan")
}

async fn cleanup(pool: &PgPool, users: &[Uuid], servers: &[Uuid]) {
    let _ = sqlx::query("DELETE FROM servers WHERE id = ANY($1)")
        .bind(servers.to_vec())
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
        .expect("read body");
    serde_json::from_slice(&bytes).expect("parse body JSON")
}

fn get_req(uri: &str, token: Uuid) -> Request<Body> {
    Request::builder()
        .method("GET")
        .uri(uri)
        .header(
            header::AUTHORIZATION,
            format!("Bearer {}", sign_test_jwt(token)),
        )
        .body(Body::empty())
        .unwrap()
}

fn patch_plan(uri: &str, token: Uuid, plan: &str) -> Request<Body> {
    Request::builder()
        .method("PATCH")
        .uri(uri)
        .header(
            header::AUTHORIZATION,
            format!("Bearer {}", sign_test_jwt(token)),
        )
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(format!(r#"{{"plan":"{plan}"}}"#)))
        .unwrap()
}

// ── Tests ───────────────────────────────────────────────────────────────

/// Every admin endpoint 403s for a non-founder — INCLUDING a user who holds the
/// `official` AND `founding` badges. Badges ≠ founder powers.
#[tokio::test]
#[ignore = "requires local Supabase Postgres"]
async fn admin_endpoints_403_for_non_founder_and_badge_holder() {
    let pool = test_pool().await;
    let (founder, _) = seed_user(&pool).await;
    let (intruder, _) = seed_user(&pool).await;
    let (badge_holder, _) = seed_user(&pool).await;
    let (subject, _) = seed_user(&pool).await;
    // The badge holder wears both verification badges but is NOT the official
    // server's owner — so must never be treated as founder.
    grant_badge(&pool, badge_holder, "official").await;
    grant_badge(&pool, badge_holder, "founding").await;
    let official = seed_server(&pool, founder).await;

    let state = app_state(
        pool.clone(),
        Some(ServerId::new(official)),
        Some(UserId::new(founder)),
    )
    .await;

    for probe in [intruder, badge_holder] {
        for req in [
            get_req("/v1/admin/users?q=fa", probe),
            get_req(&format!("/v1/admin/users/{subject}/quota"), probe),
            patch_plan(
                &format!("/v1/admin/users/{subject}/plan"),
                probe,
                "supporter",
            ),
        ] {
            let resp = admin_router(state.clone()).oneshot(req).await.unwrap();
            assert_eq!(
                resp.status(),
                StatusCode::FORBIDDEN,
                "non-founder must be forbidden on every admin endpoint"
            );
        }
    }

    // The forbidden plan attempts must not have mutated the subject.
    assert_eq!(plan_of(&pool, subject).await, "free");

    cleanup(
        &pool,
        &[founder, intruder, badge_holder, subject],
        &[official],
    )
    .await;
}

/// Founder happy path: set plan persists to `profiles.plan`, and search finds
/// the user with the new plan.
#[tokio::test]
#[ignore = "requires local Supabase Postgres"]
async fn founder_sets_plan_and_search_reflects_it() {
    let pool = test_pool().await;
    let (founder, _) = seed_user(&pool).await;
    let (subject, subject_handle) = seed_user(&pool).await;
    let official = seed_server(&pool, founder).await;

    let state = app_state(
        pool.clone(),
        Some(ServerId::new(official)),
        Some(UserId::new(founder)),
    )
    .await;

    let resp = admin_router(state.clone())
        .oneshot(patch_plan(
            &format!("/v1/admin/users/{subject}/plan"),
            founder,
            "creator",
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    assert_eq!(json["plan"], "creator");
    assert_eq!(plan_of(&pool, subject).await, "creator");

    // Search by the subject's handle returns it with the updated plan.
    let resp = admin_router(state)
        .oneshot(get_req(
            &format!("/v1/admin/users?q={subject_handle}"),
            founder,
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    let items = json["items"].as_array().expect("items array");
    assert!(
        items
            .iter()
            .any(|u| u["id"] == subject.to_string() && u["plan"] == "creator"),
        "search must surface the subject with its new plan"
    );

    cleanup(&pool, &[founder, subject], &[official]).await;
}

/// Quota endpoint returns the user's real usage counts.
#[tokio::test]
#[ignore = "requires local Supabase Postgres"]
async fn founder_quota_returns_usage() {
    let pool = test_pool().await;
    let (founder, _) = seed_user(&pool).await;
    let (subject, _) = seed_user(&pool).await;
    let official = seed_server(&pool, founder).await;
    // Subject owns two servers (and is auto-membered into them below).
    let s1 = seed_server(&pool, subject).await;
    let s2 = seed_server(&pool, subject).await;
    for sid in [s1, s2] {
        sqlx::query(
            "INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING",
        )
        .bind(sid)
        .bind(subject)
        .execute(&pool)
        .await
        .expect("seed membership");
    }

    let state = app_state(
        pool.clone(),
        Some(ServerId::new(official)),
        Some(UserId::new(founder)),
    )
    .await;

    let resp = admin_router(state)
        .oneshot(get_req(
            &format!("/v1/admin/users/{subject}/quota"),
            founder,
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    assert_eq!(json["plan"], "free");
    assert_eq!(json["usage"]["ownedServers"], 2);
    assert_eq!(json["usage"]["joinedServers"], 2);
    assert_eq!(json["limits"]["maxOwnedServers"], 3);

    cleanup(&pool, &[founder, subject], &[official, s1, s2]).await;
}

/// The founder is admin (owner-level) on a server he is NOT a member of, while a
/// normal non-member is Forbidden. Drives the `ModerationService` short-circuit.
#[tokio::test]
#[ignore = "requires local Supabase Postgres"]
async fn founder_is_admin_on_foreign_server() {
    let pool = test_pool().await;
    let (founder, _) = seed_user(&pool).await;
    let (other_owner, _) = seed_user(&pool).await;
    let (stranger, _) = seed_user(&pool).await;
    let official = seed_server(&pool, founder).await;
    // A server the founder has NOTHING to do with (not owner, not a member).
    let foreign = seed_server(&pool, other_owner).await;

    let state = app_state(
        pool.clone(),
        Some(ServerId::new(official)),
        Some(UserId::new(founder)),
    )
    .await;
    let svc = state.moderation_service();
    let foreign_id = ServerId::new(foreign);

    // Founder → Owner on the foreign server WITHOUT a membership row.
    let role = svc
        .require_role(&foreign_id, &UserId::new(founder), Role::Owner)
        .await
        .expect("founder must be treated as owner on any server");
    assert_eq!(role, Role::Owner);

    // A normal non-member is Forbidden (no membership row → not a member).
    let err = svc
        .require_role(&foreign_id, &UserId::new(stranger), Role::Member)
        .await
        .expect_err("stranger must be forbidden");
    assert!(
        matches!(err, harmony_api::domain::errors::DomainError::Forbidden(_)),
        "got {err:?}"
    );

    // The founder is NOT silently inserted into server_members (hidden admin).
    let member_row: i64 = sqlx::query_scalar(
        "SELECT COALESCE(COUNT(*)::BIGINT,0) FROM server_members WHERE server_id=$1 AND user_id=$2",
    )
    .bind(foreign)
    .bind(founder)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        member_row, 0,
        "founder must remain a hidden (non-member) admin"
    );

    cleanup(
        &pool,
        &[founder, other_owner, stranger],
        &[official, foreign],
    )
    .await;
}

/// The founder bypasses a plan limit that blocks a normal user. Uses a real
/// `PgPlanLimitChecker` (with the founder wired) and the owned-server cap: Free
/// allows 3, so a normal owner at 3 is blocked while the founder passes.
#[tokio::test]
#[ignore = "requires local Supabase Postgres"]
async fn founder_bypasses_plan_limit() {
    use harmony_api::domain::ports::PlanLimitChecker;
    use harmony_api::infra::postgres::{PgAnalyticsRecorder, PgPlanLimitChecker};

    let pool = test_pool().await;
    let (founder, _) = seed_user(&pool).await;
    let (normal, _) = seed_user(&pool).await;
    // Both users already own 3 non-DM servers (the Free cap). A 4th would trip
    // the owned-server limit for the normal user.
    let mut servers = Vec::new();
    for owner in [founder, normal] {
        for _ in 0..3 {
            servers.push(seed_server(&pool, owner).await);
        }
    }

    let analytics: Arc<dyn harmony_api::domain::ports::AnalyticsRecorder> =
        Arc::new(PgAnalyticsRecorder::new(pool.clone()));
    let checker =
        PgPlanLimitChecker::new(pool.clone(), analytics).with_founder(Some(UserId::new(founder)));

    // Normal Free user at the cap → blocked.
    let err = checker
        .check_owned_server_limit(&UserId::new(normal))
        .await
        .expect_err("normal user at cap must be blocked");
    assert!(
        matches!(
            err,
            harmony_api::domain::errors::DomainError::LimitExceeded { .. }
        ),
        "got {err:?}"
    );

    // Founder at the same count → bypassed (self-hosted limits).
    checker
        .check_owned_server_limit(&UserId::new(founder))
        .await
        .expect("founder must bypass the plan limit");

    cleanup(&pool, &[founder, normal], &servers).await;
}

/// Self-hosted / no-founder instance: the admin endpoints are closed to
/// everyone (`founder_id` None → 403), and the founder short-circuits are inert.
#[tokio::test]
#[ignore = "requires local Supabase Postgres"]
async fn no_founder_closes_admin_surface() {
    let pool = test_pool().await;
    let (owner, _) = seed_user(&pool).await;
    let official = seed_server(&pool, owner).await;

    // official server configured, but founder NOT resolved (None).
    let state = app_state(pool.clone(), Some(ServerId::new(official)), None).await;

    let resp = admin_router(state)
        .oneshot(get_req("/v1/admin/users?q=fa", owner))
        .await
        .unwrap();
    assert_eq!(
        resp.status(),
        StatusCode::FORBIDDEN,
        "with no resolved founder, even the official-server owner is not an admin"
    );

    cleanup(&pool, &[owner], &[official]).await;
}
