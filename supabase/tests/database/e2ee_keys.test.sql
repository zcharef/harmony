-- =============================================================
-- E2EE Keys Tests (device_keys + one_time_keys)
--
-- Tests:
--   - Schema: device_keys table (8 cols, PK, UNIQUE, FK, index)
--   - Schema: one_time_keys table (7 cols, PK, UNIQUE, composite FK, index)
--   - RLS: device_keys policies (select, insert, update, delete × auth/anon)
--   - RLS: one_time_keys policies (select, insert, delete × auth/anon)
--
-- Run via: supabase test db
-- =============================================================
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT set_config('search_path', 'public, extensions', false);

SELECT plan(59);


-- ═══════════════════════════════════════════════════════════════
-- AUTH HELPERS
-- ═══════════════════════════════════════════════════════════════

-- WHY: Supabase's auth.uid() reads from request.jwt.claims.
-- These helpers impersonate users by setting JWT claims + switching
-- to the authenticated role (which activates RLS).

CREATE OR REPLACE FUNCTION authenticate_as(p_user_id uuid)
RETURNS void AS $$
BEGIN
    PERFORM set_config(
        'request.jwt.claims',
        json_build_object(
            'sub', p_user_id::text,
            'role', 'authenticated',
            'aud', 'authenticated',
            'iss', 'supabase'
        )::text,
        true
    );
    EXECUTE 'SET LOCAL ROLE authenticated';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION clear_auth()
RETURNS void AS $$
BEGIN
    EXECUTE 'SET LOCAL ROLE postgres';
    PERFORM set_config('request.jwt.claims', '', true);
END;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION authenticate_as(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION clear_auth() TO authenticated;


-- ═══════════════════════════════════════════════════════════════
-- TEST DATA SETUP (as postgres — bypasses RLS)
-- ═══════════════════════════════════════════════════════════════

-- User IDs (deterministic UUIDs — same convention as channel_encryption.test.sql)
-- Alice:   a1111111-...  (will own device keys)
-- Bob:     b2222222-...  (will own device keys)

-- Auth users (Alice + Bob exist from seed; ensure they exist)
INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, is_sso_user, is_anonymous, confirmation_token, recovery_token, email_change_token_new, email_change)
VALUES
    ('a1111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'alice@harmony.test', crypt('password123', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Alice"}', now(), now(), false, false, '', '', '', ''),
    ('b2222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'bob@harmony.test', crypt('password123', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Bob"}', now(), now(), false, false, '', '', '', '')
ON CONFLICT (id) DO NOTHING;

-- Profiles
INSERT INTO public.profiles (id, username, display_name)
VALUES
    ('a1111111-1111-1111-1111-111111111111', 'alice', 'Alice'),
    ('b2222222-2222-2222-2222-222222222222', 'bob', 'Bob')
ON CONFLICT (id) DO NOTHING;

-- Device keys for Alice and Bob (needed for RLS tests and one_time_keys FK)
INSERT INTO public.device_keys (id, user_id, device_id, identity_key, signing_key, device_name)
VALUES
    ('d00a0001-0001-0001-0001-000100010001', 'a1111111-1111-1111-1111-111111111111', 'ALICE_DEVICE_1', 'alice-curve25519-key-base64', 'alice-ed25519-key-base64', 'Alice Laptop'),
    ('d00b0002-0002-0002-0002-000200020002', 'b2222222-2222-2222-2222-222222222222', 'BOB_DEVICE_1', 'bob-curve25519-key-base64', 'bob-ed25519-key-base64', 'Bob Phone')
ON CONFLICT (id) DO NOTHING;

-- One-time keys for Alice and Bob (depends on device_keys above)
INSERT INTO public.one_time_keys (id, user_id, device_id, key_id, public_key, is_fallback)
VALUES
    ('0e0a0001-0001-0001-0001-000100010001', 'a1111111-1111-1111-1111-111111111111', 'ALICE_DEVICE_1', 'AAAAAA', 'alice-otk-curve25519-base64', false),
    ('0e0a0002-0002-0002-0002-000200020002', 'a1111111-1111-1111-1111-111111111111', 'ALICE_DEVICE_1', 'AAAAAB', 'alice-fallback-curve25519-base64', true),
    ('0e0b0001-0001-0001-0001-000100010001', 'b2222222-2222-2222-2222-222222222222', 'BOB_DEVICE_1', 'BBBBBA', 'bob-otk-curve25519-base64', false)
ON CONFLICT (id) DO NOTHING;


