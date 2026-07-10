# Harmony Metrics Dictionary

> **Version: 1.1.0** (2026-07-10) · Owner: Tempo (growth CTO) · Spec: `dev/strategy/growth-plan.md` §10
>
> Contract (§10, "data quality is a first-class contract"): every figure is
> traceable to a query, every query to a **versioned metric definition** in
> this file. A definition change bumps the version here, states the backfill
> rule, and re-baselines dashboards — never silently.

## Ground rules (apply to every metric)

- **Source of truth:** the production Postgres. Views live in the `analytics`
  schema; raw events in `public.analytics_events` (append-only, IDs only,
  no PII, no message content, no IP/user-agent).
- **Anti-gaming exclusions (MANDATORY, §10):** every metric excludes
  - internal/test/staff servers and accounts, seed/demo data, spam accounts —
    via ops-managed rows in `analytics.exclusions` (`scope` = `user`/`server`);
  - deleted accounts — structurally: metrics join `profiles`/`servers`, so a
    deleted entity drops out of every figure (its event rows remain in the
    log but are never counted);
  - DM "servers" (`servers.is_dm = true`) — from all server-level metrics;
  - system messages (`messages.message_type <> 'default'`) and soft-deleted/
    moderated messages (`messages.deleted_at IS NOT NULL`);
  - self-hosted instances — structurally: they run their own DB and phone
    nothing home.
- **Null rule (§10):** a rate whose measurement window has not fully elapsed
  is reported as `NULL` (unknown), never as `0`. Zero always means a measured
  zero.
- **Weeks** are ISO weeks (Monday start), UTC.
- **Read path:** grant `analytics_reader` (NOLOGIN role, SELECT-only on the
  `analytics` schema) to a login user. No client role can read or write
  `analytics_events` or the views.

## Event log

`public.analytics_events (name, user_id, server_id, channel_id, properties, occurred_at)`

| Event | Emitted by | Funnel point (§10) |
|---|---|---|
| `user_signed_up` | DB trigger `trg_profiles_record_signup` (covers every signup path, incl. direct `/auth/v1/signup`); backfilled from `profiles.created_at` | Acquisition → Activation entry |
| `server_created` | `POST /v1/servers` | Activation (owner path) |
| `server_joined` | invite join + official-server auto-join (`properties.via` = `invite` / `official_autojoin`) | Activation (member path) |
| `first_message` | `POST /v1/channels/{id}/messages` — once per user, DB-deduped (partial unique index) | Activation |
| `invite_created` | `POST /v1/servers/{id}/invites` (`properties.code`) | Referral (K numerator) |
| `invite_redeemed` | `POST /v1/servers/{id}/members` (`properties.code`; inviter derivable via code) | Referral (K conversion) |
| `voice_joined` | `POST /v1/channels/{id}/voice/join` (voice_sessions rows are ephemeral; this is the durable trace) | Retention / WCU |
| `reaction_added` | `POST .../reactions` (reaction rows are deleted on un-react; this is the durable trace) | Retention |
| `session_connected` | `GET /v1/events` (SSE connect) | Traffic signal only — **never** a retention action |

Emission is fire-and-forget (`tokio::spawn` + `tracing::warn!` on failure,
ADR-027): a failed insert can never fail or slow a user action. Metrics
tolerate gaps; user actions do not tolerate failures.

## Shared building block: meaningful actions

**View:** `analytics.meaningful_actions`

§10 (Tempo): *"Retained = performed a meaningful action (sent message ·
joined voice · reacted · accepted/responded to a social action) in a
non-internal server."* Connecting/lurking is explicitly NOT meaningful —
*"a user who returns only to … browse an empty server is NOT retained."*

Composition (eligibility baked in — exclusions live in exactly one place):

- `message_sent` — from `messages` (SSoT; predates instrumentation, enables
  backfill), `deleted_at IS NULL`, `message_type = 'default'`;
- `voice_joined`, `reaction_added`, `server_joined`, `invite_redeemed` —
  from `analytics_events`.

## Metrics

### 1. Weekly Connected Users (WCU) — north star

**View:** `analytics.metrics_wcu` · **Version 1.0.0**

§10: *"users who sent ≥1 message or joined voice in a server with ≥3 weekly
actives."* Per ISO week: a server-week qualifies when ≥3 distinct eligible
users messaged or joined voice in it that week; WCU = distinct users with
≥1 such action inside qualifying server-weeks. Reactions do NOT count toward
WCU (they count for retention only).

Fixture proof: `supabase/tests/database/analytics_funnel.test.sql` §B3 —
a 2-active server and an excluded server contribute zero.

### 2. Alive server (tightened §5)

**View:** `analytics.metrics_server_alive` · **Version 1.1.0**

