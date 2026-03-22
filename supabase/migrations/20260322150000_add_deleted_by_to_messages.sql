-- =============================================================
-- Migration: add_deleted_by_to_messages
--
-- WHY: Track WHO deleted a message so the frontend can distinguish
-- self-deleted messages ("[Message deleted]") from moderator-deleted
-- messages ("[Message removed by moderator]").
--
-- Adds a nullable `deleted_by` UUID column to messages.
-- Updates the protect_message_content trigger to also allow
-- non-authors to set `deleted_by` (alongside `deleted_at`).
-- =============================================================

-- Add column (idempotent via IF NOT EXISTS pattern)
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'messages'
          AND column_name = 'deleted_by'
    ) THEN
        ALTER TABLE public.messages
            ADD COLUMN deleted_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL;
    END IF;
END $$;

-- WHY: Update the trigger to also allow non-authors to modify deleted_by.
-- Original trigger (security_hardening.sql:L107-L133) only allowed
-- non-authors to change deleted_at. Now it also allows deleted_by.
CREATE OR REPLACE FUNCTION public.protect_message_content()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    -- If the caller is the message author, allow all changes
    IF NEW.author_id = auth.uid() THEN
        RETURN NEW;
    END IF;

    -- Non-author: block changes to anything except deleted_at and deleted_by
    IF NEW.content IS DISTINCT FROM OLD.content
       OR NEW.is_edited IS DISTINCT FROM OLD.is_edited
       OR NEW.is_pinned IS DISTINCT FROM OLD.is_pinned
       OR NEW.author_id IS DISTINCT FROM OLD.author_id
       OR NEW.channel_id IS DISTINCT FROM OLD.channel_id
       OR NEW.reply_to_id IS DISTINCT FROM OLD.reply_to_id
    THEN
        RAISE EXCEPTION 'non-author can only modify deleted_at and deleted_by'
            USING ERRCODE = '42501'; -- insufficient_privilege
    END IF;

    RETURN NEW;
END;
$$;
