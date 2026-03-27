-- WHY: pgtap is installed in the `extensions` schema on Supabase Cloud.
-- The test login role created by `supabase test db --linked` can't find
-- pgtap functions because `extensions` isn't in the default search_path,
-- and SET search_path doesn't persist in pg_prove's psql sessions.
--
-- Fix: move pgtap to `public` schema where it's always findable.
-- Also grant USAGE on extensions for other extension functions.

GRANT USAGE ON SCHEMA extensions TO postgres, anon, authenticated, service_role;

-- WHY: ALTER EXTENSION SET SCHEMA moves all functions to the target schema.
-- public is always in every role's search_path, so plan() etc. just work.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgtap') THEN
    ALTER EXTENSION pgtap SET SCHEMA public;
  END IF;
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'Cannot move pgtap to public (insufficient privilege) — will use SET search_path in tests';
  WHEN OTHERS THEN
    RAISE NOTICE 'Cannot move pgtap: % — will use SET search_path in tests', SQLERRM;
END $$;
