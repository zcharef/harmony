#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Identity-image (avatar/banner) scan-before-reveal regression tests (real DB).
//!
//! Covers the mandated per-surface invariants:
//! - CLEAN candidate → promoted: the pending image becomes the live
//!   `avatar_url`, status `approved`, `pending_avatar_url` cleared.
//! - NSFW candidate → rejected: the PREVIOUS approved image stays live, status
//!   `rejected`, `pending_avatar_url` cleared, and the flagged object is handed
//!   to the storage remover for deletion. No dead-letter row.
//! - Scan ERROR → fail-closed: the candidate stays `pending` (never revealed)
//!   AND a dead-letter row is recorded for the retry sweep.
//!
//! No mocks (ADR-018): real Postgres + hand-written classifier/remover doubles.
//!
//! WHY #[ignore]: requires a running Postgres with the Harmony schema. Run:
//!   `cargo test --test identity_image_moderation_test -- --ignored`

use std::sync::Arc;

use async_trait::async_trait;
use sqlx::PgPool;
use tokio::sync::Mutex;
use uuid::Uuid;

use harmony_api::api::identity_image_scan::{IdentityImageScanDeps, scan_pending_identity_images};
use harmony_api::domain::errors::DomainError;
use harmony_api::domain::models::{IdentityImageModerationStatus, UserId};
use harmony_api::domain::ports::{ImageClassifier, NsfwLabel, NsfwVerdict, StorageObjectRemover};
use harmony_api::domain::services::{ContentFilter, ProfileService, ServerService};
use harmony_api::infra::pg_notify_event_bus::PgNotifyEventBus;
use harmony_api::infra::postgres::{
    PgIdentityImageScanRetryRepository, PgPlanLimitChecker, PgProfileRepository, PgServerRepository,
};
use harmony_api::infra::{NoopCsamMatcher, NoopImageClassifier};

// ── Test doubles (hand-written, ADR-018) ─────────────────────────────────

/// Classifier that always labels adult-NSFW. `is_configured` stays false so the
/// pipeline never fetches bytes (the fixture URL has no real object).
#[derive(Debug)]
struct NsfwClassifier;

