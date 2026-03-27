-- =============================================================
-- Plan Constraints Tests — CHECK constraints + defaults
--
-- Validates the 3-tier plan system (free/pro/community) on both
-- servers and profiles tables.
--
-- Run via: supabase test db
-- =============================================================
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

DO $$
BEGIN
  EXECUTE format(
    'SET search_path TO public, %I',
    (SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON e.extnamespace = n.oid WHERE e.extname = 'pgtap')
  );
END $$;

SELECT plan(17);


-- ═══════════════════════════════════════════════════════════════
-- §1: servers.plan column exists and has correct properties
-- ═══════════════════════════════════════════════════════════════

SELECT has_column('public', 'servers', 'plan',
    'servers table has a plan column');

SELECT col_not_null('public', 'servers', 'plan',
    'servers.plan is NOT NULL');

SELECT col_default_is('public', 'servers', 'plan', 'free',
    'servers.plan defaults to free');


-- ═══════════════════════════════════════════════════════════════
-- §2: servers.plan CHECK constraint accepts valid values
-- ═══════════════════════════════════════════════════════════════

-- WHY: We insert real rows to verify the CHECK constraint allows each
-- valid plan value. We use a temporary owner profile to satisfy FK constraints.

-- Create a test owner (bypass RLS as postgres)
INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, is_sso_user, is_anonymous, confirmation_token, recovery_token, email_change_token_new, email_change)
VALUES ('deadbeef-plan-test-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'plan-test-owner@harmony.test', crypt('password123', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{"display_name":"PlanTestOwner"}', now(), now(), false, false, '', '', '', '')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id, username, display_name)
VALUES ('deadbeef-plan-test-0000-000000000001', 'plan-test-owner', 'PlanTestOwner')
ON CONFLICT (id) DO NOTHING;

-- Test: 'free' is accepted
SELECT lives_ok(
    $$INSERT INTO public.servers (name, owner_id, plan) VALUES ('plan-test-free', 'deadbeef-plan-test-0000-000000000001', 'free')$$,
    'servers.plan accepts free'
);

-- Test: 'pro' is accepted
SELECT lives_ok(
    $$INSERT INTO public.servers (name, owner_id, plan) VALUES ('plan-test-pro', 'deadbeef-plan-test-0000-000000000001', 'pro')$$,
    'servers.plan accepts pro'
);

-- Test: 'community' is accepted
SELECT lives_ok(
    $$INSERT INTO public.servers (name, owner_id, plan) VALUES ('plan-test-community', 'deadbeef-plan-test-0000-000000000001', 'community')$$,
    'servers.plan accepts community'
);


-- ═══════════════════════════════════════════════════════════════
-- §3: servers.plan CHECK constraint rejects invalid values
-- ═══════════════════════════════════════════════════════════════

SELECT throws_ok(
    $$INSERT INTO public.servers (name, owner_id, plan) VALUES ('plan-test-bad1', 'deadbeef-plan-test-0000-000000000001', 'enterprise')$$,
    23514,  -- check_violation
    NULL,
    'servers.plan rejects enterprise'
);

SELECT throws_ok(
    $$INSERT INTO public.servers (name, owner_id, plan) VALUES ('plan-test-bad2', 'deadbeef-plan-test-0000-000000000001', 'business')$$,
    23514,
    NULL,
    'servers.plan rejects business'
);

SELECT throws_ok(
    $$INSERT INTO public.servers (name, owner_id, plan) VALUES ('plan-test-bad3', 'deadbeef-plan-test-0000-000000000001', 'Premium')$$,
    23514,
    NULL,
    'servers.plan rejects Premium (case-sensitive)'
);


-- ═══════════════════════════════════════════════════════════════
-- §4: profiles.plan column exists and has correct properties
-- ═══════════════════════════════════════════════════════════════

SELECT has_column('public', 'profiles', 'plan',
    'profiles table has a plan column');

SELECT col_not_null('public', 'profiles', 'plan',
    'profiles.plan is NOT NULL');

SELECT col_default_is('public', 'profiles', 'plan', 'free',
    'profiles.plan defaults to free');


-- ═══════════════════════════════════════════════════════════════
-- §5: profiles.plan CHECK constraint accepts valid values
-- ═══════════════════════════════════════════════════════════════

-- WHY: Symmetric with §2 (servers). UPDATE is easier than creating new auth.users rows.

SELECT lives_ok(
    $$UPDATE public.profiles SET plan = 'free' WHERE id = 'deadbeef-plan-test-0000-000000000001'$$,
    'profiles.plan accepts free'
);

SELECT lives_ok(
    $$UPDATE public.profiles SET plan = 'pro' WHERE id = 'deadbeef-plan-test-0000-000000000001'$$,
    'profiles.plan accepts pro'
);

SELECT lives_ok(
    $$UPDATE public.profiles SET plan = 'community' WHERE id = 'deadbeef-plan-test-0000-000000000001'$$,
    'profiles.plan accepts community'
);


-- ═══════════════════════════════════════════════════════════════
-- §6: profiles.plan CHECK constraint rejects invalid values
-- ═══════════════════════════════════════════════════════════════

-- WHY: We test the profiles CHECK constraint by trying to UPDATE an existing
-- profile to an invalid plan value (easier than creating new auth.users rows).

SELECT throws_ok(
    $$UPDATE public.profiles SET plan = 'enterprise' WHERE id = 'deadbeef-plan-test-0000-000000000001'$$,
    23514,
    NULL,
    'profiles.plan rejects enterprise'
);

SELECT throws_ok(
    $$UPDATE public.profiles SET plan = 'Free' WHERE id = 'deadbeef-plan-test-0000-000000000001'$$,
    23514,
    NULL,
    'profiles.plan rejects Free (case-sensitive)'
);


-- ═══════════════════════════════════════════════════════════════
-- CLEANUP
-- ═══════════════════════════════════════════════════════════════

SELECT * FROM finish();
ROLLBACK;
