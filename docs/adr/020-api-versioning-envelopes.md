# ADR-020: API Versioning & Response Envelopes

**Status:** Accepted
**Date:** 2026-03-16

## Context

Without versioning, breaking changes immediately affect all clients:

```rust
// BAD: no version prefix — breaking changes break every client instantly
Router::new()
    .route("/users/me", get(get_me))
    .route("/servers", get(list_servers))
```

Without a standard collection envelope, clients must guess the response shape:

```json
// BAD: bare array — no metadata, no pagination info
[
  {"id": "abc", "name": "Server 1"},
  {"id": "def", "name": "Server 2"}
]
```

Clients cannot determine total count, whether more items exist, or how to fetch the next page.

## Decision

**All non-system routes live under `/v1/`:**

```rust
// GOOD: versioned routes
let v1 = Router::new()
    .route("/users/me", get(get_me))
    .route("/servers", get(list_servers))
    .route("/servers/:server_id/channels", get(list_channels));

Router::new()
    .nest("/v1", v1)
    .route("/health", get(health_check))       // system — no version prefix
    .merge(SwaggerUi::new("/swagger-ui"))       // system — no version prefix
    .route("/api-docs/openapi.json", get(docs)) // system — no version prefix
```

**System routes exempt from versioning:**
- `/health` — load balancer health checks
- `/swagger-ui` — API documentation UI
- `/api-docs/openapi.json` — OpenAPI spec

**Collection responses use a standard envelope:**

```rust
#[derive(Serialize, ToSchema)]
pub struct PaginatedResponse<T: Serialize> {
    pub items: Vec<T>,
    pub total: i64,
    pub next_cursor: Option<String>,
}
```

```json
{
  "items": [
    {"id": "abc", "name": "Server 1"},
    {"id": "def", "name": "Server 2"}
  ],
  "total": 42,
  "nextCursor": "eyJjcmVhdGVkX2F0IjoiMjAyNi0wMy0xNlQxMjowMDowMFoifQ=="
}
```

## Consequences

**Positive:**
- Breaking changes go in `/v2/` without disrupting existing clients
- Standard envelope enables generic pagination components on the frontend
- `next_cursor` supports efficient cursor-based pagination (see ADR-036)
- System routes are discoverable without knowing the API version

**Negative:**
- Every route has a `/v1/` prefix (minor verbosity)
- Must maintain multiple versions during deprecation period
- `PaginatedResponse<T>` wrapper adds a level of nesting to collection responses

## Enforcement

- **Enforcement test:** `tests/api_convention_test.rs` scans the router definition to verify all non-system routes are nested under `/v1/`
- **Type system:** `PaginatedResponse<T>` is the only return type for collection endpoints — returning a bare `Vec<T>` is a compile-time type mismatch
- **OpenAPI:** `utoipa` generates the envelope schema, ensuring frontend types match
