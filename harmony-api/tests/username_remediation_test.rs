#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Username remediation persistence regression test (real DB).
//!
//! WHY: F7 — a username chosen via direct `POST /auth/v1/signup` bypasses the
//! Rust content filter (the signup trigger cannot run it). The hot-path fix in
//! `sync_profile` regenerates such usernames through the new
//! `ProfileRepository::update_username` port method. The decision logic is
//! fully unit-covered in `profile_service.rs` (with a synthetic banned word);
//! this test covers ONLY the persistence write: the compile-time `SQLx`
//! `UPDATE ... RETURNING` and the `profiles_username_format` CHECK constraint
//! against a real schema.
//!
//! WHY `#[ignore]`: requires a running Postgres with the Harmony schema
//! (mirrors the ban-evasion and DM integration tests). Run locally with:
//!   `DATABASE_URL=... cargo test --test username_remediation_test -- --ignored`

use sqlx::PgPool;
use uuid::Uuid;

use harmony_api::domain::errors::DomainError;
use harmony_api::domain::models::UserId;
use harmony_api::domain::ports::ProfileRepository;
use harmony_api::infra::postgres::PgProfileRepository;

// ── DB pool ─────────────────────────────────────────────────────────────

async fn test_pool() -> PgPool {
    dotenvy::dotenv().ok();
    let url =
        std::env::var("DATABASE_URL").expect("DATABASE_URL must be set for integration tests");
    PgPool::connect(&url)
        .await
        .expect("Failed to connect to test database")
}

// ── Seeding ─────────────────────────────────────────────────────────────

/// Seed one user (`auth.users` + `profiles`) with a benign username and return its id.
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
    .bind(format!("username-remediation-{uid}@example.com"))
    .execute(pool)
    .await
    .expect("seed auth.users");

    // Username must match profiles_username_format: ^[a-z0-9_]{3,32}$
    let username = format!("ur{}", &uid.simple().to_string()[..10]);
    sqlx::query(
        r#"
        INSERT INTO profiles (id, username)
        VALUES ($1, $2)
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

// ── Tests ───────────────────────────────────────────────────────────────

#[tokio::test]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn update_username_persists_and_returns_new_row() {
    let pool = test_pool().await;
    let repo = PgProfileRepository::new(pool.clone());

    let uid = UserId::new(seed_user(&pool).await);
    // Same shape the service generates: `user_<12 hex of the user id>` —
    // must satisfy the profiles_username_format CHECK.
    let safe_username = format!("user_{}", &uid.0.as_simple().to_string()[..12]);

    let returned = repo
        .update_username(&uid, &safe_username)
        .await
        .expect("update_username should succeed against the real schema");
    assert_eq!(
        returned.username, safe_username,
        "RETURNING row must carry the new username"
    );
    assert_eq!(returned.id, uid, "must update the targeted user only");

    let reloaded = repo
        .get_by_id(&uid)
        .await
        .expect("get_by_id should succeed")
        .expect("profile must still exist after remediation");
    assert_eq!(
        reloaded.username, safe_username,
        "the new username must be persisted, not just returned"
    );
}

#[tokio::test]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn update_username_missing_profile_is_not_found() {
    let pool = test_pool().await;
    let repo = PgProfileRepository::new(pool);

    let ghost = UserId::new(Uuid::new_v4());
    let err = repo
        .update_username(&ghost, "user_abc123def456")
        .await
        .expect_err("updating a nonexistent profile must fail");
    assert!(
        matches!(
            err,
            DomainError::NotFound {
                resource_type: "Profile",
                ..
            }
        ),
        "got {err:?}"
    );
}
