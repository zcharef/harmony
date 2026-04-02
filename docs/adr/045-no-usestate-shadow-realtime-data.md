# ADR-045: No useState Shadow for Real-Time Data

**Status:** Accepted
**Date:** 2026-04-02

## Context

`useState(prop)` copies the prop value once on mount and never updates when the prop changes. This creates a "shadow" that silently diverges from the source of truth (TanStack Query cache).

This is catastrophic for data that changes externally (via SSE, optimistic updates, or cache invalidation), because the component renders stale values while the cache already has the correct data.

**Incident:** Channel settings toggles (private, read-only) were not updating in real-time for other admins. The SSE pipeline delivered `channel.updated` events correctly and the TanStack Query cache was updated, but `ChannelRow` rendered stale local state:

```typescript
// BUG: useState copies channel.isPrivate once on mount.
// When SSE updates the cache, channel prop changes but local state does not.
const [isPrivate, setIsPrivate] = useState(channel.isPrivate)
```

## Decision

### Rule: Never shadow server state with `useState`

Components displaying data from TanStack Query must read directly from props or query results. Never copy query-derived values into `useState`.

```typescript
// FORBIDDEN: local state shadow — breaks real-time updates (ADR-045)
function ChannelRow({ channel }: { channel: ChannelResponse }) {
  const [isPrivate, setIsPrivate] = useState(channel.isPrivate)
  return <Switch isSelected={isPrivate} />
}

// REQUIRED: read from prop (cache is the source of truth)
function ChannelRow({ channel }: { channel: ChannelResponse }) {
  return <Switch isSelected={channel.isPrivate} />
}
```

### Rule: Mutations that power toggles/inline edits must use optimistic updates

Without local `useState`, the toggle needs another way to respond instantly. Use the TanStack Query optimistic update pattern (`onMutate` → `onError` rollback → `onSettled` reconciliation):

```typescript
useMutation({
  mutationFn: ...,

  onMutate: async (input) => {
    await queryClient.cancelQueries({ queryKey })
    const previous = queryClient.getQueryData(queryKey)
    queryClient.setQueryData(queryKey, optimisticUpdate)
    return { previous }
  },

  onError: (_error, _variables, context) => {
    if (context?.previous) {
      queryClient.setQueryData(queryKey, context.previous)
    }
  },

  // WHY: SSE is not a reliable delivery guarantee — reconcile after every mutation
  onSettled: () => {
    queryClient.invalidateQueries({ queryKey })
  },
})
```

### When `useState(prop)` IS acceptable

- **Form inputs** in transient modals (load-then-render pattern, ADR-044). The user is the source of truth while the form is open, and the modal closes on submit.
- **Pure UI state** with no server-side equivalent (`isEnabling`, `isMenuOpen`, `isHovered`).

## Consequences

**Positive:**
- All real-time data flows from a single source of truth (TanStack Query cache)
- SSE updates, optimistic updates, and cache invalidations all propagate to the UI automatically
- Eliminates an entire class of stale-state bugs

**Negative:**
- Mutations that previously used `setState` for instant feedback now require optimistic cache updates (slightly more code in the mutation hook)
- The `onSettled: invalidateQueries` pattern adds one extra network request per mutation (acceptable cost for guaranteed consistency)

## Enforcement

- **Code review:** Any `useState(props.*)` or `useState(queryData.*)` pattern in a component that displays real-time data must be flagged
- **Reference implementation:** `use-update-channel.ts` (optimistic toggle), `use-send-message.ts` (optimistic append)
