#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Moderation Dashboard v2 backend integration tests (T3.3, real DB).
//!
//! Exercises the audit log + reports queue through `ModerationService` against
//! the real schema: audit rows are written by ban/kick/message-delete, the
//! audit-log read is admin-gated, the reports flow is create → queue → resolve,
//! duplicate open reports 409, channel access + moderator gates are enforced,
//! and the per-user report rate limit trips on the 6th report.
//!
//! WHY `#[ignore]`: requires a running Postgres with the Harmony schema. Run:
//!   `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:64322/postgres \
//!      cargo test --test moderation_dashboard_test -- --ignored`

use std::sync::Arc;

use sqlx::PgPool;
use uuid::Uuid;

use harmony_api::domain::errors::DomainError;
use harmony_api::domain::models::{
    ChannelId, MessageId, ModerationAction, ReportReason, ReportStatus, ServerId, UserId,
};
use harmony_api::domain::services::{ModerationService, SpamGuard};
use harmony_api::infra::postgres::{
    PgBanRepository, PgChannelRepository, PgMemberRepository, PgMessageRepository,
    PgModerationLogRepository, PgReportRepository, PgServerRepository,
};

async fn test_pool() -> PgPool {
    dotenvy::dotenv().ok();
    let url =
        std::env::var("DATABASE_URL").expect("DATABASE_URL must be set for integration tests");
    PgPool::connect(&url)
        .await
        .expect("Failed to connect to test database")
}

fn service(pool: &PgPool) -> ModerationService {
    ModerationService::new(
        Arc::new(PgServerRepository::new(pool.clone())),
        Arc::new(PgBanRepository::new(pool.clone())),
        Arc::new(PgMemberRepository::new(pool.clone())),
        Arc::new(PgChannelRepository::new(pool.clone())),
        Arc::new(PgMessageRepository::new(pool.clone())),
        Arc::new(PgModerationLogRepository::new(pool.clone())),
        Arc::new(PgReportRepository::new(pool.clone())),
        Arc::new(SpamGuard::new()),
    )
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

    let username = format!("mod{}", &uid.simple().to_string()[..10]);
    sqlx::query(
        r#"
        INSERT INTO profiles (id, username, display_name)
        VALUES ($1, $2, 'Mod Tester')
        ON CONFLICT (id) DO UPDATE
            SET username = EXCLUDED.username, display_name = EXCLUDED.display_name
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
    sqlx::query(
        "INSERT INTO servers (id, name, owner_id, is_dm) VALUES ($1, 'Mod Server', $2, false)",
    )
    .bind(sid)
    .bind(owner)
    .execute(pool)
    .await
    .expect("seed server");
    add_member(pool, sid, owner, "owner").await;
    sid
}

async fn add_member(pool: &PgPool, server: Uuid, user: Uuid, role: &str) {
    sqlx::query(
        "INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (server_id, user_id) DO UPDATE SET role = EXCLUDED.role",
    )
    .bind(server)
    .bind(user)
    .bind(role)
    .execute(pool)
    .await
    .expect("seed membership");
}

async fn seed_channel(pool: &PgPool, server: Uuid) -> Uuid {
    let cid = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channels (id, server_id, name, is_private, encrypted) VALUES ($1, $2, 'mod-chan', false, false)",
    )
    .bind(cid)
    .bind(server)
    .execute(pool)
    .await
    .expect("seed channel");
    cid
}

async fn seed_message(pool: &PgPool, channel: Uuid, author: Uuid, content: &str) -> Uuid {
    let mid = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO messages (id, channel_id, author_id, content) VALUES ($1, $2, $3, $4)",
    )
    .bind(mid)
    .bind(channel)
    .bind(author)
    .bind(content)
    .execute(pool)
    .await
    .expect("seed message");
    mid
}

// ── Audit log ────────────────────────────────────────────────

