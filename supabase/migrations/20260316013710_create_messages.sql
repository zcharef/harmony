-- =============================================================
-- Migration: create_messages
-- Creates: messages table with deleted_at for soft deletes
-- =============================================================

CREATE TABLE IF NOT EXISTS public.messages (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id  UUID NOT NULL REFERENCES public.channels(id) ON DELETE CASCADE,
    author_id   UUID NOT NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
    content     TEXT,
    reply_to_id UUID REFERENCES public.messages(id) ON DELETE SET NULL,
    is_edited   BOOLEAN NOT NULL DEFAULT false,
    is_pinned   BOOLEAN NOT NULL DEFAULT false,
    deleted_at  TIMESTAMPTZ,  -- Soft delete (ADR-038)
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    edited_at   TIMESTAMPTZ,

    CONSTRAINT messages_content_length CHECK (content IS NULL OR char_length(content) <= 4000)
);

-- Primary query: messages in a channel, ordered by time (pagination)
CREATE INDEX IF NOT EXISTS idx_messages_channel_created
    ON public.messages (channel_id, created_at DESC);

-- Pinned messages lookup
CREATE INDEX IF NOT EXISTS idx_messages_pinned
    ON public.messages (channel_id) WHERE is_pinned = true;

-- RLS: members can read/write messages in their servers
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE policyname = 'messages_select_member' AND tablename = 'messages'
    ) THEN
        CREATE POLICY messages_select_member ON public.messages
            FOR SELECT USING (
                EXISTS (
                    SELECT 1 FROM public.server_members sm
                    JOIN public.channels c ON c.server_id = sm.server_id
                    WHERE c.id = messages.channel_id
                    AND sm.user_id = auth.uid()
                )
            );
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE policyname = 'messages_insert_member' AND tablename = 'messages'
    ) THEN
        CREATE POLICY messages_insert_member ON public.messages
            FOR INSERT WITH CHECK (
                author_id = auth.uid()
                AND EXISTS (
                    SELECT 1 FROM public.server_members sm
                    JOIN public.channels c ON c.server_id = sm.server_id
                    WHERE c.id = channel_id
                    AND sm.user_id = auth.uid()
                )
            );
    END IF;
END $$;
