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

### Level 2: Static Analysis (Source-Level Text Scanning)
`tests/openapi_enforcement_test.rs`:
- Source-level text scanning, fast, no AST parsing needed (no `syn` crate)
- Reads handler files with `fs::read_to_string`, scans lines for `pub async fn` taking an Axum extractor (`State(`, `Json(`, `Path(`, `Query(`) and checks the preceding lines for `#[utoipa::path`
- Companion test verifies every `pub struct`/`pub enum` in `src/api/dto/` derives `ToSchema`

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
- Text scanning is heuristic: relies on formatting conventions (the macro within ~15 lines above the fn), not a real parse
- False positives possible for helper functions (mitigated by the `// not-a-handler` opt-out comment)

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
