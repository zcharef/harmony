-- =============================================================
-- Channel Encryption Tests (20260322190000_add_channel_encryption)
--
-- Tests:
--   - Schema: channels.encrypted column, megolm_sessions table,
--     constraints, foreign keys, indexes
--   - RLS: megolm_sessions policies for authenticated, anonymous,
--     and service role
--   - Behavior: encrypted default, toggle on/off
--
-- Run via: supabase test db
-- =============================================================
BEGIN;
SET search_path TO public, extensions;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(34);


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

-- User IDs (deterministic UUIDs — same convention as rls_policies.test.sql)
-- Alice:   owner       a1111111-...
-- Bob:     member      b2222222-...
-- Eve:     non-member  e5555555-...

-- Auth users (Alice + Bob exist from seed; Eve needs inserting)
INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, is_sso_user, is_anonymous, confirmation_token, recovery_token, email_change_token_new, email_change)
VALUES
    ('e5555555-5555-5555-5555-555555555555', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'eve@harmony.test', crypt('password123', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Eve"}', now(), now(), false, false, '', '', '', '')
ON CONFLICT (id) DO NOTHING;

-- Profiles
INSERT INTO public.profiles (id, username, display_name)
VALUES
    ('a1111111-1111-1111-1111-111111111111', 'alice', 'Alice'),
    ('b2222222-2222-2222-2222-222222222222', 'bob', 'Bob'),
    ('e5555555-5555-5555-5555-555555555555', 'eve', 'Eve')
ON CONFLICT (id) DO NOTHING;

-- Test server
INSERT INTO public.servers (id, name, owner_id, is_dm, is_public)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Encryption Test Server', 'a1111111-1111-1111-1111-111111111111', false, true)
ON CONFLICT (id) DO NOTHING;

-- Server members: Alice = owner, Bob = member; Eve is NOT a member
INSERT INTO public.server_members (server_id, user_id, role)
VALUES
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a1111111-1111-1111-1111-111111111111', 'owner'),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'b2222222-2222-2222-2222-222222222222', 'member')
ON CONFLICT (server_id, user_id) DO NOTHING;

-- Channel for encryption tests (public, not encrypted by default)
INSERT INTO public.channels (id, server_id, name, channel_type, position)
VALUES ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'general', 'text', 0)
ON CONFLICT (id) DO NOTHING;

-- Seed a megolm_session row (as postgres, bypasses RLS) for SELECT tests
INSERT INTO public.megolm_sessions (id, channel_id, session_id, creator_id)
VALUES ('deadbeef-0001-0001-0001-000100010001', '11111111-1111-1111-1111-111111111111', 'session-alpha', 'a1111111-1111-1111-1111-111111111111')
ON CONFLICT (id) DO NOTHING;


-- ═══════════════════════════════════════════════════════════════
-- 1. SCHEMA TESTS — channels.encrypted column
-- ═══════════════════════════════════════════════════════════════

SELECT has_column('public', 'channels', 'encrypted',
    'schema: channels.encrypted column exists');

SELECT col_type_is('public', 'channels', 'encrypted', 'boolean',
    'schema: channels.encrypted is BOOLEAN');

SELECT col_not_null('public', 'channels', 'encrypted',
    'schema: channels.encrypted is NOT NULL');

SELECT col_default_is('public', 'channels', 'encrypted', 'false',
    'schema: channels.encrypted defaults to false');


-- ═══════════════════════════════════════════════════════════════
-- 2. SCHEMA TESTS — megolm_sessions table
-- ═══════════════════════════════════════════════════════════════

SELECT has_table('public', 'megolm_sessions',
    'schema: megolm_sessions table exists');

SELECT has_column('public', 'megolm_sessions', 'id',
    'schema: megolm_sessions.id column exists');

SELECT col_is_pk('public', 'megolm_sessions', 'id',
    'schema: megolm_sessions.id is primary key');

SELECT has_column('public', 'megolm_sessions', 'channel_id',
    'schema: megolm_sessions.channel_id column exists');

SELECT has_column('public', 'megolm_sessions', 'session_id',
    'schema: megolm_sessions.session_id column exists');

SELECT has_column('public', 'megolm_sessions', 'creator_id',
    'schema: megolm_sessions.creator_id column exists');

SELECT has_column('public', 'megolm_sessions', 'created_at',
    'schema: megolm_sessions.created_at column exists');

SELECT col_is_unique('public', 'megolm_sessions', ARRAY['channel_id', 'session_id'],
    'schema: unique constraint on (channel_id, session_id)');

SELECT fk_ok('public', 'megolm_sessions', 'channel_id', 'public', 'channels', 'id',
    'schema: megolm_sessions.channel_id FK -> channels(id)');

-- WHY: creator_id FK targets auth.users(id) directly per the migration
-- (20260322190000_add_channel_encryption.sql:L33).
SELECT fk_ok('public', 'megolm_sessions', 'creator_id', 'auth', 'users', 'id',
    'schema: megolm_sessions.creator_id FK -> auth.users(id)');

SELECT has_index('public', 'megolm_sessions', 'idx_megolm_sessions_channel_id',
    'schema: index idx_megolm_sessions_channel_id exists');

-- WHY: Verify RLS is actually enabled on the table — without this,
-- all the policy tests below would pass vacuously.
SELECT ok(
    (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.megolm_sessions'::regclass),
    'schema: RLS is enabled on megolm_sessions'
);

SELECT col_type_is('public', 'megolm_sessions', 'channel_id', 'uuid',
    'schema: megolm_sessions.channel_id is UUID');

SELECT col_type_is('public', 'megolm_sessions', 'session_id', 'text',
    'schema: megolm_sessions.session_id is TEXT');

SELECT col_type_is('public', 'megolm_sessions', 'creator_id', 'uuid',
    'schema: megolm_sessions.creator_id is UUID');

SELECT col_type_is('public', 'megolm_sessions', 'created_at', 'timestamp with time zone',
    'schema: megolm_sessions.created_at is TIMESTAMPTZ');

SELECT col_not_null('public', 'megolm_sessions', 'channel_id',
    'schema: megolm_sessions.channel_id is NOT NULL');

SELECT col_not_null('public', 'megolm_sessions', 'session_id',
    'schema: megolm_sessions.session_id is NOT NULL');

SELECT col_not_null('public', 'megolm_sessions', 'creator_id',
    'schema: megolm_sessions.creator_id is NOT NULL');

SELECT col_not_null('public', 'megolm_sessions', 'created_at',
    'schema: megolm_sessions.created_at is NOT NULL');


-- ═══════════════════════════════════════════════════════════════
-- 3. RLS TESTS — megolm_sessions
-- ═══════════════════════════════════════════════════════════════

-- 3.1 SELECT: authenticated member CAN see megolm_sessions
SELECT authenticate_as('b2222222-2222-2222-2222-222222222222'); -- Bob (member)
SELECT is(
    (SELECT count(*)::int FROM megolm_sessions WHERE channel_id = '11111111-1111-1111-1111-111111111111'),
    1,
    'RLS SELECT: authenticated member can see megolm_sessions'
);

-- 3.2 SELECT: authenticated non-member CANNOT see megolm_sessions
-- WHY: The policy (megolm_sessions_select_member) uses is_channel_member(channel_id)
-- which requires server membership. Non-members are correctly denied at the RLS level.
SELECT authenticate_as('e5555555-5555-5555-5555-555555555555'); -- Eve (non-member)
SELECT is(
    (SELECT count(*)::int FROM megolm_sessions WHERE channel_id = '11111111-1111-1111-1111-111111111111'),
    0,
    'RLS SELECT: authenticated non-member cannot see megolm_sessions'
);

-- 3.3 SELECT: anonymous CANNOT see megolm_sessions
SELECT clear_auth();
SET LOCAL ROLE anon;
SELECT is(
    (SELECT count(*)::int FROM megolm_sessions),
    0,
    'RLS SELECT: anonymous cannot see megolm_sessions'
);

-- 3.4 INSERT: authenticated user CAN insert own megolm_session (creator_id = own uid)
SET LOCAL ROLE postgres;
SAVEPOINT sp_megolm_ins_own;
SELECT authenticate_as('b2222222-2222-2222-2222-222222222222'); -- Bob
SELECT lives_ok(
    $$INSERT INTO megolm_sessions (id, channel_id, session_id, creator_id) VALUES ('deadbeef-0002-0002-0002-000200020002', '11111111-1111-1111-1111-111111111111', 'session-bob-1', 'b2222222-2222-2222-2222-222222222222')$$,
    'RLS INSERT: authenticated user can insert own megolm_session'
);
ROLLBACK TO sp_megolm_ins_own;

-- 3.5 INSERT: authenticated user CANNOT insert with someone else's creator_id
SELECT authenticate_as('b2222222-2222-2222-2222-222222222222'); -- Bob
SELECT throws_ok(
    $$INSERT INTO megolm_sessions (id, channel_id, session_id, creator_id) VALUES ('deadbeef-0003-0003-0003-000300030003', '11111111-1111-1111-1111-111111111111', 'session-spoof', 'a1111111-1111-1111-1111-111111111111')$$,
    NULL, NULL,
    'RLS INSERT: cannot insert megolm_session with another creator_id'
);

-- 3.6 INSERT: non-member CANNOT insert even with own creator_id
-- WHY: Different from the spoofed creator_id test above — here Eve uses
-- her real UID but she's not a server/channel member, so the
-- is_channel_member(channel_id) check in the INSERT policy blocks her.
SELECT clear_auth();
SELECT authenticate_as('e5555555-5555-5555-5555-555555555555'); -- Eve (non-member)
SELECT throws_ok(
    $$INSERT INTO megolm_sessions (id, channel_id, session_id, creator_id) VALUES ('deadbeef-0005-0005-0005-000500050005', '11111111-1111-1111-1111-111111111111', 'session-eve-own', 'e5555555-5555-5555-5555-555555555555')$$,
    NULL, NULL,
    'RLS INSERT: non-member cannot insert megolm_session even with own creator_id'
);

-- 3.7 INSERT: anonymous CANNOT insert megolm_session
SELECT clear_auth();
SET LOCAL ROLE anon;
SELECT throws_ok(
    $$INSERT INTO megolm_sessions (id, channel_id, session_id, creator_id) VALUES ('deadbeef-0004-0004-0004-000400040004', '11111111-1111-1111-1111-111111111111', 'session-anon', 'e5555555-5555-5555-5555-555555555555')$$,
    NULL, NULL,
    'RLS INSERT: anonymous cannot insert megolm_session'
);

-- 3.8 SELECT: service role (postgres) CAN see all rows
SET LOCAL ROLE postgres;
SELECT cmp_ok(
    (SELECT count(*)::int FROM megolm_sessions),
    '>=', 1,
    'RLS SELECT: service role (postgres) can see all megolm_sessions'
);


-- ═══════════════════════════════════════════════════════════════
-- 4. BEHAVIOR TESTS — channel encryption flag
-- ═══════════════════════════════════════════════════════════════

-- 4.1 Creating a channel defaults encrypted to false
SAVEPOINT sp_enc_default;
SELECT clear_auth();
INSERT INTO public.channels (id, server_id, name, channel_type, position)
VALUES ('44444444-4444-4444-4444-444444444444', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'new-channel', 'text', 3);
SELECT is(
    (SELECT encrypted FROM channels WHERE id = '44444444-4444-4444-4444-444444444444'),
    false,
    'behavior: new channel defaults encrypted to false'
);
ROLLBACK TO sp_enc_default;

-- 4.2 Updating encrypted from false to true succeeds
SAVEPOINT sp_enc_on;
SELECT clear_auth();
UPDATE public.channels SET encrypted = true WHERE id = '11111111-1111-1111-1111-111111111111';
SELECT is(
    (SELECT encrypted FROM channels WHERE id = '11111111-1111-1111-1111-111111111111'),
    true,
    'behavior: can set encrypted from false to true'
);
ROLLBACK TO sp_enc_on;


-- ═══════════════════════════════════════════════════════════════
-- DONE
-- ═══════════════════════════════════════════════════════════════

SELECT clear_auth();
SELECT * FROM finish();
ROLLBACK;
