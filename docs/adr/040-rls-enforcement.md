# ADR-040: RLS Enforcement on All Tables

**Status:** Accepted
**Date:** 2026-03-16

## Context

A `CREATE TABLE` without `ENABLE ROW LEVEL SECURITY` leaves the table wide open:

```sql
-- BAD: table created without RLS — any authenticated user can read/write all rows
CREATE TABLE IF NOT EXISTS direct_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_id UUID NOT NULL REFERENCES users(id),
    recipient_id UUID NOT NULL REFERENCES users(id),
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Forgot ALTER TABLE direct_messages ENABLE ROW LEVEL SECURITY;
-- Result: any Supabase client can read ALL direct messages for ALL users.
-- This is a data breach, not a bug.
```

PostgreSQL RLS is **disabled by default** on new tables. Without explicit enablement, the table has no row-level access control even if policies exist on other tables. A single forgotten `ENABLE ROW LEVEL SECURITY` statement is a data leak.

## Decision

Every migration that creates a table **must** immediately enable RLS on that table:

```sql
-- GOOD: RLS enabled immediately after table creation
CREATE TABLE IF NOT EXISTS direct_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_id UUID NOT NULL REFERENCES users(id),
    recipient_id UUID NOT NULL REFERENCES users(id),
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE direct_messages ENABLE ROW LEVEL SECURITY;

-- Policies define who can access which rows
CREATE POLICY "Users can read their own DMs"
    ON direct_messages
    FOR SELECT
    USING (auth.uid() = sender_id OR auth.uid() = recipient_id);

CREATE POLICY "Users can send DMs"
    ON direct_messages
    FOR INSERT
    WITH CHECK (auth.uid() = sender_id);
```

**Rule:** `CREATE TABLE` and `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` must appear in the same migration file. A table must never exist, even briefly, without RLS enabled.

## Consequences

**Positive:**
- No table is ever accessible without row-level policies
- Defense in depth — even if application-level authorization has a bug, RLS prevents data leaks
- Supabase client queries are always filtered by RLS policies
- New developers cannot accidentally create unprotected tables

**Negative:**
- Every table needs at least one RLS policy to be usable (tables with RLS enabled but no policies deny all access by default — this is the safe default)
- Service role connections bypass RLS — the API must use service role only for operations that genuinely need cross-user access
- Debugging query failures requires checking both application logic and RLS policies

## Enforcement

- **Migration linter:** Scans migration files for `CREATE TABLE` statements and verifies a matching `ENABLE ROW LEVEL SECURITY` exists in the same file — fails if unpaired
- **CI:** `supabase db reset` applies all migrations; a subsequent check verifies RLS is enabled on every table in the `public` schema
- **Code review:** Migration PRs require explicit verification that RLS is enabled and at least one policy is defined
