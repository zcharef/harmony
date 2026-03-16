# Harmony — Self-Hosting & Deployment

---

## 1. Deployment Modes

| Mode | For | Infrastructure |
|------|-----|----------------|
| **Development** | You, right now | `supabase start` + `cargo run` + `pnpm dev` |
| **Harmony Cloud (SaaS)** | Your paying customers | Supabase Cloud + Kubernetes (Helm) + LiveKit Cloud |
| **Self-Hosted CE** | Open source users | Single `docker-compose.yml` on any VPS |
| **Self-Hosted EE** | Enterprise customers | Same Docker Compose + license key env var |

---

## 2. Development Setup

Already configured in the project. Quick reference:

```bash
# Terminal 1: Supabase (Postgres + Auth)
cd harmony/
supabase start

# Terminal 2: Rust API
cd harmony-api/
just dev

# Terminal 3: Tauri app
cd harmony-app/
just tauri-dev
```

Ports:
- Supabase API: `64321`
- Supabase DB: `64322`
- Supabase Studio: `64323`
- Rust API: `3000`
- Vite dev: `1420`

---

## 3. Self-Hosted Docker Compose

This is what open-source users get. One file, one command.

```yaml
# docker-compose.yml (shipped in repo root)

services:
  # ── Database & Auth (Supabase) ─────────────────────
  postgres:
    image: supabase/postgres:17.2.0
    restart: unless-stopped
    ports:
      - "5432:5432"
    environment:
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-changeme}
      POSTGRES_DB: harmony
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 5

  supabase-auth:
    image: supabase/gotrue:v2.170.0
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      GOTRUE_DB_DRIVER: postgres
      GOTRUE_DB_DATABASE_URL: postgres://postgres:${POSTGRES_PASSWORD:-changeme}@postgres:5432/harmony?sslmode=disable
      GOTRUE_SITE_URL: ${SITE_URL:-http://localhost:3000}
      GOTRUE_JWT_SECRET: ${JWT_SECRET:-your-super-secret-jwt-token-with-at-least-32-characters-long}
      GOTRUE_JWT_EXP: 3600
      GOTRUE_EXTERNAL_EMAIL_ENABLED: "true"
      GOTRUE_MAILER_AUTOCONFIRM: "true"
      API_EXTERNAL_URL: ${API_EXTERNAL_URL:-http://localhost:9999}
    ports:
      - "9999:9999"

  supabase-storage:
    image: supabase/storage-api:v1.14.6
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      DATABASE_URL: postgres://postgres:${POSTGRES_PASSWORD:-changeme}@postgres:5432/harmony
      STORAGE_BACKEND: file
      FILE_STORAGE_BACKEND_PATH: /var/lib/storage
      ANON_KEY: ${SUPABASE_ANON_KEY}
      SERVICE_KEY: ${SUPABASE_SERVICE_KEY}
      PGRST_JWT_SECRET: ${JWT_SECRET:-your-super-secret-jwt-token-with-at-least-32-characters-long}
    volumes:
      - storage_data:/var/lib/storage

  # ── Harmony API ────────────────────────────────────
  harmony-api:
    image: ghcr.io/harmony-app/harmony-api:latest
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    ports:
      - "3000:3000"
    environment:
      SERVER_PORT: "3000"
      ENVIRONMENT: production
      DATABASE_URL: postgres://postgres:${POSTGRES_PASSWORD:-changeme}@postgres:5432/harmony
      SUPABASE_JWT_SECRET: ${JWT_SECRET:-your-super-secret-jwt-token-with-at-least-32-characters-long}
      SUPABASE_URL: http://supabase-auth:9999
      # EE only (optional):
      # LICENSE_KEY: ${LICENSE_KEY}

  # ── LiveKit (Voice/Video) ──────────────────────────
  livekit:
    image: livekit/livekit-server:v1.7
    restart: unless-stopped
    ports:
      - "7880:7880"
      - "7881:7881"
      - "7882:7882/udp"
    environment:
      LIVEKIT_KEYS: "${LIVEKIT_API_KEY:-devkey}: ${LIVEKIT_API_SECRET:-devsecret}"
    command: --config /etc/livekit.yaml
    volumes:
      - ./livekit.yaml:/etc/livekit.yaml

volumes:
  postgres_data:
  storage_data:
```

