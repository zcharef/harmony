## Type

- [ ] feat — New feature
- [ ] fix — Bug fix
- [ ] refactor — Code change that neither fixes a bug nor adds a feature
- [ ] docs — Documentation only
- [ ] test — Adding or updating tests
- [ ] chore — Build process, dependencies, or tooling

## Description

<!-- What does this PR do? Why is it needed? -->

## Changes

<!-- Bullet list of key changes -->

## Checklist

### Required
- [ ] `just wall` passes in affected project(s)
- [ ] Conventional commit messages used
- [ ] PR is focused (< 400 lines, one concern)

### If API changed
- [ ] `just export-openapi` run and `openapi.json` committed
- [ ] `just gen-api` run in harmony-app
- [ ] TypeScript still compiles (`just typecheck`)

### If database changed
- [ ] Migration is idempotent (uses `IF NOT EXISTS`)
- [ ] No `DROP` statements
- [ ] RLS policies added for new tables

### Code quality
- [ ] No `unwrap()`/`expect()` in Rust production code
- [ ] No `any` in TypeScript
- [ ] No `console.log` — use structured logging
- [ ] No direct Supabase data access from client — use API client
- [ ] `throwOnError: true` on all SDK calls
