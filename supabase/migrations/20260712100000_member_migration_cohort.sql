-- =============================================================
-- Migration: member_migration_cohort
-- Growth-plan §14.1 (the 80/20 people-half) + member-migration-flow ticket.
--
-- The #1 cause of platform-migration death is members who join but never
-- participate — the owner brings 500, twelve follow, the room feels dead,
-- the owner churns back. The merged analytics funnel (§10) already answers
-- "is this server ALIVE?" at the aggregate level (analytics.metrics_server_alive).
-- This migration adds the ONE object that surface is missing for the owner:
-- a per-member cohort so the owner can SEE which members haven't participated
-- yet and act on them (the intervention targets).
--
-- Creates:
--   analytics.server_member_cohort  — one row per (eligible server, non-owner
--   eligible member): joined_at, whether they've sent a first message, and
--   their last GENUINE activity timestamp. Read-only VIEW (no new table).
--
-- Design notes:
--   - "Genuine activity" reuses EXACTLY the §5 / metrics_server_alive
--     criterion-2 definition: message_sent / voice_joined / reaction_added.
--     Joins (server_joined / invite_redeemed) are DELIBERATELY excluded — the
--     API emits both on every invite join, so counting them would mark every
--     member "active" the instant they arrive and erase the very cohort this
--     view exists to find (the alt-account gaming §5 resists). This is the
--     single source of truth for "active"; the view does not re-derive it.
--   - Eligibility (exclusions, deleted accounts, DM servers) is inherited from
--     analytics.eligible_servers / analytics.eligible_users / meaningful_actions
--     — the anti-gaming rules live in exactly one place (§10 contract).
--   - Owner is excluded: the cohort is about the PEOPLE the owner is trying to
--     bring along, not the owner.
--   - Additive and idempotent (CREATE OR REPLACE VIEW). No table, no RLS
--     surface change: like every analytics.* object it lives in the
--     non-API-exposed schema, readable only by analytics_reader + the owner
--     (postgres/service role the API connects as).
-- =============================================================

-- Per-member migration-follow-through cohort for an owner's server.
--
-- WHY member-first (not aggregate-then-join): callers ALWAYS read this view
-- for one server (`WHERE server_id = $1`). Joining server_members to
-- meaningful_actions and aggregating at the member grain lets Postgres push
-- that server_id predicate into the meaningful_actions scan (it propagates
-- through the sm.server_id join and the UNION ALL branches of
-- meaningful_actions), so a single owner's dashboard never scans the whole
-- message/event history. An earlier CTE-then-join shape aggregated every
-- server globally before the outer filter — quadratically worse as the
-- platform grows, and this surface polls every ~30s.
CREATE OR REPLACE VIEW analytics.server_member_cohort AS
SELECT
    es.server_id,
    es.owner_id,
    sm.user_id,
    sm.joined_at,
    p.username,
    p.display_name,
    p.avatar_url,
    sm.nickname,
    MIN(ma.occurred_at) FILTER (WHERE ma.action = 'message_sent') AS first_message_at,
    COALESCE(bool_or(ma.action = 'message_sent'), false) AS has_sent_message,
    -- "active" = the SAME genuine-activity set as metrics_server_alive
    -- criterion 2 (§5): message/voice/reaction. Presence-only joins
    -- (server_joined / invite_redeemed) are excluded on purpose.
    MAX(ma.occurred_at) FILTER (
        WHERE ma.action IN ('message_sent', 'voice_joined', 'reaction_added')
    ) AS last_active_at,
    COALESCE(
        bool_or(ma.action IN ('message_sent', 'voice_joined', 'reaction_added')),
        false
    ) AS is_active
FROM analytics.eligible_servers es
JOIN public.server_members sm ON sm.server_id = es.server_id
JOIN analytics.eligible_users eu ON eu.user_id = sm.user_id
JOIN public.profiles p ON p.id = sm.user_id
LEFT JOIN analytics.meaningful_actions ma
    ON ma.server_id = sm.server_id AND ma.user_id = sm.user_id
WHERE sm.user_id <> es.owner_id
GROUP BY
    es.server_id, es.owner_id, sm.user_id, sm.joined_at,
    p.username, p.display_name, p.avatar_url, sm.nickname;

-- Read path: the founder/owner dashboard reads through analytics_reader; the
-- API itself connects as the schema owner. Explicit grant mirrors the other
-- analytics views (belt-and-braces on top of ALTER DEFAULT PRIVILEGES).
-- NOTE: analytics_reader reads the cohort for EVERY server (all owners'
-- members, usernames, display_names, avatar_urls) — it carries no per-owner
-- filter. The API path enforces per-owner authorization in Rust
-- (migration_service::authorize_owner); any login role granted
-- analytics_reader inherits that unrestricted cross-server access, so grant it
-- only to trusted founder/ops roles.
GRANT SELECT ON analytics.server_member_cohort TO analytics_reader;
