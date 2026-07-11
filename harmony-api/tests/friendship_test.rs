#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Friendship + block integration tests (real DB).
//!
//! Exercises `PgFriendshipRepository` end to end: the request state machine,
//! mutual auto-accept (incl. the advisory-lock concurrency guard), decline /
//! cancel / unfriend, block teardown + gates, list ordering, and caps (§7.2).
//!
//! WHY `#[ignore]`: requires a running Postgres with the Harmony schema (mirrors
//! `dm_concurrency_test`). Run locally with:
//!   `DATABASE_URL=... cargo test --test friendship_test -- --ignored`

use std::sync::Arc;

use sqlx::PgPool;
use uuid::Uuid;

use harmony_api::domain::errors::DomainError;
use harmony_api::domain::models::friendship::{
    BlockOutcome, FriendshipStatus, RequestDirection, RequestOutcome,
};
use harmony_api::domain::models::{ChannelId, UserId};
use harmony_api::domain::ports::{DmRepository, FriendshipRepository, PlanLimitChecker};
use harmony_api::domain::services::SpamGuard;
use harmony_api::domain::services::dm_service::DmService;
use harmony_api::domain::services::friendship_service::{
    FriendshipService, MAX_BLOCKS, MAX_FRIENDS, MAX_OUTGOING_PENDING, RequestTarget,
};
use harmony_api::infra::AlwaysAllowedChecker;
use harmony_api::infra::postgres::{
    PgDmRepository, PgFriendshipRepository, PgMemberRepository, PgProfileRepository,
    PgServerRepository,
};

// ── DB pool + seeding (mirrors dm_concurrency_test) ─────────────────────

async fn test_pool() -> PgPool {
    dotenvy::dotenv().ok();
    let url =
        std::env::var("DATABASE_URL").expect("DATABASE_URL must be set for integration tests");
    PgPool::connect(&url)
        .await
        .expect("Failed to connect to test database")
}

async fn seed_user(pool: &PgPool) -> UserId {
    let uid = Uuid::new_v4();
    sqlx::query(
        r#"
        INSERT INTO auth.users (id, instance_id, role, aud, email, encrypted_password, email_confirmed_at, created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change)
        VALUES ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '', now(), now(), now(), '', '', '', '')
        ON CONFLICT (id) DO NOTHING
        "#,
    )
    .bind(uid)
    .bind(format!("friend-{uid}@example.com"))
    .execute(pool)
    .await
    .expect("seed auth.users");

    let username = format!("fr{}", &uid.simple().to_string()[..10]);
    sqlx::query(
        r#"INSERT INTO profiles (id, username, display_name)
           VALUES ($1, $2, 'Friend Tester')
           ON CONFLICT (id) DO NOTHING"#,
    )
    .bind(uid)
    .bind(username)
    .execute(pool)
    .await
    .expect("seed profiles");

    UserId::new(uid)
}

fn repo(pool: &PgPool) -> PgFriendshipRepository {
    PgFriendshipRepository::new(pool.clone())
}

// ── State machine: request → accept ─────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn request_then_accept_makes_friends() {
    let pool = test_pool().await;
    let r = repo(&pool);
    let a = seed_user(&pool).await;
    let b = seed_user(&pool).await;

    assert_eq!(
        r.create_request(&a, &b).await.unwrap(),
        RequestOutcome::Requested
    );
    // Idempotent re-POST same direction → AlreadyRequested, no duplicate row.
    assert_eq!(
        r.create_request(&a, &b).await.unwrap(),
        RequestOutcome::AlreadyRequested
    );

    // b accepts a's request.
    let friendship = r.accept_request(&b, &a).await.unwrap();
    assert_eq!(friendship.status, FriendshipStatus::Accepted);
    // friends_since maps to updated_at (accept time), strictly after created_at.
    assert!(friendship.updated_at >= friendship.created_at);

    assert!(r.are_friends(&a, &b).await.unwrap());
    assert!(r.are_friends(&b, &a).await.unwrap());

    // Both list endpoints show the friendship, friends_since == updated_at.
    let a_friends = r.list_friends(&a).await.unwrap();
    assert_eq!(a_friends.len(), 1);
    assert_eq!(a_friends[0].user_id, b);
    assert_eq!(a_friends[0].friends_since, friendship.updated_at);
    assert_eq!(r.list_friends(&b).await.unwrap().len(), 1);

    // Re-POST after accepted → AlreadyFriends.
    assert_eq!(
        r.create_request(&a, &b).await.unwrap(),
        RequestOutcome::AlreadyFriends
    );
}

