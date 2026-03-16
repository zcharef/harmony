<p align="center">
  <h1 align="center">Harmony</h1>
  <p align="center">
    <strong>The Discord that doesn't eat your RAM.</strong>
    <br />
    Open-source, privacy-first group communication — Discord's UX with Signal's principles.
  </p>
  <p align="center">
    <a href="https://github.com/harmony-app/harmony/actions"><img src="https://img.shields.io/github/actions/workflow/status/harmony-app/harmony/ci.yml?style=flat-square&label=CI" alt="CI"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue?style=flat-square" alt="License"></a>
    <a href="https://harmony.app"><img src="https://img.shields.io/badge/web-harmony.app-8b5cf6?style=flat-square" alt="Website"></a>
  </p>
</p>

---

## Why Harmony?

| | Discord | Revolt | **Harmony** |
|--|---------|--------|-------------|
| Client | Electron (~500 MB RAM) | Electron | **Tauri (~80 MB RAM)** |
| Backend | Proprietary | Rust (open) | **Rust (open)** |
| Self-hostable | No | Yes | **Yes** |
| E2EE | No | No | **Planned (DMs)** |
| Business model | Nitro + Ads | Donations | **Open Core** |
| Voice / Video | Proprietary | Vortex | **LiveKit** |

**Open Core (GitLab model):** Community Edition is fully open source under AGPL-3.0. Enterprise features (SSO, audit logs) are sold separately.

---

## Architecture

```
┌──────────────────────────────────────────────┐
│              TAURI DESKTOP APP               │
│  ┌────────────────────────────────────────┐  │
│  │  React 19 (Vite)                      │  │
│  │  ├─ Generated TypeScript API client   │  │
│  │  ├─ TanStack Query                    │  │
│  │  ├─ Zustand                           │  │
│  │  └─ Shadcn UI + Tailwind             │  │
│  └──────────────┬─────────────────────────┘  │
│                 │ HTTP (Bearer JWT)           │
│  ┌──────────────┴─────────────────────────┐  │
│  │  Tauri Rust Runtime                    │  │
│  │  ├─ System tray, Push-to-Talk hotkey   │  │
│  │  └─ Native notifications              │  │
│  └────────────────────────────────────────┘  │
└──────────────────┬───────────────────────────┘
                   │
        ┌──────────▼──────────┐
        │   HARMONY RUST API  │
        │  (Axum · Hexagonal) │
        │  ├─ REST /v1/*      │
        │  ├─ Supabase JWT    │
        │  └─ RFC 9457 errors │
        └───┬────────────┬────┘
            │            │
   ┌────────▼──┐   ┌────▼───────┐
   │ Supabase  │   │  LiveKit   │
   │ ├ Postgres│   │  (SFU)     │
   │ ├ Auth    │   │  Voice     │
   │ ├ Storage │   │  Video     │
   │ └ Realtime│   │  Screen    │
   └───────────┘   └────────────┘
```

**Key decisions:**
- **OpenAPI SSoT** — Rust structs generate `openapi.json`, which generates the TypeScript client. Zero manual type definitions.
- **Hexagonal architecture** — Domain logic has zero infrastructure imports. Swap the DB without touching business rules.
- **Supabase Realtime** for push — no custom WebSocket/SSE server. Writes go through REST; Supabase pushes changes to clients.
- **RFC 9457** — All API errors are machine-readable `ProblemDetails` JSON.

> Full architecture docs: [`docs/architecture/`](docs/architecture/) · ADRs: [`docs/adr/`](docs/adr/)

---

## Quick Start

### Prerequisites

