#![warn(
    dead_code,
    unused_variables,
    unused_imports,
    unused_mut,
    unreachable_code
)]
// WHY: main.rs is the composition root — process::exit on fatal startup errors is acceptable.
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use harmony_api::domain::ports::VoiceSessionRepository as _;
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
    let state = init_app_state(&config).await;

    // 5. Parse trusted proxy CIDRs for rate limiter
    let trusted_proxies = config
        .trusted_proxies
        .as_deref()
        .map(api::middleware::rate_limit::parse_trusted_proxies)
        .unwrap_or_default();
    if trusted_proxies.is_empty() {
        tracing::info!(
            "No trusted proxies configured — proxy headers will be ignored for rate limiting"
        );
    } else {
        tracing::info!(
            count = trusted_proxies.len(),
            "Trusted proxies configured for rate limiting"
        );
    }

    // 6. Background tasks: sweep stale presence entries + expired mutes every 60s
    spawn_presence_sweep(state.clone());
    spawn_spam_guard_sweep(state.spam_guard().clone());
    spawn_moderation_retry_sweep(state.clone());
    spawn_voice_session_sweep(state.clone());

    // 7. Build router with middleware stack
    let app = build_router(
        state,
        trusted_proxies,
        config.rate_limit_per_minute,
        config.livekit_url.as_deref(),
    );

    // 8. Start server with graceful shutdown
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

    // Flush pending OTel spans before exit
    if let Some(provider) = tracer_provider
        && let Err(e) = provider.shutdown()
    {
        tracing::error!(error = %e, "OpenTelemetry shutdown error");
    }
}

