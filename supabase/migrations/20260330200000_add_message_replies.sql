-- =============================================================
-- Migration: add_message_replies
-- Adds: parent_message_id FK for message reply threading
-- =============================================================

ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS parent_message_id UUID REFERENCES messages(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_messages_parent_id
    ON messages(parent_message_id)
    WHERE parent_message_id IS NOT NULL;
