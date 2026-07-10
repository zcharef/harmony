#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::doc_markdown
)]
//! Mentions backend regression tests (real DB, step 2).
//!
//! Covers the BLOCKER-1 pair (`filter_mentionable` ≡ `ensure_channel_access`),
//! mention resolution (left member / deleted account), message persistence of
//! `mentioned_user_ids`, and the computed `mention_count` (mention-equivalence
//! incl. the DM disjunct + mark_read reset).
//!
//! WHY `#[ignore]`: requires a running Postgres with the Harmony schema (mirrors
//! the read-state, DM, ban and voice integration tests). Run locally with:
//!   `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:64322/postgres \
//!      cargo test --test mentions_test -- --ignored`

use std::collections::HashSet;

use sqlx::PgPool;
use uuid::Uuid;

use harmony_api::domain::models::{ChannelId, MessageId, ServerId, UserId};
use harmony_api::domain::ports::{
    ChannelRepository, MemberRepository, MessageRepository, ReadStateRepository,
};
use harmony_api::infra::postgres::{
    PgChannelRepository, PgMemberRepository, PgMessageRepository, PgReadStateRepository,
};

// ── DB pool (mirrors read_state_access_test) ─────────────────────────────

async fn test_pool() -> PgPool {
    dotenvy::dotenv().ok();
    let url =
        std::env::var("DATABASE_URL").expect("DATABASE_URL must be set for integration tests");
    PgPool::connect(&url)
        .await
        .expect("Failed to connect to test database")
}

