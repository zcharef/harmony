-- =============================================================
-- Migration: create_user_badges (+ founding-member backfill)
--
-- 1) `user_badges` — an extensible (user_id, badge) grant table, NOT a
--    boolean column on profiles. Harmony+ / boost / staff badges reuse
--    the same table later; the first tenant is the free, permanent,
--    scarce `founding` badge (growth-plan §8, founding-badge ticket §1).
-- 2) Backfill `founding` for the earliest accounts by `profiles.created_at`.
--
-- Grant rule (ticket §2): the first N accounts by signup order, capped
-- also by a launch-day window — whichever limit is hit first. The launch
-- window is pending Zayd (ticket §2 / growth-plan §11); pre-launch only
-- the COUNT bound is active, so this backfill grants the first N by
-- created_at. New signups keep getting the badge via the Rust service
-- (`ProfileService::grant_founding_if_eligible`) until the cap is reached.
--
-- RLS: readable by any authenticated user (mirrors
-- `profiles_select_authenticated`); no write policy, so grants are
-- service_role-only (the Rust API bypasses RLS) — clients can never
-- mint themselves a badge.
--
-- Idempotent & additive per ADR-019 — safe to re-run (the backfill is
-- ON CONFLICT DO NOTHING and re-running never duplicates a grant).
-- =============================================================

-- Keep in sync with FOUNDING_MAX_ACCOUNTS in profile_service.rs.
-- Changing the cap is a product decision; the Rust constant is the SSoT
-- for the live signup path, this literal only seeds the backfill.

CREATE TABLE IF NOT EXISTS public.user_badges (
    user_id    UUID        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    badge      TEXT        NOT NULL,
    granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, badge)
);

-- Read path is a per-user EXISTS / a `WHERE badge = 'founding'` count.
-- Index the badge column so the count and the holder lookup stay cheap.
CREATE INDEX IF NOT EXISTS idx_user_badges_badge ON public.user_badges (badge);

-- RLS: SELECT open to authenticated (badges are as public as the profile
-- they decorate); no INSERT/UPDATE/DELETE policy → writes are
-- service_role-only (ADR-040 requires RLS ON regardless).
ALTER TABLE public.user_badges ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'user_badges'
          AND policyname = 'user_badges_select_authenticated'
    ) THEN
        CREATE POLICY user_badges_select_authenticated ON public.user_badges
            FOR SELECT TO authenticated
            USING (true);
    END IF;
END $$;

-- ─────────────────────────────────────────────────────────────
-- Backfill: grant `founding` to the earliest N accounts by created_at.
-- Deterministic (ORDER BY created_at, id) and idempotent (ON CONFLICT).
-- ─────────────────────────────────────────────────────────────
INSERT INTO public.user_badges (user_id, badge)
SELECT id, 'founding'
FROM public.profiles
ORDER BY created_at ASC, id ASC
LIMIT 500
ON CONFLICT (user_id, badge) DO NOTHING;
