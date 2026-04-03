# Harmony — Rust API

Rust REST API for Harmony desktop app (Tauri). Backend uses Supabase (Postgres + Auth).

## Commands

> Run `just` to see all available commands with descriptions.

| Task | Command | Notes |
|------|---------|-------|
| **Run server** | `just run` | Single run, port 3000 |
| **Dev mode** | `just dev` | Hot reload via cargo-watch |
| **Debug mode** | `just debug` | RUST_LOG=debug |
| **All tests** | `just test` | Unit + integration |
| **Unit tests** | `just test-unit` | `--lib` only |
| **Arch tests** | `just test-arch` | Hexagonal boundary checks |
| **Format** | `just fmt` | cargo fmt |
| **Lint** | `just lint` | clippy with warnings=errors |
| **Fix all** | `just fix` | fmt + clippy --fix |
| **Quality wall** | `just wall` | fmt-check + lint + test + arch |
| **Build release** | `just build-release` | Optimized binary |
| **OpenAPI** | `just openapi` | Shows Swagger UI URL |
| **Setup tools** | `just setup` | Install cargo-watch, audit, deny |

**First-time setup:**
```bash
just setup              # Install dev tools
just env                # Copy .env.example → .env
```

## Architecture: Hexagonal (Ports & Adapters)

- **Domain (`src/domain`):** Pure Rust. Contains Models (`models/`), Repository
  Interfaces (`ports/`), and Business Logic (`services/`). Zero infrastructure
  dependencies allowed here.
- **Infrastructure (`src/infra`):** Implementations of Ports. Supabase Auth
  (`infra/auth`), Postgres via SQLx (`infra/postgres`).
- **API (`src/api`):** HTTP layer via Axum. Handlers, DTOs, and Middleware.

## Code Style & Rules

- **Strict Typing:** Use NewTypes (`struct UserId(Uuid)`) instead of raw
  `String` or `Uuid` for IDs.
- **OpenAPI SSoT:** Code-First approach. Use `utoipa` macros (`#[utoipa::path]`,
  `#[derive(ToSchema)]`) on Rust structs/handlers. Never edit YAML manually.
- **Error Handling:**
  - Domain: Use `thiserror`.
  - Application: Use `anyhow`.
  - HTTP: Map errors to RFC 9457 Problem Details.
- **Async:** Use `tokio` runtime. All I/O must be async.
- **Config:** Use typed `config` structs with `secrecy::Secret` for sensitive
  values.
- **Auth:** Supabase JWT (HS256) verified server-side via `jsonwebtoken` crate.
  Bearer-only auth — no session cookies.
- **Observability:** Structured JSON logs via `tracing`. Propagate Trace IDs
  (OpenTelemetry) (ADR-017).
- **Tracing Severity (Sentry-aware, ADR-046):** `ERROR` = Sentry alert (crashes,
  config failures, exhausted retries, safety-critical failures). `WARN` = Sentry
  breadcrumb (individual retry attempts, expected rejections, graceful
  degradation). Never use `ERROR` for expected business logic (4xx from users,
  rate limits, validation). External service adapters must classify errors as
  retryable vs non-retryable: non-retryable (401, 403) → `error!` immediately;
  retryable (5xx, 429) → `warn!` per attempt, `error!` after exhaustion.
- **Compile-Time SQL:** All queries use `sqlx::query!` or `sqlx::query_as!`.
  Runtime `sqlx::query(` is forbidden (ADR-016).
- **PostgreSQL Aggregates:** `SUM(bigint)` returns NUMERIC — always cast
  `::BIGINT` and wrap `COALESCE`. Pattern:
  `COALESCE(SUM(col)::BIGINT, 0) as "total!"` (ADR-024).
- **No std::sync::Mutex:** Use `tokio::sync::Mutex` or `DashMap` in async code.
  `std::sync::Mutex` across `.await` deadlocks (ADR-022).
- **No process::exit():** Use `anyhow::bail!()`, `return Err(...)`, or let
  panic handler run (ADR-027).
- **Typed Config Only:** No `std::env::var()` outside `config.rs`. All env vars
  through Config struct (ADR-025).
- **DTO Serialization:** All DTOs must have `#[serde(rename_all = "camelCase")]`
  (ADR-039). Request DTOs must also have `#[serde(deny_unknown_fields)]`
  (ADR-026).
- **Layer Conversions:** Domain-to-DTO uses `impl From<Model> for ResponseDto`.
  Request-to-Domain uses `impl TryFrom<RequestDto> for DomainInput`. Never
  construct DTOs inline in handlers (ADR-023).
- **Server Timestamps:** Clients never send `created_at`/`updated_at`. Server
  generates all temporal fields (ADR-028).

### Database

- **RLS on every table:** Row-Level Security must be enabled on all tables (ADR-040).
- **Pool timeouts required:** `acquire_timeout` and `statement_timeout` must be
  configured on every connection pool (ADR-041).
- **Migrations are SSoT:** Never modify the database via the Supabase Dashboard.
  All schema changes go through migration files (ADR-043).
- **Idempotent & non-destructive migrations:** Use `IF NOT EXISTS`, `IF EXISTS`.
  No `DROP COLUMN`/`DROP TABLE` (ADR-019).
- **API versioning:** All routes live under `/v1/` (ADR-020).

## Tech Stack

- **Web Framework:** Axum 0.8
- **Runtime:** Tokio
- **API Docs:** Utoipa 5 (OpenAPI 3.1)
- **Database:** SQLx (PostgreSQL via Supabase)
- **Auth:** `jsonwebtoken` (Supabase JWT, Bearer-only)
- **Desktop Client:** Tauri

## Directory Structure

