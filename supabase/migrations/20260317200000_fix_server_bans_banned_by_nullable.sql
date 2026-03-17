-- =============================================================
-- Migration: fix_server_bans_banned_by_nullable
--
-- WHY: banned_by was NOT NULL + ON DELETE SET NULL — a contradiction.
-- If the banning admin's profile is deleted, Postgres cannot SET NULL
-- on a NOT NULL column, causing a FK violation error. Bans must
-- survive admin account deletion, so we drop the NOT NULL constraint.
-- =============================================================

ALTER TABLE public.server_bans
    ALTER COLUMN banned_by DROP NOT NULL;
