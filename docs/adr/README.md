# Architecture Decision Records (ADR)

This directory contains Architecture Decision Records for the Harmony project.

## What is an ADR?

An ADR is a document that captures an important architectural decision made along with its context and consequences. It helps future developers (including yourself) understand **why** certain choices were made.

## Index

| ADR | Title | Status |
|-----|-------|--------|
| [001](./001-use-rust-for-backend.md) | Use Rust for Backend API | Accepted |
| [003](./003-hexagonal-architecture.md) | Hexagonal Architecture (Ports & Adapters) | Accepted |
| [004](./004-intent-based-repositories.md) | Intent-Based Repository Methods | Accepted |
| [006](./006-sse-over-websockets.md) | ~~SSE Over WebSockets~~ → Supabase Realtime | Superseded |
| [007](./007-code-first-openapi.md) | Code-First OpenAPI with utoipa | Accepted |
| [008](./008-rfc9457-problem-details.md) | RFC 9457 Problem Details for Errors | Accepted |
| [009](./009-newtype-pattern.md) | NewType Pattern for Type-Safe IDs | Accepted |
| [010](./010-sentry-hub-isolation.md) | Sentry Hub Isolation for Async Rust | Accepted |
| [013](./013-enforcement-tests.md) | Static Analysis Tests for API Standards | Accepted |
| [014](./014-parse-dont-validate.md) | Parse, Don't Validate | Accepted |
| [015](./015-end-to-end-type-safety.md) | End-to-End Type Safety Pipeline | Accepted |
| [016](./016-compile-time-sql.md) | Compile-Time SQL Queries | Accepted |
| [017](./017-structured-observability.md) | Structured Observability Only | Accepted |
| [018](./018-no-mock-testing.md) | No-Mock Testing Strategy | Accepted |
| [019](./019-idempotent-migrations.md) | Idempotent & Non-Destructive Migrations | Accepted |
| [020](./020-api-versioning-envelopes.md) | API Versioning & Response Envelopes | Accepted |
| [021](./021-exhaustive-error-mapping.md) | Exhaustive DomainError to ApiError Mapping | Accepted |
| [022](./022-no-std-mutex-in-async.md) | No std::sync::Mutex in Async Code | Accepted |
| [023](./023-from-tryfrom-boundaries.md) | From/TryFrom at Layer Boundaries | Accepted |
| [024](./024-pg-aggregate-coercion.md) | PostgreSQL Aggregate Type Coercion | Accepted |
| [025](./025-typed-config.md) | Typed Config -- No Ad-Hoc env::var() | Accepted |
| [026](./026-deny-unknown-fields.md) | serde(deny_unknown_fields) on Request DTOs | Accepted |
| [027](./027-no-process-exit.md) | No process::exit() -- Graceful Shutdown Only | Accepted |
| [028](./028-server-generated-timestamps.md) | Server-Generated Timestamps | Accepted |
| [029](./029-query-key-factory.md) | Query Key Factory Pattern | Accepted |
| [030](./030-no-logic-in-barrels.md) | No Logic in Barrel Exports | Accepted |
| [031](./031-discriminated-unions-async-state.md) | Discriminated Unions for Async State | Accepted |
| [032](./032-tailwind-only-styling.md) | ~~Tailwind-Only Styling~~ → HeroUI (ADR-044) | Superseded |
| [033](./033-route-constants-ssot.md) | Route Constants SSoT | Accepted |
| [034](./034-error-boundaries-per-route.md) | Error Boundaries Per Feature Route | Accepted |
| [035](./035-satisfies-over-as.md) | satisfies Over as Type Assertions | Accepted |
| [036](./036-cursor-based-pagination.md) | Cursor-Based Pagination -- No SQL OFFSET | Accepted |
| [037](./037-permission-bitmask-invariants.md) | Permission Bitmask Invariants | Accepted |
| [038](./038-soft-deletes-user-content.md) | Soft Deletes for User Content | Accepted |
| [039](./039-camelcase-dto-serialization.md) | camelCase DTO Serialization | Accepted |
| [040](./040-rls-enforcement.md) | RLS Enforcement on All Tables | Accepted |
| [041](./041-database-query-timeouts.md) | Database Query Timeouts | Accepted |
| [042](./042-frontend-structured-logging.md) | Frontend Structured Logging — No Raw console.* | Accepted |
| [043](./043-supabase-deterministic-workflow.md) | Supabase Deterministic Workflow — Migrations as SSoT | Accepted |
| [044](./044-heroui-component-library.md) | HeroUI Component Library — Single UI Primitive Source | Accepted |
| [045](./045-no-usestate-shadow-realtime-data.md) | No useState Shadow for Real-Time Data | Accepted |
| [046](./046-tracing-severity-sentry-contract.md) | Tracing Severity as Sentry Contract | Accepted |

## Template

When adding a new ADR, use this template:

```markdown
# ADR-XXX: Title

**Status:** Proposed | Accepted | Deprecated | Superseded
**Date:** YYYY-MM-DD

## Context

What is the issue that we're seeing that is motivating this decision?

## Decision

What is the change that we're proposing?

## Consequences

What becomes easier or more difficult because of this change?
```

## Naming Convention

- Files: `NNN-short-title.md` (e.g., `001-use-rust-for-backend.md`)
- Numbers: Three digits, zero-padded
- Titles: lowercase, hyphen-separated
