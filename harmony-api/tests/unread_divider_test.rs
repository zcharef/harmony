#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Real-DB coverage for the "new messages" divider backend (unread-divider ticket).
//!
//! Two additions are exercised:
//!   - `PgReadStateRepository::get_for_channel` — the single-channel read
//!     position that anchors the divider. It MUST agree byte-for-byte with the
//!     `list_all_for_user` snapshot (a divider that disagrees with the badge is
//!     the #1 bug this feature can ship).
//!   - `PgMessageRepository::list_around` — the jump-to-message window. It must
//!     return a target-centered, `created_at DESC` page and include the anchor
//!     even when soft-deleted (jump lands on the tombstone).
//!
//! WHY `#[ignore]`: requires a running Postgres with the Harmony schema (mirrors
//! the DM, ban and read-state integration tests). Run locally with:
//!   `DATABASE_URL=... cargo test --test unread_divider_test -- --ignored`

use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use harmony_api::domain::models::{ChannelId, MessageId, UserId};
use harmony_api::domain::ports::{MessageRepository, ReadStateRepository};
use harmony_api::infra::postgres::{PgMessageRepository, PgReadStateRepository};

// ── DB pool ─────────────────────────────────────────────────────────────

async fn test_pool() -> PgPool {
    dotenvy::dotenv().ok();
    let url =
        std::env::var("DATABASE_URL").expect("DATABASE_URL must be set for integration tests");
    PgPool::connect(&url)
        .await
        .expect("Failed to connect to test database")
}

// ── Seeding (mirrors read_state_access_test) ────────────────────────────

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
    .bind(format!("ud-{uid}@example.com"))
    .execute(pool)
    .await
    .expect("seed auth.users");

    let username = format!("ud{}", &uid.simple().to_string()[..10]);
    sqlx::query(
        r#"
        INSERT INTO profiles (id, username, display_name)
        VALUES ($1, $2, 'Unread Divider')
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
    sqlx::query(
        "INSERT INTO servers (id, name, owner_id) VALUES ($1, 'Unread Divider Server', $2)",
    )
    .bind(sid)
    .bind(owner)
    .execute(pool)
    .await
    .expect("seed server");
    sid
}

async fn seed_channel(pool: &PgPool, server: Uuid) -> Uuid {
    let cid = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channels (id, server_id, name, is_private) VALUES ($1, $2, 'ud-chan', false)",
    )
    .bind(cid)
    .bind(server)
    .execute(pool)
    .await
    .expect("seed channel");
    cid
}

async fn add_member(pool: &PgPool, server: Uuid, user: Uuid, role: &str) {
    sqlx::query("INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, $3)")
        .bind(server)
        .bind(user)
        .bind(role)
        .execute(pool)
        .await
        .expect("seed server_member");
}

/// Post a message with an explicit `created_at` so ordering is deterministic.
async fn post_message_at(
    pool: &PgPool,
    channel: Uuid,
    author: Uuid,
    created_at: DateTime<Utc>,
) -> Uuid {
    let mid = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO messages (id, channel_id, author_id, content, created_at) VALUES ($1, $2, $3, 'hi', $4)",
    )
    .bind(mid)
    .bind(channel)
    .bind(author)
    .bind(created_at)
    .execute(pool)
    .await
    .expect("seed message");
    mid
}

async fn soft_delete(pool: &PgPool, message: Uuid) {
    sqlx::query("UPDATE messages SET deleted_at = now() WHERE id = $1")
        .bind(message)
        .execute(pool)
        .await
        .expect("soft-delete message");
}

async fn cleanup(pool: &PgPool, server: Uuid, users: &[Uuid]) {
    let _ = sqlx::query("DELETE FROM servers WHERE id = $1")
        .bind(server)
        .execute(pool)
        .await;
    let _ = sqlx::query("DELETE FROM auth.users WHERE id = ANY($1)")
        .bind(users.to_vec())
        .execute(pool)
        .await;
}

// ── Tests ───────────────────────────────────────────────────────────────

