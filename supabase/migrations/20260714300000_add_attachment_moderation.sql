-- =============================================================
-- Migration: add_attachment_moderation (image-moderation Phase 1)
--
-- 1) `attachment_moderation_status` enum — the terminal render state
--    a scanned image attachment resolves to.
-- 2) Moderation columns on `message_attachments`. `moderation_status`
--    DEFAULT 'pending' is the whole safety story on insert: a freshly
--    inserted attachment is blurred/withheld until a scan verdict
--    overwrites it (scan-before-reveal, spec §c.1).
-- 3) `attachment_scan_retry` dead-letter queue — mirrors
--    `moderation_retries` but keyed by attachment (the text queue carries
--    a NOT NULL `content` and is text-shaped). A failed image scan leaves
--    the attachment `pending` (never revealed) and lands here; the
--    background sweep retries. Fail-closed (spec §c.1 step 6).
--
-- RLS on every table (ADR-040). Idempotent / additive only (ADR-019):
-- IF NOT EXISTS everywhere, no DROP. Local apply only (ADR-043).
--
-- WHY no client UPDATE policy on message_attachments (unchanged from
-- 20260711500000): the service_role Rust API is the SOLE writer of
-- `moderation_status`, so a user CANNOT self-clear their own flag. This
-- is enforced by the ABSENCE of an UPDATE policy and pinned by an RLS
-- regression test.
-- =============================================================

-- ─────────────────────────────────────────────────────────────
-- 1) Terminal moderation status enum.
-- ─────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'attachment_moderation_status') THEN
    CREATE TYPE public.attachment_moderation_status AS ENUM
      ('pending','approved','gated','blocked','quarantined');
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────
-- 2) Moderation columns on message_attachments.
-- `nsfw_score` is server-side only (0.0-1.0, NULL until scanned) and is
-- NEVER shipped to clients. `moderation_reason` is bounded (audit trail,
-- never the classifier's raw output).
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.message_attachments
  ADD COLUMN IF NOT EXISTS moderation_status public.attachment_moderation_status
                             NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS nsfw_score        REAL,
  ADD COLUMN IF NOT EXISTS scanned_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS moderation_reason TEXT
      CHECK (moderation_reason IS NULL OR char_length(moderation_reason) <= 256);

-- Partial index for the "still pending" backlog the sweep and dashboards
-- watch (saturation signal). Cheap: only unscanned rows are indexed.
CREATE INDEX IF NOT EXISTS idx_message_attachments_pending
    ON public.message_attachments (created_at)
    WHERE moderation_status = 'pending';

-- ─────────────────────────────────────────────────────────────
-- 3) Dead-letter queue for failed image scans.
-- Mirrors moderation_retries (20260403000000 + 20260403160000): a
-- unique attachment_id (concurrent failures UPSERT, never duplicate),
-- a pending partial index, and a service-only RLS policy.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.attachment_scan_retry (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    attachment_id UUID NOT NULL REFERENCES message_attachments(id) ON DELETE CASCADE,
    message_id    UUID NOT NULL,
    channel_id    UUID NOT NULL,
    url           TEXT NOT NULL,
    mime          TEXT NOT NULL,
    retry_count   INTEGER NOT NULL DEFAULT 0,
    last_error    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_attachment_scan_retry_unique_attachment
    ON public.attachment_scan_retry (attachment_id);

CREATE INDEX IF NOT EXISTS idx_attachment_scan_retry_pending
    ON public.attachment_scan_retry (created_at ASC)
    WHERE retry_count < 5;

ALTER TABLE public.attachment_scan_retry ENABLE ROW LEVEL SECURITY;

-- Block all access from the `authenticated` role. service_role bypasses
-- RLS, so the Rust API is unaffected. Idempotent create.
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'attachment_scan_retry'
          AND policyname = 'attachment_scan_retry_service_only'
    ) THEN
        CREATE POLICY attachment_scan_retry_service_only ON public.attachment_scan_retry
            FOR ALL
            USING (false);
    END IF;
END $$;

COMMENT ON TABLE public.attachment_scan_retry IS
    'Dead-letter queue for failed image content-moderation scans. A scan '
    'failure leaves the attachment moderation_status=pending (never revealed) '
    'and lands here; a background sweep retries. Fail-closed.';
