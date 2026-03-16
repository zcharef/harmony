# ADR-041: Database Query Timeouts

**Status:** Accepted
**Date:** 2026-03-16

## Context

Without timeouts, a single runaway query can exhaust the connection pool and take down the entire application:

```rust
// BAD: no acquire_timeout — if pool is exhausted, requests hang forever
let pool = PgPoolOptions::new()
    .max_connections(20)
    .connect(&database_url)
    .await?;

// A slow query holds a connection for 5 minutes.
// 20 slow queries = pool exhausted.
// Every subsequent request waits indefinitely for a connection.
// Load balancer health check fails. Entire service goes down.
```

Without `statement_timeout`, a query with a missing index on a large table can run for minutes, holding a connection and accumulating database server resources (CPU, memory, I/O).

## Decision

The `PgPool` must be configured with both **acquire timeout** and **statement timeout**:

```rust
// GOOD: timeouts prevent resource exhaustion
use sqlx::postgres::PgPoolOptions;
use std::time::Duration;

let pool = PgPoolOptions::new()
    .max_connections(config.db_max_connections) // from Config struct (ADR-025)
    .acquire_timeout(Duration::from_secs(10))  // wait max 10s for a connection
    .after_connect(|conn, _meta| {
        Box::pin(async move {
            // Set statement timeout per connection — PostgreSQL kills queries
            // exceeding this duration
            sqlx::query("SET statement_timeout = '30s'")
                .execute(&mut *conn)
                .await?;
            Ok(())
        })
    })
    .connect(config.database_url.expose_secret())
    .await?;
```

**`acquire_timeout` (10 seconds):**
- Maximum time to wait for a connection from the pool
- If the pool is exhausted, the request fails fast with a clear error instead of hanging
- 10 seconds is generous — if no connection is available in 10s, the service is overloaded

**`statement_timeout` (30 seconds):**
- PostgreSQL kills any query running longer than 30 seconds
- Set via `after_connect` so every connection in the pool has the timeout
- Prevents a single bad query from monopolizing a connection

**Handler-level overrides for known long operations:**
```rust
// For legitimate long operations (e.g., data export), override per-query:
sqlx::query("SET LOCAL statement_timeout = '120s'")
    .execute(&mut *tx)
    .await?;
// This timeout applies only within the current transaction.
```

## Consequences

**Positive:**
- Runaway queries are killed after 30 seconds — connections are returned to the pool
- Pool exhaustion produces a clear error (acquire timeout) instead of silent hangs
- Service stays responsive under load — new requests fail fast rather than queueing indefinitely
- Cascading failures are prevented — one bad query does not take down the entire service

**Negative:**
- Legitimate long queries need explicit timeout overrides (forces developers to think about query performance)
- `statement_timeout` is a PostgreSQL setting — not portable to other databases (acceptable for this project)
- `after_connect` adds a round-trip per new connection (negligible — connections are pooled)

## Enforcement

- **Code review:** `config.rs` pool configuration is reviewed for `acquire_timeout` and `after_connect` with `statement_timeout`
- **Config struct (ADR-025):** Pool settings (`db_max_connections`, `db_acquire_timeout_secs`, `db_statement_timeout_secs`) are centralized in `Config`
- **Observability (ADR-017):** Connection pool metrics (active, idle, waiting) are emitted via `tracing` for monitoring saturation
