-- Fix moderation_retries: RLS policy, unique message constraint, exhausted-retry index.
-- Addresses: S1 (no RLS policies), E19 (duplicate rows), E18 (cleanup index).

-- S1: Block all access from `authenticated` role.
-- `service_role` bypasses RLS automatically, so the Rust API is unaffected.
CREATE POLICY moderation_retries_service_only ON moderation_retries
    FOR ALL
    USING (false);

-- E19: Prevent duplicate retry rows for the same message.
-- Concurrent failures must UPSERT (ON CONFLICT), not INSERT duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS idx_moderation_retries_unique_message
    ON moderation_retries (message_id);

-- E18: Supports periodic cleanup of exhausted retries (retry_count >= 5, older than 7 days).
-- The Rust retry sweep will handle the actual DELETE; this index makes it efficient.
CREATE INDEX IF NOT EXISTS idx_moderation_retries_exhausted
    ON moderation_retries (created_at) WHERE retry_count >= 5;
