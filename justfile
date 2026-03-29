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
# DEVELOPMENT
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# Run API dev server
dev-api:
    cd harmony-api && just dev

# Run App dev server (Vite, port 1420)
dev-app:
    cd harmony-app && just dev

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
