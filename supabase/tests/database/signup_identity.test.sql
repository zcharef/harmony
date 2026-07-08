-- =============================================================
-- Signup Identity Tests — handle_new_user() trigger
--
-- Guards the F6 fix: the trigger honors the CHOSEN username from
-- signup metadata (not email-derived), and a blank display name
-- becomes NULL (not the email prefix). Reserved/invalid usernames
-- and OAuth full_name fallbacks are covered too.
--
-- Run via: supabase test db
-- =============================================================
BEGIN;

SELECT plan(14);

-- Helper shape for auth.users inserts (full NOT NULL column list, mirrors
-- plan_constraints.test.sql). The AFTER INSERT trigger creates the profile.
-- §1: chosen username + display name are both honored
INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, is_sso_user, is_anonymous, confirmation_token, recovery_token, email_change_token_new, email_change)
VALUES ('51630000-0000-4e57-a000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'zayd.charef@harmony.test', crypt('pw', gen_salt('bf')), now(), '{}', '{"username":"zayd_cool","display_name":"Zayd C"}', now(), now(), false, false, '', '', '', '');

SELECT is((SELECT username FROM public.profiles WHERE id = '51630000-0000-4e57-a000-000000000001'),
    'zayd_cool', 'chosen username is honored (not email-derived)');
SELECT is((SELECT display_name FROM public.profiles WHERE id = '51630000-0000-4e57-a000-000000000001'),
    'Zayd C', 'display name from metadata is stored');

-- §2: blank display name → NULL (not the email prefix)
INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, is_sso_user, is_anonymous, confirmation_token, recovery_token, email_change_token_new, email_change)
VALUES ('51630000-0000-4e57-a000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'Bob.Smith@harmony.test', crypt('pw', gen_salt('bf')), now(), '{}', '{"username":"bobby123"}', now(), now(), false, false, '', '', '', '');

SELECT is((SELECT username FROM public.profiles WHERE id = '51630000-0000-4e57-a000-000000000002'),
    'bobby123', 'chosen username honored when display name absent');
SELECT is((SELECT display_name FROM public.profiles WHERE id = '51630000-0000-4e57-a000-000000000002'),
    NULL, 'absent display name is NULL, not the email prefix');

-- §3: whitespace-only display name → NULL
INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, is_sso_user, is_anonymous, confirmation_token, recovery_token, email_change_token_new, email_change)
VALUES ('51630000-0000-4e57-a000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ws@harmony.test', crypt('pw', gen_salt('bf')), now(), '{}', '{"username":"whitespaceuser","display_name":"   "}', now(), now(), false, false, '', '', '', '');

SELECT is((SELECT display_name FROM public.profiles WHERE id = '51630000-0000-4e57-a000-000000000003'),
    NULL, 'whitespace-only display name is NULL');

-- §4: padded display name is trimmed
INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, is_sso_user, is_anonymous, confirmation_token, recovery_token, email_change_token_new, email_change)
VALUES ('51630000-0000-4e57-a000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'pad@harmony.test', crypt('pw', gen_salt('bf')), now(), '{}', '{"username":"paddeduser","display_name":"  Trimmed  "}', now(), now(), false, false, '', '', '', '');

SELECT is((SELECT display_name FROM public.profiles WHERE id = '51630000-0000-4e57-a000-000000000004'),
    'Trimmed', 'padded display name is trimmed');

-- §5: reserved chosen username is NOT honored → email-derived
INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, is_sso_user, is_anonymous, confirmation_token, recovery_token, email_change_token_new, email_change)
VALUES ('51630000-0000-4e57-a000-000000000005', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'someone@harmony.test', crypt('pw', gen_salt('bf')), now(), '{}', '{"username":"admin"}', now(), now(), false, false, '', '', '', '');

SELECT is((SELECT username FROM public.profiles WHERE id = '51630000-0000-4e57-a000-000000000005'),
    'someone', 'reserved username falls back to email-derived');

-- §6: invalid chosen username (too short) → email-derived
INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, is_sso_user, is_anonymous, confirmation_token, recovery_token, email_change_token_new, email_change)
VALUES ('51630000-0000-4e57-a000-000000000006', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'valid.user@harmony.test', crypt('pw', gen_salt('bf')), now(), '{}', '{"username":"AB"}', now(), now(), false, false, '', '', '', '');

SELECT is((SELECT username FROM public.profiles WHERE id = '51630000-0000-4e57-a000-000000000006'),
    'valid_user', 'invalid (too-short) username falls back to email-derived');

-- §7: no username metadata → email-derived (backward compat)
INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, is_sso_user, is_anonymous, confirmation_token, recovery_token, email_change_token_new, email_change)
VALUES ('51630000-0000-4e57-a000-000000000007', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'Legacy.User@harmony.test', crypt('pw', gen_salt('bf')), now(), '{}', '{}', now(), now(), false, false, '', '', '', '');

SELECT is((SELECT username FROM public.profiles WHERE id = '51630000-0000-4e57-a000-000000000007'),
    'legacy_user', 'no metadata → email-derived username (backward compat)');
SELECT is((SELECT display_name FROM public.profiles WHERE id = '51630000-0000-4e57-a000-000000000007'),
    NULL, 'no metadata → NULL display name');

-- §8: OAuth full_name is used as display name when display_name absent
INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, is_sso_user, is_anonymous, confirmation_token, recovery_token, email_change_token_new, email_change)
VALUES ('51630000-0000-4e57-a000-000000000008', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'oauth@harmony.test', crypt('pw', gen_salt('bf')), now(), '{}', '{"full_name":"OAuth Person"}', now(), now(), false, false, '', '', '', '');

SELECT is((SELECT display_name FROM public.profiles WHERE id = '51630000-0000-4e57-a000-000000000008'),
    'OAuth Person', 'OAuth full_name is used as display name');

-- §9: username uniqueness — a second signup with the same chosen username
--     gets a suffixed variant of THAT base (not an email-derived name)
INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, is_sso_user, is_anonymous, confirmation_token, recovery_token, email_change_token_new, email_change)
VALUES ('51630000-0000-4e57-a000-000000000009', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'dup@harmony.test', crypt('pw', gen_salt('bf')), now(), '{}', '{"username":"zayd_cool"}', now(), now(), false, false, '', '', '', '');

SELECT isnt((SELECT username FROM public.profiles WHERE id = '51630000-0000-4e57-a000-000000000009'),
    'zayd_cool', 'colliding chosen username is suffixed, not reused');
SELECT matches((SELECT username FROM public.profiles WHERE id = '51630000-0000-4e57-a000-000000000009'),
    '^zayd_cool_', 'collision suffix keeps the chosen base');
SELECT is((SELECT count(*)::int FROM public.profiles WHERE username = 'zayd_cool'),
    1, 'username uniqueness holds after collision');

SELECT * FROM finish();

ROLLBACK;