// ── Mutual auto-accept ──────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn mutual_requests_auto_accept() {
    let pool = test_pool().await;
    let r = repo(&pool);
    let a = seed_user(&pool).await;
    let b = seed_user(&pool).await;

    assert_eq!(
        r.create_request(&a, &b).await.unwrap(),
        RequestOutcome::Requested
    );
    // b sends the reverse request → auto-accept (flips existing row, no 2nd row).
    assert_eq!(
        r.create_request(&b, &a).await.unwrap(),
        RequestOutcome::AutoAccepted
    );
    assert!(r.are_friends(&a, &b).await.unwrap());
    assert_eq!(r.count_friends(&a).await.unwrap(), 1);
}

/// Two concurrent mutual requests must resolve to exactly ONE accepted row —
/// the advisory-lock guard (modeled on `dm_concurrency_test`).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn concurrent_mutual_requests_yield_one_accepted_row() {
    let pool = test_pool().await;
    let a = seed_user(&pool).await;
    let b = seed_user(&pool).await;

    let r1 = repo(&pool);
    let r2 = repo(&pool);
    let (a1, b1, a2, b2) = (a.clone(), b.clone(), a.clone(), b.clone());
    let t1 = tokio::spawn(async move { r1.create_request(&a1, &b1).await });
    let t2 = tokio::spawn(async move { r2.create_request(&b2, &a2).await });
    let _ = t1.await.unwrap();
    let _ = t2.await.unwrap();

    // Exactly one row for the pair, and it is accepted.
    let count: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*)::bigint FROM friendships
           WHERE (requester_id = $1 AND addressee_id = $2)
              OR (requester_id = $2 AND addressee_id = $1)"#,
    )
    .bind(a.0)
    .bind(b.0)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, 1, "exactly one friendship row per pair");
    assert!(repo(&pool).are_friends(&a, &b).await.unwrap());
}

/// `create_block` must serialize against `create_request` on the SAME canonical
/// pair advisory lock, otherwise a block and a concurrent new request are not
/// ordered and a pending row can outlive the block (the request's block-check
/// reads "no block", the uncontended block tears down nothing, then the request
/// inserts). The narrow interleaving is not reliably reproducible through the
/// public API without injected delays, so this proves the guarantee directly:
/// while the pair lock is held elsewhere, `create_block` must WAIT for it. With
/// the lock removed from `create_block`, it would return immediately and this
/// test's `is_finished()` assertion fails.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn create_block_waits_on_the_pair_advisory_lock() {
    let pool = test_pool().await;
    let a = seed_user(&pool).await;
    let b = seed_user(&pool).await;

    // Canonical pair key, computed exactly like the repo's `pair_key`.
    let (low, high) = if a.0 <= b.0 { (a.0, b.0) } else { (b.0, a.0) };
    let key = format!("{low}:{high}");

    // Hold the pair lock on a dedicated transaction — stands in for an in-flight
    // `create_request` that grabbed it first.
    let mut holder = pool.begin().await.unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(&key)
        .execute(&mut *holder)
        .await
        .unwrap();

    let r = repo(&pool);
    let (blocker, blocked) = (b.clone(), a.clone());
    let handle = tokio::spawn(async move { r.create_block(&blocker, &blocked).await });

    // While the lock is held, create_block cannot make progress.
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    assert!(
        !handle.is_finished(),
        "create_block must block on the pair lock, not run uncontended"
    );

    // Release the lock → create_block proceeds and commits the block.
    holder.commit().await.unwrap();
    let outcome = handle.await.unwrap().unwrap();
    assert_eq!(outcome, BlockOutcome::Blocked);
    assert!(repo(&pool).is_blocked_between(&a, &b).await.unwrap());
}

