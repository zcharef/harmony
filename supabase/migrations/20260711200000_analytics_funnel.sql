-- =============================================================
-- Migration: analytics_funnel
-- Growth-plan §10: privacy-first, own-DB funnel instrumentation.
--
-- Creates:
--   1. public.analytics_events   — append-only funnel event log (IDs only,
--      no message content, no IP/user-agent, no PII). Written by the Rust
--      API (service role) and one DB trigger (signup). Clients can neither
--      read nor write it.
--   2. analytics.exclusions      — anti-gaming exclusion list (internal/
--      test/staff servers and accounts, seed/demo data, spam accounts).
--      Ops-managed; every metric view bakes it in (Tempo, 2026-07-10).
--   3. analytics.* metric views  — §10 definitions: WCU (north star),
--      alive-server (tightened §5), activation, event-based D1/D7/D30
--      retention, K-factor inputs.
--   4. analytics_reader role     — NOLOGIN read-only path for founder
--      dashboards. Grant it to a login user to consume metrics.
--
-- Design notes:
--   - No FKs on analytics_events: the log must survive entity deletion
--     (deleted accounts/servers drop out of metrics at read time via
--     joins against profiles/servers — which is exactly the anti-gaming
--     "exclude deleted accounts" rule).
--   - Append-only is enforced by a BEFORE UPDATE trigger (service role
--     cannot bypass triggers). DELETE stays possible for the service
--     role only — that is the privacy scrub path on account deletion.
--   - Views are intentionally owner-security (definer semantics): they
--     expose AGGREGATES only, live in the non-API-exposed `analytics`
--     schema, and are granted only to analytics_reader + service_role.
-- =============================================================

-- ─────────────────────────────────────────────────────────────
-- 1. Event log
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.analytics_events (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    user_id     UUID,           -- no FK: log survives account deletion
    server_id   UUID,           -- no FK: log survives server deletion
    channel_id  UUID,           -- no FK: log survives channel deletion
    properties  JSONB NOT NULL DEFAULT '{}'::jsonb,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Stable event names only (growth-plan §10: "stable event names")
    CONSTRAINT analytics_events_name_format CHECK (name ~ '^[a-z0-9_]{3,64}$'),
    -- Defense-in-depth: payloads are small ID/flag bags, never content dumps
    CONSTRAINT analytics_events_properties_size CHECK (pg_column_size(properties) <= 2048)
);

CREATE INDEX IF NOT EXISTS idx_analytics_events_name_occurred
    ON public.analytics_events (name, occurred_at);
