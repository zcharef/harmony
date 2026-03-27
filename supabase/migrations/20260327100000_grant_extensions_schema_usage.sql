-- WHY: pgtap is installed in the `extensions` schema on Supabase Cloud.
-- The test login role created by `supabase test db --linked` can't call
-- pgtap functions because SET search_path doesn't persist across
-- statements in pg_prove's psql sessions.
--
-- Fix: reinstall pgtap in `public` schema where it's always findable.
-- Also grant USAGE on extensions for other extension functions.

GRANT USAGE ON SCHEMA extensions TO postgres, anon, authenticated, service_role;

-- WHY: DROP + CREATE moves all pgtap functions to public schema.
-- The migration role has sufficient privileges for extension management.
DROP EXTENSION IF EXISTS pgtap;
CREATE EXTENSION pgtap SCHEMA public;
