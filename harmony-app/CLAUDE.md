# HARMONY APP — TECHNICAL MANIFESTO

**Scope:** Tauri Desktop App (React + Vite SPA)
**Architecture:** Pure UI Client consuming Rust REST API (harmony-api)

---

## 0. Architecture Overview

> **KEY INSIGHT:** This app is a **Pure UI Client**. All business logic and data access
> flows through the **Rust REST API** (`harmony-api`). The app does NOT access
> Supabase directly for data — it consumes a TypeScript client auto-generated from OpenAPI.

```
┌─────────────────────────────────────────────┐
│               TAURI DESKTOP APP             │
│  ┌─────────────────────────────────────┐    │
│  │  React SPA (Vite)                   │    │
│  │  • Generated TypeScript API client  │    │
│  │  • TanStack Query for caching       │    │
│  │  • Zustand for global state         │    │
│  └─────────────┬───────────────────────┘    │
│                │ HTTP (Bearer Token)         │
└────────────────┼────────────────────────────┘
                 ▼
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

**What the App Does NOT Do:**
- Direct Supabase database queries
- Business logic (validation beyond UX, authorization, etc.)

---

## 1. Fundamental Principles

### 1.1 Feature-First (Screaming Architecture)

- **Colocation mandatory:** Everything that changes together lives together.
- **Forbidden:** Catch-all folders (`/components`, `/hooks`, `/types`) at src root.
- **Standard:** Core code lives in `src/features/`.

#### Layer Responsibilities

| Level | Location | Responsibility | Rules |
|-------|----------|----------------|-------|
| **Level 1 (Agnostic)** | `src/components/ui/`, `src/hooks/`, `src/lib/` | Pure tech, framework-agnostic | Zero business logic, zero domain knowledge |
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
| Direct `radix-ui` / `@radix-ui/*` imports in feature code | **FORBIDDEN** (use `@/components/ui/*` shadcn layer) |
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
| UI Components | Shadcn UI + Radix |
| Styling | Tailwind CSS 3 |
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
│   │   ├── ui/                 # Shadcn primitives — DO NOT MODIFY
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

### 4.5 Cross-Feature Communication

- Import via barrel exports only: `import { X } from '@/features/y'`
- Pass IDs between features, NOT full objects
- Side effects handled by API (not cross-feature function calls)

### 4.6 Query Key Factory (MANDATORY) (ADR-029)

```typescript
// FORBIDDEN: inline query keys
queryKey: ['messages', channelId]

// REQUIRED: use factory from src/lib/query-keys.ts
import { queryKeys } from '@/lib/query-keys'
queryKey: queryKeys.messages.byChannel(channelId)
```

### 4.7 Error Boundaries (MANDATORY) (ADR-034)

Every feature route wrapped in `<FeatureErrorBoundary>` from `@/components/shared/error-boundary`.

### 4.8 Styling (MANDATORY) (ADR-032)

- No inline `style={{}}` -- Tailwind via `className` only (ADR-032).
- Shadcn UI primitives are the only exception for Radix positioning.

### 4.9 Type Assertions (MANDATORY) (ADR-035)

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

## 6. Error Handling

### API Errors (RFC 9457)

All business errors originate from the Rust API as RFC 9457 ProblemDetails responses.

```typescript
// Mutation with proper error handling
export function useLeaveServer() {
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await leaveServer({ path: { id }, throwOnError: true })
      return data
    },
    onError: (error) => {
      toast.error(error.detail ?? 'An error occurred')
    },
  })
}
```

| HTTP Status | Client Handling |
|-------------|-----------------|
| 401 | Redirect to login |
| 409, 422 | Toast with `error.detail` |
| 500 | Generic message |

### Rules

- No stack traces exposed to user
- No `console.*` calls — use `logger` from `@/lib/logger` (ADR-042)
- Zero PII in logs

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
- [ ] No direct `@radix-ui/*` imports in feature code — use `@/components/ui/*`
- [ ] Cross-feature: pass IDs, not full objects

### State Management
- [ ] Server state: TanStack Query
- [ ] Form state: React Hook Form
- [ ] Ephemeral UI state: `useState`
- [ ] Global state: Zustand (sparingly)

### Forms
- [ ] Async forms use load-then-render pattern
- [ ] No `useEffect(() => reset(data), [data])`

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
