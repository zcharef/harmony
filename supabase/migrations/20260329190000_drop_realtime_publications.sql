-- WHY: Supabase Realtime is replaced by server-sent events (SSE) from the
-- Rust API (GET /v1/events).  Removing these tables from the publication
-- eliminates Realtime billing and WAL overhead for logical replication
-- slots that are no longer consumed.
-- See: harmony-api Critical Invariant #5, ADR-SSE-001 through ADR-SSE-007.

-- Guard with pg_publication_tables so the migration is idempotent:
-- re-running after the tables are already removed is a no-op.

DO $$ BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND tablename = 'messages' AND schemaname = 'public'
    ) THEN
        ALTER PUBLICATION supabase_realtime DROP TABLE public.messages;
    END IF;
END $$;

DO $$ BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND tablename = 'server_members' AND schemaname = 'public'
    ) THEN
        ALTER PUBLICATION supabase_realtime DROP TABLE public.server_members;
    END IF;
END $$;

DO $$ BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND tablename = 'channel_role_access' AND schemaname = 'public'
    ) THEN
        ALTER PUBLICATION supabase_realtime DROP TABLE public.channel_role_access;
    END IF;
END $$;
