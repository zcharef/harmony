-- =============================================================
-- Migration: idx_messages_rate_limit
--
-- WHY: The Rust API enforces per-channel message rate limiting by
-- counting recent messages per author. Without this index, the
-- COUNT query does a sequential scan on potentially millions of rows.
-- =============================================================

CREATE INDEX IF NOT EXISTS idx_messages_author_channel_created
    ON public.messages (author_id, channel_id, created_at DESC);
