-- User preferences table (DND mode, future expandable settings).
-- WHY: Separate from profiles to keep user-controlled settings isolated
-- from public-facing profile data.

CREATE TABLE IF NOT EXISTS user_preferences (
    user_id     UUID PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
    dnd_enabled BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE policyname = 'preferences_select_own' AND tablename = 'user_preferences'
    ) THEN
        CREATE POLICY preferences_select_own ON user_preferences
            FOR SELECT USING (user_id = auth.uid());
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE policyname = 'preferences_all_own' AND tablename = 'user_preferences'
    ) THEN
        CREATE POLICY preferences_all_own ON user_preferences
            FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
    END IF;
END $$;
