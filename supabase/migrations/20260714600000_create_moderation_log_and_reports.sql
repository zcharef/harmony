-- =============================================================
-- Moderation Dashboard v2 (T3.3) — audit log + reports queue.
--
-- Two append-only moderation surfaces, both written by the Rust
-- API only (clients never INSERT). RLS is defense-in-depth
-- (ADR-040): the Rust API is the primary enforcer over the
-- service_role connection, which bypasses RLS.
-- Idempotent + non-destructive (ADR-019).
-- =============================================================

-- ── Audit log ────────────────────────────────────────────────

-- Action taxonomy. Extendable; unknown values rejected by the Rust enum.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'moderation_action') THEN
        CREATE TYPE public.moderation_action AS ENUM (
            'member_kick',
            'member_ban',
            'member_unban',
            'member_timeout',
            'member_timeout_remove',
            'message_delete',
            'message_bulk_delete'
        );
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.moderation_log (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id     UUID NOT NULL REFERENCES public.servers(id)  ON DELETE CASCADE,
    action        public.moderation_action NOT NULL,
    -- actor = the moderator (or SYSTEM_MODERATOR sentinel for automod deletes).
    actor_id      UUID NOT NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
    -- target user (kick/ban/timeout). NULL for message-only actions.
    target_user_id    UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    -- target message (message_delete). NULL for member-only actions.
    target_message_id UUID,   -- NO FK: messages are soft-deleted & may be purged.
    reason        TEXT CHECK (reason IS NULL OR char_length(reason) <= 512),
    -- action-specific extras: {"durationSeconds":600},{"count":12,"channelId":"…"}.
    metadata      JSONB NOT NULL DEFAULT '{}'::jsonb
                    CHECK (jsonb_typeof(metadata) = 'object'),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Cursor pagination + per-server newest-first listing (ADR-036).
CREATE INDEX IF NOT EXISTS idx_moderation_log_server_created
    ON public.moderation_log (server_id, created_at DESC, id DESC);

ALTER TABLE public.moderation_log ENABLE ROW LEVEL SECURITY;

-- Defense-in-depth: only server owner may SELECT via PowerSync/direct.
-- (Rust API enforces admin+ over the service_role connection, bypassing RLS.)
DROP POLICY IF EXISTS moderation_log_select_owner ON public.moderation_log;
CREATE POLICY moderation_log_select_owner ON public.moderation_log
    FOR SELECT USING (
        EXISTS (SELECT 1 FROM public.servers s
                WHERE s.id = moderation_log.server_id AND s.owner_id = auth.uid())
    );
-- No INSERT/UPDATE/DELETE policy → clients cannot write or tamper. Append-only.

-- ── Reports queue ────────────────────────────────────────────

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'report_status') THEN
        CREATE TYPE public.report_status AS ENUM ('open', 'resolved', 'dismissed');
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.message_reports (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id    UUID NOT NULL REFERENCES public.servers(id)   ON DELETE CASCADE,
    channel_id   UUID NOT NULL REFERENCES public.channels(id)  ON DELETE CASCADE,
    message_id   UUID NOT NULL,               -- NO FK (soft-delete/purge, see above)
    reporter_id  UUID NOT NULL REFERENCES public.profiles(id)  ON DELETE CASCADE,
    -- who authored the reported message; denormalised so the queue survives
    -- the message being purged and can still offer "ban author".
    reported_user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    reason       TEXT NOT NULL
                    CHECK (char_length(reason) >= 1 AND char_length(reason) <= 512),
    status       public.report_status NOT NULL DEFAULT 'open',
    resolved_by  UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    resolved_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One OPEN report per (reporter, message): idempotent re-report, 409 on dupe.
CREATE UNIQUE INDEX IF NOT EXISTS uq_message_reports_open
    ON public.message_reports (reporter_id, message_id)
    WHERE status = 'open';

-- Mod-queue listing: open reports per server, newest first (ADR-036).
CREATE INDEX IF NOT EXISTS idx_message_reports_server_status_created
    ON public.message_reports (server_id, status, created_at DESC, id DESC);

ALTER TABLE public.message_reports ENABLE ROW LEVEL SECURITY;
-- Defense-in-depth: reporter sees own; owner sees all. Rust API is primary gate.
DROP POLICY IF EXISTS message_reports_select ON public.message_reports;
CREATE POLICY message_reports_select ON public.message_reports
    FOR SELECT USING (
        reporter_id = auth.uid()
        OR EXISTS (SELECT 1 FROM public.servers s
                   WHERE s.id = message_reports.server_id AND s.owner_id = auth.uid())
    );
-- No client INSERT/UPDATE/DELETE → writes go through the Rust API only.
