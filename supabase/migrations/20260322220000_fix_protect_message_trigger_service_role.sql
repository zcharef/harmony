-- =============================================================
-- Migration: fix_protect_message_trigger_service_role
--
-- WHY: The protect_message_content() trigger calls auth.uid()
-- to determine if the caller is the message author. When the
-- Rust API connects directly as the postgres superuser,
-- auth.uid() returns NULL. This causes:
--
--   1. The author check (NEW.author_id = auth.uid()) to fail
--      because <uuid> = NULL is always NULL/false in SQL.
--   2. The deleted_by spoofing check
--      (NEW.deleted_by IS DISTINCT FROM auth.uid()) to fire
--      because <uuid> IS DISTINCT FROM NULL is always true.
--   3. The trigger raises 'deleted_by must be the deleting
--      user''s own ID' → Postgres returns error code 42501
--      → the API maps this to HTTP 500.
--
-- FIX: When auth.uid() IS NULL, the caller is a superuser or
-- service_role connection. Authorization is already enforced by
-- the API service layer (MessageService::delete_message). The
-- trigger is defense-in-depth for Realtime/PowerSync clients
-- where auth.uid() is set. Bypass all checks for superuser.
--
-- Impact: DELETE message endpoint returns 204 instead of 500.
-- =============================================================

CREATE OR REPLACE FUNCTION public.protect_message_content()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    -- WHY: When the Rust API connects as postgres superuser,
    -- auth.uid() returns NULL. Authorization is handled by the
    -- API service layer; the trigger is defense-in-depth for
    -- Realtime/PowerSync clients only.
    --
    -- INVARIANT: This bypass is safe because no anon-role write
    -- policies (INSERT/UPDATE/DELETE) exist on the messages table.
    -- If anon write policies are ever added, this NULL check must
    -- be replaced with an explicit role check (e.g. current_setting
    -- ('request.jwt.claims')::json->>'role' = 'service_role').
    IF auth.uid() IS NULL THEN
        RETURN NEW;
    END IF;

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

    -- Non-author: if changing deleted_by, it must be their own uid
    IF NEW.deleted_by IS DISTINCT FROM OLD.deleted_by
       AND NEW.deleted_by IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'deleted_by must be the deleting user''s own ID'
            USING ERRCODE = '42501'; -- insufficient_privilege
    END IF;

    RETURN NEW;
END;
$$;