// ── Seeding ──────────────────────────────────────────────────────────────

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
    .bind(format!("mnt-{uid}@example.com"))
    .execute(pool)
    .await
    .expect("seed auth.users");

    let username = format!("mn{}", &uid.simple().to_string()[..10]);
    sqlx::query(
        r#"
        INSERT INTO profiles (id, username, display_name)
        VALUES ($1, $2, 'Mention Tester')
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

async fn seed_server(pool: &PgPool, owner: Uuid, is_dm: bool) -> Uuid {
    let sid = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO servers (id, name, owner_id, is_dm) VALUES ($1, 'Mention Server', $2, $3)",
    )
    .bind(sid)
    .bind(owner)
    .bind(is_dm)
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

async fn add_member(pool: &PgPool, server: Uuid, user: Uuid, role: &str) {
    sqlx::query("INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, $3)")
        .bind(server)
        .bind(user)
        .bind(role)
        .execute(pool)
        .await
        .expect("seed server_member");
}

/// Post a message authored by `author` mentioning `mentions`.
async fn post_message(pool: &PgPool, channel: Uuid, author: Uuid, mentions: &[Uuid]) {
    sqlx::query(
        "INSERT INTO messages (channel_id, author_id, content, mentioned_user_ids) VALUES ($1, $2, 'hi', $3)",
    )
    .bind(channel)
    .bind(author)
    .bind(mentions)
    .execute(pool)
    .await
    .expect("seed message");
}

async fn grant_channel_role(pool: &PgPool, channel: Uuid, role: &str) {
    sqlx::query("INSERT INTO channel_role_access (channel_id, role) VALUES ($1, $2)")
        .bind(channel)
        .bind(role)
        .execute(pool)
        .await
        .expect("grant channel_role_access");
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

async fn fetch_channel(pool: &PgPool, channel: Uuid) -> harmony_api::domain::models::Channel {
    PgChannelRepository::new(pool.clone())
        .get_by_id(&ChannelId::new(channel))
        .await
        .expect("get_by_id")
        .expect("channel exists")
}

// ── filter_mentionable ≡ ensure_channel_access (BLOCKER-1) ────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn filter_mentionable_gates_channel_access() {
    let pool = test_pool().await;
    let repo = PgMemberRepository::new(pool.clone());

    let owner = seed_user(&pool).await;
    let member = seed_user(&pool).await;
    let admin = seed_user(&pool).await;
    let stranger = seed_user(&pool).await; // NOT a server member

    let server = seed_server(&pool, owner, false).await;
    add_member(&pool, server, member, "member").await;
    add_member(&pool, server, admin, "admin").await;

    let public = fetch_channel(&pool, seed_channel(&pool, server, "pub", false).await).await;
    let private = fetch_channel(&pool, seed_channel(&pool, server, "priv", true).await).await;

    let candidates = [
        UserId::new(member),
        UserId::new(admin),
        UserId::new(stranger),
    ];

    // Public channel: members pass, stranger dropped.
    let pub_ok: HashSet<Uuid> = repo
        .filter_mentionable(&public, &candidates)
        .await
        .unwrap()
        .into_iter()
        .map(|u| u.0)
        .collect();
    assert!(pub_ok.contains(&member), "member mentionable in public");
    assert!(pub_ok.contains(&admin), "admin mentionable in public");
    assert!(!pub_ok.contains(&stranger), "stranger dropped (non-member)");

    // Private channel, NO grant: plain member dropped, admin passes (role bypass).
    let priv_ok: HashSet<Uuid> = repo
        .filter_mentionable(&private, &candidates)
        .await
        .unwrap()
        .into_iter()
        .map(|u| u.0)
        .collect();
    assert!(
        !priv_ok.contains(&member),
        "member WITHOUT grant dropped in private channel (BLOCKER-1)"
    );
    assert!(
        priv_ok.contains(&admin),
        "admin passes private (role bypass)"
    );
    assert!(!priv_ok.contains(&stranger), "stranger dropped");

    // After granting the member's role, the member becomes mentionable.
    grant_channel_role(&pool, private.id.0, "member").await;
    let priv_after: HashSet<Uuid> = repo
        .filter_mentionable(&private, &candidates)
        .await
        .unwrap()
        .into_iter()
        .map(|u| u.0)
        .collect();
    assert!(
        priv_after.contains(&member),
        "member WITH channel_role_access grant is mentionable"
    );

    cleanup(&pool, &[server], &[owner, member, admin, stranger]).await;
}

// ── resolve_mentioned_users (left member / deleted account) ───────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn resolve_mentioned_users_handles_left_and_deleted() {
    let pool = test_pool().await;
    let repo = PgMemberRepository::new(pool.clone());

    let owner = seed_user(&pool).await;
    let current = seed_user(&pool).await; // current member (has a nickname)
    let left = seed_user(&pool).await; // resolves but nickname is null (not a member)

    let server = seed_server(&pool, owner, false).await;
    add_member(&pool, server, current, "member").await;
    sqlx::query(
        "UPDATE server_members SET nickname = 'Nick' WHERE server_id = $1 AND user_id = $2",
    )
    .bind(server)
    .bind(current)
    .execute(&pool)
    .await
    .unwrap();

    let missing = Uuid::new_v4(); // no profile row at all → omitted
    let ids = [
        UserId::new(current),
        UserId::new(left),
        UserId::new(missing),
    ];
    let resolved = repo
        .resolve_mentioned_users(&ServerId::new(server), &ids)
        .await
        .unwrap();

    let by_id: std::collections::HashMap<Uuid, _> =
        resolved.into_iter().map(|m| (m.user_id.0, m)).collect();
    assert!(
        !by_id.contains_key(&missing),
        "deleted account (no profile) is omitted"
    );
    assert_eq!(
        by_id.get(&current).unwrap().nickname.as_deref(),
        Some("Nick"),
        "current member resolves with nickname"
    );
    let left_resolved = by_id.get(&left).expect("left user still resolves");
    assert!(
        left_resolved.nickname.is_none(),
        "a non-member profile resolves with a null nickname"
    );

    cleanup(&pool, &[server], &[owner, current, left]).await;
}

