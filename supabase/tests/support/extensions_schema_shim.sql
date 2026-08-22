-- Mirrors real hosted Supabase's platform-provisioned "extensions" schema.
-- On a hosted Supabase project, pgcrypto (and several other common
-- extensions) are installed into a dedicated "extensions" schema *before*
-- any user migration ever runs -- verified directly against the live hosted
-- staging project: extensions.digest()/extensions.gen_random_bytes() exist
-- there, not public.digest()/public.gen_random_bytes(). A vanilla local
-- Postgres has no such pre-provisioning, so 00000000000001_extensions.sql's
-- `create extension if not exists "pgcrypto"` would otherwise land in
-- "public" locally (the first schema on a fresh session's search_path),
-- diverging from hosted and hiding bugs like migration 18's original
-- `public.digest(...)` references, which only surfaced when applied to the
-- real hosted project.
--
-- Applying this shim before 00000000000001_extensions.sql makes that
-- migration's own `create extension if not exists` a no-op for pgcrypto
-- (already present here), so both environments resolve
-- extensions.digest(...)/extensions.gen_random_bytes(...) identically.
create schema if not exists extensions;
create extension if not exists "pgcrypto" with schema extensions;
