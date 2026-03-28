-- =============================================================
-- Migration: rls_hardening
-- Fixes all RLS audit findings across 9 tables.
--
-- Changes (by severity):
--
-- CRITICAL:
--   C1 - servers INSERT: enforce owner_id = auth.uid()
--   C2 - server_members INSERT: drop self-join policy (API-only)
--   C3 - anon lockout: revoke anon on all public tables,
--        replace profiles_select_all with authenticated-only
--
-- HIGH:
--   H1 - messages SELECT: hide soft-deleted rows
--   H2a - servers UPDATE: owner only
--   H2b - servers DELETE: owner only
--   H2d - messages UPDATE: owner can soft-delete any message
--   H2e - channels UPDATE: server owner only
--   H2f - channels DELETE: server owner only
--   H2g - server_members UPDATE: own row only
--   H2h - server_members DELETE: self-leave
--   H2i - server_members DELETE: owner can kick (not self)
--
-- MEDIUM:
--   M1 - channel_read_states INSERT/UPDATE: add membership check
--   M2 - message_reactions DELETE: add membership check
--
-- NOTE: messages_update_author (H2c) already exists in
--       20260316014000_messages_update_delete_rls.sql — not touched.
-- =============================================================

-- ─────────────────────────────────────────────────────────────
-- C3: Revoke anon access on all public tables
-- ─────────────────────────────────────────────────────────────
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;

-- ─────────────────────────────────────────────────────────────
-- C3: Replace profiles_select_all (open to all roles, USING(true))
--     with authenticated-only version
-- ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS profiles_select_all ON public.profiles;

CREATE POLICY profiles_select_authenticated ON public.profiles
    FOR SELECT TO authenticated
    USING (true);

-- ─────────────────────────────────────────────────────────────
-- C1: servers INSERT — enforce owner_id = auth.uid()
-- ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS servers_insert_authenticated ON public.servers;

CREATE POLICY servers_insert_authenticated ON public.servers
    FOR INSERT TO authenticated
    WITH CHECK (owner_id = auth.uid());

-- ─────────────────────────────────────────────────────────────
-- C2: Drop self-join policy (joins are API-only via service_role)
-- ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS server_members_insert_own ON public.server_members;

-- ─────────────────────────────────────────────────────────────
-- H1: messages SELECT — hide soft-deleted rows
-- ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS messages_select_member ON public.messages;

CREATE POLICY messages_select_member ON public.messages
    FOR SELECT TO authenticated
    USING (
        deleted_at IS NULL
        AND EXISTS (
            SELECT 1 FROM public.server_members sm
            JOIN public.channels c ON c.server_id = sm.server_id
            WHERE c.id = messages.channel_id
            AND sm.user_id = auth.uid()
        )
    );

-- ─────────────────────────────────────────────────────────────
-- H2a: servers UPDATE — owner only
-- ─────────────────────────────────────────────────────────────
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE policyname = 'servers_update_owner' AND tablename = 'servers'
    ) THEN
        CREATE POLICY servers_update_owner ON public.servers
            FOR UPDATE TO authenticated
            USING (owner_id = auth.uid());
    END IF;
END $$;

-- ─────────────────────────────────────────────────────────────
-- H2b: servers DELETE — owner only
-- ─────────────────────────────────────────────────────────────
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE policyname = 'servers_delete_owner' AND tablename = 'servers'
    ) THEN
        CREATE POLICY servers_delete_owner ON public.servers
            FOR DELETE TO authenticated
            USING (owner_id = auth.uid());
    END IF;
END $$;

-- ─────────────────────────────────────────────────────────────
-- H2d: messages UPDATE — server owner can soft-delete any message
--      (permissive; Postgres ORs this with messages_update_author)
-- ─────────────────────────────────────────────────────────────
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE policyname = 'messages_update_owner_softdelete' AND tablename = 'messages'
    ) THEN
        CREATE POLICY messages_update_owner_softdelete ON public.messages
            FOR UPDATE TO authenticated
            USING (
                EXISTS (
                    SELECT 1 FROM public.channels c
                    JOIN public.servers s ON s.id = c.server_id
                    WHERE c.id = messages.channel_id
                    AND s.owner_id = auth.uid()
                )
            );
    END IF;
