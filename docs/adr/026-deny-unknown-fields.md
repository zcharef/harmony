# ADR-026: serde(deny_unknown_fields) on Request DTOs

**Status:** Accepted
**Date:** 2026-03-16

## Context

Without `deny_unknown_fields`, typos in request bodies are silently ignored:

```rust
// BAD: no deny_unknown_fields
#[derive(Deserialize)]
pub struct CreateServerRequest {
    pub name: String,
    pub description: Option<String>,
}

// Client sends: { "name": "My Server", "descrption": "A cool server" }
//                                        ^^^^^^^^^^^ typo!
// Serde silently ignores "descrption" and sets description = None.
// The client thinks they set a description. The server silently drops it.
```

This is especially insidious for optional fields — the client sends the field (with a typo), the server silently ignores it, and both sides believe the request succeeded. The bug only surfaces when the client notices their description is missing.

## Decision

All request DTOs must include `#[serde(deny_unknown_fields)]`:

```rust
// GOOD: typos are rejected with a clear error message
#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateServerRequest {
    pub name: String,
    pub description: Option<String>,
}

// Client sends: { "name": "My Server", "descrption": "A cool server" }
// Response: 400 Bad Request
// {
//   "type": "about:blank",
//   "title": "Bad Request",
//   "status": 400,
//   "detail": "unknown field `descrption`, expected `name` or `description`"
// }
```

**Scope:** This applies to all `Deserialize` structs in `src/api/dto/` that represent incoming request bodies or query parameters. Response DTOs (only `Serialize`) are not affected.

**Trade-off acknowledged:** `deny_unknown_fields` breaks forward compatibility during rolling deployments. If v2 of a client sends a new field that v1 of the server doesn't know about, the server rejects the request. This is an acceptable trade-off because:
1. Our client and server are deployed together (Tauri app bundles both)
2. Type safety and typo detection outweigh rolling deployment flexibility
3. API versioning (ADR-020) handles intentional schema evolution

## Consequences

**Positive:**
- Client typos produce immediate, clear error messages instead of silent data loss
- Clients cannot accidentally send fields the server ignores (e.g., `isAdmin: true`)
- Forces explicit API evolution — new fields require intentional server-side changes

**Negative:**
- Breaks forward compatibility — old server rejects new client fields (mitigated by API versioning)
- Every request DTO needs the annotation (enforcement test catches omissions)
- Third-party integrations sending extra fields will be rejected (use a separate DTO without the annotation for webhook receivers)

## Enforcement

- **Enforcement test:** `tests/rust_patterns_test.rs` scans all structs in `src/api/dto/` that derive `Deserialize` and verifies they also have `#[serde(deny_unknown_fields)]`
- **CI:** The enforcement test runs as part of `cargo test`