-- ═══════════════════════════════════════════════════════════════
-- 1. SCHEMA TESTS — device_keys
-- ═══════════════════════════════════════════════════════════════

SELECT has_table('public', 'device_keys',
    'schema: device_keys table exists');

SELECT col_type_is('public', 'device_keys', 'id', 'uuid',
    'schema: device_keys.id is UUID');

SELECT col_type_is('public', 'device_keys', 'user_id', 'uuid',
    'schema: device_keys.user_id is UUID');

SELECT col_type_is('public', 'device_keys', 'device_id', 'text',
    'schema: device_keys.device_id is TEXT');

SELECT col_type_is('public', 'device_keys', 'identity_key', 'text',
    'schema: device_keys.identity_key is TEXT');

SELECT col_type_is('public', 'device_keys', 'signing_key', 'text',
    'schema: device_keys.signing_key is TEXT');

SELECT col_type_is('public', 'device_keys', 'device_name', 'text',
    'schema: device_keys.device_name is TEXT');

SELECT col_type_is('public', 'device_keys', 'created_at', 'timestamp with time zone',
    'schema: device_keys.created_at is TIMESTAMPTZ');

SELECT col_type_is('public', 'device_keys', 'last_key_upload_at', 'timestamp with time zone',
    'schema: device_keys.last_key_upload_at is TIMESTAMPTZ');

-- NOT NULL constraints (device_name is nullable per migration)
SELECT col_not_null('public', 'device_keys', 'user_id',
    'schema: device_keys.user_id is NOT NULL');

SELECT col_not_null('public', 'device_keys', 'device_id',
    'schema: device_keys.device_id is NOT NULL');

SELECT col_not_null('public', 'device_keys', 'identity_key',
    'schema: device_keys.identity_key is NOT NULL');

SELECT col_not_null('public', 'device_keys', 'signing_key',
    'schema: device_keys.signing_key is NOT NULL');

SELECT col_not_null('public', 'device_keys', 'created_at',
    'schema: device_keys.created_at is NOT NULL');

SELECT col_not_null('public', 'device_keys', 'last_key_upload_at',
    'schema: device_keys.last_key_upload_at is NOT NULL');

-- Primary key
SELECT col_is_pk('public', 'device_keys', 'id',
    'schema: device_keys.id is primary key');

-- Unique constraint on (user_id, device_id)
SELECT col_is_unique('public', 'device_keys', ARRAY['user_id', 'device_id'],
    'schema: unique constraint device_keys_user_device_unique on (user_id, device_id)');

-- Foreign key: user_id -> profiles(id)
SELECT fk_ok('public', 'device_keys', 'user_id', 'public', 'profiles', 'id',
    'schema: device_keys.user_id FK -> profiles(id)');

-- Index
SELECT has_index('public', 'device_keys', 'idx_device_keys_user_id',
    'schema: index idx_device_keys_user_id exists');

-- RLS enabled
SELECT row_level_security_is_on('public', 'device_keys',
    'schema: RLS is enabled on device_keys');


-- ═══════════════════════════════════════════════════════════════
-- 2. RLS TESTS — device_keys
-- ═══════════════════════════════════════════════════════════════

-- 2.1 SELECT: authenticated user CAN select all device keys
SELECT authenticate_as('a1111111-1111-1111-1111-111111111111'); -- Alice
SELECT is(
    (SELECT count(*)::int FROM device_keys),
    2,
    'RLS SELECT: authenticated user can see all device keys'
);

-- 2.2 INSERT: authenticated user CAN insert with own user_id
SELECT clear_auth();
SAVEPOINT sp_dk_ins_own;
SELECT authenticate_as('a1111111-1111-1111-1111-111111111111'); -- Alice
SELECT lives_ok(
    $$INSERT INTO device_keys (id, user_id, device_id, identity_key, signing_key, device_name)
      VALUES ('d00a0099-0099-0099-0099-009900990099', 'a1111111-1111-1111-1111-111111111111', 'ALICE_DEVICE_2', 'alice-key2-curve', 'alice-key2-ed', 'Alice Tablet')$$,
    'RLS INSERT: authenticated user can insert own device key'
);
ROLLBACK TO sp_dk_ins_own;

