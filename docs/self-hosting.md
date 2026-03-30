# Self-Hosting Harmony

> **Status:** Docker Compose setup is in progress. This document describes the target experience. Check [Releases](https://github.com/zcharef/harmony/releases) for the first self-hosting-ready version.

Harmony is fully self-hostable. You run the complete stack — database, auth, API, web app — on your own infrastructure. No calls home, no Supabase Cloud account required.

**What you get:**
- Full Supabase self-hosted stack (Postgres, GoTrue auth, Studio admin UI, Storage)
- Harmony Rust API
- Harmony web app (served by nginx)
- Migrations applied automatically on startup and on every upgrade

---

## Prerequisites

- Docker 24+ and Docker Compose v2.20+
- A server, VPS, or local machine (2 GB RAM minimum)
- A domain name (optional, required only for HTTPS)

---

## Quick Start

```bash
# 1. Clone
git clone https://github.com/zcharef/harmony.git
cd harmony

# 2. Configure
cp .env.example .env
# Edit .env — fill in the 5 required values (see below)

# 3. Build and start
docker compose up -d --build

# 4. Open the app
# Web: http://your-server-ip:8000
# Admin (Supabase Studio): http://your-server-ip:3001
```

That's it. Migrations run automatically inside the stack. The first build takes ~5 minutes (compiles the Rust API and React app). Subsequent builds are fast (Docker layer cache).

---

## Configuration

Copy `.env.example` to `.env` and fill in the following:

### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `POSTGRES_PASSWORD` | Postgres superuser password | `changeme-use-something-strong` |
| `JWT_SECRET` | Secret used to sign Supabase JWTs (min 32 chars) | output of `openssl rand -hex 32` |
| `ANON_KEY` | Supabase anonymous key (JWT signed with `JWT_SECRET`) | see [Generating Keys](#generating-keys) |
| `SERVICE_ROLE_KEY` | Supabase service-role key (JWT signed with `JWT_SECRET`) | see [Generating Keys](#generating-keys) |
| `SITE_URL` | Your public URL (used by GoTrue for auth redirects) | `https://chat.example.com` or `http://localhost:8000` |

### Optional but recommended for production

| Variable | Description | Default |
|----------|-------------|---------|
| `SESSION_SECRET` | HMAC secret for Harmony session cookies | random (not stable across restarts) |
| `SMTP_HOST` | SMTP server for email confirmation | — (email confirmation disabled if unset) |
| `SMTP_PORT` | SMTP port | `587` |
| `SMTP_USER` | SMTP username | — |
| `SMTP_PASS` | SMTP password | — |
| `SMTP_SENDER_NAME` | From name in emails | `Harmony` |

### Self-hosting specific

| Variable | Description | Value |
|----------|-------------|-------|
| `PLAN_ENFORCEMENT_ENABLED` | Disable SaaS plan limits | `false` |
| `ENVIRONMENT` | Runtime environment | `production` |
| `RATE_LIMIT_PER_MINUTE` | API rate limit per IP | `60` |
| `TRUSTED_PROXIES` | CIDR list of trusted reverse proxies | — |

### Optional / integrations

| Variable | Description |
|----------|-------------|
| `VITE_TURNSTILE_SITE_KEY` | Cloudflare Turnstile bot protection (skip for self-hosted) |
| `SENTRY_DSN` | Crash reporting for the Rust API |
| `VITE_SENTRY_DSN` | Crash reporting for the web app |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OpenTelemetry tracing endpoint |

---

## Generating Keys

Supabase requires a JWT `anon` key and a `service_role` key, both signed with your `JWT_SECRET`.

The easiest way is to use the official Supabase key generator:

```bash
# Install the Supabase CLI if you don't have it
brew install supabase/tap/supabase

# Generate keys (replace YOUR_JWT_SECRET with the value from your .env)
supabase gen keys --project-ref local --secret YOUR_JWT_SECRET
```

Or use [jwt.io](https://jwt.io) to manually create JWTs with these payloads:

**anon key payload:**
```json
{ "role": "anon", "iss": "supabase", "iat": 1741737600, "exp": 1899504000 }
```

**service_role key payload:**
```json
{ "role": "service_role", "iss": "supabase", "iat": 1741737600, "exp": 1899504000 }
```

Sign both with algorithm **HS256** and your `JWT_SECRET`.

---

## Stack Architecture

```
Your server
├── Port 8000 (Kong API gateway)      ← main entry point for web + Tauri app
│   ├── /auth/v1/*  → GoTrue (auth)
│   ├── /rest/v1/*  → PostgREST
│   └── /           → harmony-web (nginx serving the React SPA)
├── Port 3001 (Supabase Studio)        ← admin dashboard
└── Port 3000 (harmony-api)            ← internal only, not exposed
```

**Services started by `docker compose up -d --build`:**

| Service | Image | Purpose |
|---------|-------|---------|
| `db` | `supabase/postgres:17.x` | PostgreSQL with Supabase extensions and auth schema |
| `auth` | `supabase/gotrue` | JWT issuance, email/password auth, OAuth |
| `kong` | `kong:2.8.1` | API gateway, routes traffic to services |
| `rest` | `postgrest/postgrest` | Auto-generated REST API (used by Studio) |
| `meta` | `supabase/postgres-meta` | Schema inspector (used by Studio) |
| `studio` | `supabase/studio` | Supabase admin UI |
| `migrate` | `supabase/cli` | One-shot: applies Harmony DB migrations on startup |
| `harmony-api` | built from `harmony-api/Dockerfile` | Rust REST API |
| `harmony-web` | `nginx:alpine` + built app | Serves React SPA |

---

## Connecting the Desktop App

The Tauri desktop app will support a **"Set custom server"** setting (tracked in [#28](https://github.com/zcharef/harmony/issues/28)). Until that ships, desktop users on self-hosted instances need to build the app themselves (see [Building from Source](#building-from-source)).

For the **web app**, your self-hosted instance serves everything at `http://your-server:8000` — users just open that URL in their browser.

---

## Upgrading

```bash
cd harmony
git pull
docker compose pull
docker compose up -d --build
```

The `migrate` service runs on every startup and applies only new migrations (tracked in `supabase_migrations.schema_migrations`). It is safe to run repeatedly — already-applied migrations are skipped. There is no risk of re-running a migration you've already applied even if you're upgrading across many versions at once.

---

## HTTPS / TLS

The docker compose stack does not handle TLS itself. For production, put a reverse proxy in front of Kong (port 8000):

### Caddy (recommended — automatic TLS via Let's Encrypt)

Install Caddy on the host, then create `/etc/caddy/Caddyfile`:

```
chat.example.com {
    reverse_proxy localhost:8000
}
```

```bash
systemctl reload caddy
```

Caddy automatically provisions and renews the TLS certificate.

### nginx

```nginx
server {
    listen 443 ssl;
    server_name chat.example.com;

    ssl_certificate     /etc/letsencrypt/live/chat.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/chat.example.com/privkey.pem;

    # Required for SSE (real-time events)
    proxy_buffering off;
    proxy_cache off;

    location / {
        proxy_pass http://localhost:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}

server {
    listen 80;
    server_name chat.example.com;
    return 301 https://$host$request_uri;
}
```

Obtain a certificate with [Certbot](https://certbot.eff.org/):
```bash
certbot --nginx -d chat.example.com
```

> **SSE note:** The `proxy_buffering off` directive is required. Without it, nginx buffers the response and real-time events are never delivered to the browser.

---

## Email Setup

By default, GoTrue runs with email confirmation disabled (`GOTRUE_MAILER_AUTOCONFIRM=true`). Users can sign up and log in immediately without verifying their email.

To enable email confirmation, set SMTP vars in `.env`:

```bash
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=noreply@example.com
SMTP_PASS=your-smtp-password
SMTP_SENDER_NAME=Harmony
GOTRUE_MAILER_AUTOCONFIRM=false
```

Any SMTP provider works (Postmark, Resend, SendGrid, Gmail, your own server).

---

## Managing Users (Supabase Studio)

Supabase Studio is available at `http://your-server:3001`. From there you can:

- View and manage registered users (`Authentication → Users`)
- Inspect database tables and run SQL (`Table Editor`, `SQL Editor`)
- Monitor logs

Default Studio credentials are set by `DASHBOARD_USERNAME` and `DASHBOARD_PASSWORD` in `.env`.

---

## Plan Limits

Harmony's SaaS version enforces Free/Pro plan limits (max servers, channels, members, etc.). Self-hosted instances have **no limits** — set `PLAN_ENFORCEMENT_ENABLED=false` in `.env` (included in the default `.env.example`).

---

## Building from Source

If you want to customize the app or build the Tauri desktop client pointed at your instance:

### Web app

```bash
cd harmony-app
cp .env.example .env
# Edit .env:
#   VITE_API_URL=https://chat.example.com
#   VITE_SUPABASE_URL=https://chat.example.com   (Kong proxies /auth/v1/*)
#   VITE_SUPABASE_ANON_KEY=<your anon key>
pnpm install
pnpm build
# Output: dist/ — serve with any static file server
```

### Tauri desktop app

```bash
cd harmony-app
cp .env.example .env
# Edit .env with your instance URLs (same as above)

# Prerequisites: Rust stable, Node 20+, pnpm, Tauri CLI v2 prerequisites
# See: https://tauri.app/start/prerequisites/

pnpm install
pnpm tauri build
# Output: src-tauri/target/release/bundle/
```

> The Tauri auto-updater in self-built binaries points at the official GitHub releases by default. Disable it or replace the `updater.endpoints` and `updater.pubkey` in `src-tauri/tauri.conf.json` with your own release infrastructure.

---

## Troubleshooting

**`migrate` container exits with an error**

Check logs: `docker compose logs migrate`

Common causes:
- `auth` service not yet ready when migrate started (retry: `docker compose up migrate`)
- Migration SQL error — check the migration file name in the error output

**Can't log in / auth errors**

Verify `JWT_SECRET`, `ANON_KEY`, and `SERVICE_ROLE_KEY` are consistent. All three must use the same secret. Run `docker compose logs auth` for GoTrue error details.

**Real-time (SSE) not working**

If using nginx, ensure `proxy_buffering off` is set. If using Cloudflare proxy, set the route to "No Transform" and ensure HTTP/2 is enabled.

**Studio shows connection error**

Studio connects to PostgREST and the Supabase API via Kong. Ensure Kong is healthy: `docker compose ps kong`. Check `docker compose logs kong`.

---

## Security Notes

- Change all default passwords in `.env` before exposing to the internet
- `SERVICE_ROLE_KEY` bypasses Row Level Security — never expose it to the browser or include it in the web app build
- Studio (port 3001) should not be publicly accessible — firewall it or bind to localhost only
- The Rust API runs as a non-root user in a distroless container
- All database access is subject to Row Level Security policies

---

## License

Harmony is [AGPL-3.0](../LICENSE). You are free to self-host, modify, and distribute it. If you run a modified version as a network service, you must release your modifications under the same license.
