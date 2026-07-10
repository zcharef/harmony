<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="mediakit/logo_horizontal_dark.png">
    <source media="(prefers-color-scheme: light)" srcset="mediakit/logo_horizontal.png">
    <img alt="Harmony" src="mediakit/logo_horizontal_dark.png" height="64">
  </picture>
  <br /><br />
  <strong>Discord-class chat you can run yourself.</strong>
  <br />
  Open-source, AGPL-3.0 community chat with a Rust API, LiveKit voice, and a self-host path built around one Docker Compose command.
  <br /><br />
  <a href="https://github.com/zcharef/harmony/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/zcharef/harmony/ci.yml?style=flat-square&label=CI&logo=github" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue?style=flat-square" alt="License"></a>
  <a href="https://joinharmony.app"><img src="https://img.shields.io/badge/try_it-joinharmony.app-8b5cf6?style=flat-square" alt="Try Harmony"></a>
  <br /><br />
  <a href="https://ko-fi.com/Z8Z11JU7E7"><img src="https://ko-fi.com/img/githubbutton_sm.svg" alt="ko-fi"></a>
</p>

> **Status:** Alpha, actively developed. Text chat, LiveKit voice, DMs, presence, roles, and moderation are live. Attachments, notifications, and E2EE are still in progress.

<!-- TODO(launch-assets): hero screenshot + demo GIF go here — see dev/active/tickets/launch-assets.md -->
<!-- <p align="center"><img src="mediakit/screenshot-hero.png" alt="Harmony" width="800"></p> -->

---

## Try it

Three ways in, pick your poison:

- **Browser** — [app.joinharmony.app](https://app.joinharmony.app). No download, no phone number, no ID verification. Chatting in under a minute.
- **Self-host** — the full stack on your own machine with one command. Unlimited users, every feature, no strings:
  ```bash
  git clone https://github.com/zcharef/harmony.git && cd harmony
  cp .env.example .env   # fill in the 5 required values (see docs)
  docker compose up -d --build
  ```
  Full guide (env vars, keys, TLS, upgrades): **[docs/self-hosting.md](docs/self-hosting.md)**
- **Desktop** — native Tauri app (~80 MB RAM vs Electron's ~500 MB), built from source today; packaged releases are on the roadmap. See [Development](#development).

---

## Why Harmony?

Harmony's first promise is practical ownership: a Discord-class chat surface you can inspect, run, and move to your own infrastructure.

### What makes Harmony different

- **Privacy you can verify.** Harmony is fully open source under AGPL-3.0, so you can inspect the code that handles your data. Self-hosted instances run on your infrastructure and do not report usage back to Harmony.

- **The Discord features you expect.** Reactions, replies, unread indicators, emoji picker, avatars, markdown, message grouping, date dividers, per-channel notification settings, presence and DND, voice channels, moderation and anti-spam. All shipped.

- **E2EE in development.** The crypto foundation is built on [vodozemac](https://github.com/matrix-org/vodozemac) (NCC Group audited). It runs natively in the desktop app's Rust runtime and keys live in your OS keychain, so private keys never touch JavaScript. E2EE DMs are the next milestone. Not live yet.

- **Simple to self-host.** One Docker Compose command runs the current stack: Harmony's Rust API, Postgres, and Supabase's open-source auth services. No Redis, no MongoDB, no RabbitMQ.

- **Keep ownership of your community.** Move to your own hardware any time: same codebase, same product surface, your infrastructure. Discord migration tooling is in development; assisted structure-only migration is available by request ([migrate@joinharmony.app](mailto:migrate@joinharmony.app)).

- **Web + Desktop, same codebase.** Use Harmony in the browser with zero friction, or run the Tauri desktop app for native performance. E2EE DMs will land on desktop first.

> **Alpha disclaimer:** E2EE is under active development and not yet live in production. The underlying crypto library (vodozemac) has been [audited by NCC Group](https://matrix.org/media/Hodgson_vodozemac_audit.pdf). Full integration audit planned before beta.

---

## Development

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
| **4** | Attachments, notifications, mentions, onboarding | In Progress |
| **5** | E2EE DMs (desktop), opt-in channel encryption | In Progress |
| **6** | Server discovery, custom emoji, push notifications | Planned |
| **7** | Mobile app, web E2EE (WASM), bot API | Planned |

---

## Contributing

Contributions welcome! See [`CONTRIBUTING.md`](CONTRIBUTING.md) for setup and guidelines.

Before submitting a PR:
1. Run `just wall` in the project you changed
2. Follow [conventional commits](https://www.conventionalcommits.org/)
3. One concern per PR

If you want software like this to exist and can't contribute code, a GitHub star helps people find the project.

## Security

Found a vulnerability? See [`SECURITY.md`](SECURITY.md).

## License

[AGPL-3.0](LICENSE) — use, modify, and self-host freely. If you run a modified version as a network service, you must release your source code.
