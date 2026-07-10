-- =============================================================
-- Migration: index_reactions_ordered
-- Supports the "who reacted" batch read-model: the reactor list is ordered by
-- (created_at, user_id) within each (message_id, emoji) partition and capped at
-- the first 10. Indexing all four columns lets Postgres satisfy the window
-- ORDER BY (ROW_NUMBER / MIN) fully from the index — including deterministic
-- created_at ties broken by user_id — without a per-group sort.
--
-- Non-destructive (ADR-019): idx_message_reactions_message stays — it still
-- serves the RLS existence checks and single-column lookups.
-- =============================================================

CREATE INDEX IF NOT EXISTS idx_message_reactions_message_emoji_created
    ON public.message_reactions (message_id, emoji, created_at, user_id);
