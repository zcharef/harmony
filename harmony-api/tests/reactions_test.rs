#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Reactions "who reacted" backend regression tests (T1.5, real DB).
//!
//! Covers the batched read-model `PgReactionRepository::batch_for_messages`:
//! the reactor list is bounded to the first 10 by `created_at`, `count` stays
//! the authoritative (unbounded) total, `display_name` falls back to NULL,
//! `reacted_by_me` reflects the viewer even beyond the cap, and distinct emoji
//! keep independent reactor lists.
//!
//! WHY `#[ignore]`: requires a running Postgres with the Harmony schema
//! (mirrors the attachments/mentions integration tests). Run locally with:
//!   `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:64322/postgres \
//!      cargo test --test reactions_test -- --ignored`

use chrono::{DateTime, Duration, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use harmony_api::domain::models::{MessageId, UserId};
use harmony_api::domain::ports::ReactionRepository;
use harmony_api::infra::postgres::PgReactionRepository;

// ── DB pool (mirrors attachments_test) ───────────────────────────────────

async fn test_pool() -> PgPool {
    dotenvy::dotenv().ok();
    let url =
        std::env::var("DATABASE_URL").expect("DATABASE_URL must be set for integration tests");
    PgPool::connect(&url)
        .await
        .expect("Failed to connect to test database")
}

// ── Seeding ───────────────────────────────────────────────────────────────

/// Seeds an `auth.users` + `profiles` pair. `display_name` may be NULL to
/// exercise the username fallback.
async fn seed_user(pool: &PgPool, display_name: Option<&str>) -> Uuid {
    let uid = Uuid::new_v4();
    sqlx::query(
        r#"
        INSERT INTO auth.users (id, instance_id, role, aud, email, encrypted_password, email_confirmed_at, created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change)
        VALUES ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '', now(), now(), now(), '', '', '', '')
        ON CONFLICT (id) DO NOTHING
        "#,
    )
    .bind(uid)
    .bind(format!("rx-{uid}@example.com"))
    .execute(pool)
    .await
    .expect("seed auth.users");

    // WHY DO UPDATE (not DO NOTHING): the signup trigger auto-creates a
    // profiles row on the auth.users insert with a derived username and NULL
    // display_name — DO NOTHING would silently keep those and defeat the
    // display-name fixtures. Overwrite with the test's chosen values.
    let username = format!("rx{}", &uid.simple().to_string()[..10]);
    sqlx::query(
        r#"
        INSERT INTO profiles (id, username, display_name)
        VALUES ($1, $2, $3)
        ON CONFLICT (id) DO UPDATE
            SET username = EXCLUDED.username, display_name = EXCLUDED.display_name
        "#,
    )
    .bind(uid)
    .bind(username)
    .bind(display_name)
    .execute(pool)
    .await
    .expect("seed profiles");

    uid
}

async fn seed_server(pool: &PgPool, owner: Uuid) -> Uuid {
    let sid = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO servers (id, name, owner_id, is_dm) VALUES ($1, 'Rx Server', $2, false)",
    )
    .bind(sid)
    .bind(owner)
    .execute(pool)
    .await
    .expect("seed server");
    sqlx::query("INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'owner')")
        .bind(sid)
        .bind(owner)
        .execute(pool)
        .await
        .expect("seed owner membership");
    sid
}

async fn seed_channel(pool: &PgPool, server: Uuid) -> Uuid {
    let cid = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channels (id, server_id, name, is_private, encrypted) VALUES ($1, $2, 'rx-chan', false, false)",
    )
    .bind(cid)
    .bind(server)
    .execute(pool)
    .await
    .expect("seed channel");
    cid
}

async fn seed_message(pool: &PgPool, channel: Uuid, author: Uuid) -> Uuid {
    let mid = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO messages (id, channel_id, author_id, content) VALUES ($1, $2, $3, 'hi')",
    )
    .bind(mid)
    .bind(channel)
    .bind(author)
    .execute(pool)
    .await
    .expect("seed message");
    mid
}

