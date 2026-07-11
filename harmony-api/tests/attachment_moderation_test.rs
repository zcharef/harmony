#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Image content-moderation Phase 1 regression tests (real DB).
//!
//! Covers the mandated invariants (spec §d Phase 1):
//! - RLS: a non-service-role authenticated user CANNOT UPDATE
//!   `message_attachments.moderation_status` (no UPDATE policy) — pins "a user
//!   can't self-clear a moderation flag".
//! - Noop scan flips `pending → approved` and emits `MessageUpdated` carrying
//!   the new status (asserted on a second event-bus subscriber — the SSE flip).
//! - Context→status mapping end-to-end: adult-NSFW is `gated` in a public
//!   non-NSFW channel and `approved` in an `is_nsfw` channel.
//! - Fail-closed: a scan error leaves the attachment `pending` (never revealed)
//!   AND records a dead-letter row.
//!
//! WHY `#[ignore]`: requires a running Postgres with the Harmony schema. Run:
//!   `DATABASE_URL=… cargo test --test attachment_moderation_test -- --ignored`

use std::sync::Arc;

use async_trait::async_trait;
use sqlx::PgPool;
use uuid::Uuid;

use harmony_api::api::attachment_scan::{AttachmentScanDeps, scan_message_attachments};
use harmony_api::domain::errors::DomainError;
use harmony_api::domain::models::{
    AttachmentModerationStatus, ChannelId, MessageId, NewAttachment, ServerEvent, ServerId, UserId,
};
use harmony_api::domain::ports::{
    CsamMatcher, EventBus, ImageClassifier, MessageRepository, NsfwLabel, NsfwVerdict,
};
use harmony_api::domain::services::{ContentFilter, MessageService, SpamGuard};
use harmony_api::infra::pg_notify_event_bus::PgNotifyEventBus;
use harmony_api::infra::postgres::{
    PgAttachmentRepository, PgAttachmentScanRetryRepository, PgChannelRepository,
    PgEmbedRepository, PgFriendshipRepository, PgMemberRepository, PgMessageRepository,
    PgPlanLimitChecker, PgReactionRepository,
};
use harmony_api::infra::{NoopCsamMatcher, NoopImageClassifier};

const ATTACHMENT_ORIGIN: &str = "https://test.supabase.co";

// ── Test doubles (hand-written, not a mock library — ADR-018) ────────────

/// Classifier that always labels adult-NSFW (score 0.95). `is_configured` stays
/// false so the pipeline never fetches bytes (the fixture URL has no object).
#[derive(Debug)]
struct NsfwClassifier;

#[async_trait]
impl ImageClassifier for NsfwClassifier {
    async fn classify_nsfw(&self, _bytes: &[u8], _mime: &str) -> Result<NsfwVerdict, DomainError> {
        Ok(NsfwVerdict {
            score: 0.95,
            label: NsfwLabel::Nsfw,
        })
    }
}

/// Classifier that always errors — drives the fail-closed / dead-letter path.
#[derive(Debug)]
struct ErroringClassifier;

#[async_trait]
impl ImageClassifier for ErroringClassifier {
    async fn classify_nsfw(&self, _bytes: &[u8], _mime: &str) -> Result<NsfwVerdict, DomainError> {
        Err(DomainError::ExternalService("inference boom".to_string()))
    }
}

// ── DB pool + seeding (mirrors attachments_test) ─────────────────────────

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
    .bind(format!("mod-{uid}@example.com"))
    .execute(pool)
    .await
    .expect("seed auth.users");

    let username = format!("mo{}", &uid.simple().to_string()[..10]);
    sqlx::query("INSERT INTO profiles (id, username, display_name) VALUES ($1, $2, 'Mod Tester') ON CONFLICT (id) DO NOTHING")
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
        "INSERT INTO servers (id, name, owner_id, is_dm) VALUES ($1, 'Mod Server', $2, $3)",
    )
    .bind(sid)
    .bind(owner)
    .bind(is_dm)
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