CREATE INDEX IF NOT EXISTS idx_analytics_events_user_occurred
    ON public.analytics_events (user_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_analytics_events_server_occurred
    ON public.analytics_events (server_id, occurred_at);

-- Once-per-user funnel milestones: a second insert is a silent no-op
-- (the Rust recorder always uses ON CONFLICT DO NOTHING).
CREATE UNIQUE INDEX IF NOT EXISTS uq_analytics_events_once_per_user
    ON public.analytics_events (name, user_id)
    WHERE name IN ('user_signed_up', 'first_message');

-- Append-only guard: no row is ever rewritten (metric integrity).
CREATE OR REPLACE FUNCTION public.analytics_events_block_update()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'analytics_events is append-only (UPDATE forbidden)'
        USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_analytics_events_append_only ON public.analytics_events;
CREATE TRIGGER trg_analytics_events_append_only
    BEFORE UPDATE ON public.analytics_events
    FOR EACH ROW
    EXECUTE FUNCTION public.analytics_events_block_update();

-- RLS: enabled with ZERO policies — clients (anon/authenticated) can
-- neither read nor write. Only the service role (RLS-bypassing API
-- connection) touches this table. Explicit REVOKE is belt-and-braces
-- against Supabase default grants on the public schema.
ALTER TABLE public.analytics_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.analytics_events FROM anon, authenticated;

-- ─────────────────────────────────────────────────────────────
-- 2. Signup event — emitted by the DB, not the API
-- WHY a trigger: profile creation is the one funnel point the Rust API
-- does not own (handle_new_user() fires on auth.users insert, and a
-- direct /auth/v1/signup never touches our API). The trigger captures
-- every signup path. EXCEPTION-guarded: analytics must NEVER fail signup.
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.record_signup_event()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- The system moderator sentinel is not a user signup.
    IF NEW.id = '00000000-0000-0000-0000-000000000001' THEN
        RETURN NEW;
    END IF;
    BEGIN
        INSERT INTO public.analytics_events (name, user_id, occurred_at)
        VALUES ('user_signed_up', NEW.id, NEW.created_at)
        ON CONFLICT DO NOTHING;
    EXCEPTION WHEN OTHERS THEN
        -- ADR-027: no silent failure — but never block signup either.
        RAISE WARNING 'analytics: user_signed_up insert failed for %: %', NEW.id, SQLERRM;
    END;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_profiles_record_signup ON public.profiles;
CREATE TRIGGER trg_profiles_record_signup
    AFTER INSERT ON public.profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.record_signup_event();

-- Backfill: existing users get their signup event at profile creation
-- time so cohort views are continuous from day one.
INSERT INTO public.analytics_events (name, user_id, occurred_at)
SELECT 'user_signed_up', p.id, p.created_at
FROM public.profiles p
WHERE p.id <> '00000000-0000-0000-0000-000000000001'
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────
-- 3. Analytics schema: exclusions + metric views
-- ─────────────────────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS analytics;

-- Anti-gaming exclusion list (§10, MANDATORY on every metric):
-- internal/test/staff servers and accounts, seed/demo data, spam
-- accounts. Deleted accounts need no entry — they vanish from profiles
-- and thus from every view. Ops-managed via service role.
CREATE TABLE IF NOT EXISTS analytics.exclusions (
    scope      TEXT NOT NULL CHECK (scope IN ('user', 'server')),
    target_id  UUID NOT NULL,
    reason     TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (scope, target_id)
);

ALTER TABLE analytics.exclusions ENABLE ROW LEVEL SECURITY;

-- The system moderator sentinel must never count as a user.
INSERT INTO analytics.exclusions (scope, target_id, reason)
VALUES ('user', '00000000-0000-0000-0000-000000000001', 'system moderator sentinel')
ON CONFLICT DO NOTHING;

-- Eligible = exists (not deleted) AND not excluded. Every metric view
-- builds on these two — the anti-gaming rules live in exactly one place.
CREATE OR REPLACE VIEW analytics.eligible_users AS
SELECT p.id AS user_id, p.created_at AS signed_up_at
FROM public.profiles p
WHERE NOT EXISTS (
    SELECT 1 FROM analytics.exclusions x
    WHERE x.scope = 'user' AND x.target_id = p.id
);

CREATE OR REPLACE VIEW analytics.eligible_servers AS
SELECT s.id AS server_id, s.owner_id, s.created_at
FROM public.servers s
WHERE s.is_dm = false
  AND NOT EXISTS (
    SELECT 1 FROM analytics.exclusions x
    WHERE x.scope = 'server' AND x.target_id = s.id
  );

-- Meaningful actions (§10 retention contract): sent message · joined
-- voice · reacted · accepted a social action (joined a server, redeemed
-- an invite) — in a non-internal, non-DM server, by an eligible user.
-- Messages come from the messages table (SSoT, predates instrumentation);
-- ephemeral actions (voice, reactions, joins) come from the event log.
-- Session connects deliberately do NOT count ("returned to browse an
-- empty server is NOT retained" — Tempo).
CREATE OR REPLACE VIEW analytics.meaningful_actions AS
SELECT
    m.author_id AS user_id,
    c.server_id,
    m.created_at AS occurred_at,
    'message_sent'::text AS action
FROM public.messages m
JOIN public.channels c ON c.id = m.channel_id
JOIN analytics.eligible_servers es ON es.server_id = c.server_id
JOIN analytics.eligible_users eu ON eu.user_id = m.author_id
WHERE m.deleted_at IS NULL                -- spam/moderated messages are soft-deleted
  AND m.message_type = 'default'          -- system announcements are not user activity
UNION ALL
SELECT
    e.user_id,
    e.server_id,
    e.occurred_at,
    e.name AS action
FROM public.analytics_events e
JOIN analytics.eligible_servers es ON es.server_id = e.server_id
JOIN analytics.eligible_users eu ON eu.user_id = e.user_id
WHERE e.name IN ('voice_joined', 'reaction_added', 'server_joined', 'invite_redeemed');

-- ── North star: Weekly Connected Users (§10) ──
-- Users who sent ≥1 message OR joined voice, in a server that had ≥3
-- such users the same week. Weeks are ISO weeks, UTC.
CREATE OR REPLACE VIEW analytics.metrics_wcu AS
WITH connect_actions AS (
    SELECT
        ma.user_id,
        ma.server_id,
        date_trunc('week', ma.occurred_at AT TIME ZONE 'UTC')::date AS week_start
    FROM analytics.meaningful_actions ma
    WHERE ma.action IN ('message_sent', 'voice_joined')
),
server_weekly_actives AS (
    SELECT server_id, week_start, COUNT(DISTINCT user_id) AS active_users
    FROM connect_actions
    GROUP BY server_id, week_start
)
SELECT
    ca.week_start,
    COUNT(DISTINCT ca.user_id) AS wcu
FROM connect_actions ca
JOIN server_weekly_actives swa
    ON swa.server_id = ca.server_id AND swa.week_start = ca.week_start
WHERE swa.active_users >= 3
GROUP BY ca.week_start;

-- ── Alive server (tightened §5, per Tempo — alt-account resistant) ──
-- In week 1 after creation: ≥5 joined, ≥3 non-owner members active,
-- ≥50 messages from ≥3 distinct senders, message activity on ≥2 days.
-- is_alive: true as soon as all criteria hold; false once the week-1
-- window closed unmet; NULL while the window is still open (§10
-- explicit null/unknown rule).
CREATE OR REPLACE VIEW analytics.metrics_server_alive AS
WITH week1_messages AS (
    SELECT es.server_id, m.author_id, m.created_at
    FROM analytics.eligible_servers es
    JOIN public.channels c ON c.server_id = es.server_id
    JOIN public.messages m ON m.channel_id = c.id
    JOIN analytics.eligible_users eu ON eu.user_id = m.author_id
    WHERE m.deleted_at IS NULL
      AND m.message_type = 'default'
      AND m.created_at >= es.created_at
      AND m.created_at < es.created_at + INTERVAL '7 days'
),
week1_active_members AS (
    SELECT ma.server_id, ma.user_id
    FROM analytics.meaningful_actions ma
    JOIN analytics.eligible_servers es ON es.server_id = ma.server_id
    WHERE ma.occurred_at >= es.created_at
      AND ma.occurred_at < es.created_at + INTERVAL '7 days'
    GROUP BY ma.server_id, ma.user_id
),
stats AS (
    SELECT
        es.server_id,
        es.created_at,
        (SELECT COUNT(*) FROM public.server_members sm
          WHERE sm.server_id = es.server_id
            AND sm.joined_at < es.created_at + INTERVAL '7 days') AS members_joined_week1,
        (SELECT COUNT(*) FROM week1_active_members wam
          WHERE wam.server_id = es.server_id
            AND wam.user_id <> es.owner_id) AS non_owner_active_week1,
        (SELECT COUNT(*) FROM week1_messages wm
          WHERE wm.server_id = es.server_id) AS messages_week1,
        (SELECT COUNT(DISTINCT wm.author_id) FROM week1_messages wm
          WHERE wm.server_id = es.server_id) AS distinct_senders_week1,
        (SELECT COUNT(DISTINCT (wm.created_at AT TIME ZONE 'UTC')::date)
           FROM week1_messages wm
          WHERE wm.server_id = es.server_id) AS active_days_week1
    FROM analytics.eligible_servers es
)
SELECT
    server_id,
    created_at,
    members_joined_week1,
    non_owner_active_week1,
    messages_week1,
    distinct_senders_week1,
    active_days_week1,
    CASE
        WHEN members_joined_week1 >= 5
         AND non_owner_active_week1 >= 3
         AND messages_week1 >= 50
         AND distinct_senders_week1 >= 3
         AND active_days_week1 >= 2
        THEN true
        WHEN now() >= created_at + INTERVAL '7 days'
        THEN false
        ELSE NULL
    END AS is_alive
FROM stats;

-- ── Activation: signup → first message (§10 funnel KPI) ──
-- v1 operationalization: activated = first non-deleted message in an
-- eligible server within 7 days of signup. Rate is NULL until the whole
-- cohort week has had its full 7-day window (cohort_week + 14 days).
CREATE OR REPLACE VIEW analytics.metrics_activation AS
WITH cohort AS (
    SELECT
        eu.user_id,
        eu.signed_up_at,
        date_trunc('week', eu.signed_up_at AT TIME ZONE 'UTC')::date AS cohort_week
    FROM analytics.eligible_users eu
),
first_message AS (
    SELECT ma.user_id, MIN(ma.occurred_at) AS first_message_at
    FROM analytics.meaningful_actions ma
    WHERE ma.action = 'message_sent'
    GROUP BY ma.user_id
)
SELECT
    c.cohort_week,
    COUNT(*) AS signups,
    COUNT(*) FILTER (
        WHERE fm.first_message_at IS NOT NULL
          AND fm.first_message_at < c.signed_up_at + INTERVAL '7 days'
    ) AS activated_within_7d,
    CASE
        WHEN now() >= c.cohort_week + INTERVAL '14 days'
        THEN ROUND(
            COUNT(*) FILTER (
                WHERE fm.first_message_at IS NOT NULL
                  AND fm.first_message_at < c.signed_up_at + INTERVAL '7 days'
            )::numeric / COUNT(*), 4)
        ELSE NULL
    END AS activation_rate,
    ROUND((percentile_cont(0.5) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM fm.first_message_at - c.signed_up_at)
    ) FILTER (WHERE fm.first_message_at IS NOT NULL) / 3600.0)::numeric, 2)
        AS median_hours_to_first_message