/// Inserts a reaction row with an explicit `created_at` so ordering is
/// deterministic (the repo's `add` uses `now()`, which cannot stagger a batch
/// within one test run).
async fn seed_reaction(pool: &PgPool, message: Uuid, user: Uuid, emoji: &str, at: DateTime<Utc>) {
    sqlx::query(
        "INSERT INTO message_reactions (message_id, user_id, emoji, created_at) VALUES ($1, $2, $3, $4)",
    )
    .bind(message)
    .bind(user)
    .bind(emoji)
    .bind(at)
    .execute(pool)
    .await
    .expect("seed reaction");
}

async fn cleanup(pool: &PgPool, servers: &[Uuid], users: &[Uuid]) {
    let _ = sqlx::query("DELETE FROM servers WHERE id = ANY($1)")
        .bind(servers.to_vec())
        .execute(pool)
        .await;
    let _ = sqlx::query("DELETE FROM auth.users WHERE id = ANY($1)")
        .bind(users.to_vec())
        .execute(pool)
        .await;
}

// ── Tests ─────────────────────────────────────────────────────────────────

/// 12 users react 👍 with staggered timestamps: the reactor list caps at the
/// first 10 by `created_at`, `count` is the full 12, and the two latest are
/// excluded.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn batch_reactors_capped_at_ten_ordered_by_created_at() {
    let pool = test_pool().await;
    let repo = PgReactionRepository::new(pool.clone());

    let owner = seed_user(&pool, Some("Owner")).await;
    let server = seed_server(&pool, owner).await;
    let channel = seed_channel(&pool, server).await;
    let message = seed_message(&pool, channel, owner).await;

    let base = Utc::now();
    let mut users = vec![owner];
    // 12 distinct reactors, each stamped one second after the previous so the
    // insertion order is the created_at order.
    for i in 0..12 {
        let u = seed_user(&pool, Some(&format!("Reactor {i}"))).await;
        users.push(u);
        seed_reaction(&pool, message, u, "👍", base + Duration::seconds(i)).await;
    }

    let map = repo
        .batch_for_messages(&[MessageId::new(message)], &UserId::new(owner))
        .await
        .expect("batch_for_messages");

    let summaries = map.get(&MessageId::new(message)).expect("message present");
    assert_eq!(summaries.len(), 1, "one emoji group");
    let s = &summaries[0];
    assert_eq!(s.emoji, "👍");
    assert_eq!(s.count, 12, "count is the unbounded total");
    assert_eq!(s.reactors.len(), 10, "reactor list capped at 10");

    // The 10 reactors are the FIRST 10 by created_at, in order — the last two
    // (Reactor 10, Reactor 11) are excluded.
    let names: Vec<&str> = s
        .reactors
        .iter()
        .map(|r| r.display_name.as_deref().unwrap_or(&r.username))
        .collect();
    assert_eq!(names[0], "Reactor 0");
    assert_eq!(names[9], "Reactor 9");
    assert!(!names.contains(&"Reactor 10"));
    assert!(!names.contains(&"Reactor 11"));

    cleanup(&pool, &[server], &users).await;
}

/// A reactor with `display_name = NULL` yields `Reactor.display_name == None`
/// (client falls back to username); a reactor with a display name keeps it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn batch_reactor_display_name_falls_back_to_null() {
    let pool = test_pool().await;
    let repo = PgReactionRepository::new(pool.clone());

    let owner = seed_user(&pool, Some("Owner")).await;
    let server = seed_server(&pool, owner).await;
    let channel = seed_channel(&pool, server).await;
    let message = seed_message(&pool, channel, owner).await;

    let named = seed_user(&pool, Some("Named Person")).await;
    let anon = seed_user(&pool, None).await;
    let base = Utc::now();
    seed_reaction(&pool, message, named, "🎉", base).await;
    seed_reaction(&pool, message, anon, "🎉", base + Duration::seconds(1)).await;

    let map = repo
        .batch_for_messages(&[MessageId::new(message)], &UserId::new(owner))
        .await
        .expect("batch_for_messages");
    let s = &map.get(&MessageId::new(message)).expect("present")[0];

    assert_eq!(s.reactors.len(), 2);
    assert_eq!(s.reactors[0].display_name.as_deref(), Some("Named Person"));
    assert_eq!(
        s.reactors[1].display_name, None,
        "NULL display_name maps to None"
    );

    cleanup(&pool, &[server], &[owner, named, anon]).await;
}

