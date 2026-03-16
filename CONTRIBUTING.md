# Contributing to Harmony

Thank you for your interest in contributing to Harmony! This guide will help you get started.

## Development Setup

### Prerequisites

- **Rust** (latest stable via rustup)
- **Node.js** 20+ and **pnpm**
- **Docker** (for Supabase local dev)
- **Supabase CLI** (`brew install supabase/tap/supabase`)
- **just** (`brew install just`) — command runner

### Getting Started

```bash
# 1. Clone the repo
git clone https://github.com/harmony-app/harmony.git
cd harmony

# 2. Start Supabase (Postgres + Auth)
supabase start

# 3. Start the Rust API
cd harmony-api
cp .env.example .env
just dev

# 4. Start the Tauri app (new terminal)
cd harmony-app
pnpm install
just dev
```

### Quality Wall

Before pushing, run the quality wall in both projects:

```bash
# Rust API
cd harmony-api && just wall

# Tauri App
cd harmony-app && just wall
```

These checks also run automatically via git hooks (Lefthook) and CI.

## Code Standards

### Architecture Rules

#### Enforcement Rules (Machine-Verified)

Every quality property is enforced by automated tests, not just documentation. See [`docs/adr/013-enforcement-tests.md`](./docs/adr/013-enforcement-tests.md).

**Rust API (`harmony-api/`):**

| Rule | Enforcement | ADR |
|------|-------------|-----|
| Domain layer purity | `tests/architecture_test.rs` | [003](./docs/adr/003-hexagonal-architecture.md) |
| All handlers have `#[utoipa::path]` | `tests/openapi_enforcement_test.rs` | [007](./docs/adr/007-code-first-openapi.md) |
| RFC 9457 error format | `tests/rfc9457_contract_test.rs` | [008](./docs/adr/008-rfc9457-problem-details.md) |
| No `println!`/`dbg!` | Clippy `print_stdout = "deny"` | 017 |
| Compile-time SQL only | `tests/rust_patterns_test.rs` | 016 |
| No `std::sync::Mutex` in async | `tests/rust_patterns_test.rs` | 022 |
| No `std::env::var` outside config | `tests/rust_patterns_test.rs` | 025 |
| All routes under `/v1/` | `tests/api_convention_test.rs` | 020 |
| No mock crates | `deny.toml` bans | 018 |
| Non-destructive migrations | `scripts/lint-migrations.sh` | 019 |

**Frontend (`harmony-app/`):**

| Rule | Enforcement | ADR |
|------|-------------|-----|
| No `any` | Biome `noExplicitAny: error` | -- |
| No `console.*` | Biome `noConsole: error` | [042](./docs/adr/042-structured-logging.md) |
| Module boundaries | `eslint-plugin-boundaries` | -- |
| No circular deps | `madge` | -- |
| Feature barrel exports | `tests/arch/feature-structure.test.ts` | -- |
| No direct Supabase data access | `tests/arch/type-safety.test.ts` | 015 |
| No inline styles | `tests/arch/react-patterns.test.ts` | 032 |
| No logic in barrel `index.ts` | `tests/arch/react-patterns.test.ts` | 030 |
| No complex boolean state | `tests/arch/react-patterns.test.ts` | 031 |
| No raw fetch | `tests/arch/type-safety.test.ts` | -- |
| `throwOnError: true` on SDK calls | CLAUDE.md enforcement | -- |
| Query key factory | `tests/arch/react-patterns.test.ts` | 029 |

**Rust API (Hexagonal Architecture):**
- `src/domain/` is pure Rust — zero infra imports (no SQLx, no Axum)
- Repository traits are intent-based (e.g., `create_server`, not `insert_row`)
- All IDs use NewTypes (`UserId`, `ServerId`) — never raw `String` or `Uuid`
- No `unwrap()` or `expect()` in production code — propagate errors with `?`
- All HTTP errors use RFC 9457 ProblemDetails format
- Every handler has `#[utoipa::path]`, every DTO has `#[derive(ToSchema)]`

**Tauri App (Feature-First):**
- Business code lives in `src/features/`, not root-level folders
- Each feature has an `index.ts` barrel export — deep imports are build errors
- No `@radix-ui/*` or `@/components/ui/*` imports — use `@heroui/react` (ADR-044)
- All API calls use the generated client with `throwOnError: true`
- No manual TypeScript type definitions for API data — import from `@/lib/api`
- State management: TanStack Query (server), React Hook Form (forms), useState (ephemeral), Zustand (global, sparingly)

### Type Safety (End-to-End)

```
Rust #[derive(ToSchema)] -> openapi.json -> TypeScript types + Zod schemas
```

- If you change a Rust DTO, run `just export-openapi` then `just gen-api`
- The TypeScript app will fail to compile if types are mismatched
- Use `satisfies` for type assertions, not `as`
- Use auto-generated Zod schemas for runtime validation at boundaries

### Commit Messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(chat): add message editing
fix(auth): handle expired refresh token
refactor(api): extract permission service
docs: update architecture overview
```

**Types:** feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert
**Scopes:** chat, channels, servers, members, auth, ui, config, deps

### What NOT to Do

- Do not add `console.log` — use structured logging
- Do not use `any` — it's a build error (Biome)
- Do not use `unsafe` in Rust — it's forbidden (Cargo lint)
- Do not bypass git hooks with `--no-verify`
- Do not add dependencies without discussion in an issue first
- UI primitives come from `@heroui/react` — see ADR-044. No copy-pasted component wrappers.
- Do not modify `src/lib/api/` (auto-generated)

### Database Changes

All database schema changes follow the Supabase local-first workflow (ADR-043).

- **Never modify the database via the Supabase Dashboard.** Migrations are the single source of truth.
- Create migrations with `supabase migration new <name>` and write idempotent SQL (`IF NOT EXISTS`, `IF EXISTS`).
- Migrations must be **non-destructive**: no `DROP COLUMN`, no `DROP TABLE`, no `optional -> required` changes (ADR-019).
- RLS must be enabled on every new table (ADR-040).
- Test migrations locally with `supabase db reset` before pushing.

## Pull Request Process

1. Fork the repo and create a branch from `main`
2. Make your changes following the code standards above
3. Run `just wall` in both projects — all checks must pass
4. If you changed the Rust API DTOs/handlers, regenerate the OpenAPI spec
5. Open a PR using the template — fill in all sections
6. Wait for CI to pass and a maintainer to review

### PR Size

- Keep PRs small and focused (< 400 lines changed)
- One feature or fix per PR
- If a change is large, discuss the approach in an issue first

## Reporting Issues

- **Bugs:** Use the bug report template
- **Features:** Use the feature request template
- **Security:** See [SECURITY.md](./SECURITY.md) — do NOT open a public issue

## License

By contributing, you agree that your contributions will be licensed under the project's AGPL-3.0 license (for Community Edition code). See [LICENSE](./LICENSE).
