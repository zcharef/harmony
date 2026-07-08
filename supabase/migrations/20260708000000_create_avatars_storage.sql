-- =============================================================
-- Migration: create_avatars_storage
--
-- Creates the `avatars` storage bucket (public read) and RLS
-- policies on storage.objects:
--   - public SELECT (avatars are public images)
--   - authenticated INSERT/UPDATE/DELETE restricted to the
--     `avatars` bucket AND objects under the caller's own
--     `{auth.uid()}/...` prefix
--
-- WHY direct client upload: the SPA uploads avatars straight to
-- Supabase Storage (sanctioned in src/lib/supabase.ts — bypasses
-- the API's 2MB body cap). The Rust API only ever stores the
-- resulting public URL via PATCH /v1/profiles/me.
--
-- Idempotent per ADR-019 — safe to re-run.
-- =============================================================

-- ─────────────────────────────────────────────────────────────
-- Bucket: avatars (public read, 5MB cap, image mime types only)
-- WHY server-side caps: defense in depth — the client also
-- validates type/size, but the bucket enforces them for any
-- caller with a valid JWT.
-- ─────────────────────────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'avatars',
    'avatars',
    true,
    5242880, -- 5 MB, matches the client-side cap
    ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────
-- Public read — avatars render for everyone (public bucket)
-- ─────────────────────────────────────────────────────────────
-- WHY no SELECT policy (conscious decision, security review 2026-07-08):
-- avatar rendering uses the public-bucket URL path
-- (/storage/v1/object/public/avatars/{path}), which bypasses RLS because the
-- bucket is public=true. A SELECT policy for `public` would ADDITIONALLY grant
-- the anon role the storage LIST API on this bucket — letting anyone enumerate
-- every user's UUID folder unauthenticated. Privacy-first: rendering works,
-- listing stays closed. If it was already created by an earlier run, drop it.
DO $$ BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'storage' AND tablename = 'objects'
          AND policyname = 'avatars_select_public'
    ) THEN
        DROP POLICY avatars_select_public ON storage.objects;
    END IF;
END $$;

-- ─────────────────────────────────────────────────────────────
-- Write access — authenticated users, own folder only.
-- WHY first path segment = auth.uid(): the client uploads to
-- `{uid}/{uuid}.{ext}`, so ownership is encoded in the path and
-- no extra owner column/trigger is needed.
-- ─────────────────────────────────────────────────────────────
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'storage' AND tablename = 'objects'
          AND policyname = 'avatars_insert_own'
    ) THEN
        CREATE POLICY avatars_insert_own ON storage.objects
            FOR INSERT TO authenticated
            WITH CHECK (
                bucket_id = 'avatars'
                AND (storage.foldername(name))[1] = auth.uid()::text
            );
    END IF;
END $$;

-- WHY kept although the client is INSERT-only (fresh {uid}/{uuid} path per
-- upload): supabase-js upsert/metadata operations issue UPDATEs; owner-scoped
-- USING + WITH CHECK (both required — WITH CHECK blocks renaming an object
-- INTO another user's folder) makes this safe to keep for that flexibility.
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'storage' AND tablename = 'objects'
          AND policyname = 'avatars_update_own'
    ) THEN
        CREATE POLICY avatars_update_own ON storage.objects
            FOR UPDATE TO authenticated
            USING (
                bucket_id = 'avatars'
                AND (storage.foldername(name))[1] = auth.uid()::text
            )
            WITH CHECK (
                bucket_id = 'avatars'
                AND (storage.foldername(name))[1] = auth.uid()::text
            );
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'storage' AND tablename = 'objects'
          AND policyname = 'avatars_delete_own'
    ) THEN
        CREATE POLICY avatars_delete_own ON storage.objects
            FOR DELETE TO authenticated
            USING (
                bucket_id = 'avatars'
                AND (storage.foldername(name))[1] = auth.uid()::text
            );
    END IF;
END $$;
