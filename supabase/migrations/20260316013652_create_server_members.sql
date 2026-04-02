-- =============================================================
-- Migration: create_server_members
-- Creates: server_members junction table
-- Also adds deferred servers SELECT policy (needs server_members)
-- =============================================================

CREATE TABLE IF NOT EXISTS public.server_members (
    server_id   UUID NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    nickname    TEXT,
    joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    muted       BOOLEAN NOT NULL DEFAULT false,

    PRIMARY KEY (server_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_server_members_user ON public.server_members (user_id);

-- RLS: members can see memberships for servers they belong to
ALTER TABLE public.server_members ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE policyname = 'server_members_select_member' AND tablename = 'server_members'
    ) THEN
        CREATE POLICY server_members_select_member ON public.server_members
            FOR SELECT USING (
                EXISTS (
                    SELECT 1 FROM public.server_members sm
                    WHERE sm.server_id = server_members.server_id
                    AND sm.user_id = auth.uid()
                )
            );
    END IF;
END $$;

-- Members can insert themselves (join a server)
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE policyname = 'server_members_insert_own' AND tablename = 'server_members'
    ) THEN
        CREATE POLICY server_members_insert_own ON public.server_members
            FOR INSERT WITH CHECK (user_id = auth.uid());
    END IF;
END $$;

-- Deferred: servers SELECT policy (now that server_members exists)
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE policyname = 'servers_select_member' AND tablename = 'servers'
    ) THEN
        CREATE POLICY servers_select_member ON public.servers
            FOR SELECT USING (
                EXISTS (
                    SELECT 1 FROM public.server_members sm
                    WHERE sm.server_id = id
                    AND sm.user_id = auth.uid()
                )
            );
    END IF;
END $$;
