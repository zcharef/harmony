-- =============================================================
-- Migration: add_encryption_to_messages
--
-- WHY: E2EE DMs store base64-encoded Olm ciphertext in the
-- existing content column. Two new columns identify encrypted
-- messages and the sending device (needed by recipients to
-- look up the correct Olm session for decryption).
--
-- The content length constraint is updated to allow larger
-- ciphertext (base64 ~33% overhead + Olm envelope).
-- =============================================================

-- ─────────────────────────────────────────────────────────────
-- 1. Add encryption metadata columns
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.messages
    ADD COLUMN IF NOT EXISTS encrypted BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS sender_device_id TEXT;

-- WHY: sender_device_id is required when encrypted = true so the
-- recipient knows which Olm session to use for decryption.
ALTER TABLE public.messages
    DROP CONSTRAINT IF EXISTS messages_device_required_when_encrypted,
    ADD CONSTRAINT messages_device_required_when_encrypted
        CHECK (encrypted = false OR sender_device_id IS NOT NULL);

-- ─────────────────────────────────────────────────────────────
-- 2. Update content length constraint for ciphertext
--
-- WHY: Base64-encoded Olm ciphertext is ~33% larger than plaintext
-- plus Olm envelope overhead. Plaintext limit stays at 4000;
-- encrypted content is allowed up to 8000 characters.
--
-- Replaces: messages_content_length from
-- 20260316013710_create_messages.sql:L18
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.messages
    DROP CONSTRAINT IF EXISTS messages_content_length,
    ADD CONSTRAINT messages_content_length
        CHECK (
            content IS NULL
            OR (encrypted = false AND char_length(content) <= 4000)
            OR (encrypted = true  AND char_length(content) <= 8000)
        );
