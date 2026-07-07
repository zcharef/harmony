#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! DM creation concurrency regression test (real DB).
//!
//! WHY: `PgDmRepository::create_dm` re-checks for an existing DM inside a
//! transaction using `FOR SHARE`, but `FOR SHARE` locks nothing when no DM
//! exists yet — there are zero `server_members` rows to lock. Two concurrent
//! `create_dm(a, b)` calls for the same pair could therefore both observe
//! "no DM" and both INSERT, producing duplicate split-brain DM servers.
//! `create_dm` now acquires a transaction-scoped advisory lock on the canonical
//! (ordered) user pair before the re-check, serializing creation per pair.
//!
//! This test proves the fix: ~8 concurrent `create_dm(a, b)` calls must all
//! return the SAME `(server_id, channel_id)` and leave exactly ONE `is_dm`
//! server for the pair. Without the advisory lock this test finds duplicates.
//!
//! WHY `#[ignore]`: requires a running Postgres with the Harmony schema (mirrors
//! the voice integration tests). Run locally with:
//!   `DATABASE_URL=... cargo test --test dm_concurrency_test -- --ignored`

use sqlx::PgPool;
use uuid::Uuid;

use harmony_api::domain::models::UserId;
use harmony_api::domain::ports::DmRepository;
use harmony_api::infra::postgres::PgDmRepository;

// ── DB pool (mirrors voice integration tests) ───────────────────────────

async fn test_pool() -> PgPool {
    dotenvy::dotenv().ok();
    let url =
        std::env::var("DATABASE_URL").expect("DATABASE_URL must be set for integration tests");
    PgPool::connect(&url)
        .await
        .expect("Failed to connect to test database")
}

// ── Seeding ─────────────────────────────────────────────────────────────

/// Seed one user (`auth.users` + `profiles`) and return its id.
/// Uses a random UUID so parallel/repeat runs never collide.
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
    .bind(format!("dm-race-{uid}@example.com"))
    .execute(pool)
    .await
    .expect("seed auth.users");

    // Username must match profiles_username_format: ^[a-z0-9_]{3,32}$
    let username = format!("dr{}", &uid.simple().to_string()[..10]);
    sqlx::query(
        r#"
        INSERT INTO profiles (id, username, display_name)
        VALUES ($1, $2, 'DM Racer')
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

/// Count `is_dm` servers where BOTH users are members.
async fn count_dm_servers(pool: &PgPool, uid_a: Uuid, uid_b: Uuid) -> i64 {
    sqlx::query_scalar(
        r#"
        SELECT COUNT(*)::bigint
        FROM servers s
        WHERE s.is_dm = true
          AND EXISTS (SELECT 1 FROM server_members WHERE server_id = s.id AND user_id = $1)
          AND EXISTS (SELECT 1 FROM server_members WHERE server_id = s.id AND user_id = $2)
        "#,
    )
    .bind(uid_a)
    .bind(uid_b)
    .fetch_one(pool)
    .await
    .expect("count dm servers")
}

/// Best-effort cleanup. `servers.owner_id` is `ON DELETE RESTRICT`, so DM
/// servers must be dropped (cascading channels + members) before the users.
async fn cleanup(pool: &PgPool, uid_a: Uuid, uid_b: Uuid) {
    let _ = sqlx::query(
        r#"
        DELETE FROM servers s
        WHERE s.is_dm = true
          AND EXISTS (SELECT 1 FROM server_members WHERE server_id = s.id AND user_id = $1)
          AND EXISTS (SELECT 1 FROM server_members WHERE server_id = s.id AND user_id = $2)
        "#,
    )
    .bind(uid_a)
    .bind(uid_b)
    .execute(pool)
    .await;

    // Deleting auth.users cascades to profiles (profiles_id_fkey ON DELETE CASCADE).
    let _ = sqlx::query("DELETE FROM auth.users WHERE id = ANY($1)")
        .bind(vec![uid_a, uid_b])
        .execute(pool)
        .await;
}

// ── Test ────────────────────────────────────────────────────────────────

/// Concurrent `create_dm(a, b)` for one pair must converge on a single DM.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn concurrent_create_dm_yields_exactly_one_dm() {
    let pool = test_pool().await;

    let uid_a = seed_user(&pool).await;
    let uid_b = seed_user(&pool).await;

    let repo = PgDmRepository::new(pool.clone());

    // Fire 8 concurrent create_dm(a, b) for the SAME pair.
    let mut handles = Vec::with_capacity(8);
    for _ in 0..8 {
        let repo = repo.clone();
        let a = UserId::new(uid_a);
        let b = UserId::new(uid_b);
        handles.push(tokio::spawn(async move { repo.create_dm(&a, &b).await }));
    }

    let mut results = Vec::with_capacity(8);
    for handle in handles {
        let ids = handle
            .await
            .expect("task join")
            .expect("create_dm should succeed");
        results.push(ids);
    }

    // (1) Every call returned the SAME (server_id, channel_id).
    let first = results.first().expect("at least one result").clone();
    for (idx, ids) in results.iter().enumerate() {
        assert_eq!(
            ids, &first,
            "call {idx} returned {ids:?}, expected {first:?} — concurrent create_dm diverged (split-brain DM)"
        );
    }

    // (2) Exactly ONE is_dm server exists for the pair.
    let dm_count = count_dm_servers(&pool, uid_a, uid_b).await;
    assert_eq!(
        dm_count, 1,
        "expected exactly 1 DM server for the pair, found {dm_count} (advisory lock failed to serialize creation)"
    );

    cleanup(&pool, uid_a, uid_b).await;
}
