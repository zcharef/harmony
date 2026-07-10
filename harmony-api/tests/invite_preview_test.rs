#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Public invite preview validity gate (real DB).
//!
//! WHY: `preview_public_invite` feeds the UNAUTHENTICATED invite landing page
//! (`GET /v1/invites/{code}`). The ticket contract is: only valid, non-expired,
//! non-exhausted codes return server context; everything else is a plain 404 —
//! a dead code must not keep leaking server name/member count, and "expired"
//! must not be distinguishable from "never existed".
//!
//! WHY `#[ignore]`: requires a running Postgres with the Harmony schema
//! (mirrors the ban-evasion and DM integration tests). Run locally with:
//!   `DATABASE_URL=... cargo test --test invite_preview_test -- --ignored`

use std::sync::Arc;

use sqlx::PgPool;
use uuid::Uuid;

use harmony_api::domain::errors::DomainError;
use harmony_api::domain::models::InviteCode;
use harmony_api::domain::services::InviteService;
use harmony_api::infra::AlwaysAllowedChecker;
use harmony_api::infra::postgres::{
    PgBanRepository, PgInviteRepository, PgMemberRepository, PgServerRepository,
};

// ── DB pool ─────────────────────────────────────────────────────────────

async fn test_pool() -> PgPool {
    dotenvy::dotenv().ok();
    let url =
        std::env::var("DATABASE_URL").expect("DATABASE_URL must be set for integration tests");
    PgPool::connect(&url)
        .await
        .expect("Failed to connect to test database")
}

fn invite_service(pool: &PgPool) -> InviteService {
    InviteService::new(
        Arc::new(PgInviteRepository::new(pool.clone())),
        Arc::new(PgMemberRepository::new(pool.clone())),
        Arc::new(PgBanRepository::new(pool.clone())),
        Arc::new(PgServerRepository::new(pool.clone())),
        Arc::new(AlwaysAllowedChecker),
    )
}

// ── Seeding ─────────────────────────────────────────────────────────────

/// Seed one user (`auth.users` + `profiles`) and return its id.
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
    .bind(format!("inv-preview-{uid}@example.com"))
    .execute(pool)
    .await
    .expect("seed auth.users");

    // Username must match profiles_username_format: ^[a-z0-9_]{3,32}$
    let username = format!("ip{}", &uid.simple().to_string()[..10]);
    sqlx::query(
        r#"
        INSERT INTO profiles (id, username, display_name)
        VALUES ($1, $2, 'Invite Previewer')
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

/// Seed a (non-DM) server owned by `owner`.
async fn seed_server(pool: &PgPool, owner: Uuid) -> Uuid {
    let sid = Uuid::new_v4();
    sqlx::query("INSERT INTO servers (id, name, owner_id) VALUES ($1, $2, $3)")
        .bind(sid)
        .bind("Invite Preview Server")
        .bind(owner)
        .execute(pool)
        .await
        .expect("seed server");
    sid
}

/// Seed an invite with explicit validity knobs. Code matches `^[a-zA-Z0-9]{6,12}$`.
async fn seed_invite(
    pool: &PgPool,
    server: Uuid,
    creator: Uuid,
    max_uses: Option<i32>,
    use_count: i32,
    expires_in_secs: Option<i64>,
) -> String {
    let raw = Uuid::new_v4().simple().to_string();
    let code = raw[..8].to_string();
    sqlx::query(
        r#"
        INSERT INTO invites (code, server_id, creator_id, max_uses, use_count, expires_at)
        VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6))
        "#,
    )
    .bind(&code)
    .bind(server)
    .bind(creator)
    .bind(max_uses)
    .bind(use_count)
    .bind(expires_in_secs.map(|s| s as f64))
    .execute(pool)
    .await
    .expect("seed invite");
    code
}

async fn cleanup(pool: &PgPool, server: Uuid, owner: Uuid) {
    for stmt in [
        "DELETE FROM server_members WHERE server_id = $1",
        "DELETE FROM invites WHERE server_id = $1",
        "DELETE FROM channels WHERE server_id = $1",
        "DELETE FROM servers WHERE id = $1",
    ] {
        let _ = sqlx::query(stmt).bind(server).execute(pool).await;
    }
    let _ = sqlx::query("DELETE FROM auth.users WHERE id = $1")
        .bind(owner)
        .execute(pool)
        .await;
}

fn assert_not_found(result: &Result<harmony_api::domain::models::Invite, DomainError>, ctx: &str) {
    assert!(
        matches!(result, Err(DomainError::NotFound { .. })),
        "{ctx}: expected NotFound, got {result:?}"
    );
}

// ── Tests ───────────────────────────────────────────────────────────────

/// A live invite returns full context for the landing page.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn valid_invite_previews_ok() {
    let pool = test_pool().await;
    let owner = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    let code = seed_invite(&pool, server, owner, None, 0, Some(3600)).await;

    let service = invite_service(&pool);
    let invite = service
        .preview_public_invite(&InviteCode(code))
        .await
        .expect("valid invite must preview");

    assert_eq!(invite.server_id.to_string(), server.to_string());

    cleanup(&pool, server, owner).await;
}

/// An expired invite is a plain `NotFound` — indistinguishable from nonexistent.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn expired_invite_previews_not_found() {
    let pool = test_pool().await;
    let owner = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    let code = seed_invite(&pool, server, owner, None, 0, Some(-60)).await;

    let service = invite_service(&pool);
    let result = service.preview_public_invite(&InviteCode(code)).await;
    assert_not_found(&result, "expired invite");

    cleanup(&pool, server, owner).await;
}

/// An exhausted invite (`use_count` == `max_uses`) is a plain `NotFound`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn exhausted_invite_previews_not_found() {
    let pool = test_pool().await;
    let owner = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    let code = seed_invite(&pool, server, owner, Some(3), 3, Some(3600)).await;

    let service = invite_service(&pool);
    let result = service.preview_public_invite(&InviteCode(code)).await;
    assert_not_found(&result, "exhausted invite");

    cleanup(&pool, server, owner).await;
}

/// A code that never existed is `NotFound` (same error shape as expired).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn nonexistent_invite_previews_not_found() {
    let pool = test_pool().await;

    let service = invite_service(&pool);
    let result = service
        .preview_public_invite(&InviteCode("zzzznope".to_string()))
        .await;
    assert_not_found(&result, "nonexistent invite");
}
