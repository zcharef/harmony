# ADR-042: Frontend Structured Logging — No Raw console.*

**Status:** Accepted
**Date:** 2026-03-16

## Context

The Rust API uses `tracing` for structured logging (ADR-017). Every log entry is JSON, includes correlation IDs, and is captured by Sentry. The frontend has no equivalent — `console.log`/`console.error` goes to browser devtools and is invisible in production.

```typescript
// BAD: invisible in production, no structure, no Sentry
console.error('Failed to load messages:', error)

// BAD: env.ts used console.error for startup validation
console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors)
```

AI agents default to `console.error` because it's the simplest thing. This creates a blind spot: errors happen in production, nobody sees them.

## Decision

Ban ALL `console.*` calls (Biome `noConsole: error`, no exceptions). Create a thin `logger` utility that routes to:
1. **Development**: browser devtools (for DX)
2. **Production**: Sentry breadcrumbs + `captureException` (for observability)

```typescript
// src/lib/logger.ts
import * as Sentry from '@sentry/react'

export const logger = {
  error(message: string, context?: Record<string, unknown>) {
    if (import.meta.env.DEV) {
      // biome-ignore lint/suspicious/noConsole: logger is the only authorized console access
      console.error(message, context)
    }
    Sentry.addBreadcrumb({ message, data: context, level: 'error' })
  },
  warn(message: string, context?: Record<string, unknown>) {
    if (import.meta.env.DEV) {
      // biome-ignore lint/suspicious/noConsole: logger is the only authorized console access
      console.warn(message, context)
    }
    Sentry.addBreadcrumb({ message, data: context, level: 'warning' })
  },
  info(message: string, context?: Record<string, unknown>) {
    if (import.meta.env.DEV) {
      // biome-ignore lint/suspicious/noConsole: logger is the only authorized console access
      console.info(message, context)
    }
    Sentry.addBreadcrumb({ message, data: context, level: 'info' })
  },
}
```

Usage:
```typescript
// GOOD: structured, observable, captured by Sentry
import { logger } from '@/lib/logger'
logger.error('Failed to load messages', { channelId, status: error.status })
```

For `env.ts` startup validation (runs before Sentry is initialized), use `throw` directly — the error will crash the app at startup, which is the correct fail-fast behavior.

## Consequences

**Positive:**
- Production errors are visible in Sentry, not just browser devtools
- Structured context (key-value pairs) enables filtering and search
- Single pattern for all logging (same as Rust's `tracing`)
- `biome-ignore` comments are localized to the logger file only

**Negative:**
- One more utility file to maintain
- Sentry must be initialized early in the app lifecycle

**Enforcement:**
- Biome: `noConsole: error` with NO overrides (remove the `env.ts` exception)
- Enforcement test: scan `src/` for `biome-ignore.*noConsole` outside of `src/lib/logger.ts`
- The `logger.ts` file is the ONLY authorized place for `console.*` calls

**Location:** `src/lib/logger.ts`
