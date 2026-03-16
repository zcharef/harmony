# ADR-033: Route Constants SSoT

**Status:** Accepted
**Date:** 2026-03-16

## Context

Inline route strings are fragile, unsearchable, and break silently when routes change:

```typescript
// BAD: route strings scattered across components
function ServerCard({ server }: Props) {
  const navigate = useNavigate();

  return (
    <div onClick={() => navigate(`/servers/${server.id}`)}>
      {server.name}
      <a href={`/servers/${server.id}/settings`}>Settings</a>
      <a href={`/servers/${server.id}/channels/${defaultChannelId}`}>General</a>
    </div>
  );
}

// If the route pattern changes from /servers/:id to /s/:id,
// you must find-and-replace across every file. Miss one? Broken link.
```

String interpolation makes it impossible to:
- Find all references to a route pattern (regex is unreliable with interpolation)
- Refactor route structure without risking broken links
- Get TypeScript errors when route parameters change

## Decision

All route paths are defined as builder functions in `src/lib/routes.ts`. Components reference `ROUTES`, never inline route strings.

```typescript
// GOOD: centralized route definitions with typed parameters
// src/lib/routes.ts
export const ROUTES = {
  home: () => '/',
  servers: {
    list: () => '/servers',
    detail: (serverId: string) => `/servers/${serverId}`,
    settings: (serverId: string) => `/servers/${serverId}/settings`,
    channels: {
      detail: (serverId: string, channelId: string) =>
        `/servers/${serverId}/channels/${channelId}`,
    },
  },
  invite: {
    accept: (inviteCode: string) => `/invite/${inviteCode}`,
  },
} as const;
```

**Usage in components:**
```typescript
// GOOD: route builder — type-safe, refactorable, searchable
function ServerCard({ server }: Props) {
  const navigate = useNavigate();

  return (
    <div onClick={() => navigate(ROUTES.servers.detail(server.id))}>
      {server.name}
      <a href={ROUTES.servers.settings(server.id)}>Settings</a>
      <a href={ROUTES.servers.channels.detail(server.id, defaultChannelId)}>
        General
      </a>
    </div>
  );
}
```

## Consequences

**Positive:**
- Single source of truth for all route paths — rename once, updates everywhere
- TypeScript enforces correct parameters (e.g., `detail(serverId)` requires exactly one string)
- Easy to find all navigation to a route (search for `ROUTES.servers.detail`)
- Route builder functions are testable — unit test the path output

**Negative:**
- Extra indirection — must look up `ROUTES` to see the actual path pattern
- Factory file must be kept in sync with router configuration (enforcement test helps)

## Enforcement

- **Enforcement test:** `tests/arch/feature-structure.test.ts` scans `.tsx` files in `src/features/` for route-like patterns (template literals containing `/servers/`, `/channels/`, etc.) — test fails if found
- **Allowlist:** `src/lib/routes.ts` itself, router configuration files, and test fixtures
