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

use sqlx::PgPool;
use uuid::Uuid;

use harmony_api::domain::models::UserId;
use harmony_api::domain::models::friendship::{
    BlockOutcome, FriendshipStatus, RequestDirection, RequestOutcome,
};
use harmony_api::domain::ports::FriendshipRepository;
use harmony_api::infra::postgres::PgFriendshipRepository;

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
