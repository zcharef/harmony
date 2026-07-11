-- =============================================================
-- Migration: create_friendships
-- Creates: friendships (pending/accepted, requester→addressee),
--          user_blocks (directional)
-- =============================================================

CREATE TABLE IF NOT EXISTS friendships (
    requester_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    addressee_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (requester_id, addressee_id),
    CONSTRAINT friendships_no_self CHECK (requester_id <> addressee_id)
);

-- One row per pair regardless of direction. The reverse-direction request
-- is an auto-accept UPDATE, never a second INSERT (see FriendshipService).
CREATE UNIQUE INDEX IF NOT EXISTS idx_friendships_canonical_pair
    ON friendships (LEAST(requester_id, addressee_id), GREATEST(requester_id, addressee_id));

-- List queries: "my friends" and "my incoming requests" both filter on
-- addressee_id; the PK covers requester_id-first lookups.
CREATE INDEX IF NOT EXISTS idx_friendships_addressee
    ON friendships (addressee_id, status);

CREATE TABLE IF NOT EXISTS user_blocks (
    blocker_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    blocked_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (blocker_id, blocked_id),
    CONSTRAINT user_blocks_no_self CHECK (blocker_id <> blocked_id)
);

-- "Is there a block in either direction?" checks probe both columns.
CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked
    ON user_blocks (blocked_id);

-- RLS required by ADR-040. The Rust API connects with the service role;
-- own-row policies mirror channel_notification_settings
-- (20260330210000_create_channel_notification_settings.sql:16-32).
ALTER TABLE friendships ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_blocks ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE policyname = 'friendships_select_own' AND tablename = 'friendships'
    ) THEN
        CREATE POLICY friendships_select_own ON friendships
            FOR SELECT USING (requester_id = auth.uid() OR addressee_id = auth.uid());
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE policyname = 'user_blocks_select_own' AND tablename = 'user_blocks'
    ) THEN
        CREATE POLICY user_blocks_select_own ON user_blocks
            FOR SELECT USING (blocker_id = auth.uid());
    END IF;
END $$;
