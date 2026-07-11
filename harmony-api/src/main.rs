#![warn(
    dead_code,
    unused_variables,
    unused_imports,
    unused_mut,
    unreachable_code
)]
// WHY: main.rs is the composition root — process::exit on fatal startup errors is acceptable.
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use harmony_api::{api, config, domain, infra};

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use opentelemetry::trace::TracerProvider as _;
use opentelemetry_otlp::{SpanExporter, WithExportConfig};
use opentelemetry_sdk::Resource;
use opentelemetry_sdk::trace::SdkTracerProvider;
use secrecy::ExposeSecret;
use sentry::integrations::tracing::EventFilter;
use tokio::signal;
use tracing_opentelemetry::OpenTelemetryLayer;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use api::AppState;
use api::router::build_router;
use config::Config;

#[tokio::main]
async fn main() {
    // WHY: livekit-api enables `rust_crypto` while harmony-api uses `aws_lc_rs`.
    // Both features active causes jsonwebtoken v10 to panic. Explicitly selecting
    // aws_lc_rs before any JWT operation prevents the conflict.
    let _ = jsonwebtoken::crypto::aws_lc::DEFAULT_PROVIDER.install_default();

    // 1. Load configuration (fail-fast if invalid)
    let config = Config::init();

    // 2. Initialize Sentry (must be before tracing!)
    let _sentry_guard = init_sentry(&config);

    // 3. Initialize tracing
    let tracer_provider = init_tracing(&config);

    tracing::info!(
        port = config.server_port,
        environment = %config.environment,
        otel_enabled = tracer_provider.is_some(),
        "Starting Harmony API"
    );

    // 4. Initialize infrastructure services
    let AppInit {
        state,
        instance_id,
        event_notify_rx,
        event_local_tx,
        presence_write_rx,
        presence_cache_handle,
    } = init_app_state(&config).await;

    // 5. Background tasks: sweep stale presence entries + expired mutes every 60s
    spawn_presence_sweep(state.clone());
    spawn_spam_guard_sweep(state.spam_guard().clone());
    spawn_moderation_retry_sweep(state.clone());
    spawn_attachment_scan_sweep(state.clone());
    spawn_identity_image_scan_sweep(state.clone());
    spawn_voice_session_sweep(state.clone());

    // Background tasks: PG LISTEN/NOTIFY workers for cross-instance SSE + presence
    let cancel = tokio_util::sync::CancellationToken::new();

    tokio::spawn(infra::pg_notify_event_bus::event_notify_worker(
        state.pool().clone(),
        instance_id,
        event_notify_rx,
    ));
    tokio::spawn(infra::pg_notify_event_bus::event_listen_worker(
        state.pool().clone(),
        instance_id,
        event_local_tx,
        cancel.clone(),
    ));
    tokio::spawn(infra::pg_presence_tracker::presence_write_worker(
        state.pool().clone(),
        instance_id,
        presence_write_rx,
    ));
    tokio::spawn(infra::pg_presence_tracker::presence_listen_worker(
        state.pool().clone(),
        instance_id,
        presence_cache_handle,
        cancel.clone(),
    ));

    // 6. Build router with middleware stack
    let app = build_router(state.clone(), config.livekit_url.as_deref());

    // 7. Start server with graceful shutdown
    let addr = SocketAddr::from(([0, 0, 0, 0], config.server_port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("Failed to bind to address");

    tracing::info!("Listening on {}", addr);
    tracing::info!(
        "Swagger UI available at http://localhost:{}/swagger-ui",
        config.server_port
    );

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("Server error");

    // WHY: cleanup_instance BEFORE cancel — presence writes need PG access.
    state.presence_tracker().cleanup_instance().await;
    cancel.cancel();
    tracing::info!("PgListener tasks cancelled, presence cleaned up");

    // Flush pending OTel spans before exit
    if let Some(provider) = tracer_provider
        && let Err(e) = provider.shutdown()
    {
        tracing::error!(error = %e, "OpenTelemetry shutdown error");
    }
}

/// Pieces needed to spawn background tasks after `AppState` is constructed.
struct AppInit {
    state: AppState,
    instance_id: uuid::Uuid,
    event_notify_rx: tokio::sync::mpsc::UnboundedReceiver<crate::domain::models::ServerEvent>,
    event_local_tx: tokio::sync::broadcast::Sender<crate::domain::models::ServerEvent>,
    presence_write_rx:
        tokio::sync::mpsc::UnboundedReceiver<infra::pg_presence_tracker::PresenceCommand>,
    presence_cache_handle: std::sync::Arc<
        dashmap::DashMap<crate::domain::models::UserId, infra::pg_presence_tracker::PresenceEntry>,
    >,
}

/// Initialize application state with Postgres pool, services, and repositories.
async fn init_app_state(config: &Config) -> AppInit {
    // Initialize Postgres connection pool
    let pool = infra::postgres::create_pool(&config.database_url, config.max_db_connections).await;
    tracing::info!("Postgres connection pool initialized");

    // Verify database connectivity at startup
    if let Err(e) = infra::postgres::ping(&pool).await {
        tracing::error!(error = %e, "Database connectivity check failed at startup");
        panic!("Cannot connect to Postgres: {}", e);
    }
    tracing::info!("Database connectivity verified");

    // Fetch ES256 public key from Supabase JWKS (newer CLI versions sign with ECDSA)
    let es256_key = fetch_supabase_jwks(config).await;

    // Construct Postgres adapters (ports → adapters)
    let profile_repo = Arc::new(infra::postgres::PgProfileRepository::new(pool.clone()));
    let server_repo = Arc::new(infra::postgres::PgServerRepository::new(pool.clone()));
    let message_repo = Arc::new(infra::postgres::PgMessageRepository::new(pool.clone()));
    let channel_repo = Arc::new(infra::postgres::PgChannelRepository::new(pool.clone()));
    let invite_repo = Arc::new(infra::postgres::PgInviteRepository::new(pool.clone()));
    let member_repo = Arc::new(infra::postgres::PgMemberRepository::new(pool.clone()));
    let ban_repo = Arc::new(infra::postgres::PgBanRepository::new(pool.clone()));
    let dm_repo = Arc::new(infra::postgres::PgDmRepository::new(pool.clone()));
    let friendship_repo = Arc::new(infra::postgres::PgFriendshipRepository::new(pool.clone()));
    let key_repo = Arc::new(infra::postgres::PgKeyRepository::new(pool.clone()));
    let reaction_repo = Arc::new(infra::postgres::PgReactionRepository::new(pool.clone()));
    let attachment_repo = Arc::new(infra::postgres::PgAttachmentRepository::new(pool.clone()));
    let read_state_repo = Arc::new(infra::postgres::PgReadStateRepository::new(pool.clone()));

    // WHY: Self-hosted deployments have no plan restrictions (AlwaysAllowedChecker).
    // SaaS deployments enforce Free/Pro limits via Postgres queries (PgPlanLimitChecker).
    let plan_limit_checker: Arc<dyn crate::domain::ports::PlanLimitChecker> =
        if config.plan_enforcement_enabled {
            tracing::info!("Plan limit enforcement ENABLED (SaaS mode)");
            Arc::new(infra::postgres::PgPlanLimitChecker::new(pool.clone()))
        } else {
            tracing::info!("Plan limit enforcement DISABLED (self-hosted mode)");
            Arc::new(infra::AlwaysAllowedChecker)
        };

    // Content moderation filter (AutoMod)
    let content_filter: Arc<domain::services::ContentFilter> = if config.content_moderation_enabled
    {
        tracing::info!("Content moderation ENABLED");
        Arc::new(domain::services::ContentFilter::new())
    } else {
        tracing::info!("Content moderation DISABLED (self-hosted mode)");
        Arc::new(domain::services::ContentFilter::noop())
    };

    // Construct domain services (injected with repository ports)
    let profile_service = Arc::new(domain::services::ProfileService::new(
        profile_repo.clone(),
        content_filter.clone(),
    ));
    let server_service = Arc::new(domain::services::ServerService::new(
        server_repo.clone(),
        plan_limit_checker.clone(),
        content_filter.clone(),
    ));
    let spam_guard = Arc::new(domain::services::SpamGuard::with_enabled(
        config.spam_guard_enabled,
    ));
    if !config.spam_guard_enabled {
        tracing::warn!(
            "SpamGuard DISABLED (SPAM_GUARD_ENABLED=false) — anti-abuse checks bypassed"
        );
    }
    // WHY: Clone before message_repo is moved into MessageService.
    // Needed for async moderation soft-delete in the handler layer.
    let message_repo_for_moderation: Arc<dyn domain::ports::MessageRepository> =
        message_repo.clone();
    // WHY: Clone before server_repo is moved into DmService.
    // Needed for fetching moderation categories inside `tokio::spawn`.
    let server_repo_for_moderation: Arc<dyn domain::ports::ServerRepository> = server_repo.clone();

    // WHY: Construct OpenAI moderator only when API key is configured.
    // When None, async content moderation is disabled (graceful degradation).
    // WHY: Filter empty strings — an empty OPENAI_API_KEY="" would create a
    // moderator that always fails with 401, wasting 7s of retries per message.
    let content_moderator: Option<Arc<dyn domain::ports::ContentModerator>> = config
        .openai_api_key
        .as_ref()
        .filter(|key| !key.expose_secret().is_empty())
        .map(|key| {
            tracing::info!("OpenAI Moderation API enabled");
            Arc::new(infra::OpenAiModerator::new(key.clone()))
                as Arc<dyn domain::ports::ContentModerator>
        });

    // WHY: Construct Safe Browsing client only when API key is configured.
    let safe_browsing: Option<Arc<infra::safe_browsing::SafeBrowsingClient>> = config
        .safe_browsing_api_key
        .as_ref()
        .filter(|key| !key.expose_secret().is_empty())
        .and_then(
            |key| match infra::safe_browsing::SafeBrowsingClient::new(key.clone()) {
                Ok(client) => {
                    tracing::info!("Google Safe Browsing API enabled");
                    Some(Arc::new(client))
                }
                Err(e) => {
                    tracing::warn!(error = %e, "Failed to initialize Safe Browsing client");
                    None
                }
            },
        );

    // WHY: Construct the Klipy GIF client only when a key is configured. When
    // absent, the `/v1/gifs/*` endpoints return 503 and the client hides the
    // picker — no panic, mirroring Safe Browsing / LiveKit optionality.
    let klipy_global_max = config
        .klipy_global_max_per_hour
        .unwrap_or(infra::klipy::DEFAULT_GLOBAL_MAX_PER_HOUR);
    let klipy: Option<Arc<infra::klipy::KlipyClient>> = config
        .klipy_api_key
        .as_ref()
        .filter(|key| !key.expose_secret().is_empty())
        .and_then(
            |key| match infra::klipy::KlipyClient::new(key.clone(), klipy_global_max) {
                Ok(client) => {
                    tracing::info!(
                        global_max_per_hour = klipy_global_max,
                        "Klipy GIF API enabled"
                    );
                    Some(Arc::new(client))
                }
                Err(e) => {
                    tracing::warn!(error = %e, "Failed to initialize Klipy client");
                    None
                }
            },
        );

    // C3: Dead-letter queue for failed AI moderation checks (Tier 1 safety).
    let moderation_retry_repo = Arc::new(infra::postgres::PgModerationRetryRepository::new(
        pool.clone(),
    ));

    // Image content-moderation (spec §c.3). Phase 1 wires the Noop classifier +
    // matcher so the whole pending→scan→approved pipeline + SSE flip runs with
    // no external dependency. The in-process ONNX NSFW classifier (Phase 2) and
    // a real CSAM matcher (Phase 3) are documented follow-ups — swapping them in
    // touches only this wiring, never the pipeline.
    let image_classifier: Arc<dyn domain::ports::ImageClassifier> = match (
        config.nsfw_classifier_enabled,
        config.nsfw_model_path.as_deref(),
    ) {
        // On success the classifier logs the canonical "loaded ONNX model —
        // detection ACTIVE" line (with the model byte size) from `load()`.
        (true, Some(model_path)) => match infra::OnnxNsfwClassifier::load(model_path) {
            Ok(classifier) => Arc::new(classifier),
            // Fail-SAFE, not fail-open on the CSAM axis: a missing/invalid
            // NSFW model only means adult content is not auto-detected (it can
            // never quarantine — that is CSAM's job). error! so an operator is
            // paged (ADR-046) that the classifier silently degraded to Noop.
            Err(e) => {
                tracing::error!(
                    model_path,
                    error = %e,
                    "nsfw classifier: model load failed, using Noop — adult-NSFW detection DISABLED"
                );
                Arc::new(infra::NoopImageClassifier)
            }
        },
        (true, None) => {
            tracing::warn!(
                "NSFW_CLASSIFIER_ENABLED is set but NSFW_MODEL_PATH is empty — using Noop (images auto-approved)"
            );
            Arc::new(infra::NoopImageClassifier)
        }
        (false, _) => {
            tracing::info!("Adult-NSFW image classifier: Noop (disabled)");
            Arc::new(infra::NoopImageClassifier)
        }
    };
    let csam_matcher: Arc<dyn domain::ports::CsamMatcher> = Arc::new(infra::NoopCsamMatcher);
    if config.attachments_require_csam_scan && !csam_matcher.is_configured() {
        tracing::warn!(
            "ATTACHMENTS_REQUIRE_CSAM_SCAN is set but no real CSAM matcher is configured — image attachments will be REFUSED (fail closed)"
        );
    }
    let attachment_scan_retry_repo = Arc::new(
        infra::postgres::PgAttachmentScanRetryRepository::new(pool.clone()),
    );
    // WHY clone before the move into MessageService: the async scan task writes
    // moderation status through this same repository port.
    let attachment_repo_for_scan: Arc<dyn domain::ports::AttachmentRepository> =
        attachment_repo.clone();

    let message_service = Arc::new(domain::services::MessageService::new(
        message_repo.clone(),
        channel_repo.clone(),
        member_repo.clone(),
        plan_limit_checker.clone(),
        reaction_repo.clone(),
        attachment_repo,
        content_filter.clone(),
        spam_guard.clone(),
        friendship_repo.clone(),
    ));
    let invite_service = Arc::new(domain::services::InviteService::new(
        invite_repo,
        member_repo.clone(),
        ban_repo.clone(),
        server_repo.clone(),
        plan_limit_checker.clone(),
    ));
    let channel_service = Arc::new(domain::services::ChannelService::new(
        channel_repo.clone(),
        server_repo.clone(),
        plan_limit_checker.clone(),
        content_filter,
    ));
    let moderation_log_repo = Arc::new(infra::postgres::PgModerationLogRepository::new(
        pool.clone(),
    ));
    let report_repo = Arc::new(infra::postgres::PgReportRepository::new(pool.clone()));
    let moderation_service = Arc::new(domain::services::ModerationService::new(
        server_repo.clone(),
        ban_repo.clone(),
        member_repo.clone(),
        channel_repo.clone(),
        message_repo.clone(),
        moderation_log_repo,
        report_repo,
        spam_guard.clone(),
    ));
    let friendship_service = Arc::new(domain::services::FriendshipService::new(
        friendship_repo.clone(),
        profile_repo.clone(),
        spam_guard.clone(),
    ));
    let dm_service = Arc::new(domain::services::DmService::new(
        dm_repo,
        profile_repo,
        server_repo,
        member_repo.clone(),
        plan_limit_checker.clone(),
        friendship_repo,
    ));
    let key_service = Arc::new(domain::services::KeyService::new(key_repo));
    let reaction_service = Arc::new(domain::services::ReactionService::new(
        reaction_repo,
        channel_repo.clone(),
        member_repo.clone(),
        message_repo,
        spam_guard.clone(),
    ));
    let read_state_service = Arc::new(domain::services::ReadStateService::new(
        read_state_repo,
        channel_repo.clone(),
        member_repo.clone(),
    ));
    let megolm_session_repo = Arc::new(infra::postgres::PgMegolmSessionRepository::new(
        pool.clone(),
    ));
    let desktop_auth_repo = Arc::new(infra::postgres::PgDesktopAuthRepository::new(pool.clone()));
    let notification_settings_repo = Arc::new(
        infra::postgres::PgNotificationSettingsRepository::new(pool.clone()),
    );
    let notification_settings_service = Arc::new(
        // WHY channel/member repos: the PATCH path enforces channel access
        // (server membership + private-channel grant) before writing.
        domain::services::NotificationSettingsService::new(
            notification_settings_repo,
            channel_repo.clone(),
            member_repo.clone(),
        ),
    );
    let user_preferences_repo = Arc::new(infra::postgres::PgUserPreferencesRepository::new(
        pool.clone(),
    ));
    let user_preferences_service = Arc::new(domain::services::UserPreferencesService::new(
        user_preferences_repo,
    ));

    // Generate unique instance ID for this API process (cross-instance dedup)
    let instance_id = uuid::Uuid::new_v4();
    tracing::info!(%instance_id, "API instance ID generated");

    // Initialize PG-backed event bus (dual-path: local broadcast + pg_notify)
    let (event_bus_inner, event_notify_rx) = infra::PgNotifyEventBus::new(instance_id);
    let event_local_tx = event_bus_inner.local_sender().clone();
    let event_bus: Arc<dyn domain::ports::EventBus> = Arc::new(event_bus_inner);

    // Initialize PG-backed presence tracker (local DashMap cache + Postgres SSoT)
    let (presence_inner, presence_write_rx) =
        infra::PgPresenceTracker::new(instance_id, pool.clone());
    presence_inner
        .hydrate()
        .await
        .expect("Failed to hydrate presence cache from Postgres");
    let presence_cache_handle = presence_inner.local_cache_handle();
    let presence_tracker = Arc::new(presence_inner);

    // WHY: Construct voice service only when all three LiveKit env vars are set.
    // When None, voice handlers return 503 directly (graceful degradation).
    let (voice_service, voice_session_repo): (
        Option<Arc<domain::services::VoiceService>>,
        Option<Arc<dyn domain::ports::VoiceSessionRepository>>,
    ) = if config.livekit_enabled() {
        let livekit_url = config.livekit_url.as_deref().unwrap().to_string();
        let livekit_key = config.livekit_api_key.clone().unwrap();
        let livekit_secret = config.livekit_api_secret.clone().unwrap();
        let livekit_service = Arc::new(infra::livekit::LiveKitTokenService::new(
            livekit_url,
            livekit_key,
            livekit_secret,
            config.livekit_token_ttl_secs,
        ));
        let voice_repo: Arc<dyn domain::ports::VoiceSessionRepository> =
            Arc::new(infra::postgres::PgVoiceSessionRepository::new(pool.clone()));

        tracing::info!("Voice channels ENABLED (LiveKit configured)");
        let svc = Arc::new(domain::services::VoiceService::new(
            voice_repo.clone(),
            channel_repo.clone(),
            member_repo.clone(),
            plan_limit_checker.clone(),
            livekit_service,
        ));
        (Some(svc), Some(voice_repo))
    } else {
        tracing::info!("Voice channels DISABLED (LiveKit not configured)");
        (None, None)
    };

    // Analytics recorder (growth-plan §10 funnel events, fire-and-forget).
    let analytics_recorder: Arc<dyn domain::ports::AnalyticsRecorder> =
        Arc::new(infra::postgres::PgAnalyticsRecorder::new(pool.clone()));

    tracing::info!("Domain services initialized");

    // WHY normalize at startup: attachment URL validation pins the origin
    // (scheme://host[:port]) of every attachment to OUR Supabase instance.
    // Unset/unparseable/non-http(s) → None → attachment sends are rejected
    // (fail closed), never accepted unverified.
    let attachment_url_origin =
        config
            .supabase_url
            .as_deref()
            .and_then(|raw| match url::Url::parse(raw) {
                Ok(parsed) if parsed.scheme() == "https" || parsed.scheme() == "http" => {
                    Some(parsed.origin().ascii_serialization())
                }
                Ok(parsed) => {
                    tracing::error!(
                        scheme = parsed.scheme(),
                        "SUPABASE_URL has a non-http(s) scheme — attachments DISABLED (fail closed)"
                    );
                    None
                }
                Err(err) => {
                    tracing::error!(
                        error = %err,
                        "SUPABASE_URL is not a valid URL — attachments DISABLED (fail closed)"
                    );
                    None
                }
            });
    if attachment_url_origin.is_none() {
        tracing::warn!(
            "No usable SUPABASE_URL — message attachments will be rejected (fail closed)"
        );
    }

    let state = AppState::new(
        pool,
        config.supabase_jwt_secret.clone(),
        es256_key,
        config.is_production(),
        profile_service,
        server_service,
        message_service,
        invite_service,
        channel_service,
        moderation_service,
        dm_service,
        friendship_service,
        key_service,
        reaction_service,
        read_state_service,
        notification_settings_service,
        user_preferences_service,
        member_repo,
        channel_repo,
        ban_repo,
        plan_limit_checker,
        event_bus,
        presence_tracker,
        megolm_session_repo,
        desktop_auth_repo,
        spam_guard,
        content_moderator,
        safe_browsing,
        klipy,
        message_repo_for_moderation,
        server_repo_for_moderation,
        moderation_retry_repo,
        image_classifier,
        csam_matcher,
        attachment_repo_for_scan,
        attachment_scan_retry_repo,
        config.attachments_require_csam_scan,
        voice_service,
        voice_session_repo,
        config.official_server_id.as_deref().map(|id| {
            domain::models::ServerId(
                id.parse::<uuid::Uuid>()
                    .expect("OFFICIAL_SERVER_ID must be a valid UUID"),
            )
        }),
        analytics_recorder,
        attachment_url_origin,
        config.trusted_proxy_secret.clone(),
    );

    AppInit {
        state,
        instance_id,
        event_notify_rx,
        event_local_tx,
        presence_write_rx,
        presence_cache_handle,
    }
}

/// Spawn a background task that sweeps stale presence entries every 60s.
///
/// Entries with `last_heartbeat` older than 90s (hardcoded in SQL) are
/// removed and `PresenceChanged { status: offline }` is emitted for each.
///
/// WHY: The 90s SQL interval gives a 60s buffer after the last SSE heartbeat
/// touch (30s interval). If a user's SSE connection drops, the sweep will
/// detect the stale entry within ~60–90s and broadcast the offline event.
fn spawn_presence_sweep(state: api::AppState) {
    use domain::models::{ServerEvent, UserStatus};

    const SWEEP_INTERVAL: Duration = Duration::from_secs(60);

    tokio::spawn(async move {
        let mut interval = tokio::time::interval(SWEEP_INTERVAL);
        loop {
            interval.tick().await;

            let stale_users = state.presence_tracker().sweep_stale(SWEEP_INTERVAL).await;
            if stale_users.is_empty() {
                continue;
            }

            tracing::info!(count = stale_users.len(), "Swept stale presence entries");

            for user_id in stale_users {
                // WHY: Routing metadata for SSE scoping (shared server/DM only,
                // redacted before clients see it). On lookup failure fall back
                // to an empty vec — the SSE layer treats that as broadcast, so
                // a DB hiccup degrades to the old behavior instead of eating
                // the offline event (ADR-027: never silently lose the signal).
                let server_ids = match state.server_service().list_all_memberships(&user_id).await {
                    Ok(ids) => ids,
                    Err(e) => {
                        tracing::warn!(
                            user_id = %user_id.0,
                            error = %e,
                            "presence sweep: membership lookup failed — broadcasting unscoped offline event"
                        );
                        Vec::new()
                    }
                };
                let event = ServerEvent::PresenceChanged {
                    sender_id: user_id.clone(),
                    user_id,
                    status: UserStatus::Offline,
                    server_ids,
                };
                state.event_bus().publish(event);
            }
        }
    });
}

/// Spawn a background task that sweeps expired `SpamGuard` state every 60s.
///
/// Cleans up expired mutes, stale duplicate hashes, and stale flood counters
/// to prevent unbounded memory growth.
fn spawn_spam_guard_sweep(spam_guard: std::sync::Arc<domain::services::SpamGuard>) {
    const SWEEP_INTERVAL: Duration = Duration::from_secs(60);

    tokio::spawn(async move {
        let mut interval = tokio::time::interval(SWEEP_INTERVAL);
        loop {
            interval.tick().await;
            // WHY: catch_unwind prevents a panic in sweep logic from killing
            // the background task permanently (ADR-027: no silent failures).
            // sweep_expired is a sync function, so std::panic::catch_unwind works.
            if let Err(e) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                spam_guard.sweep_expired();
            })) {
                tracing::error!(error = ?e, "SpamGuard sweep panicked — will retry next interval");
            }
        }
    });
}

