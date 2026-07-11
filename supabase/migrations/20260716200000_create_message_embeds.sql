-- =============================================================
-- Migration: create_message_embeds (link previews)
--
-- 1) `message_embeds` — one row per unfurled URL preview attached to a
--    message (Open Graph / twitter-card metadata). Written by the async
--    unfurl worker AFTER the message commits; read via a batch query
--    zipped into each message (mirrors message_attachments).
--    `suppressed` implements author-removal: the row is kept (never
--    deleted) so the same message never re-unfurls that URL, but
--    suppressed rows are excluded from every read path.
-- 2) `link_unfurl_cache` — unfurl results keyed by normalized URL so
--    repeated links skip the outbound fetch. TTL is enforced at read
--    time (`fetched_at` recency check in the query), not by a sweeper.
--    Failed unfurls are cached too (all-NULL metadata) to prevent
--    refetch storms on dead links.
--
-- Idempotent per ADR-019 — safe to re-run. Additive only.
-- =============================================================

-- ─────────────────────────────────────────────────────────────
-- Table: message_embeds
-- WHY ON DELETE CASCADE: messages are soft-deleted (ADR-038), so the
-- cascade never fires in normal operation — correctness insurance for
-- true-DELETE paths (test teardown, GDPR hard-erase later), same
-- posture as message_attachments.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS message_embeds (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id  UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    url         TEXT NOT NULL,
    title       TEXT,
    description TEXT,
    site_name   TEXT,
    image_url   TEXT,
    -- Author-removed previews stay as suppressed rows (never re-unfurl).
    suppressed  BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Batch read is `WHERE message_id = ANY($1)` — index the FK.
CREATE INDEX IF NOT EXISTS idx_message_embeds_message_id
    ON message_embeds (message_id);

-- RLS: embeds inherit the visibility of their parent message — same
-- membership gate as message_attachments_select_via_message. No direct
-- client access anyway (the Rust API is the only reader, service_role
-- bypasses RLS) — but ADR-040 requires RLS ON.
ALTER TABLE message_embeds ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'message_embeds'
          AND policyname = 'message_embeds_select_via_message'
    ) THEN
        CREATE POLICY message_embeds_select_via_message ON message_embeds
            FOR SELECT TO authenticated
            USING (
                NOT suppressed
                AND public.is_channel_member(
                    (SELECT m.channel_id FROM public.messages m
                     WHERE m.id = message_embeds.message_id)
                )
            );
    END IF;
END $$;

-- ─────────────────────────────────────────────────────────────
-- Table: link_unfurl_cache
-- WHY no policies: server-internal cache — only the Rust API
-- (service_role, bypasses RLS) reads or writes it. RLS ON with zero
-- policies denies every client role (ADR-040 fail-closed).
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS link_unfurl_cache (
    normalized_url TEXT PRIMARY KEY,
    title          TEXT,
    description    TEXT,
    site_name      TEXT,
    image_url      TEXT,
    fetched_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE link_unfurl_cache ENABLE ROW LEVEL SECURITY;
