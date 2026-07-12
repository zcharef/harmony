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
//! Also covers FTS basics, the hybrid fuzzy/relevance behaviour (partial words,
//! case, typos, best-match-first ranking), encrypted exclusion, the
//! `from:`/`in:`/`has:` filters, soft-delete, left-author resolution, composite
//! relevance-keyset pagination, and cross-server injection.
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
use harmony_api::domain::models::{ChannelId, MessageWithAuthor, ServerId, UserId};
use harmony_api::domain::ports::{MessageRepository, MessageSearchFilters};
use harmony_api::domain::services::{ContentFilter, MessageService, SpamGuard};
use harmony_api::infra::postgres::{
    PgAttachmentRepository, PgChannelRepository, PgEmbedRepository, PgFriendshipRepository,
    PgMemberRepository, PgMessageRepository, PgPlanLimitChecker, PgReactionRepository,
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
fn ids(rows: &[MessageWithAuthor]) -> HashSet<Uuid> {
    rows.iter().map(|m| m.message.id.0).collect()
}

/// Run a search (first page, default limit) and return just the message vec —
/// the common shape for the non-pagination assertions. Pagination tests call
/// `search_in_server` directly to reach the opaque `next_cursor`.
async fn search(
    repo: &PgMessageRepository,
    sid: &ServerId,
    uid: &UserId,
    q: &str,
    f: &MessageSearchFilters,
) -> Vec<MessageWithAuthor> {
    repo.search_in_server(sid, uid, q, f, None, 25)
        .await
        .unwrap()
        .messages
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
        Arc::new(PgPlanLimitChecker::new(
            pool.clone(),
            std::sync::Arc::new(harmony_api::infra::postgres::PgAnalyticsRecorder::new(
                pool.clone(),
            )),
        )),
        Arc::new(PgReactionRepository::new(pool.clone())),
        Arc::new(PgAttachmentRepository::new(pool.clone())),
        Arc::new(PgEmbedRepository::new(pool.clone())),
        Arc::new(ContentFilter::new()),
        Arc::new(SpamGuard::with_enabled(false)),
        Arc::new(PgFriendshipRepository::new(pool.clone())),
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
    let r = search(&repo, &sid, &uid, "hello", &filters()).await;
    assert_eq!(ids(&r), HashSet::from([hello]));

    // `world` matches both. Scores tie (both an exact word hit), so the
    // created_at DESC tiebreak keeps the newest (goodbye) first.
    let r = search(&repo, &sid, &uid, "world", &filters()).await;
    assert_eq!(ids(&r), HashSet::from([hello, goodbye]));
    assert_eq!(
        r.first().unwrap().message.id.0,
        goodbye,
        "score tie → newest first"
    );

    // Stopword-only query → empty tsquery, and 'the' is not trigram-similar to
    // either body → zero rows (not an error).
    let r = search(&repo, &sid, &uid, "the", &filters()).await;
    assert!(r.is_empty(), "stopword-only query returns nothing");

    cleanup(&pool, &[server], &[owner]).await;
}

// ── Fuzzy / partial / typo recall + relevance ranking (E6 core) ───────────

/// Partial word that FTS misses (`pipel` does not stem to `pipeline`) is caught
/// by the trigram branch. This is the "not practical" gap the epic closes.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn partial_word_matches_via_trigram() {
    let pool = test_pool().await;
    let repo = PgMessageRepository::new(pool.clone());

    let owner = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    add_member(&pool, server, owner, "owner").await;
    let channel = seed_channel(&pool, server, "general", false, false).await;

    let msg = post(&pool, channel, owner, "deployment pipeline notes").await;
    let sid = ServerId::new(server);
    let uid = UserId::new(owner);

    // `pipel` is a substring of `pipeline` but NOT its stem — FTS returns
    // nothing today; the trigram `<%` branch surfaces it.
    let r = search(&repo, &sid, &uid, "pipel", &filters()).await;
    assert!(
        ids(&r).contains(&msg),
        "partial word matches via trigram fuzzy branch"
    );

    cleanup(&pool, &[server], &[owner]).await;
}

/// Case-mismatched query still matches (FTS lowercases). Explicit regression
/// assertion so a future refactor can't silently reintroduce case-sensitivity.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn case_mismatched_query_matches() {
    let pool = test_pool().await;
    let repo = PgMessageRepository::new(pool.clone());

    let owner = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    add_member(&pool, server, owner, "owner").await;
    let channel = seed_channel(&pool, server, "general", false, false).await;

    let msg = post(&pool, channel, owner, "deployment guide").await;
    let sid = ServerId::new(server);
    let uid = UserId::new(owner);

    let r = search(&repo, &sid, &uid, "DEPLOY", &filters()).await;
    assert_eq!(
        ids(&r),
        HashSet::from([msg]),
        "uppercase query matches lowercase content"
    );

    cleanup(&pool, &[server], &[owner]).await;
}