/// Spawn a background task that retries failed image content-moderation scans
/// every 60s (spec §c.1 step 6). Fetches dead-lettered attachments, re-runs the
/// scan, and on success writes the verdict + emits `MessageUpdated`. Fail-closed:
/// a still-failing scan bumps the retry count and stays `pending`. Logs the
/// dead-letter depth each cycle as the saturation signal (Four Golden Signals).
fn spawn_attachment_scan_sweep(state: api::AppState) {
    use crate::api::attachment_scan::{AttachmentScanDeps, rescan_attachment};
    use domain::models::{Attachment, AttachmentModerationStatus};

    const SWEEP_INTERVAL: Duration = Duration::from_secs(60);
    /// Maximum records to process per sweep cycle.
    const BATCH_LIMIT: i64 = 10;

    tokio::spawn(async move {
        let mut interval = tokio::time::interval(SWEEP_INTERVAL);
        loop {
            interval.tick().await;

            let retry_repo = state.attachment_scan_retry_repository();
            let message_repo = state.message_repository_for_moderation();

            // Saturation signal: how deep is the unmoderated backlog?
            if let Ok(depth) = retry_repo.count_pending().await
                && depth > 0
            {
                tracing::info!(dead_letter_depth = depth, "attachment scan retry backlog");
            }

            let pending = match retry_repo.list_pending(BATCH_LIMIT).await {
                Ok(rows) => rows,
                Err(e) => {
                    tracing::warn!(error = %e, "attachment scan sweep: failed to fetch pending retries");
                    continue;
                }
            };
            if pending.is_empty() {
                continue;
            }

            let deps = AttachmentScanDeps::from_state(&state);
            for retry in pending {
                // Resolve the author (needed for the own-server decision cell). A
                // missing/deleted message means the attachment is gone — clear it.
                let author_id = match message_repo.find_by_id(&retry.message_id).await {
                    Ok(Some(m)) => m.author_id,
                    Ok(None) => {
                        if let Err(e) = retry_repo.delete(&retry.attachment_id).await {
                            tracing::warn!(attachment_id = %retry.attachment_id, error = %e, "attachment scan sweep: failed to clear orphaned retry");
                        }
                        continue;
                    }
                    Err(e) => {
                        tracing::warn!(message_id = %retry.message_id, error = %e, "attachment scan sweep: message lookup failed");
                        continue;
                    }
                };

                let attachment = Attachment {
                    id: retry.attachment_id.clone(),
                    message_id: retry.message_id.clone(),
                    url: retry.url.clone(),
                    mime: retry.mime.clone(),
                    size: 0,
                    width: None,
                    height: None,
                    moderation_status: AttachmentModerationStatus::Pending,
                    created_at: retry.created_at,
                };

                // rescan_attachment writes + clears + emits on success; on a
                // repeat failure the dead-letter UPSERT bumps the retry count.
                rescan_attachment(&deps, &attachment, &author_id, &retry.channel_id).await;
            }
        }
    });
}

