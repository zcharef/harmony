# Harmony — System Architecture Overview

> **Working Name:** Harmony
> **Tagline:** "The Discord that doesn't eat your RAM."
> **Vision:** Open-source, privacy-first group communication — Discord's UX with Signal's principles and GitLab's business model.

---

## 1. Product Positioning

| Attribute | Discord | Revolt | **Harmony** |
|-----------|---------|--------|-------------|
| Client | Electron (~500MB RAM) | Electron | **Tauri (~80MB RAM)** |
| Backend | Proprietary | Rust (open) | **Rust (open)** |
| Self-hostable | No | Yes | **Yes** |
| E2EE | No | No | **Planned (DMs)** |
| Business model | Nitro + Ads | Donations | **Open Core (GitLab model)** |
| Voice/Video | Proprietary | Vortex | **LiveKit** |

---

## 2. High-Level Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    TAURI DESKTOP APP                      │
│  ┌────────────────────────────────────────────────────┐  │
│  │  React 19 SPA (Vite)                              │  │
│  │  ├─ Generated TypeScript API client (OpenAPI SSoT)│  │
│  │  ├─ TanStack Query (server state cache)           │  │
│  │  ├─ Zustand (client state)                        │  │
│  │  └─ Shadcn UI + Tailwind                          │  │
│  └──────────────────┬────────────────────────────────┘  │
│                     │ HTTP (Bearer Token)                │
│  ┌──────────────────┴────────────────────────────────┐  │
│  │  Tauri Rust Runtime                               │  │
│  │  ├─ System tray, global hotkeys (Push-to-Talk)    │  │
│  │  ├─ Native notifications                          │  │
│  │  └─ File system access (downloads, cache)         │  │
│  └───────────────────────────────────────────────────┘  │
└──────────────────────────┬───────────────────────────────┘
                           │
              ┌────────────▼────────────────┐
              │      HARMONY RUST API       │
              │  (Axum — Hexagonal Arch)    │
              │  ├─ REST endpoints (/v1/*)  │
              │  ├─ Supabase JWT auth       │
              │  └─ RFC 9457 errors         │
              └─────┬──────────┬────────────┘
                    │          │
         ┌──────────▼──┐  ┌───▼──────────┐
         │  Supabase   │  │   LiveKit    │
         │  ├─ Postgres│  │  (SFU)      │
         │  ├─ Auth    │  │  Voice/Video│
         │  ├─ Storage │  │  Screen     │
         │  └─ Realtime│  │  Share      │
         └─────────────┘  └─────────────┘
```

### Data Flow Principles

1. **Pure UI Client:** The Tauri app has ZERO business logic. All validation, authorization, and data access flows through the Rust API.
2. **Supabase Realtime for push:** Real-time updates use Supabase Realtime (Postgres Changes for data, Broadcast for ephemeral events, Presence for online status). Client writes via REST POST to the Rust API; Supabase Realtime pushes changes automatically.
3. **OpenAPI SSoT:** Rust structs (utoipa) → `openapi.json` → Generated TypeScript client + Zod schemas. No manual type definitions.
4. **Supabase for Auth + Realtime + Storage:** The app calls Supabase Auth directly (login/signup) and subscribes to Supabase Realtime for push notifications. All data **writes and reads** go through the Rust API.

---

## 3. Architecture Decisions (Summary)

| Decision | Choice | Why |
|----------|--------|-----|
| Client runtime | Tauri 2 | 10x lighter than Electron, Rust backend for native perf |
| Frontend framework | React 19 + Vite | Largest ecosystem, Tauri has first-class React support |
| Backend language | Rust (Axum) | Memory-safe, zero-cost abstractions, ideal for concurrent requests |
| Database | PostgreSQL (via Supabase) | Battle-tested, RLS for security, excellent JSON support |
| Real-time | Supabase Realtime (Postgres Changes + Broadcast + Presence) | Battle-tested, RLS-aware, handles reconnection/scaling, no custom code |
| Voice/Video | LiveKit | Open-source SFU, Rust SDK, handles WebRTC complexity |
| Auth | Supabase Auth (GoTrue) | JWT-based, social logins, self-hostable |
| File storage | Supabase Storage (S3-compatible) | Integrated with auth, supports RLS policies |
| API documentation | Code-first OpenAPI (utoipa) | Rust structs are SSoT, TypeScript client auto-generated |
| Error format | RFC 9457 ProblemDetails | Standard, machine-readable, extensible |
| Architecture | Hexagonal (Ports & Adapters) | Domain logic testable without infra, swap DB/auth easily |
| Observability | tracing + OpenTelemetry + Sentry | Structured logs, distributed tracing, error tracking |

---

## 4. Monorepo Structure

```
harmony/
├── harmony-api/          # Rust REST API (Axum, hexagonal arch)
│   ├── src/
│   │   ├── domain/       # Pure business logic (models, ports, services)
│   │   ├── infra/        # Postgres (SQLx), Supabase Auth adapters
│   │   └── api/          # HTTP handlers, middleware, DTOs
│   ├── deploy/helm/      # Kubernetes Helm charts
│
│
├── harmony-app/          # Tauri desktop app (React + Vite)
│   ├── src/
│   │   ├── features/     # Feature-first business domains
│   │   ├── components/   # UI primitives (Shadcn) + shared + layout
│   │   └── lib/          # Generated API client, utils
│   └── src-tauri/        # Tauri Rust runtime
│
├── supabase/             # Supabase config + migrations
│   ├── config.toml
│   └── migrations/       # PostgreSQL migrations (SSoT for schema)
│
├── docs/
│   ├── architecture/    # This documentation
│   └── adr/             # Architecture Decision Records
├── lefthook.yml          # Git hooks (pre-commit, pre-push)
└── docker-compose.yml    # Local dev + self-hosting (future)
```

---

## 5. Isolation Model (MVP)

Harmony uses the **Slack/GitLab isolation model**, NOT Discord's federated model:

- **Harmony Cloud (SaaS):** One large centralized instance. Users create an account, join/create servers. Feels like Discord.
- **Self-Hosted:** A completely isolated instance. Users register locally. No communication with Harmony Cloud or other instances.

Federation (connecting self-hosted instances) is explicitly **out of scope** and deferred to post-1.0.

### Why Isolation?

1. **Privacy promise:** Self-hosters want complete control. Their instance should not "phone home."
2. **Simplicity:** Federation (ActivityPub, Matrix protocol) is a multi-year engineering effort.
3. **Business model:** Drives users toward Harmony Cloud for convenience.

---

## 6. Open Core Model

See [05-open-core.md](./05-open-core.md) for full details.

**Summary:**

| | Community Edition (CE) | Enterprise Edition (EE) | Harmony Cloud |
|--|------------------------|------------------------|---------------|
| Code | Open Source (AGPL-3.0) | Proprietary modules | EE on Harmony infra |
| Hosting | User's VPS | User's VPS | Harmony-managed |
| Core features | All | All | All |
| SSO / SAML | — | Yes | Yes (Pro plan) |
| Audit logs | Basic | Advanced | Advanced |
| Priority support | — | Yes | Yes |
| Cost | Free | License fee | Subscription |

---

## 7. Document Index

| Document | Contents |
|----------|----------|
| [00-overview.md](./00-overview.md) | This file — system overview |
| [01-database-schema.md](./01-database-schema.md) | PostgreSQL schema, tables, RLS policies |
| [02-api-design.md](./02-api-design.md) | REST API endpoints, DTOs, error contracts |
| [03-realtime.md](./03-realtime.md) | Supabase Realtime architecture, LiveKit voice/video |
| [04-auth-and-permissions.md](./04-auth-and-permissions.md) | Auth flow, RBAC, permission bitmasks |
| [05-open-core.md](./05-open-core.md) | Business model, CE vs EE, monetization |
| [06-self-hosting.md](./06-self-hosting.md) | Docker Compose, deployment, ops |
| [07-roadmap.md](./07-roadmap.md) | Phased development plan, milestones |
