-- Presence sessions table for multi-instance presence tracking.
-- Each API instance maintains its own rows (composite PK: user_id + instance_id).
-- The sweep background task cleans stale entries across all instances.

CREATE TABLE IF NOT EXISTS presence_sessions (
    user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    instance_id      UUID NOT NULL,
    status           TEXT NOT NULL DEFAULT 'online',
    server_ids       UUID[] NOT NULL DEFAULT '{}',
    connection_count INT  NOT NULL DEFAULT 1,
    last_heartbeat   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, instance_id)
);

CREATE INDEX IF NOT EXISTS idx_presence_sessions_heartbeat
    ON presence_sessions (last_heartbeat);

-- RLS required by ADR-040. Service role bypasses via default policies.
ALTER TABLE presence_sessions ENABLE ROW LEVEL SECURITY;
