# ADR-016: Compile-Time SQL Queries

**Status:** Accepted
**Date:** 2026-03-16

## Context

Runtime-constructed SQL queries bypass compile-time verification:

```rust
// BAD: typo in column name compiles fine, panics at runtime
let rows = sqlx::query("SELECT naem FROM users WHERE id = $1")
    .bind(&user_id)
    .fetch_all(&pool)
    .await?;

// BAD: wrong number of bind parameters compiles fine
let rows = sqlx::query("SELECT name FROM users WHERE id = $1 AND org_id = $2")
    .bind(&user_id)
    // forgot to bind org_id — runtime error
    .fetch_all(&pool)
    .await?;
```

These bugs only surface in integration tests or production. The `sqlx::query!` macro catches them at compile time by checking queries against the database schema.

## Decision

All SQL queries **must** use compile-time checked macros:

- `sqlx::query!()` — for queries returning anonymous records
- `sqlx::query_as!()` — for queries returning typed structs
- `sqlx::query_scalar!()` — for single-column queries

**Banned functions** (runtime, unchecked):
- `sqlx::query(`
- `sqlx::query_as(`
- `sqlx::query_scalar(`
- `sqlx::query_with(`

```rust
// GOOD: compile-time checked — typo in column name is a compile error
let user = sqlx::query_as!(
    UserRow,
    r#"SELECT id, name, email FROM users WHERE id = $1"#,
    user_id.as_uuid()
)
.fetch_optional(&pool)
.await?;
```

**Offline mode:** CI uses `SQLX_OFFLINE=true` with a checked-in `sqlx-data.json` (or `.sqlx/` directory) so queries are verified without a live database.

## Consequences

**Positive:**
- Column typos, type mismatches, and bind parameter errors caught at compile time
- Refactoring database schema immediately surfaces all broken queries
- `SQLX_OFFLINE` mode enables CI builds without a running database

**Negative:**
- Requires running `cargo sqlx prepare` after query changes to update offline data
- Slightly slower compilation due to macro expansion
- Dynamic queries (e.g., optional filters) require conditional query construction with separate `query!` calls

## Enforcement

- **Enforcement test:** `tests/rust_patterns_test.rs` scans all `.rs` files in `src/infra/` for banned patterns: `sqlx::query(`, `sqlx::query_as(`, `sqlx::query_scalar(`, `sqlx::query_with(`
- **CI:** Builds with `SQLX_OFFLINE=true` — if offline data is stale, compilation fails
- **Command:** `cargo sqlx prepare --check` in CI verifies offline data is up to date
