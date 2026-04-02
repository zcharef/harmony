-- =============================================================
-- Migration: create_message_reactions
-- Creates: message_reactions table (forward-compatible, no API yet)
-- =============================================================

CREATE TABLE IF NOT EXISTS public.message_reactions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id  UUID NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    emoji       TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT message_reactions_unique UNIQUE (message_id, user_id, emoji),
    CONSTRAINT message_reactions_emoji_length CHECK (char_length(emoji) BETWEEN 1 AND 32)
);

CREATE INDEX IF NOT EXISTS idx_message_reactions_message ON public.message_reactions (message_id);

-- RLS: members can SELECT/INSERT/DELETE own reactions
ALTER TABLE public.message_reactions ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE policyname = 'message_reactions_select_member' AND tablename = 'message_reactions'
    ) THEN
        CREATE POLICY message_reactions_select_member ON public.message_reactions
            FOR SELECT USING (
                EXISTS (
                    SELECT 1 FROM public.server_members sm
                    JOIN public.channels c ON c.server_id = sm.server_id
                    JOIN public.messages m ON m.channel_id = c.id
                    WHERE m.id = message_reactions.message_id
                    AND sm.user_id = auth.uid()
                )
            );
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE policyname = 'message_reactions_insert_own' AND tablename = 'message_reactions'
    ) THEN
        CREATE POLICY message_reactions_insert_own ON public.message_reactions
            FOR INSERT WITH CHECK (
                user_id = auth.uid()
                AND EXISTS (
                    SELECT 1 FROM public.server_members sm
                    JOIN public.channels c ON c.server_id = sm.server_id
                    JOIN public.messages m ON m.channel_id = c.id
                    WHERE m.id = message_id
                    AND sm.user_id = auth.uid()
                )
            );
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE policyname = 'message_reactions_delete_own' AND tablename = 'message_reactions'
    ) THEN
        CREATE POLICY message_reactions_delete_own ON public.message_reactions
            FOR DELETE USING (user_id = auth.uid());
    END IF;
END $$;
