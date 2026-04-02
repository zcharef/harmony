-- AutoMod content moderation columns.
-- When a message is moderated, `content` is replaced with word-level masking (****).
-- The original text is preserved in `original_content` for future appeals.
ALTER TABLE public.messages
    ADD COLUMN IF NOT EXISTS moderated_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS moderation_reason TEXT,
    ADD COLUMN IF NOT EXISTS original_content TEXT;

COMMENT ON COLUMN public.messages.moderated_at IS 'When AutoMod flagged this message. NULL = clean.';
COMMENT ON COLUMN public.messages.moderation_reason IS 'Why AutoMod flagged this message. Generic reason, never the matched word.';
COMMENT ON COLUMN public.messages.original_content IS 'Original unmasked content before AutoMod. Only set when moderated.';
