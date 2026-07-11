-- =============================================================
-- Migration: signup_via_invite_once_per_user
-- Adds `signup_via_invite` to the once-per-user analytics milestones.
--
-- The API emits `signup_via_invite` on a join-via-invite by an account
-- created within the attribution window. A user can redeem several
-- invites inside that window; only the FIRST one is the signup driver.
-- The partial unique index + the recorder's ON CONFLICT DO NOTHING turn
-- replays into silent no-ops (same mechanism as `first_message`).
--
-- Index rebuild is safe: `signup_via_invite` is a new event name, so no
-- existing rows can violate the widened predicate. Non-destructive of
-- data (ADR-019: only an index is replaced).
-- =============================================================

DROP INDEX IF EXISTS public.uq_analytics_events_once_per_user;

CREATE UNIQUE INDEX IF NOT EXISTS uq_analytics_events_once_per_user
    ON public.analytics_events (name, user_id)
    WHERE name IN ('user_signed_up', 'first_message', 'signup_via_invite');
