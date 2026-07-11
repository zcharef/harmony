-- =============================================================
-- Migration: add_server_discovery
-- Adds: opt-in server directory columns on servers.
--   - discoverable:          owner/admin opt-in flag (default OFF)
--   - discovery_category:    allowlisted category (validated in the API,
--                            CHECK below is defense-in-depth)
--   - discovery_description: short public blurb (moderated in the API)
--   - discovery_featured:    surfaces official/curated servers first.
--                            No UI — set directly in the DB only.
--
-- The directory listing is served exclusively by the Rust API (service
-- connection, RLS not applicable); no PostgREST path exists for it, so
-- the discoverable=true filter is enforced in the API queries.
-- =============================================================

ALTER TABLE public.servers
    ADD COLUMN IF NOT EXISTS discoverable BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS discovery_category TEXT,
    ADD COLUMN IF NOT EXISTS discovery_description TEXT,
    ADD COLUMN IF NOT EXISTS discovery_featured BOOLEAN NOT NULL DEFAULT false;

-- Defense-in-depth mirrors of the API-side validation (single source of
-- truth for the allowlist is the Rust DISCOVERY_CATEGORIES const).
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'servers_discovery_category_allowlist'
    ) THEN
        ALTER TABLE public.servers
            ADD CONSTRAINT servers_discovery_category_allowlist CHECK (
                discovery_category IS NULL OR discovery_category IN (
                    'gaming', 'tech', 'education', 'music',
                    'art', 'science', 'community', 'other'
                )
            );
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'servers_discovery_description_length'
    ) THEN
        ALTER TABLE public.servers
            ADD CONSTRAINT servers_discovery_description_length CHECK (
                discovery_description IS NULL
                OR char_length(discovery_description) <= 300
            );
    END IF;
END $$;

-- The directory query filters on discoverable=true and orders by
-- (discovery_featured DESC, member_count DESC). The partial index keeps the
-- scan proportional to the (small, curated) opted-in set.
CREATE INDEX IF NOT EXISTS idx_servers_discoverable
    ON public.servers (discovery_featured DESC)
    WHERE discoverable = true AND is_dm = false;
