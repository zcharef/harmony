#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Link-preview (unfurl) integration tests (real DB).
//!
//! Covers the pipeline invariants:
//! - unfurl → `message_embeds` row → `MessageUpdated` fan-out carrying the
//!   FULL message payload (id + content + embeds), asserted on a second
//!   event-bus subscriber (the SSE reader).
//! - The unfurl cache short-circuits repeat fetches (successes AND failures)
//!   — pinned with a `wiremock` `expect(1)` on the upstream.
//! - Suppression: a removed preview disappears from reads and never
//!   resurrects through a later unfurl pass.
//!
//! WHY `#[ignore]`: requires a running Postgres with the Harmony schema. Run:
//!   `DATABASE_URL=… cargo test --test link_unfurl_test -- --ignored`

use std::sync::Arc;

use sqlx::PgPool;
use uuid::Uuid;

use harmony_api::api::link_unfurl::{LinkUnfurlDeps, unfurl_message_links};
use harmony_api::domain::models::{ChannelId, MessageId, ServerEvent, ServerId, UserId};
use harmony_api::domain::ports::{EmbedRepository, EventBus, MessageRepository};
use harmony_api::domain::services::{ContentFilter, MessageService, SpamGuard};
use harmony_api::infra::link_unfurl::LinkUnfurler;
use harmony_api::infra::pg_notify_event_bus::PgNotifyEventBus;
use harmony_api::infra::postgres::{
    PgAttachmentRepository, PgChannelRepository, PgEmbedRepository, PgFriendshipRepository,
    PgMemberRepository, PgMessageRepository, PgPlanLimitChecker, PgReactionRepository,
};
use wiremock::matchers::{method, path as mock_path};
use wiremock::{Mock, MockServer, ResponseTemplate};

// ── DB pool + seeding (mirrors attachment_moderation_test) ───────────────

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
    .bind(format!("unfurl-{uid}@example.com"))
    .execute(pool)
    .await
    .expect("seed auth.users");

    let username = format!("uf{}", &uid.simple().to_string()[..10]);
    sqlx::query("INSERT INTO profiles (id, username, display_name) VALUES ($1, $2, 'Unfurl Tester') ON CONFLICT (id) DO NOTHING")
        .bind(uid)
        .bind(username)
        .execute(pool)
        .await
        .expect("seed profiles");
    uid
}

