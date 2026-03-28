-- =============================================================
-- Migration: messages_update_delete_rls
-- Adds: RLS policy for UPDATE on messages (edit + soft delete)
-- =============================================================

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE policyname = 'messages_update_author' AND tablename = 'messages'
    ) THEN
        CREATE POLICY messages_update_author ON public.messages
            FOR UPDATE USING (
                author_id = auth.uid()
                AND deleted_at IS NULL
            ) WITH CHECK (
                author_id = auth.uid()
            );
    END IF;
END $$;
