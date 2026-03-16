# ADR-017: Structured Observability Only

**Status:** Accepted
**Date:** 2026-03-16

## Context

Ad-hoc print statements produce unstructured output that cannot be queried, filtered, or correlated:

```rust
// BAD: unstructured, no context, no levels, not machine-parseable
println!("Processing user {}", user_id);
eprintln!("ERROR: failed to fetch channel: {}", err);
dbg!(&request); // leaks Debug output of potentially sensitive data
```

These statements:
- Cannot be filtered by severity in production
- Cannot be correlated with request IDs or trace spans
- Are invisible to log aggregation tools (Datadog, Grafana Loki)
- `dbg!` in particular leaks `Debug` representations that may contain PII

## Decision

Use the `tracing` crate exclusively for all observability. Ban all print macros.

**Clippy lints (deny):**
```toml
# In Cargo.toml or clippy.toml
[lints.clippy]
print_stdout = "deny"
print_stderr = "deny"
dbg_macro = "deny"
```

**Every handler must be instrumented:**
```rust
// GOOD: structured span with typed fields
#[tracing::instrument(
    skip(state),
    fields(channel_id = %channel_id, user_id = %auth.user_id)
)]
pub async fn get_messages(
    State(state): State<AppState>,
    Path(channel_id): Path<ChannelId>,
    auth: AuthenticatedUser,
) -> ApiResult<Json<PaginatedResponse<MessageResponse>>> {
    tracing::info!("fetching messages");

    let messages = state.message_service
        .list_by_channel(&channel_id, &cursor)
        .await?;

    tracing::debug!(count = messages.len(), "messages fetched");
    Ok(Json(messages.into()))
}
```

**Rules:**
- Use structured fields (`key = value`), not string interpolation (`format!`)
- `skip(state)` on all handlers to avoid logging the entire AppState
- Sensitive fields (tokens, passwords) must never appear in spans

## Consequences

**Positive:**
- All logs are structured JSON in production — queryable by any field
- Request tracing via span propagation (every log line carries request context)
- Clippy enforces at compile time — no print statements slip through

**Negative:**
- `tracing::instrument` macro adds boilerplate to every handler
- Developers must think about which fields to include in spans
- `dbg!` is no longer available for quick debugging (use `tracing::debug!` instead)

## Enforcement

- **Clippy lints:** `print_stdout = "deny"`, `print_stderr = "deny"`, `dbg_macro = "deny"` in workspace lint configuration
- **Enforcement test:** `tests/architecture_test.rs` scans all `pub async fn` handlers in `src/api/handlers/` for `#[tracing::instrument]` attribute
- **CI:** `cargo clippy -- -D warnings` fails the build if any print macro is used