/// Spawn a background task that retries failed identity-image (avatar/banner)
/// scans every 60s (fail-closed). Mirrors `spawn_attachment_scan_sweep`: a
/// dead-lettered candidate stays `pending` (never revealed) until a retry
/// resolves it. `scan_pending_identity_images` re-reads status, so a candidate
/// already resolved out-of-band is a cheap no-op.
fn spawn_identity_image_scan_sweep(state: api::AppState) {
    use crate::api::identity_image_scan::{IdentityImageScanDeps, scan_pending_identity_images};

    const SWEEP_INTERVAL: Duration = Duration::from_secs(60);
    /// Maximum records to process per sweep cycle.
    const BATCH_LIMIT: i64 = 20;

    tokio::spawn(async move {
        let mut interval = tokio::time::interval(SWEEP_INTERVAL);
        loop {
            interval.tick().await;

            let retry_repo = state.identity_image_scan_retry_repository();

            // Saturation signal: how deep is the unmoderated backlog?
            if let Ok(depth) = retry_repo.count_pending().await
                && depth > 0
            {
                tracing::info!(
                    dead_letter_depth = depth,
                    "identity image scan retry backlog"
                );
            }

            let pending = match retry_repo.list_pending(BATCH_LIMIT).await {
                Ok(rows) => rows,
                Err(e) => {
                    tracing::warn!(error = %e, "identity image scan sweep: failed to fetch pending retries");
                    continue;
                }
            };
            if pending.is_empty() {
                continue;
            }

            let deps = IdentityImageScanDeps::from_state(&state);
            for retry in pending {
                // Re-scan every pending image for this user. Idempotent: a
                // candidate no longer pending (resolved or superseded) is skipped.
                scan_pending_identity_images(&deps, &retry.user_id).await;
            }
        }
    });
}

