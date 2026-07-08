-- =============================================================
-- Migration: add_message_mentions
-- Adds: mentioned_user_ids sidecar on messages.
-- WHY plaintext sidecar even for E2EE messages: the server cannot
-- parse ciphertext, but must route targeted mention events and
-- compute badge counts. This intentionally leaks WHO is mentioned
-- (not what was said) — see spec §6 "E2EE metadata leak".
--
-- No index: mentioned_user_ids is only evaluated as a FILTER predicate
-- on rows already selected by the read-state join — never as a
-- standalone lookup. YAGNI.
--
-- No RLS change: messages policies are row-scoped, the new column
-- rides existing rows.
-- =============================================================

ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS mentioned_user_ids UUID[] NOT NULL DEFAULT '{}';
