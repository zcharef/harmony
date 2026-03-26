# E2E Tests (Playwright)

## Quick Start (Local)

### Prerequisites

1. **Supabase CLI** installed: `brew install supabase/tap/supabase`
2. **Docker** running (Supabase local needs it)
3. **Rust toolchain** installed: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
4. **Node.js 22+** with **pnpm**: `npm install -g pnpm`

### 1. Start local Supabase

```bash
# From repo root — spins up Postgres, GoTrue Auth, Realtime, Storage
supabase start

# Apply all migrations (clean slate)
supabase db reset
```

This starts the full Supabase stack on **custom ports** (not the default 543xx):

| Service | Port |
|---------|------|
| API (PostgREST) | 64321 |
| Postgres | 64322 |
| Studio | 64323 |

### 2. Start the Rust API

```bash
cd harmony-api
just dev   # or: cargo run
```

The API starts on **http://localhost:3000** and connects to local Supabase automatically.

### 3. Start the Vite dev server

```bash
cd harmony-app
cp .env.example .env   # Only needed once
just dev               # or: pnpm dev
```

The app starts on **http://localhost:1420**.

### 4. Run E2E tests

```bash
cd harmony-app

# Run all tests (recommended)
just e2e

# Run a specific test file
pnpm exec playwright test e2e/auth.spec.ts

# Run with UI mode (interactive)
just e2e-ui

# Run with zero retries (strict mode)
pnpm exec playwright test --retries=0
```

### Current stats

- **121 tests**, all passing
- **~2 minutes** runtime with `workers: 1`
- **0 flaky** with `--retries=0`

---

## Architecture

### How tests authenticate

Tests do NOT go through the login UI (slow, flaky). Instead:

1. `createTestUser(prefix)` — Creates a user via Supabase Admin API (`service_role` key). Auto-confirms email.
2. `syncProfile(token)` — Calls `POST /v1/auth/me` to upsert the user's profile in the app database.
3. `authenticatePage(page, user)` — Injects the Supabase session into `localStorage` via `addInitScript`, then navigates to `/`. The app loads as if already logged in.

Only `auth.spec.ts` tests the actual login form UI.

### Test data isolation

Every test creates its own data with unique identifiers:

```
email: "channels-1742900000-abc123@e2e.test"
server: "E2E Server 1742900000-abc123"
```

Tests never depend on seed data or shared state. Each `test.describe` block has its own `beforeAll` that creates users, servers, and channels from scratch.

### File structure

```
e2e/
├── fixtures/
│   ├── auth-fixture.ts        # authenticatePage, selectServer, selectChannel
│   ├── user-factory.ts        # createTestUser (Supabase Admin API)
│   └── test-data-factory.ts   # createServer, createChannel, sendMessage, etc.
│
├── auth.spec.ts               # Login/logout UI tests
├── channels.spec.ts           # Channel CRUD
├── concurrent.spec.ts         # Realtime message delivery
├── dms.spec.ts                # Direct messages
├── encryption.spec.ts         # E2EE channel encryption settings
├── error-handling.spec.ts     # Expired session handling
├── invites.spec.ts            # Invite create/join flow
├── member-interactions.spec.ts # Context menu permissions by role
├── messages.spec.ts           # Send, edit, delete, pagination
├── moderation.spec.ts         # Kick, ban, unban
├── ownership.spec.ts          # Ownership transfer
├── plan-limits.spec.ts        # Free/Pro/Community plan enforcement
├── rate-limits.spec.ts        # Message + DM rate limiting
├── roles.spec.ts              # Role assignment via context menu
├── servers.spec.ts            # Server CRUD
├── settings.spec.ts           # Server settings UI
└── validation.spec.ts         # Client + server input validation
```

### Key conventions

| Rule | Why |
|------|-----|
| `data-test` attributes for all selectors | No CSS class/ID/role selectors (fragile) |
| No `if` statements in test bodies | Single deterministic execution path |
| No mocking (`page.route` / `route.fulfill`) | Tests hit the real API |
| `toHaveValue` after every `.fill()` | Verify the input received the value |
| `toHaveCount` instead of `.count()` + `toBe()` | Auto-retrying assertion |
| `not.toBeAttached()` for absence (not `not.toBeVisible`) | Stricter — element not in DOM at all |
| No `test.skip()` or `test.only()` | All tests run, always |

---

## Configuration

### Local development (default — zero config)

Everything defaults to local Supabase (`127.0.0.1:64321`) and local API (`localhost:3000`). The well-known Supabase local dev keys are hardcoded as defaults.

### CI / Supabase Cloud (via environment variables)

For running against a Supabase Cloud project (e.g., CI), set these env vars:

| Env Var | Used by | Description |
|---------|---------|-------------|
| `CI_SUPABASE_URL` | user-factory, auth-fixture | Supabase project URL (`https://xxx.supabase.co`) |
| `CI_SUPABASE_ANON_KEY` | user-factory | Supabase anon/public key |
| `CI_SUPABASE_SERVICE_ROLE_KEY` | user-factory | Supabase service role key |
| `VITE_API_URL` | test-data-factory | API base URL (default: `http://localhost:3000`) |

All env vars are optional — local defaults apply when unset.

---

## Troubleshooting

### Tests fail with "connection refused" on port 64321

Supabase local isn't running. Run `supabase start` from the repo root.

### Tests fail with "connection refused" on port 3000

The Rust API isn't running. Run `just dev` in `harmony-api/`.

### Tests fail with "connection refused" on port 1420

The Vite dev server isn't running. Run `just dev` in `harmony-app/`.

### Context menu tests fail with "getCollectionNode is not a function"

HeroUI's DropdownMenu uses React Aria Collections. Custom components as children crash — use function calls instead of JSX components. See `member-context-menu.tsx` for the pattern.

### Tests are flaky with "element is not stable"

HeroUI dropdown animations take ~150ms. The test fixtures wait for menu item visibility after opening dropdowns. If you add new dropdown tests, wait for a `data-test` item inside the menu before clicking.

### "supabase db reset" fails

Make sure Docker is running and the Supabase containers are healthy: `supabase status`.
