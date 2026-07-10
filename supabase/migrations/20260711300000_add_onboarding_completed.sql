-- =============================================================
-- Migration: add_onboarding_completed
-- Adds a first-run flag to user_preferences so the onboarding flow
-- shows exactly once per user (server-persisted, survives reinstall
-- and multi-device — a localStorage flag would re-trigger everywhere).
-- =============================================================

ALTER TABLE public.user_preferences
    ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.user_preferences.onboarding_completed IS
    'True once the user has finished (or skipped through) the first-run onboarding flow. Default false = show onboarding.';
