-- =============================================================
-- Plan Constraints Tests — CHECK constraints + defaults
--
-- Validates the 3-tier plan system (free/supporter/creator) on both
-- servers and profiles tables.
--
-- Run via: supabase test db
-- =============================================================
BEGIN;

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
VALUES ('deadbeef-0000-4e57-a000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'plan_test_owner@harmony.test', crypt('password123', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{"display_name":"PlanTestOwner"}', now(), now(), false, false, '', '', '', '')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id, username, display_name)
VALUES ('deadbeef-0000-4e57-a000-000000000001', 'plan_test_owner', 'PlanTestOwner')
ON CONFLICT (id) DO NOTHING;

-- Test: 'free' is accepted
SELECT lives_ok(
    $$INSERT INTO public.servers (name, owner_id, plan) VALUES ('plan-test-free', 'deadbeef-0000-4e57-a000-000000000001', 'free')$$,
    'servers.plan accepts free'
);

-- Test: 'supporter' is accepted (renamed from 'pro' in v3 tier rename)
SELECT lives_ok(
    $$INSERT INTO public.servers (name, owner_id, plan) VALUES ('plan-test-supporter', 'deadbeef-0000-4e57-a000-000000000001', 'supporter')$$,
    'servers.plan accepts supporter'
);

-- Test: 'creator' is accepted (renamed from 'community' in v3 tier rename)
SELECT lives_ok(
    $$INSERT INTO public.servers (name, owner_id, plan) VALUES ('plan-test-creator', 'deadbeef-0000-4e57-a000-000000000001', 'creator')$$,
    'servers.plan accepts creator'
);


-- ═══════════════════════════════════════════════════════════════
-- §3: servers.plan CHECK constraint rejects invalid values
-- ═══════════════════════════════════════════════════════════════

SELECT throws_ok(
    $$INSERT INTO public.servers (name, owner_id, plan) VALUES ('plan-test-bad1', 'deadbeef-0000-4e57-a000-000000000001', 'enterprise')$$,
    23514,  -- check_violation
    NULL,
    'servers.plan rejects enterprise'
);

SELECT throws_ok(
    $$INSERT INTO public.servers (name, owner_id, plan) VALUES ('plan-test-bad2', 'deadbeef-0000-4e57-a000-000000000001', 'business')$$,
    23514,
    NULL,
    'servers.plan rejects business'
);

SELECT throws_ok(
    $$INSERT INTO public.servers (name, owner_id, plan) VALUES ('plan-test-bad3', 'deadbeef-0000-4e57-a000-000000000001', 'Premium')$$,
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
    $$UPDATE public.profiles SET plan = 'free' WHERE id = 'deadbeef-0000-4e57-a000-000000000001'$$,
    'profiles.plan accepts free'
);

SELECT lives_ok(
    $$UPDATE public.profiles SET plan = 'supporter' WHERE id = 'deadbeef-0000-4e57-a000-000000000001'$$,
    'profiles.plan accepts supporter'
);

SELECT lives_ok(
    $$UPDATE public.profiles SET plan = 'creator' WHERE id = 'deadbeef-0000-4e57-a000-000000000001'$$,
    'profiles.plan accepts creator'
);


-- ═══════════════════════════════════════════════════════════════
-- §6: profiles.plan CHECK constraint rejects invalid values
-- ═══════════════════════════════════════════════════════════════

-- WHY: We test the profiles CHECK constraint by trying to UPDATE an existing
-- profile to an invalid plan value (easier than creating new auth.users rows).

SELECT throws_ok(
    $$UPDATE public.profiles SET plan = 'enterprise' WHERE id = 'deadbeef-0000-4e57-a000-000000000001'$$,
    23514,
    NULL,
    'profiles.plan rejects enterprise'
);

SELECT throws_ok(
    $$UPDATE public.profiles SET plan = 'Free' WHERE id = 'deadbeef-0000-4e57-a000-000000000001'$$,
    23514,
    NULL,
    'profiles.plan rejects Free (case-sensitive)'
);


-- ═══════════════════════════════════════════════════════════════
-- CLEANUP
-- ═══════════════════════════════════════════════════════════════

SELECT * FROM finish();
ROLLBACK;
