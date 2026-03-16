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

    /// Session secret for signing session tokens (min 32 bytes recommended)
    pub session_secret: Option<SecretString>,

    /// Sentry DSN for crash reporting (optional in dev)
    pub sentry_dsn: Option<SecretString>,

    /// OpenTelemetry OTLP collector endpoint (e.g., `http://localhost:4317`)
    /// When set, distributed tracing spans are exported via gRPC.
    pub otel_exporter_otlp_endpoint: Option<String>,

    /// OpenTelemetry service name reported in traces (default: "harmony-api")
    #[serde(default = "default_otel_service_name")]
    pub otel_service_name: Option<String>,
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
            .field("session_secret", &"[REDACTED]")
            .field("sentry_dsn", &self.sentry_dsn.as_ref().map(|_| "[REDACTED]"))
            .field(
                "otel_exporter_otlp_endpoint",
                &self.otel_exporter_otlp_endpoint,
            )
            .field("otel_service_name", &self.otel_service_name)
            .finish()
    }
}