/// The viewer is flagged `reacted_by_me` even when they are past the 10-reactor
/// cap (`BOOL_OR` runs over the whole partition, not just the returned rows).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn batch_reacted_by_me_true_beyond_cap() {
    let pool = test_pool().await;
    let repo = PgReactionRepository::new(pool.clone());

    let owner = seed_user(&pool, Some("Owner")).await;
    let server = seed_server(&pool, owner).await;
    let channel = seed_channel(&pool, server).await;
    let message = seed_message(&pool, channel, owner).await;

    let base = Utc::now();
    let mut users = vec![owner];
    // 10 early reactors fill the cap...
    for i in 0..10 {
        let u = seed_user(&pool, Some(&format!("Early {i}"))).await;
        users.push(u);
        seed_reaction(&pool, message, u, "👍", base + Duration::seconds(i)).await;
    }
    // ...then the viewer reacts LAST, landing at rank 11 (outside the cap).
    let viewer = seed_user(&pool, Some("Viewer")).await;
    users.push(viewer);
    seed_reaction(&pool, message, viewer, "👍", base + Duration::seconds(20)).await;

    let map = repo
        .batch_for_messages(&[MessageId::new(message)], &UserId::new(viewer))
        .await
        .expect("batch_for_messages");
    let s = &map.get(&MessageId::new(message)).expect("present")[0];

    assert_eq!(s.count, 11);
    assert_eq!(s.reactors.len(), 10);
    assert!(s.reacted_by_me, "viewer flagged even though past the cap");
    // The bounded list is exactly the 10 EARLY reactors — the viewer reacted
    // last (rank 11) so their display name is absent even though the flag is set.
    assert!(
        s.reactors
            .iter()
            .all(|r| r.display_name.as_deref() != Some("Viewer"))
    );
    assert!(s.reactors.iter().all(|r| {
        r.display_name
            .as_deref()
            .is_some_and(|n| n.starts_with("Early "))
    }));

    cleanup(&pool, &[server], &users).await;
}

/// Two distinct emoji on the same message produce two independent summaries,
/// each with its own reactor list and count.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn batch_multiple_emoji_independent_reactor_lists() {
    let pool = test_pool().await;
    let repo = PgReactionRepository::new(pool.clone());

    let owner = seed_user(&pool, Some("Owner")).await;
    let server = seed_server(&pool, owner).await;
    let channel = seed_channel(&pool, server).await;
    let message = seed_message(&pool, channel, owner).await;

    let alice = seed_user(&pool, Some("Alice")).await;
    let bob = seed_user(&pool, Some("Bob")).await;
    let base = Utc::now();
    // 👍 first (earlier), 🎉 second — group ordering follows earliest created_at.
    seed_reaction(&pool, message, alice, "👍", base).await;
    seed_reaction(&pool, message, bob, "👍", base + Duration::seconds(1)).await;
    seed_reaction(&pool, message, alice, "🎉", base + Duration::seconds(2)).await;

    let map = repo
        .batch_for_messages(&[MessageId::new(message)], &UserId::new(owner))
        .await
        .expect("batch_for_messages");
    let summaries = map.get(&MessageId::new(message)).expect("present");

    assert_eq!(summaries.len(), 2);
    assert_eq!(summaries[0].emoji, "👍");
    assert_eq!(summaries[0].count, 2);
    assert_eq!(summaries[0].reactors.len(), 2);
    assert_eq!(summaries[1].emoji, "🎉");
    assert_eq!(summaries[1].count, 1);
    assert_eq!(summaries[1].reactors.len(), 1);
    assert_eq!(
        summaries[1].reactors[0].display_name.as_deref(),
        Some("Alice")
    );

    cleanup(&pool, &[server], &[owner, alice, bob]).await;
}

/// A message with no reactions is absent from the map (unchanged behaviour).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn batch_empty_for_message_with_no_reactions() {
    let pool = test_pool().await;
    let repo = PgReactionRepository::new(pool.clone());

    let owner = seed_user(&pool, Some("Owner")).await;
    let server = seed_server(&pool, owner).await;
    let channel = seed_channel(&pool, server).await;
    let message = seed_message(&pool, channel, owner).await;

    let map = repo
        .batch_for_messages(&[MessageId::new(message)], &UserId::new(owner))
        .await
        .expect("batch_for_messages");

    assert!(!map.contains_key(&MessageId::new(message)));

    cleanup(&pool, &[server], &[owner]).await;
}
