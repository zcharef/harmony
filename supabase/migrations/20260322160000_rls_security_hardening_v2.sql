-- =============================================================
-- Migration: rls_security_hardening_v2
--
-- WHY: Fixes 3 RLS security issues found during audit.
--
-- H1 (HIGH): deleted_by spoofing — protect_message_content trigger
--    allows non-authors to set deleted_by to ANY UUID, enabling a
--    moderator to attribute deletion to someone else.
--    FIX: enforce deleted_by = auth.uid() for non-author updates.
--
-- H2 (HIGH): is_server_member() does NOT check server_bans. If
--    the API has a bug that leaves server_members intact after
--    banning, the banned user retains read access to all data.
--    FIX: add NOT EXISTS(server_bans) to is_server_member() and
--    is_channel_member(). Also add a trigger on server_bans INSERT
--    that auto-deletes the server_members row (belt AND suspenders).
--
-- M1 (MEDIUM): messages_update_moderator_softdelete has no
--    WITH CHECK, so moderators could theoretically change any
--    column. The trigger stops this today, but defense-in-depth
--    at the policy level prevents author_id hijacking if the
--    trigger is ever dropped.
--    FIX: add WITH CHECK that locks author_id.
--
-- All statements are idempotent (CREATE OR REPLACE, DROP IF EXISTS).
-- =============================================================


-- ─────────────────────────────────────────────────────────────
-- H1 FIX: deleted_by spoofing in protect_message_content
--
-- WHY: The current trigger (20260322150000:L29-L55) allows
-- non-authors to set deleted_by to any UUID. A moderator could
-- attribute deletion to a different user, which is a spoofing
-- vector. Non-authors who change deleted_by MUST set it to
-- their own auth.uid().
--
-- Pattern: matches existing protect_message_content() from
-- 20260322150000_add_deleted_by_to_messages.sql:L29-L55
-- ─────────────────────────────────────────────────────────────
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

    -- Non-author: if changing deleted_by, it must be their own uid
    IF NEW.deleted_by IS DISTINCT FROM OLD.deleted_by
       AND NEW.deleted_by IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'deleted_by must be the deleting user''s own ID'
            USING ERRCODE = '42501'; -- insufficient_privilege
    END IF;

    RETURN NEW;
END;
$$;


-- ─────────────────────────────────────────────────────────────
-- H2 FIX (part 1): is_server_member() — add ban check
--
-- WHY: If the API has a bug that leaves the server_members row
-- intact after a ban, the user retains full read access through
-- every policy that calls is_server_member(). Adding a NOT EXISTS
-- against server_bans closes this gap at the DB level.
--
-- Pattern: matches existing is_server_member() from
-- 20260316015000_fix_server_members_rls_recursion.sql:L18-L29
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.is_server_member(p_server_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.server_members
        WHERE server_id = p_server_id AND user_id = auth.uid()
    )
    AND NOT EXISTS (
        SELECT 1 FROM public.server_bans sb
        WHERE sb.server_id = p_server_id AND sb.user_id = auth.uid()
    );
$$;


-- ─────────────────────────────────────────────────────────────
-- H2 FIX (part 2): is_channel_member() — add ban check
--
-- WHY: is_channel_member() joins server_members directly instead
-- of calling is_server_member(), so it needs its own ban check.
-- Without this, banned users who still have a server_members row
-- can read messages, reactions, and read states.
--
-- Pattern: matches existing is_channel_member() from
-- 20260322123249_channel_permissions.sql:L97-L120
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.is_channel_member(p_channel_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.channels c
        JOIN public.server_members sm ON sm.server_id = c.server_id
        WHERE c.id = p_channel_id
          AND sm.user_id = auth.uid()
          AND NOT EXISTS (
              SELECT 1 FROM public.server_bans sb
              WHERE sb.server_id = c.server_id AND sb.user_id = auth.uid()
          )
          AND (
              c.is_private = false
              OR public.get_role_level(sm.role) >= public.get_role_level('admin')
              OR EXISTS (
                  SELECT 1 FROM public.channel_role_access cra
                  WHERE cra.channel_id = c.id
                    AND cra.role = sm.role
              )
          )
    );
$$;


-- ─────────────────────────────────────────────────────────────
-- H2 FIX (part 3): auto-remove server_members row on ban
--
-- WHY: Belt AND suspenders. The helpers above block access even
-- if the member row lingers, but cleaning up the row prevents
-- stale data from confusing the API or PowerSync clients.
-- This also means the ban check in the helpers will rarely fire
-- in practice — it is purely a safety net.
--
-- Pattern: trigger + function, same as protect_message_content
-- from 20260322140137_security_hardening.sql:L107-L139
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.on_server_ban_created()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    DELETE FROM public.server_members
    WHERE server_id = NEW.server_id
      AND user_id = NEW.user_id;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_server_ban_cleanup ON public.server_bans;
CREATE TRIGGER trg_server_ban_cleanup
    AFTER INSERT ON public.server_bans
    FOR EACH ROW
    EXECUTE FUNCTION public.on_server_ban_created();


-- ─────────────────────────────────────────────────────────────
-- M1 FIX: messages_update_moderator_softdelete — add WITH CHECK
--
-- WHY: The current policy (rls_role_based_policies.sql:L96-L103)
-- has no WITH CHECK, so Postgres allows moderators to write any
-- column values. The trigger catches this today, but if the
-- trigger were ever dropped or altered, moderators could hijack
-- author_id. Defense-in-depth: lock author_id at the policy level.
--
-- How it works: WITH CHECK evaluates the NEW row. We subquery the
-- current author_id from the table (which returns the OLD value
-- because the UPDATE hasn't committed yet within the policy check)
-- and require it to match the NEW author_id.
-- ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS messages_update_moderator_softdelete ON public.messages;
CREATE POLICY messages_update_moderator_softdelete ON public.messages
    FOR UPDATE TO authenticated
    USING (
        public.has_server_role(
            (SELECT c.server_id FROM public.channels c WHERE c.id = messages.channel_id),
            'moderator'
        )
    )
    WITH CHECK (
        author_id = (SELECT m.author_id FROM public.messages m WHERE m.id = messages.id)
    );