#[tokio::test]
#[ignore = "requires a running Postgres (integration)"]
async fn ban_and_kick_write_audit_rows_and_admin_can_read_them() {
    let pool = test_pool().await;
    let svc = service(&pool);

    let owner = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    let admin = seed_user(&pool).await;
    add_member(&pool, server, admin, "admin").await;
    let target_a = seed_user(&pool).await;
    add_member(&pool, server, target_a, "member").await;
    let target_b = seed_user(&pool).await;
    add_member(&pool, server, target_b, "member").await;

    let sid = ServerId::new(server);
    let admin_id = UserId::new(admin);

    svc.ban_user(
        &sid,
        &UserId::new(target_a),
        &admin_id,
        Some("spamming".into()),
    )
    .await
    .expect("ban");
    svc.kick_member(&sid, &UserId::new(target_b), &admin_id)
        .await
        .expect("kick");

    let entries = svc
        .list_moderation_log(&sid, &admin_id, None, 50)
        .await
        .expect("admin reads audit log");

    // Newest-first: kick logged after ban.
    assert_eq!(entries.len(), 2, "expected one row per action");
    assert_eq!(entries[0].action, ModerationAction::MemberKick);
    assert_eq!(entries[1].action, ModerationAction::MemberBan);
    assert_eq!(entries[1].reason.as_deref(), Some("spamming"));
    assert_eq!(entries[1].target_user_id, Some(UserId::new(target_a)));
    assert_eq!(entries[1].actor_id, admin_id);
    assert!(!entries[1].actor_username.is_empty());
}

#[tokio::test]
#[ignore = "requires a running Postgres (integration)"]
async fn audit_log_read_is_denied_below_admin() {
    let pool = test_pool().await;
    let svc = service(&pool);

    let owner = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    let moderator = seed_user(&pool).await;
    add_member(&pool, server, moderator, "moderator").await;

    let err = svc
        .list_moderation_log(&ServerId::new(server), &UserId::new(moderator), None, 50)
        .await
        .expect_err("moderator must not read the audit log");
    assert!(matches!(err, DomainError::Forbidden(_)));
}

#[tokio::test]
#[ignore = "requires a running Postgres (integration)"]
async fn log_message_delete_records_a_message_delete_row() {
    let pool = test_pool().await;
    let svc = service(&pool);

    let owner = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    let channel = seed_channel(&pool, server).await;
    let author = seed_user(&pool).await;
    add_member(&pool, server, author, "member").await;
    let message = seed_message(&pool, channel, author, "bad words").await;

    let sid = ServerId::new(server);
    svc.log_message_delete(
        &sid,
        &UserId::new(owner),
        &MessageId::new(message),
        Some("automod".into()),
    )
    .await;

    let entries = svc
        .list_moderation_log(&sid, &UserId::new(owner), None, 50)
        .await
        .expect("owner reads audit log");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].action, ModerationAction::MessageDelete);
    assert_eq!(entries[0].target_message_id, Some(message));
    assert!(entries[0].target_user_id.is_none());
}

// ── Reports queue ────────────────────────────────────────────

#[tokio::test]
#[ignore = "requires a running Postgres (integration)"]
async fn report_flow_create_queue_resolve() {
    let pool = test_pool().await;
    let svc = service(&pool);

    let owner = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    let channel = seed_channel(&pool, server).await;
    let reporter = seed_user(&pool).await;
    add_member(&pool, server, reporter, "member").await;
    let bad_author = seed_user(&pool).await;
    add_member(&pool, server, bad_author, "member").await;
    let message = seed_message(&pool, channel, bad_author, "offensive content here").await;

    let cid = ChannelId::new(channel);
    let mid = MessageId::new(message);
    let sid = ServerId::new(server);
    let reporter_id = UserId::new(reporter);
    let owner_id = UserId::new(owner);

    let report = svc
        .create_report(&cid, &mid, &reporter_id, ReportReason::Harassment, None)
        .await
        .expect("file report");
    assert_eq!(report.reason, "harassment");
    assert_eq!(report.reported_user_id, UserId::new(bad_author));
    assert_eq!(
        report.message.snippet.as_deref(),
        Some("offensive content here")
    );
    assert!(!report.message.deleted && !report.message.encrypted);

    // Owner (admin+) is moderator+, sees the open queue with the badge count.
    let (items, open_count) = svc
        .list_reports(&sid, &owner_id, None, 50)
        .await
        .expect("owner reads reports");
    assert_eq!(open_count, 1);
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].status, ReportStatus::Open);

    // Resolve → leaves the open queue.
    let resolved = svc
        .resolve_report(&sid, &owner_id, &report.id, ReportStatus::Resolved)
        .await
        .expect("resolve");
    assert_eq!(resolved.status, ReportStatus::Resolved);
    assert_eq!(resolved.resolved_by, Some(owner_id.clone()));
    assert!(resolved.resolved_at.is_some());

    let (items, open_count) = svc.list_reports(&sid, &owner_id, None, 50).await.unwrap();
    assert_eq!(open_count, 0);
    assert!(items.is_empty());
}

