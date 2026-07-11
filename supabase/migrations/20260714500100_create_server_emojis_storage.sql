-- =============================================================
-- Migration: create_server_emojis_storage
-- Bucket `server-emojis` (public read). Objects live under
-- `{server_id}/{uuid}.{ext}`. Write is restricted to callers who
-- are Admin+ in that server (has_server_role). Hard byte ceiling
-- 1 MB = the Creator-tier cap (per-plan sub-caps enforced client-
-- side + server-side count check; see §3/§9).
-- Idempotent per ADR-019.
-- =============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'server-emojis',
    'server-emojis',
    true,
    1048576, -- 1 MB, the Creator-tier max (RED LINE for hard ceiling)
    ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO NOTHING;

-- No SELECT policy: public bucket renders via /storage/v1/object/public/...
-- A SELECT policy would additionally grant the LIST API and let anyone
-- enumerate server_id folders (same decision as avatars_storage).

-- INSERT: Admin+ of the server named by the first path segment.
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'storage' AND tablename = 'objects'
          AND policyname = 'server_emojis_insert_admin'
    ) THEN
        CREATE POLICY server_emojis_insert_admin ON storage.objects
            FOR INSERT TO authenticated
            WITH CHECK (
                bucket_id = 'server-emojis'
                AND public.has_server_role((storage.foldername(name))[1]::uuid, 'admin')
            );
    END IF;
END $$;

-- UPDATE (supabase-js metadata ops) and DELETE: same Admin+ gate.
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'storage' AND tablename = 'objects'
          AND policyname = 'server_emojis_update_admin'
    ) THEN
        CREATE POLICY server_emojis_update_admin ON storage.objects
            FOR UPDATE TO authenticated
            USING (
                bucket_id = 'server-emojis'
                AND public.has_server_role((storage.foldername(name))[1]::uuid, 'admin')
            )
            WITH CHECK (
                bucket_id = 'server-emojis'
                AND public.has_server_role((storage.foldername(name))[1]::uuid, 'admin')
            );
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'storage' AND tablename = 'objects'
          AND policyname = 'server_emojis_delete_admin'
    ) THEN
        CREATE POLICY server_emojis_delete_admin ON storage.objects
            FOR DELETE TO authenticated
            USING (
                bucket_id = 'server-emojis'
                AND public.has_server_role((storage.foldername(name))[1]::uuid, 'admin')
            );
    END IF;
END $$;
