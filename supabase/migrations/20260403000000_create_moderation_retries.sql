-- Dead-letter queue for failed async AI moderation checks.
-- Messages here had OpenAI API failures during Tier 1 evaluation.
-- A background sweep retries periodically. After 5 failures,
-- tracing::error! alerts operators via Sentry.

CREATE TABLE IF NOT EXISTS moderation_retries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    server_id UUID NOT NULL,
    channel_id UUID NOT NULL,
    content TEXT NOT NULL,
    retry_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_moderation_retries_pending
    ON moderation_retries (created_at ASC)
    WHERE retry_count < 5;

ALTER TABLE moderation_retries ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE moderation_retries IS
    'Dead-letter queue for failed async AI moderation checks. '
    'Messages here had OpenAI API failures during Tier 1 evaluation. '
    'A background sweep retries periodically. After 5 failures, '
    'tracing::error! alerts operators via Sentry.';
