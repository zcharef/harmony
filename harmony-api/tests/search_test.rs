#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::doc_markdown
)]
//! Message search (T2.4) backend regression tests — real DB.
//!
//! Pins `search_in_server` — the SSoT for the search access gate — against the
//! SAME fixtures `ensure_channel_access`/`filter_mentionable` use (spec §7.2,
//! the BLOCKER regression): a private channel with no grant is absent for a
//! plain member, present for an admin, and present for the member once granted.
//! Also covers FTS basics, encrypted exclusion, the `from:`/`in:`/`has:` filters,
//! soft-delete, left-author resolution, keyset pagination, and cross-server
//! injection.
//!
//! WHY `#[ignore]`: requires a running Postgres with the Harmony schema (mirrors
//! the mentions / read-state / voice integration tests). Run locally with:
//!   `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:64322/postgres \
//!      cargo test --test search_test -- --ignored`

use std::collections::HashSet;
use std::sync::Arc;

use chrono::{DateTime, Duration, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use harmony_api::domain::errors::DomainError;
use harmony_api::domain::models::{ChannelId, ServerId, UserId};
use harmony_api::domain::ports::{MessageRepository, MessageSearchFilters};
use harmony_api::domain::services::{ContentFilter, MessageService, SpamGuard};
use harmony_api::infra::postgres::{
    PgAttachmentRepository, PgChannelRepository, PgMemberRepository, PgMessageRepository,
    PgPlanLimitChecker, PgReactionRepository,
};

// ── DB pool (mirrors mentions_test) ──────────────────────────────────────

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
    .bind(format!("srch-{uid}@example.com"))
    .execute(pool)
    .await
    .expect("seed auth.users");

    let username = format!("sr{}", &uid.simple().to_string()[..10]);
    sqlx::query("INSERT INTO profiles (id, username, display_name) VALUES ($1, $2, 'Search Tester') ON CONFLICT (id) DO NOTHING")
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
        "INSERT INTO servers (id, name, owner_id, is_dm) VALUES ($1, 'Search Server', $2, false)",
    )
    .bind(sid)
    .bind(owner)
    .execute(pool)
    .await
    .expect("seed server");
    sid
}

