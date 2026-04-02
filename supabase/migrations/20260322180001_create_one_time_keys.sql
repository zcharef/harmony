-- =============================================================
-- Migration: create_one_time_keys
--
-- WHY: Olm session establishment requires one-time pre-keys and
-- fallback keys. One-time keys are consumed (deleted) when claimed
-- by the API; fallback keys persist until rotated. This table
-- stores both types, distinguished by the is_fallback flag.
-- =============================================================

CREATE TABLE IF NOT EXISTS public.one_time_keys (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    device_id   TEXT NOT NULL,
    key_id      TEXT NOT NULL,
    public_key  TEXT NOT NULL,    -- Curve25519 (base64)
    is_fallback BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT one_time_keys_unique UNIQUE (user_id, device_id, key_id),
    CONSTRAINT one_time_keys_device_fk
        FOREIGN KEY (user_id, device_id)
        REFERENCES public.device_keys(user_id, device_id) ON DELETE CASCADE
);

-- WHY: Key claim queries fetch one non-fallback key for a user+device,
-- falling back to the fallback key if none remain. This index covers
-- both queries efficiently.
CREATE INDEX IF NOT EXISTS idx_one_time_keys_claim
    ON public.one_time_keys (user_id, device_id, is_fallback);

-- ─────────────────────────────────────────────────────────────
-- RLS: Any authenticated user can read keys (bundle fetching).
-- Only the key owner can insert/delete their own keys.
-- NOTE: The API uses service_role for atomic claim (DELETE...RETURNING),
-- so the delete policy only applies to user-initiated deletes.
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.one_time_keys ENABLE ROW LEVEL SECURITY;

-- WHY: Any authenticated user needs to read one-time keys to
-- establish an Olm session with another user's device.
CREATE POLICY one_time_keys_select_authenticated ON public.one_time_keys
    FOR SELECT TO authenticated
    USING (true);

-- WHY: Users can only upload their own one-time keys
CREATE POLICY one_time_keys_insert_own ON public.one_time_keys
    FOR INSERT TO authenticated
    WITH CHECK (user_id = auth.uid());

-- WHY: Users can only delete their own one-time keys (rotation).
-- The API uses service_role for atomic claim, so this policy only
-- covers user-initiated cleanup.
CREATE POLICY one_time_keys_delete_own ON public.one_time_keys
    FOR DELETE TO authenticated
    USING (user_id = auth.uid());