FROM cohort c
LEFT JOIN first_message fm ON fm.user_id = c.user_id
GROUP BY c.cohort_week;

-- ── Event-based D1/D7/D30 retention (§10, Tempo) ──
-- Retained at day N = performed a meaningful action (see
-- analytics.meaningful_actions — connects and lurking excluded) during
-- [signup + N days, signup + N+1 days). Rates count only users whose
-- day-N window has fully elapsed; NULL when no user is measurable yet.
CREATE OR REPLACE VIEW analytics.metrics_retention AS
WITH cohort AS (
    SELECT
        eu.user_id,
        eu.signed_up_at,
        date_trunc('week', eu.signed_up_at AT TIME ZONE 'UTC')::date AS cohort_week
    FROM analytics.eligible_users eu
),
flags AS (
    SELECT
        c.cohort_week,
        c.user_id,
        c.signed_up_at,
        EXISTS (
            SELECT 1 FROM analytics.meaningful_actions ma
            WHERE ma.user_id = c.user_id
              AND ma.occurred_at >= c.signed_up_at + INTERVAL '1 day'
              AND ma.occurred_at <  c.signed_up_at + INTERVAL '2 days'
        ) AS retained_d1,
        EXISTS (
            SELECT 1 FROM analytics.meaningful_actions ma
            WHERE ma.user_id = c.user_id
              AND ma.occurred_at >= c.signed_up_at + INTERVAL '7 days'
              AND ma.occurred_at <  c.signed_up_at + INTERVAL '8 days'
        ) AS retained_d7,
        EXISTS (
            SELECT 1 FROM analytics.meaningful_actions ma
            WHERE ma.user_id = c.user_id
              AND ma.occurred_at >= c.signed_up_at + INTERVAL '30 days'
              AND ma.occurred_at <  c.signed_up_at + INTERVAL '31 days'
        ) AS retained_d30
    FROM cohort c
)
SELECT
    cohort_week,
    COUNT(*) AS cohort_size,
    COUNT(*) FILTER (WHERE retained_d1) AS d1_retained,
    ROUND(COUNT(*) FILTER (WHERE retained_d1)::numeric
        / NULLIF(COUNT(*) FILTER (WHERE now() >= signed_up_at + INTERVAL '2 days'), 0), 4) AS d1_rate,
    COUNT(*) FILTER (WHERE retained_d7) AS d7_retained,
    ROUND(COUNT(*) FILTER (WHERE retained_d7)::numeric
        / NULLIF(COUNT(*) FILTER (WHERE now() >= signed_up_at + INTERVAL '8 days'), 0), 4) AS d7_rate,
    COUNT(*) FILTER (WHERE retained_d30) AS d30_retained,
    ROUND(COUNT(*) FILTER (WHERE retained_d30)::numeric
        / NULLIF(COUNT(*) FILTER (WHERE now() >= signed_up_at + INTERVAL '31 days'), 0), 4) AS d30_rate
