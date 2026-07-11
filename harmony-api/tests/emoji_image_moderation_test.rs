#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Custom-emoji image scan-before-reveal regression tests (real DB).
//!
//! Covers the mandated per-surface invariants for the emoji image surface:
//! - CLEAN emoji → promoted: status `approved`, now visible via
//!   `list_for_server`.
//! - NSFW emoji → rejected: the row is DELETED (never revealed to other
//!   members), the flagged object is handed to the storage remover, and no
//!   dead-letter row remains.
//! - Scan ERROR → fail-closed: the emoji stays `pending` (never listed) AND a
//!   dead-letter row is recorded for the retry sweep.
//! - Anti-self-approval: a non-service-role `authenticated` user can neither
//!   flip `moderation_status`/`url` nor INSERT a pre-approved emoji directly.
//!
//! No mocks (ADR-018): real Postgres + hand-written classifier/remover doubles.
//!
//! WHY #[ignore]: requires a running Postgres with the Harmony schema. Run:
//!   `cargo test --test emoji_image_moderation_test -- --ignored`

use std::sync::Arc;

use async_trait::async_trait;
use sqlx::PgPool;
use sqlx::Row;
use tokio::sync::Mutex;
use uuid::Uuid;

use harmony_api::api::emoji_image_scan::{EmojiImageScanDeps, scan_emoji};
use harmony_api::domain::errors::DomainError;
use harmony_api::domain::models::{EmojiId, IdentityImageModerationStatus, ServerId, UserId};
use harmony_api::domain::ports::{
    ImageClassifier, NsfwLabel, NsfwVerdict, ServerEmojiRepository, StorageObjectRemover,
};
use harmony_api::domain::services::{ContentFilter, ServerEmojiService};
use harmony_api::infra::NoopCsamMatcher;
use harmony_api::infra::pg_notify_event_bus::PgNotifyEventBus;
use harmony_api::infra::postgres::{
    PgEmojiImageScanRetryRepository, PgPlanLimitChecker, PgServerEmojiRepository,
};

// ── Test doubles (hand-written, ADR-018) ─────────────────────────────────

/// Classifier that always labels adult-NSFW. `is_configured` stays false so the
/// pipeline never fetches bytes (the fixture URL has no real object).
#[derive(Debug)]
struct NsfwClassifier;

#[async_trait]
impl ImageClassifier for NsfwClassifier {
    async fn classify_nsfw(&self, _bytes: &[u8], _mime: &str) -> Result<NsfwVerdict, DomainError> {
        Ok(NsfwVerdict {
            score: 0.98,
            label: NsfwLabel::Nsfw,
        })
    }
}

/// Classifier that always returns Clean.
#[derive(Debug)]
struct CleanClassifier;

