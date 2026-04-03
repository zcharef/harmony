# ADR-046: Tracing Severity as Sentry Contract

**Status:** Accepted
**Date:** 2026-04-03

## Context

Sentry alerting in Harmony is driven entirely by `tracing` log levels via
`sentry::integrations::tracing::layer()` with an `EventFilter`:

```rust
// main.rs — production configuration
tracing::Level::ERROR => EventFilter::Event,      // → Sentry alert
tracing::Level::WARN  => EventFilter::Breadcrumb,  // → context only
_                     => EventFilter::Ignore,
```

There are no direct `sentry::capture_exception` or `sentry::capture_message`
calls in the codebase. **Choosing `error!` vs `warn!` is choosing "alert me"
vs "just add context."**

Without a clear severity policy, external service failures (OpenAI Moderation,
Google Safe Browsing) were logged as `warn!` after retries exhausted. This
meant the moderation pipeline could be permanently broken (e.g., bad API key =
401 on every request) with **zero Sentry alerts**. Messages passed through
unmoderated — a security gap invisible to operators.

This ADR establishes the contract between tracing levels and Sentry behavior,
extending ADR-017 (structured observability) and complementing ADR-010 (Sentry
Hub isolation).

## Decision

### Severity Classification

| Situation | Level | Rationale |
|-----------|-------|-----------|
| External service: non-retryable error (401, 403) | `error!` | Config/auth problem, will never self-heal, needs operator |
| External service: all retries exhausted on retryable errors | `error!` | Service genuinely down, operator awareness needed |
| External service: individual retry attempt | `warn!` | Transient, may self-heal next attempt, useful as breadcrumb |
| Background task: failed to complete safety-critical action | `error!` | e.g., failed to soft-delete a flagged message |
| Background task: panic caught by `catch_unwind` | `error!` | Panic = bug |
| Database query failure (infra layer) | `error!` | DB connectivity is critical infrastructure |
| Business logic rejection (auth, validation, rate-limit, content filter) | `warn!` | Expected in normal operation, not operator-actionable |
| Graceful degradation at startup | `warn!` | e.g., JWKS fetch failure — fallback path works |
| Serialization/format failure in event stream | `warn!` | Drops one event, client recovers on reconnect |

### External Service Retry Policy

All external HTTP adapters (in `src/infra/`) must:

1. **Classify errors as retryable vs non-retryable** before entering the retry loop.
2. **Short-circuit on non-retryable errors** (4xx except 429) — `tracing::error!`,
   return immediately, no backoff.
3. **Log individual retry attempts at `warn!`** — they become Sentry breadcrumbs
   (useful context if an error follows).
4. **Escalate to `error!` after all retries exhausted** — the service is genuinely
   down or degraded.

**Retryable:** 5xx, 429 (rate-limited), network timeouts, connection errors.
**Non-retryable:** 401, 403, 400, 404, and other 4xx (except 429).

Reference implementation: `is_retryable()` in `src/infra/safe_browsing.rs` and
`is_retryable_status()` in `src/infra/openai_moderator.rs`.

### Noise Guard

Sentry deduplicates by fingerprint. 200 identical 401 errors become **1 issue**
with an event count spike. This is the correct signal: "moderation has been
broken for N minutes." No additional rate-limiting or circuit-breaking is needed
at the application level for alerting purposes.

## Consequences

**Positive:**
- Operators are alerted when external services are broken, before users notice
- Non-retryable config errors (bad API key) are detected on the first request,
  not after N minutes of silent failure
- No wasted retry cycles on permanent failures (401 → immediate return)
- Clear, auditable rule for choosing log levels — no judgment calls

**Negative:**
- Developers must understand the severity contract when writing new adapters
- Wrong classification (e.g., `error!` on a 429) would cause alert noise

## Enforcement

- **Code review:** Every `tracing::error!` and `tracing::warn!` in `src/infra/`
  and `tokio::spawn` blocks must be justified against this table.
- **CLAUDE.md rule:** "Tracing Severity (Sentry-aware)" is documented in the
  Code Style & Rules section.
- **New adapter checklist:** Any new external service adapter must implement
  `is_retryable` classification and follow the retry escalation pattern.
