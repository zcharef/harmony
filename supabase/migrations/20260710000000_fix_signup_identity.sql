-- =============================================================
-- Migration: fix_signup_identity
-- Fixes two signup-identity bugs in handle_new_user() (the trigger
-- that creates a profile row at auth.users INSERT, before the client's
-- first API call — it is the HOT PATH; sync_profile early-returns once
-- the row exists, so upsert_from_auth never runs on a normal signup).
--
--   1. Username was ALWAYS derived from email, ignoring the username the
--      user chose at signup (raw_user_meta_data ->> 'username'). The
--      chosen username was silently dropped. Now honored when it passes
--      the profiles.username format (^[a-z0-9_]{3,32}$) and is not
--      reserved; email-derived only as a fallback.
--   2. A blank display name fell back to COALESCE(display_name,
--      full_name, email_prefix) — yielding the EMAIL PREFIX, the exact
--      "that isn't the name I typed" outcome. Now blank/absent → NULL
--      (renders as username, per the identity-polish decision), while
--      OAuth full_name is kept (Google etc. supply a real name).
--
-- CREATE OR REPLACE is idempotent; the trigger already targets this fn.
-- =============================================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_email_prefix TEXT;
    v_chosen       TEXT;
    v_base         TEXT;   -- base username (chosen or email-derived), pre-collision
    v_username     TEXT;
    v_display      TEXT;
    v_avatar       TEXT;
    v_suffix       TEXT;
    v_attempt      INT := 0;
    v_max_retries  INT := 3;
    v_done         BOOLEAN := FALSE;
    -- WHY: mirrors RESERVED_USERNAMES in profile_service.rs. sync_profile's
    -- reserved-name gate is skipped for trigger-created rows (early return), so
    -- without this a user could self-assign 'admin'/'system'/etc at signup.
    -- KEEP IN SYNC with harmony-api/src/domain/services/profile_service.rs
    -- (RESERVED_USERNAMES). Follow-up: promote to a shared reserved_usernames
    -- table both the trigger and the Rust service query (removes the drift risk).
    v_reserved TEXT[] := ARRAY[
        'admin','administrator','system','everyone','here','moderator','mod',
        'harmony','support','deleted','root','bot','official'
    ];
BEGIN
    -- ── Email-derived fallback base (mirrors derive_username_from_email) ──
    v_email_prefix := split_part(COALESCE(NEW.email, 'user@local'), '@', 1);
    v_base := left(regexp_replace(lower(v_email_prefix), '[^a-z0-9_]', '_', 'g'), 32);
    IF length(v_base) < 3 THEN
        v_base := v_base || repeat('_', 3 - length(v_base));
    END IF;

    -- ── Prefer the chosen username when valid + not reserved (BUGFIX) ──
    -- WHY lower(): usernames are lowercase-only. The web form already
    -- lowercases input, but the trigger is the last line of defense — an OAuth
    -- provider or a direct API client could send "Zayd_Cool"; normalize it
    -- rather than silently dropping it to the email-derived fallback.
    v_chosen := lower(NEW.raw_user_meta_data ->> 'username');
    IF v_chosen IS NOT NULL
       AND v_chosen ~ '^[a-z0-9_]{3,32}$'
       AND NOT (v_chosen = ANY(v_reserved))
    THEN
        v_base := v_chosen;
    END IF;
    v_username := v_base;

    -- ── Display name: metadata only; blank/whitespace/absent → NULL (BUGFIX) ──
    -- btrim first so a whitespace-only value (or padded name) is normalized —
    -- matches resolveDisplayName's render-side trim, and "" → NULL.
    v_display := left(NULLIF(btrim(COALESCE(
        NEW.raw_user_meta_data ->> 'display_name',
        NEW.raw_user_meta_data ->> 'full_name'
    )), ''), 64);

    v_avatar := NEW.raw_user_meta_data ->> 'avatar_url';

    -- ── Insert with collision retry (suffix the SAME base, chosen or email) ──
    WHILE v_attempt < v_max_retries AND v_done IS NOT TRUE LOOP
        BEGIN
            INSERT INTO public.profiles (id, username, display_name, avatar_url, status, created_at, updated_at)
            VALUES (NEW.id, v_username, v_display, v_avatar, 'offline', now(), now());
            v_done := TRUE;
        EXCEPTION
            WHEN unique_violation THEN
                -- WHY gen_random_uuid (not gen_random_bytes): under
                -- `SET search_path = ''` the pgcrypto function gen_random_bytes
                -- (in the extensions schema) does NOT resolve, so the previous
                -- trigger's retry raised "function does not exist" → WHEN OTHERS
                -- → no profile on ANY username collision. gen_random_uuid is a
                -- core pg_catalog function and always resolves. Honoring chosen
                -- usernames makes collisions more likely, so this path matters.
                v_attempt := v_attempt + 1;
                v_suffix := '_' || left(replace(gen_random_uuid()::text, '-', ''), 3 + v_attempt);
                v_username := left(v_base, 32 - length(v_suffix));
                IF length(v_username) < 1 THEN
                    v_username := 'u';
                END IF;
                v_username := v_username || v_suffix;
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
