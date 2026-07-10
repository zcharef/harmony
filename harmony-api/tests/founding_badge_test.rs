#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Founding-member badge persistence + RLS regression tests (real DB).
//!
//! Pins the two guarantees the badge system leans on but that no unit test can
//! reach (they live below the `PgProfileRepository` / SQL boundary):
//!
//! 1. GRANT IDEMPOTENCY — `grant_badge` is `INSERT ... ON CONFLICT DO NOTHING`,
//!    so re-issuing the founding badge (login path re-runs, migration re-runs)
//!    never duplicates a row. Ticket §Tests: "Grant idempotency (re-run
//!    migration = no dupes)".
//! 2. RLS WRITE-LOCKDOWN — `user_badges` exposes a SELECT-open policy to
//!    `authenticated` and NO write policy, so a client (the `authenticated`
//!    Postgres role, RLS-enforced) can READ badges but can never INSERT one and
//!    self-mint `founding`. Writes are service_role-only (the API bypasses RLS).
//!    Ticket §Tests: "RLS visibility"; migration §RLS.
//!
//! WHY `#[ignore]`: requires a running Postgres with the Harmony schema
//! (mirrors the attachments / read-state integration tests). Run locally with:
//!   `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:64322/postgres \
//!      cargo test --test founding_badge_test -- --ignored`

use sqlx::PgPool;
use uuid::Uuid;

use harmony_api::domain::models::UserId;
use harmony_api::domain::ports::ProfileRepository;
use harmony_api::infra::postgres::PgProfileRepository;

const FOUNDING: &str = "founding";

// ── DB pool (mirrors attachments/read-state tests) ───────────────────────

async fn test_pool() -> PgPool {
    dotenvy::dotenv().ok();
    let url =
        std::env::var("DATABASE_URL").expect("DATABASE_URL must be set for integration tests");
    PgPool::connect(&url)
        .await
        .expect("Failed to connect to test database")
}

// ── Seeding (mirrors attachments_test) ───────────────────────────────────

/// Seed one user (`auth.users` + `profiles`) and return its id. Random UUID so
/// parallel/repeat runs against the shared DB never collide.
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
    .bind(format!("fnd-{uid}@example.com"))
    .execute(pool)
    .await
    .expect("seed auth.users");

    // Username must match profiles_username_format: ^[a-z0-9_]{3,32}$
    let username = format!("fn{}", &uid.simple().to_string()[..10]);
    sqlx::query(
        r#"
        INSERT INTO profiles (id, username, display_name)
        VALUES ($1, $2, 'Founding Tester')
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

/// Rows the given user holds for `badge` — `service_role` (this pool) count,
/// scoped to one user so a shared DB with other founders never skews it.
async fn badge_row_count(pool: &PgPool, user: Uuid, badge: &str) -> i64 {
    sqlx::query_scalar::<_, i64>(
        "SELECT COALESCE(COUNT(*)::BIGINT, 0) FROM user_badges WHERE user_id = $1 AND badge = $2",
    )
    .bind(user)
    .bind(badge)
    .fetch_one(pool)
    .await
    .expect("count user_badges")
}

async fn cleanup(pool: &PgPool, users: &[Uuid]) {
    // auth.users delete cascades to profiles (ON DELETE CASCADE), which cascades
    // to user_badges (user_id → profiles.id ON DELETE CASCADE).
    let _ = sqlx::query("DELETE FROM auth.users WHERE id = ANY($1)")
        .bind(users.to_vec())
        .execute(pool)
        .await;
}

// ── Tests ────────────────────────────────────────────────────────────────

/// Granting the founding badge twice leaves exactly one row: the `ON CONFLICT
/// (user_id, badge) DO NOTHING` write is idempotent, so the login-path grant and
/// the migration backfill can both fire without duplicating a badge.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn grant_founding_badge_is_idempotent() {
    let pool = test_pool().await;
    let repo = PgProfileRepository::new(pool.clone());

    let user = seed_user(&pool).await;
    let uid = UserId::new(user);

    assert_eq!(
        badge_row_count(&pool, user, FOUNDING).await,
        0,
        "fresh user must start with no founding badge"
    );

    repo.grant_badge(&uid, FOUNDING).await.expect("first grant");
    repo.grant_badge(&uid, FOUNDING)
        .await
        .expect("second grant must not error (ON CONFLICT DO NOTHING)");

    assert_eq!(
        badge_row_count(&pool, user, FOUNDING).await,
        1,
        "re-granting the founding badge must NOT create a duplicate row"
    );

    cleanup(&pool, &[user]).await;
}

/// `user_badges` is SELECT-open but write-locked for the `authenticated` role:
/// a client can read a badge the service granted, but can never INSERT one to
/// self-mint `founding`. This is the RLS posture the security model depends on.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn user_badges_rls_blocks_self_mint_but_allows_read() {
    let pool = test_pool().await;
    let repo = PgProfileRepository::new(pool.clone());

    let user = seed_user(&pool).await;
    let uid = UserId::new(user);

    // service_role (the API) grants the badge — this is the ONLY sanctioned path.
    repo.grant_badge(&uid, FOUNDING)
        .await
        .expect("service grant");

    // (1) READ as authenticated: the SELECT policy (USING true) admits the row.
    let mut tx = pool.begin().await.expect("begin read tx");
    sqlx::query("SET LOCAL ROLE authenticated")
        .execute(&mut *tx)
        .await
        .expect("set role authenticated");
    sqlx::query("SELECT set_config('request.jwt.claims', $1, true)")
        .bind(format!(r#"{{"sub": "{user}", "role": "authenticated"}}"#))
        .execute(&mut *tx)
        .await
        .expect("set jwt claims");
    let visible: i64 = sqlx::query_scalar(
        "SELECT COALESCE(COUNT(*)::BIGINT, 0) FROM user_badges WHERE user_id = $1 AND badge = $2",
    )
    .bind(user)
    .bind(FOUNDING)
    .fetch_one(&mut *tx)
    .await
    .expect("select as authenticated");
    drop(tx); // rollback → role/claims reset
    assert_eq!(
        visible, 1,
        "an authenticated client must be able to READ badges (SELECT policy is open)"
    );

    // (2) WRITE as authenticated: no INSERT policy exists → the self-mint is
    // rejected (RLS 42501, or a missing table grant — either way, locked out).
    // A distinct badge value ensures a PK conflict never masks the RLS denial.
    let mut tx = pool.begin().await.expect("begin write tx");
    sqlx::query("SET LOCAL ROLE authenticated")
        .execute(&mut *tx)
        .await
        .expect("set role authenticated");
    sqlx::query("SELECT set_config('request.jwt.claims', $1, true)")
        .bind(format!(r#"{{"sub": "{user}", "role": "authenticated"}}"#))
        .execute(&mut *tx)
        .await
        .expect("set jwt claims");
    let self_mint = sqlx::query("INSERT INTO user_badges (user_id, badge) VALUES ($1, 'staff')")
        .bind(user)
        .execute(&mut *tx)
        .await;
    drop(tx); // rollback the poisoned tx
    assert!(
        self_mint.is_err(),
        "an authenticated client must NOT be able to INSERT into user_badges (self-mint)"
    );

    cleanup(&pool, &[user]).await;
}
