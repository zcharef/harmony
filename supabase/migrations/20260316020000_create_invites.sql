-- =============================================================
-- Migration: create_invites
-- Creates: invites table for server invite links
-- =============================================================

CREATE TABLE IF NOT EXISTS public.invites (
    code        TEXT PRIMARY KEY,
    server_id   UUID NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
    creator_id  UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    max_uses    INT,                               -- NULL = unlimited
    use_count   INT NOT NULL DEFAULT 0,
    expires_at  TIMESTAMPTZ,                       -- NULL = never
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT invites_code_format CHECK (code ~ '^[a-zA-Z0-9]{6,12}$')
);

CREATE INDEX IF NOT EXISTS idx_invites_server ON public.invites (server_id);

-- RLS: policy-based access control
ALTER TABLE public.invites ENABLE ROW LEVEL SECURITY;

-- SELECT: authenticated server members can view invites for their servers
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE policyname = 'invites_select_member' AND tablename = 'invites'
    ) THEN
        CREATE POLICY invites_select_member ON public.invites
            FOR SELECT USING (
                EXISTS (
                    SELECT 1 FROM public.server_members sm
                    WHERE sm.server_id = invites.server_id
                    AND sm.user_id = auth.uid()
                )
            );
    END IF;
END $$;

-- INSERT: server members can create invites
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE policyname = 'invites_insert_member' AND tablename = 'invites'
    ) THEN
        CREATE POLICY invites_insert_member ON public.invites
            FOR INSERT WITH CHECK (
                creator_id = auth.uid()
                AND EXISTS (
                    SELECT 1 FROM public.server_members sm
                    WHERE sm.server_id = invites.server_id
                    AND sm.user_id = auth.uid()
                )
            );
    END IF;
END $$;

-- DELETE: server owner or invite creator can revoke
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE policyname = 'invites_delete_owner_or_creator' AND tablename = 'invites'
    ) THEN
        CREATE POLICY invites_delete_owner_or_creator ON public.invites
            FOR DELETE USING (
                creator_id = auth.uid()
                OR EXISTS (
                    SELECT 1 FROM public.servers s
                    WHERE s.id = invites.server_id
                    AND s.owner_id = auth.uid()
                )
            );
    END IF;
END $$;
