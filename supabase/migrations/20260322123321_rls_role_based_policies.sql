-- =============================================================
-- Migration: rls_role_based_policies (Phase 2b)
--
-- WHY: Replace binary owner/member permission checks with
-- role-based checks using has_server_role(). This enables the
-- owner > admin > moderator > member hierarchy across all tables.
--
-- Pattern: DROP POLICY IF EXISTS + CREATE POLICY for each change.
-- All policies target TO authenticated explicitly.
--
-- Depends on:
--   - 20260322120000_add_roles_to_server_members.sql (has_server_role, get_role_level)
--   - 20260322123249_channel_permissions.sql (is_channel_member update, is_private, is_read_only)
-- =============================================================


-- ─────────────────────────────────────────────────────────────
-- 1. servers table policies
-- ─────────────────────────────────────────────────────────────

-- servers UPDATE: owner-only → admin+ can update server name/desc
-- WHY: admins should manage server settings without needing ownership.
DROP POLICY IF EXISTS servers_update_owner ON public.servers;
CREATE POLICY servers_update_admin ON public.servers
    FOR UPDATE TO authenticated
    USING (public.has_server_role(id, 'admin'));

-- servers DELETE: stays owner-only (destructive action)
-- WHY: deleting a server is irreversible; only the owner should do this.
-- No change needed — servers_delete_owner already uses owner_id = auth.uid().


-- ─────────────────────────────────────────────────────────────
-- 2. channels table policies
-- WHY: Channel management (create/update/delete) moves from
-- any-member to admin+. SELECT now uses is_channel_member()
-- which handles private channel gating internally.
-- ─────────────────────────────────────────────────────────────

-- channels SELECT: use is_channel_member() for private channel support
-- WHY: is_channel_member() now checks is_private + channel_role_access,
-- so this single policy handles both public and private channels.
DROP POLICY IF EXISTS channels_select_member ON public.channels;
CREATE POLICY channels_select_member ON public.channels
    FOR SELECT TO authenticated
    USING (public.is_channel_member(id));

-- channels INSERT: any-member → admin+
DROP POLICY IF EXISTS channels_insert_member ON public.channels;
CREATE POLICY channels_insert_admin ON public.channels
    FOR INSERT TO authenticated
    WITH CHECK (public.has_server_role(server_id, 'admin'));

-- channels UPDATE: remove both old permissive policies, replace with one admin+ policy
DROP POLICY IF EXISTS channels_update_member ON public.channels;
DROP POLICY IF EXISTS channels_update_owner ON public.channels;
CREATE POLICY channels_update_admin ON public.channels
    FOR UPDATE TO authenticated
    USING (public.has_server_role(server_id, 'admin'));

-- channels DELETE: remove both old permissive policies, replace with one admin+ policy
DROP POLICY IF EXISTS channels_delete_member ON public.channels;
DROP POLICY IF EXISTS channels_delete_owner ON public.channels;
CREATE POLICY channels_delete_admin ON public.channels
    FOR DELETE TO authenticated
    USING (public.has_server_role(server_id, 'admin'));


-- ─────────────────────────────────────────────────────────────
-- 3. messages table policies
-- ─────────────────────────────────────────────────────────────

-- messages INSERT: add read-only channel enforcement
-- WHY: If a channel is read-only, only admin+ can post messages.
-- Uses WITH CHECK (not USING) because this is an INSERT policy.
-- is_channel_member() already gates private channel access.
DROP POLICY IF EXISTS messages_insert_member ON public.messages;
CREATE POLICY messages_insert_member ON public.messages
    FOR INSERT TO authenticated
    WITH CHECK (
        author_id = auth.uid()
        AND public.is_channel_member(channel_id)
        AND (
            (SELECT c.is_read_only FROM public.channels c WHERE c.id = channel_id) = false
            OR public.has_server_role(
                (SELECT c.server_id FROM public.channels c WHERE c.id = channel_id),
                'admin'
            )
        )
    );

-- messages UPDATE (soft-delete by moderator+): replace owner-only with moderator+
-- WHY: moderators need to soft-delete rule-breaking messages, not just the owner.
-- This is permissive alongside messages_update_author (Postgres ORs them).
DROP POLICY IF EXISTS messages_update_owner_softdelete ON public.messages;
CREATE POLICY messages_update_moderator_softdelete ON public.messages
    FOR UPDATE TO authenticated
    USING (
        public.has_server_role(
            (SELECT c.server_id FROM public.channels c WHERE c.id = messages.channel_id),
            'moderator'
        )
    );


-- ─────────────────────────────────────────────────────────────
-- 4. server_bans table policies
-- WHY: Ban management moves from owner-only to admin+.
-- Also fixes roles from {public} to TO authenticated (defense-in-depth).
-- ─────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS server_bans_select_owner ON public.server_bans;
CREATE POLICY server_bans_select_admin ON public.server_bans
    FOR SELECT TO authenticated
    USING (public.has_server_role(server_id, 'admin'));

DROP POLICY IF EXISTS server_bans_insert_owner ON public.server_bans;
CREATE POLICY server_bans_insert_admin ON public.server_bans
    FOR INSERT TO authenticated
    WITH CHECK (public.has_server_role(server_id, 'admin'));

DROP POLICY IF EXISTS server_bans_delete_owner ON public.server_bans;
CREATE POLICY server_bans_delete_admin ON public.server_bans
    FOR DELETE TO authenticated
    USING (public.has_server_role(server_id, 'admin'));


-- ─────────────────────────────────────────────────────────────
-- 5. server_members table policies
-- WHY: Kick permission moves from owner-only to moderator+ with
-- role hierarchy enforcement: caller must have a strictly higher
-- role level than the target member. Prevents moderators from
-- kicking admins or other moderators.
--
-- Self-leave (server_members_delete_own) is unchanged.
-- ─────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS server_members_delete_owner ON public.server_members;
CREATE POLICY server_members_delete_kick ON public.server_members
    FOR DELETE TO authenticated
    USING (
        user_id != auth.uid()
        AND public.has_server_role(server_id, 'moderator')
        AND public.get_role_level(
            (SELECT sm.role FROM public.server_members sm
             WHERE sm.server_id = server_members.server_id
               AND sm.user_id = auth.uid())
        ) > public.get_role_level(role)
    );


-- ─────────────────────────────────────────────────────────────
-- 6. invites table policies
-- WHY: Prevent invite creation for DM servers. DMs use a
-- separate flow and should never have invite links.
-- ─────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS invites_insert_member ON public.invites;
CREATE POLICY invites_insert_member ON public.invites
    FOR INSERT TO authenticated
    WITH CHECK (
        creator_id = auth.uid()
        AND public.is_server_member(server_id)
        AND (SELECT s.is_dm FROM public.servers s WHERE s.id = server_id) = false
    );

-- invites DELETE: upgrade to admin+ OR own invite creator
-- WHY: admins should be able to revoke any invite, not just the server owner.
DROP POLICY IF EXISTS invites_delete_owner_or_creator ON public.invites;
CREATE POLICY invites_delete_admin_or_creator ON public.invites
    FOR DELETE TO authenticated
    USING (
        creator_id = auth.uid()
        OR public.has_server_role(server_id, 'admin')
    );