FROM flags
GROUP BY cohort_week;

-- ── K-factor inputs (§10 referral KPIs) ──
-- Per ISO week (UTC): invites created/redeemed (from the event log —
-- invite rows are deleted on revoke, events are durable), weekly active
-- members, invites per active member, invite→join conversion, and
-- K = invites_per_active_member × conversion.
CREATE OR REPLACE VIEW analytics.metrics_invite_funnel AS
WITH weekly_invites AS (
    SELECT
        date_trunc('week', e.occurred_at AT TIME ZONE 'UTC')::date AS week_start,
        COUNT(*) FILTER (WHERE e.name = 'invite_created') AS invites_created,
        COUNT(*) FILTER (WHERE e.name = 'invite_redeemed') AS invites_redeemed
    FROM public.analytics_events e
    JOIN analytics.eligible_servers es ON es.server_id = e.server_id
    JOIN analytics.eligible_users eu ON eu.user_id = e.user_id
    WHERE e.name IN ('invite_created', 'invite_redeemed')
    GROUP BY 1
),
weekly_actives AS (
    SELECT
        date_trunc('week', ma.occurred_at AT TIME ZONE 'UTC')::date AS week_start,
        COUNT(DISTINCT ma.user_id) AS active_members
    FROM analytics.meaningful_actions ma
    GROUP BY 1
)
SELECT
    wi.week_start,
    wi.invites_created,
    wi.invites_redeemed,
    COALESCE(wa.active_members, 0) AS active_members,
    ROUND(wi.invites_redeemed::numeric / NULLIF(wi.invites_created, 0), 4)
        AS invite_join_conversion,
    ROUND(wi.invites_created::numeric / NULLIF(wa.active_members, 0), 4)
        AS invites_per_active_member,
    ROUND((wi.invites_created::numeric / NULLIF(wa.active_members, 0))
        * (wi.invites_redeemed::numeric / NULLIF(wi.invites_created, 0)), 4)
        AS k_factor
FROM weekly_invites wi
LEFT JOIN weekly_actives wa ON wa.week_start = wi.week_start;

-- ─────────────────────────────────────────────────────────────
-- 4. Read-only analytics role path
-- NOLOGIN group role; grant it to a login user (founder dashboard,
-- `just metrics` recipe later) to read aggregates without any access
-- to raw product tables.
-- ─────────────────────────────────────────────────────────────

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'analytics_reader') THEN
        CREATE ROLE analytics_reader NOLOGIN;
    END IF;
END $$;

GRANT USAGE ON SCHEMA analytics TO analytics_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA analytics TO analytics_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA analytics
    GRANT SELECT ON TABLES TO analytics_reader;

-- Clients never see the analytics schema.
REVOKE ALL ON SCHEMA analytics FROM PUBLIC;
