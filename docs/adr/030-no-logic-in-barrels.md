# ADR-030: No Logic in Barrel Exports

**Status:** Accepted
**Date:** 2026-03-16

## Context

Barrel files (`index.ts`) that contain logic create hidden dependencies and circular imports:

```typescript
// BAD: index.ts contains hooks, state, and logic
// src/features/chat/index.ts
import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';

export function useChatState() {
  const [messages, setMessages] = useState([]);
  const { data } = useQuery({ queryKey: ['messages'], queryFn: fetchMessages });

  useEffect(() => {
    if (data) setMessages(data);
  }, [data]);

  return messages;
}

export { ChatArea } from './chat-area';
export { MessageItem } from './message-item';
```

This causes:
- Importing `ChatArea` from the barrel also executes the `useChatState` hook setup
- Circular dependency risk when `useChatState` imports from other barrels
- Tree-shaking cannot eliminate unused exports because of side-effectful code
- Testing a single component requires mocking the entire barrel's dependencies

## Decision

`index.ts` files are **re-exports only**. No hooks, no state, no JSX, no component logic.

```typescript
// GOOD: index.ts is purely re-exports
// src/features/chat/index.ts
export { ChatArea } from './chat-area';
export { MessageItem } from './message-item';
export type { ChatMessage } from './types';
```

**Only these patterns are permitted in `index.ts`:**
- `export { X } from './x';`
- `export type { Y } from './y';`
- `export default X from './x';`

**Logic belongs in dedicated files:**
```
src/features/chat/
  index.ts           ← re-exports only
  chat-area.tsx      ← component with JSX
  message-item.tsx   ← component with JSX
  use-messages.ts    ← hook with useQuery/useState
  types.ts           ← TypeScript types
```

## Consequences

**Positive:**
- Barrel imports are side-effect-free — importing one export doesn't execute unrelated code
- No circular dependency risk from barrel files
- Tree-shaking works correctly — unused exports are eliminated
- Clear file responsibility — logic is always in a named file, not hidden in index.ts

**Negative:**
- More files in feature directories (acceptable — explicit is better than implicit)
- Import paths are slightly longer when bypassing the barrel (`./use-messages` vs `./`)

## Enforcement

- **Enforcement test:** `tests/arch/feature-structure.test.ts` scans all `index.ts` files in `src/` for `useState`, `useEffect`, `useQuery`, `useMutation`, `<`, or `=>` arrow functions — test fails if found
- **Allowed patterns:** Only `export { ... } from` and `export type { ... } from` statements
