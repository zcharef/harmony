-- =============================================================
-- Migration: add_channel_encryption
--
-- WHY: Megolm-based E2EE for channels requires two things:
--   1. A flag on channels indicating whether encryption is enabled
--   2. A table to store Megolm session metadata so members can
--      look up the active session for a given encrypted channel
--
-- Referenced by:
--   harmony-api/src/infra/postgres/channel_repository.rs:L109 (channels.encrypted)
--   harmony-api/src/api/handlers/channels.rs:L261 (megolm_sessions INSERT)
-- =============================================================


-- ─────────────────────────────────────────────────────────────
-- 1. Add encrypted flag to channels
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.channels
    ADD COLUMN IF NOT EXISTS encrypted BOOLEAN NOT NULL DEFAULT false;


-- ─────────────────────────────────────────────────────────────
-- 2. Create megolm_sessions table
--
-- WHY: Each encrypted channel has one active Megolm session at
-- a time. This table stores session metadata so channel members
-- can request the session key from the creator's device.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.megolm_sessions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id  UUID NOT NULL REFERENCES public.channels(id) ON DELETE CASCADE,
    session_id  TEXT NOT NULL,
    creator_id  UUID NOT NULL REFERENCES auth.users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT megolm_sessions_channel_session_unique UNIQUE (channel_id, session_id)
);

-- WHY: Channel-scoped lookups fetch the active session for a channel
CREATE INDEX IF NOT EXISTS idx_megolm_sessions_channel_id
    ON public.megolm_sessions (channel_id);


-- ─────────────────────────────────────────────────────────────
-- 3. RLS policies for megolm_sessions
--
-- WHY: Only members of the channel's server should be able to
-- read or create Megolm sessions. Uses is_channel_member()
-- helper (20260317000000_normalize_rls_helpers.sql:L26) to
-- avoid raw EXISTS subqueries and prevent RLS recursion.
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.megolm_sessions ENABLE ROW LEVEL SECURITY;

-- WHY: Any channel member needs to read session metadata to
-- request the Megolm session key from the creator's device.
DROP POLICY IF EXISTS megolm_sessions_select_member ON public.megolm_sessions;
CREATE POLICY megolm_sessions_select_member ON public.megolm_sessions
    FOR SELECT TO authenticated
    USING (public.is_channel_member(channel_id));

-- WHY: Any channel member can create a new Megolm session
-- (e.g., on key rotation). creator_id must match the caller.
DROP POLICY IF EXISTS megolm_sessions_insert_member ON public.megolm_sessions;
CREATE POLICY megolm_sessions_insert_member ON public.megolm_sessions
    FOR INSERT TO authenticated
    WITH CHECK (
        creator_id = auth.uid()
        AND public.is_channel_member(channel_id)
    );
