# syntax=docker/dockerfile:1.9

# -----------------------------------------------------------------------------
# Stage 1: Builder — compiles the Vite SPA (web-only, not Tauri desktop).
# WHY tsc && vite build: matches the package.json "build" script exactly.
# WHY --frozen-lockfile: reproducible installs; fails if pnpm-lock.yaml is stale.
# -----------------------------------------------------------------------------
FROM node:22-alpine AS builder

WORKDIR /app

# Install pnpm via corepack (ships with Node 22, no extra download)
RUN corepack enable && corepack prepare pnpm@latest --activate

# Accept all VITE_* build-time args — these are baked into the static bundle
ARG VITE_API_URL
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ARG VITE_TURNSTILE_SITE_KEY
ARG VITE_OFFICIAL_SERVER_ID

# Copy manifests first for layer caching
COPY package.json pnpm-lock.yaml ./

# Install all dependencies (including devDependencies needed for build)
RUN pnpm install --frozen-lockfile

# Copy source (after deps to maximise layer cache hits)
COPY . .

# Build: tsc type-check + vite bundle → dist/
RUN pnpm build

# -----------------------------------------------------------------------------
# Stage 2: Runtime — nginx serves the static bundle.
# WHY nginx:1.27-alpine: minimal, well-audited, no shell needed at runtime.
# -----------------------------------------------------------------------------
FROM nginx:1.27-alpine

COPY --from=builder /app/dist /usr/share/nginx/html
# WHY ../deploy: build context is harmony-app/ but nginx conf lives at repo root deploy/.
# docker-compose.yml must set context: . (repo root) and dockerfile: harmony-app/Dockerfile
# so that both src and deploy/ are reachable. See docker-compose.yml harmony-web service.
COPY deploy/nginx-app.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