-- 2.3 INSERT: authenticated user CANNOT insert with another user's user_id
SELECT authenticate_as('a1111111-1111-1111-1111-111111111111'); -- Alice
SELECT throws_ok(
    $$INSERT INTO device_keys (id, user_id, device_id, identity_key, signing_key, device_name)
      VALUES ('d00a0098-0098-0098-0098-009800980098', 'b2222222-2222-2222-2222-222222222222', 'SPOOF_DEVICE', 'spoof-curve', 'spoof-ed', 'Spoofed')$$,
    NULL, NULL,
    'RLS INSERT: authenticated user cannot insert device key for another user'
);

-- 2.4 UPDATE: authenticated user CAN update own row
-- WHY: lives_ok is false-positive — it passes even if 0 rows were updated.
-- We execute the UPDATE then verify the value actually changed.
SELECT clear_auth();
SAVEPOINT sp_dk_upd_own;
SELECT authenticate_as('a1111111-1111-1111-1111-111111111111'); -- Alice
UPDATE device_keys SET device_name = 'Alice Laptop (updated)' WHERE id = 'd00a0001-0001-0001-0001-000100010001';
SELECT clear_auth();
SELECT is(
    (SELECT device_name FROM device_keys WHERE id = 'd00a0001-0001-0001-0001-000100010001'),
    'Alice Laptop (updated)',
    'RLS UPDATE: authenticated user can update own device key'
);
ROLLBACK TO sp_dk_upd_own;

-- 2.5 UPDATE: authenticated user CANNOT update another user's row
-- WHY: UPDATE with RLS silently skips rows that don't match the USING clause.
-- We verify 0 rows were affected by checking the value is unchanged.
SELECT clear_auth();
SAVEPOINT sp_dk_upd_other;
SELECT authenticate_as('a1111111-1111-1111-1111-111111111111'); -- Alice
UPDATE device_keys SET device_name = 'HACKED' WHERE id = 'd00b0002-0002-0002-0002-000200020002';
SELECT clear_auth();
SELECT is(
    (SELECT device_name FROM device_keys WHERE id = 'd00b0002-0002-0002-0002-000200020002'),
    'Bob Phone',
    'RLS UPDATE: authenticated user cannot update another user''s device key'
);
ROLLBACK TO sp_dk_upd_other;

-- 2.6 DELETE: authenticated user CAN delete own row
-- WHY: lives_ok is false-positive — it passes even if 0 rows were deleted.
-- We execute the DELETE then verify the row is actually gone.
SELECT clear_auth();
SAVEPOINT sp_dk_del_own;
SELECT authenticate_as('a1111111-1111-1111-1111-111111111111'); -- Alice
DELETE FROM device_keys WHERE id = 'd00a0001-0001-0001-0001-000100010001';
SELECT clear_auth();
SELECT is(
    (SELECT count(*)::int FROM device_keys WHERE id = 'd00a0001-0001-0001-0001-000100010001'),
    0,
    'RLS DELETE: authenticated user can delete own device key'
);
ROLLBACK TO sp_dk_del_own;

-- 2.7 DELETE: authenticated user CANNOT delete another user's row
SELECT clear_auth();
SAVEPOINT sp_dk_del_other;
SELECT authenticate_as('a1111111-1111-1111-1111-111111111111'); -- Alice
DELETE FROM device_keys WHERE id = 'd00b0002-0002-0002-0002-000200020002';
SELECT clear_auth();
SELECT is(
    (SELECT count(*)::int FROM device_keys WHERE id = 'd00b0002-0002-0002-0002-000200020002'),
    1,
    'RLS DELETE: authenticated user cannot delete another user''s device key'
);
ROLLBACK TO sp_dk_del_other;

-- 2.8 Anonymous: CANNOT select
SELECT clear_auth();
SET LOCAL ROLE anon;
SELECT is(
    (SELECT count(*)::int FROM device_keys),
    0,
    'RLS SELECT: anonymous cannot see device keys'
);

-- 2.9 Anonymous: CANNOT insert
SET LOCAL ROLE anon;
SELECT throws_ok(
    $$INSERT INTO device_keys (id, user_id, device_id, identity_key, signing_key)
      VALUES ('d00f0001-0001-0001-0001-000100010001', 'a1111111-1111-1111-1111-111111111111', 'ANON_DEV', 'x', 'y')$$,
    NULL, NULL,
    'RLS INSERT: anonymous cannot insert device keys'
);

-- 2.10 Anonymous: CANNOT update
SET LOCAL ROLE anon;
-- WHY: anon sees 0 rows (SELECT policy is authenticated-only), so UPDATE affects nothing.
-- We verify the row is unchanged as postgres.
UPDATE device_keys SET device_name = 'HACKED_ANON' WHERE id = 'd00a0001-0001-0001-0001-000100010001';
SELECT clear_auth();
SELECT is(
    (SELECT device_name FROM device_keys WHERE id = 'd00a0001-0001-0001-0001-000100010001'),
    'Alice Laptop',
    'RLS UPDATE: anonymous cannot update device keys'
);

