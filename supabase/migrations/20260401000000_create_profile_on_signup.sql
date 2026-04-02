-- =============================================================
-- Migration: create_profile_on_signup
-- Creates: handle_new_user() trigger function + trigger on
--          auth.users to auto-create a profiles row on signup.
--
-- WHY: Without a profile row, every authenticated endpoint that
-- queries profiles will 404. This trigger guarantees the row
-- exists immediately after Supabase Auth creates the user,
-- before the client's first API call.
--
-- SECURITY DEFINER: Required because the trigger fires in the
-- auth schema context where auth.uid() is not yet set, so the
-- profiles_insert_own RLS policy (id = auth.uid()) would block
-- the INSERT.
--
-- Exception safety: The outer BEGIN...EXCEPTION ensures a bug
-- in this trigger never rolls back the auth.users INSERT —
-- signup must always succeed.
-- =============================================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_raw_prefix  TEXT;
    v_username    TEXT;
    v_display     TEXT;
    v_avatar      TEXT;
    v_suffix      TEXT;
    v_attempt     INT := 0;
    v_max_retries INT := 3;
    v_done        BOOLEAN := FALSE;
BEGIN
    -- ── 1. Derive username from email (mirrors Rust derive_username_from_email) ──
    -- Take prefix before @, lowercase, replace non-alphanumeric with underscore,
    -- truncate to 32, pad to 3.
    v_raw_prefix := split_part(COALESCE(NEW.email, 'user@local'), '@', 1);
    v_username := lower(v_raw_prefix);
    v_username := regexp_replace(v_username, '[^a-z0-9_]', '_', 'g');
    v_username := left(v_username, 32);
    IF length(v_username) < 3 THEN
        v_username := v_username || repeat('_', 3 - length(v_username));
    END IF;

    -- ── 2. Display name: prefer metadata, fall back to email prefix ──
    v_display := COALESCE(
        NEW.raw_user_meta_data ->> 'display_name',
        NEW.raw_user_meta_data ->> 'full_name',
        v_raw_prefix
    );
    -- Respect the chk_profiles_display_name_length constraint (max 64)
    v_display := left(v_display, 64);

    -- ── 3. Avatar URL (nullable) ──
    v_avatar := NEW.raw_user_meta_data ->> 'avatar_url';

    -- ── 4. Insert with collision retry loop ──
    WHILE v_attempt < v_max_retries AND v_done IS NOT TRUE LOOP
        BEGIN
            INSERT INTO public.profiles (id, username, display_name, avatar_url, status, created_at, updated_at)
            VALUES (
                NEW.id,
                v_username,
                v_display,
                v_avatar,
                'offline',
                now(),
                now()
            );
            v_done := TRUE;
        EXCEPTION
            WHEN unique_violation THEN
                -- WHY: Username collision — append random hex suffix and retry.
                -- Each retry uses a longer suffix to reduce collision probability.
                v_attempt := v_attempt + 1;
                v_suffix := '_' || encode(gen_random_bytes(2 + v_attempt), 'hex');
                -- Truncate base username to make room for suffix within 32-char limit
                v_username := left(
                    regexp_replace(lower(split_part(COALESCE(NEW.email, 'user@local'), '@', 1)), '[^a-z0-9_]', '_', 'g'),
                    32 - length(v_suffix)
                );
                IF length(v_username) < 1 THEN
                    v_username := 'u';
                END IF;
                v_username := v_username || v_suffix;
                -- Ensure minimum 3 chars after suffix (should always be true given suffix length >= 5)
                IF length(v_username) < 3 THEN
                    v_username := v_username || repeat('_', 3 - length(v_username));
                END IF;
        END;
    END LOOP;

    IF v_done IS NOT TRUE THEN
        RAISE WARNING 'handle_new_user: failed to insert profile after % attempts for user %', v_max_retries, NEW.id;
    END IF;

    RETURN NEW;
EXCEPTION
    WHEN OTHERS THEN
        -- WHY: Never block signup. Profile can be created later via POST /v1/auth/me.
        RAISE WARNING 'handle_new_user failed for user %: %', NEW.id, SQLERRM;
        RETURN NEW;
END;
$$;

-- Idempotent trigger creation (follows existing pattern from auto_join_official_server)
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'on_auth_user_created'
    ) THEN
        CREATE TRIGGER on_auth_user_created
            AFTER INSERT ON auth.users
            FOR EACH ROW
            EXECUTE FUNCTION public.handle_new_user();
    END IF;
END $$;
