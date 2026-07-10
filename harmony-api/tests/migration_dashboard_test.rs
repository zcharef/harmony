#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Member-migration command-center integration tests — real DB.
//!
//! Pins the owner dashboard queries (growth-plan §14.1) against the merged
//! §5/§10 analytics views on a seeded fixture, and proves the app-layer
//! ownership guard (only the owner reads their server's people-metrics).
//!
//! Fixture shape (one server owned by `owner`, week-1 window still open):
//!   - `active_member`  — joined + sent a message  → active, first-message
//!   - `reactor_member` — joined + added a reaction → active, no message
//!   - `dormant_a`      — joined, no genuine action → NOT-yet-active
//!   - `dormant_b`      — joined, only a `server_joined` event (presence,
//!     not participation) → NOT-yet-active (proves joins never count active)
//!   - `excluded_alt`   — joined but on analytics.exclusions → absent entirely
//!
//! WHY #[ignore]: requires a running Postgres (Supabase) with the Harmony
//! schema + the analytics views. Run locally with:
//!   `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:64322/postgres \
//!      cargo test --test migration_dashboard_test -- --ignored`

use std::sync::Arc;

use sqlx::PgPool;
use uuid::Uuid;

use harmony_api::domain::models::{RecommendedAction, ServerId, UserId};
use harmony_api::domain::services::MigrationService;
use harmony_api::infra::postgres::{PgMigrationDashboardRepository, PgServerRepository};

async fn test_pool() -> PgPool {
    dotenvy::dotenv().ok();
    let url =
        std::env::var("DATABASE_URL").expect("DATABASE_URL must be set for integration tests");
    PgPool::connect(&url)
        .await
        .expect("Failed to connect to test database")
}

fn service(pool: &PgPool) -> MigrationService {
    MigrationService::new(
        Arc::new(PgServerRepository::new(pool.clone())),
        Arc::new(PgMigrationDashboardRepository::new(pool.clone())),
    )
}

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
    .bind(format!("mig-{uid}@example.com"))
    .execute(pool)
    .await
    .expect("seed auth.users");

    let username = format!("mg{}", &uid.simple().to_string()[..10]);
    sqlx::query("INSERT INTO profiles (id, username) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING")
        .bind(uid)
        .bind(username)
        .execute(pool)
        .await
        .expect("seed profiles");

    uid
}

async fn seed_server(pool: &PgPool, owner: Uuid) -> Uuid {
    let sid = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO servers (id, name, owner_id, is_dm, created_at, updated_at) VALUES ($1, $2, $3, false, now(), now())",
    )
    .bind(sid)
    .bind("Maya's Community")
    .bind(owner)
    .execute(pool)
    .await
    .expect("seed servers");
    sid
}

async fn add_member(pool: &PgPool, server_id: Uuid, user_id: Uuid) {
    sqlx::query(
        "INSERT INTO server_members (server_id, user_id, joined_at) VALUES ($1, $2, now()) ON CONFLICT DO NOTHING",
    )
    .bind(server_id)
    .bind(user_id)
    .execute(pool)
    .await
    .expect("seed server_members");
}

async fn seed_channel(pool: &PgPool, server_id: Uuid) -> Uuid {
    let cid = Uuid::new_v4();
    sqlx::query("INSERT INTO channels (id, server_id, name) VALUES ($1, $2, 'general')")
        .bind(cid)
        .bind(server_id)
        .execute(pool)
        .await
        .expect("seed channels");
    cid
}

async fn seed_message(pool: &PgPool, channel_id: Uuid, author_id: Uuid) {
    sqlx::query("INSERT INTO messages (channel_id, author_id, content) VALUES ($1, $2, 'hello')")
        .bind(channel_id)
        .bind(author_id)
        .execute(pool)
        .await
        .expect("seed messages");
}

async fn seed_event(pool: &PgPool, name: &str, user_id: Uuid, server_id: Uuid) {
    sqlx::query("INSERT INTO analytics_events (name, user_id, server_id) VALUES ($1, $2, $3)")
        .bind(name)
        .bind(user_id)
        .bind(server_id)
        .execute(pool)
        .await
        .expect("seed analytics_events");
}

async fn exclude_user(pool: &PgPool, user_id: Uuid) {
    sqlx::query(
        "INSERT INTO analytics.exclusions (scope, target_id, reason) VALUES ('user', $1, 'integration-test alt') ON CONFLICT DO NOTHING",
    )
    .bind(user_id)
    .execute(pool)
    .await
    .expect("seed exclusions");
}

