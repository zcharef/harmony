# ADR-001: Use Rust for Backend API

**Status:** Accepted
**Date:** 2026-01-29

## Decision

Use **Rust with Axum** for the backend API.

**Rationale:**
- **Type safety**: Rust's type system catches bugs at compile time (NewTypes for IDs, exhaustive enums)
- **Performance**: Zero-cost abstractions, no GC pauses, efficient async with Tokio
- **Ecosystem**: Mature crates (utoipa for OpenAPI, sentry, tracing)
- **SQLx preparation**: When migrating to Postgres, sqlx provides compile-time checked queries
- **Long-term**: Rust skills are valuable; code is maintainable for years

## Consequences

**Positive:**
- Compile-time guarantees prevent entire classes of bugs
- Single binary deployment (no node_modules, no runtime deps)
- Excellent async performance for concurrent requests

**Negative:**
- Steeper learning curve for team members unfamiliar with Rust
- Longer compile times (mitigated with Mold linker, incremental builds)
- Smaller talent pool compared to Node.js/Go

**Mitigations:**
- Document patterns clearly (CLAUDE.md, this ADR folder)
- Use well-known crates, avoid exotic Rust features
- Architecture tests enforce hexagonal pattern compliance
