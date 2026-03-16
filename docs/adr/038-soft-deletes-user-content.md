# ADR-038: Soft Deletes for User Content

**Status:** Accepted
**Date:** 2026-03-16

## Context

Hard deletes are irreversible and break referential integrity:

```sql
-- BAD: hard delete — data gone forever, breaks references
DELETE FROM messages WHERE id = $1;

-- Other tables referencing this message (reactions, threads, pins) now have
-- dangling foreign keys or cascade-delete entire conversation threads.
-- Audit trail is destroyed. GDPR data export requests cannot be fulfilled
-- if the data is gone before the export window closes.
```

Hard deletes also make it impossible to show "This message was deleted" in the UI, which is the expected behavior in any chat application.

## Decision

User content (messages) uses **soft deletes** via a `deleted_at` timestamp column. Hard deletes are reserved for GDPR data erasure requests.

**Schema:**
```sql
CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id UUID NOT NULL REFERENCES channels(id),
    author_id UUID NOT NULL REFERENCES users(id),
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ  -- NULL = not deleted, non-NULL = deleted
);

CREATE INDEX IF NOT EXISTS idx_messages_not_deleted
    ON messages (channel_id, created_at DESC)
    WHERE deleted_at IS NULL;
```

**Query pattern — all queries filter `deleted_at IS NULL` by default:**
```rust
// GOOD: soft delete — mark as deleted, don't remove the row
let deleted = sqlx::query!(
    r#"UPDATE messages SET deleted_at = now() WHERE id = $1 AND author_id = $2"#,
    message_id.as_uuid(),
    author_id.as_uuid()
)
.execute(&pool)
.await?;

// GOOD: queries always exclude soft-deleted rows
let messages = sqlx::query_as!(
    MessageRow,
    r#"SELECT id, content, created_at
       FROM messages
       WHERE channel_id = $1
         AND deleted_at IS NULL
       ORDER BY created_at DESC
       LIMIT $2"#,
    channel_id.as_uuid(),
    limit
)
.fetch_all(&pool)
.await?;
```

**GDPR hard delete (only when legally required):**
```rust
// Hard delete — only for GDPR "right to erasure" requests
// Requires explicit admin action, not available through normal API
sqlx::query!("DELETE FROM messages WHERE author_id = $1", user_id.as_uuid())
    .execute(&pool)
    .await?;
```

## Consequences

**Positive:**
- Deleted messages show "This message was deleted" in the UI (content nullified, row preserved)
- Referential integrity maintained — reactions, threads, pins still reference a valid row
- Audit trail preserved — can investigate abuse reports after deletion
- GDPR compliance: soft delete immediately (user sees deletion), hard delete during scheduled erasure

**Negative:**
- Table size grows over time (mitigated by partial index on `deleted_at IS NULL`)
- Every query must include `WHERE deleted_at IS NULL` (easy to forget — enforcement test catches it)
- Scheduled cleanup job needed for hard-deleting expired soft-deleted rows (GDPR compliance window)

## Enforcement

- **Enforcement test:** `tests/architecture_test.rs` scans all `.rs` files in `src/infra/` for `DELETE FROM messages` — test fails if found (hard deletes must go through a dedicated GDPR erasure path, not normal repository methods)
- **Partial index:** `idx_messages_not_deleted` ensures queries filtering `deleted_at IS NULL` remain fast even as soft-deleted rows accumulate
