-- =============================================================
-- Migration: fix_moderator_softdelete_with_check
--
-- WHY: Two bugs prevent moderator soft-delete from working via RLS.
--
-- BUG 1 (SELECT policy blocks UPDATE):
--   PostgreSQL requires the NEW row to satisfy SELECT policies
--   during UPDATE. The messages SELECT policy has "deleted_at IS
--   NULL". When a moderator sets deleted_at = now(), the NEW row
--   violates the SELECT policy → rejected.
--
--   FIX: Allow moderator+ to see messages regardless of deleted_at,
--   so the soft-delete UPDATE's NEW row remains visible.
--
-- BUG 2 (WITH CHECK subquery blocked by RLS):
--   The WITH CHECK subquery on messages_update_moderator_softdelete
--   runs under RLS. When the NEW row has deleted_at set, the SELECT
--   policy filters the row from the subquery, returning NULL.
--
--   FIX: Use a SECURITY DEFINER helper that bypasses RLS.
--
-- Note: The API uses service_role (bypasses RLS), so these bugs
-- only affect Realtime/PowerSync clients. Fixed for defense-in-depth.
-- =============================================================


-- ─────────────────────────────────────────────────────────────
-- FIX 1: messages SELECT — allow moderator+ to see deleted msgs
--
-- WHY: Moderators need to soft-delete messages via UPDATE. PG
-- requires the NEW row (with deleted_at set) to pass SELECT policy.
-- Without this, any UPDATE that sets deleted_at is blocked.
--
-- Impact: Moderators see deleted message tombstones in Realtime.
-- The frontend already renders these as "[Message removed by
-- moderator]" (message-item.tsx).
-- ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS messages_select_member ON public.messages;
CREATE POLICY messages_select_member ON public.messages
    FOR SELECT TO authenticated
    USING (
        is_channel_member(channel_id)
        AND (
            deleted_at IS NULL
            OR public.has_server_role(
                (SELECT c.server_id FROM public.channels c WHERE c.id = messages.channel_id),
                'moderator'
            )
        )
    );


-- ─────────────────────────────────────────────────────────────
-- FIX 2: Helper for WITH CHECK — bypass RLS circular dependency
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_message_author_id(p_message_id UUID)
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT author_id FROM public.messages WHERE id = p_message_id;
$$;


-- ─────────────────────────────────────────────────────────────
-- FIX 2: Recreate moderator softdelete policy with fixed WITH CHECK
-- ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS messages_update_moderator_softdelete ON public.messages;
CREATE POLICY messages_update_moderator_softdelete ON public.messages
    FOR UPDATE TO authenticated
    USING (
        public.has_server_role(
            (SELECT c.server_id FROM public.channels c WHERE c.id = messages.channel_id),
            'moderator'
        )
    )
    WITH CHECK (
        author_id = public.get_message_author_id(id)
    );
