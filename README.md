<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="mediakit/logo_horizontal_dark.png">
    <source media="(prefers-color-scheme: light)" srcset="mediakit/logo_horizontal.png">
    <img alt="Harmony" src="mediakit/logo_horizontal_dark.png" height="64">
  </picture>
  <br /><br />
  <strong>Your chat app shouldn't sell your data.</strong>
  <br />
  Open-source, privacy-first group communication — Discord's UX with Signal's principles.
  <br /><br />
  <a href="https://github.com/zcharef/harmony/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/zcharef/harmony/ci.yml?style=flat-square&label=CI&logo=github" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue?style=flat-square" alt="License"></a>
  <a href="https://joinharmony.app"><img src="https://img.shields.io/badge/try_it-joinharmony.app-8b5cf6?style=flat-square" alt="Try Harmony"></a>
  <br /><br />
  <a href="https://ko-fi.com/Z8Z11JU7E7"><img src="https://ko-fi.com/img/githubbutton_sm.svg" alt="ko-fi"></a>
</p>

> **Status:** Alpha, actively developed. Text chat, voice (LiveKit), DMs, presence, and moderation are live. [Try it](https://joinharmony.app) or self-host it.

<!-- TODO: Add screenshot here -->
<!-- <p align="center"><img src="mediakit/screenshot.png" alt="Harmony" width="800"></p> -->

---

## Why Harmony?

| | Discord | Revolt | **Harmony** |
|--|---------|--------|-------------|
| Client | Electron (~500 MB RAM) | Solid.js PWA | **Web + Tauri desktop (~80 MB RAM)** |
| Backend | Proprietary | 6 Rust microservices | **Single Rust binary** |
| Database | Proprietary | MongoDB + Redis + RabbitMQ | **PostgreSQL only** |
| Self-host | N/A | 6 services + 4 datastores | **One docker compose command** |
| Privacy | Scans messages, sells data | Good | **No data collection, fully auditable** |
| E2EE | No | No | **In development (DMs first)** |

### What makes Harmony different

- **Privacy you can verify.** Fully open source under AGPL-3.0. We don't scan your messages, sell your data, or train AI on your conversations. You can read every line of code that handles your data.

- **The Discord features you expect.** Reactions, replies, unread indicators, emoji picker, avatars, markdown, message grouping, date dividers, per-channel notification settings, presence and DND, moderation and anti-spam. All shipped.

- **E2EE in development.** The crypto foundation is built on [vodozemac](https://github.com/matrix-org/vodozemac) (NCC Group audited). It runs natively in the desktop app's Rust runtime and keys live in your OS keychain, so private keys never touch JavaScript. E2EE DMs are the next milestone. Not live yet.

- **Simple to self-host.** One docker compose command runs the whole stack: the Harmony Rust binary, PostgreSQL, and Supabase's open-source auth (GoTrue). No Redis, no MongoDB, no RabbitMQ. Full features, unlimited users, your rules.

- **Discord migration (planned).** The goal: bring your entire server over with channels, roles, categories, and permissions intact. On the roadmap, not built yet.

- **Web + Desktop, same codebase.** Use Harmony in the browser with zero friction, or install the Tauri desktop app for native performance (~80 MB RAM vs Electron's ~500 MB). E2EE DMs will land on desktop first.

> **Alpha disclaimer:** E2EE is under active development and not yet live in production. The underlying crypto library (vodozemac) has been [audited by NCC Group](https://matrix.org/media/Hodgson_vodozemac_audit.pdf). Full integration audit planned before beta.

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
git clone https://github.com/zcharef/harmony.git
cd harmony

# 2. Start Supabase (Postgres + Auth + Realtime)
supabase start

# 3. Start the Rust API
cd harmony-api
cp .env.example .env
just dev                    # hot-reload on port 3000

# 4a. Start the web app (new terminal)
cd harmony-app
pnpm install
just dev                    # opens http://localhost:1420

# 4b. Or start the Tauri desktop app (native desktop build)
just tauri dev              # opens the native desktop app
```

### Quality wall

Both projects enforce a quality wall before merge:

```bash
# Rust API — fmt, clippy, security audit, all tests
cd harmony-api && just wall

# App — Biome, typecheck, module boundaries, dead code detection
cd harmony-app && just wall
```

> Run `just` in either project to see all available commands.

---

## Architecture

```
┌─────────────────────────┐  ┌───────────────────────────────────────┐
│       WEB BROWSER       │  │         TAURI DESKTOP APP             │
│  ┌───────────────────┐  │  │  ┌───────────────────────────────┐   │
│  │  React 19 (Vite)  │  │  │  │  React 19 (Vite)             │   │
│  │  (same codebase)  │  │  │  │  (same codebase)             │   │
│  │                    │  │  │  │  + E2EE (Olm / vodozemac)   │   │
│  └────────┬──────────┘  │  │  └────────────┬──────────────────┘   │
│           │ HTTP         │  │               │ invoke()             │
└───────────┼──────────────┘  │  ┌────────────┴──────────────────┐   │
            │                 │  │  Tauri Rust Runtime            │   │
            │                 │  │  ├─ vodozemac (Olm crypto)     │   │
            │                 │  │  ├─ OS Keychain (key storage)  │   │
            │                 │  │  └─ SQLCipher (message cache)  │   │
            │                 │  └────────────┬──────────────────┘   │
            │                 └───────────────┼─────────────────────┘
            │                                 │
            └──────────┬──────────────────────┘
                       │ HTTPS
            ┌──────────▼──────────┐
            │   HARMONY RUST API  │
            │   (single binary)   │
            │  SSE over Postgres  │
            │    LISTEN/NOTIFY    │
            └───┬────────────┬────┘
                │            │
     ┌──────────▼─────┐   ┌──▼──────────┐
     │ Supabase (OSS) │   │  LiveKit    │
     │ ├ Postgres     │   │  Voice      │
     │ ├ Auth (GoTrue)│   └─────────────┘
     │ └ Storage      │
     └────────────────┘
```

---

## Project Structure

```
harmony/
├── harmony-api/         Rust API (Axum)
│   ├── src/
│   │   ├── domain/      Business logic, models, service traits
│   │   ├── infra/       PostgreSQL repos, auth adapters
│   │   └── api/         HTTP handlers, middleware, DTOs
│   └── tests/           Integration + architecture tests
│
├── harmony-app/         Web + desktop app (React 19 + Vite)
│   ├── src/
│   │   ├── features/    Feature-first modules (auth, chat, dms, crypto, ...)
│   │   ├── components/  Shared UI + layout shell
│   │   └── lib/         Generated API client, utilities
│   ├── src-tauri/       Tauri Rust runtime (E2EE, keychain)
│   └── e2e/             Playwright end-to-end tests
│
└── supabase/            Config + PostgreSQL migrations
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, Vite, TypeScript, Tailwind CSS, HeroUI |
| Desktop | Tauri 2 + vodozemac (E2EE) + SQLCipher |
| State | TanStack Query (server), Zustand (client) |
| Backend | Rust, Axum, SQLx |
| Database | PostgreSQL (via Supabase) |
| Real-time | Rust SSE over Postgres LISTEN/NOTIFY |
| API contract | Code-first OpenAPI (Rust types → TypeScript client) |
| Testing | Playwright (E2E), Vitest (unit), cargo test |
| CI | GitHub Actions |

---

## Roadmap

| Phase | Goal | Status |
|-------|------|--------|
| **0** | Sign up, create server, send message | Done |
| **1** | Live chat, invites, presence | Done |
| **2** | Roles, permissions, direct messages | Done |
| **3** | Voice (LiveKit), Discord-parity QoL, moderation | Done |
| **4** | E2EE DMs (desktop), opt-in channel encryption | In Progress |
| **5** | Video/screen share, file uploads | Planned |
| **6** | Server discovery, push notifications | Planned |
| **7** | Mobile app, web E2EE (WASM), bot API | Planned |

---

## Self-Hosting

Run the full Harmony stack on your own infrastructure — no Supabase Cloud account required.

```bash
git clone https://github.com/zcharef/harmony.git && cd harmony
cp .env.example .env   # fill in the 5 required values (see docs)
docker compose up -d --build
# Web app: http://your-server:8080
# Supabase Studio: http://your-server:3001
```

For full instructions — env vars, key generation, TLS, upgrading, troubleshooting — see **[docs/self-hosting.md](docs/self-hosting.md)**.

---

## Contributing

Contributions welcome! See [`CONTRIBUTING.md`](CONTRIBUTING.md) for setup and guidelines.

Before submitting a PR:
1. Run `just wall` in the project you changed
2. Follow [conventional commits](https://www.conventionalcommits.org/)
3. One concern per PR

## Security

Found a vulnerability? See [`SECURITY.md`](SECURITY.md).

## License

[AGPL-3.0](LICENSE) — use, modify, and self-host freely. If you run a modified version as a network service, you must release your source code.