async fn seed_channel(
    pool: &PgPool,
    server: Uuid,
    name: &str,
    is_private: bool,
    encrypted: bool,
) -> Uuid {
    let cid = Uuid::new_v4();
    sqlx::query("INSERT INTO channels (id, server_id, name, is_private, encrypted) VALUES ($1, $2, $3, $4, $5)")
        .bind(cid)
        .bind(server)
        .bind(name)
        .bind(is_private)
        .bind(encrypted)
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

async fn grant_channel_role(pool: &PgPool, channel: Uuid, role: &str) {
    sqlx::query("INSERT INTO channel_role_access (channel_id, role) VALUES ($1, $2)")
        .bind(channel)
        .bind(role)
        .execute(pool)
        .await
        .expect("grant channel_role_access");
}

/// Post a plaintext message, returning its id. `created_at` is explicit so
/// pagination ordering is deterministic (distinct timestamps, no tiebreak flake).
async fn post_at(
    pool: &PgPool,
    channel: Uuid,
    author: Uuid,
    content: &str,
    created_at: DateTime<Utc>,
) -> Uuid {
    let mid = Uuid::new_v4();
    sqlx::query("INSERT INTO messages (id, channel_id, author_id, content, encrypted, created_at) VALUES ($1, $2, $3, $4, false, $5)")
        .bind(mid)
        .bind(channel)
        .bind(author)
        .bind(content)
        .bind(created_at)
        .execute(pool)
        .await
        .expect("seed message");
    mid
}

/// Post a plaintext message at `now()`.
async fn post(pool: &PgPool, channel: Uuid, author: Uuid, content: &str) -> Uuid {
    post_at(pool, channel, author, content, Utc::now()).await
}

/// Post a message flagged `encrypted = true` (content_tsv is NULL by the
/// generated-column CASE — un-searchable by construction).
async fn post_encrypted(pool: &PgPool, channel: Uuid, author: Uuid, ciphertext: &str) -> Uuid {
    let mid = Uuid::new_v4();
    sqlx::query("INSERT INTO messages (id, channel_id, author_id, content, encrypted, sender_device_id) VALUES ($1, $2, $3, $4, true, 'dev-1')")
        .bind(mid)
        .bind(channel)
        .bind(author)
        .bind(ciphertext)
        .execute(pool)
        .await
        .expect("seed encrypted message");
    mid
}

async fn soft_delete(pool: &PgPool, message: Uuid, by: Uuid) {
    sqlx::query("UPDATE messages SET deleted_at = now(), deleted_by = $2 WHERE id = $1")
        .bind(message)
        .bind(by)
        .execute(pool)
        .await
        .expect("soft delete");
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

fn filters() -> MessageSearchFilters {
    MessageSearchFilters {
        channel_id: None,
        author_id: None,
        has_link: false,
        has_image: false,
    }
}

/// Collect the returned message ids as a set for order-independent assertions.
fn ids(rows: &[harmony_api::domain::models::MessageWithAuthor]) -> HashSet<Uuid> {
    rows.iter().map(|m| m.message.id.0).collect()
}

/// Build a real `MessageService` over the test pool (mirrors `attachments_test`).
/// The service is what wraps `search_in_server` with the membership / explicit-
/// channel access gates (§7.2) — the repo alone has no such gate. `SpamGuard`
/// is irrelevant to search; disable it to match the E2E env.
fn build_service(pool: &PgPool) -> MessageService {
    MessageService::new(
        Arc::new(PgMessageRepository::new(pool.clone())),
        Arc::new(PgChannelRepository::new(pool.clone())),
        Arc::new(PgMemberRepository::new(pool.clone())),
        Arc::new(PgPlanLimitChecker::new(pool.clone())),
        Arc::new(PgReactionRepository::new(pool.clone())),
        Arc::new(PgAttachmentRepository::new(pool.clone())),
        Arc::new(ContentFilter::new()),
        Arc::new(SpamGuard::with_enabled(false)),
    )
}

// ── FTS basics ────────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn fts_basics_matches_and_stopwords() {
    let pool = test_pool().await;
    let repo = PgMessageRepository::new(pool.clone());

    let owner = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    add_member(&pool, server, owner, "owner").await;
    let channel = seed_channel(&pool, server, "general", false, false).await;

    let hello = post(&pool, channel, owner, "hello world").await;
    let goodbye = post(&pool, channel, owner, "goodbye world").await;

    let sid = ServerId::new(server);
    let uid = UserId::new(owner);

    // `hello` matches only the first.
    let r = repo
        .search_in_server(&sid, &uid, "hello", &filters(), None, 25)
        .await
        .unwrap();
    assert_eq!(ids(&r), HashSet::from([hello]));

    // `world` matches both, newest-first (goodbye posted last).
    let r = repo
        .search_in_server(&sid, &uid, "world", &filters(), None, 25)
        .await
        .unwrap();
    assert_eq!(ids(&r), HashSet::from([hello, goodbye]));
    assert_eq!(r.first().unwrap().message.id.0, goodbye, "newest first");

    // Stopword-only query → empty tsquery → zero rows (not an error).
    let r = repo
        .search_in_server(&sid, &uid, "the", &filters(), None, 25)
        .await
        .unwrap();
    assert!(r.is_empty(), "stopword-only query returns nothing");

    cleanup(&pool, &[server], &[owner]).await;
}

// ── Access gate ≡ ensure_channel_access (BLOCKER regression, §7.2) ────────

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn access_gate_matches_channel_visibility() {
    let pool = test_pool().await;
    let repo = PgMessageRepository::new(pool.clone());

    let owner = seed_user(&pool).await;
    let member = seed_user(&pool).await;
    let admin = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    add_member(&pool, server, owner, "owner").await;
    add_member(&pool, server, member, "member").await;
    add_member(&pool, server, admin, "admin").await;

    let private = seed_channel(&pool, server, "secret-room", true, false).await;
    let msg = post(&pool, private, owner, "classified treasure").await;

    let sid = ServerId::new(server);
    let member_uid = UserId::new(member);
    let admin_uid = UserId::new(admin);

    // Plain member, no grant: the private-channel match is ABSENT (server-wide).
    let r = repo
        .search_in_server(&sid, &member_uid, "treasure", &filters(), None, 25)
        .await
        .unwrap();
    assert!(
        !ids(&r).contains(&msg),
        "member without grant must NOT see a private-channel match"
    );

    // Admin: the same match is PRESENT (role bypass).
    let r = repo
        .search_in_server(&sid, &admin_uid, "treasure", &filters(), None, 25)
        .await
        .unwrap();
    assert!(
        ids(&r).contains(&msg),
        "admin sees the private-channel match"
    );

    // Explicit `in:` on the private channel the member can't access → still
    // empty from the repo (the service turns this into a clean 403; the repo
    // never leaks the row either way — no oracle).
    let member_in_private = MessageSearchFilters {
        channel_id: Some(ChannelId::new(private)),
        ..filters()
    };
    let r = repo
        .search_in_server(&sid, &member_uid, "treasure", &member_in_private, None, 25)
        .await
        .unwrap();
    assert!(
        r.is_empty(),
        "member's explicit in:#private returns no rows"
    );

    // After granting the member's role, the match appears.
    grant_channel_role(&pool, private, "member").await;
    let r = repo
        .search_in_server(&sid, &member_uid, "treasure", &filters(), None, 25)
        .await
        .unwrap();
    assert!(
        ids(&r).contains(&msg),
        "member WITH channel_role_access grant sees the match"
    );

    cleanup(&pool, &[server], &[owner, member, admin]).await;
}

// ── Encrypted exclusion ───────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn encrypted_content_is_never_returned() {
    let pool = test_pool().await;
    let repo = PgMessageRepository::new(pool.clone());

    let owner = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    add_member(&pool, server, owner, "owner").await;

    // An encrypted channel with a plaintext-looking body: excluded by c.encrypted.
    let enc_channel = seed_channel(&pool, server, "e2ee", false, true).await;
    post(
        &pool,
        enc_channel,
        owner,
        "secretword in an encrypted channel",
    )
    .await;
    // A message flagged encrypted (content_tsv NULL) in a normal channel: excluded.
    let plain_channel = seed_channel(&pool, server, "general", false, false).await;
    post_encrypted(&pool, plain_channel, owner, "secretword ciphertext").await;

    let sid = ServerId::new(server);
    let uid = UserId::new(owner);
    let r = repo
        .search_in_server(&sid, &uid, "secretword", &filters(), None, 25)
        .await
        .unwrap();
    assert!(
        r.is_empty(),
        "encrypted channel + encrypted message excluded"
    );

    cleanup(&pool, &[server], &[owner]).await;
}

