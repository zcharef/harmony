# ADR-029: Query Key Factory Pattern

**Status:** Accepted
**Date:** 2026-03-16

## Context

Inline query keys in TanStack Query are fragile and impossible to invalidate reliably:

```typescript
// BAD: inline query keys — typos, inconsistency, broken invalidation
function useMessages(channelId: string) {
  return useQuery({
    queryKey: ['messages', channelId],
    queryFn: () => fetchMessages(channelId),
  });
}

function useMessageCount(channelId: string) {
  return useQuery({
    queryKey: ['message-count', channelId], // "message-count" vs "messages" — inconsistent
    queryFn: () => fetchMessageCount(channelId),
  });
}

// Invalidation: did we use 'messages' or 'message-count' or 'msgs'?
queryClient.invalidateQueries({ queryKey: ['messages'] });
// Misses 'message-count' — stale data remains in cache
```

When query keys are strings scattered across components, there is no way to:
- Find all queries related to a feature
- Invalidate all related queries after a mutation
- Refactor key structure without breaking cache invalidation

## Decision

All query keys are defined in a single factory file `src/lib/query-keys.ts`. Components reference the factory, never inline arrays.

```typescript
// GOOD: centralized query key factory
// src/lib/query-keys.ts
export const queryKeys = {
  messages: {
    all: ['messages'] as const,
    byChannel: (channelId: string) => ['messages', 'by-channel', channelId] as const,
    count: (channelId: string) => ['messages', 'count', channelId] as const,
    detail: (messageId: string) => ['messages', 'detail', messageId] as const,
  },
  servers: {
    all: ['servers'] as const,
    detail: (serverId: string) => ['servers', 'detail', serverId] as const,
    members: (serverId: string) => ['servers', 'members', serverId] as const,
  },
  channels: {
    all: ['channels'] as const,
    byServer: (serverId: string) => ['channels', 'by-server', serverId] as const,
  },
} as const;
```

**Usage in components:**
```typescript
// GOOD: factory reference — type-safe, refactorable, searchable
function useMessages(channelId: string) {
  return useQuery({
    queryKey: queryKeys.messages.byChannel(channelId),
    queryFn: () => fetchMessages(channelId),
  });
}

// Invalidation: invalidate ALL message queries for a channel
queryClient.invalidateQueries({
  queryKey: queryKeys.messages.byChannel(channelId),
});

// Invalidation: invalidate ALL message queries (every channel)
queryClient.invalidateQueries({
  queryKey: queryKeys.messages.all,
});
```

## Consequences

**Positive:**
- Single source of truth for all query keys — no typos, no inconsistency
- Hierarchical key structure enables granular or broad cache invalidation
- `as const` provides full type safety — TypeScript knows the exact key shape
- Easy to find all queries related to a feature (search for `queryKeys.messages`)

**Negative:**
- Extra indirection — must look up the factory to understand the key structure
- Factory file grows as features are added (acceptable — one file vs. scattered strings)

## Enforcement

- **Enforcement test:** `tests/arch/feature-structure.test.ts` scans all `.tsx` and `.ts` files in `src/features/` for inline `queryKey: [` patterns — test fails if found (should use `queryKeys.*` instead)
- **Import check:** The factory file is the only file that should contain `as const` query key arrays
