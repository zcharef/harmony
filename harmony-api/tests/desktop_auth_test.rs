#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Desktop auth exchange tests (E12 — independent desktop session).
//!
//! Two levels, per the no-mock rule (ADR-018: real DB + real HTTP, external
//! HTTP only via `wiremock`):
//!
//!  1. `SupabaseAdminClient` against a `wiremock` `GoTrue` — proves redeem mints a
//!     FRESH, INDEPENDENT session for the CORRECT user (the browser's refresh
//!     token is never forwarded), and classifies upstream failures.
//!  2. `PgDesktopAuthRepository` against the real DB (`#[ignore]`, local) —
//!     proves the code binds to its creator's `user_id`, is single-use, and
//!     expires. These pin the security guarantees the redeem handler relies on.

use harmony_api::domain::models::UserId;
use harmony_api::domain::ports::SessionMinter;
use harmony_api::infra::supabase_admin::SupabaseAdminClient;
use secrecy::SecretString;
use serde_json::json;
use uuid::Uuid;
use wiremock::matchers::{body_partial_json, method, path, path_regex};
use wiremock::{Mock, MockServer, ResponseTemplate};

const SERVICE_ROLE_KEY: &str = "test-service-role-key";
const USER_EMAIL: &str = "desktop-user@example.com";
const MINTED_ACCESS: &str = "minted-access-token-xyz";
const MINTED_REFRESH: &str = "minted-refresh-token-xyz";
const HASHED_TOKEN: &str = "hashed-magiclink-token-abc";

/// Mount the three `GoTrue` admin endpoints the mint flow calls.
///
/// The binding chain is enforced by the mocks: `generate_link` only matches
/// when called with the email that `admin/users/{id}` returned, and `verify`
/// only matches the `token_hash` that `generate_link` returned. If any link is
/// wrong, wiremock 404s and the mint fails — so a passing test proves the whole
/// chain resolves the correct user's session.
async fn mount_gotrue(server: &MockServer) {
    // 1. Resolve email for ANY user id (the caller controls the id).
    Mock::given(method("GET"))
        .and(path_regex(r"^/auth/v1/admin/users/.+$"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "email": USER_EMAIL })))
        .mount(server)
        .await;

    // 2. Mint a magic-link hashed_token — ONLY for the resolved email.
    Mock::given(method("POST"))
        .and(path("/auth/v1/admin/generate_link"))
        .and(body_partial_json(
            json!({ "type": "magiclink", "email": USER_EMAIL }),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "hashed_token": HASHED_TOKEN,
            "verification_type": "magiclink",
        })))
        .mount(server)
        .await;

    // 3. Exchange the token_hash for a fresh, independent session.
    Mock::given(method("POST"))
        .and(path("/auth/v1/verify"))
        .and(body_partial_json(
            json!({ "type": "magiclink", "token_hash": HASHED_TOKEN }),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "access_token": MINTED_ACCESS,
            "token_type": "bearer",
            "expires_in": 3600,
            "refresh_token": MINTED_REFRESH,
        })))
        .mount(server)
        .await;
}

fn admin_client(base_url: &str) -> SupabaseAdminClient {
    SupabaseAdminClient::new(base_url, SecretString::from(SERVICE_ROLE_KEY.to_string())).unwrap()
}

// ── Level 1: SupabaseAdminClient against wiremock GoTrue (runs in CI) ────────

#[tokio::test]
async fn mint_session_returns_independent_session_for_the_user() {
    let server = MockServer::start().await;
    mount_gotrue(&server).await;

    let client = admin_client(&server.uri());
    let session = client
        .mint_session(UserId::new(Uuid::new_v4()))
        .await
        .expect("mint should succeed");

    // The returned tokens are the freshly MINTED ones from `/verify` — not any
    // forwarded web refresh token (there is no web token in the flow anymore).
    assert_eq!(session.access_token, MINTED_ACCESS);
    assert_eq!(session.refresh_token, MINTED_REFRESH);
}