-- 2.11 Anonymous: CANNOT delete
SET LOCAL ROLE anon;
DELETE FROM device_keys WHERE id = 'd00a0001-0001-0001-0001-000100010001';
SELECT clear_auth();
SELECT is(
    (SELECT count(*)::int FROM device_keys WHERE id = 'd00a0001-0001-0001-0001-000100010001'),
    1,
    'RLS DELETE: anonymous cannot delete device keys'
);


-- ═══════════════════════════════════════════════════════════════
-- 3. SCHEMA TESTS — one_time_keys
-- ═══════════════════════════════════════════════════════════════

SELECT has_table('public', 'one_time_keys',
    'schema: one_time_keys table exists');

SELECT col_type_is('public', 'one_time_keys', 'id', 'uuid',
    'schema: one_time_keys.id is UUID');

SELECT col_type_is('public', 'one_time_keys', 'user_id', 'uuid',
    'schema: one_time_keys.user_id is UUID');

SELECT col_type_is('public', 'one_time_keys', 'device_id', 'text',
    'schema: one_time_keys.device_id is TEXT');

SELECT col_type_is('public', 'one_time_keys', 'key_id', 'text',
    'schema: one_time_keys.key_id is TEXT');

SELECT col_type_is('public', 'one_time_keys', 'public_key', 'text',
    'schema: one_time_keys.public_key is TEXT');

SELECT col_type_is('public', 'one_time_keys', 'is_fallback', 'boolean',
    'schema: one_time_keys.is_fallback is BOOLEAN');

SELECT col_type_is('public', 'one_time_keys', 'created_at', 'timestamp with time zone',
    'schema: one_time_keys.created_at is TIMESTAMPTZ');

-- NOT NULL constraints
SELECT col_not_null('public', 'one_time_keys', 'user_id',
    'schema: one_time_keys.user_id is NOT NULL');

SELECT col_not_null('public', 'one_time_keys', 'device_id',
    'schema: one_time_keys.device_id is NOT NULL');

SELECT col_not_null('public', 'one_time_keys', 'key_id',
    'schema: one_time_keys.key_id is NOT NULL');

SELECT col_not_null('public', 'one_time_keys', 'public_key',
    'schema: one_time_keys.public_key is NOT NULL');

SELECT col_not_null('public', 'one_time_keys', 'is_fallback',
    'schema: one_time_keys.is_fallback is NOT NULL');

SELECT col_not_null('public', 'one_time_keys', 'created_at',
    'schema: one_time_keys.created_at is NOT NULL');

-- Primary key
SELECT col_is_pk('public', 'one_time_keys', 'id',
    'schema: one_time_keys.id is primary key');

-- Unique constraint on (user_id, device_id, key_id)
SELECT col_is_unique('public', 'one_time_keys', ARRAY['user_id', 'device_id', 'key_id'],
    'schema: unique constraint one_time_keys_unique on (user_id, device_id, key_id)');

-- Foreign key: user_id -> profiles(id)
SELECT fk_ok('public', 'one_time_keys', 'user_id', 'public', 'profiles', 'id',
    'schema: one_time_keys.user_id FK -> profiles(id)');

-- WHY: pgTAP's fk_ok() does not support composite FK verification directly.
-- We verify the constraint exists by querying pg_constraint for the named FK.
SELECT is(
    (SELECT count(*)::int FROM pg_constraint
     WHERE conname = 'one_time_keys_device_fk'
       AND contype = 'f'
       AND conrelid = 'public.one_time_keys'::regclass),
    1,
    'schema: composite FK one_time_keys_device_fk -> device_keys(user_id, device_id) exists'
);

-- Index
SELECT has_index('public', 'one_time_keys', 'idx_one_time_keys_claim',
    'schema: index idx_one_time_keys_claim exists');

-- RLS enabled
SELECT row_level_security_is_on('public', 'one_time_keys',
    'schema: RLS is enabled on one_time_keys');


-- ═══════════════════════════════════════════════════════════════
-- 4. RLS TESTS — one_time_keys
-- ═══════════════════════════════════════════════════════════════