/// A misspelled query returns the intended message via trigram similarity.
/// This flatly fails on FTS-only search today.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn misspelled_query_matches_via_trigram() {
    let pool = test_pool().await;
    let repo = PgMessageRepository::new(pool.clone());

    let owner = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    add_member(&pool, server, owner, "owner").await;
    let channel = seed_channel(&pool, server, "general", false, false).await;

    let msg = post(&pool, channel, owner, "deployment").await;
    let sid = ServerId::new(server);
    let uid = UserId::new(owner);

    // `deploymnet` (e/n transposed) never matches FTS but is well within the
    // trigram threshold.
    let r = search(&repo, &sid, &uid, "deploymnet", &filters()).await;
    assert!(
        ids(&r).contains(&msg),
        "typo query surfaces the intended message"
    );

    cleanup(&pool, &[server], &[owner]).await;
}

/// The core behavioural assertion: a STRONG match posted EARLIER ranks ahead of
/// a WEAK match posted LATER — proving results are best-first, not newest-first.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn relevance_ranks_best_match_first_not_newest() {
    let pool = test_pool().await;
    let repo = PgMessageRepository::new(pool.clone());

    let owner = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    add_member(&pool, server, owner, "owner").await;
    let channel = seed_channel(&pool, server, "general", false, false).await;

    let now = Utc::now();
    // Strong match (exact repeated term → high ts_rank_cd + word_similarity 1.0),
    // posted 10 minutes AGO.
    let strong = post_at(
        &pool,
        channel,
        owner,
        "deployment deployment deployment",
        now - Duration::minutes(10),
    )
    .await;
    // Weak match (typo → trigram-only, lower score), posted just NOW.
    let weak = post_at(&pool, channel, owner, "deploymnet", now).await;

    let sid = ServerId::new(server);
    let uid = UserId::new(owner);

    let r = search(&repo, &sid, &uid, "deployment", &filters()).await;
    let got = ids(&r);
    assert!(
        got.contains(&strong) && got.contains(&weak),
        "both the strong and the weak match are recalled"
    );
    assert_eq!(
        r.first().unwrap().message.id.0,
        strong,
        "the stronger (older) match ranks first — relevance, not recency"
    );

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
    let r = search(&repo, &sid, &member_uid, "treasure", &filters()).await;
    assert!(
        !ids(&r).contains(&msg),
        "member without grant must NOT see a private-channel match"
    );

    // Admin: the same match is PRESENT (role bypass).
    let r = search(&repo, &sid, &admin_uid, "treasure", &filters()).await;
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
    let r = search(&repo, &sid, &member_uid, "treasure", &member_in_private).await;
    assert!(
        r.is_empty(),
        "member's explicit in:#private returns no rows"
    );

    // After granting the member's role, the match appears.
    grant_channel_role(&pool, private, "member").await;
    let r = search(&repo, &sid, &member_uid, "treasure", &filters()).await;
    assert!(
        ids(&r).contains(&msg),
        "member WITH channel_role_access grant sees the match"
    );

    cleanup(&pool, &[server], &[owner, member, admin]).await;
}

