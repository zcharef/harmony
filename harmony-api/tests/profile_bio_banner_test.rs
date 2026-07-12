#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Profile bio + banner integration tests (T1.6).
//!
//! Tests the repository + service against a real DB (local Supabase Postgres).
//! No mocks (ADR-018) — the double-option patch semantics (omit = unchanged,
//! `null` = clear) and the `chk_profiles_bio_length` CHECK constraint only
//! exist in real SQL, which is exactly what these tests pin.
//!
//! WHY #[ignore]: These tests require a running Postgres instance (local
//! Supabase). CI sets `DATABASE_URL` to a dummy value so `cargo test
//! --all-targets` would panic on connection. Run locally with
//! `cargo test --test profile_bio_banner_test -- --ignored`.

use std::sync::Arc;

use sqlx::PgPool;
use uuid::Uuid;

use harmony_api::domain::models::{IdentityImageModerationStatus, UserId};
use harmony_api::domain::services::{ContentFilter, ProfileService};
use harmony_api::infra::postgres::PgProfileRepository;

async fn connect_pool() -> PgPool {
    let url =
        std::env::var("DATABASE_URL").expect("DATABASE_URL must be set for integration tests");
    PgPool::connect(&url)
        .await
        .expect("connect to integration test database")
}

/// Seed a user into auth.users + profiles so the profile row exists.
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
    .bind(format!("bio-test-{user_uuid}@example.com"))
    .execute(pool)
    .await
    .expect("seed auth.users");

    sqlx::query(
        r#"
        INSERT INTO profiles (id, username, display_name)
        VALUES ($1, $2, 'Bio Tester')
        ON CONFLICT (id) DO NOTHING
        "#,
    )
    .bind(user_uuid)
    .bind(format!(
        "bt{}",
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

fn service(pool: PgPool) -> ProfileService {
    ProfileService::new(
        Arc::new(PgProfileRepository::new(pool)),
        Arc::new(ContentFilter::noop()),
        false,
    )
}

#[tokio::test]
#[ignore = "requires local Supabase Postgres (DATABASE_URL)"]
async fn bio_and_banner_persist_and_round_trip() {
    let pool = connect_pool().await;
    let user_id = seed_user(&pool).await;
    let svc = service(pool);

    let updated = svc
        .update_profile(
            &user_id,
            None,
            None,
            None,
            Some(Some("Building [Harmony](https://example.com).".to_string())),
            Some(Some("https://cdn.example.com/banner.png".to_string())),
        )
        .await
        .expect("patch bio + banner");

    assert_eq!(
        updated.bio.as_deref(),
        Some("Building [Harmony](https://example.com).")
    );
    // Scan-before-reveal: a newly-set banner is staged PENDING — it is NOT the
    // live image until an async scan clears it, so `banner_url` (the displayed
    // field) stays cleared and the candidate lives in `pending_banner_url`.
    assert_eq!(
        updated.banner_url, None,
        "new banner must not be revealed before its scan clears"
    );
    assert_eq!(
        updated.pending_banner_url.as_deref(),
        Some("https://cdn.example.com/banner.png")
    );
    assert_eq!(
        updated.banner_moderation_status,
        IdentityImageModerationStatus::Pending
    );

    // Re-read via get_by_id (the GET /v1/profiles/{id} path): still pending.
    let fetched = svc.get_by_id(&user_id).await.expect("re-read profile");
    assert_eq!(
        fetched.bio.as_deref(),
        Some("Building [Harmony](https://example.com).")
    );
    assert_eq!(fetched.banner_url, None);
    assert_eq!(
        fetched.pending_banner_url.as_deref(),
        Some("https://cdn.example.com/banner.png")
    );
}

#[tokio::test]
#[ignore = "requires local Supabase Postgres (DATABASE_URL)"]
async fn explicit_null_clears_bio_but_omitting_banner_preserves_it() {
    let pool = connect_pool().await;
    let user_id = seed_user(&pool).await;
    let svc = service(pool);

    // Set both.
    svc.update_profile(
        &user_id,
        None,
        None,
        None,
        Some(Some("first bio".to_string())),
        Some(Some("https://cdn.example.com/b.png".to_string())),
    )
    .await
    .expect("seed bio + banner");

    // Clear bio (Some(None)), omit banner (None) → the pending banner candidate
    // must survive (double-option patch: omitted = unchanged).
    let after = svc
        .update_profile(&user_id, None, None, None, Some(None), None)
        .await
        .expect("clear bio, leave banner");

    assert_eq!(after.bio, None, "explicit null must clear bio");
    assert_eq!(
        after.pending_banner_url.as_deref(),
        Some("https://cdn.example.com/b.png"),
        "omitted banner candidate must be unchanged (double-option patch)"
    );
    assert_eq!(
        after.banner_moderation_status,
        IdentityImageModerationStatus::Pending
    );
}

/// The `chk_profiles_bio_length` CHECK is a defense-in-depth backstop for writes
/// that bypass the service layer (admin scripts, sync). A 191-char bio must be
/// rejected by Postgres even though the service would have caught it first.
#[tokio::test]
#[ignore = "requires local Supabase Postgres (DATABASE_URL)"]
async fn bio_over_190_chars_violates_check_constraint() {
    let pool = connect_pool().await;
    let user_id = seed_user(&pool).await;
    let raw = user_id.0;

    let result = sqlx::query("UPDATE profiles SET bio = $2 WHERE id = $1")
        .bind(raw)
        .bind("a".repeat(191))
        .execute(&pool)
        .await;

    let err = result.expect_err("191-char bio must violate chk_profiles_bio_length");
    let message = err.to_string();
    assert!(
        message.contains("chk_profiles_bio_length"),
        "expected bio length CHECK violation, got: {message}"
    );
}

/// A 190-char bio writes cleanly at the DB layer — the boundary is inclusive.
#[tokio::test]
#[ignore = "requires local Supabase Postgres (DATABASE_URL)"]
async fn bio_at_190_chars_satisfies_check_constraint() {
    let pool = connect_pool().await;
    let user_id = seed_user(&pool).await;
    let raw = user_id.0;

    sqlx::query("UPDATE profiles SET bio = $2 WHERE id = $1")
        .bind(raw)
        .bind("a".repeat(190))
        .execute(&pool)
        .await
        .expect("190-char bio must satisfy the CHECK constraint");
}
