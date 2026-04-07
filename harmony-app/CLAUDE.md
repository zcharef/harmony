# HARMONY APP — TECHNICAL MANIFESTO

**Scope:** Web App + Tauri Desktop App (React + Vite SPA)
**Architecture:** Pure UI Client consuming Rust REST API (harmony-api)

---

## 0. Architecture Overview

> **KEY INSIGHT:** This app is a **Pure UI Client** that works as both a web app and a
> Tauri desktop app. All business logic and data access flows through the **Rust REST
> API** (`harmony-api`). The app does NOT access Supabase directly for data — it
> consumes a TypeScript client auto-generated from OpenAPI.
>
> **Dual deployment:** The same React codebase serves as a standalone web app (Vite build)
> and a Tauri desktop app. The web app has full channel/server access. E2EE features
> (DM encryption) are behind `isTauri()` guards and only available in the desktop app.

```
┌───────────────────────┐  ┌─────────────────────────────────────┐
│     WEB BROWSER       │  │         TAURI DESKTOP APP           │
│  ┌─────────────────┐  │  │  ┌─────────────────────────────┐   │
│  │  React SPA      │  │  │  │  React SPA (same code)     │   │
│  │  (same code)    │  │  │  │  + E2EE (invoke → Rust)    │   │
│  └────────┬────────┘  │  │  └──────────┬──────────────────┘   │
└───────────┼───────────┘  │  ┌──────────┴──────────────────┐   │
            │               │  │  Tauri Rust Runtime         │   │
            │               │  │  vodozemac · Keychain · DB  │   │
            │               │  └──────────┬──────────────────┘   │
            │               └─────────────┼─────────────────────┘
            └──────────┬──────────────────┘
                       ▼ HTTP (Bearer Token)
             ┌───────────────────────┐
             │    RUST REST API      │
             │    (harmony-api)      │
             │  • OpenAPI SSoT       │
             │  • Supabase Auth      │
             │  • All business logic │
             └───────────┬───────────┘
                         ▼
               ┌──────────────────┐
               │   Supabase       │
               │   (Postgres)     │
               └──────────────────┘
```

**What the App Does:**
- Auth via Supabase (client-side login)
- Consumes REST API via generated TypeScript client
- UI rendering, caching, state management
- **Desktop only:** E2EE encryption/decryption via Tauri `invoke()` commands

**What the App Does NOT Do:**
- Direct Supabase database queries
- Business logic (validation beyond UX, authorization, etc.)

**Platform detection:** Use `isTauri()` from `src/lib/platform.ts` to guard
desktop-only features. Never import `@tauri-apps/api` unconditionally — it
crashes in the browser.

---

## 1. Fundamental Principles

### 1.1 Feature-First (Screaming Architecture)

- **Colocation mandatory:** Everything that changes together lives together.
- **Forbidden:** Catch-all folders (`/components`, `/hooks`, `/types`) at src root.
- **Standard:** Core code lives in `src/features/`.

#### Layer Responsibilities

| Level | Location | Responsibility | Rules |
|-------|----------|----------------|-------|
| **Level 1 (Agnostic)** | `src/hooks/`, `src/lib/` | Pure tech, framework-agnostic. HeroUI components come from `@heroui/react` (external package, ADR-044). | Zero business logic, zero domain knowledge |
| **Level 2 (Shared Domain)** | `src/components/shared/` | **PURE UI ONLY** | Props only, NO hooks, NO side effects, NO data fetching |
| **Level 3 (Cross-Feature)** | `src/features/*/index.ts` | Public API Pattern | ONLY export what other features need |

### 1.2 Zero-Trust & Type-Safety

- All external data (API, User Input) must be validated by Zod.
- TypeScript **Strict** mandatory. `any` forbidden (build error via Biome).

### 1.3 Module Boundaries (HARD CONSTRAINTS)

#### Deep Imports FORBIDDEN

```typescript
// BUILD FAIL
import { ChatArea } from '@/features/chat/chat-area'
import { useSendMessage } from '@/features/chat/hooks/use-send-message'

// ALLOWED (barrel import only)
import { ChatArea, useSendMessage } from '@/features/chat'
```

#### Public API Pattern

Each feature MUST have an `index.ts` exposing its public API:

```typescript
// src/features/chat/index.ts
export { ChatArea } from './chat-area'
export { MessageItem } from './message-item'
```