// ── Decline / cancel / unfriend ─────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn decline_cancel_unfriend_and_idempotent_deletes() {
    let pool = test_pool().await;
    let r = repo(&pool);
    let a = seed_user(&pool).await;
    let b = seed_user(&pool).await;

    // Decline (addressee removes incoming).
    r.create_request(&a, &b).await.unwrap();
    assert!(r.delete_request(&b, &a).await.unwrap());
    assert!(
        !r.delete_request(&b, &a).await.unwrap(),
        "second delete no-op"
    );

    // Cancel (requester removes outgoing).
    r.create_request(&a, &b).await.unwrap();
    assert!(r.delete_request(&a, &b).await.unwrap());

    // Unfriend is idempotent.
    r.create_request(&a, &b).await.unwrap();
    r.accept_request(&b, &a).await.unwrap();
    assert!(r.delete_friendship(&a, &b).await.unwrap());
    assert!(
        !r.delete_friendship(&a, &b).await.unwrap(),
        "repeat unfriend no-op"
    );
    // Declined/unfriended can be re-requested.
    assert_eq!(
        r.create_request(&a, &b).await.unwrap(),
        RequestOutcome::Requested
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn accept_without_pending_is_not_found() {
    let pool = test_pool().await;
    let r = repo(&pool);
    let a = seed_user(&pool).await;
    let b = seed_user(&pool).await;
    // No pending request exists → NotFound.
    assert!(r.accept_request(&b, &a).await.is_err());
}

// ── Blocks ──────────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn block_tears_down_and_gates_then_unblock_restores() {
    let pool = test_pool().await;
    let r = repo(&pool);
    let a = seed_user(&pool).await;
    let b = seed_user(&pool).await;

    // Block a friendship → deletes it, reports BlockedWasFriends.
    r.create_request(&a, &b).await.unwrap();
    r.accept_request(&b, &a).await.unwrap();
    assert_eq!(
        r.create_block(&a, &b).await.unwrap(),
        BlockOutcome::BlockedWasFriends
    );
    assert!(!r.are_friends(&a, &b).await.unwrap(), "friendship gone");
    assert!(r.is_blocked_between(&a, &b).await.unwrap());
    assert!(
        r.is_blocked_between(&b, &a).await.unwrap(),
        "either direction"
    );

    // Request after block → Forbidden, both directions.
    assert!(r.create_request(&a, &b).await.is_err());
    assert!(r.create_request(&b, &a).await.is_err());

    // Idempotent re-block.
    assert_eq!(
        r.create_block(&a, &b).await.unwrap(),
        BlockOutcome::AlreadyBlocked
    );

    // Unblock → request works again. Unblocking does not restore friendship.
    assert!(r.delete_block(&a, &b).await.unwrap());
    assert!(!r.is_blocked_between(&a, &b).await.unwrap());
    assert_eq!(
        r.create_request(&a, &b).await.unwrap(),
        RequestOutcome::Requested
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn block_pending_reports_was_pending() {
    let pool = test_pool().await;
    let r = repo(&pool);
    let a = seed_user(&pool).await;
    let b = seed_user(&pool).await;
    r.create_request(&a, &b).await.unwrap();
    assert_eq!(
        r.create_block(&a, &b).await.unwrap(),
        BlockOutcome::BlockedWasPending
    );
}

// ── List contracts ──────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn lists_are_ordered_and_bounded() {
    let pool = test_pool().await;
    let r = repo(&pool);
    let me = seed_user(&pool).await;

    // Three incoming requests, in order.
    let mut senders = Vec::new();
    for _ in 0..3 {
        let other = seed_user(&pool).await;
        r.create_request(&other, &me).await.unwrap();
        senders.push(other);
    }
    let incoming = r
        .list_requests(&me, RequestDirection::Incoming)
        .await
        .unwrap();
    assert_eq!(incoming.len(), 3);
    assert!(
        incoming
            .iter()
            .all(|x| x.direction == RequestDirection::Incoming)
    );
    // Newest first (created_at DESC): the last sender appears first.
    assert_eq!(incoming[0].user_id, *senders.last().unwrap());

    let outgoing = r
        .list_requests(&me, RequestDirection::Outgoing)
        .await
        .unwrap();
    assert!(outgoing.is_empty());
}

// ── DM gate helpers ─────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn share_non_dm_server_detects_overlap() {
    let pool = test_pool().await;
    let r = repo(&pool);
    let a = seed_user(&pool).await;
    let b = seed_user(&pool).await;

    // Strangers: no shared non-DM server, not friends.
    assert!(!r.share_non_dm_server(&a, &b).await.unwrap());

    // Put both in a non-DM server.
    let server_id = Uuid::new_v4();
    sqlx::query(
        r#"INSERT INTO servers (id, name, owner_id, is_dm, is_public)
           VALUES ($1, 'shared', $2, false, false)"#,
    )
    .bind(server_id)
    .bind(a.0)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO server_members (server_id, user_id, role)
           VALUES ($1, $2, 'owner'), ($1, $3, 'member')"#,
    )
    .bind(server_id)
    .bind(a.0)
    .bind(b.0)
    .execute(&pool)
    .await
    .unwrap();

    assert!(r.share_non_dm_server(&a, &b).await.unwrap());
}

