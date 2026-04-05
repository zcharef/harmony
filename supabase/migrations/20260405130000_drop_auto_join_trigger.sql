-- =============================================================
-- Migration: drop_auto_join_trigger
-- Removes: trg_auto_join_official_server trigger and function.
-- WHY: Auto-join is now owned by the Rust API (sync_profile handler)
-- using the OFFICIAL_SERVER_ID env var as SSoT. This eliminates the
-- split-brain between DB trigger (membership) and Rust (events).
-- =============================================================

DROP TRIGGER IF EXISTS trg_auto_join_official_server ON public.profiles;
DROP FUNCTION IF EXISTS public.auto_join_official_server();
