#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Attachments backend regression tests (T1.3 part 1, real DB).
//!
//! Covers the atomic write path (`send_to_channel` + attachment rows in one
//! transaction), the batched read path (`batch_for_messages` order), the
//! per-plan caps (Free: 1 attachment / 8MB), image-only messages, the
//! encrypted-message reject (decision D7), soft-delete retention + hard-delete
//! cascade, and the fail-closed RLS posture of `message_attachments`.
//!
//! WHY `#[ignore]`: requires a running Postgres with the Harmony schema
//! (mirrors the mentions integration tests). Run locally with:
//!   `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:64322/postgres \
//!      cargo test --test attachments_test -- --ignored`

use std::sync::Arc;

use sqlx::PgPool;
use uuid::Uuid;

use harmony_api::domain::errors::DomainError;
use harmony_api::domain::models::{ChannelId, MessageId, NewAttachment, UserId};
use harmony_api::domain::ports::{AttachmentRepository, MessageRepository};
use harmony_api::domain::services::{ContentFilter, MessageService, SpamGuard};
use harmony_api::infra::postgres::{
    PgAttachmentRepository, PgChannelRepository, PgMemberRepository, PgMessageRepository,
    PgPlanLimitChecker, PgReactionRepository,
};

/// Origin every fixture URL lives on — passed to `try_new` as the pinned
/// storage origin (mirrors `SUPABASE_URL` in a deployed environment).
const ATTACHMENT_ORIGIN: &str = "https://test.supabase.co";

// ── DB pool (mirrors mentions_test) ──────────────────────────────────────

async fn test_pool() -> PgPool {
    dotenvy::dotenv().ok();
    let url =
        std::env::var("DATABASE_URL").expect("DATABASE_URL must be set for integration tests");
    PgPool::connect(&url)
        .await
        .expect("Failed to connect to test database")
}