// ── Service wiring (real repos, no mocks per ADR-018) ───────────────────

fn friendship_service(pool: &PgPool) -> FriendshipService {
    FriendshipService::new(
        Arc::new(PgFriendshipRepository::new(pool.clone())),
        Arc::new(PgProfileRepository::new(pool.clone())),
        Arc::new(SpamGuard::new()),
    )
}

fn dm_service(pool: &PgPool) -> DmService {
    let plan: Arc<dyn PlanLimitChecker> = Arc::new(AlwaysAllowedChecker);
    DmService::new(
        Arc::new(PgDmRepository::new(pool.clone())),
        Arc::new(PgProfileRepository::new(pool.clone())),
        Arc::new(PgServerRepository::new(pool.clone())),
        Arc::new(PgMemberRepository::new(pool.clone())),
        plan,
        Arc::new(PgFriendshipRepository::new(pool.clone())),
    )
}

// ── Bulk seeding for the DB caps ────────────────────────────────────────
//
// The caps are 100 (outgoing pending), 1_000 (friends), 1_000 (blocks). Going
// through the service to reach them is impossible — SpamGuard throttles at
// 15/30 per hour — so the boundary is seeded directly, then ONE more operation
// is driven through the service to hit the cap branch. Counterpart ids are
// derived deterministically from (anchor, tag, index) so the relation insert
// references the same rows the user/profile insert created, without a round-trip.

async fn seed_counterparts(pool: &PgPool, anchor: Uuid, tag: &str, n: i64) {
    sqlx::query(
        r#"INSERT INTO auth.users (id, instance_id, role, aud, email, encrypted_password, email_confirmed_at, created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change)
           SELECT md5($1::text || $2 || g::text)::uuid,
                  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
                  'bulk-' || $2 || '-' || g || '-' || $1::text || '@example.com',
                  '', now(), now(), now(), '', '', '', ''
           FROM generate_series(1, $3) g
           ON CONFLICT (id) DO NOTHING"#,
    )
    .bind(anchor)
    .bind(tag)
    .bind(n)
    .execute(pool)
    .await
    .expect("seed counterpart auth.users");

    sqlx::query(
        r#"INSERT INTO profiles (id, username, display_name)
           SELECT md5($1::text || $2 || g::text)::uuid,
                  'b' || substr(md5($1::text || $2 || g::text), 1, 16),
                  'Bulk'
           FROM generate_series(1, $3) g
           ON CONFLICT (id) DO NOTHING"#,
    )
    .bind(anchor)
    .bind(tag)
    .bind(n)
    .execute(pool)
    .await
    .expect("seed counterpart profiles");
}

async fn fill_accepted_friends(pool: &PgPool, user: Uuid, n: i64) {
    seed_counterparts(pool, user, "fr", n).await;
    sqlx::query(
        r#"INSERT INTO friendships (requester_id, addressee_id, status)
           SELECT $1, md5($1::text || 'fr' || g::text)::uuid, 'accepted'
           FROM generate_series(1, $2) g
           ON CONFLICT DO NOTHING"#,
    )
    .bind(user)
    .bind(n)
    .execute(pool)
    .await
    .expect("fill accepted friends");
}

async fn fill_pending_outgoing(pool: &PgPool, user: Uuid, n: i64) {
    seed_counterparts(pool, user, "pg", n).await;
    sqlx::query(
        r#"INSERT INTO friendships (requester_id, addressee_id, status)
           SELECT $1, md5($1::text || 'pg' || g::text)::uuid, 'pending'
           FROM generate_series(1, $2) g
           ON CONFLICT DO NOTHING"#,
    )
    .bind(user)
    .bind(n)
    .execute(pool)
    .await
    .expect("fill pending outgoing");
}

async fn fill_blocks(pool: &PgPool, user: Uuid, n: i64) {
    seed_counterparts(pool, user, "bl", n).await;
    sqlx::query(
        r#"INSERT INTO user_blocks (blocker_id, blocked_id)
           SELECT $1, md5($1::text || 'bl' || g::text)::uuid
           FROM generate_series(1, $2) g
           ON CONFLICT DO NOTHING"#,
    )
    .bind(user)
    .bind(n)
    .execute(pool)
    .await
    .expect("fill blocks");
}

// ── Message-send block gate (dm_send_blocked multi-JOIN, §7.2) ───────────

