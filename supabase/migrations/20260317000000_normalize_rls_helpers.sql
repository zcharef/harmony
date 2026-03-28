-- =============================================================
-- Migration: normalize_rls_helpers
--
-- WHY: After the recursion fix (015000) introduced is_server_member(),
-- later migrations (030000, 031000, 140000) continued using raw
-- EXISTS subqueries against server_members. This causes:
--   1. Unnecessary double-RLS evaluation (perf hit)
--   2. Violated "One Pattern Per Concern" — two ways to check membership
--   3. Risk of re-introducing recursion if server_members policy changes
--
-- FIX: Normalize ALL membership-check policies to use SECURITY DEFINER
-- helpers. Introduces is_channel_member() for channel-scoped checks.
--
-- Also fixes:
--   - enable_realtime idempotency (ALTER PUBLICATION fails on re-run)
--   - Missing documentation on invites UPDATE (service_role only)
-- =============================================================


-- ─────────────────────────────────────────────────────────────
-- 1. New helper: is_channel_member(channel_id)
--    WHY: Many policies (messages, read_states, reactions) need
--    channel-scoped membership. Without this, they JOIN channels
--    → server_members, triggering RLS on both tables.
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
    );
$$;


-- ─────────────────────────────────────────────────────────────
-- 2. Fix enable_realtime idempotency
--    WHY: ALTER PUBLICATION ... ADD TABLE fails if already added.
-- ─────────────────────────────────────────────────────────────
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND tablename = 'messages'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
    END IF;
END $$;


-- ─────────────────────────────────────────────────────────────
-- 3. Fix: server_members SELECT (re-broken by 031000)
--    WHY: 031000 re-introduced the self-referencing EXISTS subquery
--    that 015000 had fixed. This causes infinite RLS recursion,
--    making Supabase Realtime silently drop all message events.
-- ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS server_members_select_member ON public.server_members;
CREATE POLICY server_members_select_member ON public.server_members
    FOR SELECT TO authenticated
    USING (public.is_server_member(server_id));


-- ─────────────────────────────────────────────────────────────
-- 5. Normalize: servers SELECT
-- ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS servers_select_member ON public.servers;
CREATE POLICY servers_select_member ON public.servers
    FOR SELECT TO authenticated
    USING (public.is_server_member(id));


-- ─────────────────────────────────────────────────────────────
-- 6. Normalize: channels SELECT, INSERT, UPDATE, DELETE
-- ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS channels_select_member ON public.channels;
CREATE POLICY channels_select_member ON public.channels
    FOR SELECT TO authenticated
    USING (public.is_server_member(server_id));

DROP POLICY IF EXISTS channels_insert_member ON public.channels;
CREATE POLICY channels_insert_member ON public.channels
    FOR INSERT TO authenticated
    WITH CHECK (public.is_server_member(server_id));

DROP POLICY IF EXISTS channels_update_member ON public.channels;
CREATE POLICY channels_update_member ON public.channels
    FOR UPDATE TO authenticated
    USING (public.is_server_member(server_id));

DROP POLICY IF EXISTS channels_delete_member ON public.channels;
CREATE POLICY channels_delete_member ON public.channels
    FOR DELETE TO authenticated
    USING (public.is_server_member(server_id));


-- ─────────────────────────────────────────────────────────────
-- 7. Normalize: messages SELECT, INSERT
-- ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS messages_select_member ON public.messages;
CREATE POLICY messages_select_member ON public.messages
    FOR SELECT TO authenticated
    USING (
        deleted_at IS NULL
        AND public.is_channel_member(channel_id)
    );

DROP POLICY IF EXISTS messages_insert_member ON public.messages;
CREATE POLICY messages_insert_member ON public.messages
    FOR INSERT TO authenticated
    WITH CHECK (
        author_id = auth.uid()
        AND public.is_channel_member(channel_id)
    );


-- ─────────────────────────────────────────────────────────────
-- 8. Normalize: invites SELECT, INSERT
-- ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS invites_select_member ON public.invites;
CREATE POLICY invites_select_member ON public.invites
    FOR SELECT TO authenticated
    USING (public.is_server_member(server_id));

DROP POLICY IF EXISTS invites_insert_member ON public.invites;
CREATE POLICY invites_insert_member ON public.invites
    FOR INSERT TO authenticated
    WITH CHECK (
        creator_id = auth.uid()
        AND public.is_server_member(server_id)
    );

-- WHY no invites UPDATE policy: invite redemption (incrementing use_count)
-- is handled by the API via service_role, not by client-side RLS.


-- ─────────────────────────────────────────────────────────────
-- 9. Normalize: channel_read_states SELECT, INSERT, UPDATE
-- ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS channel_read_states_select_own ON public.channel_read_states;
CREATE POLICY channel_read_states_select_own ON public.channel_read_states
    FOR SELECT TO authenticated
    USING (
        user_id = auth.uid()
        AND public.is_channel_member(channel_id)
    );

DROP POLICY IF EXISTS channel_read_states_insert_own ON public.channel_read_states;
CREATE POLICY channel_read_states_insert_own ON public.channel_read_states
    FOR INSERT TO authenticated
    WITH CHECK (
        user_id = auth.uid()
        AND public.is_channel_member(channel_id)
    );

DROP POLICY IF EXISTS channel_read_states_update_own ON public.channel_read_states;
CREATE POLICY channel_read_states_update_own ON public.channel_read_states
    FOR UPDATE TO authenticated
    USING (
        user_id = auth.uid()
        AND public.is_channel_member(channel_id)
    );


-- ─────────────────────────────────────────────────────────────
-- 10. Normalize: message_reactions SELECT, INSERT, DELETE
-- ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS message_reactions_select_member ON public.message_reactions;
CREATE POLICY message_reactions_select_member ON public.message_reactions
    FOR SELECT TO authenticated
    USING (
        public.is_channel_member(
            (SELECT m.channel_id FROM public.messages m WHERE m.id = message_reactions.message_id)
        )
    );

DROP POLICY IF EXISTS message_reactions_insert_own ON public.message_reactions;
CREATE POLICY message_reactions_insert_own ON public.message_reactions
    FOR INSERT TO authenticated
    WITH CHECK (
        user_id = auth.uid()
        AND public.is_channel_member(
            (SELECT m.channel_id FROM public.messages m WHERE m.id = message_reactions.message_id)
        )
    );

DROP POLICY IF EXISTS message_reactions_delete_own ON public.message_reactions;
CREATE POLICY message_reactions_delete_own ON public.message_reactions
    FOR DELETE TO authenticated
    USING (
        user_id = auth.uid()
        AND public.is_channel_member(
            (SELECT m.channel_id FROM public.messages m WHERE m.id = message_reactions.message_id)
        )
    );