// ── Message persistence round-trip ────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn send_persists_mentioned_user_ids() {
    let pool = test_pool().await;
    let repo = PgMessageRepository::new(pool.clone());

    let owner = seed_user(&pool).await;
    let target = seed_user(&pool).await;
    let server = seed_server(&pool, owner, false).await;
    add_member(&pool, server, target, "member").await;
    let channel = seed_channel(&pool, server, "gen", false).await;

    let sent = repo
        .send_to_channel(
            &ChannelId::new(channel),
            &UserId::new(owner),
            "hey <@x>".to_string(),
            false,
            None,
            None,
            None,
            None,
            None,
            vec![UserId::new(target)],
            vec![],
            0,
        )
        .await
        .expect("send_to_channel");
    assert_eq!(
        sent.message.mentioned_user_ids,
        vec![UserId::new(target)],
        "send_to_channel returns the persisted mention list"
    );

    // find_by_id reads the column back.
    let found = repo
        .find_by_id(&MessageId::new(sent.message.id.0))
        .await
        .unwrap()
        .expect("message exists");
    assert_eq!(found.mentioned_user_ids, vec![UserId::new(target)]);

    // update_content with None leaves the column unchanged (encrypted-edit path).
    let edited = repo
        .update_content(
            &sent.message.id,
            "edited".to_string(),
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        edited.message.mentioned_user_ids,
        vec![UserId::new(target)],
        "None leaves mentioned_user_ids untouched (COALESCE)"
    );

    // update_content with Some overwrites it.
    let recleared = repo
        .update_content(
            &sent.message.id,
            "edited again".to_string(),
            None,
            None,
            None,
            Some(vec![]),
        )
        .await
        .unwrap();
    assert!(
        recleared.message.mentioned_user_ids.is_empty(),
        "Some([]) overwrites mentioned_user_ids to empty"
    );

    cleanup(&pool, &[server], &[owner, target]).await;
}

// ── Computed mention_count (mention-equivalence + DM disjunct + reset) ─────

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn mention_count_honors_equivalence_and_reset() {
    let pool = test_pool().await;
    let read_repo = PgReadStateRepository::new(pool.clone());

    let author = seed_user(&pool).await;
    let target = seed_user(&pool).await; // mentioned in the server channel
    let bystander = seed_user(&pool).await; // NOT mentioned

    // Regular server + channel.
    let server = seed_server(&pool, author, false).await;
    add_member(&pool, server, target, "member").await;
    add_member(&pool, server, bystander, "member").await;
    let channel = seed_channel(&pool, server, "gen", false).await;
    post_message(&pool, channel, author, &[target]).await;

    // DM server between author and target (no markers → counts by is_dm).
    let dm_server = seed_server(&pool, author, true).await;
    add_member(&pool, dm_server, target, "member").await;
    let dm_channel = seed_channel(&pool, dm_server, "dm", false).await;
    post_message(&pool, dm_channel, author, &[]).await;

    let mention_count = |states: &[harmony_api::domain::models::ChannelReadState], cid: Uuid| {
        states
            .iter()
            .find(|s| s.channel_id.0 == cid)
            .map_or(0, |s| s.mention_count)
    };

    // Target: mentioned in the server channel (count 1) AND the DM counts (count 1).
    let target_states = read_repo
        .list_all_for_user(&UserId::new(target))
        .await
        .unwrap();
    assert_eq!(
        mention_count(&target_states, channel),
        1,
        "explicit mention counts for the target"
    );
    assert_eq!(
        mention_count(&target_states, dm_channel),
        1,
        "DM message counts via mention-equivalence (is_dm disjunct)"
    );

    // Bystander: unread in the server channel but NOT mentioned → mention_count 0.
    let bystander_states = read_repo
        .list_all_for_user(&UserId::new(bystander))
        .await
        .unwrap();
    assert!(
        bystander_states
            .iter()
            .any(|s| s.channel_id.0 == channel && s.unread_count == 1),
        "bystander has the unread"
    );
    assert_eq!(
        mention_count(&bystander_states, channel),
        0,
        "a non-mentioned reader gets no mention count"
    );

    // mark_read resets: move last_read_at past the message.
    let last_msg: Uuid = sqlx::query_scalar(
        "SELECT id FROM messages WHERE channel_id = $1 ORDER BY created_at DESC LIMIT 1",
    )
    .bind(channel)
    .fetch_one(&pool)
    .await
    .unwrap();
    read_repo
        .mark_read(
            &ChannelId::new(channel),
            &UserId::new(target),
            &MessageId::new(last_msg),
        )
        .await
        .unwrap();
    let after = read_repo
        .list_all_for_user(&UserId::new(target))
        .await
        .unwrap();
    assert_eq!(
        mention_count(&after, channel),
        0,
        "mark_read resets the computed mention count for free"
    );

    cleanup(&pool, &[server, dm_server], &[author, target, bystander]).await;
}
