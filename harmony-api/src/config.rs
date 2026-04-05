use secrecy::SecretString;
use serde::Deserialize;

/// Type-safe application configuration.
///
/// All secrets are wrapped in `SecretString` to prevent accidental logging.
/// Configuration is loaded from environment variables with sensible defaults.
#[derive(Deserialize, Clone)]
pub struct Config {
    #[serde(default = "default_port")]
    pub server_port: u16,

    #[serde(default = "default_environment")]
    pub environment: String,

    /// Supabase Postgres connection string
    pub database_url: SecretString,

    /// Maximum number of connections in the Postgres pool
    #[serde(default = "default_max_db_connections")]
    pub max_db_connections: u32,

    /// Supabase JWT secret for token verification (HS256)
    pub supabase_jwt_secret: SecretString,

    /// Supabase project URL (optional, for storage/auth admin calls)
    pub supabase_url: Option<String>,

    /// Sentry DSN for crash reporting (optional in dev)
    pub sentry_dsn: Option<SecretString>,

    /// OpenTelemetry OTLP collector endpoint (e.g., `http://localhost:4317`)
    /// When set, distributed tracing spans are exported via gRPC.
    pub otel_exporter_otlp_endpoint: Option<String>,

    /// OpenTelemetry service name reported in traces (default: "harmony-api")
    #[serde(default = "default_otel_service_name")]
    pub otel_service_name: Option<String>,

    /// Enable plan limit enforcement (default: true).
    /// Self-hosted deployments should set `PLAN_ENFORCEMENT_ENABLED=false`.
    /// When true (default), `PgPlanLimitChecker` enforces Free/Pro/Community limits.
    /// When false, `AlwaysAllowedChecker` is used (no limits).
    #[serde(default = "default_plan_enforcement")]
    pub plan_enforcement_enabled: bool,

    /// Enable content moderation / `AutoMod` (default: true).
    /// Self-hosted deployments should set `CONTENT_MODERATION_ENABLED=false`.
    /// When true, [`ContentFilter`] checks all user-generated text for banned words.
    /// When false, `ContentFilter::noop()` is used (no filtering).
    #[serde(default = "default_content_moderation")]
    pub content_moderation_enabled: bool,

    /// Comma-separated CIDRs of trusted reverse proxies (e.g. `"172.16.0.0/12,10.0.0.0/8"`).
    /// Only when the TCP peer IP matches a trusted proxy CIDR will `X-Forwarded-For` /
    /// `X-Real-IP` headers be used for rate limiting. When unset, proxy headers are ignored.
    pub trusted_proxies: Option<String>,

    /// Per-IP rate limit in requests per minute (default: 60).
    /// Set to 0 to disable rate limiting (dev/CI environments).
    #[serde(default = "default_rate_limit_per_minute")]
    pub rate_limit_per_minute: u32,

    /// `OpenAI` API key for the Moderation API (optional).
    /// When absent, async content moderation is disabled (graceful degradation).
    pub openai_api_key: Option<SecretString>,

    /// Google Safe Browsing API v4 key (optional).
    /// When set, URLs in messages are checked against Google's threat lists.
    pub safe_browsing_api_key: Option<SecretString>,

    /// `LiveKit` server URL (e.g., `wss://my-project.livekit.cloud`).
    /// Voice channels are disabled when absent.
    pub livekit_url: Option<String>,

    /// `LiveKit` API key for token generation (optional).
    /// Voice channels are disabled when absent.
    pub livekit_api_key: Option<SecretString>,

    /// `LiveKit` API secret for token signing (optional).
    /// Voice channels are disabled when absent.
    pub livekit_api_secret: Option<SecretString>,

    /// `LiveKit` token TTL in seconds (default: 7200 = 2 hours).
    /// Controls the maximum lifetime of voice channel JWTs.
    #[serde(default = "default_livekit_token_ttl_secs")]
    pub livekit_token_ttl_secs: u64,

    /// UUID of the official Harmony server. When set, new users are
    /// auto-joined and SSE events are emitted. Unset = no auto-join.
    pub official_server_id: Option<String>,
}

fn default_port() -> u16 {
    3000
}

fn default_max_db_connections() -> u32 {
    10
}

fn default_environment() -> String {
    "development".to_string()
}

fn default_otel_service_name() -> Option<String> {
    Some("harmony-api".to_string())
}

fn default_plan_enforcement() -> bool {
    true
}

fn default_content_moderation() -> bool {
    true
}

fn default_rate_limit_per_minute() -> u32 {
    60
}

fn default_livekit_token_ttl_secs() -> u64 {
    7200
}

impl Config {
    /// Initialize configuration from environment variables.
    ///
    /// # Panics
    /// Panics if configuration cannot be loaded (fail-fast at startup).
    #[must_use]
    #[allow(clippy::expect_used)]
    pub fn init() -> Self {
        dotenvy::dotenv().ok();

        config::Config::builder()
            .add_source(config::Environment::default().separator("__"))
            .build()
            .expect("Failed to build configuration")
            .try_deserialize()
            .expect("Failed to parse configuration")
    }

    #[must_use]
    pub fn is_production(&self) -> bool {
        self.environment == "production"
    }

    /// Returns `true` only when all three `LiveKit` fields are `Some`.
    #[must_use]
    pub fn livekit_enabled(&self) -> bool {
        self.livekit_url.is_some()
            && self.livekit_api_key.is_some()
            && self.livekit_api_secret.is_some()
    }
}

impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("server_port", &self.server_port)
            .field("environment", &self.environment)
            .field("database_url", &"[REDACTED]")
            .field("max_db_connections", &self.max_db_connections)
            .field("supabase_jwt_secret", &"[REDACTED]")
            .field("supabase_url", &self.supabase_url)
            .field(
                "sentry_dsn",
                &self.sentry_dsn.as_ref().map(|_| "[REDACTED]"),
            )
            .field(
                "otel_exporter_otlp_endpoint",
                &self.otel_exporter_otlp_endpoint,
            )
            .field("otel_service_name", &self.otel_service_name)
            .field("plan_enforcement_enabled", &self.plan_enforcement_enabled)
            .field(
                "content_moderation_enabled",
                &self.content_moderation_enabled,
            )
            .field("trusted_proxies", &self.trusted_proxies)
            .field("rate_limit_per_minute", &self.rate_limit_per_minute)
            .field(
                "openai_api_key",
                &self.openai_api_key.as_ref().map(|_| "[REDACTED]"),
            )
            .field(
                "safe_browsing_api_key",
                &self.safe_browsing_api_key.as_ref().map(|_| "[REDACTED]"),
            )
            .field("livekit_url", &self.livekit_url)
            .field(
                "livekit_api_key",
                &self.livekit_api_key.as_ref().map(|_| "[REDACTED]"),
            )
            .field(
                "livekit_api_secret",
                &self.livekit_api_secret.as_ref().map(|_| "[REDACTED]"),
            )
            .field("livekit_token_ttl_secs", &self.livekit_token_ttl_secs)
            .field("livekit_enabled", &self.livekit_enabled())
            .field("official_server_id", &self.official_server_id)
            .finish()
    }
}
