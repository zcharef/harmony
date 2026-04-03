-- =============================================================
-- Migration: add_slowmode_check_constraint
--
-- WHY: Defense-in-depth. The Rust API validates slow mode range
-- at the service layer (channel_service.rs:224-231) returning
-- clean 400s. This DB constraint is a backstop for data written
-- outside the API (service_role scripts, admin SQL, migration bugs).
--
-- Range: 0 (disabled) to 21600 (6 hours), matching application logic.
-- =============================================================

DO $$ BEGIN
    ALTER TABLE public.channels ADD CONSTRAINT chk_channels_slowmode_range
        CHECK (slowmode_seconds >= 0 AND slowmode_seconds <= 21600) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
