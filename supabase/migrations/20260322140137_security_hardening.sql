-- =============================================================
-- Migration: security_hardening
--
-- WHY: Fixes 4 SQL security issues found during RLS audit.
--
-- C1 (CRITICAL): server_members_update_own allows self-promotion
--    to any role. FIX: add WITH CHECK that freezes role via
--    a new get_member_role() SECURITY DEFINER helper.
--
-- C2 (CRITICAL): server_members_delete_kick has raw subquery
--    against server_members, causing RLS recursion.
--    FIX: replace with get_member_role() helper call.
--
-- H4 (HIGH): messages_update_moderator_softdelete grants
--    moderator+ full UPDATE on all message columns.
--    FIX: BEFORE UPDATE trigger blocks non-authors from
--    changing content/author_id/is_edited/is_pinned.
--
-- M1 (MEDIUM): channel_role_access policies lack idempotency
--    guards (no DROP IF EXISTS before CREATE).
--    FIX: re-create all 4 policies with DROP IF EXISTS.
--
-- All statements are idempotent (CREATE OR REPLACE, DROP IF EXISTS).
-- =============================================================


-- ─────────────────────────────────────────────────────────────
-- C1+C2 prerequisite: get_member_role() SECURITY DEFINER helper
--
-- WHY: Returns the caller's role in a server without triggering
-- RLS on server_members. Used by:
--   - server_members_update_own WITH CHECK (freeze role)
--   - server_members_delete_kick (replace raw subquery)
--
-- Pattern: matches existing helpers in
-- 20260322120000_add_roles_to_server_members.sql:L100-L113
-- (has_server_role) and 20260316015000:L18-L29 (is_server_member).
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_member_role(p_server_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT role FROM public.server_members
    WHERE server_id = p_server_id
      AND user_id = auth.uid();
$$;


-- ─────────────────────────────────────────────────────────────
-- C1 FIX: server_members_update_own — prevent role self-promotion
--
-- WHY: The old policy (rls_hardening.sql:L176-L179) had
-- USING (user_id = auth.uid()) with no WITH CHECK, allowing
-- members to SET role = 'owner' on their own row.
--
-- The WITH CHECK ensures that after the UPDATE, the role column
-- equals the value fetched via get_member_role() — which reads
-- the pre-UPDATE value through SECURITY DEFINER (no recursion).
-- This effectively makes `role` immutable from the row owner's
-- perspective.
-- ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS server_members_update_own ON public.server_members;
CREATE POLICY server_members_update_own ON public.server_members
    FOR UPDATE TO authenticated
    USING (user_id = auth.uid())
    WITH CHECK (
        user_id = auth.uid()
        AND role = public.get_member_role(server_id)
    );


-- ─────────────────────────────────────────────────────────────
-- C2 FIX: server_members_delete_kick — remove raw subquery
--
-- WHY: The old policy (rls_role_based_policies.sql:L139-L149)
-- used a raw SELECT against server_members inside USING, which
-- triggers RLS recursion. Replacing with get_member_role()
-- (SECURITY DEFINER) avoids the recursion.
-- ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS server_members_delete_kick ON public.server_members;
CREATE POLICY server_members_delete_kick ON public.server_members
    FOR DELETE TO authenticated
    USING (
        user_id != auth.uid()
        AND public.has_server_role(server_id, 'moderator')
        AND public.get_role_level(public.get_member_role(server_id))
            > public.get_role_level(role)
    );


-- ─────────────────────────────────────────────────────────────
-- H4 FIX: protect_message_content trigger
--
-- WHY: messages_update_moderator_softdelete (rls_role_based_policies.sql:L96-L103)
-- grants moderator+ full UPDATE on all message columns.
-- RLS WITH CHECK cannot reference OLD, so a BEFORE UPDATE
-- trigger is the correct mechanism to restrict column changes.
--
-- Rule: if the caller is NOT the message author, only
-- deleted_at and edited_at may change. Everything else
-- (content, is_edited, is_pinned, author_id, channel_id,
-- reply_to_id) must remain identical.
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

    -- Non-author: block changes to anything except deleted_at
    IF NEW.content IS DISTINCT FROM OLD.content
       OR NEW.is_edited IS DISTINCT FROM OLD.is_edited
       OR NEW.is_pinned IS DISTINCT FROM OLD.is_pinned
       OR NEW.author_id IS DISTINCT FROM OLD.author_id
       OR NEW.channel_id IS DISTINCT FROM OLD.channel_id
       OR NEW.reply_to_id IS DISTINCT FROM OLD.reply_to_id
    THEN
        RAISE EXCEPTION 'non-author can only modify deleted_at'
            USING ERRCODE = '42501'; -- insufficient_privilege
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_message_content_trigger ON public.messages;
CREATE TRIGGER protect_message_content_trigger
    BEFORE UPDATE ON public.messages
    FOR EACH ROW
    EXECUTE FUNCTION public.protect_message_content();


-- ─────────────────────────────────────────────────────────────
-- M1 FIX: channel_role_access policies — add idempotency guards
--
-- WHY: channel_permissions.sql:L47-L81 uses bare CREATE POLICY
-- without DROP IF EXISTS. If the migration were ever re-applied
-- or if a future migration needs to recreate these, it would
-- fail. This re-creates all 4 policies idempotently.
-- ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS channel_role_access_select_admin ON public.channel_role_access;
CREATE POLICY channel_role_access_select_admin ON public.channel_role_access
    FOR SELECT TO authenticated
    USING (
        public.has_server_role(
            (SELECT c.server_id FROM public.channels c WHERE c.id = channel_role_access.channel_id),
            'admin'
        )
    );

DROP POLICY IF EXISTS channel_role_access_insert_admin ON public.channel_role_access;
CREATE POLICY channel_role_access_insert_admin ON public.channel_role_access
    FOR INSERT TO authenticated
    WITH CHECK (
        public.has_server_role(
            (SELECT c.server_id FROM public.channels c WHERE c.id = channel_role_access.channel_id),
            'admin'
        )
    );

DROP POLICY IF EXISTS channel_role_access_update_admin ON public.channel_role_access;
CREATE POLICY channel_role_access_update_admin ON public.channel_role_access
    FOR UPDATE TO authenticated
    USING (
        public.has_server_role(
            (SELECT c.server_id FROM public.channels c WHERE c.id = channel_role_access.channel_id),
            'admin'
        )
    );

DROP POLICY IF EXISTS channel_role_access_delete_admin ON public.channel_role_access;
CREATE POLICY channel_role_access_delete_admin ON public.channel_role_access
    FOR DELETE TO authenticated
    USING (
        public.has_server_role(
            (SELECT c.server_id FROM public.channels c WHERE c.id = channel_role_access.channel_id),
            'admin'
        )
    );
