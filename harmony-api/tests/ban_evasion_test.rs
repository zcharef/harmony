#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Ban-evasion race regression test (real DB).
//!
//! WHY: `join_via_invite` checks `is_banned` OUTSIDE any transaction, then calls
//! `complete_join` which inserts the membership. A ban committing in that window
//! would leave a banned user as a member — `ban_user`'s membership DELETE can't
//! see the join's uncommitted INSERT, and the join can't see the uncommitted ban.
//! `complete_join` and `ban_user` now take the same per-(server, user) advisory
//! lock, and `complete_join` re-checks the ban inside it, so the two serialize and
//! a ban that committed first is caught.
//!
//! WHY `#[ignore]`: requires a running Postgres with the Harmony schema (mirrors
//! the DM and voice integration tests). Run locally with:
//!   `DATABASE_URL=... cargo test --test ban_evasion_test -- --ignored`

use sqlx::PgPool;
use uuid::Uuid;

use harmony_api::domain::errors::DomainError;
use harmony_api::domain::models::{InviteCode, ServerId, UserId};
use harmony_api::domain::ports::{BanRepository, InviteRepository, MemberRepository};
use harmony_api::infra::postgres::{PgBanRepository, PgInviteRepository, PgMemberRepository};

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
    .bind(format!("ban-race-{uid}@example.com"))
    .execute(pool)
    .await
    .expect("seed auth.users");

    // Username must match profiles_username_format: ^[a-z0-9_]{3,32}$
    let username = format!("br{}", &uid.simple().to_string()[..10]);
    sqlx::query(
        r#"
        INSERT INTO profiles (id, username, display_name)
        VALUES ($1, $2, 'Ban Racer')
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
        .bind("Ban Test Server")
        .bind(owner)
        .execute(pool)
        .await
        .expect("seed server");
    sid
}

/// Seed an unlimited-use invite for `server`. Code matches `^[a-zA-Z0-9]{6,12}$`.
async fn seed_invite(pool: &PgPool, server: Uuid, creator: Uuid) -> String {
    let raw = Uuid::new_v4().simple().to_string();
    let code = raw[..8].to_string();
    sqlx::query("INSERT INTO invites (code, server_id, creator_id) VALUES ($1, $2, $3)")
        .bind(&code)
        .bind(server)
        .bind(creator)
        .execute(pool)
        .await
        .expect("seed invite");
    code
}

async fn insert_ban(pool: &PgPool, server: Uuid, user: Uuid) {
    sqlx::query("INSERT INTO server_bans (server_id, user_id) VALUES ($1, $2)")
        .bind(server)
        .bind(user)
        .execute(pool)
        .await
        .expect("seed ban");
}

async fn is_member(pool: &PgPool, server: Uuid, user: Uuid) -> bool {
    sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2)",
    )
    .bind(server)
    .bind(user)
    .fetch_one(pool)
    .await
    .expect("is_member")
}

async fn is_banned(pool: &PgPool, server: Uuid, user: Uuid) -> bool {
    sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM server_bans WHERE server_id = $1 AND user_id = $2)",
    )
    .bind(server)
    .bind(user)
    .fetch_one(pool)
    .await
    .expect("is_banned")
}

async fn cleanup(pool: &PgPool, server: Uuid, owner: Uuid, joiner: Uuid) {
    // Children first (best-effort), then the server, then the users.
    // servers.owner_id is ON DELETE RESTRICT, so users must go after the server.
    for stmt in [
        "DELETE FROM server_bans WHERE server_id = $1",
        "DELETE FROM server_members WHERE server_id = $1",
        "DELETE FROM invites WHERE server_id = $1",
        "DELETE FROM channels WHERE server_id = $1",
        "DELETE FROM servers WHERE id = $1",
    ] {
        let _ = sqlx::query(stmt).bind(server).execute(pool).await;
    }
    let _ = sqlx::query("DELETE FROM auth.users WHERE id = ANY($1)")
        .bind(vec![owner, joiner])
        .execute(pool)
        .await;
}

// ── Tests ───────────────────────────────────────────────────────────────

/// A user with an existing ban cannot complete a join — the in-lock re-check in
/// `complete_join` rejects with `Forbidden` before any membership is inserted.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn banned_user_cannot_complete_join() {
    let pool = test_pool().await;
    let owner = seed_user(&pool).await;
    let joiner = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    let code = seed_invite(&pool, server, owner).await;
    insert_ban(&pool, server, joiner).await;

    let invite_repo = PgInviteRepository::new(pool.clone());
    let result = invite_repo
        .complete_join(
            &InviteCode(code),
            &ServerId::new(server),
            &UserId::new(joiner),
        )
        .await;

    assert!(
        matches!(result, Err(DomainError::Forbidden(_))),
        "banned user's complete_join must return Forbidden, got {result:?}"
    );
    assert!(
        !is_member(&pool, server, joiner).await,
        "a banned user must never become a member"
    );

    cleanup(&pool, server, owner, joiner).await;
}

/// A concurrent ban and invite-join for the same pair must never leave the user
/// both banned AND a member, regardless of which transaction commits first.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn concurrent_ban_and_join_never_leaves_banned_member() {
    let pool = test_pool().await;
    let owner = seed_user(&pool).await;
    let joiner = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    let code = seed_invite(&pool, server, owner).await;

    // Fire the ban and the join concurrently on independent connections.
    let (pool_j, code_j) = (pool.clone(), code.clone());
    let join_handle = tokio::spawn(async move {
        PgInviteRepository::new(pool_j)
            .complete_join(
                &InviteCode(code_j),
                &ServerId::new(server),
                &UserId::new(joiner),
            )
            .await
    });
    let pool_b = pool.clone();
    let ban_handle = tokio::spawn(async move {
        PgBanRepository::new(pool_b)
            .ban_user(
                &ServerId::new(server),
                &UserId::new(joiner),
                &UserId::new(owner),
                None,
            )
            .await
    });

    // Either outcome is valid (join may succeed or be Forbidden); only the final
    // state matters. Join tasks must not panic.
    let _ = join_handle.await.expect("join task join");
    let _ = ban_handle.await.expect("ban task join");

    let banned = is_banned(&pool, server, joiner).await;
    let member = is_member(&pool, server, joiner).await;
    assert!(
        !(banned && member),
        "a banned user must never remain a member (banned={banned}, member={member})"
    );

    cleanup(&pool, server, owner, joiner).await;
}

/// `add_member` (the auto-join path) must reject a banned user — otherwise a
/// banned user is re-added to the official server on their next profile sync.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn add_member_rejects_banned_user() {
    let pool = test_pool().await;
    let owner = seed_user(&pool).await;
    let joiner = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    insert_ban(&pool, server, joiner).await;

    let member_repo = PgMemberRepository::new(pool.clone());
    let result = member_repo
        .add_member(&ServerId::new(server), &UserId::new(joiner))
        .await;

    assert!(
        matches!(result, Err(DomainError::Forbidden(_))),
        "add_member must reject a banned user, got {result:?}"
    );
    assert!(
        !is_member(&pool, server, joiner).await,
        "a banned user must never be (re-)added as a member"
    );

    cleanup(&pool, server, owner, joiner).await;
}