/// Spawn a background task that retries failed AI moderation checks every 60s (C3).
///
/// Fetches pending retries from the dead-letter queue and re-runs the `OpenAI`
/// moderation check. If flagged: soft-delete + emit `MessageDeleted`. If clean:
/// remove from queue. If error: increment retry count. After 5 failures,
/// `tracing::error!` fires a Sentry alert for operator investigation.
fn spawn_moderation_retry_sweep(state: api::AppState) {
    use domain::models::{SYSTEM_MODERATOR_ID, ServerEvent};
    use domain::services::content_moderation::{SCORE_THRESHOLD, evaluate_moderation};
    use domain::services::resolve_channel_access_by_id;

    const SWEEP_INTERVAL: Duration = Duration::from_secs(60);
    /// Maximum retries per record before alerting operators.
    const MAX_RETRIES: i32 = 5;
    /// Maximum records to process per sweep cycle.
    const BATCH_LIMIT: i64 = 10;

    // WHY: Skip sweep entirely when no moderator is configured (self-hosted).
    // The dead-letter queue can only be populated when a moderator exists,
    // so sweeping without one would be a no-op.
    let moderator = match state.content_moderator().cloned() {
        Some(m) => m,
        None => return,
    };

    tokio::spawn(async move {
        let mut interval = tokio::time::interval(SWEEP_INTERVAL);
        loop {
            interval.tick().await;

            let retry_repo = state.moderation_retry_repository();
            let message_repo = state.message_repository_for_moderation();
            let server_repo = state.server_repository_for_moderation();
            let event_bus = state.event_bus_arc();

            let pending = match retry_repo.list_pending(BATCH_LIMIT).await {
                Ok(rows) => rows,
                Err(e) => {
                    tracing::warn!(
                        error = %e,
                        "Failed to fetch pending moderation retries"
                    );
                    continue;
                }
            };

            if pending.is_empty() {
                continue;
            }

            tracing::debug!(count = pending.len(), "Processing moderation retry batch");

            for retry in pending {
                // Re-attempt AI moderation
                match moderator.check_text(&retry.content).await {
                    Ok(result) => {
                        // Fetch server moderation categories for tiered evaluation
                        let server_categories = match server_repo
                            .get_moderation_categories(&retry.server_id)
                            .await
                        {
                            Ok(cats) => cats,
                            Err(e) => {
                                tracing::warn!(
                                    retry_id = %retry.id,
                                    server_id = %retry.server_id,
                                    error = %e,
                                    "Failed to fetch server moderation categories during retry"
                                );
                                std::collections::HashMap::new()
                            }
                        };

                        let decision = evaluate_moderation(
                            &result.category_scores,
                            &result.category_flags,
                            &server_categories,
                            SCORE_THRESHOLD,
                        );

                        match decision {
                            domain::services::ModerationDecision::Delete { reason, is_tier1 } => {
                                // Stale-content guard: skip if message was edited since retry was created
                                let current_msg = match message_repo
                                    .find_by_id(&retry.message_id)
                                    .await
                                {
                                    Ok(Some(msg)) => msg,
                                    Ok(None) => {
                                        // Message already deleted — clean up retry record
                                        tracing::debug!(message_id = %retry.message_id, "Retried message already deleted");
                                        if let Err(e) = retry_repo.delete(&retry.id).await {
                                            tracing::warn!(
                                                retry_id = %retry.id,
                                                error = %e,
                                                "Failed to delete moderation retry for already-deleted message"
                                            );
                                        }
                                        continue;
                                    }
                                    Err(e) => {
                                        tracing::warn!(error = %e, "Failed to read message for stale guard");
                                        continue;
                                    }
                                };

                                let msg_timestamp =
                                    current_msg.edited_at.unwrap_or(current_msg.created_at);
                                if msg_timestamp > retry.created_at {
                                    tracing::info!(
                                        message_id = %retry.message_id,
                                        "Message edited after retry was created — skipping moderation, content changed"
                                    );
                                    if let Err(e) = retry_repo.delete(&retry.id).await {
                                        tracing::warn!(
                                            retry_id = %retry.id,
                                            error = %e,
                                            "Failed to delete moderation retry for edited message"
                                        );
                                    }
                                    continue;
                                }

                                let tier_label = if is_tier1 { "tier1" } else { "tier2" };
                                tracing::info!(
                                    retry_id = %retry.id,
                                    message_id = %retry.message_id,
                                    tier = tier_label,
                                    reason = %reason,
                                    "Retry sweep flagged message — soft-deleting"
                                );

                                // WHY: None = skip atomic stale-content guard. The retry
                                // sweep already does its own stale check above (lines
                                // 465-473) by comparing msg_timestamp > retry.created_at.
                                if let Err(e) = message_repo
                                    .soft_delete(&retry.message_id, &SYSTEM_MODERATOR_ID, None)
                                    .await
                                {
                                    if matches!(e, domain::errors::DomainError::NotFound { .. }) {
                                        tracing::debug!(
                                            message_id = %retry.message_id,
                                            "Retried message already deleted — removing from queue"
                                        );
                                    } else {
                                        tracing::error!(
                                            message_id = %retry.message_id,
                                            error = %e,
                                            "Failed to soft-delete message during retry sweep — flagged content remains visible"
                                        );
                                    }
                                } else {
                                    // WHY: Gate the moderation delete to a private
                                    // channel's authorized members. Fail OPEN on
                                    // lookup error (ADR-027) — losing the delete is
                                    // worse than it reaching a few extra members.
                                    let channel_access = resolve_channel_access_by_id(
                                        state.channel_repository(),
                                        &retry.channel_id,
                                    )
                                    .await
                                    .unwrap_or_else(|e| {
                                        tracing::warn!(
                                            message_id = %retry.message_id,
                                            channel_id = %retry.channel_id,
                                            error = %e,
                                            "Failed to resolve channel access for retry-sweep delete — failing open (public)"
                                        );
                                        None
                                    });
                                    let event = ServerEvent::MessageDeleted {
                                        sender_id: SYSTEM_MODERATOR_ID,
                                        server_id: retry.server_id.clone(),
                                        channel_id: retry.channel_id.clone(),
                                        message_id: retry.message_id.clone(),
                                        deleted_by: SYSTEM_MODERATOR_ID,
                                        channel_access,
                                    };
                                    event_bus.publish(event);
                                }

                                // Remove from retry queue regardless of soft_delete outcome
                                if let Err(e) = retry_repo.delete(&retry.id).await {
                                    tracing::warn!(
                                        retry_id = %retry.id,
                                        error = %e,
                                        "Failed to delete moderation retry after successful moderation"
                                    );
                                }
                            }
                            domain::services::ModerationDecision::Pass => {
                                // Content is clean — remove from retry queue
                                if let Err(e) = retry_repo.delete(&retry.id).await {
                                    tracing::warn!(
                                        retry_id = %retry.id,
                                        error = %e,
                                        "Failed to delete clean moderation retry"
                                    );
                                }
                            }
                        }
                    }
                    Err(e) => {
                        // Still failing — increment retry count
                        match retry_repo.increment_retry(&retry.id, &e.to_string()).await {
                            Ok(new_count) if new_count >= MAX_RETRIES => {
                                // WHY: 5 consecutive failures means the external
                                // service is persistently broken for this message.
                                // Escalate to operators via Sentry (tracing::error!).
                                tracing::error!(
                                    retry_id = %retry.id,
                                    message_id = %retry.message_id,
                                    server_id = %retry.server_id,
                                    retry_count = new_count,
                                    last_error = %e,
                                    "Moderation retry exhausted — message remains unmoderated, operator action required"
                                );
                            }
                            Ok(new_count) => {
                                tracing::warn!(
                                    retry_id = %retry.id,
                                    message_id = %retry.message_id,
                                    retry_count = new_count,
                                    error = %e,
                                    "Moderation retry failed — will retry next sweep"
                                );
                            }
                            Err(inc_err) => {
                                tracing::error!(
                                    retry_id = %retry.id,
                                    error = %inc_err,
                                    "Failed to increment moderation retry count"
                                );
                            }
                        }
                    }
                }
            }
        }
    });
}

