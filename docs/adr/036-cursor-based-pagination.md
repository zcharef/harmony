# ADR-036: Cursor-Based Pagination -- No SQL OFFSET

**Status:** Accepted
**Date:** 2026-03-16

## Context

`OFFSET`-based pagination degrades at scale and produces inconsistent results:

```sql
-- BAD: OFFSET scans and discards rows — O(offset + limit) per query
SELECT * FROM messages
WHERE channel_id = $1
ORDER BY created_at DESC
OFFSET 10000 LIMIT 50;
-- PostgreSQL reads 10,050 rows, discards 10,000, returns 50.
-- Page 200 is 200x slower than page 1.
```

```rust
// BAD: page/offset parameters in request DTOs
#[derive(Deserialize)]
pub struct ListMessagesQuery {
    pub page: Option<i64>,       // Encourages OFFSET pagination
    pub page_number: Option<i64>, // Same problem, different name
    pub offset: Option<i64>,     // Directly maps to SQL OFFSET
    pub limit: Option<i64>,
}
```

Additionally, `OFFSET` pagination produces **inconsistent results** when data is inserted or deleted between page requests. A new message pushed to page 1 shifts all subsequent items, causing duplicates or missed items on subsequent pages.

## Decision

Use **cursor-based pagination** exclusively. The cursor is an opaque token encoding the last seen sort key.

**SQL pattern:**
```sql
-- GOOD: cursor-based — constant time regardless of depth
SELECT id, content, created_at
FROM messages
WHERE channel_id = $1
  AND created_at < $2  -- $2 is the cursor (last seen created_at)
ORDER BY created_at DESC
LIMIT $3;
```

**Rust implementation:**
```rust
#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CursorQuery {
    pub cursor: Option<String>,  // Opaque base64-encoded cursor
    pub limit: Option<i64>,      // Default 50, max 100
}

#[derive(Serialize, ToSchema)]
pub struct PaginatedResponse<T: Serialize> {
    pub items: Vec<T>,
    pub total: i64,
    pub next_cursor: Option<String>, // None when no more items
}
```

**Cursor encoding:** The cursor is a base64-encoded JSON object containing the sort key(s):
```rust
// Cursor: eyJjcmVhdGVkX2F0IjoiMjAyNi0wMy0xNlQxMjowMDowMFoifQ==
// Decoded: {"created_at": "2026-03-16T12:00:00Z"}
```

**Banned SQL patterns:**
- `OFFSET` in any query
- `LIMIT ... OFFSET ...`

**Banned DTO fields:**
- `page`
- `page_number`
- `offset`

## Consequences

**Positive:**
- Constant query time regardless of pagination depth (always scans `limit` rows, not `offset + limit`)
- Consistent results even when data is inserted/deleted between requests
- Opaque cursor allows changing the sort key or encoding without breaking clients
- Works naturally with TanStack Query's `useInfiniteQuery`

**Negative:**
- Cannot "jump to page N" — only forward/backward sequential access (acceptable for chat-style UIs)
- Cursor must encode all sort key columns (composite cursors for multi-column sorts)
- `total` count requires a separate `COUNT(*)` query (can be cached or estimated)

## Enforcement

- **Enforcement test (backend):** `tests/api_convention_test.rs` scans all `.rs` files in `src/infra/` for `OFFSET` in SQL strings — test fails if found
- **Enforcement test (backend):** `tests/api_convention_test.rs` scans request DTOs in `src/api/dto/` for fields named `page`, `page_number`, or `offset` — test fails if found
- **Type system:** `PaginatedResponse<T>` uses `next_cursor: Option<String>`, not page numbers