#[tokio::test]
#[ignore = "requires a running Postgres (integration)"]
async fn duplicate_open_report_conflicts_then_allowed_after_resolve() {
    let pool = test_pool().await;
    let svc = service(&pool);

    let owner = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    let channel = seed_channel(&pool, server).await;
    let reporter = seed_user(&pool).await;
    add_member(&pool, server, reporter, "member").await;
    let author = seed_user(&pool).await;
    add_member(&pool, server, author, "member").await;
    let message = seed_message(&pool, channel, author, "dup me").await;

    let cid = ChannelId::new(channel);
    let mid = MessageId::new(message);
    let sid = ServerId::new(server);
    let reporter_id = UserId::new(reporter);

    let first = svc
        .create_report(&cid, &mid, &reporter_id, ReportReason::Spam, None)
        .await
        .expect("first report");

    let dup = svc
        .create_report(&cid, &mid, &reporter_id, ReportReason::Spam, None)
        .await
        .expect_err("duplicate open report must conflict");
    assert!(matches!(dup, DomainError::Conflict(_)));

    // After resolution the partial unique index no longer blocks a re-report.
    svc.resolve_report(
        &sid,
        &UserId::new(owner),
        &first.id,
        ReportStatus::Dismissed,
    )
    .await
    .expect("dismiss");
    svc.create_report(&cid, &mid, &reporter_id, ReportReason::Spam, None)
        .await
        .expect("re-report allowed after resolution");
}

#[tokio::test]
#[ignore = "requires a running Postgres (integration)"]
async fn report_requires_channel_access() {
    let pool = test_pool().await;
    let svc = service(&pool);

    let owner = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    let channel = seed_channel(&pool, server).await;
    let author = seed_user(&pool).await;
    add_member(&pool, server, author, "member").await;
    let message = seed_message(&pool, channel, author, "secret").await;

    // Outsider is NOT a member of the server.
    let outsider = seed_user(&pool).await;
    let err = svc
        .create_report(
            &ChannelId::new(channel),
            &MessageId::new(message),
            &UserId::new(outsider),
            ReportReason::Nsfw,
            None,
        )
        .await
        .expect_err("non-member cannot report");
    assert!(matches!(err, DomainError::Forbidden(_)));
}

#[tokio::test]
#[ignore = "requires a running Postgres (integration)"]
async fn reports_queue_requires_moderator() {
    let pool = test_pool().await;
    let svc = service(&pool);

    let owner = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    let member = seed_user(&pool).await;
    add_member(&pool, server, member, "member").await;

    let err = svc
        .list_reports(&ServerId::new(server), &UserId::new(member), None, 50)
        .await
        .expect_err("plain member cannot read the reports queue");
    assert!(matches!(err, DomainError::Forbidden(_)));
}

#[tokio::test]
#[ignore = "requires a running Postgres (integration)"]
async fn report_rate_limit_trips_on_sixth() {
    let pool = test_pool().await;
    let svc = service(&pool);

    let owner = seed_user(&pool).await;
    let server = seed_server(&pool, owner).await;
    let channel = seed_channel(&pool, server).await;
    let reporter = seed_user(&pool).await;
    add_member(&pool, server, reporter, "member").await;
    let author = seed_user(&pool).await;
    add_member(&pool, server, author, "member").await;

    let cid = ChannelId::new(channel);
    let reporter_id = UserId::new(reporter);

    // Five distinct messages → five reports allowed within the 60s window.
    for i in 0..5 {
        let m = seed_message(&pool, channel, author, &format!("msg {i}")).await;
        svc.create_report(
            &cid,
            &MessageId::new(m),
            &reporter_id,
            ReportReason::Spam,
            None,
        )
        .await
        .unwrap_or_else(|e| panic!("report {i} should pass: {e:?}"));
    }

    let sixth = seed_message(&pool, channel, author, "msg 6").await;
    let err = svc
        .create_report(
            &cid,
            &MessageId::new(sixth),
            &reporter_id,
            ReportReason::Spam,
            None,
        )
        .await
        .expect_err("sixth report in the window must be rate limited");
    assert!(matches!(err, DomainError::RateLimited(_)));
}
