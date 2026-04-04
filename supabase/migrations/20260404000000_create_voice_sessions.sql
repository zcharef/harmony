-- Voice sessions: tracks who is currently in a voice channel
-- SSoT for voice presence — LiveKit is the transport, this table is the state.

CREATE TABLE IF NOT EXISTS voice_sessions (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    channel_id   UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    server_id    UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    session_id   TEXT NOT NULL DEFAULT '',
    joined_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id)  -- One active voice session per user, globally (D8)
);

CREATE INDEX IF NOT EXISTS idx_voice_sessions_channel_id ON voice_sessions(channel_id);
CREATE INDEX IF NOT EXISTS idx_voice_sessions_server_id ON voice_sessions(server_id);
CREATE INDEX IF NOT EXISTS idx_voice_sessions_last_seen ON voice_sessions(last_seen_at);

ALTER TABLE voice_sessions ENABLE ROW LEVEL SECURITY;

-- RLS: Users can see voice sessions in servers they belong to
-- WHY: PG 15 does not support CREATE POLICY IF NOT EXISTS. DROP+CREATE
-- ensures idempotency when the migration runs more than once.
DROP POLICY IF EXISTS voice_sessions_select_policy ON voice_sessions;
CREATE POLICY voice_sessions_select_policy ON voice_sessions
    FOR SELECT USING (
        server_id IN (SELECT server_id FROM server_members WHERE user_id = auth.uid())
    );

-- RLS: Only the API service role can insert/update/delete (not end users directly)
-- The Rust API uses the service_role key, so no insert/update/delete policies needed for users.
