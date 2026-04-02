-- =============================================================
-- Migration: auto_join_official_server
-- Creates: trigger on profiles INSERT to auto-join the official
--          Harmony server via its permanent invite code.
-- =============================================================

-- WHY: Every new user should land in the official Harmony server
-- on signup, so they have a community space from day one.
-- The invite code 'XGP2b4iB' is the never-expires invite for
-- the official server.

CREATE OR REPLACE FUNCTION public.auto_join_official_server()
RETURNS TRIGGER AS $$
DECLARE
    v_server_id UUID;
BEGIN
    SELECT server_id INTO v_server_id
    FROM public.invites
    WHERE code = 'XGP2b4iB';

    IF v_server_id IS NOT NULL THEN
        INSERT INTO public.server_members (server_id, user_id)
        VALUES (v_server_id, NEW.id)
        ON CONFLICT (server_id, user_id) DO NOTHING;
    END IF;

    RETURN NEW;
EXCEPTION
    WHEN OTHERS THEN
        -- WHY: Auto-join is best-effort. Never block signup.
        RAISE WARNING 'auto_join_official_server failed for user %: %', NEW.id, SQLERRM;
        RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_auto_join_official_server'
    ) THEN
        CREATE TRIGGER trg_auto_join_official_server
            AFTER INSERT ON public.profiles
            FOR EACH ROW
            EXECUTE FUNCTION public.auto_join_official_server();
    END IF;
END $$;