/// Spawn a background task that sweeps stale voice sessions every 30s.
///
/// Sessions with `last_seen_at` older than 75s are removed and
/// `VoiceStateUpdate { action: Left }` is emitted for each.
///
/// WHY: Mirrors `spawn_presence_sweep` but for voice sessions.
/// The 75s threshold accommodates Chrome's background tab throttling (timers
/// clamped to 1/min max). A 15s heartbeat interval can miss up to 5 beats
/// when the tab is backgrounded: 15s * 5 = 75s.
fn spawn_voice_session_sweep(state: api::AppState) {
    /// How often the sweep runs.
    const SWEEP_INTERVAL: Duration = Duration::from_secs(30);
    /// Sessions older than this are considered stale (disconnected).
    /// WHY 75s: 15s heartbeat * 5 missed = 75s. Chrome throttles background
    /// tab timers to 1/min max, so 45s was too aggressive and killed sessions
    /// in backgrounded tabs.
    const STALE_THRESHOLD_SECS: i64 = 75;
    /// Alone-in-channel threshold: disconnect after 3 minutes alone.
    const ALONE_THRESHOLD_SECS: i64 = 180;
    /// AFK threshold: disconnect after 30 minutes of inactivity.
    const AFK_THRESHOLD_SECS: i64 = 1800;

    // WHY: Skip sweep entirely when voice is not enabled.
    // No voice session repository means no voice sessions can exist.
    let voice_repo = match state.voice_session_repository().cloned() {
        Some(repo) => repo,
        None => return,
    };

    tokio::spawn(async move {
        let mut interval = tokio::time::interval(SWEEP_INTERVAL);
        loop {
            interval.tick().await;

            // WHY: Use Postgres clock (not Rust Utc::now()) to eliminate clock skew.
            // Heartbeat's touch() uses Postgres now() for last_seen_at, so thresholds
            // must be computed from the same clock.
            let now = match voice_repo.now().await {
                Ok(ts) => ts,
                Err(e) => {
                    tracing::warn!(error = %e, "Voice session sweep: failed to fetch DB time");
                    continue;
                }
            };
            let stale_threshold = now - chrono::Duration::seconds(STALE_THRESHOLD_SECS);

            let mut stale_count: usize = 0;
            let mut stale_ok = true;
            let mut alone_count: usize = 0;
            let mut alone_ok = true;
            let mut afk_count: usize = 0;
            let mut afk_ok = true;

            // Helper: emit VoiceStateUpdate(Left) for each removed session,
            // gated on the channel's access scope (F5). Fail OPEN on a
            // resolver error (ADR-027, F5 decision #3), matching the
            // moderation-sweep precedent: losing the Left event leaves a
            // ghost participant in every authorized roster until the next
            // fetch — worse than the roster change reaching a few extra
            // members for one event.
            async fn emit_left(state: &api::AppState, sessions: Vec<domain::models::VoiceSession>) {
                use domain::models::{ServerEvent, VoiceAction};
                use domain::services::resolve_channel_access_by_id;

                for session in sessions {
                    let channel_access = resolve_channel_access_by_id(
                        state.channel_repository(),
                        &session.channel_id,
                    )
                    .await
                    .unwrap_or_else(|e| {
                        tracing::warn!(
                            channel_id = %session.channel_id,
                            user_id = %session.user_id,
                            error = %e,
                            "Failed to resolve channel access for voice-sweep Left event — failing open (public)"
                        );
                        None
                    });
                    let event = ServerEvent::VoiceStateUpdate {
                        sender_id: session.user_id.clone(),
                        server_id: session.server_id.clone(),
                        channel_id: session.channel_id.clone(),
                        user_id: session.user_id,
                        action: VoiceAction::Left,
                        display_name: String::new(),
                        is_muted: None,
                        is_deafened: None,
                        channel_access,
                    };
                    state.event_bus().publish(event);
                }
            }

            // Step 1: Remove sessions that stopped heartbeating.
            match voice_repo.delete_stale(stale_threshold).await {
                Ok(stale) => {
                    stale_count = stale.len();
                    emit_left(&state, stale).await;
                }
                Err(e) => {
                    stale_ok = false;
                    tracing::warn!(error = %e, "Voice session sweep: delete_stale failed");
                }
            }

            // Step 2: Remove sessions alone in their channel beyond threshold.
            let alone_threshold = now - chrono::Duration::seconds(ALONE_THRESHOLD_SECS);
            match voice_repo.delete_alone_in_channel(alone_threshold).await {
                Ok(alone) => {
                    alone_count = alone.len();
                    emit_left(&state, alone).await;
                }
                Err(e) => {
                    alone_ok = false;
                    tracing::warn!(error = %e, "Voice session sweep: delete_alone_in_channel failed");
                }
            }

            // Step 3: Remove AFK sessions (still heartbeating but inactive).
            let afk_threshold = now - chrono::Duration::seconds(AFK_THRESHOLD_SECS);
            match voice_repo.delete_afk(afk_threshold, stale_threshold).await {
                Ok(afk) => {
                    afk_count = afk.len();
                    emit_left(&state, afk).await;
                }
                Err(e) => {
                    afk_ok = false;
                    tracing::warn!(error = %e, "Voice session sweep: delete_afk failed");
                }
            }

            // Step 4: Update alone_since markers for the next sweep cycle.
            if let Err(e) = voice_repo.update_alone_since().await {
                tracing::warn!(error = %e, "Voice session sweep: update_alone_since failed");
            }

            // WHY: Always log a summary so operators can distinguish
            // "sweep ran and found nothing" from "sweep failed."
            if stale_count > 0
                || alone_count > 0
                || afk_count > 0
                || !stale_ok
                || !alone_ok
                || !afk_ok
            {
                tracing::info!(
                    stale = stale_count,
                    stale_ok,
                    alone = alone_count,
                    alone_ok,
                    afk = afk_count,
                    afk_ok,
                    "Voice session sweep complete"
                );
            }
        }
    });
}

