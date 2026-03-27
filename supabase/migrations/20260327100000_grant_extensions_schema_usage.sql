-- WHY: pgtap is installed in the `extensions` schema on Supabase Cloud.
-- The test login role created by `supabase test db --linked` lacks USAGE
-- on this schema, causing "permission denied for schema extensions".
-- This grant ensures all standard Supabase roles can access extension
-- functions (pgtap, pgcrypto, etc.).

GRANT USAGE ON SCHEMA extensions TO postgres, anon, authenticated, service_role;
