ALTER TABLE public.user_preferences
    ADD COLUMN IF NOT EXISTS hide_profanity BOOLEAN NOT NULL DEFAULT true;
COMMENT ON COLUMN public.user_preferences.hide_profanity IS 'When true, client masks profanity words before rendering.';
