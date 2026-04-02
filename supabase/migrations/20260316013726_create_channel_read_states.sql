-- =============================================================
-- Migration: create_channel_read_states
-- Creates: channel_read_states table (forward-compatible, no API yet)
-- =============================================================

CREATE TABLE IF NOT EXISTS public.channel_read_states (
    channel_id      UUID NOT NULL REFERENCES public.channels(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    last_read_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_message_id UUID REFERENCES public.messages(id) ON DELETE SET NULL,

    PRIMARY KEY (channel_id, user_id)
);

-- RLS: user can SELECT/UPSERT their own read states
ALTER TABLE public.channel_read_states ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE policyname = 'channel_read_states_select_own' AND tablename = 'channel_read_states'
    ) THEN
        CREATE POLICY channel_read_states_select_own ON public.channel_read_states
            FOR SELECT USING (user_id = auth.uid());
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE policyname = 'channel_read_states_insert_own' AND tablename = 'channel_read_states'
    ) THEN
        CREATE POLICY channel_read_states_insert_own ON public.channel_read_states
            FOR INSERT WITH CHECK (user_id = auth.uid());
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE policyname = 'channel_read_states_update_own' AND tablename = 'channel_read_states'
    ) THEN
        CREATE POLICY channel_read_states_update_own ON public.channel_read_states
            FOR UPDATE USING (user_id = auth.uid());
    END IF;
END $$;
