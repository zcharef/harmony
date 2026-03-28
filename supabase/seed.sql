-- =============================================================
-- Seed data for local development
-- Creates: 2 test users, 1 server, 1 channel, sample messages
--
-- Test credentials:
--   alice@harmony.test / password123
--   bob@harmony.test   / password123
-- =============================================================

-- Insert test users into auth.users
-- Password: "password123" hashed with bcrypt
-- Note: confirmed_at is a generated column (LEAST(email_confirmed_at, phone_confirmed_at)), omit it
-- WHY: GoTrue scans token/change varchar columns into Go strings — NULL causes
-- a scan error. Columns with no default must be set to '' explicitly.
-- phone is left NULL (has unique constraint + GoTrue handles NULL phone natively).
INSERT INTO auth.users (
    id,
    instance_id,
    aud,
    role,
    email,
    encrypted_password,
    email_confirmed_at,
    raw_app_meta_data,
    raw_user_meta_data,
    created_at,
    updated_at,
    is_sso_user,
    is_anonymous,
    confirmation_token,
    recovery_token,
    email_change_token_new,
    email_change
) VALUES (
    'a1111111-1111-1111-1111-111111111111',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'alice@harmony.test',
    crypt('password123', gen_salt('bf')),
    now(),
    '{"provider": "email", "providers": ["email"]}',
    '{"display_name": "Alice"}',
    now(),
    now(),
    false,
    false,
    '', '', '', ''
), (
    'b2222222-2222-2222-2222-222222222222',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'bob@harmony.test',
    crypt('password123', gen_salt('bf')),
    now(),
    '{"provider": "email", "providers": ["email"]}',
    '{"display_name": "Bob"}',
    now(),
    now(),
    false,
    false,
    '', '', '', ''
) ON CONFLICT (id) DO NOTHING;

-- Insert identities (required for Supabase Auth login to work)
-- Note: email is a generated column (from identity_data->>'email'), omit it
INSERT INTO auth.identities (
    id,
    provider_id,
    user_id,
    identity_data,
    provider,
    last_sign_in_at,
    created_at,
    updated_at
) VALUES (
    'a1111111-1111-1111-1111-111111111111',
    'a1111111-1111-1111-1111-111111111111',
    'a1111111-1111-1111-1111-111111111111',
    jsonb_build_object('sub', 'a1111111-1111-1111-1111-111111111111', 'email', 'alice@harmony.test'),
    'email',
    now(),
    now(),
    now()
), (
    'b2222222-2222-2222-2222-222222222222',
    'b2222222-2222-2222-2222-222222222222',
    'b2222222-2222-2222-2222-222222222222',
    jsonb_build_object('sub', 'b2222222-2222-2222-2222-222222222222', 'email', 'bob@harmony.test'),
    'email',
    now(),
    now(),
    now()
) ON CONFLICT (id) DO NOTHING;

-- Profiles
INSERT INTO public.profiles (id, username, display_name, status)
VALUES
    ('a1111111-1111-1111-1111-111111111111', 'alice', 'Alice', 'online'),
    ('b2222222-2222-2222-2222-222222222222', 'bob', 'Bob', 'online')
ON CONFLICT (id) DO NOTHING;

-- Server: "Harmony Dev"
INSERT INTO public.servers (id, name, description, owner_id, is_public, member_count)
VALUES (
    'cccccccc-cccc-cccc-cccc-cccccccccccc',
    'Harmony Dev',
    'Development server for testing Harmony',
    'a1111111-1111-1111-1111-111111111111',
    true,
    2
) ON CONFLICT (id) DO NOTHING;

-- Server members
INSERT INTO public.server_members (server_id, user_id)
VALUES
    ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'a1111111-1111-1111-1111-111111111111'),
    ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'b2222222-2222-2222-2222-222222222222')
ON CONFLICT (server_id, user_id) DO NOTHING;

-- Channel: #general
INSERT INTO public.channels (id, server_id, name, topic, channel_type, position)
VALUES (
    'dddddddd-dddd-dddd-dddd-dddddddddddd',
    'cccccccc-cccc-cccc-cccc-cccccccccccc',
    'general',
    'General discussion',
    'text',
    0
) ON CONFLICT (id) DO NOTHING;

-- Sample messages
INSERT INTO public.messages (id, channel_id, author_id, content, created_at)
VALUES
    (
        'eeeeeeee-0001-0001-0001-eeeeeeeeeeee',
        'dddddddd-dddd-dddd-dddd-dddddddddddd',
        'a1111111-1111-1111-1111-111111111111',
        'Welcome to Harmony! This is the first message.',
        now() - interval '10 minutes'
    ),
    (
        'eeeeeeee-0002-0002-0002-eeeeeeeeeeee',
        'dddddddd-dddd-dddd-dddd-dddddddddddd',
        'b2222222-2222-2222-2222-222222222222',
        'Hey Alice! Glad to be here.',
        now() - interval '9 minutes'
    ),
    (
        'eeeeeeee-0003-0003-0003-eeeeeeeeeeee',
        'dddddddd-dddd-dddd-dddd-dddddddddddd',
        'a1111111-1111-1111-1111-111111111111',
        'Let''s build something great together.',
        now() - interval '8 minutes'
    )
ON CONFLICT (id) DO NOTHING;
