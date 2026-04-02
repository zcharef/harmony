# ADR-024: PostgreSQL Aggregate Type Coercion

**Status:** Accepted
**Date:** 2026-03-16

## Context

PostgreSQL silently widens aggregate return types, causing sqlx `ColumnDecode` panics at runtime:

```rust
// BAD: SUM(bigint) returns NUMERIC, not BIGINT — sqlx panics at runtime
let count = sqlx::query_scalar!(
    r#"SELECT SUM(message_count) FROM channels WHERE server_id = $1"#,
    server_id.as_uuid()
)
.fetch_one(&pool)
.await?;
// Runtime panic: ColumnDecode { source: "mismatched types; Rust type `i64`
//   is not compatible with SQL type `NUMERIC`" }
```

PostgreSQL type widening rules:
- `SUM(integer)` returns `bigint`
- `SUM(bigint)` returns `numeric` (arbitrary precision — no Rust equivalent)
- `AVG(anything)` returns `numeric`
- `SUM`/`AVG` on empty sets returns `NULL`

The `numeric` type has no direct Rust mapping in sqlx. And `NULL` on an empty set causes `Option` unwrapping issues when the developer expects a count.

## Decision

**Always** cast aggregates to the expected type and wrap in `COALESCE`:

```rust
// GOOD: explicit cast + COALESCE prevents both type mismatch and NULL
let total = sqlx::query_scalar!(
    r#"SELECT COALESCE(SUM(message_count)::BIGINT, 0) as "total!" FROM channels WHERE server_id = $1"#,
    server_id.as_uuid()
)
.fetch_one(&pool)
.await?;
// total is i64, never NULL, never NUMERIC
```

**Pattern for all aggregates:**
- `SUM`: `COALESCE(SUM(col)::BIGINT, 0) as "alias!"`
- `AVG`: `COALESCE(AVG(col)::DOUBLE PRECISION, 0.0) as "alias!"`
- `ARRAY_AGG`: `COALESCE(ARRAY_AGG(col), '{}') as "alias!"`

The `"alias!"` syntax tells sqlx the column is non-nullable (because `COALESCE` guarantees it).

## Consequences

**Positive:**
- Eliminates runtime `ColumnDecode` panics from type widening
- `COALESCE` handles empty result sets — no `Option` unwrapping needed
- `"alias!"` tells sqlx the column is non-nullable — cleaner Rust types
- Explicit about the expected return type in every aggregate query

**Negative:**
- Every aggregate query requires the `COALESCE(...::TYPE, default)` boilerplate
- Developers must know the PostgreSQL type widening rules (this ADR serves as documentation)
- The `::BIGINT` cast truncates values exceeding `i64::MAX` (acceptable for our use cases)

## Enforcement

- **Enforcement test:** `tests/rust_patterns_test.rs` scans all `.rs` files in `src/infra/` for SQL strings containing `SUM(`, `AVG(`, or `ARRAY_AGG(` and verifies they include an explicit `::` cast
- **Code review:** Aggregate queries without `COALESCE` and explicit casts are rejected with a pointer to this ADR