/// The send gate fires for a block in EITHER direction, symmetrically, and the
/// DM stays intact (only sending is gated — history/E2EE untouched).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn dm_send_blocked_reflects_block_in_either_direction() {
    let pool = test_pool().await;
    let r = repo(&pool);
    let a = seed_user(&pool).await;
    let b = seed_user(&pool).await;

    let dm_repo = PgDmRepository::new(pool.clone());
    let (_server_id, channel) = dm_repo.create_dm(&a, &b).await.unwrap();

    // No block → both sides may send.
    assert!(!r.dm_send_blocked(&a, &channel).await.unwrap());
    assert!(!r.dm_send_blocked(&b, &channel).await.unwrap());

    // b blocks a → NEITHER side may send in this DM.
    r.create_block(&b, &a).await.unwrap();
    assert!(
        r.dm_send_blocked(&a, &channel).await.unwrap(),
        "the blocked user cannot send"
    );
    assert!(
        r.dm_send_blocked(&b, &channel).await.unwrap(),
        "the blocker cannot send either"
    );

    // Unblock restores sending (DM was never torn down).
    r.delete_block(&b, &a).await.unwrap();
    assert!(!r.dm_send_blocked(&a, &channel).await.unwrap());
    assert!(!r.dm_send_blocked(&b, &channel).await.unwrap());
}

/// The gate is a no-op outside DM channels: a normal server channel is never
/// blocked, even when the two members have a block between them.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn dm_send_blocked_is_false_in_non_dm_channel() {
    let pool = test_pool().await;
    let r = repo(&pool);
    let a = seed_user(&pool).await;
    let b = seed_user(&pool).await;

    let server_id = Uuid::new_v4();
    sqlx::query(
        r#"INSERT INTO servers (id, name, owner_id, is_dm, is_public)
           VALUES ($1, 'shared', $2, false, false)"#,
    )
    .bind(server_id)
    .bind(a.0)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO server_members (server_id, user_id, role)
           VALUES ($1, $2, 'owner'), ($1, $3, 'member')"#,
    )
    .bind(server_id)
    .bind(a.0)
    .bind(b.0)
    .execute(&pool)
    .await
    .unwrap();
    let channel_id = Uuid::new_v4();
    sqlx::query(r#"INSERT INTO channels (id, server_id, name) VALUES ($1, $2, 'general')"#)
        .bind(channel_id)
        .bind(server_id)
        .execute(&pool)
        .await
        .unwrap();

    r.create_block(&b, &a).await.unwrap();
    let channel = ChannelId::new(channel_id);
    assert!(!r.dm_send_blocked(&a, &channel).await.unwrap());
    assert!(!r.dm_send_blocked(&b, &channel).await.unwrap());
}

// ── Friends cap enforced on BOTH sides (accept + auto-accept, §7.2) ──────

/// Accepting must reject when the OTHER party (the requester) is at the friends
/// cap, even though the accepting user has room. Guards the `counts.other`
/// branch of `accept_request`.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn accept_rejected_when_requester_at_friends_cap() {
    let pool = test_pool().await;
    let r = repo(&pool);
    let x = seed_user(&pool).await;
    let y = seed_user(&pool).await;

    fill_accepted_friends(&pool, x.0, MAX_FRIENDS).await;
    assert_eq!(r.count_friends(&x).await.unwrap(), MAX_FRIENDS);

    // x requests y (pending has no friends cap), then y accepts. y has 0 friends
    // but x — the OTHER side — is full → Conflict.
    assert_eq!(
        r.create_request(&x, &y).await.unwrap(),
        RequestOutcome::Requested
    );
    let err = r.accept_request(&y, &x).await.unwrap_err();
    assert!(matches!(err, DomainError::Conflict(_)), "got {err:?}");
}

/// The mutual auto-accept path enforces the same both-sides cap: the reverse
/// request must fail when the original requester is already full. Guards the
/// `counts.other` branch of the `AutoAccepted` arm of `create_request`.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn auto_accept_rejected_when_other_side_at_friends_cap() {
    let pool = test_pool().await;
    let r = repo(&pool);
    let x = seed_user(&pool).await;
    let y = seed_user(&pool).await;

    fill_accepted_friends(&pool, x.0, MAX_FRIENDS).await;
    assert_eq!(
        r.create_request(&x, &y).await.unwrap(),
        RequestOutcome::Requested
    );

    // y sends the reverse request → would auto-accept, but x is full → Conflict.
    let err = r.create_request(&y, &x).await.unwrap_err();
    assert!(matches!(err, DomainError::Conflict(_)), "got {err:?}");
    // The pending row survives the rolled-back auto-accept.
    assert!(!r.are_friends(&x, &y).await.unwrap());
}

