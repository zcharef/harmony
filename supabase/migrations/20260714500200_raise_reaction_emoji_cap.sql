-- =============================================================
-- Migration: raise_reaction_emoji_cap
-- Custom emoji reactions store `:name:` (name <= 32) = up to 34 chars,
-- over the old 32 cap. Raise to 64. Idempotent (drop+recreate).
-- =============================================================
DO $$ BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'message_reactions_emoji_length'
    ) THEN
        ALTER TABLE public.message_reactions
            DROP CONSTRAINT message_reactions_emoji_length;
    END IF;
END $$;

ALTER TABLE public.message_reactions
    ADD CONSTRAINT message_reactions_emoji_length
    CHECK (char_length(emoji) BETWEEN 1 AND 64);