**Enforcement:** `eslint-plugin-boundaries` (see Quality Wall section).

### 1.4 API Client Safety

| Rule | Enforcement |
|------|-------------|
| Direct Supabase SDK data access | **FORBIDDEN** (use API client) |
| Manual API fetch calls | **FORBIDDEN** (use generated client for type safety) |
| Direct `@radix-ui/*` imports | **FORBIDDEN** — use `@heroui/react` (ADR-044) |
| SDK calls without `throwOnError: true` in `queryFn`/`mutationFn` | **FORBIDDEN** (enforced by arch test) |
| Manual API type definitions (`interface Message { ... }`) | **FORBIDDEN** — import from `@/lib/api` only (ADR-015, enforced by arch test) |

---

## 2. Tech Stack (Locked)

Any new library requires explicit approval.

| Domain | Technology |
|--------|-----------|
| Desktop Runtime | Tauri 2 |
| Framework | React 19 (SPA via Vite) |
| Language | TypeScript 5+ (Strict) |
| **Backend** | **Rust REST API** (`harmony-api`) |
| **API Client** | **Generated from OpenAPI** (utoipa) |
| Auth | Supabase Auth (client-side) |
| Data Fetching | TanStack Query v5 + API Client |
| Global State | Zustand |
| Validation | Zod (for UX, API is authoritative) |
| UI Components | HeroUI (ADR-044) |
| Styling | Tailwind CSS 4 |
| Icons | Lucide React |
| Forms | React Hook Form + Zod Resolver |
| Linter/Formatter | Biome |
| Bundler | Vite 7 |

---

## 3. Folder Structure

```
harmony-app/
├── biome.json                  # Linter/Formatter config
├── eslint.config.mjs           # Module boundaries ONLY
├── tsconfig.json               # TypeScript Strict
├── vite.config.ts              # Vite + Tauri config
├── vitest.config.ts            # Unit/integration tests
├── vitest.config.arch.ts       # Architecture tests
├── openapi-ts.config.ts        # API client generation
├── justfile                    # Command center
│
├── src/
│   ├── main.tsx                # App entry point
│   ├── App.tsx                 # Root component (providers, router)
│   │
│   ├── components/
│   │   ├── shared/             # Cross-feature pure UI components
│   │   └── layout/             # App shell (sidebar, header, panels)
│   │
│   ├── features/               # BUSINESS DOMAINS
│   │   ├── chat/               # Messaging
│   │   │   ├── components/     # ChatArea, MessageInput
│   │   │   ├── hooks/          # useSendMessage, useMessages
│   │   │   └── index.ts        # PUBLIC API (barrel export)
│   │   │
│   │   ├── channels/           # Channel management
│   │   ├── members/            # Member list, presence
│   │   ├── server-nav/         # Server sidebar navigation
│   │   └── auth/               # Login, session management
│   │
│   ├── lib/                    # TECHNICAL UTILITIES (domain-agnostic)
│   │   ├── api/                # Generated API client (DO NOT EDIT)
│   │   ├── api-client.ts       # Runtime API config
│   │   ├── env.ts              # Zod-validated env vars
│   │   ├── logger.ts           # Structured logger (ADR-042)
│   │   ├── query-keys.ts       # Query key factory (ADR-029)
│   │   ├── routes.ts           # Route constants SSoT
│   │   ├── supabase.ts         # Supabase client (Auth only)
│   │   └── utils.ts            # cn() helper
│   │
│   └── hooks/                  # Generic technical hooks
│
├── tests/
│   └── arch/                   # Architecture enforcement tests
│       └── feature-structure.test.ts
│
└── src-tauri/                  # Tauri desktop runtime (Rust)
```

---

## 4. Coding Standards

### 4.1 Data Fetching & Mutations

All data flows through the Rust REST API. No direct Supabase.

```typescript
// GOOD: API client via TanStack Query
export function useMessages(channelId: string) {
  return useQuery({
    queryKey: ['messages', channelId],
    queryFn: async () => {
      const { data } = await getMessages({
        path: { channelId },
        throwOnError: true,
      })
      return data
    },
  })
}
```

#### Mutations

```typescript
// GOOD: Mutation via API client
export function useSendMessage() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (input: SendMessageInput) => {
      const { data } = await sendMessage({
        body: input,
        throwOnError: true,
      })
      return data
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['messages', variables.channelId] })
    },
  })
}
```