// ── Structured filters (from / in / has:link / has:image / compose) ───────

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn structured_filters_narrow_results() {
    let pool = test_pool().await;
    let repo = PgMessageRepository::new(pool.clone());

    let alice = seed_user(&pool).await;
    let bob = seed_user(&pool).await;
    let server = seed_server(&pool, alice).await;
    add_member(&pool, server, alice, "owner").await;
    add_member(&pool, server, bob, "member").await;

    let chan_a = seed_channel(&pool, server, "alpha", false, false).await;
    let chan_b = seed_channel(&pool, server, "beta", false, false).await;

    let a_alice = post(&pool, chan_a, alice, "widget alpha channel").await;
    let b_bob = post(&pool, chan_b, bob, "widget beta channel").await;
    let link_msg = post(&pool, chan_a, alice, "widget see https://example.com/page").await;
    let image_msg = post(
        &pool,
        chan_a,
        alice,
        "widget pic https://cdn.example.com/a.png",
    )
    .await;

    let sid = ServerId::new(server);
    let caller = UserId::new(alice);

    // from: — only alice's widget messages (excludes bob's).
    let from_alice = MessageSearchFilters {
        author_id: Some(UserId::new(alice)),
        ..filters()
    };
    let r = repo
        .search_in_server(&sid, &caller, "widget", &from_alice, None, 25)
        .await
        .unwrap();
    let got = ids(&r);
    assert!(got.contains(&a_alice) && got.contains(&link_msg) && got.contains(&image_msg));
    assert!(!got.contains(&b_bob), "from:alice excludes bob's message");

    // in: — restrict to channel B (only bob's message).
    let in_b = MessageSearchFilters {
        channel_id: Some(ChannelId::new(chan_b)),
        ..filters()
    };
    let r = repo
        .search_in_server(&sid, &caller, "widget", &in_b, None, 25)
        .await
        .unwrap();
    assert_eq!(
        ids(&r),
        HashSet::from([b_bob]),
        "in:#beta narrows to one channel"
    );

    // has:link — only URL-bearing messages.
    let has_link = MessageSearchFilters {
        has_link: true,
        ..filters()
    };
    let r = repo
        .search_in_server(&sid, &caller, "widget", &has_link, None, 25)
        .await
        .unwrap();
    let got = ids(&r);
    assert!(got.contains(&link_msg) && got.contains(&image_msg));
    assert!(
        !got.contains(&a_alice),
        "has:link drops the plain-text message"
    );

    // has:image — only image-URL messages.
    let has_image = MessageSearchFilters {
        has_image: true,
        ..filters()
    };
    let r = repo
        .search_in_server(&sid, &caller, "widget", &has_image, None, 25)
        .await
        .unwrap();
    assert_eq!(
        ids(&r),
        HashSet::from([image_msg]),
        "has:image matches only the .png url"
    );

    // from: + in: compose (alice in channel A).
    let from_in = MessageSearchFilters {
        channel_id: Some(ChannelId::new(chan_a)),
        author_id: Some(UserId::new(alice)),
        ..filters()
    };
    let r = repo
        .search_in_server(&sid, &caller, "widget", &from_in, None, 25)
        .await
        .unwrap();
    let got = ids(&r);
    assert!(got.contains(&a_alice) && !got.contains(&b_bob));

    cleanup(&pool, &[server], &[alice, bob]).await;
}