async fn seed_channel(pool: &PgPool, server: Uuid, is_nsfw: bool) -> Uuid {
    let cid = Uuid::new_v4();
    sqlx::query("INSERT INTO channels (id, server_id, name, is_private, is_nsfw) VALUES ($1, $2, 'mod-chan', false, $3)")
        .bind(cid)
        .bind(server)
        .bind(is_nsfw)
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

fn image(owner: Uuid, file: &str) -> NewAttachment {
    NewAttachment::try_new(
        format!("{ATTACHMENT_ORIGIN}/storage/v1/object/public/attachments/{owner}/{file}"),
        "image/webp".to_string(),
        1024,
        Some(800),
        Some(600),
        &UserId::new(owner),
        Some(ATTACHMENT_ORIGIN),
    )
    .expect("valid attachment fixture")
}

fn build_service(pool: &PgPool) -> Arc<MessageService> {
    Arc::new(MessageService::new(
        Arc::new(PgMessageRepository::new(pool.clone())),
        Arc::new(PgChannelRepository::new(pool.clone())),
        Arc::new(PgMemberRepository::new(pool.clone())),
        Arc::new(PgPlanLimitChecker::new(pool.clone())),
        Arc::new(PgReactionRepository::new(pool.clone())),
        Arc::new(PgAttachmentRepository::new(pool.clone())),
        Arc::new(PgEmbedRepository::new(pool.clone())),
        Arc::new(ContentFilter::new()),
        Arc::new(SpamGuard::with_enabled(false)),
        Arc::new(PgFriendshipRepository::new(pool.clone())),
    ))
}

/// Build the scan deps with the given classifier + matcher, sharing `event_bus`.
fn build_deps(
    pool: &PgPool,
    classifier: Arc<dyn ImageClassifier>,
    matcher: Arc<dyn CsamMatcher>,
    event_bus: Arc<dyn EventBus>,
) -> AttachmentScanDeps {
    AttachmentScanDeps {
        classifier,
        matcher,
        attachment_repo: Arc::new(PgAttachmentRepository::new(pool.clone())),
        channel_repo: Arc::new(PgChannelRepository::new(pool.clone())),
        retry_repo: Arc::new(PgAttachmentScanRetryRepository::new(pool.clone())),
        message_service: build_service(pool),
        event_bus,
    }
}

async fn send_image_message(pool: &PgPool, channel: Uuid, owner: Uuid) -> MessageId {
    let repo = PgMessageRepository::new(pool.clone());
    let sent = repo
        .send_to_channel(
            &ChannelId::new(channel),
            &UserId::new(owner),
            String::new(),
            false,
            None,
            None,
            None,
            None,
            None,
            vec![],
            vec![image(owner, "pic.webp")],
            0,
        )
        .await
        .expect("send_to_channel");
    // Every attachment inserts as pending (the fail-closed default).
    assert_eq!(
        sent.attachments[0].moderation_status,
        AttachmentModerationStatus::Pending
    );
    sent.message.id
}

async fn status_of(pool: &PgPool, message_id: &MessageId) -> String {
    sqlx::query_scalar::<_, String>(
        "SELECT moderation_status::text FROM message_attachments WHERE message_id = $1",
    )
    .bind(message_id.0)
    .fetch_one(pool)
    .await
    .expect("read status")
}

// ── Tests ────────────────────────────────────────────────────────────────

/// RLS regression (mandatory): a non-service-role authenticated user cannot
/// UPDATE `moderation_status` — enforced by the ABSENCE of an UPDATE policy.
/// Attempted as the uploader (owner) AND another member: both denied, and the
/// status stays `pending`. Pins "a user can't self-clear a moderation flag".
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn authenticated_user_cannot_update_moderation_status() {
    let pool = test_pool().await;
    let owner = seed_user(&pool).await;
    let other = seed_user(&pool).await;
    let server = seed_server(&pool, owner, false).await;
    sqlx::query("INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')")
        .bind(server)
        .bind(other)
        .execute(&pool)
        .await
        .expect("seed member");
    let channel = seed_channel(&pool, server, false).await;
    let message_id = send_image_message(&pool, channel, owner).await;

    for actor in [owner, other] {
        let mut tx = pool.begin().await.expect("begin");
        sqlx::query("SET LOCAL ROLE authenticated")
            .execute(&mut *tx)
            .await
            .expect("set role");
        sqlx::query("SELECT set_config('request.jwt.claims', $1, true)")
            .bind(format!(r#"{{"sub": "{actor}", "role": "authenticated"}}"#))
            .execute(&mut *tx)
            .await
            .expect("set claims");
        let result = sqlx::query(
            "UPDATE message_attachments SET moderation_status = 'approved' WHERE message_id = $1",
        )
        .bind(message_id.0)
        .execute(&mut *tx)
        .await
        .expect("update runs but affects nothing");
        drop(tx); // rollback → role reset
        assert_eq!(
            result.rows_affected(),
            0,
            "authenticated user {actor} must not UPDATE moderation_status (no policy)"
        );
    }

    // service_role (the test pool) confirms the flag was never cleared.
    assert_eq!(status_of(&pool, &message_id).await, "pending");

    cleanup(&pool, &[server], &[owner, other]).await;
}

/// The Noop scan flips `pending → approved` and emits a `MessageUpdated`
/// carrying the new status — asserted on a SECOND bus subscriber (the SSE flip).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn noop_scan_flips_pending_to_approved_and_emits_message_updated() {
    let pool = test_pool().await;
    let owner = seed_user(&pool).await;
    let server = seed_server(&pool, owner, false).await;
    let channel = seed_channel(&pool, server, false).await;
    let message_id = send_image_message(&pool, channel, owner).await;

    let (bus_inner, _notify_rx) = PgNotifyEventBus::new(Uuid::new_v4());
    let event_bus: Arc<dyn EventBus> = Arc::new(bus_inner);
    let mut rx = event_bus.subscribe(); // second SSE client

    let deps = build_deps(
        &pool,
        Arc::new(NoopImageClassifier),
        Arc::new(NoopCsamMatcher),
        event_bus.clone(),
    );
    scan_message_attachments(
        &deps,
        &message_id,
        &UserId::new(owner),
        &ChannelId::new(channel),
        &ServerId::new(server),
    )
    .await;

    assert_eq!(status_of(&pool, &message_id).await, "approved");

    let event = rx
        .try_recv()
        .expect("a MessageUpdated must have been published");
    match event {
        ServerEvent::MessageUpdated { message, .. } => {
            assert_eq!(message.id, message_id);
            assert_eq!(
                message.attachments[0].moderation_status,
                AttachmentModerationStatus::Approved
            );
        }
        other => panic!("expected MessageUpdated, got {other:?}"),
    }

    cleanup(&pool, &[server], &[owner]).await;
}

/// Context mapping end-to-end: adult-NSFW is `gated` in a public non-NSFW
/// channel and `approved` in an `is_nsfw` channel (§b decision table).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn nsfw_gated_in_public_channel_and_approved_in_nsfw_channel() {
    let pool = test_pool().await;
    let owner = seed_user(&pool).await;
    // A second author so the own-server (author==owner) cell doesn't mask the
    // public-channel gating.
    let author = seed_user(&pool).await;
    let server = seed_server(&pool, owner, false).await;
    sqlx::query("INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')")
        .bind(server)
        .bind(author)
        .execute(&pool)
        .await
        .expect("seed member");
    let public_channel = seed_channel(&pool, server, false).await;
    let nsfw_channel = seed_channel(&pool, server, true).await;

    let (bus_inner, _rx) = PgNotifyEventBus::new(Uuid::new_v4());
    let event_bus: Arc<dyn EventBus> = Arc::new(bus_inner);
    let deps = build_deps(
        &pool,
        Arc::new(NsfwClassifier),
        Arc::new(NoopCsamMatcher),
        event_bus,
    );

    // Public non-NSFW channel, author != owner → gated.
    let public_msg = send_image_message(&pool, public_channel, author).await;
    scan_message_attachments(
        &deps,
        &public_msg,
        &UserId::new(author),
        &ChannelId::new(public_channel),
        &ServerId::new(server),
    )
    .await;
    assert_eq!(status_of(&pool, &public_msg).await, "gated");

    // is_nsfw channel → approved.
    let nsfw_msg = send_image_message(&pool, nsfw_channel, author).await;
    scan_message_attachments(
        &deps,
        &nsfw_msg,
        &UserId::new(author),
        &ChannelId::new(nsfw_channel),
        &ServerId::new(server),
    )
    .await;
    assert_eq!(status_of(&pool, &nsfw_msg).await, "approved");

    cleanup(&pool, &[server], &[owner, author]).await;
}

/// Fail-closed: a terminal scan error leaves the attachment `pending` (never
/// revealed) AND records a dead-letter row for the background sweep to retry.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn scan_error_leaves_pending_and_dead_letters() {
    let pool = test_pool().await;
    let owner = seed_user(&pool).await;
    let server = seed_server(&pool, owner, false).await;
    let channel = seed_channel(&pool, server, false).await;
    let message_id = send_image_message(&pool, channel, owner).await;

    let (bus_inner, _rx) = PgNotifyEventBus::new(Uuid::new_v4());
    let event_bus: Arc<dyn EventBus> = Arc::new(bus_inner);
    let deps = build_deps(
        &pool,
        Arc::new(ErroringClassifier),
        Arc::new(NoopCsamMatcher),
        event_bus,
    );
    scan_message_attachments(
        &deps,
        &message_id,
        &UserId::new(owner),
        &ChannelId::new(channel),
        &ServerId::new(server),
    )
    .await;

    // Never revealed on failure.
    assert_eq!(status_of(&pool, &message_id).await, "pending");

    // A dead-letter row exists for the retry sweep.
    let dead_letters: i64 = sqlx::query_scalar(
        "SELECT COALESCE(COUNT(*)::BIGINT, 0) FROM attachment_scan_retry WHERE message_id = $1",
    )
    .bind(message_id.0)
    .fetch_one(&pool)
    .await
    .expect("count dead letters");
    assert_eq!(dead_letters, 1, "a failed scan must dead-letter");

    cleanup(&pool, &[server], &[owner]).await;
}
