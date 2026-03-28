-- =============================================================
-- Migration: v3_tier_rename
--
-- WHY: V3 renames plan tiers to match the public brand language:
--   pro       -> supporter
--   community -> creator
--
-- Also raises text field constraint ceilings to V3 self-hosted
-- maximums. DB constraints use the highest tier ceiling
-- (self-hosted). Per-plan enforcement is done at the API
-- service layer.
-- =============================================================

-- ─────────────────────────────────────────────────────────────
-- §1: Rename plan tiers on servers
-- ─────────────────────────────────────────────────────────────

-- §1a: Widen the CHECK to accept both old and new values during migration
ALTER TABLE public.servers
    DROP CONSTRAINT IF EXISTS servers_plan_valid;

ALTER TABLE public.servers
    ADD CONSTRAINT servers_plan_valid CHECK (plan IN ('free', 'pro', 'community', 'supporter', 'creator'));

-- §1b: Migrate existing data
UPDATE public.servers SET plan = 'supporter' WHERE plan = 'pro';
UPDATE public.servers SET plan = 'creator'   WHERE plan = 'community';

-- §1c: Tighten the CHECK to final V3 values only
ALTER TABLE public.servers
    DROP CONSTRAINT IF EXISTS servers_plan_valid;

ALTER TABLE public.servers
    ADD CONSTRAINT servers_plan_valid CHECK (plan IN ('free', 'supporter', 'creator'));

-- ─────────────────────────────────────────────────────────────
-- §2: Rename plan tiers on profiles
-- ─────────────────────────────────────────────────────────────

-- §2a: Widen the CHECK to accept both old and new values during migration
ALTER TABLE public.profiles
    DROP CONSTRAINT IF EXISTS profiles_plan_valid;

ALTER TABLE public.profiles
    ADD CONSTRAINT profiles_plan_valid CHECK (plan IN ('free', 'pro', 'community', 'supporter', 'creator'));

-- §2b: Migrate existing data
UPDATE public.profiles SET plan = 'supporter' WHERE plan = 'pro';
UPDATE public.profiles SET plan = 'creator'   WHERE plan = 'community';

-- §2c: Tighten the CHECK to final V3 values only
ALTER TABLE public.profiles
    DROP CONSTRAINT IF EXISTS profiles_plan_valid;

ALTER TABLE public.profiles
    ADD CONSTRAINT profiles_plan_valid CHECK (plan IN ('free', 'supporter', 'creator'));

-- ─────────────────────────────────────────────────────────────
-- §3: Raise text field constraint ceilings to V3 self-hosted maximums
--
-- WHY: DB constraints use the highest tier ceiling (self-hosted).
-- Per-plan enforcement is done at the API service layer.
-- ─────────────────────────────────────────────────────────────

-- §3a: servers.description 1024 -> 5000
ALTER TABLE public.servers
    DROP CONSTRAINT IF EXISTS chk_servers_description_length;

DO $$ BEGIN
    ALTER TABLE public.servers ADD CONSTRAINT chk_servers_description_length
        CHECK (description IS NULL OR char_length(description) <= 5000) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- §3b: channels.topic 1024 -> 4096
ALTER TABLE public.channels
    DROP CONSTRAINT IF EXISTS chk_channels_topic_length;

DO $$ BEGIN
    ALTER TABLE public.channels ADD CONSTRAINT chk_channels_topic_length
        CHECK (topic IS NULL OR char_length(topic) <= 4096) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- §3c: profiles.custom_status 128 -> 256
ALTER TABLE public.profiles
    DROP CONSTRAINT IF EXISTS chk_profiles_custom_status_length;

DO $$ BEGIN
    ALTER TABLE public.profiles ADD CONSTRAINT chk_profiles_custom_status_length
        CHECK (custom_status IS NULL OR char_length(custom_status) <= 256) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- §3d: messages.content 4000 -> 8000 (original constraint in create_messages.sql)
ALTER TABLE public.messages
    DROP CONSTRAINT IF EXISTS messages_content_length;

DO $$ BEGIN
    ALTER TABLE public.messages ADD CONSTRAINT messages_content_length
        CHECK (content IS NULL OR char_length(content) <= 8000) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
