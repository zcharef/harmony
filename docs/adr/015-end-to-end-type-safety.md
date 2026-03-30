# ADR-015: End-to-End Type Safety Pipeline

**Status:** Accepted
**Date:** 2026-03-16

## Context

When TypeScript types are written manually to match the Rust API, they inevitably drift:

```typescript
// BAD: manually defined, already out of date
interface UserResponse {
  id: string;
  email: string;
  // missing: display_name was added to Rust last week
}

const user = await api.getMe(); // user.displayName is undefined at runtime
```

The developer adds a field to the Rust DTO, the OpenAPI spec regenerates, but nobody updates the hand-written TypeScript interface. The frontend silently reads `undefined` for the new field and ships a broken UI.

## Decision

The Rust-generated OpenAPI spec (`openapi.json`) is the **single source of truth** for all API types. TypeScript types are **auto-generated** from it. No manual type definitions for API shapes exist in the frontend.

**Pipeline:**
1. Rust DTOs with `#[derive(Serialize, ToSchema)]` define the schema
2. `just gen-api` exports `openapi.json` and runs `openapi-ts` to generate TypeScript client types
3. CI verifies the generated types are up to date

```bash
# In CI:
just gen-api
git diff --exit-code openapi.json   # Fail if spec changed but wasn't committed
tsc --noEmit                        # Fail if generated types don't compile
```

**Frontend usage:**
```typescript
// GOOD: auto-generated types from openapi.json
import type { UserResponse } from '@/lib/api-client';

// TypeScript knows every field. Adding a field in Rust
// automatically appears here after regeneration.
```

## Consequences

**Positive:**
- Zero type drift between Rust API and TypeScript frontend
- Adding a field in Rust automatically flows to TypeScript after `just gen-api`
- CI catches forgotten regeneration before merge

**Negative:**
- Developers must run `just gen-api` after changing DTOs (CI catches if forgotten)
- Generated code is not hand-optimized (acceptable trade-off for correctness)

## Enforcement

- **CI step:** `just gen-api && tsc --noEmit` — fails if types are stale or don't compile
- **Diff check:** `git diff --exit-code harmony-api/openapi.json` — fails if spec was changed but not committed
- **Lint rule:** PR review flags any `interface` or `type` in `src/lib/` that duplicates a generated API type