§5 (tightened per Tempo — *"the old ≥5 members ≥50 messages is gamed by one
owner + four alts"*), all within week 1 after server creation:

1. ≥5 members joined (`server_members.joined_at` in window — members who
   later left are not re-counted; known v1 limitation, `server_joined`
   events close the gap going forward);
2. ≥3 non-owner members active — **"active" here = `message_sent` ·
   `voice_joined` · `reaction_added` in that server.** `server_joined` /
   `invite_redeemed` deliberately do NOT count for this criterion: the API
   emits both for every invite join, so counting them would make joining
   itself satisfy the bar and collapse it into criterion 1 — the exact
   alt-account gaming this metric exists to resist. (Joins remain
   meaningful actions everywhere else: retention, K-factor actives.)
3. ≥50 messages from ≥3 distinct senders;
4. message activity on ≥2 separate days.

`is_alive`: `true` as soon as all four hold · `false` once the 7-day window
closes unmet · `NULL` while the window is open (null rule).

Fixture proof: §B4–B6 — the genuine server is alive; the alt-farm (owner +
4 silent alts + 50 owner-only messages, production-shaped: the alts carry
the `server_joined`/`invite_redeemed` events the API emits on every join)
is not, and its non-owner-active count is 0; the excluded server is absent.

### 3. Activation: signup → first message

**View:** `analytics.metrics_activation` · **Version 1.0.0**

§10 KPI: *"signup→first-message rate."* v1 operationalization (window not
specified in §10; chosen and versioned here): **activated = first non-deleted
message in an eligible server within 7 days of signup**. Per signup-week
cohort: `signups`, `activated_within_7d`, `activation_rate` (NULL until
`cohort_week + 14 days`, i.e. every member has had a full window),
`median_hours_to_first_message`.

Cohort basis is `profiles.created_at` (SSoT; deleted accounts drop out, which
is exactly the anti-gaming rule).

### 4. Event-based D1/D7/D30 retention

**View:** `analytics.metrics_retention` · **Version 1.1.0**

§10: *"Retention is event-based + server-contextual, not 'returned by signup
week'."* Retained at day N = ≥1 meaningful action during
`[signup + N days, signup + N+1 days)` (classic exact-day retention).
Per signup-week cohort: `cohort_size`, `dN_retained`, `dN_rate`. Each rate
counts only users whose day-N window has fully elapsed — **numerator and
denominator alike**: a user who already acted inside a still-open window is
not yet measurable and inflates neither side (otherwise an in-progress
cohort week could report a rate above 1.0). `dN_retained` stays the raw
retained count (immature included); `NULL` rate when no member is
measurable yet.

Fixture proof: §B1–B2, §B13 — the delete-and-leave user vanishes from the
cohort; the connect-only lurker is not retained; the voice-only user is
retained at D7; the mixed-maturity cohort (one measurable non-retained user
+ one immature already-active user) reports 0.0000, not 1.0.

### 5. K-factor inputs (referral)

**View:** `analytics.metrics_invite_funnel` · **Version 1.0.0**

§10 KPIs: *"invites sent/active member, invite→join conversion, K-factor."*
Per ISO week, from the event log (invite rows are deleted on revoke; events
are durable):

- `invites_created`, `invites_redeemed`;
- `active_members` = distinct users with ≥1 meaningful action that week
  (every eligible server — the ≥3-actives bar belongs to WCU, not here);
- `invite_join_conversion` = redeemed / created;
- `invites_per_active_member` = created / actives;
- `k_factor` = invites_per_active_member × invite_join_conversion.

Cross-week redemptions land in the redemption week (weekly inputs, not a
per-invite cohort study — v1 simplification, versioned here).

Not yet measured (no data source yet): member-follow-through rate (§10 —
needs "stayed" definition), notification opt-in (notifications epic owns the
`notification_optin` event), acquisition surface KPIs (GitHub/landing —
Cloudflare Web Analytics, not this DB).

## Versioning & backfill rules

- Definition change ⇒ bump the version on that metric AND this file's header,
  describe the change in a `## Changelog` entry, and state whether history is
  backfilled (recompute from base tables/events) or re-baselined (marked as a
  discontinuity in dashboards).
- Views are versionless in SQL (always current definition); the version lives
  here. Historical comparability is the responsibility of the changelog entry.
- Fixture pack: `supabase/tests/database/analytics_funnel.test.sql` must be
  updated in the same PR as any definition change — a metric without a fixture
  proving its edge cases does not ship.

## Changelog

- **1.1.0** (2026-07-10) — review fixes, pre-release (1.0.0 never shipped, so
  no backfill/re-baseline: views recompute from base data on deploy).
  - Alive-server → 1.1.0: criterion 2 ("≥3 non-owner members active") now
    counts only `message_sent`/`voice_joined`/`reaction_added`. Previously
    `server_joined`/`invite_redeemed` counted, so every invite join satisfied
    the bar and it collapsed into criterion 1.
  - Retention → 1.1.0: `dN_rate` numerators now apply the same maturity
    filter as the denominators. Previously an immature already-active user
    was counted retained but not measurable, letting in-progress cohort
    weeks report rates above 1.0.
- **1.0.0** (2026-07-10) — initial dictionary: WCU, alive-server (tightened),
  activation, D1/D7/D30 event-based retention, K-factor inputs; anti-gaming
  exclusion mechanism (`analytics.exclusions` + structural rules).