#[tokio::test]
async fn mint_session_maps_upstream_5xx_to_external_service() {
    let server = MockServer::start().await;
    // Persistent 5xx on the first hop → retried, then exhausted.
    Mock::given(method("GET"))
        .and(path_regex(r"^/auth/v1/admin/users/.+$"))
        .respond_with(ResponseTemplate::new(503))
        .mount(&server)
        .await;

    let client = admin_client(&server.uri());
    let err = client
        .mint_session(UserId::new(Uuid::new_v4()))
        .await
        .expect_err("5xx should fail");
    // Maps to DomainError::ExternalService (→ 502), never Internal (→ 500).
    assert!(
        matches!(
            err,
            harmony_api::domain::errors::DomainError::ExternalService(_)
        ),
        "expected ExternalService, got {err:?}"
    );
}

#[tokio::test]
async fn mint_session_maps_unknown_user_4xx_to_external_service() {
    let server = MockServer::start().await;
    // 404 (unknown user / bad key) is non-retryable.
    Mock::given(method("GET"))
        .and(path_regex(r"^/auth/v1/admin/users/.+$"))
        .respond_with(ResponseTemplate::new(404).set_body_json(json!({ "msg": "user not found" })))
        .mount(&server)
        .await;

    let client = admin_client(&server.uri());
    let err = client
        .mint_session(UserId::new(Uuid::new_v4()))
        .await
        .expect_err("404 should fail");
    assert!(matches!(
        err,
        harmony_api::domain::errors::DomainError::ExternalService(_)
    ));
}

// ── Level 2: PgDesktopAuthRepository against the real DB (local, #[ignore]) ──

mod repo {
    use super::*;
    use chrono::{Duration, Utc};
    use harmony_api::domain::ports::DesktopAuthRepository;
    use harmony_api::infra::postgres::PgDesktopAuthRepository;
    use sqlx::PgPool;

    async fn test_pool() -> PgPool {
        dotenvy::dotenv().ok();
        let url =
            std::env::var("DATABASE_URL").expect("DATABASE_URL must be set for integration tests");
        PgPool::connect(&url)
            .await
            .expect("connect to test database")
    }

    const CHALLENGE: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; // 43 chars

    #[tokio::test]
    #[ignore = "requires local Postgres"]
    async fn create_then_redeem_round_trips_user_id_and_is_single_use() {
        let pool = test_pool().await;
        let repo = PgDesktopAuthRepository::new(pool);

        let code = format!("{:064x}", rand::random::<u128>());
        let user_id = UserId::new(Uuid::new_v4());
        let expires_at = Utc::now() + Duration::seconds(60);

        repo.create_code(&code, CHALLENGE, user_id.clone(), expires_at)
            .await
            .expect("create");

        // First redeem: returns the SAME user the code was bound to (binding).
        let redeemed = repo.redeem_code(&code).await.expect("redeem").expect("row");
        assert_eq!(redeemed.user_id, user_id, "redeem must bind to the creator");
        assert_eq!(redeemed.code_challenge, CHALLENGE);

        // Second redeem: the code is consumed (single-use) → None.
        let second = repo.redeem_code(&code).await.expect("redeem2");
        assert!(second.is_none(), "code must be single-use");
    }

    #[tokio::test]
    #[ignore = "requires local Postgres"]
    async fn redeem_rejects_expired_code() {
        let pool = test_pool().await;
        let repo = PgDesktopAuthRepository::new(pool);

        let code = format!("{:064x}", rand::random::<u128>());
        let expired = Utc::now() - Duration::seconds(1);
        repo.create_code(&code, CHALLENGE, UserId::new(Uuid::new_v4()), expired)
            .await
            .expect("create");

        let redeemed = repo.redeem_code(&code).await.expect("redeem");
        assert!(redeemed.is_none(), "expired code must not redeem");
    }

    #[tokio::test]
    #[ignore = "requires local Postgres"]
    async fn redeem_rejects_unknown_code() {
        let pool = test_pool().await;
        let repo = PgDesktopAuthRepository::new(pool);
        let unknown = format!("{:064x}", rand::random::<u128>());
        let redeemed = repo.redeem_code(&unknown).await.expect("redeem");
        assert!(redeemed.is_none(), "unknown code must not redeem");
    }
}