/// Initialize application state with Postgres pool, services, and repositories.
async fn init_app_state(config: &Config) -> AppState {
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
    let key_repo = Arc::new(infra::postgres::PgKeyRepository::new(pool.clone()));
    let reaction_repo = Arc::new(infra::postgres::PgReactionRepository::new(pool.clone()));
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
    let spam_guard = Arc::new(domain::services::SpamGuard::new());
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

    // C3: Dead-letter queue for failed AI moderation checks (Tier 1 safety).
    let moderation_retry_repo = Arc::new(infra::postgres::PgModerationRetryRepository::new(
        pool.clone(),
    ));

    let message_service = Arc::new(domain::services::MessageService::new(
        message_repo,
        channel_repo.clone(),
        member_repo.clone(),
        plan_limit_checker.clone(),
        reaction_repo.clone(),
        content_filter.clone(),
        spam_guard.clone(),
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
    let moderation_service = Arc::new(domain::services::ModerationService::new(
        server_repo.clone(),
        ban_repo.clone(),
        member_repo.clone(),
    ));
    let dm_service = Arc::new(domain::services::DmService::new(
        dm_repo,
        profile_repo,
        server_repo,
        member_repo.clone(),
        plan_limit_checker.clone(),
    ));
    let key_service = Arc::new(domain::services::KeyService::new(key_repo));
    let reaction_service = Arc::new(domain::services::ReactionService::new(
        reaction_repo,
        channel_repo.clone(),
        member_repo.clone(),
    ));
    let read_state_service = Arc::new(domain::services::ReadStateService::new(read_state_repo));
    let megolm_session_repo = Arc::new(infra::postgres::PgMegolmSessionRepository::new(
        pool.clone(),
    ));
    let desktop_auth_repo = Arc::new(infra::postgres::PgDesktopAuthRepository::new(pool.clone()));
    let notification_settings_repo = Arc::new(
        infra::postgres::PgNotificationSettingsRepository::new(pool.clone()),
    );
    let notification_settings_service = Arc::new(
        domain::services::NotificationSettingsService::new(notification_settings_repo),
    );
    let user_preferences_repo = Arc::new(infra::postgres::PgUserPreferencesRepository::new(
        pool.clone(),
    ));
    let user_preferences_service = Arc::new(domain::services::UserPreferencesService::new(
        user_preferences_repo,
    ));

    // Initialize in-process event bus for SSE real-time delivery
    let event_bus: Arc<dyn domain::ports::EventBus> = Arc::new(infra::BroadcastEventBus::new());

    // Initialize in-memory presence tracker
    let presence_tracker = Arc::new(infra::PresenceTracker::new());

    // WHY: Construct voice service only when all three LiveKit env vars are set.
    // When None, voice endpoints return DomainError::VoiceDisabled (graceful degradation).
    let voice_service: Option<Arc<domain::services::VoiceService>> = if config.livekit_enabled() {
        let livekit_url = config.livekit_url.as_deref().unwrap().to_string();
        let livekit_key = config.livekit_api_key.clone().unwrap();
        let livekit_secret = config.livekit_api_secret.clone().unwrap();
        let livekit_service = Arc::new(infra::livekit::LiveKitTokenService::new(
            livekit_url,
            livekit_key,
            livekit_secret,
            config.livekit_token_ttl_secs,
        ));
        let voice_repo = Arc::new(infra::postgres::PgVoiceSessionRepository::new(pool.clone()));

        tracing::info!("Voice channels ENABLED (LiveKit configured)");
        Some(Arc::new(domain::services::VoiceService::new(
            voice_repo,
            channel_repo.clone(),
            member_repo.clone(),
            plan_limit_checker.clone(),
            livekit_service,
        )))
    } else {
        tracing::info!("Voice channels DISABLED (LiveKit not configured)");
        None
    };

    tracing::info!("Domain services initialized");

    AppState::new(
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
        key_service,
        reaction_service,
        read_state_service,
        notification_settings_service,
        user_preferences_service,
        member_repo,
        ban_repo,
        plan_limit_checker,
        event_bus,
        presence_tracker,
        megolm_session_repo,
        desktop_auth_repo,
        spam_guard,
        content_moderator,
        safe_browsing,
        message_repo_for_moderation,
        server_repo_for_moderation,
        moderation_retry_repo,
        voice_service,
    )
}

/// Spawn a background task that sweeps stale presence entries every 60s.
///
/// Entries with `last_heartbeat` older than 90s are removed and
/// `PresenceChanged { status: offline }` is emitted for each.
///
/// WHY: The 90s `max_age` gives a 60s buffer after the last SSE heartbeat
/// touch (30s interval). If a user's SSE connection drops, the sweep will
/// detect the stale entry within ~60–90s and broadcast the offline event.
fn spawn_presence_sweep(state: api::AppState) {
    use domain::models::{ServerEvent, UserStatus};

    /// How often the sweep runs.
    const SWEEP_INTERVAL: Duration = Duration::from_secs(60);
    /// Entries older than this are considered stale (disconnected).
    const STALE_MAX_AGE: Duration = Duration::from_secs(90);

    tokio::spawn(async move {
        let mut interval = tokio::time::interval(SWEEP_INTERVAL);
        loop {
            interval.tick().await;

            let stale_users = state.presence_tracker().sweep_stale(STALE_MAX_AGE);
            if stale_users.is_empty() {
                continue;
            }

            tracing::info!(count = stale_users.len(), "Swept stale presence entries");

            for user_id in stale_users {
                let event = ServerEvent::PresenceChanged {
                    sender_id: user_id.clone(),
                    user_id,
                    status: UserStatus::Offline,
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

/// Spawn a background task that retries failed AI moderation checks every 60s (C3).
///
/// Fetches pending retries from the dead-letter queue and re-runs the `OpenAI`
/// moderation check. If flagged: soft-delete + emit `MessageDeleted`. If clean:
/// remove from queue. If error: increment retry count. After 5 failures,
/// `tracing::error!` fires a Sentry alert for operator investigation.
fn spawn_moderation_retry_sweep(state: api::AppState) {
    use domain::models::{SYSTEM_MODERATOR_ID, ServerEvent};
    use domain::services::content_moderation::{SCORE_THRESHOLD, evaluate_moderation};

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
                                        let _ = retry_repo.delete(&retry.id).await;
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
                                    let _ = retry_repo.delete(&retry.id).await;
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
                                    let event = ServerEvent::MessageDeleted {
                                        sender_id: SYSTEM_MODERATOR_ID,
                                        server_id: retry.server_id.clone(),
                                        channel_id: retry.channel_id.clone(),
                                        message_id: retry.message_id.clone(),
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
    use domain::models::{ServerEvent, VoiceAction};

    /// How often the sweep runs.
    const SWEEP_INTERVAL: Duration = Duration::from_secs(30);
    /// Sessions older than this are considered stale (disconnected).
    /// WHY 75s: 15s heartbeat * 5 missed = 75s. Chrome throttles background
    /// tab timers to 1/min max, so 45s was too aggressive and killed sessions
    /// in backgrounded tabs.
    const STALE_THRESHOLD_SECS: i64 = 75;

    // WHY: Skip sweep entirely when voice is not enabled.
    // No voice service means no voice sessions can exist.
    let voice_service = match state.voice_service().cloned() {
        Some(s) => s,
        None => return,
    };

    // WHY: We need the VoiceSessionRepository directly for delete_stale,
    // but VoiceService doesn't expose it. Use a separate repo instance
    // constructed from the pool (same pattern as message_repo_for_moderation).
    // However, delete_stale is on VoiceSessionRepository which is inside
    // VoiceService. Instead, we construct a separate repo from the pool.
    let pool = state.pool().clone();
    let voice_repo = infra::postgres::PgVoiceSessionRepository::new(pool);

    tokio::spawn(async move {
        // WHY: Suppress unused variable warning — voice_service is held to prove
        // voice is enabled, but the sweep uses voice_repo directly.
        let _voice_enabled = voice_service;

        let mut interval = tokio::time::interval(SWEEP_INTERVAL);
        loop {
            interval.tick().await;

            let threshold = chrono::Utc::now() - chrono::Duration::seconds(STALE_THRESHOLD_SECS);
            match voice_repo.delete_stale(threshold).await {
                Ok(stale) => {
                    if stale.is_empty() {
                        continue;
                    }

                    tracing::info!(count = stale.len(), "Swept stale voice sessions");

                    for session in stale {
                        let event = ServerEvent::VoiceStateUpdate {
                            sender_id: session.user_id.clone(),
                            server_id: session.server_id.clone(),
                            channel_id: session.channel_id.clone(),
                            user_id: session.user_id,
                            action: VoiceAction::Left,
                            display_name: String::new(),
                        };
                        state.event_bus().publish(event);
                    }
                }
                Err(e) => tracing::warn!(error = %e, "Voice session sweep failed"),
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
