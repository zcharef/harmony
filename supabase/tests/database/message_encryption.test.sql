-- =============================================================
-- Message Encryption Tests (20260322180002_add_encryption_to_messages)
--
-- Tests:
--   - Schema: messages.encrypted column, messages.sender_device_id column
--   - CHECK constraints: messages_device_required_when_encrypted,
--     messages_content_length (updated for ciphertext)
--   - Behavior: defaults for encrypted and sender_device_id
--
-- Run via: supabase test db
-- =============================================================
BEGIN;
SET search_path TO public, extensions;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(17);


-- ═══════════════════════════════════════════════════════════════
-- TEST DATA SETUP (as postgres — bypasses RLS)
-- ═══════════════════════════════════════════════════════════════

-- Test user (deterministic UUID — same convention as other test files)
INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, is_sso_user, is_anonymous, confirmation_token, recovery_token, email_change_token_new, email_change)
VALUES ('deadbeef-0e00-0e00-0e00-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'msg-enc-test@harmony.test', crypt('password123', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{"display_name":"MsgEncTester"}', now(), now(), false, false, '', '', '', '')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id, username, display_name)
VALUES ('deadbeef-0e00-0e00-0e00-000000000001', 'msg_enc_tester', 'MsgEncTester')
ON CONFLICT (id) DO NOTHING;

