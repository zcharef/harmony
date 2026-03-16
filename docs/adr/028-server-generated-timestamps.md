# ADR-028: Server-Generated Timestamps

**Status:** Accepted
**Date:** 2026-03-16

## Context

Accepting timestamps from clients is unreliable and exploitable:

```rust
// BAD: client-provided timestamp — unreliable
#[derive(Deserialize)]
pub struct CreateMessageRequest {
    pub content: String,
    pub created_at: DateTime<Utc>, // Client can backdate or future-date messages
}

// Client sends: { "content": "hello", "created_at": "1970-01-01T00:00:00Z" }
// Message appears at the top of the chat history forever.
```

Client clocks are unreliable (wrong timezone, skewed, manually set). Accepting client timestamps allows:
- Backdating messages to appear earlier in history
- Future-dating messages to stay pinned at the top
- Inconsistent ordering across clients with different clocks

## Decision

The server generates all timestamps. Clients never send `created_at`, `updated_at`, `edited_at`, or `joined_at`.

```rust
// GOOD: server generates timestamps — clients cannot manipulate ordering
#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateMessageRequest {
    pub content: String,
    // No timestamp fields — server generates them
}

// In the service layer:
pub async fn create_message(&self, input: NewMessage) -> Result<Message, DomainError> {
    let now = Utc::now();
    let message = self.repo.insert(Message {
        id: MessageId::new(),
        content: input.content,
        created_at: now,
        updated_at: now,
        // ...
    }).await?;
    Ok(message)
}
```

**Database defaults as backup:**
```sql
CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**All timestamps are ISO 8601 UTC** in API responses:
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "content": "Hello, world!",
  "createdAt": "2026-03-16T12:00:00Z",
  "updatedAt": "2026-03-16T12:00:00Z"
}
```

**Allowlist — client-provided timestamps:**
- `expires_at` in invite creation (the client specifies when the invite should expire)

## Consequences

**Positive:**
- Consistent, trustworthy ordering across all clients
- No clock skew issues — server clock is the single source of truth
- Cannot manipulate message history by backdating or future-dating
- Database `DEFAULT now()` provides a safety net if application code forgets

**Negative:**
- Client-perceived latency is not reflected in timestamps (message `created_at` is server-receive time, not client-send time)
- Cannot implement "scheduled messages" without an explicit `scheduled_for` field (a separate concern)

## Enforcement

- **Enforcement test:** `tests/rust_patterns_test.rs` scans all request DTO structs (`Deserialize` structs in `src/api/dto/`) for fields named `created_at`, `updated_at`, `edited_at`, or `joined_at` — test fails if found (with an allowlist for `expires_at`)
- **Database:** `DEFAULT now()` on all timestamp columns ensures server-generated values even if application code is buggy
