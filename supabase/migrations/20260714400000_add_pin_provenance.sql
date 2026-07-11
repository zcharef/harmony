-- =============================================================
-- Migration: add_pin_provenance
-- Adds pinned_by / pinned_at to messages so the pinned panel can
-- show who pinned a message and order by pin recency. The is_pinned
-- flag and idx_messages_pinned already exist (create_messages).
--
-- No RLS change: rows are already covered by messages_select_member.
-- No trigger change: protect_message_content() bypasses the
-- service_role pool (auth.uid() IS NULL), and pin authorization is
-- enforced in MessageService::set_pinned.
-- =============================================================

ALTER TABLE public.messages
    ADD COLUMN IF NOT EXISTS pinned_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ;

-- Ordered pinned lookup (panel is pinned_at DESC). Supersedes the
-- read pattern of the existing idx_messages_pinned (kept — it still
-- serves the flag filter and is non-destructive to drop-free ADR-019).
CREATE INDEX IF NOT EXISTS idx_messages_pinned_at
    ON public.messages (channel_id, pinned_at DESC)
    WHERE is_pinned = true;
