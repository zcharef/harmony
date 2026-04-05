-- =============================================================
-- Migration: skip_system_user_in_auto_join
-- Fixes: auto_join_official_server trigger to skip the system
--        moderator sentinel (00000000-...-000000000001).
-- Cleans: removes sentinel from any servers it was auto-joined to.
-- =============================================================

-- WHY: The system moderator sentinel exists only as a FK target for
-- deleted_by (AutoMod). When it was created, the profiles INSERT trigger
-- auto-joined it to the official server, making it appear in the member list.

-- 1. Replace trigger function with a guard for the system sentinel.
CREATE OR REPLACE FUNCTION public.auto_join_official_server()
RETURNS TRIGGER AS $$
DECLARE
    v_server_id UUID;
BEGIN
    -- WHY: The system moderator sentinel is not a real user. Skip it.
    IF NEW.id = '00000000-0000-0000-0000-000000000001' THEN
        RETURN NEW;
    END IF;

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

-- 2. Remove sentinel from all servers it was incorrectly joined to.
DELETE FROM public.server_members
WHERE user_id = '00000000-0000-0000-0000-000000000001';
