-- =============================================================
-- Migration: create_profiles
-- Creates: set_updated_at() trigger function, profiles table
-- =============================================================

-- Reusable trigger function for updated_at columns
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Profiles table
CREATE TABLE IF NOT EXISTS public.profiles (
    id            UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    username      TEXT NOT NULL,
    display_name  TEXT,
    avatar_url    TEXT,
    status        TEXT CHECK (status IN ('online', 'idle', 'dnd', 'offline')) DEFAULT 'offline',
    custom_status TEXT,
    public_key    TEXT,  -- E2EE forward-compat: nullable public key
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT profiles_username_unique UNIQUE (username),
    CONSTRAINT profiles_username_format CHECK (username ~ '^[a-z0-9_]{3,32}$')
);

-- Index for username lookups (login, search, @mentions)
CREATE INDEX IF NOT EXISTS idx_profiles_username ON public.profiles (username);

-- Auto-update updated_at on row change
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_profiles_updated_at'
    ) THEN
        CREATE TRIGGER trg_profiles_updated_at
            BEFORE UPDATE ON public.profiles
            FOR EACH ROW
            EXECUTE FUNCTION public.set_updated_at();
    END IF;
END $$;

-- RLS: anyone can read, only owner can update
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE policyname = 'profiles_select_all' AND tablename = 'profiles'
    ) THEN
        CREATE POLICY profiles_select_all ON public.profiles
            FOR SELECT USING (true);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE policyname = 'profiles_update_own' AND tablename = 'profiles'
    ) THEN
        CREATE POLICY profiles_update_own ON public.profiles
            FOR UPDATE USING (id = auth.uid());
    END IF;
END $$;

-- Allow authenticated users to insert their own profile (for POST /v1/auth/me)
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE policyname = 'profiles_insert_own' AND tablename = 'profiles'
    ) THEN
        CREATE POLICY profiles_insert_own ON public.profiles
            FOR INSERT WITH CHECK (id = auth.uid());
    END IF;
END $$;
