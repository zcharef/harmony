# ADR-013: Static Analysis Tests for API Standards Enforcement

**Status:** Accepted
**Date:** 2026-01-30

## Context

Junior developers may add endpoints that:
1. Lack OpenAPI documentation (`#[utoipa::path]`)
2. Return errors not following RFC 9457
3. Bypass architectural boundaries

Code reviews are not reliable enforcement mechanisms.

## Decision

Implement **3-level automated enforcement**:

### Level 1: Compile-Time (Type System)
```rust
pub type ApiResult<T> = Result<T, ApiError>;
```
- `ApiError` forces RFC 9457 via `IntoResponse`
- Impossible to return non-standard error JSON

### Level 2: Static Analysis (AST Parsing)
`tests/openapi_enforcement_test.rs`:
- Parses handler files with `syn` crate
- Verifies all `pub async fn` with `State<AppState>` have `#[utoipa::path]`
- Checks `responses` clause uses `ProblemDetails` for 4xx/5xx

### Level 3: Runtime Verification
`tests/rfc9457_contract_test.rs`:
- Unit tests verify `ProblemDetails` serialization
- Integration tests (ignored by default) verify actual HTTP responses

## Consequences

**Positive:**
- `cargo test` blocks non-compliant code
- No human review needed for standards compliance
- Self-documenting via test failure messages

**Negative:**
- Extra build time (~2s for AST parsing)
- False positives possible for helper functions

**Files:**
- `tests/openapi_enforcement_test.rs` - OpenAPI checks
- `tests/rfc9457_contract_test.rs` - Error format checks
- `tests/architecture_test.rs` - Hexagonal boundary checks

**Running:**
```bash
just test-arch          # Architecture + enforcement tests
cargo test --test openapi_enforcement_test
cargo test --test rfc9457_contract_test
```
