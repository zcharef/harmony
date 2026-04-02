-- =============================================================
-- Migration: add_plan_to_servers
-- Adds: plan column to servers table for SaaS tier enforcement
-- WHY: Servers need a plan assignment for limit enforcement.
-- Self-hosted deployments ignore this column (AlwaysAllowedChecker).
-- Default 'free' ensures existing servers get the correct baseline.
-- =============================================================

ALTER TABLE public.servers
    ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'free';

-- WHY: CHECK constraint prevents invalid plan values at the DB level.
-- Defense-in-depth: the Rust Plan enum also validates, but this catches
-- direct SQL updates or migration bugs.
ALTER TABLE public.servers
    DROP CONSTRAINT IF EXISTS servers_plan_valid;

ALTER TABLE public.servers
    ADD CONSTRAINT servers_plan_valid CHECK (plan IN ('free', 'pro'));
