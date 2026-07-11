-- =============================================================
-- Migration: create_server_emojis
-- Custom per-server emoji. Rows store the public Storage URL only
-- (the image bytes live in the `server-emojis` bucket, uploaded
-- direct-from-client per the avatar pipeline). Writes are API-only
-- (the Rust API connects as `postgres` and bypasses RLS); the
-- SELECT policy is defense-in-depth mirroring message_reactions.
-- Idempotent per ADR-019.
-- =============================================================

CREATE TABLE IF NOT EXISTS public.server_emojis (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id   UUID NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    url         TEXT NOT NULL,
    is_animated BOOLEAN NOT NULL DEFAULT false,
    created_by  UUID NOT NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- name: ^[a-z0-9_]{2,32}$ (enforced fully in Rust; CHECK is a floor)
    CONSTRAINT server_emojis_name_format CHECK (name ~ '^[a-z0-9_]{2,32}$'),
    CONSTRAINT server_emojis_url_length  CHECK (char_length(url) BETWEEN 1 AND 2048),
    -- Case-insensitive uniqueness per server. name is already lowercased by
    -- the API, so a plain UNIQUE suffices, but keep it explicit.
    CONSTRAINT server_emojis_unique_name UNIQUE (server_id, name)
);

CREATE INDEX IF NOT EXISTS idx_server_emojis_server
    ON public.server_emojis (server_id);

ALTER TABLE public.server_emojis ENABLE ROW LEVEL SECURITY;

-- SELECT: any member of the server can read its emoji (mirrors
-- message_reactions_select_member, 20260316013719_create_message_reactions.sql).
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE policyname = 'server_emojis_select_member' AND tablename = 'server_emojis'
    ) THEN
        CREATE POLICY server_emojis_select_member ON public.server_emojis
            FOR SELECT USING (
                EXISTS (
                    SELECT 1 FROM public.server_members sm
                    WHERE sm.server_id = server_emojis.server_id
                      AND sm.user_id = auth.uid()
                )
            );
    END IF;
END $$;

-- No INSERT/UPDATE/DELETE policy for authenticated: all writes go through the
-- Rust API (service connection bypasses RLS). ADR-043 — API is the only writer.
