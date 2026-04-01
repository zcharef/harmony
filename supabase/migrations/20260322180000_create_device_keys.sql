-- =============================================================
-- Migration: create_device_keys
--
-- WHY: E2EE key distribution requires each user+device to publish
-- identity keys (Curve25519 + Ed25519) so other clients can
-- establish Olm sessions. This table stores one row per device.
-- =============================================================

CREATE TABLE IF NOT EXISTS public.device_keys (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id            UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    device_id          TEXT NOT NULL,
    identity_key       TEXT NOT NULL,  -- Curve25519 public key (base64)
    signing_key        TEXT NOT NULL,  -- Ed25519 public key (base64)
    device_name        TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_key_upload_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT device_keys_user_device_unique UNIQUE (user_id, device_id)
);

-- WHY: Key bundle lookup fetches all devices for a target user
CREATE INDEX IF NOT EXISTS idx_device_keys_user_id
    ON public.device_keys (user_id);

-- ─────────────────────────────────────────────────────────────
-- RLS: Any authenticated user can read keys (session establishment).
-- Only the key owner can write/delete their own keys.
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.device_keys ENABLE ROW LEVEL SECURITY;

-- WHY: Any authenticated user needs to read device keys to establish
-- an Olm session with another user's device.
DROP POLICY IF EXISTS device_keys_select_authenticated ON public.device_keys;
CREATE POLICY device_keys_select_authenticated ON public.device_keys
    FOR SELECT TO authenticated
    USING (true);

-- WHY: Users can only register their own device keys
DROP POLICY IF EXISTS device_keys_insert_own ON public.device_keys;
CREATE POLICY device_keys_insert_own ON public.device_keys
    FOR INSERT TO authenticated
    WITH CHECK (user_id = auth.uid());

-- WHY: Users can only update their own device keys (e.g., key rotation)
DROP POLICY IF EXISTS device_keys_update_own ON public.device_keys;
CREATE POLICY device_keys_update_own ON public.device_keys
    FOR UPDATE TO authenticated
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

-- WHY: Users can only delete their own device keys (e.g., device logout)
DROP POLICY IF EXISTS device_keys_delete_own ON public.device_keys;
CREATE POLICY device_keys_delete_own ON public.device_keys
    FOR DELETE TO authenticated
    USING (user_id = auth.uid());
