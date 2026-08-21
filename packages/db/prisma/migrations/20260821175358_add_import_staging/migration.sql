-- AlterTable
ALTER TABLE "ImportBatch" ADD COLUMN     "charset" TEXT NOT NULL DEFAULT 'utf-8',
ADD COLUMN     "finishedAt" TIMESTAMP(3),
ADD COLUMN     "headers" JSONB,
ADD COLUMN     "startedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ImportRow" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "raw" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "recordId" TEXT,

    CONSTRAINT "ImportRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ImportRow_batchId_status_idx" ON "ImportRow"("batchId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ImportRow_batchId_rowNumber_key" ON "ImportRow"("batchId", "rowNumber");

-- AddForeignKey
ALTER TABLE "ImportRow" ADD CONSTRAINT "ImportRow_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS. Required for every migration that creates a table — see
-- 20260818160000_rls_enable, whose blanket enable only snapshotted the tables
-- that existed then. The invariant to hold: no table in `public` other than
-- `_prisma_migrations` has `rowsecurity` false.
--
-- ENABLE, never FORCE: the owning role (crm_app) stays exempt from its own
-- policies, so the application keeps full table access and authorisation
-- remains in the repository layer. Any other role — on Supabase, anon /
-- authenticated through the Data API — matches no policy and sees no rows.
ALTER TABLE "ImportRow" ENABLE ROW LEVEL SECURITY;
