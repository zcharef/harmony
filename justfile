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

# Full quality wall: API + App checks (the one command to rule them all)
wall: wall-api wall-app
    @echo ""
    @echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    @echo "  FULL QUALITY WALL PASSED"
    @echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Run Rust API quality wall
wall-api:
    @echo "━━━ API Quality Wall ━━━"
    cd harmony-api && just wall

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
# SETUP
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# Full project setup (both API + App)
setup:
    cd harmony-api && just setup
    cd harmony-app && just setup
    lefthook install
    @echo "Full setup complete!"
