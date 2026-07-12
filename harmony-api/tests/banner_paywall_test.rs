#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Profile-banner paywall integration tests (E8).
//!
//! The profile banner is a paid capability unlocked at Supporter+. The gate
//! reuses the zero-cap plan pattern (like custom emoji): Free's `max_banners`
//! is 0, so `check_banner_allowed` trips with `LimitExceeded { limit: 0 }`,
//! which the API error layer maps to a `FEATURE_NOT_IN_PLAN` 403 whose
//! `plan_gate.required_plan` is `supporter`.
//!
//! Tests the real `PgPlanLimitChecker` against a live DB (no mocks, ADR-018),
//! mirroring `founder_admin_test::founder_bypasses_plan_limit`.
//!
//! WHY #[ignore]: requires a running Postgres (local Supabase). Run with:
//!   `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:64322/postgres \
//!      cargo test --test banner_paywall_test -- --ignored`

use std::sync::Arc;

use sqlx::PgPool;
use uuid::Uuid;

use harmony_api::domain::errors::DomainError;
use harmony_api::domain::models::{Plan, ResourceKind, UserId};
use harmony_api::domain::ports::PlanLimitChecker;
use harmony_api::infra::postgres::{PgAnalyticsRecorder, PgPlanLimitChecker};

async fn test_pool() -> PgPool {
    dotenvy::dotenv().ok();
    let url =
        std::env::var("DATABASE_URL").expect("DATABASE_URL must be set for integration tests");
    PgPool::connect(&url)
        .await
        .expect("Failed to connect to test database")
}

/// Seed a user (auth.users + profiles). Returns the id.
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
    .bind(format!("banner-{uid}@example.com"))
    .execute(pool)
    .await
    .expect("seed auth.users");

    let username = format!("bn{}", &uid.simple().to_string()[..10]);
    sqlx::query(
        "INSERT INTO profiles (id, username, display_name) VALUES ($1, $2, 'Banner Tester') ON CONFLICT (id) DO NOTHING",
    )
    .bind(uid)
    .bind(&username)
    .execute(pool)
    .await
    .expect("seed profiles");
    uid
}

async fn set_plan(pool: &PgPool, user: Uuid, plan: Plan) {
    sqlx::query("UPDATE profiles SET plan = $2 WHERE id = $1")
        .bind(user)
        .bind(plan.as_str())
        .execute(pool)
        .await
        .expect("set plan");
}

async fn cleanup(pool: &PgPool, users: &[Uuid]) {
    let _ = sqlx::query("DELETE FROM auth.users WHERE id = ANY($1)")
        .bind(users.to_vec())
        .execute(pool)
        .await;
}

fn checker(pool: PgPool, founder: Option<Uuid>) -> PgPlanLimitChecker {
    let analytics: Arc<dyn harmony_api::domain::ports::AnalyticsRecorder> =
        Arc::new(PgAnalyticsRecorder::new(pool.clone()));
    PgPlanLimitChecker::new(pool, analytics).with_founder(founder.map(UserId::new))
}

/// Free plan → banner is not included → `FEATURE_NOT_IN_PLAN` (limit 0).
#[tokio::test]
#[ignore = "requires local Supabase Postgres"]
async fn free_user_cannot_set_banner() {
    let pool = test_pool().await;
    let user = seed_user(&pool).await;
    // Newly seeded profiles default to Free, but pin it explicitly.
    set_plan(&pool, user, Plan::Free).await;

    let checker = checker(pool.clone(), None);
    let err = checker
        .check_banner_allowed(&UserId::new(user))
        .await
        .expect_err("Free user must be blocked from setting a banner");

    match err {
        DomainError::LimitExceeded {
            resource,
            plan,
            limit,
        } => {
            assert_eq!(resource, ResourceKind::Banner);
            assert_eq!(plan, Some(Plan::Free));
            // limit == 0 is what the error layer maps to FEATURE_NOT_IN_PLAN,
            // and lowest_tier_unlocking(Banner, 0) == Supporter.
            assert_eq!(limit, 0);
        }
        other => panic!("expected LimitExceeded, got {other:?}"),
    }

    cleanup(&pool, &[user]).await;
}

/// Supporter plan → banner is included → allowed.
#[tokio::test]
#[ignore = "requires local Supabase Postgres"]
async fn supporter_user_can_set_banner() {
    let pool = test_pool().await;
    let user = seed_user(&pool).await;
    set_plan(&pool, user, Plan::Supporter).await;

    let checker = checker(pool.clone(), None);
    checker
        .check_banner_allowed(&UserId::new(user))
        .await
        .expect("Supporter must be allowed to set a banner");

    cleanup(&pool, &[user]).await;
}

/// Creator plan → banner is included → allowed.
#[tokio::test]
#[ignore = "requires local Supabase Postgres"]
async fn creator_user_can_set_banner() {
    let pool = test_pool().await;
    let user = seed_user(&pool).await;
    set_plan(&pool, user, Plan::Creator).await;

    let checker = checker(pool.clone(), None);
    checker
        .check_banner_allowed(&UserId::new(user))
        .await
        .expect("Creator must be allowed to set a banner");

    cleanup(&pool, &[user]).await;
}

/// The founder bypasses the banner gate even on a Free plan row — the checker
/// resolves the founder to `SELF_HOSTED_LIMITS` (`max_banners` = 1).
#[tokio::test]
#[ignore = "requires local Supabase Postgres"]
async fn founder_bypasses_banner_gate() {
    let pool = test_pool().await;
    let founder = seed_user(&pool).await;
    set_plan(&pool, founder, Plan::Free).await;

    let checker = checker(pool.clone(), Some(founder));
    checker
        .check_banner_allowed(&UserId::new(founder))
        .await
        .expect("founder must bypass the banner gate");

    cleanup(&pool, &[founder]).await;
}
