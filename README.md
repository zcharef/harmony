<p align="center">
  <h1 align="center">Harmony</h1>
  <p align="center">
    <strong>Your chat app shouldn't sell your data.</strong>
    <br />
    Open-source, privacy-first group communication — Discord's UX with Signal's principles.
  </p>
  <p align="center">
    <a href="https://github.com/harmony-app/harmony/actions"><img src="https://img.shields.io/github/actions/workflow/status/harmony-app/harmony/ci.yml?style=flat-square&label=CI" alt="CI"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue?style=flat-square" alt="License"></a>
    <a href="https://harmony.app"><img src="https://img.shields.io/badge/web-harmony.app-8b5cf6?style=flat-square" alt="Website"></a>
  </p>
</p>

> **Status:** Alpha — actively developed. Core chat works. Contributions welcome.

---

## Why Harmony?

| | Discord | Stoat (Revolt) | **Harmony** |
|--|---------|----------------|-------------|
| Client | Electron (~500 MB RAM) | Solid.js PWA | **Tauri native app (~80 MB RAM)** |
| Backend | Proprietary | Rust (6 microservices) | **Rust (single binary)** |
| Database | Proprietary | MongoDB + Redis + RabbitMQ | **PostgreSQL only** |
| Self-host complexity | N/A | 6 services + MongoDB + Redis + RabbitMQ + MinIO | **`docker compose up` (PostgreSQL only)** |
| Data privacy | Scans messages, shares data | Good | **No data collection, fully auditable** |
| ID verification | Requiring it | No | **Never** |
| E2EE | No | No | **Planned (DMs)** |
| Sustainable business model | Nitro + Ads | Donations (unclear sustainability) | **Open source + SaaS** |
| Voice / Video | Proprietary | Vortex | **LiveKit (open-source SFU)** |

### Privacy that you can verify

Your conversations are yours. Harmony is fully open source under AGPL-3.0 — you don't have to take our word for it, you can read every line of code that handles your data. We don't scan your messages, sell your data to advertisers, train AI on your conversations, or require ID verification to use the app. Chatting with your friends or running your community shouldn't cost you your privacy.

### Self-hosting that actually works

Other alternatives require you to deploy and maintain MongoDB, Redis, RabbitMQ, MinIO, and half a dozen interconnected services just to send a message. Harmony runs on PostgreSQL. That's it. One database, one API binary, one `docker compose up`. If you can run Postgres, you can run Harmony.

### Built to last

Open source projects that rely on donations alone often struggle to survive long-term. Harmony is designed as a sustainable business from day one: a generous free tier for everyone, optional cosmetics for supporters, and managed cloud hosting for those who prefer convenience. Your community platform shouldn't disappear because funding dried up.

### For teams, too

Harmony isn't just for gaming communities. Small teams and co-workers who want private group chat without Slack's per-seat pricing or Microsoft Teams' bloat can self-host Harmony for free. Full features, unlimited users, zero cost.

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
│  │  └─ HeroUI + Tailwind               │  │
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
- **Single binary** — The API is one Rust binary. No microservice orchestration, no message queues, no cache servers. Simpler to deploy, debug, and maintain.

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
│   │   ├── components/  UI primitives (HeroUI) + shared + layout
│   │   └── lib/         Generated API client, utils
│   └── src-tauri/       Tauri Rust runtime
│
└── supabase/            Supabase config + PostgreSQL migrations
```

---

## Self-Hosting

Harmony is designed to be self-hosted with a single command:

```bash
docker compose up
```

No MongoDB. No Redis. No RabbitMQ. No MinIO. Just PostgreSQL and one API binary.

Self-hosting gives you the complete product with no feature restrictions. Unlimited users, unlimited history, all features. Your server, your rules.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop client | Tauri 2 (Rust + WebView) |
| Frontend | React 19, Vite, TypeScript, Tailwind, HeroUI |
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

## Roadmap

| Phase | Goal | Status |
|-------|------|--------|
| **0 — Walking Skeleton** | Sign up, create server, send message | Done |
| **1 — Real-Time** | Two users chatting live, invites, presence | Done |
| **2 — Roles & DMs** | Permissions, private messages | In progress |
| **3 — Voice & Files** | LiveKit voice/video, file uploads, public beta | Planned |
| **4 — SaaS Launch** | Harmony Cloud, server discovery, push notifications | Planned |
| **5 — Growth** | E2EE, mobile app, web client, bot API | Planned |

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

Harmony is licensed under [AGPL-3.0](LICENSE). You can use, modify, and self-host it freely. If you run a modified version as a network service, you must release your source code.
