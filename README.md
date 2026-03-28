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
</p>
<p align="center">
  <p align="center">
    <a href="https://github.com/zcharef/harmony/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/zcharef/harmony/ci.yml?style=flat-square&label=CI&logo=github" alt="CI"></a>
    <a href="https://github.com/zcharef/harmony/actions/workflows/e2e-deploy.yml"><img src="https://img.shields.io/github/actions/workflow/status/zcharef/harmony/e2e-deploy.yml?style=flat-square&label=E2E%20%26%20Deploy&logo=playwright" alt="E2E & Deploy"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue?style=flat-square" alt="License"></a>
    <a href="https://joinharmony.app"><img src="https://img.shields.io/badge/web-joinharmony.app-8b5cf6?style=flat-square" alt="Website"></a>
  </p>
</p>

> **Status:** Alpha — actively developed. Core chat works. Contributions welcome.

---

## Why Harmony?

| | Discord | Stoat (Revolt) | **Harmony** |
|--|---------|----------------|-------------|
| Client | Electron (~500 MB RAM) | Solid.js PWA | **Web app + Tauri desktop (~80 MB RAM)** |
| Backend | Proprietary | Rust (6 microservices) | **Rust (single binary)** |
| Database | Proprietary | MongoDB + Redis + RabbitMQ | **PostgreSQL only** |
| Self-host complexity | N/A | 6 services + MongoDB + Redis + RabbitMQ + MinIO | **PostgreSQL + one binary** |
| Data privacy | Scans messages, shares data | Good | **No data collection, fully auditable** |
| ID verification | Requiring it | No | **Never** |
| E2EE | No | No | **Yes (desktop DMs + opt-in channels)** |
| Sustainable business model | Nitro + Ads | Donations (unclear sustainability) | **Open source + SaaS** |
| Voice / Video | Proprietary | Vortex | **LiveKit (open-source SFU) — planned** |

### Privacy that you can verify

Your conversations are yours. Harmony is fully open source under AGPL-3.0 — you don't have to take our word for it, you can read every line of code that handles your data. We don't scan your messages, sell your data to advertisers, train AI on your conversations, or require ID verification to use the app. Chatting with your friends or running your community shouldn't cost you your privacy.

### End-to-end encrypted where it matters

