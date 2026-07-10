-- =============================================================
-- Migration: create_message_attachments (attachments T1.3, part 1)
--
-- 1) `message_attachments` table — one row per file attached to a
--    message. Written atomically in the send_to_channel transaction;
--    read via a batch query zipped into each message (mirrors the
--    reactions batch pattern).
-- 2) `attachments` storage bucket + owner-scoped write RLS on
--    storage.objects — copies 20260708000000_create_avatars_storage
--    exactly, changing only the bucket id, size cap and mime list.
--
-- WHY no storage_path column: the object path is derived from `url`
-- (parseAttachmentStoragePath, mirrors parseAvatarStoragePath in
-- avatar-file.ts) when cleanup is eventually added. Columns kept to
-- the roadmap-specified minimal set.
--
-- Idempotent per ADR-019 — safe to re-run. Additive only.
-- =============================================================

-- ─────────────────────────────────────────────────────────────
-- Table: message_attachments
-- WHY size BIGINT: Creator cap is 100 MB (< 2^31) but BIGINT is
-- free insurance and matches the SUM(size)::BIGINT shape the
-- deferred storage-quota query will use (ADR-024).
-- WHY ON DELETE CASCADE: hard deletes only. Messages are
-- soft-deleted (ADR-038), so the cascade never fires in normal
-- operation — attachment rows survive alongside the tombstone.
-- It is correctness insurance for true-DELETE paths (test
-- teardown, GDPR hard-erase later).
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS message_attachments (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    url        TEXT NOT NULL,
    mime       TEXT NOT NULL,
    size       BIGINT NOT NULL,
    width      INTEGER,      -- NULL for non-images
    height     INTEGER,      -- NULL for non-images
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Batch read is `WHERE message_id = ANY($1)` — index the FK.
CREATE INDEX IF NOT EXISTS idx_message_attachments_message_id
    ON message_attachments (message_id);

-- RLS: attachments inherit the visibility of their parent message — same
-- membership gate as message_reactions_select_member (the normalized
-- is_channel_member() pattern, 20260317000000). Explicit membership check,
-- no reliance on RLS transitivity through the messages subquery. No direct
-- client access anyway — the Rust API is the only reader (service_role
-- bypasses RLS) — but ADR-040 requires RLS ON.
ALTER TABLE message_attachments ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'message_attachments'
          AND policyname = 'message_attachments_select_via_message'
    ) THEN
        CREATE POLICY message_attachments_select_via_message ON message_attachments
            FOR SELECT TO authenticated
            USING (
                public.is_channel_member(
                    (SELECT m.channel_id FROM public.messages m
                     WHERE m.id = message_attachments.message_id)
                )
            );
    END IF;
END $$;

-- ─────────────────────────────────────────────────────────────
-- Bucket: attachments (public read, 100MB cap, image + common file mimes)
-- WHY 100 MB bucket cap: the bucket file_size_limit is a single value; it must
-- be the MAX plan tier (Creator 100MB). Per-plan enforcement (Free 8MB /
-- Supporter 50MB) happens in the Rust API. The bucket cap is the hard security
-- boundary; the per-plan cap is the UX/billing gate (ticket decision D5).
-- ─────────────────────────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'attachments',
    'attachments',
    true,
    104857600, -- 100 MB (Creator tier)
    ARRAY[
        'image/png','image/jpeg','image/webp','image/gif','image/avif',
        'application/pdf','text/plain','application/zip',
        'video/mp4','video/webm',
        'audio/mpeg','audio/ogg','audio/wav'
    ]
)
ON CONFLICT (id) DO NOTHING;

-- WHY no SELECT policy (same conscious decision as the avatars bucket,
-- security review 2026-07-08): attachment rendering uses the public-bucket URL
-- path (/storage/v1/object/public/attachments/{path}), which bypasses RLS
-- because the bucket is public=true. A SELECT policy for `public` would
-- ADDITIONALLY grant the anon role the storage LIST API on this bucket —
-- letting anyone enumerate every user's UUID folder unauthenticated.
-- Rendering works, listing stays closed. Drop it if an earlier run created it.
DO $$ BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'storage' AND tablename = 'objects'
          AND policyname = 'attachments_select_public'
    ) THEN
        DROP POLICY attachments_select_public ON storage.objects;
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
          AND policyname = 'attachments_insert_own'
    ) THEN
        CREATE POLICY attachments_insert_own ON storage.objects
            FOR INSERT TO authenticated
            WITH CHECK (
                bucket_id = 'attachments'
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
          AND policyname = 'attachments_update_own'
    ) THEN
        CREATE POLICY attachments_update_own ON storage.objects
            FOR UPDATE TO authenticated
            USING (
                bucket_id = 'attachments'
                AND (storage.foldername(name))[1] = auth.uid()::text
            )
            WITH CHECK (
                bucket_id = 'attachments'
                AND (storage.foldername(name))[1] = auth.uid()::text
            );
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'storage' AND tablename = 'objects'
          AND policyname = 'attachments_delete_own'
    ) THEN
        CREATE POLICY attachments_delete_own ON storage.objects
            FOR DELETE TO authenticated
            USING (
                bucket_id = 'attachments'
                AND (storage.foldername(name))[1] = auth.uid()::text
            );
    END IF;
END $$;
