-- =============================================================
-- Migration: add_profile_bio_banner
-- Adds: profiles.bio (markdown-lite, <=190 chars) and
--       profiles.banner_url (public Storage URL, reuses the avatars bucket).
-- Both nullable, additive. DB CHECKs are defense-in-depth backstops
-- (NOT VALID — skip existing rows); the Rust service layer returns the
-- clean 400s. Mirrors the profiles length constraints added in
-- 20260326000000_text_field_constraints.sql.
--
-- No new Storage bucket: a banner object lives in the existing `avatars`
-- bucket at `{uid}/{uuid}.{ext}`, already covered by the avatars RLS
-- policies (write access keyed on the first path segment = auth.uid()).
-- No RLS change, no index (bio/banner are never a lookup predicate).
--
-- Idempotent & additive per ADR-019 — safe to re-run.
-- =============================================================

ALTER TABLE public.profiles
    ADD COLUMN IF NOT EXISTS bio TEXT,
    ADD COLUMN IF NOT EXISTS banner_url TEXT;

-- bio: 190-char product cap (Discord's "About Me" is 190).
DO $$ BEGIN
    ALTER TABLE public.profiles ADD CONSTRAINT chk_profiles_bio_length
        CHECK (bio IS NULL OR char_length(bio) <= 190) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- banner_url: 2048-char URL ceiling, same as avatar_url.
DO $$ BEGIN
    ALTER TABLE public.profiles ADD CONSTRAINT chk_profiles_banner_url_length
        CHECK (banner_url IS NULL OR char_length(banner_url) <= 2048) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
