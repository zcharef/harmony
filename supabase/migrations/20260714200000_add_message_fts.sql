-- =============================================================
-- Migration: add_message_fts
-- Adds: content_tsv generated FTS vector on messages + GIN index.
--
-- WHY a STORED generated column (not a trigger): the tsvector is a pure
-- function of the same row's content + encrypted flag, so a generated
-- column is the SSoT with zero trigger code to drift. `to_tsvector` is
-- called in its TWO-ARG form ('english'::regconfig, text) which is
-- IMMUTABLE — the one-arg form is only STABLE and is rejected in a
-- generated-column expression.
--
-- WHY NULL for encrypted rows: E2EE messages store ciphertext in
-- `content`; indexing it is useless (never matches a plaintext query)
-- and only bloats the GIN index. `encrypted` is a same-table column
-- (20260322180002_add_encryption_to_messages.sql) so the CASE is legal
-- in a generated column. Encrypted messages are therefore un-searchable
-- server-side BY CONSTRUCTION (see spec §1, §6). The query layer ALSO
-- filters c.encrypted/m.encrypted (belt + suspenders).
--
-- NOTE (ops): adding a STORED generated column rewrites the table under
-- ACCESS EXCLUSIVE and backfills every existing row; the GIN index build
-- is non-concurrent (migration runs in a txn). Acceptable at current
-- alpha scale. If `messages` grows large before this ships, split into a
-- plain nullable column + backfill + CREATE INDEX CONCURRENTLY outside a
-- txn — NOT needed now.
-- =============================================================

ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS content_tsv tsvector
    GENERATED ALWAYS AS (
        CASE
            WHEN encrypted THEN NULL
            ELSE to_tsvector('english', COALESCE(content, ''))
        END
    ) STORED;

CREATE INDEX IF NOT EXISTS idx_messages_content_tsv
    ON messages USING GIN (content_tsv);
