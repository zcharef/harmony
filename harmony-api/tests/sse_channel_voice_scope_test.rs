#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! F5 regression: channel/voice SSE events must be gated on channel access.
//!
//! WHY: `ChannelCreated/Updated/Deleted` and `VoiceStateUpdate` were fanned out
//! by server membership alone, so a member with no grant to a private channel
//! still received its name/topic and voice roster over `/v1/events`. The fix
//! attaches the F3 `channel_access` routing metadata to those four variants at
//! every publish site; the existing SSE Stage-2 gate + redaction then apply.
//!
//! Split of proof (mirrors F3):
//! - The Stage-2 drop/deliver decision per receiver role is unit-tested in
//!   `api/handlers/events.rs` (`private_channel_and_voice_events_dropped_for_
//!   ungranted_member` + the public-channel reactivity control).
//! - Accessor + redaction (wire payload byte-identical) are unit-tested in
//!   `domain/models/server_event.rs`.
//! - THIS file proves the resolver the publish sites rely on against a real
//!   Postgres `channel_role_access` table: public → `None`, private → the
//!   granted role set, missing channel → `None` (why `delete_channel` must
//!   resolve BEFORE deleting).
//!
//! WHY `#[ignore]`: requires a running Postgres with the Harmony schema (mirrors
//! the read-state, mentions, DM, ban and voice integration tests). Run with:
//!   `DATABASE_URL=... cargo test --test sse_channel_voice_scope_test -- --ignored`

use sqlx::PgPool;
use uuid::Uuid;

use harmony_api::domain::models::{ChannelId, Role};
use harmony_api::domain::services::resolve_channel_access_by_id;
use harmony_api::infra::postgres::PgChannelRepository;

// ── DB pool (mirrors read_state_access_test) ─────────────────────────────

async fn test_pool() -> PgPool {
    dotenvy::dotenv().ok();
    let url =
        std::env::var("DATABASE_URL").expect("DATABASE_URL must be set for integration tests");
    PgPool::connect(&url)
        .await
        .expect("Failed to connect to test database")
}

// ── Seeding (mirrors read_state_access_test) ─────────────────────────────

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
    .bind(format!("f5-{uid}@example.com"))
    .execute(pool)
    .await
    .expect("seed auth.users");

    let username = format!("f5{}", &uid.simple().to_string()[..10]);
    sqlx::query(
        r#"
        INSERT INTO profiles (id, username, display_name)
        VALUES ($1, $2, 'F5 Scope')
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

async fn seed_server(pool: &PgPool, owner: Uuid) -> Uuid {
    let sid = Uuid::new_v4();
    sqlx::query("INSERT INTO servers (id, name, owner_id) VALUES ($1, 'F5 Scope Server', $2)")
        .bind(sid)
        .bind(owner)
        .execute(pool)
        .await
        .expect("seed server");
    sid
}

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

async fn grant_channel_role(pool: &PgPool, channel: Uuid, role: &str) {
    sqlx::query("INSERT INTO channel_role_access (channel_id, role) VALUES ($1, $2)")
        .bind(channel)
        .bind(role)
        .execute(pool)
        .await
        .expect("grant channel_role_access");
}

async fn cleanup(pool: &PgPool, server: Uuid, users: &[Uuid]) {
    // Server delete cascades to channels → channel_role_access. Owner FK is
    // ON DELETE RESTRICT, so drop the server before the users.
    let _ = sqlx::query("DELETE FROM servers WHERE id = $1")
        .bind(server)
        .execute(pool)
        .await;
    let _ = sqlx::query("DELETE FROM auth.users WHERE id = ANY($1)")
        .bind(users.to_vec())
        .execute(pool)
        .await;
}

// ── Tests ────────────────────────────────────────────────────────────────

/// The publish-site resolver must produce, from real `channels` +
/// `channel_role_access` rows, exactly the routing scope the Stage-2 gate
/// needs: `None` for public (deliver to all members — the reactivity
/// invariant), `Some(granted roles)` for private (ungranted members dropped).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn resolver_maps_channel_privacy_to_routing_scope() {
    let pool = test_pool().await;
    let repo = PgChannelRepository::new(pool.clone());

    let owner = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    let public_channel = seed_channel(&pool, server, "f5-public", false).await;
    let private_ungranted = seed_channel(&pool, server, "f5-priv-ungranted", true).await;
    let private_granted = seed_channel(&pool, server, "f5-priv-granted", true).await;
    grant_channel_role(&pool, private_granted, "member").await;

    // Public → None: delivered by server membership alone. This is the
    // control guarding against over-gating (public events must keep flowing
    // to every member in real time).
    let scope = resolve_channel_access_by_id(&repo, &ChannelId::new(public_channel))
        .await
        .expect("resolve public");
    assert!(scope.is_none(), "public channel must resolve to None");

    // Private, no grants → Some([]): only Owner/Admin (implicit) receive its
    // events — a fresh private channel's exact state (grants come later).
    let scope = resolve_channel_access_by_id(&repo, &ChannelId::new(private_ungranted))
        .await
        .expect("resolve private ungranted")
        .expect("private channel must carry a scope");
    assert!(
        scope.authorized_roles.is_empty(),
        "ungranted private channel must expose an empty grant set, got {:?}",
        scope.authorized_roles
    );

    // Private with a member grant → Some([Member]): granted members receive
    // events, everything else is dropped by the Stage-2 gate.
    let scope = resolve_channel_access_by_id(&repo, &ChannelId::new(private_granted))
        .await
        .expect("resolve private granted")
        .expect("private channel must carry a scope");
    assert_eq!(scope.authorized_roles, vec![Role::Member]);

    cleanup(&pool, server, &[owner]).await;
}

/// A missing channel resolves to `None` (public). This documents WHY
/// `delete_channel` (and `delete_server`) must resolve the scope BEFORE the
/// row is deleted: resolving after would fail open and broadcast a private
/// channel's deletion + voice roster to the whole server.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn missing_channel_resolves_to_public_hence_pre_delete_snapshot() {
    let pool = test_pool().await;
    let repo = PgChannelRepository::new(pool.clone());

    let owner = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    let private_channel = seed_channel(&pool, server, "f5-priv-doomed", true).await;
    grant_channel_role(&pool, private_channel, "moderator").await;

    let channel_id = ChannelId::new(private_channel);

    // Pre-delete: the snapshot the handlers take — carries the grant set.
    let pre = resolve_channel_access_by_id(&repo, &channel_id)
        .await
        .expect("resolve pre-delete")
        .expect("private channel must carry a scope");
    assert_eq!(pre.authorized_roles, vec![Role::Moderator]);

    sqlx::query("DELETE FROM channels WHERE id = $1")
        .bind(private_channel)
        .execute(&pool)
        .await
        .expect("delete channel");

    // Post-delete: the row (and its grants) are gone → resolves to None
    // (public). Publishing with THIS value would leak — hence the pre-delete
    // snapshot in `delete_channel` / `delete_server`.
    let post = resolve_channel_access_by_id(&repo, &channel_id)
        .await
        .expect("resolve post-delete");
    assert!(
        post.is_none(),
        "missing channel must resolve to None — the leak the pre-delete snapshot prevents"
    );

    cleanup(&pool, server, &[owner]).await;
}