/// `get_for_channel` reports the null anchor + full unread when never read, and
/// its counts MUST equal the same channel's entry in `list_all_for_user`.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn get_for_channel_matches_snapshot_and_tracks_mark_read() {
    let pool = test_pool().await;
    let author = seed_user(&pool).await;
    let reader = seed_user(&pool).await;
    let server = seed_server(&pool, author).await;
    let channel = seed_channel(&pool, server).await;
    add_member(&pool, server, reader, "member").await;

    let base = Utc::now() - chrono::Duration::hours(1);
    let mut last_mid = Uuid::nil();
    for i in 0..3 {
        last_mid =
            post_message_at(&pool, channel, author, base + chrono::Duration::seconds(i)).await;
    }

    let read_repo = PgReadStateRepository::new(pool.clone());
    let cid = ChannelId::new(channel);
    let ruid = UserId::new(reader);

    // (1) Never read: null anchor, unread = 3.
    let state = read_repo.get_for_channel(&cid, &ruid).await.unwrap();
    assert_eq!(state.unread_count, 3, "all three messages are unread");
    assert!(state.last_read_at.is_none(), "never read → null anchor");
    assert!(
        state.last_message_id.is_none(),
        "never read → no last message"
    );

    // (2) Consistency guard: the single-channel read must equal the snapshot.
    let snapshot = read_repo.list_all_for_user(&ruid).await.unwrap();
    let entry = snapshot
        .into_iter()
        .find(|s| s.channel_id.0 == channel)
        .expect("channel present in snapshot while unread > 0");
    assert_eq!(
        state.unread_count, entry.unread_count,
        "divider anchor unread must equal the badge snapshot"
    );
    assert_eq!(state.mention_count, entry.mention_count);

    // (3) After marking read up to the last message: unread clears, anchor set.
    read_repo
        .mark_read(&cid, &ruid, &MessageId::new(last_mid))
        .await
        .unwrap();
    let after = read_repo.get_for_channel(&cid, &ruid).await.unwrap();
    assert_eq!(after.unread_count, 0, "everything read → zero unread");
    assert!(after.last_read_at.is_some(), "mark_read sets the anchor");
    assert_eq!(
        after.last_message_id,
        Some(MessageId::new(last_mid)),
        "anchor points at the marked message"
    );

    cleanup(&pool, server, &[author, reader]).await;
}

/// `list_around` returns a target-centered, DESC-ordered window and includes the
/// anchor even when it is soft-deleted (jump-to-tombstone).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn list_around_centers_window_and_includes_deleted_anchor() {
    let pool = test_pool().await;
    let author = seed_user(&pool).await;
    let server = seed_server(&pool, author).await;
    let channel = seed_channel(&pool, server).await;

    let base = Utc::now() - chrono::Duration::hours(2);
    let mut ids = Vec::new();
    for i in 0..40 {
        ids.push(
            post_message_at(&pool, channel, author, base + chrono::Duration::seconds(i)).await,
        );
    }

    let msg_repo = PgMessageRepository::new(pool.clone());
    let cid = ChannelId::new(channel);
    let anchor = MessageId::new(ids[20]);

    // limit split: before = 20/2 = 10 older, after = 20-1-10 = 9 newer, +anchor = 20.
    let window = msg_repo
        .list_around(&cid, &anchor, 10, 9)
        .await
        .unwrap()
        .expect("anchor exists");
    assert_eq!(window.len(), 20, "10 older + anchor + 9 newer");

    // DESC ordered.
    for pair in window.windows(2) {
        assert!(
            pair[0].message.created_at >= pair[1].message.created_at,
            "list_around must be created_at DESC"
        );
    }
    // Anchor present and centered.
    assert!(
        window.iter().any(|m| m.message.id == anchor),
        "anchor must be in the window"
    );

    // Unknown / wrong-channel anchor → None.
    let missing = msg_repo
        .list_around(&cid, &MessageId::new(Uuid::new_v4()), 10, 9)
        .await
        .unwrap();
    assert!(missing.is_none(), "unknown anchor yields None (→ NotFound)");

    // Soft-deleted anchor is still returned (jump-to-tombstone).
    soft_delete(&pool, ids[20]).await;
    let with_deleted = msg_repo
        .list_around(&cid, &anchor, 5, 5)
        .await
        .unwrap()
        .expect("deleted anchor still resolves");
    assert!(
        with_deleted.iter().any(|m| m.message.id == anchor),
        "soft-deleted anchor must be included so the jump lands on the tombstone"
    );

    cleanup(&pool, server, &[author]).await;
}
