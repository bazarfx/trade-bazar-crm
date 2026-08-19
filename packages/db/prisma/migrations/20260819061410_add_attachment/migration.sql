-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "fieldKey" TEXT NOT NULL,
    "uploadedById" TEXT,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Attachment_entityType_entityId_fieldKey_idx" ON "Attachment"("entityType", "entityId", "fieldKey");

-- CreateIndex
CREATE INDEX "Attachment_isDeleted_createdAt_idx" ON "Attachment"("isDeleted", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_bucket_objectKey_key" ON "Attachment"("bucket", "objectKey");

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RLS. Required for every migration that creates a table — see
-- 20260818160000_rls_enable. ENABLE, never FORCE: the owning role stays exempt
-- so the app keeps full access and authorisation remains in the repository
-- layer, while any other role matches no policy and sees no rows.
ALTER TABLE "Attachment" ENABLE ROW LEVEL SECURITY;