-- 4.1 SELECT: authenticated user CAN select all one-time keys
SELECT authenticate_as('b2222222-2222-2222-2222-222222222222'); -- Bob
SELECT is(
    (SELECT count(*)::int FROM one_time_keys),
    3,
    'RLS SELECT: authenticated user can see all one-time keys'
);

-- 4.2 INSERT: authenticated user CAN insert with own user_id
SELECT clear_auth();
SAVEPOINT sp_otk_ins_own;
SELECT authenticate_as('b2222222-2222-2222-2222-222222222222'); -- Bob
SELECT lives_ok(
    $$INSERT INTO one_time_keys (id, user_id, device_id, key_id, public_key, is_fallback)
      VALUES ('0e0b0099-0099-0099-0099-009900990099', 'b2222222-2222-2222-2222-222222222222', 'BOB_DEVICE_1', 'BBBBBZ', 'bob-new-otk-base64', false)$$,
    'RLS INSERT: authenticated user can insert own one-time key'
);
ROLLBACK TO sp_otk_ins_own;

-- 4.3 INSERT: authenticated user CANNOT insert for another user
SELECT authenticate_as('b2222222-2222-2222-2222-222222222222'); -- Bob
SELECT throws_ok(
    $$INSERT INTO one_time_keys (id, user_id, device_id, key_id, public_key, is_fallback)
      VALUES ('0e0b0098-0098-0098-0098-009800980098', 'a1111111-1111-1111-1111-111111111111', 'ALICE_DEVICE_1', 'SPOOF1', 'spoof-key', false)$$,
    NULL, NULL,
    'RLS INSERT: authenticated user cannot insert one-time key for another user'
);

-- 4.4 DELETE: authenticated user CAN delete own one-time key
-- WHY: lives_ok is false-positive — it passes even if 0 rows were deleted.
-- We execute the DELETE then verify the row is actually gone.
SELECT clear_auth();
SAVEPOINT sp_otk_del_own;
SELECT authenticate_as('b2222222-2222-2222-2222-222222222222'); -- Bob
DELETE FROM one_time_keys WHERE id = '0e0b0001-0001-0001-0001-000100010001';
SELECT clear_auth();
SELECT is(
    (SELECT count(*)::int FROM one_time_keys WHERE id = '0e0b0001-0001-0001-0001-000100010001'),
    0,
    'RLS DELETE: authenticated user can delete own one-time key'
);
ROLLBACK TO sp_otk_del_own;

-- 4.5 DELETE: authenticated user CANNOT delete another user's one-time key
SELECT clear_auth();
SAVEPOINT sp_otk_del_other;
SELECT authenticate_as('b2222222-2222-2222-2222-222222222222'); -- Bob
DELETE FROM one_time_keys WHERE id = '0e0a0001-0001-0001-0001-000100010001'; -- Alice's key
SELECT clear_auth();
SELECT is(
    (SELECT count(*)::int FROM one_time_keys WHERE id = '0e0a0001-0001-0001-0001-000100010001'),
    1,
    'RLS DELETE: authenticated user cannot delete another user''s one-time key'
);
ROLLBACK TO sp_otk_del_other;

-- 4.6 Anonymous: CANNOT select
SELECT clear_auth();
SET LOCAL ROLE anon;
SELECT is(
    (SELECT count(*)::int FROM one_time_keys),
    0,
    'RLS SELECT: anonymous cannot see one-time keys'
);

-- 4.7 Anonymous: CANNOT insert
SET LOCAL ROLE anon;
SELECT throws_ok(
    $$INSERT INTO one_time_keys (id, user_id, device_id, key_id, public_key, is_fallback)
      VALUES ('0e0f0001-0001-0001-0001-000100010001', 'a1111111-1111-1111-1111-111111111111', 'ALICE_DEVICE_1', 'ANON_K', 'anon-key', false)$$,
    NULL, NULL,
    'RLS INSERT: anonymous cannot insert one-time keys'
);

-- 4.8 Anonymous: CANNOT delete
SET LOCAL ROLE anon;
DELETE FROM one_time_keys WHERE id = '0e0a0001-0001-0001-0001-000100010001';
SELECT clear_auth();
SELECT is(
    (SELECT count(*)::int FROM one_time_keys WHERE id = '0e0a0001-0001-0001-0001-000100010001'),
    1,
    'RLS DELETE: anonymous cannot delete one-time keys'
);


-- ═══════════════════════════════════════════════════════════════
-- DONE
-- ═══════════════════════════════════════════════════════════════

SELECT clear_auth();
SELECT * FROM finish();
ROLLBACK;
