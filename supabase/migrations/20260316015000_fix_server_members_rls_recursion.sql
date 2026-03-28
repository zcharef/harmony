-- =============================================================
-- Migration: fix_server_members_rls_recursion
-- Fixes: infinite recursion in server_members SELECT RLS policy
--
-- WHY: The server_members_select_member policy queries server_members
-- itself to check if the user is a member. When any other policy
-- (messages, channels, servers) also joins server_members, Postgres
-- applies RLS recursively: messages → server_members → server_members → ...
-- Supabase Realtime's RLS evaluator hits this and silently drops events.
--
-- FIX: A SECURITY DEFINER function bypasses RLS on the inner query,
-- breaking the cycle. All other policies that join server_members
-- benefit automatically — no changes needed to messages/channels/etc.
-- =============================================================

-- Step 1: Create a SECURITY DEFINER helper that checks membership
-- without triggering RLS on server_members.
CREATE OR REPLACE FUNCTION public.is_server_member(p_server_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.server_members
        WHERE server_id = p_server_id AND user_id = auth.uid()
    );
$$;

-- Step 2: Replace the self-referencing policy with one that uses the helper.
DROP POLICY IF EXISTS server_members_select_member ON public.server_members;

CREATE POLICY server_members_select_member ON public.server_members
    FOR SELECT USING (
        public.is_server_member(server_id)
    );
