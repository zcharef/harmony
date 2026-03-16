# ADR-027: No process::exit() -- Graceful Shutdown Only

**Status:** Accepted
**Date:** 2026-03-16

## Context

`process::exit()` terminates the process immediately, skipping all cleanup:

```rust
// BAD: immediate termination — skips destructors
fn validate_config() {
    if std::env::var("DATABASE_URL").is_err() {
        eprintln!("DATABASE_URL is required");
        std::process::exit(1); // Skips Drop impls, leaks connections,
                                // drops in-flight HTTP responses,
                                // corrupts half-written files
    }
}
```

`process::exit()`:
- Skips all `Drop` implementations (database connections not returned to pool)
- Drops in-flight HTTP responses (clients receive connection reset)
- Bypasses panic handlers and Sentry error reporting
- Does not flush buffered writers (logs, files)

Similarly, `process::abort()` is even worse — no unwinding, no cleanup whatsoever.

## Decision

Never use `process::exit()` or `process::abort()`. Use Rust's standard error propagation:

```rust
// GOOD: error propagation — all destructors run, connections returned
fn validate_config() -> Result<Config, anyhow::Error> {
    let database_url = std::env::var("DATABASE_URL")
        .context("DATABASE_URL is required")?;

    Ok(Config { database_url })
}

// In main:
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = Config::from_env()?; // Returns Err, main exits with code 1
    let app = build_app(config).await?;
    serve(app).await?;
    Ok(())
    // All destructors run. Connections returned. Logs flushed.
}
```

**Acceptable alternatives to `process::exit()`:**
- `anyhow::bail!("reason")` — returns an error, triggers normal unwinding
- `return Err(...)` — standard error propagation
- `panic!("reason")` — triggers the panic handler (Sentry captures it), then unwinds

## Consequences

**Positive:**
- All destructors run — database connections returned, files flushed, logs written
- Sentry captures the error (panics go through the panic handler)
- In-flight HTTP responses complete or receive proper error responses
- Graceful shutdown signal handlers work correctly (Tokio shutdown hooks fire)

**Negative:**
- Slightly more verbose error handling in `main()` (use `anyhow::Result` to keep it clean)
- `panic!()` still terminates the process, but at least it unwinds and runs destructors

## Enforcement

- **Enforcement test:** `tests/architecture_test.rs` scans all `.rs` files in `src/` for `process::exit` and `process::abort` — test fails if found
- **Code review:** Any use of `std::process::exit` or `std::process::abort` is rejected with a pointer to this ADR
