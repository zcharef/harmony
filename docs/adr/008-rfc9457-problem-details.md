# ADR-008: RFC 9457 Problem Details for Errors

**Status:** Accepted
**Date:** 2026-01-29

## Context

HTTP APIs need consistent error responses. Options:
1. **Ad-hoc JSON** - `{"error": "Something went wrong"}`
2. **HTTP status only** - Just 400/401/500
3. **RFC 9457** - Standard `application/problem+json` format

## Decision

All errors return **RFC 9457 Problem Details**:

```json
{
  "type": "about:blank",
  "title": "Validation Error",
  "status": 400,
  "detail": "Email format is invalid",
  "instance": "/v1/auth/signup"
}
```

**Implementation:**
```rust
#[derive(Serialize, ToSchema)]
pub struct ProblemDetails {
    #[serde(rename = "type")]
    pub type_uri: String,      // "about:blank" or custom URI
    pub title: String,         // Human-readable summary
    pub status: u16,           // HTTP status code
    pub detail: String,        // Specific explanation
    pub instance: Option<String>, // Request path
}
```

## Consequences

**Positive:**
- Standard format understood by API clients
- TypeScript can type errors strongly
- `type` field enables programmatic error handling

**Negative:**
- Slightly verbose compared to simple `{"error": "..."}`

**Mapping:**
| DomainError | HTTP Status | title |
|-------------|-------------|-------|
| NotFound | 404 | "Not Found" |
| ValidationError | 400 | "Bad Request" |
| Forbidden | 403 | "Forbidden" |
| Conflict | 409 | "Conflict" |
| Internal | 500 | "Internal Server Error" |

**TypeScript client:**
```typescript
if (error instanceof ApiError) {
  const problem = error.body as ProblemDetails;
  toast.error(problem.detail);
}
```