/// Fetch the ES256 public key from the Supabase JWKS endpoint.
///
/// Returns `None` (with a warning log) if `SUPABASE_URL` is not set or the JWKS
/// endpoint is unreachable. This keeps HS256-only setups working without breakage.
async fn fetch_supabase_jwks(config: &Config) -> Option<jsonwebtoken::DecodingKey> {
    let supabase_url = config.supabase_url.as_deref()?;
    let jwks_url = format!("{supabase_url}/auth/v1/.well-known/jwks.json");

    tracing::info!(url = %jwks_url, "Fetching Supabase JWKS for ES256 support");

    let response = match reqwest::get(&jwks_url).await {
        Ok(resp) => resp,
        Err(e) => {
            tracing::warn!(
                error = %e,
                url = %jwks_url,
                "Failed to fetch Supabase JWKS — ES256 tokens will be rejected. \
                 HS256 tokens still work via SUPABASE_JWT_SECRET."
            );
            return None;
        }
    };

    let jwks: jsonwebtoken::jwk::JwkSet = match response.json().await {
        Ok(jwks) => jwks,
        Err(e) => {
            tracing::warn!(
                error = %e,
                "Failed to parse Supabase JWKS response — ES256 tokens will be rejected"
            );
            return None;
        }
    };

    // WHY: Use the first key in the set. Supabase JWKS typically contains a single signing key.
    let jwk = jwks.keys.first()?;

    match jsonwebtoken::DecodingKey::from_jwk(jwk) {
        Ok(key) => {
            tracing::info!(
                kid = ?jwk.common.key_id,
                "ES256 public key loaded from Supabase JWKS"
            );
            Some(key)
        }
        Err(e) => {
            tracing::warn!(
                error = %e,
                "Failed to construct DecodingKey from Supabase JWK — ES256 tokens will be rejected"
            );
            None
        }
    }
}

