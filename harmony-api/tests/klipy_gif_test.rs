#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Klipy GIF proxy tests against a `wiremock` upstream (T1.4).
//!
//! Exercises the real `KlipyClient` retry/parse logic — only the *external*
//! HTTP endpoint is faked (ADR-018: never mock our own code). Covers the happy
//! path (200 → flattened page) and upstream failure (persistent 5xx → error
//! that the handler maps to 502). The key redaction is asserted by the `Debug`
//! unit test in `src/infra/klipy.rs`.

use harmony_api::infra::klipy::{KlipyClient, KlipyError};
use secrecy::SecretString;
use serde_json::json;
use wiremock::matchers::{method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

const KEY: &str = "test-key-123";

fn trending_body() -> serde_json::Value {
    json!({
        "result": true,
        "data": {
            "data": [
                {
                    "id": 6628111025458995_i64,
                    "slug": "happy-dance",
                    "title": "Happy Dance",
                    "file": {
                        "md": {
                            "gif": { "url": "https://static.klipy.com/happy-md.gif", "width": 480, "height": 270 },
                            "webp": { "url": "https://static.klipy.com/happy-md.webp", "width": 480, "height": 270 }
                        },
                        "sm": { "gif": { "url": "https://static.klipy.com/happy-sm.gif", "width": 220, "height": 124 } }
                    }
                }
            ],
            "current_page": 1,
            "per_page": 24,
            "has_next": true
        }
    })
}

#[tokio::test]
async fn trending_success_maps_to_flattened_page() {
    let server = MockServer::start().await;

    // WHY the exact path with the key: proves the key rides as a PATH segment
    // (Klipy's scheme), and the server-side rating/per_page ceiling is applied.
    Mock::given(method("GET"))
        .and(path(format!("/{KEY}/gifs/trending")))
        .and(query_param("per_page", "24"))
        .and(query_param("rating", "pg-13"))
        .and(query_param("page", "1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(trending_body()))
        .expect(1)
        .mount(&server)
        .await;

    let client =
        KlipyClient::with_base_url(SecretString::from(KEY.to_string()), 90, server.uri()).unwrap();

    let page = client.trending(1).await.expect("trending should succeed");
    assert_eq!(page.page, 1);
    assert!(page.has_next);
    assert_eq!(page.items.len(), 1);
    let gif = &page.items[0];
    assert_eq!(gif.id, "happy-dance");
    assert_eq!(gif.title, "Happy Dance");
    assert_eq!(gif.url, "https://static.klipy.com/happy-md.gif");
    assert_eq!(gif.preview_url, "https://static.klipy.com/happy-md.webp");
    assert_eq!(gif.width, 480);
    assert_eq!(gif.height, 270);
}

#[tokio::test]
async fn search_forwards_query_and_parses() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(format!("/{KEY}/gifs/search")))
        .and(query_param("q", "cats"))
        .and(query_param("rating", "pg-13"))
        .respond_with(ResponseTemplate::new(200).set_body_json(trending_body()))
        .mount(&server)
        .await;

    let client =
        KlipyClient::with_base_url(SecretString::from(KEY.to_string()), 90, server.uri()).unwrap();

    let page = client
        .search("cats", 1)
        .await
        .expect("search should succeed");
    assert_eq!(page.items.len(), 1);
}

#[tokio::test]
async fn upstream_client_error_is_non_retryable_and_hits_once() {
    // A 4xx (bad/expired key) is a config error the handler maps to 502. It must
    // NOT be retried — assert the upstream is hit exactly once.
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(format!("/{KEY}/gifs/trending")))
        .respond_with(ResponseTemplate::new(401).set_body_string("invalid api key"))
        .expect(1)
        .mount(&server)
        .await;

    let client =
        KlipyClient::with_base_url(SecretString::from(KEY.to_string()), 90, server.uri()).unwrap();

    let err = client
        .trending(1)
        .await
        .expect_err("401 should be an error");
    assert!(
        matches!(err, KlipyError::ClientError { status: 401, .. }),
        "got {err:?}"
    );
}

#[tokio::test]
async fn upstream_server_error_exhausts_retries() {
    // A persistent 5xx is retryable; after MAX_RETRIES it surfaces as a
    // retries-exhausted/server error → the handler maps it to 502.
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(format!("/{KEY}/gifs/trending")))
        .respond_with(ResponseTemplate::new(503))
        .expect(3) // MAX_RETRIES
        .mount(&server)
        .await;

    let client =
        KlipyClient::with_base_url(SecretString::from(KEY.to_string()), 90, server.uri()).unwrap();

    let err = client.trending(1).await.expect_err("5xx should fail");
    assert!(
        matches!(
            err,
            KlipyError::ServerError(503) | KlipyError::RetriesExhausted
        ),
        "got {err:?}"
    );
}

#[tokio::test]
async fn global_budget_blocks_calls_beyond_the_cap() {
    // With a cap of 1, the second call is rejected BEFORE any network I/O — the
    // upstream is hit at most once even though we call twice.
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(format!("/{KEY}/gifs/trending")))
        .respond_with(ResponseTemplate::new(200).set_body_json(trending_body()))
        .mount(&server)
        .await;

    let client =
        KlipyClient::with_base_url(SecretString::from(KEY.to_string()), 1, server.uri()).unwrap();

    client.trending(1).await.expect("first call within budget");
    let err = client
        .trending(1)
        .await
        .expect_err("second call exceeds global budget");
    assert!(matches!(err, KlipyError::BudgetExhausted), "got {err:?}");
}
