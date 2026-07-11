-- =============================================================
-- Migration: add_identity_image_moderation
--
-- Scan-before-reveal for profile identity images (avatar + banner),
-- mirroring the message-attachment moderation model
-- (20260714300000_add_attachment_moderation). A newly-set identity
-- image is held PENDING and NOT shown to other users until an async
-- scan clears it; other users keep seeing the current APPROVED image.
--
-- Data model (per image field):
--   - `{field}_url`                 the APPROVED, displayed image. Every
--                                   render surface (member list, message
--                                   author, hover card) reads THIS column,
--                                   so those renders are unchanged.
--   - `pending_{field}_url`         the not-yet-cleared candidate under
--                                   scan. NEVER shipped to other users; the
--                                   Rust API only reveals it by promoting it
--                                   into `{field}_url` on a clean verdict.
--   - `{field}_moderation_status`   pending → approved / rejected.
--   - `{field}_nsfw_score`          server-side only (0.0-1.0, NULL until
--                                   scanned); NEVER shipped to clients.
--   - `{field}_scanned_at`          verdict timestamp (audit).
--
-- Existing rows are grandfathered `approved` (their avatars/banners were
-- set before scanning existed — re-scanning historical images is a
-- separate backfill job, not this migration).
--
-- Fail-closed: a scan that ERRORS leaves the candidate `pending` (never
-- revealed) and lands in `identity_image_scan_retry` (dead-letter),
-- mirroring `attachment_scan_retry`. A background sweep re-scans.
--
-- WHY no client UPDATE exposure of these columns: the service_role Rust
-- API is the SOLE writer of every moderation column (a user cannot
-- self-approve their own pending image). `profiles` already has no client
-- UPDATE policy for the moderation-owned columns; this migration only adds
-- columns, changing no policy. Idempotent / additive only (ADR-019),
-- IF NOT EXISTS everywhere, no DROP. Local apply only (ADR-043).
-- =============================================================

-- ─────────────────────────────────────────────────────────────
-- 1) Terminal moderation status enum for identity images.
-- Simpler than `attachment_moderation_status`: an identity image has no
-- channel context (an avatar is global), so there is no `gated`/`blocked`
-- middle ground — a flagged image is `rejected` (never revealed).
-- ─────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'identity_image_moderation_status') THEN
    CREATE TYPE public.identity_image_moderation_status AS ENUM
      ('pending','approved','rejected');
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────
-- 2) Moderation columns on profiles, per image field.
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS avatar_moderation_status public.identity_image_moderation_status
                             NOT NULL DEFAULT 'approved',
  ADD COLUMN IF NOT EXISTS pending_avatar_url TEXT
      CHECK (pending_avatar_url IS NULL OR char_length(pending_avatar_url) <= 2048),
  ADD COLUMN IF NOT EXISTS avatar_nsfw_score REAL,
  ADD COLUMN IF NOT EXISTS avatar_scanned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS banner_moderation_status public.identity_image_moderation_status
                             NOT NULL DEFAULT 'approved',
  ADD COLUMN IF NOT EXISTS pending_banner_url TEXT
      CHECK (pending_banner_url IS NULL OR char_length(pending_banner_url) <= 2048),
  ADD COLUMN IF NOT EXISTS banner_nsfw_score REAL,
  ADD COLUMN IF NOT EXISTS banner_scanned_at TIMESTAMPTZ;

-- Partial indexes for the "still pending" backlog the sweep + dashboards
-- watch (saturation signal). Cheap: only unscanned rows are indexed.
CREATE INDEX IF NOT EXISTS idx_profiles_avatar_pending
    ON public.profiles (updated_at)
    WHERE avatar_moderation_status = 'pending';
CREATE INDEX IF NOT EXISTS idx_profiles_banner_pending
    ON public.profiles (updated_at)
    WHERE banner_moderation_status = 'pending';

-- ─────────────────────────────────────────────────────────────
-- 2b) Lock the reveal + moderation columns to the service_role API.
--
-- WHY (SECURITY, self-approval bypass): `profiles` has a `profiles_update_own`
-- RLS policy AND a table-level UPDATE grant to `authenticated`, so a user could
-- otherwise `PATCH` PostgREST directly (their own JWT) and set `avatar_url`
-- straight to an unscanned image, or flip `*_moderation_status` to 'approved' —
-- bypassing the async scan entirely. That is the identity-image analogue of the
-- attachment invariant "a user CANNOT self-clear their own moderation flag"
-- (20260714300000). The Rust API writes these columns over the `service_role`
-- connection, which BYPASSES column privileges, so this only blocks the direct
-- client path.
--
-- PostgreSQL semantics: a table-level UPDATE grant lets `authenticated` write
-- EVERY column regardless of per-column REVOKEs, so we revoke the table grant
-- and re-grant UPDATE on exactly the columns a user may still self-edit
-- directly. The reveal columns (`avatar_url`, `banner_url`) and the
-- moderation-owned columns are deliberately excluded.
--
-- NOTE (documented follow-up, out of scope here): the re-granted text columns
-- (`display_name`, `bio`, `custom_status`) and `plan` remain directly writable,
-- so the API-side text moderation / plan checks are still bypassable via a
-- direct PostgREST write. Locking `profiles` to API-only writes wholesale is a
-- separate hardening step. Idempotent (ADR-019): REVOKE/GRANT re-run cleanly.
-- ─────────────────────────────────────────────────────────────
REVOKE UPDATE ON public.profiles FROM authenticated;
GRANT UPDATE (
    id, username, display_name, status, custom_status,
    public_key, created_at, updated_at, plan, bio
) ON public.profiles TO authenticated;

-- ─────────────────────────────────────────────────────────────
-- 3) Dead-letter queue for failed identity-image scans.
-- Mirrors attachment_scan_retry (20260714300000): a unique
-- (user_id, image_kind) key (concurrent failures UPSERT, never duplicate),
-- a pending partial index, and a service-only RLS policy.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.identity_image_scan_retry (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    -- 'avatar' | 'banner' — which image field the pending candidate belongs to.
    image_kind  TEXT NOT NULL CHECK (image_kind IN ('avatar','banner')),
    url         TEXT NOT NULL,
    retry_count INTEGER NOT NULL DEFAULT 0,
    last_error  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_identity_image_scan_retry_unique
    ON public.identity_image_scan_retry (user_id, image_kind);

CREATE INDEX IF NOT EXISTS idx_identity_image_scan_retry_pending
    ON public.identity_image_scan_retry (created_at ASC)
    WHERE retry_count < 5;

ALTER TABLE public.identity_image_scan_retry ENABLE ROW LEVEL SECURITY;

-- Block all access from the `authenticated` role. service_role bypasses
-- RLS, so the Rust API is unaffected. Idempotent create.
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'identity_image_scan_retry'
          AND policyname = 'identity_image_scan_retry_service_only'
    ) THEN
        CREATE POLICY identity_image_scan_retry_service_only ON public.identity_image_scan_retry
            FOR ALL
            USING (false);
    END IF;
END $$;

COMMENT ON TABLE public.identity_image_scan_retry IS
    'Dead-letter queue for failed identity-image (avatar/banner) moderation '
    'scans. A scan failure leaves the candidate in pending_{field}_url (never '
    'revealed) and lands here; a background sweep retries. Fail-closed.';
