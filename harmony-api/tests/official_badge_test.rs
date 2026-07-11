#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Official (verified) badge persistence + RLS regression tests (real DB).
//!
//! Pins the guarantees the official-badge grant path leans on but that no unit
//! test can reach (they live below the `PgProfileRepository` / SQL boundary):
//!
//! 1. GRANT → LIST ROUNDTRIP — after a service-role grant, the badge appears in
//!    the official-set read (`list_badge_holders`), which drives the per-message
//!    render. REVOKE removes it. Grant is idempotent (`ON CONFLICT DO NOTHING`).
//! 2. USERNAME RESOLUTION — `get_by_username` resolves a handle to the profile,
//!    the path the owner-only grant action uses when a subject is named rather
//!    than passed by UUID.
//! 3. RLS WRITE-LOCKDOWN — `user_badges` is SELECT-open to `authenticated` and
//!    has NO write policy, so a client can never self-mint `official`. Writes
//!    are service_role-only (the API bypasses RLS).
//!
//! WHY `#[ignore]`: requires a running Postgres with the Harmony schema
//! (mirrors `founding_badge_test.rs`). Run locally with:
//!   `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:64322/postgres \
//!      cargo test --test official_badge_test -- --ignored`

use sqlx::PgPool;
use uuid::Uuid;

use harmony_api::domain::models::UserId;
use harmony_api::domain::ports::ProfileRepository;
use harmony_api::infra::postgres::PgProfileRepository;

const OFFICIAL: &str = "official";

// ── DB pool (mirrors founding_badge_test) ────────────────────────────────

async fn test_pool() -> PgPool {
    dotenvy::dotenv().ok();
    let url =
        std::env::var("DATABASE_URL").expect("DATABASE_URL must be set for integration tests");
    PgPool::connect(&url)
        .await
        .expect("Failed to connect to test database")
}

/// Seed one user (`auth.users` + `profiles`) and return its id + username.
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
    .bind(format!("off-{uid}@example.com"))
    .execute(pool)
    .await
    .expect("seed auth.users");

    // Username must match profiles_username_format: ^[a-z0-9_]{3,32}$.
    // WHY ON CONFLICT: the `handle_new_user` trigger may have already created
    // the profile from the auth.users insert above.
    let username = format!("of{}", &uid.simple().to_string()[..10]);
    sqlx::query(
        r#"
        INSERT INTO profiles (id, username, display_name)
        VALUES ($1, $2, 'Official Tester')
        ON CONFLICT (id) DO NOTHING
        "#,
    )
    .bind(uid)
    .bind(&username)
    .execute(pool)
    .await
    .expect("seed profiles");

    // Read back the username actually stored: when the signup trigger wins the
    // INSERT, the stored handle is trigger-derived, not the one bound above.
    let stored: String = sqlx::query_scalar("SELECT username FROM profiles WHERE id = $1")
        .bind(uid)
        .fetch_one(pool)
        .await
        .expect("read back seeded username");

    (uid, stored)
}

async fn cleanup(pool: &PgPool, users: &[Uuid]) {
    // auth.users delete cascades to profiles, which cascades to user_badges.
    let _ = sqlx::query("DELETE FROM auth.users WHERE id = ANY($1)")
        .bind(users.to_vec())
        .execute(pool)
        .await;
}

// ── Tests ────────────────────────────────────────────────────────────────

/// After a service-role grant the user shows up in the official set; a second
/// grant is idempotent; revoke removes it again.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn official_grant_list_revoke_roundtrip() {
    let pool = test_pool().await;
    let repo = PgProfileRepository::new(pool.clone());

    let (user, _username) = seed_user(&pool).await;
    let uid = UserId::new(user);

    let holds = |ids: &[UserId]| ids.contains(&uid);

    assert!(
        !holds(&repo.list_badge_holders(OFFICIAL).await.unwrap()),
        "fresh user must not hold the official badge"
    );

    repo.grant_badge(&uid, OFFICIAL).await.expect("first grant");
    repo.grant_badge(&uid, OFFICIAL)
        .await
        .expect("second grant must not error (ON CONFLICT DO NOTHING)");
    assert!(
        holds(&repo.list_badge_holders(OFFICIAL).await.unwrap()),
        "granted user must appear in the official set exactly once"
    );

    repo.revoke_badge(&uid, OFFICIAL).await.expect("revoke");
    assert!(
        !holds(&repo.list_badge_holders(OFFICIAL).await.unwrap()),
        "revoked user must drop out of the official set"
    );

    cleanup(&pool, &[user]).await;
}

/// `get_by_username` resolves the handle the owner grant action accepts.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn get_by_username_resolves_the_subject() {
    let pool = test_pool().await;
    let repo = PgProfileRepository::new(pool.clone());

    let (user, username) = seed_user(&pool).await;

    let resolved = repo
        .get_by_username(&username)
        .await
        .expect("query")
        .expect("profile must exist for the seeded username");
    assert_eq!(resolved.id, UserId::new(user));

    assert!(
        repo.get_by_username("nobody_has_this_handle")
            .await
            .expect("query")
            .is_none(),
        "an unknown handle resolves to None"
    );

    cleanup(&pool, &[user]).await;
}

/// A client (the `authenticated` role, RLS-enforced) can READ the official set
/// but can never INSERT `official` to self-verify. Writes are service_role-only.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn official_rls_blocks_self_mint_but_allows_read() {
    let pool = test_pool().await;
    let repo = PgProfileRepository::new(pool.clone());

    let (user, _username) = seed_user(&pool).await;
    let uid = UserId::new(user);

    // service_role (the API) grants the badge — the ONLY sanctioned path.
    repo.grant_badge(&uid, OFFICIAL)
        .await
        .expect("service grant");

    // (1) READ as authenticated: the open SELECT policy admits the row.
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
    .bind(OFFICIAL)
    .fetch_one(&mut *tx)
    .await
    .expect("select as authenticated");
    drop(tx);
    assert_eq!(
        visible, 1,
        "an authenticated client must be able to READ the official badge"
    );

    // (2) WRITE as authenticated: no INSERT policy exists → self-mint rejected.
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
    // A fresh user with no `official` row yet, so a PK conflict cannot mask the
    // RLS denial.
    let (other, _) = seed_user(&pool).await;
    let self_mint = sqlx::query("INSERT INTO user_badges (user_id, badge) VALUES ($1, 'official')")
        .bind(other)
        .execute(&mut *tx)
        .await;
    drop(tx);
    assert!(
        self_mint.is_err(),
        "an authenticated client must NOT be able to self-mint the official badge"
    );

    cleanup(&pool, &[user, other]).await;
}
