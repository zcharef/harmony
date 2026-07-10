-- =============================================================
-- Analytics Funnel Tests — growth-plan §10
--
-- Covers:
--   §A  analytics_events security: clients can neither read nor write,
--       append-only enforcement, once-per-user dedup, signup trigger.
--   §B  metric views on seeded fixtures (2020 dates — isolated from
--       seed/live data), including the §10 fixture-pack edge cases:
--       the alt-account "alive" server, the delete-and-leave "retained"
--       user, excluded servers/users, and the lurker (connect-only)
--       non-retained user.
--
-- Run via: supabase test db
-- =============================================================
BEGIN;

SELECT plan(38);

-- ═══════════════════════════════════════════════════════════════
-- AUTH HELPERS (same pattern as rls_policies.test.sql)
-- ═══════════════════════════════════════════════════════════════

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
-- §A — EVENT LOG SECURITY & INTEGRITY
-- ═══════════════════════════════════════════════════════════════

SELECT has_table('public', 'analytics_events', 'analytics_events table exists');

SELECT is(
    (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.analytics_events'::regclass),
    true,
    'RLS is enabled on analytics_events'
);

-- A1: signup trigger — inserting an auth user creates the profile
-- (handle_new_user) which records user_signed_up at profile creation time.
INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, is_sso_user, is_anonymous, confirmation_token, recovery_token, email_change_token_new, email_change)
VALUES ('77a10000-0000-4000-a000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'funnel.t1@harmony.test', crypt('pw', gen_salt('bf')), now(), '{}', '{"username":"funnel_t1"}', now(), now(), false, false, '', '', '', '');

SELECT is(
    (SELECT COUNT(*)::int FROM public.analytics_events
      WHERE name = 'user_signed_up' AND user_id = '77a10000-0000-4000-a000-000000000001'),
    1,
    'signup emits exactly one user_signed_up event'
);

SELECT is(
    (SELECT occurred_at FROM public.analytics_events
      WHERE name = 'user_signed_up' AND user_id = '77a10000-0000-4000-a000-000000000001'),
    (SELECT created_at FROM public.profiles WHERE id = '77a10000-0000-4000-a000-000000000001'),
    'user_signed_up occurred_at matches profile creation time'
);

-- A2: once-per-user dedup — the partial unique index absorbs replays.
INSERT INTO public.analytics_events (name, user_id)
VALUES ('first_message', '77a10000-0000-4000-a000-000000000001')
ON CONFLICT DO NOTHING;
INSERT INTO public.analytics_events (name, user_id)
VALUES ('first_message', '77a10000-0000-4000-a000-000000000001')
ON CONFLICT DO NOTHING;

SELECT is(
    (SELECT COUNT(*)::int FROM public.analytics_events
      WHERE name = 'first_message' AND user_id = '77a10000-0000-4000-a000-000000000001'),
    1,
    'first_message is once-per-user (second insert is a no-op)'
);

-- A3: append-only — even postgres cannot UPDATE.
SELECT throws_ok(
    $$UPDATE public.analytics_events SET properties = '{"tampered":true}' WHERE name = 'first_message'$$,
    '42501',
    'analytics_events is append-only (UPDATE forbidden)',
    'UPDATE on analytics_events is rejected by the append-only trigger'
);

-- A4: authenticated clients can neither read nor write the event log,
-- nor touch the analytics schema.
SELECT authenticate_as('77a10000-0000-4000-a000-000000000001');

SELECT throws_ok(
    $$SELECT COUNT(*) FROM public.analytics_events$$,
    '42501',
    NULL,
    'authenticated cannot SELECT analytics_events (own events included)'
);

SELECT throws_ok(
    $$INSERT INTO public.analytics_events (name, user_id) VALUES ('first_message', '77a10000-0000-4000-a000-000000000001')$$,
    '42501',
    NULL,
    'authenticated cannot INSERT into analytics_events'
);

SELECT throws_ok(
    $$SELECT * FROM analytics.metrics_wcu$$,
    '42501',
    NULL,
    'authenticated cannot read the analytics schema'
);

SELECT clear_auth();

-- A5: the read-only analytics role CAN read every metric view.
-- WHY the GRANT: the test runner's postgres role is not a superuser in
-- Supabase, so it needs membership to SET ROLE. Rolled back with the test.
GRANT analytics_reader TO postgres;
SET LOCAL ROLE analytics_reader;
SELECT lives_ok($$SELECT * FROM analytics.metrics_wcu$$, 'analytics_reader can read metrics_wcu');
SELECT lives_ok($$SELECT * FROM analytics.metrics_server_alive$$, 'analytics_reader can read metrics_server_alive');
SELECT lives_ok($$SELECT * FROM analytics.metrics_retention$$, 'analytics_reader can read metrics_retention');
SELECT lives_ok($$SELECT * FROM analytics.metrics_activation$$, 'analytics_reader can read metrics_activation');
SELECT lives_ok($$SELECT * FROM analytics.metrics_invite_funnel$$, 'analytics_reader can read metrics_invite_funnel');
RESET ROLE;

-- ═══════════════════════════════════════════════════════════════
-- §B — VIEW FIXTURES (June 2020: nothing else exists that week)
--
-- Cast:
--   O1  owner of S1 (the genuinely alive server)
--   R1  retained-by-message user (d1) — also the "activated" user
--   R2  lurker: connects on day 1 but performs no meaningful action
--   R4  retained-by-voice user (d7)
--   R3  EXCLUDED user posting in S1 (staff/dogfood analog)
--   R5  delete-and-leave user: active day 1, then deletes account
--   U5, U6 active members of S1 (profiles created "now" — different cohort)
--   O2  owner of S2 (alt farm: 4 alt members, all 50 messages his own)
--   U7  posts in S3 (an EXCLUDED server)
-- ═══════════════════════════════════════════════════════════════

INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, is_sso_user, is_anonymous, confirmation_token, recovery_token, email_change_token_new, email_change)
VALUES
    ('77b10000-0000-4000-a000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'funnel.o1@harmony.test', crypt('pw', gen_salt('bf')), now(), '{}', '{"username":"funnel_o1"}', now(), now(), false, false, '', '', '', ''),
    ('77b10000-0000-4000-a000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'funnel.r1@harmony.test', crypt('pw', gen_salt('bf')), now(), '{}', '{"username":"funnel_r1"}', now(), now(), false, false, '', '', '', ''),
    ('77b10000-0000-4000-a000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'funnel.r2@harmony.test', crypt('pw', gen_salt('bf')), now(), '{}', '{"username":"funnel_r2"}', now(), now(), false, false, '', '', '', ''),
    ('77b10000-0000-4000-a000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'funnel.r4@harmony.test', crypt('pw', gen_salt('bf')), now(), '{}', '{"username":"funnel_r4"}', now(), now(), false, false, '', '', '', ''),
    ('77b10000-0000-4000-a000-000000000005', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'funnel.r3@harmony.test', crypt('pw', gen_salt('bf')), now(), '{}', '{"username":"funnel_r3"}', now(), now(), false, false, '', '', '', ''),
    ('77b10000-0000-4000-a000-000000000006', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'funnel.r5@harmony.test', crypt('pw', gen_salt('bf')), now(), '{}', '{"username":"funnel_r5"}', now(), now(), false, false, '', '', '', ''),
    ('77b10000-0000-4000-a000-000000000007', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'funnel.u5@harmony.test', crypt('pw', gen_salt('bf')), now(), '{}', '{"username":"funnel_u5"}', now(), now(), false, false, '', '', '', ''),
    ('77b10000-0000-4000-a000-000000000008', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'funnel.u6@harmony.test', crypt('pw', gen_salt('bf')), now(), '{}', '{"username":"funnel_u6"}', now(), now(), false, false, '', '', '', ''),
    ('77b10000-0000-4000-a000-000000000009', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'funnel.o2@harmony.test', crypt('pw', gen_salt('bf')), now(), '{}', '{"username":"funnel_o2"}', now(), now(), false, false, '', '', '', ''),
    ('77b10000-0000-4000-a000-000000000010', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'funnel.a1@harmony.test', crypt('pw', gen_salt('bf')), now(), '{}', '{"username":"funnel_a1"}', now(), now(), false, false, '', '', '', ''),
    ('77b10000-0000-4000-a000-000000000011', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'funnel.a2@harmony.test', crypt('pw', gen_salt('bf')), now(), '{}', '{"username":"funnel_a2"}', now(), now(), false, false, '', '', '', ''),
    ('77b10000-0000-4000-a000-000000000012', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'funnel.a3@harmony.test', crypt('pw', gen_salt('bf')), now(), '{}', '{"username":"funnel_a3"}', now(), now(), false, false, '', '', '', ''),
    ('77b10000-0000-4000-a000-000000000013', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'funnel.a4@harmony.test', crypt('pw', gen_salt('bf')), now(), '{}', '{"username":"funnel_a4"}', now(), now(), false, false, '', '', '', ''),
    ('77b10000-0000-4000-a000-000000000014', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'funnel.u7@harmony.test', crypt('pw', gen_salt('bf')), now(), '{}', '{"username":"funnel_u7"}', now(), now(), false, false, '', '', '', '');

-- Signup cohort of Monday 2020-06-01: R1, R2, R4 (+R5 until deletion).
UPDATE public.profiles SET created_at = '2020-06-01T00:00:00Z'
WHERE id IN (
    '77b10000-0000-4000-a000-000000000002',  -- R1
    '77b10000-0000-4000-a000-000000000003',  -- R2
    '77b10000-0000-4000-a000-000000000004',  -- R4
    '77b10000-0000-4000-a000-000000000006'   -- R5
);

-- Servers (created Monday 2020-06-01)
INSERT INTO public.servers (id, name, owner_id, is_dm, is_public, created_at)
VALUES
    ('77510000-0000-4000-a000-000000000001', 'Funnel Alive Server',  '77b10000-0000-4000-a000-000000000001', false, false, '2020-06-01T00:00:00Z'),
    ('77510000-0000-4000-a000-000000000002', 'Funnel Alt Farm',      '77b10000-0000-4000-a000-000000000009', false, false, '2020-06-01T00:00:00Z'),
    ('77510000-0000-4000-a000-000000000003', 'Funnel Internal Server','77b10000-0000-4000-a000-000000000001', false, false, '2020-06-01T00:00:00Z');

-- S3 is internal/staff — excluded (anti-gaming).
INSERT INTO analytics.exclusions (scope, target_id, reason)
VALUES ('server', '77510000-0000-4000-a000-000000000003', 'internal test server');

-- R3 is staff — excluded (anti-gaming).
INSERT INTO analytics.exclusions (scope, target_id, reason)
VALUES ('user', '77b10000-0000-4000-a000-000000000005', 'staff dogfood account');

INSERT INTO public.channels (id, server_id, name, channel_type)
VALUES
    ('77c10000-0000-4000-a000-000000000001', '77510000-0000-4000-a000-000000000001', 'general', 'text'),
    ('77c10000-0000-4000-a000-000000000002', '77510000-0000-4000-a000-000000000002', 'general', 'text'),
    ('77c10000-0000-4000-a000-000000000003', '77510000-0000-4000-a000-000000000003', 'general', 'text');

-- S1 memberships: owner + R1, R2, R4, U5, U6 all joined in week 1 (6 ≥ 5).
INSERT INTO public.server_members (server_id, user_id, joined_at)
VALUES
    ('77510000-0000-4000-a000-000000000001', '77b10000-0000-4000-a000-000000000001', '2020-06-01T00:00:00Z'),
    ('77510000-0000-4000-a000-000000000001', '77b10000-0000-4000-a000-000000000002', '2020-06-01T01:00:00Z'),
    ('77510000-0000-4000-a000-000000000001', '77b10000-0000-4000-a000-000000000003', '2020-06-01T01:00:00Z'),
    ('77510000-0000-4000-a000-000000000001', '77b10000-0000-4000-a000-000000000004', '2020-06-01T01:00:00Z'),
    ('77510000-0000-4000-a000-000000000001', '77b10000-0000-4000-a000-000000000007', '2020-06-01T02:00:00Z'),
    ('77510000-0000-4000-a000-000000000001', '77b10000-0000-4000-a000-000000000008', '2020-06-01T02:00:00Z');

-- S2 memberships: owner + 4 alts (5 ≥ 5, but only the owner ever talks).
INSERT INTO public.server_members (server_id, user_id, joined_at)
VALUES
    ('77510000-0000-4000-a000-000000000002', '77b10000-0000-4000-a000-000000000009', '2020-06-01T00:00:00Z'),
    ('77510000-0000-4000-a000-000000000002', '77b10000-0000-4000-a000-000000000010', '2020-06-01T01:00:00Z'),
    ('77510000-0000-4000-a000-000000000002', '77b10000-0000-4000-a000-000000000011', '2020-06-01T01:00:00Z'),
    ('77510000-0000-4000-a000-000000000002', '77b10000-0000-4000-a000-000000000012', '2020-06-01T01:00:00Z'),
    ('77510000-0000-4000-a000-000000000002', '77b10000-0000-4000-a000-000000000013', '2020-06-01T01:00:00Z');

-- S1 messages, week 1, spread over 2 days, 4 distinct eligible senders:
-- R1×20 (day 1 — also his D1-retention action), U5×20, U6×6, O1×5 = 51.
INSERT INTO public.messages (channel_id, author_id, content, created_at)
SELECT '77c10000-0000-4000-a000-000000000001', '77b10000-0000-4000-a000-000000000002',
       'r1 msg ' || g, '2020-06-02T05:00:00Z'::timestamptz + (g || ' minutes')::interval
FROM generate_series(1, 20) g;
INSERT INTO public.messages (channel_id, author_id, content, created_at)
SELECT '77c10000-0000-4000-a000-000000000001', '77b10000-0000-4000-a000-000000000007',
       'u5 msg ' || g, '2020-06-02T10:00:00Z'::timestamptz + (g || ' minutes')::interval
FROM generate_series(1, 20) g;
INSERT INTO public.messages (channel_id, author_id, content, created_at)
SELECT '77c10000-0000-4000-a000-000000000001', '77b10000-0000-4000-a000-000000000008',
       'u6 msg ' || g, '2020-06-03T09:00:00Z'::timestamptz + (g || ' minutes')::interval
FROM generate_series(1, 6) g;
INSERT INTO public.messages (channel_id, author_id, content, created_at)
SELECT '77c10000-0000-4000-a000-000000000001', '77b10000-0000-4000-a000-000000000001',
       'o1 msg ' || g, '2020-06-03T11:00:00Z'::timestamptz + (g || ' minutes')::interval
FROM generate_series(1, 5) g;

-- R3 (EXCLUDED staff) also posts in S1 — must count nowhere.
INSERT INTO public.messages (channel_id, author_id, content, created_at)
SELECT '77c10000-0000-4000-a000-000000000001', '77b10000-0000-4000-a000-000000000005',
       'r3 msg ' || g, '2020-06-02T08:00:00Z'::timestamptz + (g || ' minutes')::interval
FROM generate_series(1, 3) g;

-- S2 alt farm: 50 messages, ALL from the owner, single day.
INSERT INTO public.messages (channel_id, author_id, content, created_at)
SELECT '77c10000-0000-4000-a000-000000000002', '77b10000-0000-4000-a000-000000000009',
       'o2 solo ' || g, '2020-06-02T06:00:00Z'::timestamptz + (g || ' minutes')::interval
FROM generate_series(1, 50) g;

-- S3 (EXCLUDED server): U7 posts — must count nowhere.
INSERT INTO public.messages (channel_id, author_id, content, created_at)
SELECT '77c10000-0000-4000-a000-000000000003', '77b10000-0000-4000-a000-000000000014',
       'u7 msg ' || g, '2020-06-02T07:00:00Z'::timestamptz + (g || ' minutes')::interval
FROM generate_series(1, 3) g;

-- Event-log fixtures (as the API would emit them):
-- R2 the lurker only CONNECTS on day 1 — not a meaningful action.
INSERT INTO public.analytics_events (name, user_id, server_id, occurred_at)
VALUES ('session_connected', '77b10000-0000-4000-a000-000000000003',
        '77510000-0000-4000-a000-000000000001', '2020-06-02T09:00:00Z');
-- R4 joins voice on day 7 — retained_d7 via voice.
INSERT INTO public.analytics_events (name, user_id, server_id, channel_id, occurred_at)
VALUES ('voice_joined', '77b10000-0000-4000-a000-000000000004',
        '77510000-0000-4000-a000-000000000001', '77c10000-0000-4000-a000-000000000001',
        '2020-06-08T03:00:00Z');
-- Invite funnel: O1 creates 2 invites, R1 redeems 1.
INSERT INTO public.analytics_events (name, user_id, server_id, properties, occurred_at)
VALUES
    ('invite_created',  '77b10000-0000-4000-a000-000000000001', '77510000-0000-4000-a000-000000000001', '{"code":"funnel01"}', '2020-06-02T04:00:00Z'),
    ('invite_created',  '77b10000-0000-4000-a000-000000000001', '77510000-0000-4000-a000-000000000001', '{"code":"funnel02"}', '2020-06-02T04:05:00Z'),
    ('invite_redeemed', '77b10000-0000-4000-a000-000000000002', '77510000-0000-4000-a000-000000000001', '{"code":"funnel01"}', '2020-06-02T04:30:00Z');

-- R5 delete-and-leave: active on day 1 (reacted — a meaningful action)...
-- then deletes their account. The event row survives (append-only log, no
-- FK); the USER must still vanish from every metric via eligibility joins.
INSERT INTO public.analytics_events (name, user_id, server_id, channel_id, occurred_at)
VALUES ('reaction_added', '77b10000-0000-4000-a000-000000000006',
        '77510000-0000-4000-a000-000000000001', '77c10000-0000-4000-a000-000000000001',
        '2020-06-02T06:30:00Z');

-- B1: before deletion R5 counts in the cohort...
SELECT is(
    (SELECT cohort_size::int FROM analytics.metrics_retention WHERE cohort_week = '2020-06-01'),
    4,
    'cohort includes R5 before account deletion'
);

DELETE FROM auth.users WHERE id = '77b10000-0000-4000-a000-000000000006';

-- ...and vanishes from every metric after (anti-gaming: deleted accounts).
SELECT is(
    (SELECT cohort_size::int FROM analytics.metrics_retention WHERE cohort_week = '2020-06-01'),
    3,
    'delete-and-leave user is NOT in the cohort after deletion'
);

-- B2: retention — R1 retained d1 by message; R2 (connect-only) is NOT;
-- R4 retained d7 by voice; nobody at d30.
SELECT is(
    (SELECT d1_retained::int FROM analytics.metrics_retention WHERE cohort_week = '2020-06-01'),
    1,
    'd1: only the messaging user is retained (lurker connect does not count)'
);
SELECT is(
    (SELECT d1_rate FROM analytics.metrics_retention WHERE cohort_week = '2020-06-01'),
    0.3333,
    'd1 rate = 1/3'
);
SELECT is(
    (SELECT d7_retained::int FROM analytics.metrics_retention WHERE cohort_week = '2020-06-01'),
    1,
    'd7: voice join is a meaningful action'
);
SELECT is(
    (SELECT d30_retained::int FROM analytics.metrics_retention WHERE cohort_week = '2020-06-01'),
    0,
    'd30: nobody retained'
);
SELECT is(
    (SELECT d30_rate FROM analytics.metrics_retention WHERE cohort_week = '2020-06-01'),
    0.0000,
    'd30 rate is 0 (cohort mature, so a real zero — not NULL)'
);

-- B3: WCU — S1 qualifies (4 eligible actives ≥ 3); the alt farm (1 active)
-- and the excluded server do not; the excluded user R3 is not counted.
SELECT is(
    (SELECT wcu::int FROM analytics.metrics_wcu WHERE week_start = '2020-06-01'),
    4,
    'WCU counts only users in servers with >=3 weekly actives, exclusions applied'
);

-- B4: alive server — S1 meets all five tightened criteria.
SELECT is(
    (SELECT is_alive FROM analytics.metrics_server_alive
      WHERE server_id = '77510000-0000-4000-a000-000000000001'),
    true,
    'S1 is alive: >=5 joined, >=3 non-owner active, >=50 msgs from >=3 senders, >=2 days'
);
SELECT is(
    (SELECT messages_week1::int FROM analytics.metrics_server_alive
      WHERE server_id = '77510000-0000-4000-a000-000000000001'),
    51,
    'excluded-user messages do not count toward the 50-message bar'
);
SELECT is(
    (SELECT non_owner_active_week1::int FROM analytics.metrics_server_alive
      WHERE server_id = '77510000-0000-4000-a000-000000000001'),
    3,
    'S1 has exactly 3 non-owner active members in week 1'
);

-- B5: the alt-account farm is NOT alive (Tempo's fixture).
SELECT is(
    (SELECT is_alive FROM analytics.metrics_server_alive
      WHERE server_id = '77510000-0000-4000-a000-000000000002'),
    false,
    'alt farm is not alive: 50 owner-only messages fail distinct-sender and non-owner-active bars'
);
SELECT is(
    (SELECT distinct_senders_week1::int FROM analytics.metrics_server_alive
      WHERE server_id = '77510000-0000-4000-a000-000000000002'),
    1,
    'alt farm has a single distinct sender'
);

-- B6: excluded server is absent from the alive view entirely.
SELECT is(
    (SELECT COUNT(*)::int FROM analytics.metrics_server_alive
      WHERE server_id = '77510000-0000-4000-a000-000000000003'),
    0,
    'excluded (internal) server does not appear in metrics_server_alive'
);

-- B7: activation — cohort of 3 (R1, R2, R4): only R1 sent a message
-- within 7 days. Median time-to-first-message = 29h (signup 06-01 00:00,
-- first message 06-02 05:00).
SELECT is(
    (SELECT signups::int FROM analytics.metrics_activation WHERE cohort_week = '2020-06-01'),
    3,
    'activation cohort size'
);
SELECT is(
    (SELECT activated_within_7d::int FROM analytics.metrics_activation WHERE cohort_week = '2020-06-01'),
    1,
    'only the messaging user activated within 7 days'
);
SELECT is(
    (SELECT activation_rate FROM analytics.metrics_activation WHERE cohort_week = '2020-06-01'),
    0.3333,
    'activation rate = 1/3 (cohort mature, so a real number — not NULL)'
);
SELECT is(
    (SELECT median_hours_to_first_message FROM analytics.metrics_activation WHERE cohort_week = '2020-06-01'),
    29.02,
    'median time-to-first-message is ~29 hours (signup Mon 00:00, first msg Tue 05:01)'
);

-- B8: K-factor inputs — 2 invites created, 1 redeemed, 5 weekly actives
-- (O1, R1, U5, U6 in S1 + O2 in S2: the K denominator counts every active
-- member in eligible servers; the >=3-actives bar belongs to WCU only).
SELECT results_eq(
    $$SELECT invites_created::int, invites_redeemed::int, active_members::int,
             invite_join_conversion, invites_per_active_member, k_factor
        FROM analytics.metrics_invite_funnel WHERE week_start = '2020-06-01'$$,
    $$VALUES (2, 1, 5, 0.5000::numeric, 0.4000::numeric, 0.2000::numeric)$$,
    'invite funnel: created=2, redeemed=1, actives=5, conversion=0.5, invites/active=0.4, K=0.2'
);

-- B9: immature cohorts report NULL rates (§10 explicit null/unknown rule).
-- WHY a future-dated signup: the current calendar week is polluted by real
-- local-DB users who may already be d1-measurable; next week's cohort is
-- guaranteed to contain only this fixture and to be fully immature.
UPDATE public.profiles SET created_at = now() + INTERVAL '7 days'
WHERE id = '77b10000-0000-4000-a000-000000000014';  -- U7
SELECT is(
    (SELECT activation_rate FROM analytics.metrics_activation
      WHERE cohort_week = date_trunc('week', (now() + INTERVAL '7 days') AT TIME ZONE 'UTC')::date),
    NULL,
    'activation rate is NULL while the cohort window is still open'
);
SELECT is(
    (SELECT d1_rate FROM analytics.metrics_retention
      WHERE cohort_week = date_trunc('week', (now() + INTERVAL '7 days') AT TIME ZONE 'UTC')::date),
    NULL,
    'd1 rate is NULL while no cohort member is measurable yet'
);

-- B10: a server created just now with no traction reports is_alive NULL
-- (window still open), not false.
INSERT INTO public.servers (id, name, owner_id, is_dm, is_public)
VALUES ('77510000-0000-4000-a000-000000000004', 'Funnel Newborn', '77b10000-0000-4000-a000-000000000001', false, false);
SELECT is(
    (SELECT is_alive FROM analytics.metrics_server_alive
      WHERE server_id = '77510000-0000-4000-a000-000000000004'),
    NULL,
    'newborn server is NULL (unknown), not dead'
);

-- B11: DM servers never enter server metrics.
INSERT INTO public.servers (id, name, owner_id, is_dm, is_public, created_at)
VALUES ('77510000-0000-4000-a000-000000000005', 'dm', '77b10000-0000-4000-a000-000000000001', true, false, '2020-06-01T00:00:00Z');
SELECT is(
    (SELECT COUNT(*)::int FROM analytics.metrics_server_alive
      WHERE server_id = '77510000-0000-4000-a000-000000000005'),
    0,
    'DM servers are not in metrics_server_alive'
);

-- B12: system moderator sentinel is excluded from cohorts by seed data.
SELECT is(
    (SELECT COUNT(*)::int FROM analytics.eligible_users
      WHERE user_id = '00000000-0000-0000-0000-000000000001'),
    0,
    'system moderator sentinel is not an eligible user'
);

SELECT * FROM finish();
ROLLBACK;