// ── Service-level caps (outgoing pending, blocks) ───────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn send_request_rejected_at_outgoing_pending_cap() {
    let pool = test_pool().await;
    let svc = friendship_service(&pool);
    let caller = seed_user(&pool).await;

    fill_pending_outgoing(&pool, caller.0, MAX_OUTGOING_PENDING).await;
    assert_eq!(
        repo(&pool).count_outgoing_pending(&caller).await.unwrap(),
        MAX_OUTGOING_PENDING
    );

    let target = seed_user(&pool).await;
    let err = svc
        .send_request(&caller, RequestTarget::Id(target))
        .await
        .unwrap_err();
    assert!(matches!(err, DomainError::Conflict(_)), "got {err:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn block_rejected_at_blocks_cap() {
    let pool = test_pool().await;
    let svc = friendship_service(&pool);
    let caller = seed_user(&pool).await;

    fill_blocks(&pool, caller.0, MAX_BLOCKS).await;
    assert_eq!(repo(&pool).count_blocks(&caller).await.unwrap(), MAX_BLOCKS);

    let target = seed_user(&pool).await;
    let err = svc.block(&caller, &target).await.unwrap_err();
    assert!(matches!(err, DomainError::Conflict(_)), "got {err:?}");
}

// ── DM-creation gate (DmService.create_or_get_dm, §7.2) ─────────────────

/// Strangers (not friends, no shared non-DM server, no block) cannot open a DM.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn dm_gate_rejects_strangers() {
    let pool = test_pool().await;
    let svc = dm_service(&pool);
    let a = seed_user(&pool).await;
    let b = seed_user(&pool).await;

    let err = svc.create_or_get_dm(&a, &b).await.unwrap_err();
    assert!(matches!(err, DomainError::Forbidden(_)), "got {err:?}");
}

/// Friends may open a DM even with no shared server (the `are_friends` branch).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn dm_gate_allows_friends_without_shared_server() {
    let pool = test_pool().await;
    let svc = dm_service(&pool);
    let r = repo(&pool);
    let a = seed_user(&pool).await;
    let b = seed_user(&pool).await;

    r.create_request(&a, &b).await.unwrap();
    r.accept_request(&b, &a).await.unwrap();

    let (_conv, created) = svc.create_or_get_dm(&a, &b).await.unwrap();
    assert!(created, "friends can open a fresh DM");
}

/// A block in either direction hard-stops NEW DM creation.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn dm_gate_rejects_when_blocked() {
    let pool = test_pool().await;
    let svc = dm_service(&pool);
    let r = repo(&pool);
    let a = seed_user(&pool).await;
    let b = seed_user(&pool).await;

    r.create_block(&a, &b).await.unwrap();

    let err = svc.create_or_get_dm(&a, &b).await.unwrap_err();
    assert!(matches!(err, DomainError::Forbidden(_)), "blocker → 403");
    let err_rev = svc.create_or_get_dm(&b, &a).await.unwrap_err();
    assert!(
        matches!(err_rev, DomainError::Forbidden(_)),
        "blocked → 403"
    );
}

/// An EXISTING DM stays open: unfriending and then blocking never lock people
/// out of history — the gates sit after the existing-DM early return (§3.4).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn dm_existing_stays_open_after_unfriend_and_block() {
    let pool = test_pool().await;
    let svc = dm_service(&pool);
    let r = repo(&pool);
    let a = seed_user(&pool).await;
    let b = seed_user(&pool).await;

    // Friends → open a DM.
    r.create_request(&a, &b).await.unwrap();
    r.accept_request(&b, &a).await.unwrap();
    let (_conv, created) = svc.create_or_get_dm(&a, &b).await.unwrap();
    assert!(created);

    // Unfriend → the DM is still returned, not recreated.
    assert!(r.delete_friendship(&a, &b).await.unwrap());
    let (_conv2, created2) = svc.create_or_get_dm(&a, &b).await.unwrap();
    assert!(!created2, "existing DM survives unfriend");

    // Block → the DM is STILL returned (gate never runs on the existing path).
    r.create_block(&a, &b).await.unwrap();
    let (_conv3, created3) = svc.create_or_get_dm(&a, &b).await.unwrap();
    assert!(!created3, "existing DM survives block");
}