### 4.2 OpenAPI SSoT Type Safety (MANDATORY)

#### Rule 1: `throwOnError: true` in all SDK hooks

Without `true`, non-2xx responses return `{ error }` instead of throwing — TanStack Query **never sees the error**.

```typescript
// FORBIDDEN: error silently swallowed
queryFn: async () => {
  const { data } = await getMessages({ path: { channelId } })
  return data
}

// REQUIRED: every SDK call
queryFn: async () => {
  const { data } = await getMessages({ path: { channelId }, throwOnError: true })
  return data
}
```

#### Rule 2: Always import types from `@/lib/api`, never define manually

```typescript
// FORBIDDEN: manual type duplicating API contract
interface Message { id: string; content: string }

// REQUIRED: import from generated client
import type { MessageDto } from '@/lib/api'
```

#### After Rust API changes: `just gen-api` → `just wall`

### 4.3 State Management (One Pattern Per Concern)

1. **Server State:** TanStack Query (cache).
2. **Form State:** React Hook Form.
3. **Ephemeral UI State:** `useState` (isMenuOpen, isHovered).
4. **Global State (Session):** Zustand (use sparingly).

#### No `useState` Shadow for Real-Time Data (ADR-045)

Never copy query-derived props into `useState` — it creates a stale shadow that ignores SSE/cache updates:

```typescript
// FORBIDDEN: shadow breaks real-time sync (ADR-045)
const [isPrivate, setIsPrivate] = useState(channel.isPrivate)

// REQUIRED: read from prop (cache is the source of truth)
<Switch isSelected={channel.isPrivate} />
```

For instant toggle/inline-edit feedback without local state, use optimistic cache updates in the mutation hook (`onMutate` → `onError` rollback → `onSettled` invalidation). See `use-update-channel.ts` and `use-send-message.ts` as reference implementations.

### 4.4 Async Forms (React Hook Form) — MANDATORY

```typescript
// FORBIDDEN: race condition
function MyForm() {
  const { data } = useAsyncData()
  const { reset, ...form } = useForm({ defaultValues: { name: '' } })
  useEffect(() => { if (data) reset({ name: data.name }) }, [data, reset])
}

// REQUIRED: load-then-render
export function MyForm() {
  const { data, isPending } = useAsyncData()
  if (isPending) return <LoadingState />
  return <MyFormContent data={data} />
}

function MyFormContent({ data }: { data: Data | undefined }) {
  const form = useForm({ defaultValues: { name: data?.name ?? '' } })
}
```

### 4.5 Real-Time Events via SSE (MANDATORY)

All push notifications use Server-Sent Events from the Rust API. Supabase Realtime is NOT used.

#### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  MainLayout (src/components/layout/main-layout.tsx)         │
│  └─ useFetchSSE(userId, getToken) — single SSE connection   │
│       ↓ fetch('/v1/events', Bearer token) → ReadableStream  │
│       ↓ eventsource-parser → validate with Zod              │
│       ↓ window.dispatchEvent(CustomEvent("sse:<name>"))     │
└──────────────────────────────┬──────────────────────────────┘
                               │ CustomEvent bus
        ┌──────────────────────┼──────────────────────┐
        ▼                      ▼                      ▼
 use-realtime-         use-realtime-          use-realtime-
 messages.ts           members.ts             channels.ts
 (chat feature)        (members feature)      (channels feature)
 useServerEvent(       useServerEvent(        useServerEvent(
  "message.created",    "member.joined",       "channel.created",
  handler)              handler)               handler)
