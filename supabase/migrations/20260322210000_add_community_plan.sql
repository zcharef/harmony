-- =============================================================
-- Migration: add_community_plan
-- Adds: 'community' as valid plan value + plan column on profiles
-- WHY: 3-tier plan system (Free/Pro/Community). Server-level limits
-- use servers.plan, user-level limits use profiles.plan.
-- =============================================================

-- §1: Update servers.plan CHECK constraint to allow 'community'
ALTER TABLE public.servers
    DROP CONSTRAINT IF EXISTS servers_plan_valid;

ALTER TABLE public.servers
    ADD CONSTRAINT servers_plan_valid CHECK (plan IN ('free', 'pro', 'community'));

-- §2: Add plan column to profiles for per-user limits (§1 servers, §10 DMs, §11 profile, §12 rate limits)
-- WHY: Some limits are per-user (not per-server). The user's plan determines
-- their personal limits. Default 'free' ensures existing profiles are correct.
ALTER TABLE public.profiles
    ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'free';

ALTER TABLE public.profiles
    DROP CONSTRAINT IF EXISTS profiles_plan_valid;

ALTER TABLE public.profiles
    ADD CONSTRAINT profiles_plan_valid CHECK (plan IN ('free', 'pro', 'community'));
