-- =============================================================
-- Migration: add_roles_to_server_members
--
-- WHY: Phase 1 Role System. Adds hierarchical roles (owner, admin,
-- moderator, member) to server_members, enabling role-based
-- authorization for moderation, channel management, and future
-- permission gates.
--
-- Hierarchy: owner(4) > admin(3) > moderator(2) > member(1)
--
-- The API (Rust handlers) is the primary enforcer of role checks.
-- The SECURITY DEFINER helpers here are defense-in-depth for
-- RLS policies and PowerSync clients.
-- =============================================================


-- ─────────────────────────────────────────────────────────────
-- 1. Add `role` column to server_members
-- ─────────────────────────────────────────────────────────────
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'server_members'
          AND column_name = 'role'
    ) THEN
        ALTER TABLE public.server_members
            ADD COLUMN role TEXT NOT NULL DEFAULT 'member';
    END IF;
END $$;

-- CHECK constraint: only valid role values
-- WHY: defense-in-depth; the API validates too, but the DB is the last line.
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.check_constraints
        WHERE constraint_name = 'server_members_role_check'
    ) THEN
        ALTER TABLE public.server_members
            ADD CONSTRAINT server_members_role_check
            CHECK (role IN ('owner', 'admin', 'moderator', 'member'));
    END IF;
END $$;


-- ─────────────────────────────────────────────────────────────
-- 2. Backfill: set role = 'owner' for server creators
-- WHY: existing members default to 'member', but the user whose
-- user_id matches servers.owner_id must be marked as 'owner'.
-- Idempotent: re-running just overwrites 'owner' with 'owner'.
-- ─────────────────────────────────────────────────────────────
UPDATE public.server_members sm
SET role = 'owner'
FROM public.servers s
WHERE sm.server_id = s.id
  AND sm.user_id = s.owner_id;


-- ─────────────────────────────────────────────────────────────
-- 3. Index for role-scoped queries
-- WHY: policies and API queries filter by (server_id, role).
-- Composite index supports both equality and range scans.
-- ─────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_server_members_server_role
    ON public.server_members (server_id, role);


-- ─────────────────────────────────────────────────────────────
-- 4. Helper: get_role_level(role_text) -> integer
-- WHY: encodes the hierarchy as integers for >= comparisons.
-- Internal helper used by has_server_role(). Kept as a separate
-- function so the hierarchy mapping is defined in exactly one place.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_role_level(p_role TEXT)
RETURNS INT
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT CASE p_role
        WHEN 'owner'     THEN 4
        WHEN 'admin'     THEN 3
        WHEN 'moderator' THEN 2
        WHEN 'member'    THEN 1
        ELSE 0
    END;
$$;


-- ─────────────────────────────────────────────────────────────
-- 5. Helper: has_server_role(server_id, min_role) -> boolean
-- WHY: single entry point for "does auth.uid() have at least
-- this role in this server?" Used by RLS policies and can be
-- called from the API for defense-in-depth checks.
--
-- Pattern: same as is_server_member() from
-- 20260316015000_fix_server_members_rls_recursion.sql:L18-L29
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.has_server_role(p_server_id UUID, p_min_role TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.server_members
        WHERE server_id = p_server_id
          AND user_id = auth.uid()
          AND public.get_role_level(role) >= public.get_role_level(p_min_role)
    );
$$;


-- ─────────────────────────────────────────────────────────────
-- 6. Add server_members to Realtime publication
-- WHY: clients need to receive role changes in real time (e.g.,
-- when a member is promoted to moderator). server_members was
-- not previously in the publication.
-- ─────────────────────────────────────────────────────────────
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND tablename = 'server_members'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.server_members;
    END IF;
END $$;
