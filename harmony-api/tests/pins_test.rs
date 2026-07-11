#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Pins backend regression tests (T2.3, real DB).
//!
//! Exercises the real SQL added for pins: `PgMessageRepository::set_pinned`
//! writes the flag + provenance atomically, `count_pinned` and `list_pinned`
//! honor the `is_pinned = true AND deleted_at IS NULL` filter, and the panel
//! order is `pinned_at DESC`.
//!
//! WHY `#[ignore]`: requires a running Postgres with the Harmony schema
//! (mirrors the reactions/attachments integration tests). Run locally with:
//!   `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:64322/postgres \
//!      cargo test --test pins_test -- --ignored`

use sqlx::PgPool;
use uuid::Uuid;

use harmony_api::domain::models::{ChannelId, MessageId, UserId};
use harmony_api::domain::ports::MessageRepository;
use harmony_api::infra::postgres::PgMessageRepository;

async fn test_pool() -> PgPool {
    dotenvy::dotenv().ok();
    let url =
        std::env::var("DATABASE_URL").expect("DATABASE_URL must be set for integration tests");
    PgPool::connect(&url)
        .await
        .expect("Failed to connect to test database")
}

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
    .bind(format!("pin-{uid}@example.com"))
    .execute(pool)
    .await
    .expect("seed auth.users");

    let username = format!("pin{}", &uid.simple().to_string()[..10]);
    sqlx::query(
        r#"
        INSERT INTO profiles (id, username, display_name)
        VALUES ($1, $2, 'Pinner')
        ON CONFLICT (id) DO UPDATE
            SET username = EXCLUDED.username, display_name = EXCLUDED.display_name
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
        "INSERT INTO servers (id, name, owner_id, is_dm) VALUES ($1, 'Pin Server', $2, false)",
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
        "INSERT INTO channels (id, server_id, name, is_private, encrypted) VALUES ($1, $2, 'pin-chan', false, false)",
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

/// Fixture: owner + server + channel + one message. Returns the repo, channel id,
/// message id, and the pinning user id.
async fn fixture(pool: &PgPool) -> (PgMessageRepository, ChannelId, MessageId, UserId) {
    let owner = seed_user(pool).await;
    let server = seed_server(pool, owner).await;
    let channel = seed_channel(pool, server).await;
    let message = seed_message(pool, channel, owner).await;
    (
        PgMessageRepository::new(pool.clone()),
        ChannelId::new(channel),
        MessageId::new(message),
        UserId::new(owner),
    )
}

#[tokio::test]
#[ignore = "requires a running Postgres (integration)"]
async fn pin_sets_flag_and_provenance_then_unpin_clears_all_three() {
    let pool = test_pool().await;
    let (repo, channel, message, pinner) = fixture(&pool).await;

    // Pin: flag + provenance are written atomically.
    let pinned = repo.set_pinned(&message, &pinner, true).await.unwrap();
    assert!(pinned.message.is_pinned);
    assert_eq!(pinned.message.pinned_by.as_ref(), Some(&pinner));
    assert!(pinned.message.pinned_at.is_some());

    assert_eq!(repo.count_pinned(&channel).await.unwrap(), 1);
    let listed = repo.list_pinned(&channel, 50).await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].message.id, message);

    // Unpin: all three cleared, drops from the list + count.
    let unpinned = repo.set_pinned(&message, &pinner, false).await.unwrap();
    assert!(!unpinned.message.is_pinned);
    assert!(unpinned.message.pinned_by.is_none());
    assert!(unpinned.message.pinned_at.is_none());

    assert_eq!(repo.count_pinned(&channel).await.unwrap(), 0);
    assert!(repo.list_pinned(&channel, 50).await.unwrap().is_empty());
}

#[tokio::test]
#[ignore = "requires a running Postgres (integration)"]
async fn list_pinned_orders_by_pinned_at_desc() {
    let pool = test_pool().await;
    let owner = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    let channel = seed_channel(&pool, server).await;
    let repo = PgMessageRepository::new(pool.clone());
    let cid = ChannelId::new(channel);

    let m1 = MessageId::new(seed_message(&pool, channel, owner).await);
    let m2 = MessageId::new(seed_message(&pool, channel, owner).await);
    let m3 = MessageId::new(seed_message(&pool, channel, owner).await);
    let pinner = UserId::new(owner);

    // Pin in order with a real gap so pinned_at is strictly increasing.
    for m in [&m1, &m2, &m3] {
        repo.set_pinned(m, &pinner, true).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }

    let listed = repo.list_pinned(&cid, 50).await.unwrap();
    let ids: Vec<_> = listed.iter().map(|m| m.message.id.clone()).collect();
    // Most-recently-pinned first.
    assert_eq!(ids, vec![m3, m2, m1]);
}

#[tokio::test]
#[ignore = "requires a running Postgres (integration)"]
async fn set_pinned_on_deleted_message_is_not_found_and_deleted_pins_drop_from_list() {
    let pool = test_pool().await;
    let (repo, channel, message, pinner) = fixture(&pool).await;

    // Pin, then soft-delete the pinned message.
    repo.set_pinned(&message, &pinner, true).await.unwrap();
    repo.soft_delete(&message, &pinner, None).await.unwrap();

    // A soft-deleted pinned message drops out of the panel list.
    assert!(repo.list_pinned(&channel, 50).await.unwrap().is_empty());

    // Pinning a soft-deleted message is a NotFound (the flag write is scoped to
    // non-deleted rows).
    let err = repo.set_pinned(&message, &pinner, true).await.unwrap_err();
    assert!(
        matches!(
            err,
            harmony_api::domain::errors::DomainError::NotFound { .. }
        ),
        "expected NotFound, got {err:?}"
    );
}