- [Rust](https://rustup.rs/) (latest stable)
- [Node.js](https://nodejs.org/) 20+ and [pnpm](https://pnpm.io/)
- [Docker](https://docs.docker.com/get-docker/) (for Supabase local dev)
- [Supabase CLI](https://supabase.com/docs/guides/cli) (`brew install supabase/tap/supabase`)
- [just](https://just.systems/) (`brew install just`)

### Run locally

```bash
# 1. Clone
git clone https://github.com/harmony-app/harmony.git
cd harmony

# 2. Start Supabase (Postgres + Auth + Realtime)
supabase start

# 3. Start the Rust API
cd harmony-api
cp .env.example .env
just dev                    # hot-reload on port 3000

# 4. Start the Tauri app (new terminal)
cd harmony-app
pnpm install
just dev                    # opens the desktop app
```

### Quality wall

Both projects enforce a quality wall before merge:

```bash
# Rust API — fmt + clippy (warnings = errors) + all tests (unit + arch + openapi + rfc9457)
cd harmony-api && just wall

# Tauri App — Biome + typecheck + boundaries + circular deps + knip
cd harmony-app && just wall
```

> Run `just` in either project to see all available commands.

---

## Project Structure

```
harmony/
├── harmony-api/         Rust REST API (Axum, hexagonal architecture)
│   ├── src/
│   │   ├── domain/      Pure business logic (models, ports, services)
│   │   ├── infra/       Postgres (SQLx), Supabase Auth adapters
│   │   └── api/         HTTP handlers, middleware, DTOs
│   └── tests/           Architecture boundary + OpenAPI + RFC 9457 tests
│
├── harmony-app/         Tauri desktop app (React 19 + Vite)
│   ├── src/
│   │   ├── features/    Feature-first business domains
│   │   ├── components/  UI primitives (Shadcn) + shared + layout
│   │   └── lib/         Generated API client, utils
│   └── src-tauri/       Tauri Rust runtime
│
├── supabase/            Supabase config + PostgreSQL migrations
│
└── docs/
    ├── architecture/    System design (8 documents)
    └── adr/             Architecture Decision Records (10 ADRs)
```

---

## Self-Hosting

Harmony is designed to be self-hosted with a single command:

```bash
docker compose up
```

Full guide: [`docs/architecture/06-self-hosting.md`](docs/architecture/06-self-hosting.md)

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop client | Tauri 2 (Rust + WebView) |
| Frontend | React 19, Vite, TypeScript, Tailwind, Shadcn UI |
| State management | TanStack Query (server), Zustand (client) |
| Backend | Rust, Axum 0.8, SQLx |
| Database | PostgreSQL (via Supabase) |
| Auth | Supabase Auth (JWT) |
| Real-time | Supabase Realtime (Postgres Changes + Broadcast + Presence) |
| Voice / Video | LiveKit (open-source SFU) |
| API docs | Code-first OpenAPI (utoipa) |
| Observability | tracing + OpenTelemetry + Sentry |
| CI | GitHub Actions |

---

## Open Core Model

| | Community (CE) | Enterprise (EE) | Harmony Cloud |
|--|----------------|-----------------|---------------|
| License | AGPL-3.0 | Proprietary | EE on our infra |
| Core features | All | All | All |
| SSO / SAML | — | Yes | Yes (Business plan) |
| Audit logs | Basic | Advanced | Advanced |
| Priority support | — | Yes | Yes |
| Cost | Free | License fee | [Subscription](https://harmony.app) |

---

## Roadmap

| Phase | Goal | Status |
|-------|------|--------|
| **0 — Walking Skeleton** | Sign up, create server, send message | In progress |
| **1 — Real-Time** | Two users chatting live | Planned |
| **2 — Roles & DMs** | Permissions, private messages | Planned |
| **3 — Voice & Files** | LiveKit voice/video, file uploads | Planned |
| **4 — SaaS Launch** | Harmony Cloud, subscriptions | Planned |
| **5 — Enterprise** | SSO, audit logs, mobile app, E2EE | Planned |

Full roadmap: [`docs/architecture/07-roadmap.md`](docs/architecture/07-roadmap.md)

---

## Contributing

We welcome contributions! See [`CONTRIBUTING.md`](CONTRIBUTING.md) for setup instructions and guidelines.

Before submitting a PR:
1. Run `just wall` in the project you changed
2. Follow [conventional commits](https://www.conventionalcommits.org/)
3. One concern per PR

---

## Security

Found a vulnerability? Please report it responsibly. See [`SECURITY.md`](SECURITY.md).

---

## License

Harmony Community Edition is licensed under [AGPL-3.0](LICENSE).

Enterprise modules (when released) will be under a separate proprietary license.
