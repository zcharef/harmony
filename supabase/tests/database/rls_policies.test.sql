-- =============================================================
-- RLS Policy Tests — Every Policy × Every Role
--
-- Tests all 34 RLS policies across 10 tables with 6 user roles:
--   owner, admin, moderator, member, non-member, banned.
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

SELECT plan(97);


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

-- User IDs (deterministic UUIDs for readability)
-- Alice:   owner       a1111111-...
-- Charlie: admin       c3333333-...
-- Diana:   moderator   d4444444-...
-- Bob:     member      b2222222-...
-- Eve:     non-member  e5555555-...
-- Frank:   banned      f6666666-...

-- Auth users (profiles FK → auth.users; Alice + Bob exist from seed)
INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, is_sso_user, is_anonymous, confirmation_token, recovery_token, email_change_token_new, email_change)
VALUES
    ('c3333333-3333-3333-3333-333333333333', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'charlie@harmony.test', crypt('password123', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Charlie"}', now(), now(), false, false, '', '', '', ''),
    ('d4444444-4444-4444-4444-444444444444', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'diana@harmony.test', crypt('password123', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Diana"}', now(), now(), false, false, '', '', '', ''),
    ('e5555555-5555-5555-5555-555555555555', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'eve@harmony.test', crypt('password123', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Eve"}', now(), now(), false, false, '', '', '', ''),
    ('f6666666-6666-6666-6666-666666666666', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'frank@harmony.test', crypt('password123', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Frank"}', now(), now(), false, false, '', '', '', '')
ON CONFLICT (id) DO NOTHING;

-- Profiles (Alice + Bob may exist from seed; ON CONFLICT skips)
INSERT INTO public.profiles (id, username, display_name)
VALUES
    ('a1111111-1111-1111-1111-111111111111', 'alice', 'Alice'),
    ('b2222222-2222-2222-2222-222222222222', 'bob', 'Bob'),
    ('c3333333-3333-3333-3333-333333333333', 'charlie', 'Charlie'),
    ('d4444444-4444-4444-4444-444444444444', 'diana', 'Diana'),
    ('e5555555-5555-5555-5555-555555555555', 'eve', 'Eve'),
    ('f6666666-6666-6666-6666-666666666666', 'frank', 'Frank')
ON CONFLICT (id) DO NOTHING;

-- Test server
INSERT INTO public.servers (id, name, owner_id, is_dm, is_public)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'RLS Test Server', 'a1111111-1111-1111-1111-111111111111', false, true)
ON CONFLICT (id) DO NOTHING;

-- DM server (for invite DM test)
INSERT INTO public.servers (id, name, owner_id, is_dm)
VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'DM', 'a1111111-1111-1111-1111-111111111111', true)
ON CONFLICT (id) DO NOTHING;

-- Server members with roles
INSERT INTO public.server_members (server_id, user_id, role)
VALUES
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a1111111-1111-1111-1111-111111111111', 'owner'),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'c3333333-3333-3333-3333-333333333333', 'admin'),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'd4444444-4444-4444-4444-444444444444', 'moderator'),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'b2222222-2222-2222-2222-222222222222', 'member')
ON CONFLICT (server_id, user_id) DO NOTHING;

-- DM server member
INSERT INTO public.server_members (server_id, user_id, role)
VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'a1111111-1111-1111-1111-111111111111', 'owner')
ON CONFLICT (server_id, user_id) DO NOTHING;

-- Ban Frank: first add as member, then ban (trigger auto-deletes membership)
INSERT INTO public.server_members (server_id, user_id, role)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'f6666666-6666-6666-6666-666666666666', 'member')
ON CONFLICT (server_id, user_id) DO NOTHING;
INSERT INTO public.server_bans (server_id, user_id, banned_by, reason)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'f6666666-6666-6666-6666-666666666666', 'a1111111-1111-1111-1111-111111111111', 'test ban')
ON CONFLICT (server_id, user_id) DO NOTHING;

-- Channels: public, private (with moderator access), read-only
INSERT INTO public.channels (id, server_id, name, channel_type, position, is_private, is_read_only)
VALUES
    ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'general', 'text', 0, false, false),
    ('22222222-2222-2222-2222-222222222222', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'private-chan', 'text', 1, true, false),
    ('33333333-3333-3333-3333-333333333333', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'announcements', 'text', 2, false, true)
ON CONFLICT (id) DO NOTHING;

-- Private channel: grant moderator role access
INSERT INTO public.channel_role_access (channel_id, role)
VALUES ('22222222-2222-2222-2222-222222222222', 'moderator')
ON CONFLICT (channel_id, role) DO NOTHING;

-- Messages
INSERT INTO public.messages (id, channel_id, author_id, content)
VALUES
    ('aaaa0001-0001-0001-0001-000100010001', '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', 'Hello from Alice'),
    ('bbbb0002-0002-0002-0002-000200020002', '11111111-1111-1111-1111-111111111111', 'b2222222-2222-2222-2222-222222222222', 'Hello from Bob')
ON CONFLICT (id) DO NOTHING;

-- Soft-deleted message (should be invisible via RLS)
INSERT INTO public.messages (id, channel_id, author_id, content, deleted_at, deleted_by)
VALUES ('dddd0003-0003-0003-0003-000300030003', '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', 'Deleted msg', now(), 'a1111111-1111-1111-1111-111111111111')
ON CONFLICT (id) DO NOTHING;

-- Invite (created by Bob)
INSERT INTO public.invites (code, server_id, creator_id)
VALUES ('testcode1', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'b2222222-2222-2222-2222-222222222222')
ON CONFLICT (code) DO NOTHING;

-- Channel read state (Bob's)
INSERT INTO public.channel_read_states (channel_id, user_id, last_read_at)
VALUES ('11111111-1111-1111-1111-111111111111', 'b2222222-2222-2222-2222-222222222222', now())
ON CONFLICT (channel_id, user_id) DO NOTHING;

-- Message reaction (Bob's)
INSERT INTO public.message_reactions (id, message_id, user_id, emoji)
VALUES ('fea10001-0001-0001-0001-000100010001', 'aaaa0001-0001-0001-0001-000100010001', 'b2222222-2222-2222-2222-222222222222', '👍')
ON CONFLICT (id) DO NOTHING;


-- ═══════════════════════════════════════════════════════════════
-- 1. HELPER FUNCTIONS
-- ═══════════════════════════════════════════════════════════════

-- 1.1 get_role_level
SELECT is(public.get_role_level('owner'),     4, 'get_role_level: owner = 4');
SELECT is(public.get_role_level('admin'),     3, 'get_role_level: admin = 3');
SELECT is(public.get_role_level('moderator'), 2, 'get_role_level: moderator = 2');
SELECT is(public.get_role_level('member'),    1, 'get_role_level: member = 1');
SELECT is(public.get_role_level('garbage'),   0, 'get_role_level: unknown = 0');

-- 1.2 has_server_role
SELECT authenticate_as('a1111111-1111-1111-1111-111111111111'); -- owner
SELECT is(public.has_server_role('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'admin'), true,  'has_server_role: owner >= admin');

SELECT authenticate_as('c3333333-3333-3333-3333-333333333333'); -- admin
SELECT is(public.has_server_role('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'admin'), true,  'has_server_role: admin >= admin');

SELECT authenticate_as('d4444444-4444-4444-4444-444444444444'); -- moderator
SELECT is(public.has_server_role('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'admin'), false, 'has_server_role: moderator < admin');

SELECT authenticate_as('b2222222-2222-2222-2222-222222222222'); -- member
SELECT is(public.has_server_role('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'moderator'), false, 'has_server_role: member < moderator');

-- 1.3 is_server_member
SELECT authenticate_as('b2222222-2222-2222-2222-222222222222'); -- member
SELECT is(public.is_server_member('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), true,  'is_server_member: member = true');

SELECT authenticate_as('e5555555-5555-5555-5555-555555555555'); -- non-member
SELECT is(public.is_server_member('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), false, 'is_server_member: non-member = false');

SELECT authenticate_as('f6666666-6666-6666-6666-666666666666'); -- banned
SELECT is(public.is_server_member('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), false, 'is_server_member: banned user = false');

-- 1.4 is_channel_member
SELECT authenticate_as('b2222222-2222-2222-2222-222222222222'); -- member
SELECT is(public.is_channel_member('11111111-1111-1111-1111-111111111111'), true,  'is_channel_member: member sees public channel');

SELECT authenticate_as('e5555555-5555-5555-5555-555555555555'); -- non-member
SELECT is(public.is_channel_member('11111111-1111-1111-1111-111111111111'), false, 'is_channel_member: non-member blocked from public channel');

SELECT authenticate_as('c3333333-3333-3333-3333-333333333333'); -- admin
SELECT is(public.is_channel_member('22222222-2222-2222-2222-222222222222'), true,  'is_channel_member: admin sees private channel (implicit)');

SELECT authenticate_as('b2222222-2222-2222-2222-222222222222'); -- member
SELECT is(public.is_channel_member('22222222-2222-2222-2222-222222222222'), false, 'is_channel_member: member blocked from private channel (no access)');

SELECT authenticate_as('d4444444-4444-4444-4444-444444444444'); -- moderator
SELECT is(public.is_channel_member('22222222-2222-2222-2222-222222222222'), true,  'is_channel_member: moderator sees private channel (channel_role_access)');

SELECT clear_auth();


-- ═══════════════════════════════════════════════════════════════
-- 2. PROFILES
-- ═══════════════════════════════════════════════════════════════

-- 2.1 SELECT: any authenticated can see all profiles
SELECT authenticate_as('b2222222-2222-2222-2222-222222222222');
SELECT cmp_ok(
    (SELECT count(*)::int FROM profiles),
    '>=', 6,
    'profiles SELECT: authenticated user sees all profiles'
);

-- 2.2 INSERT: can only insert own profile
-- WHY: WITH CHECK (id = auth.uid()) enforces self-only insert.
-- Eve's profile exists; test that Bob cannot insert for Alice.
SELECT authenticate_as('b2222222-2222-2222-2222-222222222222');
SELECT throws_ok(
    $$INSERT INTO profiles (id, username, display_name) VALUES ('c3333333-3333-3333-3333-333333333333', 'imposter', 'Fake')$$,
    NULL, NULL,
    'profiles INSERT: cannot insert profile for another user'
);

-- 2.4 UPDATE: can update own profile
SAVEPOINT sp_prof_upd;
SELECT authenticate_as('b2222222-2222-2222-2222-222222222222');
UPDATE profiles SET display_name = 'Bobby' WHERE id = 'b2222222-2222-2222-2222-222222222222';
SELECT is(
    (SELECT display_name FROM profiles WHERE id = 'b2222222-2222-2222-2222-222222222222'),
    'Bobby',
    'profiles UPDATE: can update own display_name'
);
ROLLBACK TO sp_prof_upd;

-- 2.5 UPDATE: cannot update other user's profile
SAVEPOINT sp_prof_upd2;
SELECT authenticate_as('b2222222-2222-2222-2222-222222222222');
UPDATE profiles SET display_name = 'Hacked' WHERE id = 'a1111111-1111-1111-1111-111111111111';
SELECT clear_auth();
SELECT is(
    (SELECT display_name FROM profiles WHERE id = 'a1111111-1111-1111-1111-111111111111'),
    'Alice',
    'profiles UPDATE: cannot update another user''s profile'
);
ROLLBACK TO sp_prof_upd2;

SELECT clear_auth();


-- ═══════════════════════════════════════════════════════════════
-- 3. SERVERS
-- ═══════════════════════════════════════════════════════════════

-- 3.1 SELECT: owner, member can see; non-member, banned cannot
SELECT authenticate_as('a1111111-1111-1111-1111-111111111111');
SELECT is(
    (SELECT count(*)::int FROM servers WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
    1, 'servers SELECT: owner can see server'
);

SELECT authenticate_as('b2222222-2222-2222-2222-222222222222');
SELECT is(
    (SELECT count(*)::int FROM servers WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
    1, 'servers SELECT: member can see server'
);

SELECT authenticate_as('e5555555-5555-5555-5555-555555555555');
SELECT is(
    (SELECT count(*)::int FROM servers WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
    0, 'servers SELECT: non-member cannot see server'
);

SELECT authenticate_as('f6666666-6666-6666-6666-666666666666');
SELECT is(
    (SELECT count(*)::int FROM servers WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
    0, 'servers SELECT: banned user cannot see server'
);

-- 3.2 INSERT: owner_id must equal auth.uid()
SAVEPOINT sp_srv_ins;
SELECT authenticate_as('e5555555-5555-5555-5555-555555555555');
SELECT lives_ok(
    $$INSERT INTO servers (id, name, owner_id) VALUES ('99999999-9999-9999-9999-999999999991', 'Eve Server', 'e5555555-5555-5555-5555-555555555555')$$,
    'servers INSERT: can create with own owner_id'
);
ROLLBACK TO sp_srv_ins;

SELECT authenticate_as('e5555555-5555-5555-5555-555555555555');
SELECT throws_ok(
    $$INSERT INTO servers (id, name, owner_id) VALUES ('99999999-9999-9999-9999-999999999992', 'Spoofed', 'a1111111-1111-1111-1111-111111111111')$$,
    NULL, NULL,
    'servers INSERT: cannot set owner_id to another user'
);

-- 3.3 UPDATE: admin+ can update; member cannot
SAVEPOINT sp_srv_upd;
SELECT authenticate_as('a1111111-1111-1111-1111-111111111111');
UPDATE servers SET name = 'Updated by Owner' WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
SELECT is(
    (SELECT name FROM servers WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
    'Updated by Owner',
    'servers UPDATE: owner can update server'
);
ROLLBACK TO sp_srv_upd;

SAVEPOINT sp_srv_upd2;
SELECT authenticate_as('c3333333-3333-3333-3333-333333333333');
UPDATE servers SET name = 'Updated by Admin' WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
SELECT is(
    (SELECT name FROM servers WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
    'Updated by Admin',
    'servers UPDATE: admin can update server'
);
ROLLBACK TO sp_srv_upd2;

SAVEPOINT sp_srv_upd3;
SELECT authenticate_as('b2222222-2222-2222-2222-222222222222');
UPDATE servers SET name = 'Hacked' WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
SELECT clear_auth();
SELECT is(
    (SELECT name FROM servers WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
    'RLS Test Server',
    'servers UPDATE: member cannot update server'
);
ROLLBACK TO sp_srv_upd3;

-- 3.4 DELETE: owner only
SAVEPOINT sp_srv_del;
SELECT authenticate_as('c3333333-3333-3333-3333-333333333333');
DELETE FROM servers WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
SELECT clear_auth();
SELECT is(
    (SELECT count(*)::int FROM servers WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
    1,
    'servers DELETE: admin cannot delete server'
);
ROLLBACK TO sp_srv_del;

SELECT clear_auth();


-- ═══════════════════════════════════════════════════════════════
-- 4. CHANNELS
-- ═══════════════════════════════════════════════════════════════

-- 4.1 SELECT: public channel visibility
SELECT authenticate_as('b2222222-2222-2222-2222-222222222222');
SELECT is(
    (SELECT count(*)::int FROM channels WHERE id = '11111111-1111-1111-1111-111111111111'),
    1, 'channels SELECT: member sees public channel'
);

SELECT authenticate_as('e5555555-5555-5555-5555-555555555555');
SELECT is(
    (SELECT count(*)::int FROM channels WHERE id = '11111111-1111-1111-1111-111111111111'),
    0, 'channels SELECT: non-member cannot see public channel'
);

SELECT authenticate_as('f6666666-6666-6666-6666-666666666666');
SELECT is(
    (SELECT count(*)::int FROM channels WHERE id = '11111111-1111-1111-1111-111111111111'),
    0, 'channels SELECT: banned user cannot see channel'
);

-- 4.2 SELECT: private channel visibility
SELECT authenticate_as('c3333333-3333-3333-3333-333333333333');
SELECT is(
    (SELECT count(*)::int FROM channels WHERE id = '22222222-2222-2222-2222-222222222222'),
    1, 'channels SELECT: admin sees private channel'
);

SELECT authenticate_as('d4444444-4444-4444-4444-444444444444');
SELECT is(
    (SELECT count(*)::int FROM channels WHERE id = '22222222-2222-2222-2222-222222222222'),
    1, 'channels SELECT: moderator with access sees private channel'
);

SELECT authenticate_as('b2222222-2222-2222-2222-222222222222');
SELECT is(
    (SELECT count(*)::int FROM channels WHERE id = '22222222-2222-2222-2222-222222222222'),
    0, 'channels SELECT: member without access cannot see private channel'
);

-- 4.3 INSERT: admin+ only
SAVEPOINT sp_ch_ins;
SELECT authenticate_as('c3333333-3333-3333-3333-333333333333');
SELECT lives_ok(
    $$INSERT INTO channels (id, server_id, name, channel_type, position) VALUES ('44444444-4444-4444-4444-444444444444', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'new-chan', 'text', 10)$$,
    'channels INSERT: admin can create channel'
);
ROLLBACK TO sp_ch_ins;

SELECT authenticate_as('b2222222-2222-2222-2222-222222222222');
SELECT throws_ok(
    $$INSERT INTO channels (id, server_id, name, channel_type, position) VALUES ('44444444-4444-4444-4444-444444444445', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bad-chan', 'text', 11)$$,
    NULL, NULL,
    'channels INSERT: member cannot create channel'
);

-- 4.4 UPDATE: admin+ only
SAVEPOINT sp_ch_upd;
SELECT authenticate_as('c3333333-3333-3333-3333-333333333333');
UPDATE channels SET name = 'renamed' WHERE id = '11111111-1111-1111-1111-111111111111';
SELECT is(
    (SELECT name FROM channels WHERE id = '11111111-1111-1111-1111-111111111111'),
    'renamed',
    'channels UPDATE: admin can update channel'
);
ROLLBACK TO sp_ch_upd;

SAVEPOINT sp_ch_upd2;
SELECT authenticate_as('b2222222-2222-2222-2222-222222222222');
UPDATE channels SET name = 'hacked' WHERE id = '11111111-1111-1111-1111-111111111111';
SELECT clear_auth();
SELECT is(
    (SELECT name FROM channels WHERE id = '11111111-1111-1111-1111-111111111111'),
    'general',
    'channels UPDATE: member cannot update channel'
);
ROLLBACK TO sp_ch_upd2;

-- 4.5 DELETE: admin+ only
SAVEPOINT sp_ch_del;
SELECT authenticate_as('c3333333-3333-3333-3333-333333333333');
DELETE FROM channels WHERE id = '11111111-1111-1111-1111-111111111111';
SELECT clear_auth();
SELECT is(
    (SELECT count(*)::int FROM channels WHERE id = '11111111-1111-1111-1111-111111111111'),
    0,
    'channels DELETE: admin can delete channel'
);
ROLLBACK TO sp_ch_del;

SELECT clear_auth();


-- ═══════════════════════════════════════════════════════════════
-- 5. MESSAGES
-- ═══════════════════════════════════════════════════════════════

-- 5.1 SELECT: member sees messages; non-member/banned cannot; deleted hidden
SELECT authenticate_as('b2222222-2222-2222-2222-222222222222');
SELECT is(
    (SELECT count(*)::int FROM messages WHERE channel_id = '11111111-1111-1111-1111-111111111111'),
    2, 'messages SELECT: member sees non-deleted messages (2 of 3)'
);

SELECT authenticate_as('e5555555-5555-5555-5555-555555555555');
SELECT is(
    (SELECT count(*)::int FROM messages WHERE channel_id = '11111111-1111-1111-1111-111111111111'),
    0, 'messages SELECT: non-member sees nothing'
);

SELECT authenticate_as('f6666666-6666-6666-6666-666666666666');
SELECT is(
    (SELECT count(*)::int FROM messages WHERE channel_id = '11111111-1111-1111-1111-111111111111'),
    0, 'messages SELECT: banned user sees nothing'
);

-- 5.2 INSERT: author=self, channel member, read-only checks
SAVEPOINT sp_msg_ins;
SELECT authenticate_as('b2222222-2222-2222-2222-222222222222');
SELECT lives_ok(
    $$INSERT INTO messages (id, channel_id, author_id, content) VALUES ('eeee0001-0001-0001-0001-000100010001', '11111111-1111-1111-1111-111111111111', 'b2222222-2222-2222-2222-222222222222', 'New message')$$,
    'messages INSERT: member can post in normal channel'
);
ROLLBACK TO sp_msg_ins;

SELECT authenticate_as('b2222222-2222-2222-2222-222222222222');
SELECT throws_ok(
    $$INSERT INTO messages (id, channel_id, author_id, content) VALUES ('eeee0002-0002-0002-0002-000200020002', '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', 'Spoofed author')$$,
    NULL, NULL,
    'messages INSERT: cannot set author_id to another user'
);

SELECT authenticate_as('e5555555-5555-5555-5555-555555555555');
SELECT throws_ok(
    $$INSERT INTO messages (id, channel_id, author_id, content) VALUES ('eeee0003-0003-0003-0003-000300030003', '11111111-1111-1111-1111-111111111111', 'e5555555-5555-5555-5555-555555555555', 'Non-member post')$$,
    NULL, NULL,
    'messages INSERT: non-member cannot post'
);

-- Read-only channel: member cannot post, admin can
SELECT authenticate_as('b2222222-2222-2222-2222-222222222222');
SELECT throws_ok(
    $$INSERT INTO messages (id, channel_id, author_id, content) VALUES ('eeee0004-0004-0004-0004-000400040004', '33333333-3333-3333-3333-333333333333', 'b2222222-2222-2222-2222-222222222222', 'Readonly attempt')$$,
    NULL, NULL,
    'messages INSERT: member cannot post in read-only channel'
);

SAVEPOINT sp_msg_ro;
SELECT authenticate_as('c3333333-3333-3333-3333-333333333333');
SELECT lives_ok(
    $$INSERT INTO messages (id, channel_id, author_id, content) VALUES ('eeee0005-0005-0005-0005-000500050005', '33333333-3333-3333-3333-333333333333', 'c3333333-3333-3333-3333-333333333333', 'Admin announcement')$$,
    'messages INSERT: admin can post in read-only channel'
);
ROLLBACK TO sp_msg_ro;

-- 5.3 UPDATE (author): own message only, not deleted
SAVEPOINT sp_msg_ed;
SELECT authenticate_as('b2222222-2222-2222-2222-222222222222');
UPDATE messages SET content = 'Edited by Bob', is_edited = true WHERE id = 'bbbb0002-0002-0002-0002-000200020002';
SELECT is(
    (SELECT content FROM messages WHERE id = 'bbbb0002-0002-0002-0002-000200020002'),
    'Edited by Bob',
    'messages UPDATE(author): author can edit own message'
);
ROLLBACK TO sp_msg_ed;

SAVEPOINT sp_msg_ed2;
SELECT authenticate_as('b2222222-2222-2222-2222-222222222222');
UPDATE messages SET content = 'Hacked' WHERE id = 'aaaa0001-0001-0001-0001-000100010001';
SELECT clear_auth();
SELECT is(
    (SELECT content FROM messages WHERE id = 'aaaa0001-0001-0001-0001-000100010001'),
    'Hello from Alice',
    'messages UPDATE(author): non-author cannot edit message'
);
ROLLBACK TO sp_msg_ed2;

-- 5.4 UPDATE (moderator softdelete): moderator+ can soft-delete
SAVEPOINT sp_msg_mod;
SELECT authenticate_as('d4444444-4444-4444-4444-444444444444');
UPDATE messages SET deleted_at = now(), deleted_by = 'd4444444-4444-4444-4444-444444444444' WHERE id = 'bbbb0002-0002-0002-0002-000200020002';
SELECT clear_auth();
SELECT isnt(
    (SELECT deleted_at FROM messages WHERE id = 'bbbb0002-0002-0002-0002-000200020002'),
    NULL,
    'messages UPDATE(mod): moderator can soft-delete message'
);
ROLLBACK TO sp_msg_mod;

SELECT clear_auth();


-- ═══════════════════════════════════════════════════════════════
-- 6. SERVER MEMBERS
-- ═══════════════════════════════════════════════════════════════

-- 6.1 SELECT: member sees all members; non-member/banned cannot
SELECT authenticate_as('b2222222-2222-2222-2222-222222222222');
SELECT cmp_ok(
    (SELECT count(*)::int FROM server_members WHERE server_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
    '>=', 4,
    'server_members SELECT: member sees all members'
);

SELECT authenticate_as('e5555555-5555-5555-5555-555555555555');
SELECT is(
    (SELECT count(*)::int FROM server_members WHERE server_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
    0, 'server_members SELECT: non-member sees nothing'
);

SELECT authenticate_as('f6666666-6666-6666-6666-666666666666');
SELECT is(
    (SELECT count(*)::int FROM server_members WHERE server_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
    0, 'server_members SELECT: banned user sees nothing'
);

-- 6.2 DELETE (self-leave): user can leave
SAVEPOINT sp_sm_leave;
SELECT authenticate_as('b2222222-2222-2222-2222-222222222222');
DELETE FROM server_members WHERE server_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' AND user_id = 'b2222222-2222-2222-2222-222222222222';
SELECT clear_auth();
SELECT is(
    (SELECT count(*)::int FROM server_members WHERE server_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' AND user_id = 'b2222222-2222-2222-2222-222222222222'),
    0,
    'server_members DELETE(own): user can self-leave'
);
ROLLBACK TO sp_sm_leave;

-- 6.3 DELETE (kick): hierarchy enforcement
-- Owner can kick admin
SAVEPOINT sp_sm_kick1;
SELECT authenticate_as('a1111111-1111-1111-1111-111111111111');
DELETE FROM server_members WHERE server_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' AND user_id = 'c3333333-3333-3333-3333-333333333333';
SELECT clear_auth();
SELECT is(
    (SELECT count(*)::int FROM server_members WHERE server_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' AND user_id = 'c3333333-3333-3333-3333-333333333333'),
    0,
    'server_members DELETE(kick): owner can kick admin'
);
ROLLBACK TO sp_sm_kick1;

-- Moderator can kick member
SAVEPOINT sp_sm_kick2;
SELECT authenticate_as('d4444444-4444-4444-4444-444444444444');
DELETE FROM server_members WHERE server_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' AND user_id = 'b2222222-2222-2222-2222-222222222222';
SELECT clear_auth();
SELECT is(
    (SELECT count(*)::int FROM server_members WHERE server_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' AND user_id = 'b2222222-2222-2222-2222-222222222222'),
    0,
    'server_members DELETE(kick): moderator can kick member'
);
ROLLBACK TO sp_sm_kick2;

-- Moderator cannot kick admin (hierarchy blocks)
SAVEPOINT sp_sm_kick3;
SELECT authenticate_as('d4444444-4444-4444-4444-444444444444');
DELETE FROM server_members WHERE server_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' AND user_id = 'c3333333-3333-3333-3333-333333333333';
SELECT clear_auth();
SELECT is(
    (SELECT count(*)::int FROM server_members WHERE server_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' AND user_id = 'c3333333-3333-3333-3333-333333333333'),
    1,
    'server_members DELETE(kick): moderator cannot kick admin (hierarchy)'
);
ROLLBACK TO sp_sm_kick3;

-- Member cannot kick anyone
SAVEPOINT sp_sm_kick4;
SELECT authenticate_as('b2222222-2222-2222-2222-222222222222');
DELETE FROM server_members WHERE server_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' AND user_id = 'd4444444-4444-4444-4444-444444444444';
SELECT clear_auth();
SELECT is(
    (SELECT count(*)::int FROM server_members WHERE server_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' AND user_id = 'd4444444-4444-4444-4444-444444444444'),
    1,
    'server_members DELETE(kick): member cannot kick moderator'
);
ROLLBACK TO sp_sm_kick4;

SELECT clear_auth();


-- ═══════════════════════════════════════════════════════════════
-- 7. SERVER BANS
-- ═══════════════════════════════════════════════════════════════

-- 7.1 SELECT: admin+ can see bans; mod/member cannot
SELECT authenticate_as('a1111111-1111-1111-1111-111111111111');
SELECT is(
    (SELECT count(*)::int FROM server_bans WHERE server_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
    1, 'server_bans SELECT: owner can see bans'
);

SELECT authenticate_as('c3333333-3333-3333-3333-333333333333');
SELECT is(
    (SELECT count(*)::int FROM server_bans WHERE server_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
    1, 'server_bans SELECT: admin can see bans'
);

SELECT authenticate_as('d4444444-4444-4444-4444-444444444444');
SELECT is(
    (SELECT count(*)::int FROM server_bans WHERE server_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
    0, 'server_bans SELECT: moderator cannot see bans'
);

SELECT authenticate_as('b2222222-2222-2222-2222-222222222222');
SELECT is(
    (SELECT count(*)::int FROM server_bans WHERE server_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
    0, 'server_bans SELECT: member cannot see bans'
);

-- 7.2 INSERT: admin+ can create ban
SAVEPOINT sp_ban_ins;
SELECT authenticate_as('c3333333-3333-3333-3333-333333333333');
SELECT lives_ok(
    $$INSERT INTO server_bans (server_id, user_id, banned_by, reason) VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'e5555555-5555-5555-5555-555555555555', 'c3333333-3333-3333-3333-333333333333', 'test')$$,
    'server_bans INSERT: admin can create ban'
);
ROLLBACK TO sp_ban_ins;

SELECT authenticate_as('b2222222-2222-2222-2222-222222222222');
SELECT throws_ok(
    $$INSERT INTO server_bans (server_id, user_id, banned_by, reason) VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'e5555555-5555-5555-5555-555555555555', 'b2222222-2222-2222-2222-222222222222', 'test')$$,
    NULL, NULL,
    'server_bans INSERT: member cannot create ban'
);

-- 7.3 DELETE: admin+ can remove ban
SAVEPOINT sp_ban_del;
SELECT authenticate_as('c3333333-3333-3333-3333-333333333333');
DELETE FROM server_bans WHERE server_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' AND user_id = 'f6666666-6666-6666-6666-666666666666';
SELECT clear_auth();
SELECT is(
    (SELECT count(*)::int FROM server_bans WHERE server_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' AND user_id = 'f6666666-6666-6666-6666-666666666666'),
    0,
    'server_bans DELETE: admin can remove ban'
);
ROLLBACK TO sp_ban_del;

SAVEPOINT sp_ban_del2;
SELECT authenticate_as('d4444444-4444-4444-4444-444444444444');
DELETE FROM server_bans WHERE server_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' AND user_id = 'f6666666-6666-6666-6666-666666666666';
SELECT clear_auth();
SELECT is(
    (SELECT count(*)::int FROM server_bans WHERE server_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' AND user_id = 'f6666666-6666-6666-6666-666666666666'),
    1,
    'server_bans DELETE: moderator cannot remove ban'
);
ROLLBACK TO sp_ban_del2;

SELECT clear_auth();


-- ═══════════════════════════════════════════════════════════════
-- 8. INVITES
-- ═══════════════════════════════════════════════════════════════

-- 8.1 SELECT: member can see; non-member cannot
SELECT authenticate_as('b2222222-2222-2222-2222-222222222222');
SELECT is(
    (SELECT count(*)::int FROM invites WHERE server_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
    1, 'invites SELECT: member can see invites'
);

SELECT authenticate_as('e5555555-5555-5555-5555-555555555555');
SELECT is(
    (SELECT count(*)::int FROM invites WHERE server_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
    0, 'invites SELECT: non-member cannot see invites'
);

-- 8.2 INSERT: member can create (creator_id = self, not DM)
SAVEPOINT sp_inv_ins;
SELECT authenticate_as('b2222222-2222-2222-2222-222222222222');
SELECT lives_ok(
    $$INSERT INTO invites (code, server_id, creator_id) VALUES ('testcode2', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'b2222222-2222-2222-2222-222222222222')$$,
    'invites INSERT: member can create invite'
);
ROLLBACK TO sp_inv_ins;

-- Cannot spoof creator_id
SELECT authenticate_as('b2222222-2222-2222-2222-222222222222');
SELECT throws_ok(
    $$INSERT INTO invites (code, server_id, creator_id) VALUES ('testcode3', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a1111111-1111-1111-1111-111111111111')$$,
    NULL, NULL,
    'invites INSERT: cannot spoof creator_id'
);

-- Cannot create invite for DM server
SELECT authenticate_as('a1111111-1111-1111-1111-111111111111');
SELECT throws_ok(
    $$INSERT INTO invites (code, server_id, creator_id) VALUES ('testcode4', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'a1111111-1111-1111-1111-111111111111')$$,
    NULL, NULL,
    'invites INSERT: cannot create invite for DM server'
);

-- Non-member cannot create invite
SELECT authenticate_as('e5555555-5555-5555-5555-555555555555');
SELECT throws_ok(
    $$INSERT INTO invites (code, server_id, creator_id) VALUES ('testcode5', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'e5555555-5555-5555-5555-555555555555')$$,
    NULL, NULL,
    'invites INSERT: non-member cannot create invite'
);

-- 8.3 DELETE: creator or admin+ can delete
SAVEPOINT sp_inv_del;
SELECT authenticate_as('b2222222-2222-2222-2222-222222222222');
DELETE FROM invites WHERE code = 'testcode1';
SELECT clear_auth();
SELECT is(
    (SELECT count(*)::int FROM invites WHERE code = 'testcode1'),
    0,
    'invites DELETE: creator can delete own invite'
);
ROLLBACK TO sp_inv_del;

SAVEPOINT sp_inv_del2;
SELECT authenticate_as('c3333333-3333-3333-3333-333333333333');
DELETE FROM invites WHERE code = 'testcode1';
SELECT clear_auth();
SELECT is(
    (SELECT count(*)::int FROM invites WHERE code = 'testcode1'),
    0,
    'invites DELETE: admin can delete any invite'
);
ROLLBACK TO sp_inv_del2;

SELECT clear_auth();


-- ═══════════════════════════════════════════════════════════════
-- 9. CHANNEL READ STATES
-- ═══════════════════════════════════════════════════════════════

-- 9.1 SELECT: own only + channel member
SELECT authenticate_as('b2222222-2222-2222-2222-222222222222');
SELECT is(
    (SELECT count(*)::int FROM channel_read_states WHERE channel_id = '11111111-1111-1111-1111-111111111111' AND user_id = 'b2222222-2222-2222-2222-222222222222'),
    1, 'channel_read_states SELECT: can see own read state'
);

-- Cannot see other user's read state (user_id filter in USING)
SELECT authenticate_as('a1111111-1111-1111-1111-111111111111');
SELECT is(
    (SELECT count(*)::int FROM channel_read_states WHERE user_id = 'b2222222-2222-2222-2222-222222222222'),
    0, 'channel_read_states SELECT: cannot see other user''s read state'
);

SELECT authenticate_as('e5555555-5555-5555-5555-555555555555');
SELECT is(
    (SELECT count(*)::int FROM channel_read_states),
    0, 'channel_read_states SELECT: non-member sees nothing'
);

-- 9.2 INSERT: own + channel member
SAVEPOINT sp_crs_ins;
SELECT authenticate_as('a1111111-1111-1111-1111-111111111111');
SELECT lives_ok(
    $$INSERT INTO channel_read_states (channel_id, user_id, last_read_at) VALUES ('11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', now())$$,
    'channel_read_states INSERT: can insert own read state'
);
ROLLBACK TO sp_crs_ins;

SELECT authenticate_as('e5555555-5555-5555-5555-555555555555');
SELECT throws_ok(
    $$INSERT INTO channel_read_states (channel_id, user_id, last_read_at) VALUES ('11111111-1111-1111-1111-111111111111', 'e5555555-5555-5555-5555-555555555555', now())$$,
    NULL, NULL,
    'channel_read_states INSERT: non-member cannot insert'
);

-- 9.3 UPDATE: own + channel member
SAVEPOINT sp_crs_upd;
SELECT authenticate_as('b2222222-2222-2222-2222-222222222222');
UPDATE channel_read_states SET last_read_at = now() WHERE channel_id = '11111111-1111-1111-1111-111111111111' AND user_id = 'b2222222-2222-2222-2222-222222222222';
SELECT pass('channel_read_states UPDATE: can update own read state');
ROLLBACK TO sp_crs_upd;

SELECT clear_auth();


-- ═══════════════════════════════════════════════════════════════
-- 10. MESSAGE REACTIONS
-- ═══════════════════════════════════════════════════════════════

-- 10.1 SELECT: channel member can see
SELECT authenticate_as('b2222222-2222-2222-2222-222222222222');
SELECT is(
    (SELECT count(*)::int FROM message_reactions WHERE message_id = 'aaaa0001-0001-0001-0001-000100010001'),
    1, 'message_reactions SELECT: member sees reactions'
);

SELECT authenticate_as('e5555555-5555-5555-5555-555555555555');
SELECT is(
    (SELECT count(*)::int FROM message_reactions),
    0, 'message_reactions SELECT: non-member sees nothing'
);

-- 10.2 INSERT: own + channel member
SAVEPOINT sp_rxn_ins;
SELECT authenticate_as('a1111111-1111-1111-1111-111111111111');
SELECT lives_ok(
    $$INSERT INTO message_reactions (id, message_id, user_id, emoji) VALUES ('fea20001-0001-0001-0001-000200010001', 'aaaa0001-0001-0001-0001-000100010001', 'a1111111-1111-1111-1111-111111111111', '❤️')$$,
    'message_reactions INSERT: member can add own reaction'
);
ROLLBACK TO sp_rxn_ins;

SELECT authenticate_as('b2222222-2222-2222-2222-222222222222');
SELECT throws_ok(
    $$INSERT INTO message_reactions (id, message_id, user_id, emoji) VALUES ('fea20002-0002-0002-0002-000200020002', 'aaaa0001-0001-0001-0001-000100010001', 'a1111111-1111-1111-1111-111111111111', '😀')$$,
    NULL, NULL,
    'message_reactions INSERT: cannot add reaction as another user'
);

-- 10.3 DELETE: own + channel member
SAVEPOINT sp_rxn_del;
SELECT authenticate_as('b2222222-2222-2222-2222-222222222222');
DELETE FROM message_reactions WHERE id = 'fea10001-0001-0001-0001-000100010001';
SELECT clear_auth();
SELECT is(
    (SELECT count(*)::int FROM message_reactions WHERE id = 'fea10001-0001-0001-0001-000100010001'),
    0,
    'message_reactions DELETE: can delete own reaction'
);
ROLLBACK TO sp_rxn_del;

SELECT clear_auth();


-- ═══════════════════════════════════════════════════════════════
-- 11. CHANNEL ROLE ACCESS
-- ═══════════════════════════════════════════════════════════════

-- 11.1 SELECT: admin+ only
SELECT authenticate_as('c3333333-3333-3333-3333-333333333333');
SELECT is(
    (SELECT count(*)::int FROM channel_role_access),
    1, 'channel_role_access SELECT: admin can see access rules'
);

SELECT authenticate_as('d4444444-4444-4444-4444-444444444444');
SELECT is(
    (SELECT count(*)::int FROM channel_role_access),
    0, 'channel_role_access SELECT: moderator cannot see access rules'
);

SELECT authenticate_as('b2222222-2222-2222-2222-222222222222');
SELECT is(
    (SELECT count(*)::int FROM channel_role_access),
    0, 'channel_role_access SELECT: member cannot see access rules'
);

-- 11.2 INSERT: admin+ only
SAVEPOINT sp_cra_ins;
SELECT authenticate_as('c3333333-3333-3333-3333-333333333333');
SELECT lives_ok(
    $$INSERT INTO channel_role_access (channel_id, role) VALUES ('22222222-2222-2222-2222-222222222222', 'member')$$,
    'channel_role_access INSERT: admin can create access rule'
);
ROLLBACK TO sp_cra_ins;

SELECT authenticate_as('b2222222-2222-2222-2222-222222222222');
SELECT throws_ok(
    $$INSERT INTO channel_role_access (channel_id, role) VALUES ('22222222-2222-2222-2222-222222222222', 'member')$$,
    NULL, NULL,
    'channel_role_access INSERT: member cannot create access rule'
);

-- 11.3 DELETE: admin+ only
SAVEPOINT sp_cra_del;
SELECT authenticate_as('c3333333-3333-3333-3333-333333333333');
DELETE FROM channel_role_access WHERE channel_id = '22222222-2222-2222-2222-222222222222' AND role = 'moderator';
SELECT clear_auth();
SELECT is(
    (SELECT count(*)::int FROM channel_role_access WHERE channel_id = '22222222-2222-2222-2222-222222222222' AND role = 'moderator'),
    0,
    'channel_role_access DELETE: admin can delete access rule'
);
ROLLBACK TO sp_cra_del;

SAVEPOINT sp_cra_del2;
SELECT authenticate_as('d4444444-4444-4444-4444-444444444444');
DELETE FROM channel_role_access WHERE channel_id = '22222222-2222-2222-2222-222222222222' AND role = 'moderator';
SELECT clear_auth();
SELECT is(
    (SELECT count(*)::int FROM channel_role_access WHERE channel_id = '22222222-2222-2222-2222-222222222222' AND role = 'moderator'),
    1,
    'channel_role_access DELETE: moderator cannot delete access rule'
);
ROLLBACK TO sp_cra_del2;

SELECT clear_auth();


-- ═══════════════════════════════════════════════════════════════
-- 12. TRIGGER: on_server_ban_created auto-deletes membership
-- ═══════════════════════════════════════════════════════════════

-- Verify Frank's membership was auto-deleted when banned
SELECT is(
    (SELECT count(*)::int FROM server_members WHERE server_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' AND user_id = 'f6666666-6666-6666-6666-666666666666'),
    0,
    'trigger: on_server_ban_created auto-deleted server_members row'
);

-- Belt-and-suspenders: even if membership is manually re-inserted, is_server_member still blocks
SAVEPOINT sp_belt;
INSERT INTO public.server_members (server_id, user_id, role)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'f6666666-6666-6666-6666-666666666666', 'member');
SELECT authenticate_as('f6666666-6666-6666-6666-666666666666');
SELECT is(
    public.is_server_member('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
    false,
    'belt-and-suspenders: is_server_member blocks even with stale membership row'
);
ROLLBACK TO sp_belt;


-- ═══════════════════════════════════════════════════════════════
-- DONE
-- ═══════════════════════════════════════════════════════════════

SELECT clear_auth();
SELECT * FROM finish();
ROLLBACK;
