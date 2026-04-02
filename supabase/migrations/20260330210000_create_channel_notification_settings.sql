-- =============================================================
-- Migration: create_channel_notification_settings
-- Creates: channel_notification_settings table for per-channel notification preferences
-- =============================================================

CREATE TABLE IF NOT EXISTS channel_notification_settings (
    channel_id  UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    level       TEXT NOT NULL DEFAULT 'all' CHECK (level IN ('all', 'mentions', 'none')),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (channel_id, user_id)
);

ALTER TABLE channel_notification_settings ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE policyname = 'notif_settings_select_own' AND tablename = 'channel_notification_settings'
    ) THEN
        CREATE POLICY notif_settings_select_own ON channel_notification_settings
            FOR SELECT USING (user_id = auth.uid());
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE policyname = 'notif_settings_upsert_own' AND tablename = 'channel_notification_settings'
    ) THEN
        CREATE POLICY notif_settings_upsert_own ON channel_notification_settings
            FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
    END IF;
END $$;
