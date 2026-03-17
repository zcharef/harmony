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

use opentelemetry::trace::TracerProvider as _;
use opentelemetry_otlp::{SpanExporter, WithExportConfig};
use opentelemetry_sdk::Resource;
use opentelemetry_sdk::trace::SdkTracerProvider;
use secrecy::{ExposeSecret, SecretString};
use sentry::integrations::tracing::EventFilter;
use tokio::signal;
use tracing_opentelemetry::OpenTelemetryLayer;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use api::AppState;
use api::router::build_router;
use config::Config;

#[tokio::main]
async fn main() {
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

    // 5. Build router with middleware stack
    let app = build_router(state);

    // 6. Start server with graceful shutdown
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

    // Session secret (required — stateless HMAC session tokens)
    let session_secret: SecretString = config.session_secret.clone().unwrap_or_else(|| {
        if config.is_production() {
            panic!("SESSION_SECRET must be set in production");
        }
        tracing::warn!("SESSION_SECRET not set — using insecure default for development");
        SecretString::from("dev-only-insecure-session-secret-do-not-use-in-prod!!")
    });

    // Construct Postgres adapters (ports → adapters)
    let profile_repo = Arc::new(infra::postgres::PgProfileRepository::new(pool.clone()));
    let server_repo = Arc::new(infra::postgres::PgServerRepository::new(pool.clone()));
    let message_repo = Arc::new(infra::postgres::PgMessageRepository::new(pool.clone()));
    let channel_repo = Arc::new(infra::postgres::PgChannelRepository::new(pool.clone()));
    let invite_repo = Arc::new(infra::postgres::PgInviteRepository::new(pool.clone()));
    let member_repo = Arc::new(infra::postgres::PgMemberRepository::new(pool.clone()));
    let ban_repo = Arc::new(infra::postgres::PgBanRepository::new(pool.clone()));

    // Construct domain services (injected with repository ports)
    let profile_service = Arc::new(domain::services::ProfileService::new(profile_repo));
    let server_service = Arc::new(domain::services::ServerService::new(server_repo.clone()));
    let message_service = Arc::new(domain::services::MessageService::new(
        message_repo,
        channel_repo.clone(),
        server_repo.clone(),
        member_repo.clone(),
    ));
    let invite_service = Arc::new(domain::services::InviteService::new(
        invite_repo,
        member_repo.clone(),
        ban_repo.clone(),
    ));
    let channel_service = Arc::new(domain::services::ChannelService::new(channel_repo));
    let moderation_service = Arc::new(domain::services::ModerationService::new(
        server_repo,
        ban_repo.clone(),
        member_repo.clone(),
    ));

    tracing::info!("Domain services initialized");

    AppState::new(
        pool,
        config.supabase_jwt_secret.clone(),
        es256_key,
        session_secret,
        config.is_production(),
        profile_service,
        server_service,
        message_service,
        invite_service,
        channel_service,
        moderation_service,
        member_repo,
        ban_repo,
    )
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