Direct messages from the desktop app are end-to-end encrypted using the [Olm protocol](https://gitlab.matrix.org/matrix-org/olm/-/blob/master/docs/olm.md) via [vodozemac](https://github.com/matrix-org/vodozemac) (NCC Group audited). The server stores ciphertext only — even we can't read encrypted DMs. Web users can also send and receive DMs, but their messages are transmitted as plaintext since no crypto runtime is available in the browser yet. The same conversation can contain both encrypted and plaintext messages — per-message lock icons make the encryption status of every message visible. Server owners can also enable E2EE per channel for group conversations.

> **Alpha disclaimer:** E2EE is functional but the integration layer has not yet undergone a professional security audit. The underlying cryptographic library (vodozemac) has been [audited by NCC Group](https://matrix.org/media/Hodgson_vodozemac_audit.pdf). We plan to commission a full integration audit before beta. Do not rely on Harmony for sensitive communications until the audit is complete.

### Web + Desktop — use Harmony anywhere

Harmony works in the browser and as a native desktop app. The React frontend is the same codebase — the web app is what you get when you open Harmony in a browser, and the desktop app wraps it in [Tauri](https://tauri.app/) for native performance (~80 MB RAM vs Electron's ~500 MB).

**Web app:** Full access to servers, channels, DMs, invites, members, roles, and moderation. DM messages sent from the web are not encrypted — per-message indicators show which messages are protected. Zero download, zero friction — just open the URL. This is how most people will first try Harmony.

**Desktop app:** Everything the web app does, plus end-to-end encrypted DMs. Messages you send from the desktop app are automatically encrypted — no setup required. The desktop app stores your encryption keys in your operating system's keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service) and runs all cryptography natively in Rust — private keys never touch JavaScript.

**Why E2EE requires the desktop app:** A web client downloads its code from the server on every page load. If the server is compromised, a modified JavaScript bundle could silently exfiltrate encryption keys. This is why Signal has never shipped a web client. We plan to add browser-based E2EE via vodozemac compiled to WebAssembly (proven in production by Element/Matrix) — but for v1, encrypted DMs are desktop-only. Web users can still send and receive DMs — their messages are transmitted as plaintext, while messages from desktop users remain encrypted. Per-message lock icons make the encryption status of every message visible.

A mobile app is planned for a future release.

### Self-hosting that actually works

Other alternatives require you to deploy and maintain MongoDB, Redis, RabbitMQ, MinIO, and half a dozen interconnected services just to send a message. Harmony runs on PostgreSQL. That's it. One database, one API binary. If you can run Postgres, you can run Harmony.

### Built to last

Open source projects that rely on donations alone often struggle to survive long-term. Harmony is designed as a sustainable business from day one: a generous free tier for everyone, optional cosmetics for supporters, and managed cloud hosting for those who prefer convenience. Your community platform shouldn't disappear because funding dried up.

### For teams, too

Harmony isn't just for gaming communities. Small teams and co-workers who want private group chat without Slack's per-seat pricing or Microsoft Teams' bloat can self-host Harmony for free. Full features, unlimited users, zero cost.

---

## Architecture

```
┌─────────────────────────┐  ┌───────────────────────────────────────┐
│       WEB BROWSER       │  │         TAURI DESKTOP APP             │
│  ┌───────────────────┐  │  │  ┌───────────────────────────────┐   │
│  │  React 19 (Vite)  │  │  │  │  React 19 (Vite)             │   │
│  │  (same codebase)  │  │  │  │  (same codebase)             │   │
│  │  Channels, servers │  │  │  │  + E2EE DMs (Olm/vodozemac) │   │
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
            └───┬────────────┬────┘
                │            │
       ┌────────▼──┐   ┌─────────────┐
       │ Supabase  │   │  LiveKit    │
       │ ├ Postgres│   │  (planned)  │
       │ ├ Auth    │   │  Voice      │
       │ ├ Storage │   │  Video      │
       │ └ Realtime│   │  Screen     │
       └───────────┘   └─────────────┘
```

**Key decisions:**
- **Single binary** — One Rust binary serves the entire API. No microservices, no message queues, no cache servers.
- **PostgreSQL only** — No Redis, no MongoDB. Supabase handles auth, storage, and real-time push.
- **Same codebase, two targets** — The React app runs in the browser or as a Tauri desktop app. E2EE is desktop-only (keys never touch JavaScript).

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

# 4b. Or start the Tauri desktop app (for E2EE DMs)
just tauri dev              # opens the native desktop app
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
├── harmony-app/         Web app + Tauri desktop (React 19 + Vite)
│   ├── src/
│   │   ├── features/    Feature-first business domains
│   │   │   ├── auth/        Login, session management
│   │   │   ├── channels/    Channel management
│   │   │   ├── chat/        Messaging
│   │   │   ├── crypto/      E2EE key management (desktop only)
│   │   │   ├── dms/         Direct messages
│   │   │   ├── members/     Member list, presence
│   │   │   ├── presence/    Online/offline status
│   │   │   ├── server-nav/  Server sidebar navigation
│   │   │   └── settings/    User settings
│   │   ├── components/  Shared UI + layout shell
│   │   └── lib/         Generated API client, utils
│   └── src-tauri/       Tauri Rust runtime (E2EE crypto, keychain)
│
└── supabase/            Supabase config + PostgreSQL migrations
```

---

## Self-Hosting

Harmony is designed to be simple to self-host: one API binary and PostgreSQL. No MongoDB. No Redis. No RabbitMQ. No MinIO.

Self-hosting gives you the complete product with no feature restrictions. Unlimited users, unlimited history, all features. Your server, your rules.

> **Coming soon:** A `docker compose up` one-liner and full self-hosting guide are planned for beta.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Web client | React 19 SPA (same codebase as desktop) |
| Desktop client | Tauri 2 (Rust + WebView) — adds E2EE via vodozemac |
| Frontend | React 19, Vite, TypeScript, Tailwind, HeroUI |
| State management | TanStack Query (server), Zustand (client) |
| Backend | Rust, Axum 0.8, SQLx |
| Database | PostgreSQL (via Supabase) |
| Auth | Supabase Auth (JWT) |
| Real-time | Supabase Realtime (Postgres Changes + Broadcast + Presence) |
| Voice / Video | LiveKit (open-source SFU) — planned |
| API docs | Code-first OpenAPI (utoipa) |
| Observability | tracing + OpenTelemetry + Sentry |
| CI | GitHub Actions |

---

## Roadmap

| Phase | Goal | Status |
|-------|------|--------|
| **0 — Walking Skeleton** | Sign up, create server, send message | Done |
| **1 — Real-Time** | Two users chatting live, invites, presence | Done |
| **2 — Roles & DMs** | Permissions, private messages | Done |
| **3 — E2EE + Web** | E2EE DMs (desktop), plaintext DMs (web), mixed-encryption conversations, opt-in channel E2EE | In Progress |
| **4 — Voice & Files** | LiveKit voice/video, file uploads, public beta | Planned |
| **5 — SaaS Launch** | Harmony Cloud, server discovery, push notifications | Planned |
| **6 — Growth** | Mobile app, web E2EE (WASM), bot API, key backup, multi-device | Planned |

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