END $$;

-- ─────────────────────────────────────────────────────────────
-- H2e: channels UPDATE — server owner only
-- ─────────────────────────────────────────────────────────────
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE policyname = 'channels_update_owner' AND tablename = 'channels'
    ) THEN
        CREATE POLICY channels_update_owner ON public.channels
            FOR UPDATE TO authenticated
            USING (
                EXISTS (
                    SELECT 1 FROM public.servers s
                    WHERE s.id = channels.server_id
                    AND s.owner_id = auth.uid()
                )
            );
    END IF;
END $$;

-- ─────────────────────────────────────────────────────────────
-- H2f: channels DELETE — server owner only
-- ─────────────────────────────────────────────────────────────
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE policyname = 'channels_delete_owner' AND tablename = 'channels'
    ) THEN
        CREATE POLICY channels_delete_owner ON public.channels
            FOR DELETE TO authenticated
            USING (
                EXISTS (
                    SELECT 1 FROM public.servers s
                    WHERE s.id = channels.server_id
                    AND s.owner_id = auth.uid()
                )
            );
    END IF;
END $$;

-- ─────────────────────────────────────────────────────────────
-- H2g: server_members UPDATE — own row only (nickname, muted)
-- ─────────────────────────────────────────────────────────────
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE policyname = 'server_members_update_own' AND tablename = 'server_members'
    ) THEN
        CREATE POLICY server_members_update_own ON public.server_members
            FOR UPDATE TO authenticated
            USING (user_id = auth.uid());
    END IF;
END $$;

-- ─────────────────────────────────────────────────────────────
-- H2h: server_members DELETE — user can leave (self)
-- ─────────────────────────────────────────────────────────────
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE policyname = 'server_members_delete_own' AND tablename = 'server_members'
    ) THEN
        CREATE POLICY server_members_delete_own ON public.server_members
            FOR DELETE TO authenticated
            USING (user_id = auth.uid());
    END IF;
END $$;

-- ─────────────────────────────────────────────────────────────
-- H2i: server_members DELETE — owner can kick (except self)
--      (permissive; Postgres ORs this with server_members_delete_own)
-- ─────────────────────────────────────────────────────────────
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE policyname = 'server_members_delete_owner' AND tablename = 'server_members'
    ) THEN
        CREATE POLICY server_members_delete_owner ON public.server_members
            FOR DELETE TO authenticated
            USING (
                user_id != auth.uid()
                AND EXISTS (
                    SELECT 1 FROM public.servers s
                    WHERE s.id = server_members.server_id
                    AND s.owner_id = auth.uid()
                )
            );
    END IF;
END $$;

-- ─────────────────────────────────────────────────────────────
-- M1: channel_read_states INSERT/UPDATE — add membership check
-- ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS channel_read_states_insert_own ON public.channel_read_states;

CREATE POLICY channel_read_states_insert_own ON public.channel_read_states
    FOR INSERT TO authenticated
    WITH CHECK (
        user_id = auth.uid()
        AND EXISTS (
            SELECT 1 FROM public.server_members sm
            JOIN public.channels c ON c.server_id = sm.server_id
            WHERE c.id = channel_id
            AND sm.user_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS channel_read_states_update_own ON public.channel_read_states;

CREATE POLICY channel_read_states_update_own ON public.channel_read_states
    FOR UPDATE TO authenticated
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
-- M2: message_reactions DELETE — add membership check
-- ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS message_reactions_delete_own ON public.message_reactions;

CREATE POLICY message_reactions_delete_own ON public.message_reactions
    FOR DELETE TO authenticated
    USING (
        user_id = auth.uid()
        AND EXISTS (
            SELECT 1 FROM public.server_members sm
            JOIN public.channels c ON c.server_id = sm.server_id
            JOIN public.messages m ON m.channel_id = c.id
            WHERE m.id = message_reactions.message_id
            AND sm.user_id = auth.uid()
        )
    );
