-- =============================================================
-- Migration: rls_normalize_roles
-- Normalizes all remaining policies to TO authenticated.
--
-- WHY: After rls_hardening revoked all anon grants, policies
-- with roles={public} are functionally safe but inconsistent.
-- Explicit TO authenticated is defense-in-depth: if a future
-- migration accidentally re-grants anon access, these policies
-- won't silently apply to unauthenticated requests.
--
-- Also adds the missing membership check on channel_read_states
-- SELECT (was flagged as inconsistent with INSERT/UPDATE).
-- =============================================================

-- ─────────────────────────────────────────────────────────────
-- profiles: INSERT, UPDATE → TO authenticated
-- ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS profiles_insert_own ON public.profiles;
CREATE POLICY profiles_insert_own ON public.profiles
    FOR INSERT TO authenticated
    WITH CHECK (id = auth.uid());

DROP POLICY IF EXISTS profiles_update_own ON public.profiles;
CREATE POLICY profiles_update_own ON public.profiles
    FOR UPDATE TO authenticated
    USING (id = auth.uid());

-- ─────────────────────────────────────────────────────────────
-- servers: SELECT → TO authenticated
-- ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS servers_select_member ON public.servers;
CREATE POLICY servers_select_member ON public.servers
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.server_members sm
            WHERE sm.server_id = servers.id
            AND sm.user_id = auth.uid()
        )
    );

-- ─────────────────────────────────────────────────────────────
-- server_members: SELECT → TO authenticated
-- ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS server_members_select_member ON public.server_members;
CREATE POLICY server_members_select_member ON public.server_members
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.server_members sm
            WHERE sm.server_id = server_members.server_id
            AND sm.user_id = auth.uid()
        )
    );

-- ─────────────────────────────────────────────────────────────
-- channels: SELECT, INSERT → TO authenticated
-- ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS channels_select_member ON public.channels;
CREATE POLICY channels_select_member ON public.channels
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.server_members sm
            WHERE sm.server_id = channels.server_id
            AND sm.user_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS channels_insert_member ON public.channels;
CREATE POLICY channels_insert_member ON public.channels
    FOR INSERT TO authenticated
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.server_members sm
            WHERE sm.server_id = channels.server_id
            AND sm.user_id = auth.uid()
        )
    );

-- ─────────────────────────────────────────────────────────────
-- messages: INSERT, UPDATE (author) → TO authenticated
-- ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS messages_insert_member ON public.messages;
CREATE POLICY messages_insert_member ON public.messages
    FOR INSERT TO authenticated
    WITH CHECK (
        author_id = auth.uid()
        AND EXISTS (
            SELECT 1 FROM public.server_members sm
            JOIN public.channels c ON c.server_id = sm.server_id
            WHERE c.id = messages.channel_id
            AND sm.user_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS messages_update_author ON public.messages;
CREATE POLICY messages_update_author ON public.messages
    FOR UPDATE TO authenticated
    USING (author_id = auth.uid() AND deleted_at IS NULL)
    WITH CHECK (author_id = auth.uid());

-- ─────────────────────────────────────────────────────────────
-- message_reactions: SELECT, INSERT → TO authenticated
-- ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS message_reactions_select_member ON public.message_reactions;
CREATE POLICY message_reactions_select_member ON public.message_reactions
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.server_members sm
            JOIN public.channels c ON c.server_id = sm.server_id
            JOIN public.messages m ON m.channel_id = c.id
            WHERE m.id = message_reactions.message_id
            AND sm.user_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS message_reactions_insert_own ON public.message_reactions;
CREATE POLICY message_reactions_insert_own ON public.message_reactions
    FOR INSERT TO authenticated
    WITH CHECK (
        user_id = auth.uid()
        AND EXISTS (
            SELECT 1 FROM public.server_members sm
            JOIN public.channels c ON c.server_id = sm.server_id
            JOIN public.messages m ON m.channel_id = c.id
            WHERE m.id = message_reactions.message_id
            AND sm.user_id = auth.uid()
        )
    );

-- ─────────────────────────────────────────────────────────────
-- channel_read_states: SELECT → TO authenticated + membership
-- ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS channel_read_states_select_own ON public.channel_read_states;
CREATE POLICY channel_read_states_select_own ON public.channel_read_states
    FOR SELECT TO authenticated
    USING (
        user_id = auth.uid()
        AND EXISTS (
            SELECT 1 FROM public.server_members sm
            JOIN public.channels c ON c.server_id = sm.server_id
            WHERE c.id = channel_read_states.channel_id
            AND sm.user_id = auth.uid()
        )
    );

-- ─────────────────────────────────────────────────────────────
-- invites: SELECT, INSERT, DELETE → TO authenticated
-- ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS invites_select_member ON public.invites;
CREATE POLICY invites_select_member ON public.invites
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.server_members sm
            WHERE sm.server_id = invites.server_id
            AND sm.user_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS invites_insert_member ON public.invites;
CREATE POLICY invites_insert_member ON public.invites
    FOR INSERT TO authenticated
    WITH CHECK (
        creator_id = auth.uid()
        AND EXISTS (
            SELECT 1 FROM public.server_members sm
            WHERE sm.server_id = invites.server_id
            AND sm.user_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS invites_delete_owner_or_creator ON public.invites;
CREATE POLICY invites_delete_owner_or_creator ON public.invites
    FOR DELETE TO authenticated
    USING (
        creator_id = auth.uid()
        OR EXISTS (
            SELECT 1 FROM public.servers s
            WHERE s.id = invites.server_id
            AND s.owner_id = auth.uid()
        )
    );