async fn seed_server(pool: &PgPool, owner: Uuid) -> Uuid {
    let sid = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO servers (id, name, owner_id, is_dm) VALUES ($1, 'Unfurl Server', $2, false)",
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

async fn seed_channel(pool: &PgPool, server: Uuid) -> Uuid {
    let cid = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channels (id, server_id, name, is_private) VALUES ($1, $2, 'unfurl-chan', false)",
    )
    .bind(cid)
    .bind(server)
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

/// Build the unfurl deps sharing `event_bus`, with the test-only unfurler that
/// allows loopback (the wiremock upstream) — every other range stays rejected.
fn build_deps(pool: &PgPool, event_bus: Arc<dyn EventBus>) -> LinkUnfurlDeps {
    LinkUnfurlDeps {
        embed_repo: Arc::new(PgEmbedRepository::new(pool.clone())),
        channel_repo: Arc::new(PgChannelRepository::new(pool.clone())),
        message_service: build_service(pool),
        event_bus,
        unfurler: Arc::new(LinkUnfurler::new_allowing_loopback_for_tests()),
    }
}

async fn send_text_message(pool: &PgPool, channel: Uuid, owner: Uuid, content: &str) -> MessageId {
    let repo = PgMessageRepository::new(pool.clone());
    let sent = repo
        .send_to_channel(
            &ChannelId::new(channel),
            &UserId::new(owner),
            content.to_string(),
            false,
            None,
            None,
            None,
            None,
            None,
            vec![],
            vec![],
            0,
        )
        .await
        .expect("send_to_channel");
    sent.message.id
}

fn fresh_bus() -> Arc<dyn EventBus> {
    let (bus_inner, _notify_rx) = PgNotifyEventBus::new(Uuid::new_v4());
    Arc::new(bus_inner)
}

const OG_PAGE: &str = r#"<html><head>
    <meta property="og:title" content="Example Article" />
    <meta property="og:description" content="A description." />
    <meta property="og:site_name" content="Example Site" />
    <meta property="og:image" content="https://cdn.example.com/hero.png" />
</head><body>hi</body></html>"#;

async fn mount_og_page(mock: &MockServer, page_path: &str, expect: u64) {
    Mock::given(method("GET"))
        .and(mock_path(page_path.to_string()))
        .respond_with(
            ResponseTemplate::new(200).set_body_raw(OG_PAGE.as_bytes().to_vec(), "text/html"),
        )
        .expect(expect)
        .mount(mock)
        .await;
}

// ── Tests ────────────────────────────────────────────────────────────────

/// End-to-end: unfurl a URL in a fresh message → `message_embeds` row exists
/// with the parsed metadata → `MessageUpdated` fans out to a second bus
/// subscriber carrying the FULL message (id + content + the embed) — the
/// established full-payload contract.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn unfurl_persists_embed_and_emits_full_message_updated() {
    let pool = test_pool().await;
    let owner = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    let channel = seed_channel(&pool, server).await;

    let mock = MockServer::start().await;
    mount_og_page(&mock, "/article", 1).await;
    let url = format!("{}/article", mock.uri());
    let content = format!("check this out {url}");
    let message_id = send_text_message(&pool, channel, owner, &content).await;

    let event_bus = fresh_bus();
    let mut rx = event_bus.subscribe(); // the SSE reader
    let deps = build_deps(&pool, event_bus.clone());

    unfurl_message_links(
        &deps,
        &message_id,
        &ChannelId::new(channel),
        &ServerId::new(server),
        &content,
    )
    .await;

    // DB row with the parsed metadata.
    let row = sqlx::query_as::<_, (String, Option<String>, Option<String>, Option<String>, bool)>(
        "SELECT url, title, site_name, image_url, suppressed FROM message_embeds WHERE message_id = $1",
    )
    .bind(message_id.0)
    .fetch_one(&pool)
    .await
    .expect("embed row exists");
    assert_eq!(row.0, url);
    assert_eq!(row.1.as_deref(), Some("Example Article"));
    assert_eq!(row.2.as_deref(), Some("Example Site"));
    assert_eq!(row.3.as_deref(), Some("https://cdn.example.com/hero.png"));
    assert!(!row.4);

    // Full-message SSE fan-out.
    let event = rx
        .try_recv()
        .expect("a MessageUpdated must have been published");
    match event {
        ServerEvent::MessageUpdated { message, .. } => {
            assert_eq!(message.id, message_id);
            // FULL message contract: content rides along, not a partial patch.
            assert_eq!(message.content, content);
            assert_eq!(message.embeds.len(), 1);
            assert_eq!(message.embeds[0].title.as_deref(), Some("Example Article"));
            assert_eq!(message.embeds[0].site_name.as_deref(), Some("Example Site"));
        }
        other => panic!("expected MessageUpdated, got {other:?}"),
    }

    // The read path (enrich) returns the embed too.
    let service = build_service(&pool);
    let page = service
        .list_for_channel(&ChannelId::new(channel), &UserId::new(owner), None, 50)
        .await
        .expect("list");
    let msg = page
        .iter()
        .find(|m| m.message.id == message_id)
        .expect("message in page");
    assert_eq!(msg.embeds.len(), 1);

    cleanup(&pool, &[server], &[owner]).await;
}

/// The cache short-circuits repeat fetches: two messages with the same URL,
/// but the upstream sees exactly ONE request (`expect(1)` verified on drop).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn unfurl_cache_prevents_refetch_of_same_url() {
    let pool = test_pool().await;
    let owner = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    let channel = seed_channel(&pool, server).await;

    let mock = MockServer::start().await;
    // Unique path per test run — the cache table is keyed by URL and shared.
    let page_path = format!("/cached-{}", Uuid::new_v4().simple());
    mount_og_page(&mock, &page_path, 1).await;
    let url = format!("{}{}", mock.uri(), page_path);

    let event_bus = fresh_bus();
    let deps = build_deps(&pool, event_bus.clone());

    for _ in 0..2 {
        let content = format!("look {url}");
        let message_id = send_text_message(&pool, channel, owner, &content).await;
        unfurl_message_links(
            &deps,
            &message_id,
            &ChannelId::new(channel),
            &ServerId::new(server),
            &content,
        )
        .await;

        let count = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*)::BIGINT FROM message_embeds WHERE message_id = $1",
        )
        .bind(message_id.0)
        .fetch_one(&pool)
        .await
        .expect("count");
        assert_eq!(count, 1, "each message gets its own embed row");
    }

    // MockServer::drop verifies the upstream saw exactly one request.
    cleanup(&pool, &[server], &[owner]).await;
}

