-- WHY: pgtap is installed in the `extensions` schema on Supabase Cloud.
-- The test login role from `supabase test db --linked` cannot access
-- functions in `extensions` (SET search_path doesn't persist in pg_prove).
-- Fix: reinstall pgtap in `public` where it's always in search_path.

DROP EXTENSION IF EXISTS pgtap;
CREATE EXTENSION pgtap SCHEMA public;