#[async_trait]
impl ImageClassifier for NsfwClassifier {
    async fn classify_nsfw(&self, _bytes: &[u8], _mime: &str) -> Result<NsfwVerdict, DomainError> {
        Ok(NsfwVerdict {
            score: 0.97,
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

async fn seed_user(pool: &PgPool) -> UserId {
    let user_uuid = Uuid::new_v4();
    sqlx::query(
        r#"
        INSERT INTO auth.users (id, instance_id, role, aud, email, encrypted_password, email_confirmed_at, created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change)
        VALUES ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '', now(), now(), now(), '', '', '', '')
        ON CONFLICT (id) DO NOTHING
        "#,
    )
    .bind(user_uuid)
    .bind(format!("idimg-{user_uuid}@example.com"))
    .execute(pool)
    .await
    .expect("seed auth.users");

    sqlx::query(
        r#"
        INSERT INTO profiles (id, username, display_name)
        VALUES ($1, $2, 'Img Tester')
        ON CONFLICT (id) DO NOTHING
        "#,
    )
    .bind(user_uuid)
    .bind(format!(
        "im{}",
        user_uuid
            .to_string()
            .replace('-', "")
            .get(..8)
            .unwrap_or("test0001")
    ))
    .execute(pool)
    .await
    .expect("seed profiles");

    UserId::from(user_uuid)
}

async fn cleanup(pool: &PgPool, user_id: &UserId) {
    let id = user_id.0;
    sqlx::query("DELETE FROM identity_image_scan_retry WHERE user_id = $1")
        .bind(id)
        .execute(pool)
        .await
        .ok();
    sqlx::query("DELETE FROM profiles WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await
        .ok();
    sqlx::query("DELETE FROM auth.users WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await
        .ok();
}

fn profile_service(pool: &PgPool) -> Arc<ProfileService> {
    Arc::new(ProfileService::new(
        Arc::new(PgProfileRepository::new(pool.clone())),
        Arc::new(ContentFilter::noop()),
    ))
}

fn build_deps(
    pool: &PgPool,
    classifier: Arc<dyn ImageClassifier>,
    remover: Arc<dyn StorageObjectRemover>,
    profile_service: Arc<ProfileService>,
) -> IdentityImageScanDeps {
    let server_service = Arc::new(ServerService::new(
        Arc::new(PgServerRepository::new(pool.clone())),
        Arc::new(PgPlanLimitChecker::new(pool.clone())),
        Arc::new(ContentFilter::noop()),
    ));
    let (event_bus_inner, _rx) = PgNotifyEventBus::new(Uuid::new_v4());
    IdentityImageScanDeps {
        classifier,
        matcher: Arc::new(NoopCsamMatcher),
        profile_service,
        server_service,
        retry_repo: Arc::new(PgIdentityImageScanRetryRepository::new(pool.clone())),
        storage_remover: remover,
        event_bus: Arc::new(event_bus_inner),
    }
}

async fn retry_count(pool: &PgPool, user_id: &UserId) -> i64 {
    sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM identity_image_scan_retry WHERE user_id = $1",
    )
    .bind(user_id.0)
    .fetch_one(pool)
    .await
    .expect("count retries")
}

// ── Tests ────────────────────────────────────────────────────────────────

const NEW_AVATAR: &str = "https://cdn.example.com/new-avatar.png";
const OLD_AVATAR: &str = "https://cdn.example.com/old-avatar.png";

#[tokio::test]
#[ignore = "requires local Supabase Postgres (DATABASE_URL)"]
async fn clean_candidate_is_promoted_and_revealed() {
    let pool = test_pool().await;
    let user_id = seed_user(&pool).await;
    let svc = profile_service(&pool);

    // Stage a new avatar → PENDING, not yet live.
    let staged = svc
        .update_profile(
            &user_id,
            Some(Some(NEW_AVATAR.to_string())),
            None,
            None,
            None,
            None,
        )
        .await
        .expect("stage avatar");
    assert_eq!(staged.avatar_url, None, "new avatar must not be live yet");
    assert_eq!(
        staged.avatar_moderation_status,
        IdentityImageModerationStatus::Pending
    );

    // Scan with the Noop classifier (always Clean) → promote.
    let deps = build_deps(
        &pool,
        Arc::new(NoopImageClassifier),
        Arc::new(RecordingRemover::default()),
        svc.clone(),
    );
    scan_pending_identity_images(&deps, &user_id).await;

    let after = svc.get_by_id(&user_id).await.expect("re-read");
    assert_eq!(
        after.avatar_url.as_deref(),
        Some(NEW_AVATAR),
        "clean candidate must be promoted to the live avatar"
    );
    assert_eq!(
        after.avatar_moderation_status,
        IdentityImageModerationStatus::Approved
    );
    assert_eq!(after.pending_avatar_url, None);
    assert_eq!(retry_count(&pool, &user_id).await, 0);

    cleanup(&pool, &user_id).await;
}

#[tokio::test]
#[ignore = "requires local Supabase Postgres (DATABASE_URL)"]
async fn nsfw_candidate_is_rejected_previous_kept_and_object_deleted() {
    let pool = test_pool().await;
    let user_id = seed_user(&pool).await;
    let svc = profile_service(&pool);

    // Give the user an already-approved avatar (the image everyone sees today).
    sqlx::query("UPDATE profiles SET avatar_url = $2 WHERE id = $1")
        .bind(user_id.0)
        .bind(OLD_AVATAR)
        .execute(&pool)
        .await
        .expect("seed approved avatar");

    // Stage a new avatar → PENDING (the old one stays live).
    svc.update_profile(
        &user_id,
        Some(Some(NEW_AVATAR.to_string())),
        None,
        None,
        None,
        None,
    )
    .await
    .expect("stage avatar");

    let remover = Arc::new(RecordingRemover::default());
    let deps = build_deps(
        &pool,
        Arc::new(NsfwClassifier),
        remover.clone(),
        svc.clone(),
    );
    scan_pending_identity_images(&deps, &user_id).await;

    let after = svc.get_by_id(&user_id).await.expect("re-read");
    assert_eq!(
        after.avatar_url.as_deref(),
        Some(OLD_AVATAR),
        "the previous approved avatar must stay live after a rejection"
    );
    assert_eq!(
        after.avatar_moderation_status,
        IdentityImageModerationStatus::Rejected
    );
    assert_eq!(after.pending_avatar_url, None);
    assert_eq!(
        retry_count(&pool, &user_id).await,
        0,
        "a resolved rejection must not leave a dead-letter row"
    );

    let removed = remover.removed.lock().await;
    assert_eq!(
        removed.as_slice(),
        &[NEW_AVATAR.to_string()],
        "the flagged object must be handed to the storage remover"
    );
    drop(removed);

    cleanup(&pool, &user_id).await;
}

#[tokio::test]
#[ignore = "requires local Supabase Postgres (DATABASE_URL)"]
async fn authenticated_user_cannot_self_write_reveal_or_moderation_columns() {
    // The core scan-before-reveal invariant: a user must NOT be able to bypass
    // the scan by writing the live image or moderation columns directly via
    // PostgREST. The migration revokes the `authenticated` UPDATE grant on those
    // columns, so a direct write is a permission error (service_role — the API —
    // still writes them, bypassing column grants).
    let pool = test_pool().await;
    let user_id = seed_user(&pool).await;

    // Each forbidden column write must be rejected outright.
    for set_clause in [
        "avatar_url = 'https://evil.example.com/nsfw.png'",
        "banner_url = 'https://evil.example.com/nsfw.png'",
        "avatar_moderation_status = 'approved'",
        "pending_avatar_url = 'https://evil.example.com/nsfw.png'",
    ] {
        let mut tx = pool.begin().await.expect("begin");
        sqlx::query("SET LOCAL ROLE authenticated")
            .execute(&mut *tx)
            .await
            .expect("set role");
        sqlx::query("SELECT set_config('request.jwt.claims', $1, true)")
            .bind(format!(
                r#"{{"sub": "{}", "role": "authenticated"}}"#,
                user_id.0
            ))
            .execute(&mut *tx)
            .await
            .expect("set claims");
        let result = sqlx::query(&format!("UPDATE profiles SET {set_clause} WHERE id = $1"))
            .bind(user_id.0)
            .execute(&mut *tx)
            .await;
        drop(tx); // rollback
        assert!(
            result.is_err(),
            "authenticated user must NOT be able to self-write `{set_clause}` (grant revoked)"
        );
    }

    // Control: a user MAY still directly edit a non-image column (display_name);
    // the lockdown is scoped to the reveal + moderation columns only.
    let mut tx = pool.begin().await.expect("begin");
    sqlx::query("SET LOCAL ROLE authenticated")
        .execute(&mut *tx)
        .await
        .expect("set role");
    sqlx::query("SELECT set_config('request.jwt.claims', $1, true)")
        .bind(format!(
            r#"{{"sub": "{}", "role": "authenticated"}}"#,
            user_id.0
        ))
        .execute(&mut *tx)
        .await
        .expect("set claims");
    let ok = sqlx::query("UPDATE profiles SET display_name = 'Renamed' WHERE id = $1")
        .bind(user_id.0)
        .execute(&mut *tx)
        .await;
    drop(tx);
    assert!(
        ok.is_ok(),
        "display_name must remain directly editable (not part of the image lockdown)"
    );

    cleanup(&pool, &user_id).await;
}

#[tokio::test]
#[ignore = "requires local Supabase Postgres (DATABASE_URL)"]
async fn scan_error_leaves_pending_and_dead_letters() {
    let pool = test_pool().await;
    let user_id = seed_user(&pool).await;
    let svc = profile_service(&pool);

    svc.update_profile(
        &user_id,
        Some(Some(NEW_AVATAR.to_string())),
        None,
        None,
        None,
        None,
    )
    .await
    .expect("stage avatar");

    let deps = build_deps(
        &pool,
        Arc::new(ErroringClassifier),
        Arc::new(RecordingRemover::default()),
        svc.clone(),
    );
    scan_pending_identity_images(&deps, &user_id).await;

    let after = svc.get_by_id(&user_id).await.expect("re-read");
    assert_eq!(
        after.avatar_url, None,
        "a failed scan must never reveal the candidate"
    );
    assert_eq!(
        after.avatar_moderation_status,
        IdentityImageModerationStatus::Pending,
        "a failed scan must leave the candidate pending (fail-closed)"
    );
    assert_eq!(after.pending_avatar_url.as_deref(), Some(NEW_AVATAR));
    assert_eq!(
        retry_count(&pool, &user_id).await,
        1,
        "a failed scan must record a dead-letter row for the retry sweep"
    );

    cleanup(&pool, &user_id).await;
}
