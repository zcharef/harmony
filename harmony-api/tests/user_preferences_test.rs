#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! User preferences integration tests (onboarding flag persistence).
//!
//! Tests the repository + service against a real DB (local Supabase Postgres).
//! No mocks (ADR-018) — the COALESCE partial-patch semantics only exist in
//! real SQL, which is exactly what these tests pin.
//!
//! WHY #[ignore]: These tests require a running Postgres instance (local
//! Supabase). CI sets `DATABASE_URL` to a dummy value so `cargo test --all-targets`
//! would panic on connection. Run locally with
//! `cargo test --test user_preferences_test -- --ignored`.
//!
//! Test cases:
//! 1. Fresh user (no row) → service defaults with `onboarding_completed = false`
//! 2. Patch `{ onboarding_completed: true }` → persisted `true`
//! 3. Later unrelated patch (`dnd_enabled`) preserves `onboarding_completed`
//!    (server twin of the SPA optimistic-cache regression)

use std::sync::Arc;

use sqlx::PgPool;
use uuid::Uuid;

use harmony_api::domain::models::UserId;
use harmony_api::domain::ports::UpdatePreferences;
use harmony_api::domain::services::UserPreferencesService;
use harmony_api::infra::postgres::PgUserPreferencesRepository;

async fn connect_pool() -> PgPool {
    let url =
        std::env::var("DATABASE_URL").expect("DATABASE_URL must be set for integration tests");
    PgPool::connect(&url)
        .await
        .expect("connect to integration test database")
}

/// Seed a user into auth.users + profiles so the `user_preferences` FK holds.
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
    .bind(format!("prefs-test-{user_uuid}@example.com"))
    .execute(pool)
    .await
    .expect("seed auth.users");

    sqlx::query(
        r#"
        INSERT INTO profiles (id, username, display_name)
        VALUES ($1, $2, 'Prefs Tester')
        ON CONFLICT (id) DO NOTHING
        "#,
    )
    .bind(user_uuid)
    .bind(format!(
        "pt{}",
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

fn service(pool: PgPool) -> UserPreferencesService {
    UserPreferencesService::new(Arc::new(PgUserPreferencesRepository::new(pool)))
}

#[tokio::test]
#[ignore = "requires local Supabase Postgres (DATABASE_URL)"]
async fn fresh_user_defaults_to_onboarding_incomplete() {
    let pool = connect_pool().await;
    let user_id = seed_user(&pool).await;
    let svc = service(pool);

    let prefs = svc.get(&user_id).await.expect("get default preferences");

    assert!(!prefs.onboarding_completed);
}

#[tokio::test]
#[ignore = "requires local Supabase Postgres (DATABASE_URL)"]
async fn completing_onboarding_persists() {
    let pool = connect_pool().await;
    let user_id = seed_user(&pool).await;
    let svc = service(pool);

    let updated = svc
        .update(
            &user_id,
            UpdatePreferences {
                dnd_enabled: None,
                hide_profanity: None,
                onboarding_completed: Some(true),
            },
        )
        .await
        .expect("patch onboarding_completed");
    assert!(updated.onboarding_completed);

    let fetched = svc.get(&user_id).await.expect("re-read preferences");
    assert!(fetched.onboarding_completed);
}

/// Regression: a later PATCH that does NOT mention the onboarding flag must
/// preserve it (COALESCE in the upsert). This is the server-side twin of the
/// SPA optimistic-cache bug guarded in use-update-preferences.test.ts.
#[tokio::test]
#[ignore = "requires local Supabase Postgres (DATABASE_URL)"]
async fn unrelated_patch_preserves_onboarding_completed() {
    let pool = connect_pool().await;
    let user_id = seed_user(&pool).await;
    let svc = service(pool);

    svc.update(
        &user_id,
        UpdatePreferences {
            dnd_enabled: None,
            hide_profanity: None,
            onboarding_completed: Some(true),
        },
    )
    .await
    .expect("complete onboarding");

    let after_unrelated = svc
        .update(
            &user_id,
            UpdatePreferences {
                dnd_enabled: Some(true),
                hide_profanity: None,
                onboarding_completed: None,
            },
        )
        .await
        .expect("patch unrelated field");

    assert!(after_unrelated.onboarding_completed);
    assert!(after_unrelated.dnd_enabled);
}
