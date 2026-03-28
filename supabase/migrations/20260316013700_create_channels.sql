-- =============================================================
-- Migration: create_channels
-- Creates: channel_type enum, channels table
-- =============================================================

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'channel_type') THEN
        CREATE TYPE channel_type AS ENUM ('text', 'voice', 'forum');
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.channels (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id        UUID NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
    name             TEXT NOT NULL,
    topic            TEXT,
    channel_type     channel_type NOT NULL DEFAULT 'text',
    position         INT NOT NULL DEFAULT 0,
    is_nsfw          BOOLEAN NOT NULL DEFAULT false,
    slowmode_seconds INT NOT NULL DEFAULT 0,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT channels_name_format CHECK (name ~ '^[a-z0-9-]{1,100}$')
);

CREATE INDEX IF NOT EXISTS idx_channels_server ON public.channels (server_id);

-- RLS: members can see channels in their servers
ALTER TABLE public.channels ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE policyname = 'channels_select_member' AND tablename = 'channels'
    ) THEN
        CREATE POLICY channels_select_member ON public.channels
            FOR SELECT USING (
                EXISTS (
                    SELECT 1 FROM public.server_members sm
                    WHERE sm.server_id = channels.server_id
                    AND sm.user_id = auth.uid()
                )
            );
    END IF;
END $$;

-- Members can create channels in servers they belong to
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE policyname = 'channels_insert_member' AND tablename = 'channels'
    ) THEN
        CREATE POLICY channels_insert_member ON public.channels
            FOR INSERT WITH CHECK (
                EXISTS (
                    SELECT 1 FROM public.server_members sm
                    WHERE sm.server_id = channels.server_id
                    AND sm.user_id = auth.uid()
                )
            );
    END IF;
END $$;
