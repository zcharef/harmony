-- =============================================================
-- Migration: channels_crud_policies
-- Adds: updated_at column, update trigger, member-level
--       UPDATE and DELETE RLS policies for channels CRUD
-- =============================================================

-- ─────────────────────────────────────────────────────────────
-- 1. Add updated_at column to channels
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.channels
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- ─────────────────────────────────────────────────────────────
-- 2. Auto-update updated_at on row change
--    Reuses public.set_updated_at() from create_profiles migration
-- ─────────────────────────────────────────────────────────────
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_channels_updated_at'
    ) THEN
        CREATE TRIGGER trg_channels_updated_at
            BEFORE UPDATE ON public.channels
            FOR EACH ROW
            EXECUTE FUNCTION public.set_updated_at();
    END IF;
END $$;

-- ─────────────────────────────────────────────────────────────
-- 3. RLS UPDATE — members can update channels in their servers
--    (permissive; Postgres ORs this with channels_update_owner)
--
-- WHY: For v0.1.0 walking skeleton, all server members have full
-- channel management permissions. Role-based permissions (e.g.
-- restrict CUD to admins/owners) will be added in a future milestone.
-- ─────────────────────────────────────────────────────────────
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE policyname = 'channels_update_member' AND tablename = 'channels'
    ) THEN
        CREATE POLICY channels_update_member ON public.channels
            FOR UPDATE TO authenticated
            USING (
                EXISTS (
                    SELECT 1 FROM public.server_members sm
                    WHERE sm.server_id = channels.server_id
                    AND sm.user_id = auth.uid()
                )
            );
    END IF;
END $$;

-- ─────────────────────────────────────────────────────────────
-- 4. RLS DELETE — members can delete channels in their servers
--    (permissive; Postgres ORs this with channels_delete_owner)
--    Same v0.1.0 rationale as UPDATE above.
-- ─────────────────────────────────────────────────────────────
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE policyname = 'channels_delete_member' AND tablename = 'channels'
    ) THEN
        CREATE POLICY channels_delete_member ON public.channels
            FOR DELETE TO authenticated
            USING (
                EXISTS (
                    SELECT 1 FROM public.server_members sm
                    WHERE sm.server_id = channels.server_id
                    AND sm.user_id = auth.uid()
                )
            );
    END IF;
END $$;
