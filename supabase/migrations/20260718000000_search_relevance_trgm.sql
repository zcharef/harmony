-- =============================================================
-- Migration: search_relevance_trgm
-- Adds: pg_trgm extension + partial trigram GIN index on message content.
--
-- WHY: message search already uses Postgres full-text search (the STORED
-- `content_tsv` column from 20260714200000_add_message_fts.sql). FTS is
-- token/stem based: it matches whole words, case-insensitively, but it
-- CANNOT match a partial word (`deploy` vs `deployment`) and has zero typo
-- tolerance (`deploymnet` matches nothing). Trigram similarity fixes both in
-- one operator, and is similarity-scored so the best match can rank first.
--
-- The hybrid search predicate becomes `content_tsv @@ query OR $q <% content`:
-- FTS stays the ranked recall engine, trigram adds the forgiving fuzzy branch.
-- The `<%` (word_similarity) operator is index-backed by a `gin_trgm_ops`
-- index, so the fuzzy branch stays an index scan rather than a seq scan.
--
-- WHY a PARTIAL index (`WHERE encrypted = false AND deleted_at IS NULL`): it
-- mirrors the search WHERE clause exactly. Encrypted rows hold ciphertext
-- (never a useful plaintext match) and soft-deleted rows are never returned,
-- so indexing them only bloats the GIN. This keeps the index lean and aligned
-- with the FTS migration's stance (content_tsv is NULL for encrypted rows).
--
-- NOTE (ops): the GIN index is built non-concurrently inside the migration
-- txn (ACCESS EXCLUSIVE on `messages`). Acceptable at current alpha scale —
-- same reasoning already documented for `content_tsv`. If `messages` grows
-- large before this ships, split into `CREATE INDEX CONCURRENTLY` outside a
-- txn — NOT needed now. Idempotent + non-destructive (ADR-019).
-- =============================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_messages_content_trgm
    ON messages USING GIN (content gin_trgm_ops)
    WHERE encrypted = false AND deleted_at IS NULL;
