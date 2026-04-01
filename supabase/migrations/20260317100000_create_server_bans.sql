-- =============================================================
-- Migration: create_server_bans
--
-- WHY: Layer 1 moderation requires banning users from servers.
-- The server_bans table records which users are banned, by whom,
-- and optionally why. The Rust API enforces authorization;
-- RLS here is defense-in-depth for PowerSync clients.
-- =============================================================

-- ─────────────────────────────────────────────────────────────
-- 1. Create server_bans table
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.server_bans (
    server_id   UUID NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    banned_by   UUID NOT NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
    reason      TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (server_id, user_id)
);

-- WHY: Fast lookup for "is this user banned from this server?" in both
-- RLS policies and the Rust API's ban check on invite join.
CREATE INDEX IF NOT EXISTS idx_server_bans_user_id
    ON public.server_bans (user_id);

-- ─────────────────────────────────────────────────────────────
-- 2. RLS (defense-in-depth — Rust API is the primary enforcer)
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.server_bans ENABLE ROW LEVEL SECURITY;

-- WHY: server_bans should NOT sync to regular members (privacy).
-- Only the server owner can see who is banned.
DROP POLICY IF EXISTS server_bans_select_owner ON public.server_bans;
CREATE POLICY server_bans_select_owner ON public.server_bans
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.servers s
            WHERE s.id = server_bans.server_id
              AND s.owner_id = auth.uid()
        )
    );

-- WHY: Only the server owner can ban users.
DROP POLICY IF EXISTS server_bans_insert_owner ON public.server_bans;
CREATE POLICY server_bans_insert_owner ON public.server_bans
    FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.servers s
            WHERE s.id = server_bans.server_id
              AND s.owner_id = auth.uid()
        )
    );

-- WHY: Only the server owner can unban users.
DROP POLICY IF EXISTS server_bans_delete_owner ON public.server_bans;
CREATE POLICY server_bans_delete_owner ON public.server_bans
    FOR DELETE
    USING (
        EXISTS (
            SELECT 1 FROM public.servers s
            WHERE s.id = server_bans.server_id
              AND s.owner_id = auth.uid()
        )
    );
