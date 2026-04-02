-- =============================================================
-- Migration: text_field_constraints
--
-- WHY: Defense-in-depth. The Rust API validates all input at
-- the service layer (returning clean 400s). These DB constraints
-- are backstops for data written outside the API (admin scripts,
-- PowerSync sync, migration bugs).
--
-- DB constraints use the highest tier ceiling (self-hosted).
-- Per-plan enforcement is done at the API service layer.
--
-- NOTE: All constraints use NOT VALID so they skip validation of
-- existing rows (safe for large tables). They still enforce on
-- all future INSERTs and UPDATEs. A separate VALIDATE CONSTRAINT
-- can be run later during a maintenance window if desired.
-- =============================================================

-- ─────────────────────────────────────────────────────────────
-- 1. Core tables
-- ─────────────────────────────────────────────────────────────

-- channels.topic (max 4096 chars, V3 self-hosted ceiling)
DO $$ BEGIN
    ALTER TABLE public.channels ADD CONSTRAINT chk_channels_topic_length
        CHECK (topic IS NULL OR char_length(topic) <= 4096) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- server_bans.reason (max 512 chars, matches moderation_service reason check)
DO $$ BEGIN
    ALTER TABLE public.server_bans ADD CONSTRAINT chk_server_bans_reason_length
        CHECK (reason IS NULL OR char_length(reason) <= 512) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- profiles.display_name (max 64 chars -- future-proofing for update-profile endpoint)
DO $$ BEGIN
    ALTER TABLE public.profiles ADD CONSTRAINT chk_profiles_display_name_length
        CHECK (display_name IS NULL OR char_length(display_name) <= 64) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- profiles.custom_status (max 256 chars, V3 self-hosted ceiling)
DO $$ BEGIN
    ALTER TABLE public.profiles ADD CONSTRAINT chk_profiles_custom_status_length
        CHECK (custom_status IS NULL OR char_length(custom_status) <= 256) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- profiles.avatar_url (max 2048 chars -- URL length limit)
DO $$ BEGIN
    ALTER TABLE public.profiles ADD CONSTRAINT chk_profiles_avatar_url_length
        CHECK (avatar_url IS NULL OR char_length(avatar_url) <= 2048) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- profiles.public_key (max 4096 chars -- E2EE key material)
DO $$ BEGIN
    ALTER TABLE public.profiles ADD CONSTRAINT chk_profiles_public_key_length
        CHECK (public_key IS NULL OR char_length(public_key) <= 4096) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- servers.description (max 5000 chars, V3 self-hosted ceiling)
DO $$ BEGIN
    ALTER TABLE public.servers ADD CONSTRAINT chk_servers_description_length
        CHECK (description IS NULL OR char_length(description) <= 5000) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- servers.icon_url (max 2048 chars -- URL length limit)
DO $$ BEGIN
    ALTER TABLE public.servers ADD CONSTRAINT chk_servers_icon_url_length
        CHECK (icon_url IS NULL OR char_length(icon_url) <= 2048) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- server_members.nickname (max 64 chars)
DO $$ BEGIN
    ALTER TABLE public.server_members ADD CONSTRAINT chk_server_members_nickname_length
        CHECK (nickname IS NULL OR char_length(nickname) <= 64) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─────────────────────────────────────────────────────────────
-- 2. E2EE tables (20260322180000_create_device_keys.sql)
-- ─────────────────────────────────────────────────────────────

-- device_keys.device_id (max 256 chars -- device identifier string)
DO $$ BEGIN
    ALTER TABLE public.device_keys ADD CONSTRAINT chk_device_keys_device_id_length
        CHECK (char_length(device_id) <= 256) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- device_keys.identity_key (max 512 chars -- base64-encoded Curve25519 key)
DO $$ BEGIN
    ALTER TABLE public.device_keys ADD CONSTRAINT chk_device_keys_identity_key_length
        CHECK (char_length(identity_key) <= 512) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- device_keys.signing_key (max 512 chars -- base64-encoded Ed25519 key)
DO $$ BEGIN
    ALTER TABLE public.device_keys ADD CONSTRAINT chk_device_keys_signing_key_length
        CHECK (char_length(signing_key) <= 512) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- device_keys.device_name (max 128 chars -- human-readable device label)
DO $$ BEGIN
    ALTER TABLE public.device_keys ADD CONSTRAINT chk_device_keys_device_name_length
        CHECK (device_name IS NULL OR char_length(device_name) <= 128) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─────────────────────────────────────────────────────────────
-- 3. E2EE tables (20260322180001_create_one_time_keys.sql)
-- ─────────────────────────────────────────────────────────────

-- one_time_keys.device_id (max 256 chars -- must match device_keys.device_id)
DO $$ BEGIN
    ALTER TABLE public.one_time_keys ADD CONSTRAINT chk_one_time_keys_device_id_length
        CHECK (char_length(device_id) <= 256) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- one_time_keys.key_id (max 256 chars -- key identifier string)
DO $$ BEGIN
    ALTER TABLE public.one_time_keys ADD CONSTRAINT chk_one_time_keys_key_id_length
        CHECK (char_length(key_id) <= 256) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- one_time_keys.public_key (max 512 chars -- base64-encoded Curve25519 key)
DO $$ BEGIN
    ALTER TABLE public.one_time_keys ADD CONSTRAINT chk_one_time_keys_public_key_length
        CHECK (char_length(public_key) <= 512) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─────────────────────────────────────────────────────────────
-- 4. E2EE columns on messages (20260322180002_add_encryption_to_messages.sql)
-- ─────────────────────────────────────────────────────────────

-- messages.sender_device_id (max 256 chars -- device identifier, nullable)
DO $$ BEGIN
    ALTER TABLE public.messages ADD CONSTRAINT chk_messages_sender_device_id_length
        CHECK (sender_device_id IS NULL OR char_length(sender_device_id) <= 256) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─────────────────────────────────────────────────────────────
-- 5. Megolm sessions (20260322190000_add_channel_encryption.sql)
-- ─────────────────────────────────────────────────────────────

-- megolm_sessions.session_id (max 256 chars -- Megolm session identifier)
DO $$ BEGIN
    ALTER TABLE public.megolm_sessions ADD CONSTRAINT chk_megolm_sessions_session_id_length
        CHECK (char_length(session_id) <= 256) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