/// Builds the whole fixture and returns `(owner, server_id, dormant_a, dormant_b)`.
async fn seed_fixture(pool: &PgPool) -> (Uuid, Uuid, Uuid, Uuid) {
    let owner = seed_user(pool).await;
    let active_member = seed_user(pool).await;
    let reactor_member = seed_user(pool).await;
    let dormant_a = seed_user(pool).await;
    let dormant_b = seed_user(pool).await;
    let excluded_alt = seed_user(pool).await;

    let server_id = seed_server(pool, owner).await;
    let channel_id = seed_channel(pool, server_id).await;

    for u in [
        owner,
        active_member,
        reactor_member,
        dormant_a,
        dormant_b,
        excluded_alt,
    ] {
        add_member(pool, server_id, u).await;
    }

    // active_member: a real message → genuine activity + first message.
    seed_message(pool, channel_id, active_member).await;
    // reactor_member: a reaction → genuine activity, but no message.
    seed_event(pool, "reaction_added", reactor_member, server_id).await;
    // dormant_b: only a presence-only join event → must NOT count as active.
    seed_event(pool, "server_joined", dormant_b, server_id).await;
    // excluded_alt: also "joined", but excluded from analytics entirely.
    seed_event(pool, "server_joined", excluded_alt, server_id).await;
    exclude_user(pool, excluded_alt).await;

    (owner, server_id, dormant_a, dormant_b)
}

#[tokio::test]
#[ignore = "requires local Postgres (Supabase) with Harmony schema + analytics views"]
async fn follow_through_counts_reuse_the_alive_active_definition() {
    let pool = test_pool().await;
    let (owner, server_id, _, _) = seed_fixture(&pool).await;
    let svc = service(&pool);

    let progress = svc
        .progress(&ServerId::new(server_id), &UserId::new(owner))
        .await
        .expect("owner reads progress");

    let ft = &progress.follow_through;
    // 4 eligible non-owner members joined (the excluded alt drops out entirely).
    assert_eq!(ft.members_joined, 4, "excluded alt must not inflate joins");
    // 2 genuinely active: the message sender + the reactor. The presence-only
    // joiner (dormant_b) does NOT count — joins are not activity (§5 criterion 2).
    assert_eq!(
        ft.members_active, 2,
        "only genuine actions (message/reaction) count as active"
    );
    assert_eq!(ft.members_sent_message, 1, "only one member sent a message");
    assert_eq!(
        ft.not_yet_active, 2,
        "the two dormant members are the intervention targets"
    );

    // Fresh server, <3 active → the playbook says seed conversation.
    assert_eq!(
        progress.recommended_action,
        RecommendedAction::SeedConversation
    );
}

#[tokio::test]
#[ignore = "requires local Postgres (Supabase) with Harmony schema + analytics views"]
async fn cohort_lists_only_the_not_yet_active_members() {
    let pool = test_pool().await;
    let (owner, server_id, dormant_a, dormant_b) = seed_fixture(&pool).await;
    let svc = service(&pool);

    let page = svc
        .not_yet_active_cohort(&ServerId::new(server_id), &UserId::new(owner), None, 25)
        .await
        .expect("owner reads cohort");

    assert_eq!(page.total, 2, "exactly two not-yet-active members");
    let ids: Vec<Uuid> = page.items.iter().map(|m| m.user_id.0).collect();
    assert!(ids.contains(&dormant_a), "dormant_a must be a target");
    assert!(
        ids.contains(&dormant_b),
        "presence-only joiner is still not-yet-active"
    );
    // Nobody in the cohort has sent a message (a message is a genuine action).
    assert!(page.items.iter().all(|m| !m.has_sent_message));
}

#[tokio::test]
#[ignore = "requires local Postgres (Supabase) with Harmony schema + analytics views"]
async fn only_the_owner_can_read_the_dashboard() {
    let pool = test_pool().await;
    let (_owner, server_id, _, _) = seed_fixture(&pool).await;
    let intruder = seed_user(&pool).await;
    let svc = service(&pool);

    // The intruder is a real user, just not the owner (nor even a member).
    let progress_err = svc
        .progress(&ServerId::new(server_id), &UserId::new(intruder))
        .await;
    assert!(
        matches!(
            progress_err,
            Err(harmony_api::domain::errors::DomainError::Forbidden(_))
        ),
        "a non-owner must be forbidden from progress, got {progress_err:?}"
    );

    let cohort_err = svc
        .not_yet_active_cohort(&ServerId::new(server_id), &UserId::new(intruder), None, 25)
        .await;
    assert!(
        matches!(
            cohort_err,
            Err(harmony_api::domain::errors::DomainError::Forbidden(_))
        ),
        "a non-owner must be forbidden from the cohort, got {cohort_err:?}"
    );
}

#[tokio::test]
#[ignore = "requires local Postgres (Supabase) with Harmony schema + analytics views"]
async fn missing_server_is_not_found() {
    let pool = test_pool().await;
    let caller = seed_user(&pool).await;
    let svc = service(&pool);

    let err = svc
        .progress(&ServerId::new(Uuid::new_v4()), &UserId::new(caller))
        .await;
    assert!(
        matches!(
            err,
            Err(harmony_api::domain::errors::DomainError::NotFound { .. })
        ),
        "an unknown server must be 404, got {err:?}"
    );
}
