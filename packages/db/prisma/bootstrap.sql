-- Bootstrap the application database role.
--
-- Run ONCE, as a superuser, BEFORE the first `npm run db:deploy`:
--   Supabase — SQL Editor, or psql as the `postgres` role
--   Vultr    — psql as postgres
--   Local    — already done by `createuser crm --createdb`
--
-- WHY THIS RUNS FIRST: table ownership is fixed at CREATE TABLE time. If
-- migrations run as Supabase's `postgres` role, every table inherits that
-- role's ALTER DEFAULT PRIVILEGES grants to anon/authenticated/service_role,
-- and a later `pg_dump` carries ACLs referencing roles that do not exist on a
-- plain Postgres box. Fixing it afterwards means REASSIGN OWNED plus
-- re-pointing every connection string.
--
-- Every Supabase-specific block is guarded, so this file also runs clean on
-- Vultr and on a local Postgres.

-- ── 1. the application role ──────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_app') THEN
    -- CREATEDB is only needed so a local `migrate dev` can build its shadow DB
    CREATE ROLE crm_app LOGIN CREATEDB PASSWORD 'REPLACE_ME';
  END IF;
END $$;

GRANT USAGE, CREATE ON SCHEMA public TO crm_app;

-- Supabase keeps extensions in their own schema; harmless no-op elsewhere.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'extensions') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA extensions TO crm_app';
  END IF;
END $$;

-- Let the platform's own tooling (dashboard, backups) administer objects
-- that crm_app owns.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
    EXECUTE 'GRANT crm_app TO postgres';
  END IF;
END $$;

ALTER ROLE crm_app SET idle_in_transaction_session_timeout = '60s';

-- ── 2. keep the Data API roles from inheriting anything ──────────────────
-- Supabase only. This app has its own auth and permission engine and must
-- never be reachable over PostgREST; the Data API should also be disabled in
-- the dashboard. Belt and braces.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated';
    EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated';
    EXECUTE 'REVOKE ALL ON ALL ROUTINES  IN SCHEMA public FROM anon, authenticated';
    EXECUTE 'REVOKE USAGE ON SCHEMA public FROM anon, authenticated';
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated';
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated';
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON ROUTINES  FROM anon, authenticated';
  END IF;
END $$;