#[async_trait]
impl ImageClassifier for CleanClassifier {
    async fn classify_nsfw(&self, _bytes: &[u8], _mime: &str) -> Result<NsfwVerdict, DomainError> {
        Ok(NsfwVerdict {
            score: 0.01,
            label: NsfwLabel::Clean,
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

/// Storage remover that records every deleted URL so the reject test can assert
/// the flagged object was handed off for deletion.
#[derive(Debug, Default)]
struct RecordingRemover {
    removed: Mutex<Vec<String>>,
}

#[async_trait]
impl StorageObjectRemover for RecordingRemover {
    async fn remove(&self, public_url: &str) -> Result<(), DomainError> {
        self.removed.lock().await.push(public_url.to_string());
        Ok(())
    }
}

// ── DB pool + seeding ────────────────────────────────────────────────────

async fn test_pool() -> PgPool {
    dotenvy::dotenv().ok();
    let url =
        std::env::var("DATABASE_URL").expect("DATABASE_URL must be set for integration tests");
    PgPool::connect(&url)
        .await
        .expect("connect to integration test database")
}

/// Seed an owner profile + an empty server, returning both ids.
async fn seed_owner_and_server(pool: &PgPool) -> (UserId, ServerId) {
    let user_uuid = Uuid::new_v4();
    sqlx::query(
        r#"
        INSERT INTO auth.users (id, instance_id, role, aud, email, encrypted_password, email_confirmed_at, created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change)
        VALUES ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '', now(), now(), now(), '', '', '', '')
        ON CONFLICT (id) DO NOTHING
        "#,
    )
    .bind(user_uuid)
    .bind(format!("emoji-{user_uuid}@example.com"))
    .execute(pool)
    .await
    .expect("seed auth.users");

    sqlx::query(
        r#"
        INSERT INTO profiles (id, username, display_name)
        VALUES ($1, $2, 'Emoji Tester')
        ON CONFLICT (id) DO NOTHING
        "#,
    )
    .bind(user_uuid)
    .bind(format!(
        "em{}",
        user_uuid
            .to_string()
            .replace('-', "")
            .get(..8)
            .unwrap_or("test0001")
    ))
    .execute(pool)
    .await
    .expect("seed profiles");

    let server_uuid = Uuid::new_v4();
    sqlx::query(
        r#"
        INSERT INTO servers (id, name, owner_id)
        VALUES ($1, 'Emoji Test Server', $2)
        "#,
    )
    .bind(server_uuid)
    .bind(user_uuid)
    .execute(pool)
    .await
    .expect("seed server");

    // Owner is a member of their own server (needed for the SELECT-policy path).
    sqlx::query(
        r#"
        INSERT INTO server_members (server_id, user_id, role)
        VALUES ($1, $2, 'owner')
        ON CONFLICT DO NOTHING
        "#,
    )
    .bind(server_uuid)
    .bind(user_uuid)
    .execute(pool)
    .await
    .expect("seed membership");

    (UserId::from(user_uuid), ServerId::new(server_uuid))
}

async fn cleanup(pool: &PgPool, user_id: &UserId, server_id: &ServerId) {
    // server_emojis + emoji_image_scan_retry cascade from server/emoji deletes.
    sqlx::query("DELETE FROM servers WHERE id = $1")
        .bind(server_id.0)
        .execute(pool)
        .await
        .ok();
    sqlx::query("DELETE FROM profiles WHERE id = $1")
        .bind(user_id.0)
        .execute(pool)
        .await
        .ok();
    sqlx::query("DELETE FROM auth.users WHERE id = $1")
        .bind(user_id.0)
        .execute(pool)
        .await
        .ok();
}

fn emoji_service(pool: &PgPool) -> Arc<ServerEmojiService> {
    Arc::new(ServerEmojiService::new(
        Arc::new(PgServerEmojiRepository::new(pool.clone())),
        Arc::new(PgPlanLimitChecker::new(
            pool.clone(),
            std::sync::Arc::new(harmony_api::infra::postgres::PgAnalyticsRecorder::new(
                pool.clone(),
            )),
        )),
        Some("https://cdn.example.com".to_string()),
        Arc::new(ContentFilter::noop()),
    ))
}

fn build_deps(
    pool: &PgPool,
    classifier: Arc<dyn ImageClassifier>,
    remover: Arc<dyn StorageObjectRemover>,
    service: Arc<ServerEmojiService>,
) -> EmojiImageScanDeps {
    let (event_bus_inner, _rx) = PgNotifyEventBus::new(Uuid::new_v4());
    EmojiImageScanDeps {
        classifier,
        matcher: Arc::new(NoopCsamMatcher),
        emoji_service: service,
        retry_repo: Arc::new(PgEmojiImageScanRetryRepository::new(pool.clone())),
        storage_remover: remover,
        event_bus: Arc::new(event_bus_inner),
    }
}

/// Insert a PENDING emoji directly through the repo (bypasses the plan/URL gate,
/// which the service unit tests already cover) and return its id.
async fn seed_pending_emoji(
    pool: &PgPool,
    server_id: &ServerId,
    owner: &UserId,
    name: &str,
    url: &str,
) -> EmojiId {
    let repo = PgServerEmojiRepository::new(pool.clone());
    let emoji = repo
        .create(server_id, name, url, false, owner)
        .await
        .expect("seed pending emoji");
    assert_eq!(
        emoji.moderation_status,
        IdentityImageModerationStatus::Pending,
        "a freshly-created emoji must be pending"
    );
    emoji.id
}

async fn retry_count(pool: &PgPool, emoji_id: &EmojiId) -> i64 {
    sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM emoji_image_scan_retry WHERE emoji_id = $1")
        .bind(emoji_id.0)
        .fetch_one(pool)
        .await
        .expect("count retries")
}

async fn status_of(pool: &PgPool, emoji_id: &EmojiId) -> Option<String> {
    sqlx::query_scalar::<_, String>(
        "SELECT moderation_status::text FROM server_emojis WHERE id = $1",
    )
    .bind(emoji_id.0)
    .fetch_optional(pool)
    .await
    .expect("read status")
}

const EMOJI_URL: &str = "https://cdn.example.com/storage/v1/object/public/server-emojis/e.png";

// ── Tests ────────────────────────────────────────────────────────────────

#[tokio::test]
#[ignore = "requires local Supabase Postgres (DATABASE_URL)"]
async fn clean_emoji_is_promoted_and_revealed() {
    let pool = test_pool().await;
    let (owner, server_id) = seed_owner_and_server(&pool).await;
    let svc = emoji_service(&pool);
    let emoji_id = seed_pending_emoji(&pool, &server_id, &owner, "clean_one", EMOJI_URL).await;

    // Pending → invisible to members.
    assert!(
        svc.list_for_server(&server_id).await.unwrap().is_empty(),
        "a pending emoji must not be listed"
    );

    let deps = build_deps(
        &pool,
        Arc::new(CleanClassifier),
        Arc::new(RecordingRemover::default()),
        svc.clone(),
    );
    scan_emoji(&deps, &emoji_id).await;

    assert_eq!(
        status_of(&pool, &emoji_id).await.as_deref(),
        Some("approved")
    );
    let listed = svc.list_for_server(&server_id).await.unwrap();
    assert_eq!(listed.len(), 1, "a promoted emoji must be listed");
    assert_eq!(listed[0].id, emoji_id);
    assert_eq!(retry_count(&pool, &emoji_id).await, 0);

    cleanup(&pool, &owner, &server_id).await;
}

#[tokio::test]
#[ignore = "requires local Supabase Postgres (DATABASE_URL)"]
async fn nsfw_emoji_is_rejected_deleted_and_object_removed() {
    let pool = test_pool().await;
    let (owner, server_id) = seed_owner_and_server(&pool).await;
    let svc = emoji_service(&pool);
    let emoji_id = seed_pending_emoji(&pool, &server_id, &owner, "bad_one", EMOJI_URL).await;

    let remover = Arc::new(RecordingRemover::default());
    let deps = build_deps(
        &pool,
        Arc::new(NsfwClassifier),
        remover.clone(),
        svc.clone(),
    );
    scan_emoji(&deps, &emoji_id).await;

    // Never revealed: the row is deleted, so nothing to list.
    assert_eq!(
        status_of(&pool, &emoji_id).await,
        None,
        "a rejected emoji row must be deleted (never revealed)"
    );
    assert!(svc.list_for_server(&server_id).await.unwrap().is_empty());
    // The flagged object was handed off for deletion.
    assert_eq!(
        remover.removed.lock().await.as_slice(),
        &[EMOJI_URL.to_string()],
        "the flagged object must be handed to the storage remover"
    );
    // The FK cascade drops the dead-letter row along with the emoji.
    assert_eq!(retry_count(&pool, &emoji_id).await, 0);

    cleanup(&pool, &owner, &server_id).await;
}

#[tokio::test]
#[ignore = "requires local Supabase Postgres (DATABASE_URL)"]
async fn scan_error_leaves_pending_and_dead_letters() {
    let pool = test_pool().await;
    let (owner, server_id) = seed_owner_and_server(&pool).await;
    let svc = emoji_service(&pool);
    let emoji_id = seed_pending_emoji(&pool, &server_id, &owner, "boom_one", EMOJI_URL).await;

    let deps = build_deps(
        &pool,
        Arc::new(ErroringClassifier),
        Arc::new(RecordingRemover::default()),
        svc.clone(),
    );
    scan_emoji(&deps, &emoji_id).await;

    assert_eq!(
        status_of(&pool, &emoji_id).await.as_deref(),
        Some("pending"),
        "a failed scan must leave the emoji pending (fail-closed)"
    );
    assert!(
        svc.list_for_server(&server_id).await.unwrap().is_empty(),
        "a still-pending emoji must never be listed"
    );
    assert_eq!(
        retry_count(&pool, &emoji_id).await,
        1,
        "a failed scan must record a dead-letter row for the retry sweep"
    );

    cleanup(&pool, &owner, &server_id).await;
}

#[tokio::test]
#[ignore = "requires local Supabase Postgres (DATABASE_URL)"]
async fn authenticated_user_cannot_self_approve_or_write_emoji() {
    // The anti-self-approval invariant: a client (the `authenticated` role) can
    // neither flip an emoji's moderation_status/url nor INSERT a pre-approved
    // emoji directly via PostgREST. server_emojis has NO write policy, so RLS
    // blocks every client write; only the service_role Rust API writes.
    let pool = test_pool().await;
    let (owner, server_id) = seed_owner_and_server(&pool).await;
    let emoji_id = seed_pending_emoji(&pool, &server_id, &owner, "locked", EMOJI_URL).await;

    // 1) Self-approval + url rewrite must NOT take effect.
    for set_clause in [
        "moderation_status = 'approved'",
        "url = 'https://evil.example.com/nsfw.png'",
    ] {
        let mut tx = pool.begin().await.expect("begin");
        sqlx::query("SET LOCAL ROLE authenticated")
            .execute(&mut *tx)
            .await
            .expect("set role");
        sqlx::query("SELECT set_config('request.jwt.claims', $1, true)")
            .bind(format!(
                r#"{{"sub": "{}", "role": "authenticated"}}"#,
                owner.0
            ))
            .execute(&mut *tx)
            .await
            .expect("set claims");
        // RLS with no UPDATE policy hides the row → 0 rows (or a permission
        // error); either way the write must not land. We assert on the effect.
        let _ = sqlx::query(&format!(
            "UPDATE server_emojis SET {set_clause} WHERE id = $1"
        ))
        .bind(emoji_id.0)
        .execute(&mut *tx)
        .await;
        drop(tx); // rollback
    }

    // The emoji is still pending with its original url — no client write landed.
    let row =
        sqlx::query("SELECT moderation_status::text AS s, url FROM server_emojis WHERE id = $1")
            .bind(emoji_id.0)
            .fetch_one(&pool)
            .await
            .expect("re-read emoji");
    let status: String = row.get("s");
    let url: String = row.get("url");
    assert_eq!(
        status, "pending",
        "self-approval must not have taken effect"
    );
    assert_eq!(url, EMOJI_URL, "url rewrite must not have taken effect");

    // 2) INSERTing a pre-approved emoji as the client must be rejected outright
    //    (no INSERT policy → RLS WITH CHECK denies).
    let mut tx = pool.begin().await.expect("begin");
    sqlx::query("SET LOCAL ROLE authenticated")
        .execute(&mut *tx)
        .await
        .expect("set role");
    sqlx::query("SELECT set_config('request.jwt.claims', $1, true)")
        .bind(format!(
            r#"{{"sub": "{}", "role": "authenticated"}}"#,
            owner.0
        ))
        .execute(&mut *tx)
        .await
        .expect("set claims");
    let insert = sqlx::query(
        r#"
        INSERT INTO server_emojis (server_id, name, url, created_by, moderation_status)
        VALUES ($1, 'injected', $2, $3, 'approved')
        "#,
    )
    .bind(server_id.0)
    .bind(EMOJI_URL)
    .bind(owner.0)
    .execute(&mut *tx)
    .await;
    drop(tx);
    assert!(
        insert.is_err(),
        "authenticated user must NOT be able to INSERT a pre-approved emoji"
    );

    cleanup(&pool, &owner, &server_id).await;
}
