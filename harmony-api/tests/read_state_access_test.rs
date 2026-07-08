#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Read-state private-channel access regression test (real DB).
//!
//! WHY: `PgReadStateRepository::list_all_for_user` joins `server_members` and
//! `channels` with NO `is_private` gate, so it returned unread counts for private
//! channels a member cannot access. Channel access = membership + (for private
//! channels) admin/owner or a `channel_role_access` grant. That mismatch leaked a
//! phantom unread badge for a channel `mark_read` 403s on (`ensure_channel_access`),
//! i.e. a permanently unclearable badge.
//!
//! The fix adds the same access predicate `channel_repository.rs::list_for_server`
//! already uses inline. This test proves it:
//!   - a plain member with an unread message in a private channel they lack access
//!     to → the channel is ABSENT from `list_all_for_user` (no phantom unread);
//!   - an admin (role bypass) → the channel is PRESENT;
//!   - after granting the member's role via `channel_role_access` → PRESENT;
//!   - a public channel is unaffected (always present with an unread).
//!
//! WHY `#[ignore]`: requires a running Postgres with the Harmony schema (mirrors
//! the DM, ban and voice integration tests). Run locally with:
//!   `DATABASE_URL=... cargo test --test read_state_access_test -- --ignored`

use std::collections::HashSet;

use sqlx::PgPool;
use uuid::Uuid;

use harmony_api::domain::models::UserId;
use harmony_api::domain::ports::ReadStateRepository;
use harmony_api::infra::postgres::PgReadStateRepository;

// ── DB pool (mirrors ban/dm integration tests) ──────────────────────────

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
/// Random UUID so parallel/repeat runs never collide.
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
    .bind(format!("rsa-{uid}@example.com"))
    .execute(pool)
    .await
    .expect("seed auth.users");

    // Username must match profiles_username_format: ^[a-z0-9_]{3,32}$
    let username = format!("rs{}", &uid.simple().to_string()[..10]);
    sqlx::query(
        r#"
        INSERT INTO profiles (id, username, display_name)
        VALUES ($1, $2, 'Read State Access')
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
    sqlx::query("INSERT INTO servers (id, name, owner_id) VALUES ($1, 'Read State Server', $2)")
        .bind(sid)
        .bind(owner)
        .execute(pool)
        .await
        .expect("seed server");
    sid
}

/// Seed a channel. `name` must match `^[a-z0-9-]{1,100}$`.
async fn seed_channel(pool: &PgPool, server: Uuid, name: &str, is_private: bool) -> Uuid {
    let cid = Uuid::new_v4();
    sqlx::query("INSERT INTO channels (id, server_id, name, is_private) VALUES ($1, $2, $3, $4)")
        .bind(cid)
        .bind(server)
        .bind(name)
        .bind(is_private)
        .execute(pool)
        .await
        .expect("seed channel");
    cid
}

/// Add `user` to `server` with `role` ('member' | 'admin' | ...).
async fn add_member(pool: &PgPool, server: Uuid, user: Uuid, role: &str) {
    sqlx::query("INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, $3)")
        .bind(server)
        .bind(user)
        .bind(role)
        .execute(pool)
        .await
        .expect("seed server_member");
}

/// Post an (unread, non-system, non-deleted) message authored by `author`.
async fn post_message(pool: &PgPool, channel: Uuid, author: Uuid) {
    sqlx::query("INSERT INTO messages (channel_id, author_id, content) VALUES ($1, $2, 'hi')")
        .bind(channel)
        .bind(author)
        .execute(pool)
        .await
        .expect("seed message");
}

/// Grant a role access to a private channel.
async fn grant_channel_role(pool: &PgPool, channel: Uuid, role: &str) {
    sqlx::query("INSERT INTO channel_role_access (channel_id, role) VALUES ($1, $2)")
        .bind(channel)
        .bind(role)
        .execute(pool)
        .await
        .expect("grant channel_role_access");
}

/// Channel ids returned by `list_all_for_user`, as a set for membership asserts.
async fn unread_channel_ids(pool: &PgPool, user: Uuid) -> HashSet<Uuid> {
    let repo = PgReadStateRepository::new(pool.clone());
    repo.list_all_for_user(&UserId::new(user))
        .await
        .expect("list_all_for_user")
        .into_iter()
        .map(|s| s.channel_id.0)
        .collect()
}

async fn cleanup(pool: &PgPool, server: Uuid, users: &[Uuid]) {
    // Deleting the server cascades to channels → messages / channel_role_access
    // and server_members. servers.owner_id is ON DELETE RESTRICT, so the server
    // must be dropped before the users.
    let _ = sqlx::query("DELETE FROM servers WHERE id = $1")
        .bind(server)
        .execute(pool)
        .await;
    // Deleting auth.users cascades to profiles (profiles_id_fkey ON DELETE CASCADE).
    let _ = sqlx::query("DELETE FROM auth.users WHERE id = ANY($1)")
        .bind(users.to_vec())
        .execute(pool)
        .await;
}

// ── Test ────────────────────────────────────────────────────────────────

/// The read-state snapshot must honor private-channel access: a member without
/// access never sees the private channel's unread; admins and role-granted
/// members do; public channels are unaffected.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn read_state_respects_private_channel_access() {
    let pool = test_pool().await;

    let author = seed_user(&pool).await; // server owner + message author
    let member = seed_user(&pool).await; // plain member, no private access
    let admin = seed_user(&pool).await; // admin, role bypass

    let server = seed_server(&pool, author).await;
    let private_channel = seed_channel(&pool, server, "priv-chan", true).await;
    let public_channel = seed_channel(&pool, server, "pub-chan", false).await;

    add_member(&pool, server, member, "member").await;
    add_member(&pool, server, admin, "admin").await;

    // One unread message in each channel, authored by someone other than the
    // readers (so author_id != $1 holds for both member and admin).
    post_message(&pool, private_channel, author).await;
    post_message(&pool, public_channel, author).await;

    // (1) Plain member WITHOUT access: public visible, private hidden (the fix).
    let member_ids = unread_channel_ids(&pool, member).await;
    assert!(
        member_ids.contains(&public_channel),
        "member must see the public channel's unread (unchanged behavior)"
    );
    assert!(
        !member_ids.contains(&private_channel),
        "member without channel_role_access must NOT see a private channel's unread \
         (phantom-unread leak — the bug this fixes)"
    );

    // (2) Admin: role bypass → private channel visible.
    let admin_ids = unread_channel_ids(&pool, admin).await;
    assert!(
        admin_ids.contains(&private_channel),
        "admin must see the private channel's unread (role bypass)"
    );
    assert!(
        admin_ids.contains(&public_channel),
        "admin must see the public channel's unread"
    );

    // (3) After granting the member's role access, the private channel appears.
    grant_channel_role(&pool, private_channel, "member").await;
    let member_ids_after = unread_channel_ids(&pool, member).await;
    assert!(
        member_ids_after.contains(&private_channel),
        "member WITH a channel_role_access grant for their role must see the \
         private channel's unread"
    );
    assert!(
        member_ids_after.contains(&public_channel),
        "public channel unread must remain visible after the grant"
    );

    cleanup(&pool, server, &[author, member, admin]).await;
}
