-- Notification preference columns on user_preferences (ADR-047 table).
-- WHY server-side: preferences sync across devices/platforms; browser
-- permission state stays in the browser (per-device by nature).
-- RLS: table already has RLS enabled with own-row policies
-- (20260402120000_create_user_preferences.sql) — new columns inherit them.
-- All defaults true = current effective behavior (notifications always
-- attempted today), so this migration is behavior-neutral for existing users.

ALTER TABLE public.user_preferences
    ADD COLUMN IF NOT EXISTS notifications_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE public.user_preferences
    ADD COLUMN IF NOT EXISTS notify_messages BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE public.user_preferences
    ADD COLUMN IF NOT EXISTS notify_dms BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE public.user_preferences
    ADD COLUMN IF NOT EXISTS notify_mentions BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE public.user_preferences
    ADD COLUMN IF NOT EXISTS notification_sounds_enabled BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN public.user_preferences.notifications_enabled IS
    'Master switch for desktop/browser notifications (does not affect sounds).';
COMMENT ON COLUMN public.user_preferences.notify_messages IS
    'Notify on server-channel messages (non-mention).';
COMMENT ON COLUMN public.user_preferences.notify_dms IS
    'Notify on direct messages.';
COMMENT ON COLUMN public.user_preferences.notify_mentions IS
    'Notify on mentions.';
COMMENT ON COLUMN public.user_preferences.notification_sounds_enabled IS
    'Master switch for notification sounds.';