/// Initialize Sentry for crash reporting and proactive alerting.
fn init_sentry(config: &Config) -> Option<sentry::ClientInitGuard> {
    let dsn = config.sentry_dsn.as_ref()?;

    let dsn_str = dsn.expose_secret();
    if dsn_str.is_empty() {
        return None;
    }

    let guard = sentry::init((
        dsn_str.to_string(),
        sentry::ClientOptions {
            release: sentry::release_name!(),
            environment: Some(config.environment.clone().into()),
            traces_sample_rate: if config.is_production() { 0.1 } else { 1.0 },
            ..Default::default()
        },
    ));

    Some(guard)
}

/// Initialize tracing subscriber with JSON output for production.
fn init_tracing(config: &Config) -> Option<SdkTracerProvider> {
    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        "info,harmony_api=debug,tower_http=debug"
            .parse()
            .expect("hardcoded filter string is valid")
    });

    let tracer_provider = init_otel_provider(config);

    if config.is_production() {
        let sentry_layer =
            sentry::integrations::tracing::layer().event_filter(|md| match *md.level() {
                tracing::Level::ERROR => EventFilter::Event,
                tracing::Level::WARN => EventFilter::Breadcrumb,
                _ => EventFilter::Ignore,
            });

        let otel_layer = tracer_provider
            .as_ref()
            .map(|p| OpenTelemetryLayer::new(p.tracer("harmony-api")));

        tracing_subscriber::registry()
            .with(env_filter)
            .with(tracing_subscriber::fmt::layer().json())
            .with(sentry_layer)
            .with(otel_layer)
            .init();
    } else {
        let sentry_layer =
            sentry::integrations::tracing::layer().event_filter(|md| match *md.level() {
                tracing::Level::ERROR => EventFilter::Event,
                _ => EventFilter::Ignore,
            });

        let otel_layer = tracer_provider
            .as_ref()
            .map(|p| OpenTelemetryLayer::new(p.tracer("harmony-api")));

        tracing_subscriber::registry()
            .with(env_filter)
            .with(tracing_subscriber::fmt::layer().pretty())
            .with(sentry_layer)
            .with(otel_layer)
            .init();
    }

    tracer_provider
}

/// Build an `OTel` `SdkTracerProvider` if `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
fn init_otel_provider(config: &Config) -> Option<SdkTracerProvider> {
    let endpoint = config.otel_exporter_otlp_endpoint.as_deref()?;
    if endpoint.is_empty() {
        return None;
    }

    let service_name = config
        .otel_service_name
        .clone()
        .unwrap_or_else(|| "harmony-api".to_string());

    let exporter = SpanExporter::builder()
        .with_tonic()
        .with_endpoint(endpoint)
        .build()
        .expect("Failed to create OTLP span exporter");

    let provider = SdkTracerProvider::builder()
        .with_batch_exporter(exporter)
        .with_resource(Resource::builder().with_service_name(service_name).build())
        .build();

    opentelemetry::global::set_tracer_provider(provider.clone());

    Some(provider)
}

/// Graceful shutdown handler.
async fn shutdown_signal() {
    let ctrl_c = async {
        signal::ctrl_c()
            .await
            .expect("Failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("Failed to install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }

    tracing::info!("Shutdown signal received, starting graceful shutdown...");
}
