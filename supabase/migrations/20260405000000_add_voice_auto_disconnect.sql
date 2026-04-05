-- Voice auto-disconnect: add activity tracking columns for AFK and alone detection.

ALTER TABLE voice_sessions
ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE voice_sessions
ADD COLUMN IF NOT EXISTS alone_since TIMESTAMPTZ NULL;

-- Partial index: only indexes non-NULL rows (most rows are NULL = not alone)
CREATE INDEX IF NOT EXISTS idx_voice_sessions_alone_since
ON voice_sessions(alone_since) WHERE alone_since IS NOT NULL;

-- B-tree index for AFK sweep query: WHERE last_active_at < now() - interval '...'
CREATE INDEX IF NOT EXISTS idx_voice_sessions_last_active_at
ON voice_sessions(last_active_at);