// ── Seeding (mirrors mentions_test) ──────────────────────────────────────

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
    .bind(format!("att-{uid}@example.com"))
    .execute(pool)
    .await
    .expect("seed auth.users");

    let username = format!("at{}", &uid.simple().to_string()[..10]);
    sqlx::query(
        r#"
        INSERT INTO profiles (id, username, display_name)
        VALUES ($1, $2, 'Attachment Tester')
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
    // WHY no explicit plan: servers default to 'free' — exactly the tier whose
    // caps (1 attachment, 8MB) the plan-limit tests pin.
    sqlx::query(
        "INSERT INTO servers (id, name, owner_id, is_dm) VALUES ($1, 'Att Server', $2, false)",
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

async fn seed_channel(pool: &PgPool, server: Uuid, encrypted: bool) -> Uuid {
    let cid = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channels (id, server_id, name, is_private, encrypted) VALUES ($1, $2, 'att-chan', false, $3)",
    )
    .bind(cid)
    .bind(server)
    .bind(encrypted)
    .execute(pool)
    .await
    .expect("seed channel");
    cid
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

/// Builds a valid public-bucket URL under the OWNER's upload folder — the
/// validation funnel requires the `{uid}/` prefix to match the author.
fn attachment_url(owner: Uuid, file: &str) -> String {
    format!("{ATTACHMENT_ORIGIN}/storage/v1/object/public/attachments/{owner}/{file}")
}

fn attachment(
    owner: Uuid,
    file: &str,
    mime: &str,
    size: i64,
    dims: Option<(i32, i32)>,
) -> NewAttachment {
    NewAttachment::try_new(
        attachment_url(owner, file),
        mime.to_string(),
        size,
        dims.map(|(w, _)| w),
        dims.map(|(_, h)| h),
        &UserId::new(owner),
        Some(ATTACHMENT_ORIGIN),
    )
    .expect("valid attachment fixture")
}

fn build_service(pool: &PgPool) -> MessageService {
    MessageService::new(
        Arc::new(PgMessageRepository::new(pool.clone())),
        Arc::new(PgChannelRepository::new(pool.clone())),
        Arc::new(PgMemberRepository::new(pool.clone())),
        Arc::new(PgPlanLimitChecker::new(pool.clone())),
        Arc::new(PgReactionRepository::new(pool.clone())),
        Arc::new(PgAttachmentRepository::new(pool.clone())),
        Arc::new(ContentFilter::new()),
        // WHY disabled: these tests exercise plan caps, not anti-abuse
        // heuristics — mirrors SPAM_GUARD_ENABLED=false in the E2E env.
        Arc::new(SpamGuard::with_enabled(false)),
    )
}

// ── Atomic write + ordered read ──────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn send_persists_attachments_atomically_and_in_order() {
    let pool = test_pool().await;
    let repo = PgMessageRepository::new(pool.clone());
    let attachment_repo = PgAttachmentRepository::new(pool.clone());

    let owner = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    let channel = seed_channel(&pool, server, false).await;

    let first = attachment(owner, "file.webp", "image/webp", 1024, Some((800, 600)));
    let second = attachment(owner, "doc.pdf", "application/pdf", 2048, None);

    let sent = repo
        .send_to_channel(
            &ChannelId::new(channel),
            &UserId::new(owner),
            "two files".to_string(),
            false,
            None,
            None,
            None,
            None,
            None,
            vec![],
            vec![first.clone(), second.clone()],
            0,
        )
        .await
        .expect("send_to_channel");

    // Returned in insertion order with server-assigned ids.
    assert_eq!(sent.attachments.len(), 2);
    assert_eq!(sent.attachments[0].url, first.url);
    assert_eq!(sent.attachments[0].width, Some(800));
    assert_eq!(sent.attachments[1].url, second.url);
    assert_eq!(sent.attachments[1].width, None);

    // Rows exist with the right message_id.
    let count: i64 = sqlx::query_scalar(
        "SELECT COALESCE(COUNT(*)::BIGINT, 0) FROM message_attachments WHERE message_id = $1",
    )
    .bind(sent.message.id.0)
    .fetch_one(&pool)
    .await
    .expect("count rows");
    assert_eq!(count, 2);

    // Batched read reconstructs the same order (created_at, id).
    let map = attachment_repo
        .batch_for_messages(std::slice::from_ref(&sent.message.id))
        .await
        .expect("batch_for_messages");
    let read = map.get(&sent.message.id).expect("attachments present");
    assert_eq!(read.len(), 2);
    assert_eq!(read[0].url, first.url);
    assert_eq!(read[1].url, second.url);

    cleanup(&pool, &[server], &[owner]).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn batch_for_messages_maps_attachments_to_the_right_message() {
    let pool = test_pool().await;
    let repo = PgMessageRepository::new(pool.clone());
    let attachment_repo = PgAttachmentRepository::new(pool.clone());

    let owner = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    let channel = seed_channel(&pool, server, false).await;

    let mut ids: Vec<MessageId> = Vec::new();
    // 3 messages: #0 with one attachment, #1 without, #2 with one attachment.
    for (i, with_attachment) in [(0, true), (1, false), (2, true)] {
        let attachments = if with_attachment {
            vec![attachment(
                owner,
                &format!("f{i}.webp"),
                "image/webp",
                512,
                Some((10, 10)),
            )]
        } else {
            vec![]
        };
        let sent = repo
            .send_to_channel(
                &ChannelId::new(channel),
                &UserId::new(owner),
                format!("msg {i}"),
                false,
                None,
                None,
                None,
                None,
                None,
                vec![],
                attachments,
                0,
            )
            .await
            .expect("send_to_channel");
        ids.push(sent.message.id);
    }

    let map = attachment_repo
        .batch_for_messages(&ids)
        .await
        .expect("batch_for_messages");
    assert!(map.get(&ids[0]).is_some_and(|a| a.len() == 1));
    assert!(!map.contains_key(&ids[1]), "no-attachment message absent");
    assert!(map.get(&ids[2]).is_some_and(|a| a.len() == 1));
    assert!(
        map[&ids[0]][0].url.contains("f0.webp") && map[&ids[2]][0].url.contains("f2.webp"),
        "attachments mapped to their own message"
    );

    cleanup(&pool, &[server], &[owner]).await;
}

// ── Plan caps (Free server: 1 attachment, 8MB) ───────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn free_plan_rejects_second_attachment_and_oversized_file() {
    let pool = test_pool().await;
    let service = build_service(&pool);

    let owner = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    let channel = seed_channel(&pool, server, false).await;
    let channel_id = ChannelId::new(channel);
    let author = UserId::new(owner);

    // 2 attachments on Free (cap 1) → LimitExceeded.
    let result = service
        .create(
            &channel_id,
            &author,
            "too many".to_string(),
            false,
            None,
            None,
            None,
            vec![
                attachment(owner, "file.webp", "image/webp", 1024, Some((1, 1))),
                attachment(owner, "file.webp", "image/webp", 1024, Some((1, 1))),
            ],
        )
        .await;
    assert!(
        matches!(result, Err(DomainError::LimitExceeded { limit: 1, .. })),
        "expected LimitExceeded(1), got {result:?}"
    );

    // Single file over the Free 8MB cap → LimitExceeded.
    let result = service
        .create(
            &channel_id,
            &author,
            "too big".to_string(),
            false,
            None,
            None,
            None,
            vec![attachment(
                owner,
                "file.webp",
                "image/webp",
                8_388_609,
                Some((1, 1)),
            )],
        )
        .await;
    assert!(
        matches!(result, Err(DomainError::LimitExceeded { .. })),
        "expected size LimitExceeded, got {result:?}"
    );

    // Exactly one small attachment → accepted.
    let sent = service
        .create(
            &channel_id,
            &author,
            "just right".to_string(),
            false,
            None,
            None,
            None,
            vec![attachment(
                owner,
                "file.webp",
                "image/webp",
                1024,
                Some((1, 1)),
            )],
        )
        .await
        .expect("one small attachment allowed on Free");
    assert_eq!(sent.attachments.len(), 1);

    cleanup(&pool, &[server], &[owner]).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn image_only_message_is_valid_and_empty_both_is_rejected() {
    let pool = test_pool().await;
    let service = build_service(&pool);

    let owner = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    let channel = seed_channel(&pool, server, false).await;
    let channel_id = ChannelId::new(channel);
    let author = UserId::new(owner);

    // Empty content + 1 attachment → valid (decision D10).
    let sent = service
        .create(
            &channel_id,
            &author,
            String::new(),
            false,
            None,
            None,
            None,
            vec![attachment(
                owner,
                "file.webp",
                "image/webp",
                1024,
                Some((4, 4)),
            )],
        )
        .await
        .expect("image-only message accepted");
    assert_eq!(sent.attachments.len(), 1);
    assert_eq!(sent.message.content, "");

    // Empty content + zero attachments → still rejected.
    let result = service
        .create(
            &channel_id,
            &author,
            "   ".to_string(),
            false,
            None,
            None,
            None,
            vec![],
        )
        .await;
    assert!(matches!(result, Err(DomainError::ValidationError(_))));

    cleanup(&pool, &[server], &[owner]).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn encrypted_message_with_attachments_is_rejected() {
    let pool = test_pool().await;
    let service = build_service(&pool);

    let owner = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    let channel = seed_channel(&pool, server, true).await; // encrypted channel

    let result = service
        .create(
            &ChannelId::new(channel),
            &UserId::new(owner),
            "ciphertext".to_string(),
            true,
            Some("DEVICE1".to_string()),
            None,
            None,
            vec![attachment(
                owner,
                "file.webp",
                "image/webp",
                1024,
                Some((1, 1)),
            )],
        )
        .await;
    assert!(
        matches!(result, Err(DomainError::ValidationError(ref msg)) if msg.contains("encrypted")),
        "expected D7 reject, got {result:?}"
    );

    cleanup(&pool, &[server], &[owner]).await;
}

// ── Deletion semantics ───────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn soft_delete_retains_rows_and_hard_delete_cascades() {
    let pool = test_pool().await;
    let repo = PgMessageRepository::new(pool.clone());

    let owner = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    let channel = seed_channel(&pool, server, false).await;

    let sent = repo
        .send_to_channel(
            &ChannelId::new(channel),
            &UserId::new(owner),
            "to be deleted".to_string(),
            false,
            None,
            None,
            None,
            None,
            None,
            vec![],
            vec![attachment(
                owner,
                "file.webp",
                "image/webp",
                512,
                Some((2, 2)),
            )],
            0,
        )
        .await
        .expect("send_to_channel");
    let mid = sent.message.id.0;

    // Soft delete (ADR-038): attachment rows SURVIVE alongside the tombstone.
    repo.soft_delete(&sent.message.id, &UserId::new(owner), None)
        .await
        .expect("soft_delete");
    let count: i64 = sqlx::query_scalar(
        "SELECT COALESCE(COUNT(*)::BIGINT, 0) FROM message_attachments WHERE message_id = $1",
    )
    .bind(mid)
    .fetch_one(&pool)
    .await
    .expect("count after soft delete");
    assert_eq!(count, 1, "soft delete must retain attachment rows");

    // Hard DELETE (teardown/GDPR path only): FK cascade removes the rows.
    sqlx::query("DELETE FROM messages WHERE id = $1")
        .bind(mid)
        .execute(&pool)
        .await
        .expect("hard delete");
    let count: i64 = sqlx::query_scalar(
        "SELECT COALESCE(COUNT(*)::BIGINT, 0) FROM message_attachments WHERE message_id = $1",
    )
    .bind(mid)
    .fetch_one(&pool)
    .await
    .expect("count after hard delete");
    assert_eq!(count, 0, "hard delete must cascade attachment rows");

    cleanup(&pool, &[server], &[owner]).await;
}

// ── RLS posture ──────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn message_attachments_rls_is_enabled_with_select_policy() {
    let pool = test_pool().await;

    let rls_enabled: bool = sqlx::query_scalar(
        "SELECT relrowsecurity FROM pg_class WHERE relname = 'message_attachments'",
    )
    .fetch_one(&pool)
    .await
    .expect("pg_class lookup");
    assert!(rls_enabled, "RLS must be ON (ADR-040)");

    let policy_count: i64 = sqlx::query_scalar(
        "SELECT COALESCE(COUNT(*)::BIGINT, 0) FROM pg_policies
         WHERE tablename = 'message_attachments'
           AND policyname = 'message_attachments_select_via_message'",
    )
    .fetch_one(&pool)
    .await
    .expect("pg_policies lookup");
    assert_eq!(policy_count, 1, "select-via-message policy must exist");

    // Fail-closed smoke: an anonymous `authenticated` session (no JWT claims →
    // auth.uid() IS NULL → parent message invisible) sees ZERO attachment rows,
    // while service_role (this pool) can read them.
    let owner = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    let channel = seed_channel(&pool, server, false).await;
    let repo = PgMessageRepository::new(pool.clone());
    let sent = repo
        .send_to_channel(
            &ChannelId::new(channel),
            &UserId::new(owner),
            "rls probe".to_string(),
            false,
            None,
            None,
            None,
            None,
            None,
            vec![],
            vec![attachment(
                owner,
                "file.webp",
                "image/webp",
                256,
                Some((1, 1)),
            )],
            0,
        )
        .await
        .expect("send_to_channel");

    let mut tx = pool.begin().await.expect("begin");
    sqlx::query("SET LOCAL ROLE authenticated")
        .execute(&mut *tx)
        .await
        .expect("set role");
    let visible: i64 = sqlx::query_scalar(
        "SELECT COALESCE(COUNT(*)::BIGINT, 0) FROM message_attachments WHERE message_id = $1",
    )
    .bind(sent.message.id.0)
    .fetch_one(&mut *tx)
    .await
    .expect("count as authenticated");
    drop(tx); // rollback → role reset

    assert_eq!(visible, 0, "claimless authenticated role must see nothing");

    // Positive path: the same query WITH the member's JWT claims sees the row
    // (the policy admits members via is_channel_member).
    let mut tx = pool.begin().await.expect("begin");
    sqlx::query("SET LOCAL ROLE authenticated")
        .execute(&mut *tx)
        .await
        .expect("set role");
    sqlx::query("SELECT set_config('request.jwt.claims', $1, true)")
        .bind(format!(r#"{{"sub": "{owner}", "role": "authenticated"}}"#))
        .execute(&mut *tx)
        .await
        .expect("set claims");
    let visible: i64 = sqlx::query_scalar(
        "SELECT COALESCE(COUNT(*)::BIGINT, 0) FROM message_attachments WHERE message_id = $1",
    )
    .bind(sent.message.id.0)
    .fetch_one(&mut *tx)
    .await
    .expect("count as member");
    drop(tx);

    assert_eq!(visible, 1, "a channel member must see the attachment row");

    cleanup(&pool, &[server], &[owner]).await;
}
