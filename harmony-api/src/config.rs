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

    /// Enable the anti-abuse `SpamGuard` (default: true).
    /// When true, flood auto-mute, duplicate detection, and per-action rate
    /// limits are enforced. When false, every check is a no-op — set
    /// `SPAM_GUARD_ENABLED=false` for E2E suites (which seed many messages as
    /// one user and would trip the flood mute) and single-user self-hosting.
    #[serde(default = "default_spam_guard")]
    pub spam_guard_enabled: bool,

    /// `OpenAI` API key for the Moderation API (optional).
    /// When absent, async content moderation is disabled (graceful degradation).
    pub openai_api_key: Option<SecretString>,

    /// Google Safe Browsing API v4 key (optional).
    /// When set, URLs in messages are checked against Google's threat lists.
    pub safe_browsing_api_key: Option<SecretString>,

    /// Enable the in-process ONNX adult-NSFW image classifier (Phase 2).
    /// Default `false`: the `NoopImageClassifier` is used (never flags) until a
    /// real model is wired. Requires `nsfw_model_path` when true.
    #[serde(default = "default_false")]
    pub nsfw_classifier_enabled: bool,

    /// Filesystem path to the bundled ONNX NSFW model (Phase 2). When absent,
    /// the classifier falls back to Noop even if `nsfw_classifier_enabled`.
    pub nsfw_model_path: Option<String>,

    /// Refuse image attachments when no REAL CSAM matcher is configured
    /// (fail-closed hard gate, spec §c.3). Default `false` (owner decision):
    /// while invite-only we run a Noop matcher and do NOT refuse images. A
    /// public launch flips this to `true` alongside a real matcher (Phase 3).
    #[serde(default = "default_false")]
    pub attachments_require_csam_scan: bool,

    /// Klipy GIF API key (optional). When absent, the `/v1/gifs/*` proxy
    /// endpoints return `503` and the client hides the GIF picker button.
    /// Server-side only — this key is NEVER exposed to the browser.
    pub klipy_api_key: Option<SecretString>,

    /// Process-global Klipy budget: max upstream calls per rolling hour across
    /// all users. Guards the shared upstream budget (test key: 100/hr) that the
    /// per-user rate limit alone cannot protect. Default 90 — raise or disable
    /// for the unlimited production key.
    pub klipy_global_max_per_hour: Option<u32>,

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

    /// Shared secret authenticating trusted server-side proxies (the invite
    /// OG Cloudflare Pages Function). A request presenting this value in
    /// `x-harmony-proxy-secret` may set `x-harmony-client-ip` to the original
    /// client IP, so unauth rate limits key on the real caller instead of the
    /// proxy egress IP. Unset = the forwarded header is never trusted.
    pub trusted_proxy_secret: Option<SecretString>,
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

fn default_false() -> bool {
    false
}

fn default_spam_guard() -> bool {
    true
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
            .field("spam_guard_enabled", &self.spam_guard_enabled)
            .field(
                "openai_api_key",
                &self.openai_api_key.as_ref().map(|_| "[REDACTED]"),
            )
            .field(
                "safe_browsing_api_key",
                &self.safe_browsing_api_key.as_ref().map(|_| "[REDACTED]"),
            )
            .field("nsfw_classifier_enabled", &self.nsfw_classifier_enabled)
            .field("nsfw_model_path", &self.nsfw_model_path)
            .field(
                "attachments_require_csam_scan",
                &self.attachments_require_csam_scan,
            )
            .field(
                "klipy_api_key",
                &self.klipy_api_key.as_ref().map(|_| "[REDACTED]"),
            )
            .field("klipy_global_max_per_hour", &self.klipy_global_max_per_hour)
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
            .field(
                "trusted_proxy_secret",
                &self.trusted_proxy_secret.as_ref().map(|_| "[REDACTED]"),
            )
            .finish()
    }
}