// ── Soft-delete exclusion ─────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn soft_deleted_messages_are_excluded() {
    let pool = test_pool().await;
    let repo = PgMessageRepository::new(pool.clone());

    let owner = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    add_member(&pool, server, owner, "owner").await;
    let channel = seed_channel(&pool, server, "general", false, false).await;

    let msg = post(&pool, channel, owner, "ephemeral note").await;
    let sid = ServerId::new(server);
    let uid = UserId::new(owner);

    let r = repo
        .search_in_server(&sid, &uid, "ephemeral", &filters(), None, 25)
        .await
        .unwrap();
    assert!(ids(&r).contains(&msg), "present before delete");

    soft_delete(&pool, msg, owner).await;
    let r = repo
        .search_in_server(&sid, &uid, "ephemeral", &filters(), None, 25)
        .await
        .unwrap();
    assert!(r.is_empty(), "soft-deleted message disappears from search");

    cleanup(&pool, &[server], &[owner]).await;
}

// ── Left / deleted author still returned ──────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn message_from_a_user_who_left_is_still_returned() {
    let pool = test_pool().await;
    let repo = PgMessageRepository::new(pool.clone());

    let owner = seed_user(&pool).await;
    let left = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    add_member(&pool, server, owner, "owner").await;
    add_member(&pool, server, left, "member").await;
    let channel = seed_channel(&pool, server, "general", false, false).await;

    let msg = post(&pool, channel, left, "orphan message body").await;
    // The author leaves the server (row removed) — their message remains.
    sqlx::query("DELETE FROM server_members WHERE server_id = $1 AND user_id = $2")
        .bind(server)
        .bind(left)
        .execute(&pool)
        .await
        .unwrap();

    let sid = ServerId::new(server);
    let uid = UserId::new(owner);

    let r = repo
        .search_in_server(&sid, &uid, "orphan", &filters(), None, 25)
        .await
        .unwrap();
    assert!(
        ids(&r).contains(&msg),
        "a left member's message still matches"
    );

    // `from:` by the departed user's id still resolves (marker is an ID).
    let from_left = MessageSearchFilters {
        author_id: Some(UserId::new(left)),
        ..filters()
    };
    let r = repo
        .search_in_server(&sid, &uid, "orphan", &from_left, None, 25)
        .await
        .unwrap();
    assert_eq!(ids(&r), HashSet::from([msg]));

    cleanup(&pool, &[server], &[owner, left]).await;
}