```text
src/
├── domain/       # PURE: Models, Ports (Traits), Services, Errors
├── infra/        # IMPL: Postgres (SQLx), Supabase Auth
├── api/          # HTTP: Router, Handlers, Middleware, DTOs
│   ├── openapi.rs  # Utoipa config
│   └── handlers/   # Health check (+ future endpoints)
├── config.rs     # Typed environment configuration
└── main.rs       # Wiring, Graceful Shutdown, Tracing Init
```

## Critical Invariants

1. **Secrets:** Never log secrets. Use `Secret<String>` wrapper.
2. **No `unwrap()`/`expect()` in production code** — propagate with `?`.
3. **Domain purity:** Domain layer must have zero infra imports.
4. **No Split-Brain:** All business logic must reside in Rust API.
5. **Real-Time:** `GET /v1/events` SSE endpoint streams events to connected clients. Mutation handlers publish events via the EventBus after DB commits. Supabase Realtime is no longer used. See ADR-SSE-001 through ADR-SSE-007 in `dev/active/sse-realtime-migration/`.
6. **Exhaustive error mapping:** `From<DomainError> for ApiError` uses exhaustive match, no `_ =>` wildcard (ADR-021).
7. **No mocks:** Tests use real DB (testcontainers) and real HTTP. `mockall`/`mock_derive` are banned. External HTTP only via `wiremock` (ADR-018).
8. **Cursor pagination only:** No SQL `OFFSET`. Use `WHERE created_at < $cursor` (ADR-036).
9. **Soft deletes for messages:** `UPDATE SET deleted_at = now()`, never `DELETE FROM messages` (ADR-038).
10. **Supabase workflow:** Never modify the database via the Dashboard. All schema changes go through migration files; migrations are the SSoT (ADR-043).

## OpenAPI SSoT Pipeline

The Rust API is the **Single Source of Truth** for all TypeScript types consumed by the Tauri app.

```
Rust #[derive(ToSchema)] → cargo run --bin export_openapi → openapi.json → @hey-api/openapi-ts → generated types
```

**After any change to handlers, DTOs, or domain models with `ToSchema`:**
1. `just export-openapi` — regenerate `openapi.json`
2. Regenerate TypeScript client
3. Verify all TypeScript compiles

### Utoipa 5 Gotchas

- **`#[schema(example)]` on `Option<NewType>` fields is silently ignored** — utoipa generates `oneOf: [null, $ref]`. Examples must live on the **NewType schema itself**.
- **External API failures** must use `DomainError::ExternalService` (→ 502), NOT `DomainError::Internal` (→ 500).

---

## Pre-Push Checklist (Rust API)

Before pushing code, verify every applicable item:

### Architecture & Boundaries
- [ ] Domain layer (`src/domain/`) has zero infra imports (no SQLx, no Axum, no HTTP)
- [ ] Repository traits are intent-based (`create_server`, not `insert`)
- [ ] New code respects hexagonal boundaries (verified by `just test-arch`)

### Type Safety
- [ ] All IDs use NewTypes (`UserId`, etc.), never raw `String`/`Uuid`
- [ ] DTOs use `TryFrom<Dto>` for domain conversion (parse, don't validate)
- [ ] Domain → Response conversion uses `From<DomainEntity>`

### Error Handling (RFC 9457)
- [ ] Domain errors use `thiserror`, application errors use `anyhow`
- [ ] All HTTP errors map to ProblemDetails JSON
- [ ] External service failures use `DomainError::ExternalService` (→ 502), not `Internal` (→ 500)
- [ ] No `unwrap()`/`expect()` in production code — propagate with `?`

### Success Responses
- [ ] Single resource: `(StatusCode::OK, Json(response))` — no `{ data: ... }` wrapper
- [ ] Creation: `(StatusCode::CREATED, Json(entity))`
- [ ] Empty action: `StatusCode::NO_CONTENT` (zero body)
- [ ] Collections: envelope `{ items: [...], total, nextCursor }` — never bare arrays (ADR-036)

### OpenAPI SSoT
- [ ] Every handler has `#[utoipa::path]`, every DTO has `#[derive(ToSchema)]`
- [ ] `openapi.json` regenerated after DTO/handler changes (`just export-openapi`)
- [ ] `#[schema(example)]` lives on NewType schemas, not on `Option<NewType>` fields

### Observability & Security
- [ ] Logging uses `tracing::info!()` with structured fields — never `println!()`
- [ ] Sensitive values wrapped in `Secret<String>` (auto-masked in logs)
- [ ] Zero PII in logs (no emails, names, tokens)
- [ ] Config uses typed structs, not ad-hoc `std::env::var()`

### Async Safety
- [ ] No `std::sync::Mutex` in async code — use `tokio::sync::Mutex` or lock-free
- [ ] All I/O is async (tokio runtime)

### Enforcement Rules
- [ ] No `std::sync::Mutex` in async code — use `tokio::sync::Mutex` or `DashMap`
- [ ] No `std::env::var()` outside `config.rs`
- [ ] All DTOs have `#[serde(rename_all = "camelCase")]`; request DTOs also have `#[serde(deny_unknown_fields)]`
- [ ] No `OFFSET` in SQL queries — cursor pagination only
- [ ] SQL aggregates have `::BIGINT` cast and `COALESCE`
- [ ] Permission constants are powers of 2

### Testing
- [ ] Architecture boundary tests pass (`just test-arch`)
- [ ] All unit + integration tests pass (`just test`)

### Quality Wall (`just wall`)
- [ ] `cargo fmt --check` passes
- [ ] `cargo clippy --all-targets -- -D warnings` passes (zero warnings)
- [ ] `cargo test` passes (all unit + integration + arch tests)

### Security (periodic, before release)
- [ ] `cargo audit` — no known vulnerabilities
- [ ] `cargo deny check` — no banned licenses/crates