-- Test server + channel (messages require channel_id FK)
INSERT INTO public.servers (id, name, owner_id, is_dm, is_public)
VALUES ('deadbeef-0e00-0e00-0e00-aaaaaaaaaaaa', 'MsgEnc Test Server', 'deadbeef-0e00-0e00-0e00-000000000001', false, true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.channels (id, server_id, name, channel_type, position)
VALUES ('deadbeef-0e00-0e00-0e00-cccccccccccc', 'deadbeef-0e00-0e00-0e00-aaaaaaaaaaaa', 'enc-test-channel', 'text', 0)
ON CONFLICT (id) DO NOTHING;


-- ═══════════════════════════════════════════════════════════════
-- 1. SCHEMA TESTS — messages.encrypted column
-- ═══════════════════════════════════════════════════════════════

SELECT has_column('public', 'messages', 'encrypted',
    'schema: messages.encrypted column exists');

SELECT col_type_is('public', 'messages', 'encrypted', 'boolean',
    'schema: messages.encrypted is BOOLEAN');

SELECT col_not_null('public', 'messages', 'encrypted',
    'schema: messages.encrypted is NOT NULL');

SELECT col_default_is('public', 'messages', 'encrypted', 'false',
    'schema: messages.encrypted defaults to false');


-- ═══════════════════════════════════════════════════════════════
-- 2. SCHEMA TESTS — messages.sender_device_id column
-- ═══════════════════════════════════════════════════════════════

SELECT has_column('public', 'messages', 'sender_device_id',
    'schema: messages.sender_device_id column exists');

SELECT col_type_is('public', 'messages', 'sender_device_id', 'text',
    'schema: messages.sender_device_id is TEXT');

-- WHY: sender_device_id is nullable — only required when encrypted = true
-- (enforced by CHECK constraint, not by NOT NULL).
SELECT col_is_null('public', 'messages', 'sender_device_id',
    'schema: messages.sender_device_id is nullable');


-- ═══════════════════════════════════════════════════════════════
-- 3. CHECK CONSTRAINT — messages_device_required_when_encrypted
--
-- Rule: encrypted = false OR sender_device_id IS NOT NULL
-- (from 20260322180002_add_encryption_to_messages.sql:L24-25)
-- ═══════════════════════════════════════════════════════════════

-- 3.1 Positive: encrypted=false with NULL sender_device_id → allowed
SAVEPOINT sp_device_plain;
SELECT lives_ok(
    $$INSERT INTO public.messages (channel_id, author_id, content, encrypted, sender_device_id)
      VALUES ('deadbeef-0e00-0e00-0e00-cccccccccccc', 'deadbeef-0e00-0e00-0e00-000000000001', 'hello plaintext', false, NULL)$$,
    'check: encrypted=false + NULL sender_device_id is allowed'
);
ROLLBACK TO sp_device_plain;

-- 3.2 Positive: encrypted=true with sender_device_id set → allowed
SAVEPOINT sp_device_enc;
SELECT lives_ok(
    $$INSERT INTO public.messages (channel_id, author_id, content, encrypted, sender_device_id)
      VALUES ('deadbeef-0e00-0e00-0e00-cccccccccccc', 'deadbeef-0e00-0e00-0e00-000000000001', 'base64ciphertext==', true, 'DEVICE-ABC-123')$$,
    'check: encrypted=true + sender_device_id set is allowed'
);
ROLLBACK TO sp_device_enc;

-- 3.3 Negative: encrypted=true with NULL sender_device_id → REJECTED
-- WHY: Recipients need the sender_device_id to look up the correct Olm session.
SELECT throws_ok(
    $$INSERT INTO public.messages (channel_id, author_id, content, encrypted, sender_device_id)
      VALUES ('deadbeef-0e00-0e00-0e00-cccccccccccc', 'deadbeef-0e00-0e00-0e00-000000000001', 'ciphertext-no-device', true, NULL)$$,
    23514,  -- check_violation
    NULL,
    'check: encrypted=true + NULL sender_device_id is rejected'
);


-- ═══════════════════════════════════════════════════════════════
-- 4. CHECK CONSTRAINT — messages_content_length (updated)
--
-- Rule: content IS NULL
--    OR (encrypted = false AND char_length(content) <= 4000)
--    OR (encrypted = true  AND char_length(content) <= 8000)
-- (from 20260322180002_add_encryption_to_messages.sql:L40-44)
-- ═══════════════════════════════════════════════════════════════

-- 4.1 Positive: encrypted=false with 4000-char content → allowed
SAVEPOINT sp_len_plain_ok;
SELECT lives_ok(
    $$INSERT INTO public.messages (channel_id, author_id, content, encrypted)
      VALUES ('deadbeef-0e00-0e00-0e00-cccccccccccc', 'deadbeef-0e00-0e00-0e00-000000000001', repeat('a', 4000), false)$$,
    'check: plaintext content at 4000 chars is allowed'
);
ROLLBACK TO sp_len_plain_ok;

-- 4.2 Negative: encrypted=false with 4001-char content → REJECTED
SELECT throws_ok(
    $$INSERT INTO public.messages (channel_id, author_id, content, encrypted)
      VALUES ('deadbeef-0e00-0e00-0e00-cccccccccccc', 'deadbeef-0e00-0e00-0e00-000000000001', repeat('a', 4001), false)$$,
    23514,  -- check_violation
    NULL,
    'check: plaintext content at 4001 chars is rejected'
);

-- 4.3 Positive: encrypted=true with 8000-char content + sender_device_id → allowed
SAVEPOINT sp_len_enc_ok;
SELECT lives_ok(
    $$INSERT INTO public.messages (channel_id, author_id, content, encrypted, sender_device_id)
      VALUES ('deadbeef-0e00-0e00-0e00-cccccccccccc', 'deadbeef-0e00-0e00-0e00-000000000001', repeat('x', 8000), true, 'DEVICE-ABC-123')$$,
    'check: encrypted content at 8000 chars is allowed'
);
ROLLBACK TO sp_len_enc_ok;

-- 4.4 Negative: encrypted=true with 8001-char content + sender_device_id → REJECTED
SELECT throws_ok(
    $$INSERT INTO public.messages (channel_id, author_id, content, encrypted, sender_device_id)
      VALUES ('deadbeef-0e00-0e00-0e00-cccccccccccc', 'deadbeef-0e00-0e00-0e00-000000000001', repeat('x', 8001), true, 'DEVICE-ABC-123')$$,
    23514,  -- check_violation
    NULL,
    'check: encrypted content at 8001 chars is rejected'
);

-- 4.5 Positive: NULL content → allowed regardless of encrypted flag
SAVEPOINT sp_len_null;
SELECT lives_ok(
    $$INSERT INTO public.messages (channel_id, author_id, content, encrypted)
      VALUES ('deadbeef-0e00-0e00-0e00-cccccccccccc', 'deadbeef-0e00-0e00-0e00-000000000001', NULL, false)$$,
    'check: NULL content is allowed (encrypted=false)'
);
ROLLBACK TO sp_len_null;


-- ═══════════════════════════════════════════════════════════════
-- 5. BEHAVIOR TESTS — defaults
-- ═══════════════════════════════════════════════════════════════

-- 5.1 New message defaults encrypted to false
SAVEPOINT sp_default_enc;
INSERT INTO public.messages (id, channel_id, author_id, content)
VALUES ('deadbeef-0e00-0e00-0e00-dddddddddd01', 'deadbeef-0e00-0e00-0e00-cccccccccccc', 'deadbeef-0e00-0e00-0e00-000000000001', 'default test');
SELECT is(
    (SELECT encrypted FROM messages WHERE id = 'deadbeef-0e00-0e00-0e00-dddddddddd01'),
    false,
    'behavior: new message defaults encrypted to false'
);
ROLLBACK TO sp_default_enc;

-- 5.2 New message defaults sender_device_id to NULL
SAVEPOINT sp_default_dev;
INSERT INTO public.messages (id, channel_id, author_id, content)
VALUES ('deadbeef-0e00-0e00-0e00-dddddddddd02', 'deadbeef-0e00-0e00-0e00-cccccccccccc', 'deadbeef-0e00-0e00-0e00-000000000001', 'device default test');
SELECT is(
    (SELECT sender_device_id FROM messages WHERE id = 'deadbeef-0e00-0e00-0e00-dddddddddd02'),
    NULL::text,
    'behavior: new message defaults sender_device_id to NULL'
);
ROLLBACK TO sp_default_dev;


-- ═══════════════════════════════════════════════════════════════
-- DONE
-- ═══════════════════════════════════════════════════════════════

SELECT * FROM finish();
ROLLBACK;
