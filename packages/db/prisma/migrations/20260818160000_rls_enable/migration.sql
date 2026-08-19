-- Enable row level security on every table in the application schema.
--
-- ENABLE, never FORCE: the owning role (crm_app) is exempt from its own
-- policies unless FORCE is used, so the application keeps full table access
-- and authorisation stays exactly where CLAUDE.md requires it — in the
-- repository layer, via PermissionEngine.scopeFilter.
--
-- What this buys: any OTHER role that reaches these tables (on Supabase:
-- anon / authenticated via the Data API) matches zero policies and therefore
-- sees zero rows. Defence in depth behind the disabled Data API.
--
-- Deliberately vanilla Postgres. No policies are created, and nothing here
-- names a Supabase-specific role — so this migration is a harmless no-op on a
-- self-managed Vultr box rather than a restore error.
--
-- NOTE: this snapshots the tables that exist right now. Any future migration
-- that creates a table must append the same block.
DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END $$;