/// Failed unfurls are negative-cached: a 404 URL produces NO embed row, and a
/// second message with the same URL does not refetch (`expect(1)`).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn failed_unfurl_is_negative_cached_and_yields_no_embed() {
    let pool = test_pool().await;
    let owner = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    let channel = seed_channel(&pool, server).await;

    let mock = MockServer::start().await;
    let page_path = format!("/dead-{}", Uuid::new_v4().simple());
    Mock::given(method("GET"))
        .and(mock_path(page_path.clone()))
        .respond_with(ResponseTemplate::new(404))
        .expect(1)
        .mount(&mock)
        .await;
    let url = format!("{}{}", mock.uri(), page_path);

    let event_bus = fresh_bus();
    let mut rx = event_bus.subscribe();
    let deps = build_deps(&pool, event_bus.clone());

    for _ in 0..2 {
        let content = format!("dead link {url}");
        let message_id = send_text_message(&pool, channel, owner, &content).await;
        unfurl_message_links(
            &deps,
            &message_id,
            &ChannelId::new(channel),
            &ServerId::new(server),
            &content,
        )
        .await;

        let count = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*)::BIGINT FROM message_embeds WHERE message_id = $1",
        )
        .bind(message_id.0)
        .fetch_one(&pool)
        .await
        .expect("count");
        assert_eq!(count, 0, "failed unfurl must not create an embed");
    }

    // No embeds resolved → no MessageUpdated fan-out at all.
    assert!(rx.try_recv().is_err(), "no event for a failed unfurl");

    cleanup(&pool, &[server], &[owner]).await;
}

/// Suppression: the author removes the preview → it disappears from batch
/// reads, and a later unfurl pass over the same message does NOT resurrect it
/// (the suppressed row blocks re-insertion).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a running Postgres with the Harmony schema"]
async fn suppressed_embed_disappears_and_never_resurrects() {
    let pool = test_pool().await;
    let owner = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    let channel = seed_channel(&pool, server).await;

    let mock = MockServer::start().await;
    let page_path = format!("/nores-{}", Uuid::new_v4().simple());
    mount_og_page(&mock, &page_path, 1).await;
    let url = format!("{}{}", mock.uri(), page_path);
    let content = format!("see {url}");
    let message_id = send_text_message(&pool, channel, owner, &content).await;

    let event_bus = fresh_bus();
    let deps = build_deps(&pool, event_bus.clone());
    unfurl_message_links(
        &deps,
        &message_id,
        &ChannelId::new(channel),
        &ServerId::new(server),
        &content,
    )
    .await;

    let embed_repo = PgEmbedRepository::new(pool.clone());
    let embeds = embed_repo
        .batch_for_messages(std::slice::from_ref(&message_id))
        .await
        .expect("batch read");
    let embed_id = embeds.get(&message_id).expect("embed present")[0]
        .id
        .clone();

    // Author removes the preview through the service (authz path included).
    let service = build_service(&pool);
    let reloaded = service
        .suppress_embed(
            &ChannelId::new(channel),
            &message_id,
            &embed_id,
            &UserId::new(owner),
        )
        .await
        .expect("suppress");
    assert!(
        reloaded.expect("message reloaded").embeds.is_empty(),
        "the reloaded full message no longer carries the preview"
    );

    // A second unfurl pass (cache hit — no upstream request) must not
    // resurrect the suppressed preview.
    unfurl_message_links(
        &deps,
        &message_id,
        &ChannelId::new(channel),
        &ServerId::new(server),
        &content,
    )
    .await;
    let embeds = embed_repo
        .batch_for_messages(std::slice::from_ref(&message_id))
        .await
        .expect("batch read after re-unfurl");
    assert!(
        !embeds.contains_key(&message_id),
        "suppressed preview must never resurrect"
    );

    // Suppressing again is NotFound (already suppressed).
    let err = service
        .suppress_embed(
            &ChannelId::new(channel),
            &message_id,
            &embed_id,
            &UserId::new(owner),
        )
        .await
        .unwrap_err();
    assert!(
        matches!(
            err,
            harmony_api::domain::errors::DomainError::NotFound { .. }
        ),
        "got {err:?}"
    );

    cleanup(&pool, &[server], &[owner]).await;
}