// ── Keyset pagination ─────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn keyset_pagination_pages_without_gap_or_overlap() {
    let pool = test_pool().await;
    let repo = PgMessageRepository::new(pool.clone());

    let owner = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    add_member(&pool, server, owner, "owner").await;
    let channel = seed_channel(&pool, server, "general", false, false).await;

    // 26 distinct, strictly-ordered matches (created_at spaced 1s apart).
    let base = Utc::now() - Duration::seconds(60);
    let mut all: Vec<Uuid> = Vec::new();
    for i in 0..26 {
        let id = post_at(
            &pool,
            channel,
            owner,
            "paginate token",
            base + Duration::seconds(i),
        )
        .await;
        all.push(id);
    }
    // Newest-first expected order is the reverse of insertion order.
    all.reverse();

    let sid = ServerId::new(server);
    let uid = UserId::new(owner);

    let page1 = repo
        .search_in_server(&sid, &uid, "paginate", &filters(), None, 25)
        .await
        .unwrap();
    assert_eq!(page1.len(), 25, "first page fills the limit");
    let page1_ids: Vec<Uuid> = page1.iter().map(|m| m.message.id.0).collect();
    assert_eq!(page1_ids, all[..25].to_vec(), "newest 25 in order");

    // Cursor = the 25th (oldest returned) row's created_at.
    let cursor = page1.last().unwrap().message.created_at;
    let page2 = repo
        .search_in_server(&sid, &uid, "paginate", &filters(), Some(cursor), 25)
        .await
        .unwrap();
    assert_eq!(page2.len(), 1, "second page holds the 26th match");
    assert_eq!(page2[0].message.id.0, all[25], "no gap, no overlap");

    cleanup(&pool, &[server], &[owner]).await;
}

// ── Cross-server injection ────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn cross_server_channel_and_author_do_not_leak() {
    let pool = test_pool().await;
    let repo = PgMessageRepository::new(pool.clone());

    let owner_a = seed_user(&pool).await;
    let owner_b = seed_user(&pool).await;
    let server_a = seed_server(&pool, owner_a).await;
    let server_b = seed_server(&pool, owner_b).await;
    add_member(&pool, server_a, owner_a, "owner").await;
    add_member(&pool, server_b, owner_b, "owner").await;

    let chan_a = seed_channel(&pool, server_a, "a-general", false, false).await;
    let chan_b = seed_channel(&pool, server_b, "b-general", false, false).await;
    post(&pool, chan_a, owner_a, "shared keyword here").await;
    post(&pool, chan_b, owner_b, "shared keyword there").await;

    let sid_a = ServerId::new(server_a);
    let caller = UserId::new(owner_a);

    // A foreign channel id (server B) as the `in:` filter → zero rows (the
    // `c.server_id = $1` scope excludes it — the service layer 403s first).
    let foreign_channel = MessageSearchFilters {
        channel_id: Some(ChannelId::new(chan_b)),
        ..filters()
    };
    let r = repo
        .search_in_server(&sid_a, &caller, "shared", &foreign_channel, None, 25)
        .await
        .unwrap();
    assert!(r.is_empty(), "a channel from another server yields nothing");

    // A foreign author id → zero rows (scoped by c.server_id).
    let foreign_author = MessageSearchFilters {
        author_id: Some(UserId::new(owner_b)),
        ..filters()
    };
    let r = repo
        .search_in_server(&sid_a, &caller, "shared", &foreign_author, None, 25)
        .await
        .unwrap();
    assert!(r.is_empty(), "an author from another server yields nothing");

    cleanup(&pool, &[server_a, server_b], &[owner_a, owner_b]).await;
}

// ── Service access gates (§7.2 — the gates the repo does NOT have) ────────
//
// These exercise `MessageService::search_messages`, not the repo. The repo's
// SQL short-circuits to TRUE on `c.is_private = false` regardless of membership
// (see `search_in_server`: `c.is_private = false OR EXISTS(...)`) — so a
// PUBLIC-channel match leaks to anyone at the repo level. The service is the
// SOLE gate stopping that: the `is_member` check, and the explicit-channel
// `ensure_channel_access` / cross-server 403. Delete either and the repo tests
// above still pass; these fail. Spec §7.2 (non-member -> 403, cross-server
// injection -> 403) + §7.4 scenarios 7-8.

