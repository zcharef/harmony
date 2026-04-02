-- =============================================================
-- Migration: add_message_type
-- Adds message_type enum and system_event_key to messages table.
-- Enables system messages (join/leave announcements) without
-- per-event schema changes — new event types are frontend-only.
-- =============================================================

-- 1. Create the message_type enum
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'message_type') THEN
        CREATE TYPE message_type AS ENUM ('default', 'system');
    END IF;
END $$;

-- 2. Add message_type column (backward-compatible: defaults to 'default')
ALTER TABLE public.messages
    ADD COLUMN IF NOT EXISTS message_type message_type NOT NULL DEFAULT 'default';

-- 3. Add system_event_key column (nullable — only set for system messages)
ALTER TABLE public.messages
    ADD COLUMN IF NOT EXISTS system_event_key TEXT;

-- 4. CHECK constraint: system_event_key must be set iff message_type = 'system'
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_system_event_key_consistency'
    ) THEN
        ALTER TABLE public.messages
            ADD CONSTRAINT chk_system_event_key_consistency
            CHECK ((message_type = 'system') = (system_event_key IS NOT NULL));
    END IF;
END $$;
