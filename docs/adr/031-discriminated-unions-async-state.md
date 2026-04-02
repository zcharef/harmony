# ADR-031: Discriminated Unions for Async State

**Status:** Accepted
**Date:** 2026-03-16

## Context

Complex boolean combinations for async state create impossible states and miss edge cases:

```typescript
// BAD: boolean combinations — what does isLoading && !isError && data mean?
function MessageList({ channelId }: Props) {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: queryKeys.messages.byChannel(channelId),
    queryFn: () => fetchMessages(channelId),
  });

  if (isLoading && !isError) return <Spinner />;
  if (isError && !isLoading) return <Error message={error.message} />;
  if (!isLoading && !isError && data) return <MessageList messages={data} />;
  // What about: isLoading && isError? data && isError? !data && !isLoading && !isError?
  // These "impossible" states are representable and unhandled.
  return null; // Silent failure
}
```

Boolean combinations grow exponentially: 3 booleans = 8 states, most of which are "impossible" but still representable. Developers forget edge cases, and TypeScript cannot narrow types based on boolean combinations.

## Decision

Use TanStack Query's `status` discriminant for complex state handling:

```typescript
// GOOD: discriminated union — every state is explicit, TypeScript narrows types
function MessageList({ channelId }: Props) {
  const query = useQuery({
    queryKey: queryKeys.messages.byChannel(channelId),
    queryFn: () => fetchMessages(channelId),
  });

  switch (query.status) {
    case 'pending':
      return <Spinner />;
    case 'error':
      return <Error message={query.error.message} />;
    case 'success':
      // TypeScript knows query.data is defined here
      return <MessageList messages={query.data} />;
  }
}
```

**Scope clarification:** This ADR targets complex boolean combinations like `isLoading && !isError && data`. Simple conditional renders are fine:

```typescript
// FINE: simple conditional — not a complex boolean combination
{isPending && <Skeleton />}
{data?.items.map(item => <Item key={item.id} {...item} />)}
```

The distinction is: if you're combining two or more boolean flags with `&&` and `!` to distinguish states, use `switch (status)` instead.

## Consequences

**Positive:**
- Every async state is handled explicitly — no silent `return null` fallthrough
- TypeScript narrows `query.data` to non-undefined inside `case 'success'`
- Adding a new status (e.g., TanStack Query v6 adds one) produces a TypeScript error if unhandled
- Easier to read: `case 'error'` vs `isError && !isLoading`

**Negative:**
- More verbose than simple boolean checks for trivial cases (mitigated by scope clarification above)
- Requires destructuring `query` as an object instead of individual boolean flags

## Enforcement

- **Enforcement test:** `tests/arch/feature-structure.test.ts` scans `.tsx` files in `src/features/` for complex boolean patterns: `&& !isError`, `&& !isPending`, `&& !isLoading` — test fails if found (these indicate complex boolean state that should use `switch (status)`)
- **Simple conditionals** like `{isPending && <Skeleton />}` are not flagged
