# ADR-025: Typed Config -- No Ad-Hoc env::var()

**Status:** Accepted
**Date:** 2026-03-16

## Context

Scattered `std::env::var()` calls are fragile and unauditable:

```rust
// BAD: env vars read ad-hoc throughout the codebase
pub async fn send_email(to: &str, body: &str) -> Result<()> {
    let api_key = std::env::var("SENDGRID_API_KEY")
        .expect("SENDGRID_API_KEY must be set"); // panics in production if missing

    let base_url = std::env::var("SENDGRID_URL")
        .unwrap_or("https://api.sendgrid.com".to_string()); // different default in every file

    // api_key is a plain String — can be logged, serialized, or compared accidentally
    tracing::info!("Sending email with key: {}", api_key); // LEAKED SECRET
    Ok(())
}
```

Problems:
- Missing env vars discovered at runtime, not at startup
- Defaults scattered across files (inconsistent)
- Secrets stored as plain `String` — can be logged or serialized accidentally
- No single place to audit which env vars the application requires

## Decision

All environment variables are read through a single **`Config` struct** in `config.rs`. No `std::env::var()` calls exist outside this file.

```rust
// GOOD: all env vars in one place, validated at startup
use secrecy::SecretString;

#[derive(Clone)]
pub struct Config {
    pub database_url: SecretString,
    pub supabase_jwt_secret: SecretString,
    pub sendgrid_api_key: SecretString,
    pub port: u16,
    pub environment: Environment,
    pub cors_origin: String,
}

impl Config {
    pub fn from_env() -> Result<Self, anyhow::Error> {
        Ok(Self {
            database_url: SecretString::new(
                std::env::var("DATABASE_URL")
                    .context("DATABASE_URL must be set")?
            ),
            supabase_jwt_secret: SecretString::new(
                std::env::var("SUPABASE_JWT_SECRET")
                    .context("SUPABASE_JWT_SECRET must be set")?
            ),
            sendgrid_api_key: SecretString::new(
                std::env::var("SENDGRID_API_KEY")
                    .context("SENDGRID_API_KEY must be set")?
            ),
            port: std::env::var("PORT")
                .unwrap_or_else(|_| "3000".to_string())
                .parse()
                .context("PORT must be a valid u16")?,
            environment: std::env::var("ENVIRONMENT")
                .unwrap_or_else(|_| "development".to_string())
                .parse()?,
            cors_origin: std::env::var("CORS_ORIGIN")
                .unwrap_or_else(|_| "http://localhost:1420".to_string()),
        })
    }
}
```

**Secret fields:** Any config field matching `*_key`, `*_secret`, `*_token`, `*_password`, or `*_dsn` **must** be `SecretString`. This type:
- Implements `Debug` as `"[REDACTED]"` — cannot be accidentally logged
- Requires explicit `.expose_secret()` to access the inner value
- Prevents accidental serialization

## Consequences

**Positive:**
- All env vars validated at startup — fail fast with clear error messages, not runtime panics deep in a request
- Single file to audit for environment dependencies
- `SecretString` prevents accidental secret leakage in logs, error messages, or serialized output
- Defaults are centralized and documented in one place

**Negative:**
- Every new env var requires updating `Config` (this is the point — it forces deliberate addition)
- `SecretString` requires `.expose_secret()` at every use site (minor ergonomic cost for major safety gain)
- Test configurations must construct `Config` explicitly

## Enforcement

- **Enforcement test:** `tests/architecture_test.rs` scans all `.rs` files outside `src/config.rs` for `std::env::var` or `env::var` — test fails if found
- **Code review:** Config fields with sensitive names (`*_key`, `*_secret`, `*_token`, `*_password`, `*_dsn`) that are not `SecretString` are rejected
- **CI:** Application startup in CI validates all required env vars are present