### User Experience

```bash
# 1. Clone the repo
git clone https://github.com/harmony-app/harmony.git
cd harmony

# 2. Copy example env
cp .env.example .env
# Edit .env: set POSTGRES_PASSWORD, JWT_SECRET, etc.

# 3. Start everything
docker compose up -d

# 4. Run migrations
docker compose exec harmony-api harmony-migrate

# 5. Open Harmony at http://localhost:3000
```

---

## 4. Harmony Cloud (SaaS) Deployment

### Infrastructure

```
┌─────────────────────────────────────────────────┐
│              Kubernetes Cluster                  │
│                                                  │
│  ┌──────────────┐   ┌──────────────┐            │
│  │ harmony-api  │   │ harmony-api  │  (HPA)     │
│  │ Pod 1        │   │ Pod 2        │            │
│  └──────┬───────┘   └──────┬───────┘            │
│         │                  │                     │
│         └────────┬─────────┘                     │
│                  │                               │
│         ┌────────▼────────┐                      │
│         │    Ingress      │                      │
│         │ (api.harmony.app)                      │
│         └─────────────────┘                      │
└─────────────────────────────────────────────────┘
                   │
      ┌────────────┼────────────┐
      ▼            ▼            ▼
┌──────────┐ ┌──────────┐ ┌──────────┐
│ Supabase │ │ LiveKit  │ │ Sentry   │
│ Cloud    │ │ Cloud    │ │ (errors) │
└──────────┘ └──────────┘ └──────────┘
```

### Why Supabase Cloud for SaaS?

- Automatic backups (Point-in-Time Recovery)
- Connection pooling (PgBouncer)
- Edge functions for webhooks
- Managed auth (email templates, social logins)
- You don't need to be a DBA

### Helm Deployment

Helm charts already exist in `harmony-api/deploy/helm/`. Key values:

```yaml
# values.yaml
replicaCount: 2
image:
  repository: ghcr.io/harmony-app/harmony-api
  tag: "latest"

env:
  DATABASE_URL: "postgres://...@db.supabase.co:5432/postgres"
  SUPABASE_JWT_SECRET: "<from-supabase-dashboard>"
  SUPABASE_URL: "https://xyzproject.supabase.co"
  SENTRY_DSN: "https://...@sentry.io/..."

autoscaling:
  enabled: true
  minReplicas: 2
  maxReplicas: 10
  targetCPUUtilization: 70
```

---

## 5. Database Migrations Strategy

### Same migrations, everywhere

```
supabase/migrations/
├── 20260215000000_create_profiles.sql
├── 20260215000001_create_servers.sql
└── ...
```

| Environment | How migrations run |
|------------|-------------------|
| **Dev** | `supabase db reset` (drops and recreates) |
| **SaaS (Supabase Cloud)** | `supabase db push` (applies pending migrations) |
| **Self-hosted (Docker)** | `harmony-migrate` binary runs on startup |

The `harmony-migrate` binary is a thin wrapper around SQLx migrations that reads the same SQL files.

---

## 6. Backup Strategy (SaaS)

| What | How | Frequency |
|------|-----|-----------|
| Database | Supabase PITR (Point-in-Time Recovery) | Continuous |
| File storage | Supabase Storage (S3-backed) | Built-in |
| Config | Git (infrastructure-as-code) | Every commit |

For self-hosted users: document `pg_dump` cron job in the README.

---

## 7. Domain Architecture (SaaS)

```
harmony.app              → Marketing website
app.harmony.app           → Tauri app download page
api.harmony.app            → Rust API
cloud.harmony.app          → Web client (future, Phase 4)
```

---

## 8. Monitoring (SaaS)

Already configured in the Rust API:

| Tool | Purpose | Status |
|------|---------|--------|
| Sentry | Error tracking, performance | Configured |
| OpenTelemetry | Distributed tracing | Configured |
| tracing (structured logs) | Application logging | Configured |
| Supabase Dashboard | DB metrics, auth stats | Built-in |
| LiveKit Dashboard | Voice/video metrics | Built-in |
