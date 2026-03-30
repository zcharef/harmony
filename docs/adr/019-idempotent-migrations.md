# ADR-019: Idempotent & Non-Destructive Migrations

**Status:** Accepted
**Date:** 2026-03-16

## Context

Destructive migrations cause irreversible data loss and break rolling deployments:

```sql
-- BAD: destroys data, cannot be undone
DROP COLUMN display_name;
DROP TABLE audit_logs;
ALTER TABLE users ALTER COLUMN email TYPE TEXT; -- locks table, breaks running queries
ALTER TABLE users RENAME COLUMN name TO display_name; -- breaks old app versions
```

In a rolling deployment, the old application version is still running when the migration executes. A `DROP COLUMN` removes data that the old version is actively reading. A `RENAME COLUMN` breaks every query referencing the old name.

Non-idempotent migrations fail on re-run:

```sql
-- BAD: fails if table already exists (e.g., migration re-run after partial failure)
CREATE TABLE channels (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL
);
```

## Decision

All migrations must be **idempotent** and **non-destructive**.

**Idempotent:** Every DDL statement uses `IF NOT EXISTS` / `IF EXISTS` guards:

```sql
-- GOOD: safe to re-run
CREATE TABLE IF NOT EXISTS channels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_channels_server_id ON channels (server_id);

ALTER TABLE channels ADD COLUMN IF NOT EXISTS description TEXT;
```

**Non-destructive:** The following are **banned** in migrations:
- `DROP COLUMN`
- `DROP TABLE`
- `ALTER TYPE` (changing column types)
- `RENAME COLUMN` / `RENAME TABLE`

**Breaking changes use a 2-migration strategy:**
1. **Migration 1:** Add the new column/table, backfill data, update application code to write to both old and new
2. **Migration 2 (after full deployment):** Stop writing to the old column (but never drop it — data archaeology value)

**Naming convention:** `YYYYMMDDHHMMSS_description.sql`
```
20260316120000_create_channels_table.sql
20260316120100_add_topic_to_channels.sql
```

## Consequences

**Positive:**
- Migrations are safe to re-run after partial failures
- Rolling deployments never break — old app version continues to work during migration
- Data is never destroyed — can always be recovered or audited
- `supabase db reset` works reliably in CI and local development

**Negative:**
- Unused columns accumulate over time (acceptable — storage is cheap, data loss is not)
- Breaking changes require two deployments instead of one
- Developers must think through the migration sequence for schema changes

## Enforcement

- **Migration linter script:** Scans migration files for banned patterns (`DROP COLUMN`, `DROP TABLE`, `ALTER TYPE`, `RENAME COLUMN`, `RENAME TABLE`) and missing `IF NOT EXISTS` on `CREATE TABLE`
- **CI:** `supabase db reset` runs on every PR — validates all migrations apply cleanly from scratch
- **Code review:** Migration PRs require explicit sign-off that the 2-migration strategy was followed for breaking changes