/// A non-member of the server gets `Forbidden` even when a matching message
/// exists in a PUBLIC channel — proving the `is_member` gate is load-bearing.
/// The same query hits the repo directly to show the row DOES leak without the
/// service (the gate is not redundant with the SQL).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn service_non_member_is_forbidden_even_for_public_channel() {
    let pool = test_pool().await;
    let repo = PgMessageRepository::new(pool.clone());
    let service = build_service(&pool);

    let owner = seed_user(&pool).await;
    let outsider = seed_user(&pool).await; // NOT added to the server
    let server = seed_server(&pool, owner).await;
    add_member(&pool, server, owner, "owner").await;
    let public = seed_channel(&pool, server, "general", false, false).await;
    let msg = post(&pool, public, owner, "public treasure map").await;

    let sid = ServerId::new(server);
    let outsider_uid = UserId::new(outsider);

    // Repo (no gate): the public-channel row IS returned to the outsider.
    let raw = repo
        .search_in_server(&sid, &outsider_uid, "treasure", &filters(), None, 25)
        .await
        .unwrap();
    assert!(
        ids(&raw).contains(&msg),
        "repo has no membership gate — public-channel row leaks (this is why the service gate exists)"
    );

    // Service (gated): the non-member is refused before any row is read.
    let err = service
        .search_messages(&sid, &outsider_uid, "treasure", filters(), None, 25)
        .await
        .expect_err("non-member must be Forbidden");
    assert!(
        matches!(err, DomainError::Forbidden(_)),
        "expected Forbidden, got {err:?}"
    );

    cleanup(&pool, &[server], &[owner, outsider]).await;
}

/// An explicit `in:#channel` on a PRIVATE channel the caller cannot access is a
/// clean `Forbidden` (not empty results) — the service's `ensure_channel_access`
/// on the explicit filter.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn service_explicit_private_channel_without_access_is_forbidden() {
    let pool = test_pool().await;
    let service = build_service(&pool);

    let owner = seed_user(&pool).await;
    let member = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    add_member(&pool, server, owner, "owner").await;
    add_member(&pool, server, member, "member").await;
    let private = seed_channel(&pool, server, "secret-room", true, false).await;
    post(&pool, private, owner, "classified treasure").await;

    let sid = ServerId::new(server);
    let member_uid = UserId::new(member);
    let in_private = MessageSearchFilters {
        channel_id: Some(ChannelId::new(private)),
        ..filters()
    };

    let err = service
        .search_messages(&sid, &member_uid, "treasure", in_private, None, 25)
        .await
        .expect_err("explicit in:#private without a grant must be Forbidden");
    assert!(
        matches!(err, DomainError::Forbidden(_)),
        "expected Forbidden, got {err:?}"
    );

    cleanup(&pool, &[server], &[owner, member]).await;
}

/// An explicit `in:#channel` whose channel belongs to ANOTHER server is a
/// `Forbidden` (no 404 existence oracle) — the service validates the channel's
/// `server_id` before any search runs.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn service_explicit_cross_server_channel_is_forbidden() {
    let pool = test_pool().await;
    let service = build_service(&pool);

    let owner_a = seed_user(&pool).await;
    let owner_b = seed_user(&pool).await;
    let server_a = seed_server(&pool, owner_a).await;
    let server_b = seed_server(&pool, owner_b).await;
    add_member(&pool, server_a, owner_a, "owner").await;
    add_member(&pool, server_b, owner_b, "owner").await;
    let chan_b = seed_channel(&pool, server_b, "b-general", false, false).await;
    post(&pool, chan_b, owner_b, "shared keyword there").await;

    let sid_a = ServerId::new(server_a);
    let caller = UserId::new(owner_a); // member of A, injecting B's channel id
    let foreign_channel = MessageSearchFilters {
        channel_id: Some(ChannelId::new(chan_b)),
        ..filters()
    };

    let err = service
        .search_messages(&sid_a, &caller, "shared", foreign_channel, None, 25)
        .await
        .expect_err("a channel id from another server must be Forbidden");
    assert!(
        matches!(err, DomainError::Forbidden(_)),
        "expected Forbidden, got {err:?}"
    );

    cleanup(&pool, &[server_a, server_b], &[owner_a, owner_b]).await;
}
