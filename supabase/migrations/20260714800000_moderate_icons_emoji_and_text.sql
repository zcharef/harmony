-- =============================================================
-- Migration: moderate_icons_emoji_and_text
--
-- Scan-before-reveal for CUSTOM EMOJI images, the second image
-- surface after profile avatar/banner (20260714700000). A newly
-- created emoji is held PENDING and NOT shown to other members
-- until an async scan clears it; on a clean verdict it is promoted
-- (revealed via `emoji.created`), on a flag it is rejected (the row
-- is deleted, the object best-effort removed, the creator notified).
--
-- Unlike profile images there is no "previous approved" emoji to
-- keep live — a brand-new emoji simply stays invisible to others
-- while pending, so the model is a single `moderation_status` on
-- `server_emojis` (no separate `pending_url` column: the emoji's own
-- `url` IS the candidate under scan).
--
-- Reuses the `identity_image_moderation_status` enum from
-- 20260714700000 (pending/approved/rejected — the identical three
-- terminal states). Fail-closed: a scan that ERRORS leaves the emoji
-- `pending` (never revealed) and lands in `emoji_image_scan_retry`
-- (dead-letter), mirroring `identity_image_scan_retry`.
--
-- Idempotent / additive only (ADR-019): IF NOT EXISTS everywhere,
-- non-destructive. Local apply only (ADR-043).
-- =============================================================

-- ─────────────────────────────────────────────────────────────
-- 1) Moderation columns on server_emojis.
-- Existing rows are grandfathered `approved` (they were created
-- before scanning existed — re-scanning historical emoji is a
-- separate backfill, not this migration). The Rust API inserts new
-- rows with an explicit `pending` status.
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.server_emojis
  ADD COLUMN IF NOT EXISTS moderation_status public.identity_image_moderation_status
                             NOT NULL DEFAULT 'approved',
  -- Server-side only (0.0-1.0, NULL until scanned); NEVER shipped to clients.
  ADD COLUMN IF NOT EXISTS nsfw_score REAL,
  -- Verdict timestamp (audit).
  ADD COLUMN IF NOT EXISTS scanned_at TIMESTAMPTZ;

-- Partial index for the "still pending" backlog the sweep + dashboards
-- watch (saturation signal). Cheap: only unscanned rows are indexed.
CREATE INDEX IF NOT EXISTS idx_server_emojis_pending
    ON public.server_emojis (created_at)
    WHERE moderation_status = 'pending';

-- ─────────────────────────────────────────────────────────────
-- 2) Gate the SELECT policy to approved (or own) emoji.
--
-- WHY (scan-before-reveal at the RLS layer): the existing
-- `server_emojis_select_member` policy exposed EVERY row to any
-- member, including PENDING (not-yet-scanned) emoji. Tightening it so
-- a member only ever reads an `approved` emoji — or one they created
-- themselves — enforces "not shown to other users until cleared" as a
-- defense-in-depth backstop under the Rust API (which also filters its
-- list endpoint to approved-only). The creator keeps read access to
-- their own pending emoji so a direct read never blanks it while the
-- scan runs; the POST response already gave them the optimistic copy.
--
-- WHY no REVOKE (contrast 20260714700000): `server_emojis` has NO
-- INSERT/UPDATE/DELETE policy for `authenticated` and RLS is enabled,
-- so a client already CANNOT write `url` or flip `moderation_status`
-- directly via PostgREST (a missing permissive policy denies the write
-- regardless of any table GRANT). The service_role Rust API is the
-- sole writer — the same anti-self-approval invariant #111 had to add
-- a REVOKE to obtain on `profiles` (which DID have a write policy) is
-- already structurally true here. The regression test proves it.
-- ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS server_emojis_select_member ON public.server_emojis;
CREATE POLICY server_emojis_select_member ON public.server_emojis
    FOR SELECT USING (
        (
            moderation_status = 'approved'
            OR server_emojis.created_by = auth.uid()
        )
        AND EXISTS (
            SELECT 1 FROM public.server_members sm
            WHERE sm.server_id = server_emojis.server_id
              AND sm.user_id = auth.uid()
        )
    );

-- ─────────────────────────────────────────────────────────────
-- 3) Dead-letter queue for failed emoji-image scans.
-- Mirrors identity_image_scan_retry (20260714700000): a unique
-- emoji_id key (concurrent failures UPSERT, never duplicate), a
-- pending partial index, and a service-only RLS policy. ON DELETE
-- CASCADE: rejecting an emoji deletes its row, which drops the retry.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.emoji_image_scan_retry (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    emoji_id    UUID NOT NULL REFERENCES public.server_emojis(id) ON DELETE CASCADE,
    url         TEXT NOT NULL,
    retry_count INTEGER NOT NULL DEFAULT 0,
    last_error  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_emoji_image_scan_retry_unique
    ON public.emoji_image_scan_retry (emoji_id);

CREATE INDEX IF NOT EXISTS idx_emoji_image_scan_retry_pending
    ON public.emoji_image_scan_retry (created_at ASC)
    WHERE retry_count < 5;

ALTER TABLE public.emoji_image_scan_retry ENABLE ROW LEVEL SECURITY;

-- Block all access from the `authenticated` role. service_role bypasses
-- RLS, so the Rust API is unaffected. Idempotent create.
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'emoji_image_scan_retry'
          AND policyname = 'emoji_image_scan_retry_service_only'
    ) THEN
        CREATE POLICY emoji_image_scan_retry_service_only ON public.emoji_image_scan_retry
            FOR ALL
            USING (false);
    END IF;
END $$;

COMMENT ON TABLE public.emoji_image_scan_retry IS
    'Dead-letter queue for failed custom-emoji image moderation scans. A scan '
    'failure leaves the emoji pending (never revealed) and lands here; a '
    'background sweep retries. Fail-closed.';