```

#### Key Files

| File | Role |
|------|------|
| `src/hooks/use-fetch-sse.ts` | Single fetch-based SSE connection, mounted once in MainLayout. Bearer token auth via `Authorization` header. Exponential backoff reconnect. 50-min forced reconnect (JWT expires at 1h). Full cache invalidation on reconnect (ADR-SSE-006). |
| `src/hooks/use-server-event.ts` | Bridge hook: subscribes to `window` CustomEvents keyed by SSE event name. Feature hooks use this instead of touching the SSE stream directly. |
| `src/lib/event-types.ts` | SSoT for event types. Zod discriminated union validates all payloads. Mirrors Rust `ServerEvent` enum. Exports `ServerEvent`, `ServerEventOf<T>`, payload types. |
| `src/features/*/hooks/use-realtime-*.ts` | Feature-specific handlers. Each subscribes to relevant SSE events via `useServerEvent()` and updates TanStack Query cache directly (no refetch). |

#### Rules

| Rule | Enforcement |
|------|-------------|
| `import ... from 'supabase-js/realtime'` or Supabase channel subscriptions | **FORBIDDEN** |
| Direct cache mutation in SSE handlers (no `invalidateQueries` per event) | **REQUIRED** (instant UI) |
| Zod validation on every SSE payload before cache insertion | **REQUIRED** (CLAUDE.md 1.2) |
| One `useFetchSSE` call per app (in MainLayout only) | **REQUIRED** (single connection) |
| Feature hooks use `useServerEvent()`, never `addEventListener` directly | **REQUIRED** |

#### Adding a New SSE Event

1. **Rust API:** Add variant to `ServerEvent` enum, implement `event_name()` and payload struct
2. **`src/lib/event-types.ts`:** Add event name to `SSE_EVENT_NAMES`, Zod variant to `serverEventSchema`, mapping to `SSE_EVENT_NAME_TO_TYPE`
3. **Feature hook:** Create `use-realtime-<feature>.ts` using `useServerEvent("<event.name>", handler)` pattern
4. **Cache update:** Use `queryClient.setQueryData()` for instant UI, matching the pattern in `use-realtime-messages.ts`

### 4.6 Hook Lifecycle & View Switches (MANDATORY)

Hooks with persistent side-effects (intervals, timers, subscriptions, event listeners) that must survive view changes **MUST** live in `MainLayout` — the only component that never unmounts.

#### Why

The app swaps entire sidebars on view change: `isDmView ? <DmSidebar/> : <ChannelSidebar/>`. A hook inside `ChannelSidebar` is **killed** when the user navigates to DMs. If that hook runs a heartbeat, the server thinks the user disconnected.

#### Rules

| Hook type | Where to mount | Examples |
|-----------|---------------|----------|
| Global SSE listeners (`useServerEvent`) | `MainLayout` | `useRealtimeChannels`, `useRealtimeMembers`, `useForceDisconnect` |
| Global lifecycle (heartbeats, token refresh, cleanup) | `MainLayout` | `useVoiceConnection`, `usePresence`, `useFetchSSE` |
| Per-channel subscriptions (only needed when viewing) | Feature component | `useRealtimeVoice(channelId)`, `useRealtimeMessages(channelId)` |

#### Components that unmount during normal use

- `ChannelSidebar` — unmounts in DM view
- `DmSidebar` — unmounts in server view
- `MemberList` — unmounts when panel is collapsed
- `VoiceParticipantList` — unmounts when viewing a different server

**Before adding a hook with `setInterval`, `addEventListener`, `onAuthStateChange`, or `useServerEvent` to any of these components, ask: "Does this side-effect need to survive a view switch?" If yes, mount it in `MainLayout`.**

### 4.7 Cross-Feature Communication

- Import via barrel exports only: `import { X } from '@/features/y'`
- Pass IDs between features, NOT full objects
- Side effects handled by API (not cross-feature function calls)

### 4.8 Query Key Factory (MANDATORY) (ADR-029)

```typescript
// FORBIDDEN: inline query keys
queryKey: ['messages', channelId]

// REQUIRED: use factory from src/lib/query-keys.ts
import { queryKeys } from '@/lib/query-keys'
queryKey: queryKeys.messages.byChannel(channelId)
```

### 4.9 Error Boundaries (MANDATORY) (ADR-034)

Every feature route wrapped in `<FeatureErrorBoundary>` from `@/components/shared/error-boundary`.

### 4.10 Styling (MANDATORY) (ADR-044)

- **HeroUI prop-based styling first**: Use component props (`color="primary"`, `variant="flat"`, `size="sm"`) over Tailwind classes.
- **`className`/`classNames` for layout only**: Flexbox, margins, positioning that HeroUI props cannot express.
- **Semantic color tokens only**: Use `primary`, `secondary`, `success`, `danger`, `warning`, `default` — never hardcode Tailwind color names.
- **No inline `style={{}}`** in application code — Tailwind via `className` only.
- **No `dark:` color overrides** — HeroUI handles dark mode color switching automatically.

### 4.11 Type Assertions (MANDATORY) (ADR-035)

- Never use `as Type` (lies to compiler). Use `satisfies Type` or fix the actual type.
- Allowed: `as const`, `as unknown`, `as never` (exhaustive switches).

---

## 5. Environment Variables

Validated at startup via Zod (`src/lib/env.ts`). Build crashes on misconfiguration.

| Variable | Description |
|----------|-------------|
| `VITE_API_URL` | Rust API base URL (e.g., `http://localhost:3000`) |
| `VITE_SUPABASE_URL` | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase anonymous/public key |

All client vars must be prefixed with `VITE_` (Vite convention).

---

## 6. Error Handling (ADR-045)

### Core Principle

**User intent determines feedback.** Background operations fail silently (retry). Explicit user actions get feedback. Never show an error the user cannot act on.

### API Errors (RFC 9457)

All business errors originate from the Rust API as RFC 9457 ProblemDetails responses.

### Error Feedback Matrix (MANDATORY)

| Error | User Feedback | Retry Strategy | Client Monitoring |
|-------|--------------|----------------|-------------------|
| **Offline / Network drop** | Global banner ("Reconnecting...") | Auto-retry with backoff | Breadcrumb only |
| **Timeout (mutation)** | Inline "Failed" + retry button | 3x auto, then manual | Breadcrumb only |
| **400 / 422 (Validation)** | Inline on the input field | None (user fixes input) | Ignore |
| **401 (Unauthorized)** | None — redirect to login | Silent token refresh 1x | Breadcrumb only |
| **403 (Forbidden)** | Toast: permission denied | None | Ignore |
| **404 (Not Found)** | Inline empty state | None | Ignore |
| **409 (Conflict)** | Toast with `error.detail` | None | Analytics event |
| **429 (Rate limit)** | Transparent retry. If user spam: inline "Too fast" | Respect `Retry-After` | Ignore |
| **5xx (Server error)** | Toast ONLY if blocking explicit user action | Backoff 3x | Breadcrumb. **Server alerts.** |
| **React render crash** | Error Boundary fallback UI | Prompt reload | **`captureException`** |

### Three-Level Error Architecture

```
Level 1: Global API Interceptor (src/lib/api-client.ts)
  → 401: silent token refresh → redirect to login on failure
  → 429: transparent queue + retry with Retry-After
  → All errors: structured breadcrumb via logger

Level 2: Hook-level onError (each useMutation)
  → MANDATORY for all mutations triggered by explicit user action
  → Pattern: toast with error.detail or inline error state
  → Forbidden: empty onError, missing onError on user-initiated mutations

Level 3: Component Error Boundaries (FeatureErrorBoundary)
  → Catches React render crashes
  → Reports to Sentry via captureException
  → Shows fallback UI with reload prompt
```

### Mutation Error Handling (MANDATORY)

Every `useMutation` that is triggered by an explicit user action MUST have error feedback:

```typescript
// REQUIRED: mutation with error handling
export function useLeaveServer() {
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await leaveServer({ path: { id }, throwOnError: true })
      return data
    },
    onError: (error) => {
      logger.error('leave_server_failed', { error })
      // TODO: Replace with toast when toast system is implemented
    },
  })
}
```

```typescript
// FORBIDDEN: mutation without error handling on user-initiated action
createDm.mutate(userId, {
  onSuccess: (data) => { navigate(data) },
  // ← onError missing = silent failure = ADR-045 violation
})
```

### Monitoring Classification

| Category | Action | Reasoning |
|----------|--------|-----------|
| 4xx client errors | **Never** send to Sentry | Expected business logic, not bugs |
| 5xx server errors | Server Sentry owns this | Client adds breadcrumb only |
| React render crash | **Always** `captureException` | Unexpected — needs engineering action |
| All HTTP errors | `logger.error()` as breadcrumb | Trail for crash diagnosis |

### Rules

- No stack traces exposed to user
- No `console.*` calls — use `logger` from `@/lib/logger` (ADR-042)
- Zero PII in logs
- Prevention over reaction: disable UI before 403, don't wait for the error
- Toasts are last resort: prefer inline → banner → toast → modal (escalating severity)

---

## 7. Quality Wall

### Commands (`just <recipe>`)

| Command | What it does |
|---------|-------------|
| `just dev` | Vite dev server (port 1420) |
| `just build` | tsc + vite build |
| `just lint` | Biome check |
| `just lint-fix` | Biome auto-fix |
| `just typecheck` | tsc --noEmit |
| `just boundaries` | ESLint module boundaries |
| `just circular` | madge circular deps |
| `just unused` | Knip dead code |
| `just test` | Vitest |
| `just test-arch` | Architecture tests |
| `just wall` | ALL checks |
| `just gen-api` | OpenAPI client generation |
| `just fix` | Biome auto-fix |

### E2E Tests (Playwright)

Run locally against local Supabase (requires `supabase start`, Rust API running, and `just dev`):

```bash
cd harmony-app
npx playwright test --workers=1
```

**`--workers=1` is required** — multiple workers overwhelm the single Supabase instance,
causing SSE connections to stall and tests to timeout. This is already set in `playwright.config.ts`
but must be explicit when running from the CLI.

### Pre-commit (via Lefthook)

- Biome check + auto-fix on staged files

### Pre-push (via Lefthook)

- TypeScript check
- Module boundaries
- Circular dependency check
- Architecture tests
- Knip dead code

---

## 8. Naming Conventions

- **Folders:** `kebab-case` (`server-nav`, `chat`)
- **Files:** `kebab-case.tsx` (`channel-sidebar.tsx`)
- **Components:** `PascalCase` (`ChannelSidebar`)
- **Functions/Variables:** `camelCase` (`isAvailable`)
- **Constants:** `UPPER_SNAKE_CASE` (`MAX_RETRY_COUNT`)

---

## Pre-Push Checklist

### Architecture & SSoT
- [ ] All TypeScript types for API come from generated client (`@/lib/api`)
- [ ] No manual `fetch()` for API endpoints — use generated client
- [ ] No direct Supabase data access

### API Client Safety
- [ ] `throwOnError: true` on **every** SDK call in `queryFn`/`mutationFn`
- [ ] Mutations wrapped in TanStack Query `useMutation`
- [ ] API errors handled: 401 → redirect, 4xx → toast, 500 → generic

### Feature-First & Module Boundaries
- [ ] Business code lives in `src/features/`, not root-level folders
- [ ] Each feature has `index.ts` barrel export — no deep imports
- [ ] No `@radix-ui/*` or `@/components/ui/*` imports — use `@heroui/react` (ADR-044)
- [ ] Cross-feature: pass IDs, not full objects

### State Management
- [ ] Server state: TanStack Query
- [ ] Form state: React Hook Form
- [ ] Ephemeral UI state: `useState`
- [ ] Global state: Zustand (sparingly)
- [ ] No `useState(prop)` shadow on query-derived data (ADR-045)

### Forms
- [ ] Async forms use load-then-render pattern
- [ ] No `useEffect(() => reset(data), [data])`

### Real-Time (SSE)
- [ ] No Supabase Realtime imports or channel subscriptions
- [ ] New SSE events have Zod schema in `event-types.ts` and entry in `SSE_EVENT_NAME_TO_TYPE`
- [ ] Feature realtime hooks use `useServerEvent()`, not direct `addEventListener`
- [ ] SSE handlers update cache via `setQueryData()`, not `invalidateQueries()`
- [ ] Hooks with persistent side-effects (heartbeats, timers, global listeners) live in `MainLayout`, not in `ChannelSidebar`/`DmSidebar`/`MemberList`

### Enforcement Rules
- [ ] No inline `style={{}}` in feature code -- Tailwind `className` only
- [ ] Query keys use factory from `query-keys.ts`, no inline arrays
- [ ] No `as Type` assertions -- use `satisfies` or fix the type
- [ ] Feature routes wrapped in `<FeatureErrorBoundary>`
- [ ] No complex boolean state combinations -- use `status` discriminant

### Quality Wall (`just wall`)
- [ ] `just lint` passes (Biome)
- [ ] `just typecheck` passes (tsc --noEmit)
- [ ] `just boundaries` passes (no deep cross-feature imports)
- [ ] `just circular` passes (no circular deps)
- [ ] `just test-arch` passes (feature structure, barrel exports)

### Naming
- [ ] Folders: `kebab-case`
- [ ] Files: `kebab-case.tsx`
- [ ] Components: `PascalCase`
- [ ] Functions/Variables: `camelCase`
- [ ] Constants: `UPPER_SNAKE_CASE`

---

**This document is authoritative. Any deviation must be justified and documented.**
