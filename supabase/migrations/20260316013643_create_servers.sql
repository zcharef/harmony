-- =============================================================
-- Migration: create_servers
-- Creates: servers table with is_dm forward-compat column
-- Note: member-based SELECT policy added after server_members exists
-- =============================================================

CREATE TABLE IF NOT EXISTS public.servers (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name          TEXT NOT NULL,
    description   TEXT,
    icon_url      TEXT,
    owner_id      UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
    is_public     BOOLEAN NOT NULL DEFAULT false,
    is_dm         BOOLEAN NOT NULL DEFAULT false,  -- DM forward-compat
    member_count  INT NOT NULL DEFAULT 1,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT servers_name_length CHECK (char_length(name) BETWEEN 2 AND 100)
);

CREATE INDEX IF NOT EXISTS idx_servers_owner ON public.servers (owner_id);

-- Auto-update updated_at on row change
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_servers_updated_at'
    ) THEN
        CREATE TRIGGER trg_servers_updated_at
            BEFORE UPDATE ON public.servers
            FOR EACH ROW
            EXECUTE FUNCTION public.set_updated_at();
    END IF;
END $$;

-- RLS enabled; SELECT policy added in create_server_members migration
ALTER TABLE public.servers ENABLE ROW LEVEL SECURITY;

-- Authenticated users can create servers
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE policyname = 'servers_insert_authenticated' AND tablename = 'servers'
    ) THEN
        CREATE POLICY servers_insert_authenticated ON public.servers
            FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
    END IF;
END $$;
