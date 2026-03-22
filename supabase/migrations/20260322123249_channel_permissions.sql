-- =============================================================
-- Migration: channel_permissions (Phase 2)
--
-- WHY: Adds private channel and read-only channel support.
-- Private channels restrict visibility to specific roles.
-- Read-only channels restrict message posting to admin+.
--
-- The is_channel_member() SECURITY DEFINER is the single gate:
-- all downstream RLS policies that call it automatically
-- respect private channel access without any changes.
-- =============================================================


-- ─────────────────────────────────────────────────────────────
-- 1. Add columns to channels table
-- WHY: is_private controls visibility gating via is_channel_member().
--      is_read_only controls write gating in messages INSERT policy.
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.channels
    ADD COLUMN IF NOT EXISTS is_private BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.channels
    ADD COLUMN IF NOT EXISTS is_read_only BOOLEAN NOT NULL DEFAULT false;


-- ─────────────────────────────────────────────────────────────
-- 2. Create channel_role_access table
-- WHY: When a channel is private, this table lists which additional
-- roles (beyond owner/admin who always have implicit access) can
-- see and post in the channel. Only consulted when is_private = true.
-- Owner and admin are never stored here — they have implicit access.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.channel_role_access (
    channel_id UUID NOT NULL REFERENCES public.channels(id) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK (role IN ('admin', 'moderator', 'member')),
    PRIMARY KEY (channel_id, role)
);


-- ─────────────────────────────────────────────────────────────
-- 3. RLS for channel_role_access
-- WHY: Only admin+ should view or manage channel access rules.
-- Defense-in-depth — the API is the primary enforcer.
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.channel_role_access ENABLE ROW LEVEL SECURITY;

CREATE POLICY channel_role_access_select_admin ON public.channel_role_access
    FOR SELECT TO authenticated
    USING (
        public.has_server_role(
            (SELECT c.server_id FROM public.channels c WHERE c.id = channel_role_access.channel_id),
            'admin'
        )
    );

CREATE POLICY channel_role_access_insert_admin ON public.channel_role_access
    FOR INSERT TO authenticated
    WITH CHECK (
        public.has_server_role(
            (SELECT c.server_id FROM public.channels c WHERE c.id = channel_role_access.channel_id),
            'admin'
        )
    );

CREATE POLICY channel_role_access_update_admin ON public.channel_role_access
    FOR UPDATE TO authenticated
    USING (
        public.has_server_role(
            (SELECT c.server_id FROM public.channels c WHERE c.id = channel_role_access.channel_id),
            'admin'
        )
    );

CREATE POLICY channel_role_access_delete_admin ON public.channel_role_access
    FOR DELETE TO authenticated
    USING (
        public.has_server_role(
            (SELECT c.server_id FROM public.channels c WHERE c.id = channel_role_access.channel_id),
            'admin'
        )
    );


-- ─────────────────────────────────────────────────────────────
-- 4. Update is_channel_member() SECURITY DEFINER
-- WHY: This is the KEY change. All downstream policies that call
-- is_channel_member() automatically respect private channels.
--
-- Logic:
--   - If channel is NOT private: existing behavior (server membership)
--   - If channel IS private: server membership AND
--     (user role >= admin OR user's role is in channel_role_access)
--
-- Pattern: same as existing is_channel_member() from
-- 20260317000000_normalize_rls_helpers.sql:L26-L40
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.is_channel_member(p_channel_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.channels c
        JOIN public.server_members sm ON sm.server_id = c.server_id
        WHERE c.id = p_channel_id
          AND sm.user_id = auth.uid()
          AND (
              c.is_private = false
              OR public.get_role_level(sm.role) >= public.get_role_level('admin')
              OR EXISTS (
                  SELECT 1 FROM public.channel_role_access cra
                  WHERE cra.channel_id = c.id
                    AND cra.role = sm.role
              )
          )
    );
$$;


-- ─────────────────────────────────────────────────────────────
-- 5. Add channel_role_access to Supabase Realtime publication
-- WHY: Clients need to receive access rule changes in real time
-- so the UI can update channel visibility without a full refresh.
-- ─────────────────────────────────────────────────────────────
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND tablename = 'channel_role_access'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.channel_role_access;
    END IF;
END $$;
