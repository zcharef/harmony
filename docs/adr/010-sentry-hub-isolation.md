# ADR-010: Sentry Hub Isolation for Async Rust

**Status:** Accepted
**Date:** 2026-01-29

## Context

Sentry stores error context (user ID, breadcrumbs) in **Thread-Local Storage (TLS)**.

Tokio uses a **M:N work-stealing scheduler**: async tasks can hop between OS threads mid-execution.

**Problem without isolation:**
```
1. Request A (user=alice) sets Sentry scope
2. Tokio pauses A, runs Request B on same thread
3. Request B crashes
4. Sentry reports B's error with user=alice (WRONG!)
```

This is called **TLS context contamination**.

## Decision

Use `NewSentryLayer::new_from_top()` as the **outermost middleware** to create an isolated Sentry Hub per HTTP request.

```rust
Router::new()
    .route(...)
    .layer(TraceLayer::new_for_http())
    .layer(SentryHttpLayer::default().enable_transaction())
    .layer(NewSentryLayer::new_from_top()) // MUST be last (= outermost)
```

**Order matters:** Layers are applied in reverse order of declaration. Last declared = runs first.

## Consequences

**Positive:**
- Each request has isolated Sentry context
- user_id tags match the actual request
- No cross-request contamination

**Negative:**
- Slight overhead per request (Hub allocation)
- Must use `sentry 0.46+` for axum 0.8 compatibility

**Requirement:**
- `sentry = { version = "0.46", features = ["tower", "tower-axum-matched-path"] }`

**Why SentryHttpLayer alone is not enough:**
`SentryHttpLayer` captures request metadata but doesn't isolate the Hub. Without `NewSentryLayer`, breadcrumbs and user context leak between concurrent requests on the same thread.