/// The fuzzy/partial OR branch must not widen visibility: a private-channel row
/// a non-member cannot see stays absent even on a fuzzy (trigram) hit.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn fuzzy_branch_does_not_widen_access() {
    let pool = test_pool().await;
    let repo = PgMessageRepository::new(pool.clone());

    let owner = seed_user(&pool).await;
    let member = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    add_member(&pool, server, owner, "owner").await;
    add_member(&pool, server, member, "member").await;

    let private = seed_channel(&pool, server, "secret-room", true, false).await;
    let msg = post(&pool, private, owner, "deployment").await;

    let sid = ServerId::new(server);
    let member_uid = UserId::new(member);

    // A typo query hits `msg` ONLY through the trigram branch. The access
    // predicate must still exclude it for the ungranted member.
    let r = search(&repo, &sid, &member_uid, "deploymnet", &filters()).await;
    assert!(
        !ids(&r).contains(&msg),
        "trigram OR branch must not bypass the private-channel access gate"
    );

    cleanup(&pool, &[server], &[owner, member]).await;
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

    // Exact FTS query: excluded.
    let r = search(&repo, &sid, &uid, "secretword", &filters()).await;
    assert!(
        r.is_empty(),
        "encrypted channel + encrypted message excluded (FTS)"
    );

    // Fuzzy/typo query hits the trigram branch, which reads raw `content`
    // (ciphertext for the encrypted row). The `m.encrypted = false` predicate +
    // the partial index still keep it out.
    let r = search(&repo, &sid, &uid, "secretwrod", &filters()).await;
    assert!(
        r.is_empty(),
        "encrypted rows excluded on the trigram branch too"
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
    let r = search(&repo, &sid, &caller, "widget", &from_alice).await;
    let got = ids(&r);
    assert!(got.contains(&a_alice) && got.contains(&link_msg) && got.contains(&image_msg));
    assert!(!got.contains(&b_bob), "from:alice excludes bob's message");

    // in: — restrict to channel B (only bob's message).
    let in_b = MessageSearchFilters {
        channel_id: Some(ChannelId::new(chan_b)),
        ..filters()
    };
    let r = search(&repo, &sid, &caller, "widget", &in_b).await;
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
    let r = search(&repo, &sid, &caller, "widget", &has_link).await;
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
    let r = search(&repo, &sid, &caller, "widget", &has_image).await;
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
    let r = search(&repo, &sid, &caller, "widget", &from_in).await;
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

    let r = search(&repo, &sid, &uid, "ephemeral", &filters()).await;
    assert!(ids(&r).contains(&msg), "present before delete");

    soft_delete(&pool, msg, owner).await;
    let r = search(&repo, &sid, &uid, "ephemeral", &filters()).await;
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

    let r = search(&repo, &sid, &uid, "orphan", &filters()).await;
    assert!(
        ids(&r).contains(&msg),
        "a left member's message still matches"
    );

    // `from:` by the departed user's id still resolves (marker is an ID).
    let from_left = MessageSearchFilters {
        author_id: Some(UserId::new(left)),
        ..filters()
    };
    let r = search(&repo, &sid, &uid, "orphan", &from_left).await;
    assert_eq!(ids(&r), HashSet::from([msg]));

    cleanup(&pool, &[server], &[owner, left]).await;
}

// ── Composite relevance-keyset pagination ─────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn keyset_pagination_pages_without_gap_or_overlap() {
    let pool = test_pool().await;
    let repo = PgMessageRepository::new(pool.clone());

    let owner = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    add_member(&pool, server, owner, "owner").await;
    let channel = seed_channel(&pool, server, "general", false, false).await;

    // 26 identical-content matches (identical relevance score) with strictly
    // ordered created_at → ties are broken by the (created_at, id) suffix, so
    // the composite cursor must walk them without gap or overlap.
    let base = Utc::now() - Duration::seconds(60);
    let mut all: HashSet<Uuid> = HashSet::new();
    for i in 0..26 {
        let id = post_at(
            &pool,
            channel,
            owner,
            "paginate token",
            base + Duration::seconds(i),
        )
        .await;
        all.insert(id);
    }

    let sid = ServerId::new(server);
    let uid = UserId::new(owner);

    let page1 = repo
        .search_in_server(&sid, &uid, "paginate", &filters(), None, 25)
        .await
        .unwrap();
    assert_eq!(page1.messages.len(), 25, "first page fills the limit");
    let cursor = page1.next_cursor.expect("a full page yields a next cursor");

    let page2 = repo
        .search_in_server(&sid, &uid, "paginate", &filters(), Some(cursor), 25)
        .await
        .unwrap();
    assert_eq!(page2.messages.len(), 1, "second page holds the 26th match");
    assert!(
        page2.next_cursor.is_none(),
        "a short final page yields no next cursor"
    );

    // No gap, no overlap: the two pages together are exactly the 26 matches,
    // with no id appearing twice.
    let page1_ids = ids(&page1.messages);
    let page2_ids = ids(&page2.messages);
    assert!(
        page1_ids.is_disjoint(&page2_ids),
        "no id appears on both pages"
    );
    let union: HashSet<Uuid> = page1_ids.union(&page2_ids).copied().collect();
    assert_eq!(union, all, "the two pages cover every match exactly once");

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
    let r = search(&repo, &sid_a, &caller, "shared", &foreign_channel).await;
    assert!(r.is_empty(), "a channel from another server yields nothing");

    // A foreign author id → zero rows (scoped by c.server_id).
    let foreign_author = MessageSearchFilters {
        author_id: Some(UserId::new(owner_b)),
        ..filters()
    };
    let r = search(&repo, &sid_a, &caller, "shared", &foreign_author).await;
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
    let raw = search(&repo, &sid, &outsider_uid, "treasure", &filters()).await;
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
