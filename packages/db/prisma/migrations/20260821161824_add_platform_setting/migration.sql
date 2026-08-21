-- CreateTable
CREATE TABLE "PlatformSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformSetting_pkey" PRIMARY KEY ("key")
);

-- RLS. Required for every migration that creates a table — see
-- 20260818160000_rls_enable, whose blanket enable only snapshotted the tables
-- that existed then. The invariant to hold: no table in `public` other than
-- `_prisma_migrations` has `rowsecurity` false.
--
-- ENABLE, never FORCE: the owning role (crm_app) stays exempt from its own
-- policies, so the application keeps full table access and authorisation
-- remains in the repository layer. Any other role — on Supabase, anon /
-- authenticated through the Data API — matches no policy and sees no rows.
ALTER TABLE "PlatformSetting" ENABLE ROW LEVEL SECURITY;
