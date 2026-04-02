# Harmony — Root Command Center
# Usage: just <recipe> or just --list
#
# Orchestrates both harmony-api (Rust) and harmony-app (React/Tauri).

# Default: show available commands
default:
    @just --list --unsorted

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# QUALITY WALL — Run ALL checks across BOTH projects
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# Full quality wall: API + Tauri + App checks (the one command to rule them all)
wall: wall-api wall-tauri wall-app
    @echo ""
    @echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    @echo "  FULL QUALITY WALL PASSED"
    @echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Run Rust API quality wall
wall-api:
    @echo "━━━ API Quality Wall ━━━"
    cd harmony-api && just wall

# Run Tauri crypto quality wall
wall-tauri:
    @echo "━━━ Tauri Crypto Wall ━━━"
    cd harmony-app/src-tauri && cargo test --all-targets

# Run React App quality wall
wall-app:
    @echo "━━━ App Quality Wall ━━━"
    cd harmony-app && just wall

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# DEVELOPMENT (local Supabase + local API)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# Run API dev server (cargo-watch, auto-reload)
api-dev:
    cd harmony-api && just dev

# Run web app dev server (Vite, port 1420)
web-dev:
    cd harmony-app && just dev

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# PRODUCTION (local server ↔ production Supabase + production API)
# Create .env.production in each subproject — gitignored, never committed.
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# Run API against production Supabase (requires harmony-api/.env.production)
api-prod:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ ! -f harmony-api/.env.production ]; then
        echo "ERROR: harmony-api/.env.production not found" >&2
        echo "" >&2
        echo "Create it from .env.example with your production values:" >&2
        echo "  cp harmony-api/.env.example harmony-api/.env.production" >&2
        echo "  # Then fill in: DATABASE_URL, SUPABASE_JWT_SECRET, SUPABASE_URL, etc." >&2
        exit 1
    fi
    # WHY set -a/source: dotenvy::dotenv() won't override existing env vars,
    # so real env vars from .env.production take precedence over .env defaults.
    set -a
    source harmony-api/.env.production || { echo "ERROR: Failed to parse harmony-api/.env.production" >&2; exit 1; }
    set +a
    cd harmony-api && cargo watch -x run

# Run web app against production API + Supabase (requires harmony-app/.env.production)
web-prod:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ ! -f harmony-app/.env.production ]; then
        echo "ERROR: harmony-app/.env.production not found" >&2
        echo "" >&2
        echo "Create it from .env.example with your production values:" >&2
        echo "  cp harmony-app/.env.example harmony-app/.env.production" >&2
        echo "  # Then fill in: VITE_API_URL, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, etc." >&2
        exit 1
    fi
    # WHY --mode production: Vite natively loads .env.production with higher
    # priority than .env — no shell hacks needed.
    cd harmony-app && pnpm dev --mode production

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# CODE GENERATION (OpenAPI SSoT Pipeline)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# Full OpenAPI pipeline: Rust types → openapi.json → TypeScript client
gen-api:
    cd harmony-app && just gen-api

# Export OpenAPI spec only (no TS client regen)
openapi:
    cd harmony-api && just export-openapi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# RELEASE
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# Bump version in all manifests, commit, tag, and push — triggers Release CI
release version:
    #!/usr/bin/env bash
    set -euo pipefail
    # Guard: must be on main to avoid silent push failures
    BRANCH=$(git branch --show-current)
    if [ "$BRANCH" != "main" ]; then
      echo "ERROR: Must be on main branch (currently on '$BRANCH')" >&2
      exit 1
    fi
    echo "Bumping to v{{version}}..."
    cd harmony-app && npm pkg set version={{version}}
    cd ..
    # WHY .bak + rm: sed -i '' is macOS-only; -i.bak works on both BSD and GNU sed
    sed -i.bak 's/"version": "[^"]*"/"version": "{{version}}"/' harmony-app/src-tauri/tauri.conf.json && rm harmony-app/src-tauri/tauri.conf.json.bak
    sed -i.bak 's/^version = "[^"]*"/version = "{{version}}"/' harmony-app/src-tauri/Cargo.toml && rm harmony-app/src-tauri/Cargo.toml.bak
    # WHY cargo check: cargo generate-lockfile re-resolves ALL transitive deps,
    # risking untested upgrades. cargo check only updates the changed crate version.
    cd harmony-app/src-tauri && cargo check --quiet 2>/dev/null
    cd ../..
    git add harmony-app/package.json harmony-app/src-tauri/tauri.conf.json harmony-app/src-tauri/Cargo.toml harmony-app/src-tauri/Cargo.lock
    git commit -m "release: v{{version}}"
    git tag -a "v{{version}}" -m "Release v{{version}}"
    git push origin main --follow-tags
    echo "Tag v{{version}} pushed — Release CI triggered."

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# SETUP
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# Full project setup (both API + App)
setup:
    cd harmony-api && just setup
    cd harmony-app && just setup
    lefthook install
    @echo "Full setup complete!"
