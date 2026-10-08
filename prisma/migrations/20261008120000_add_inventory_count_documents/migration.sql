-- Phase F: InventoryCountDocument + chunks (metafield fallback retained in app layer)
CREATE TABLE IF NOT EXISTS "InventoryCountDocument" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "countId" TEXT NOT NULL,
    "countName" TEXT,
    "status" TEXT NOT NULL,
    "locationId" TEXT,
    "locationName" TEXT,
    "payloadJson" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "source" TEXT NOT NULL DEFAULT 'db',
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryCountDocument_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "InventoryCountDocumentChunk" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "payload" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryCountDocumentChunk_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "InventoryCountDocument_shop_countId_key" ON "InventoryCountDocument"("shop", "countId");
CREATE INDEX IF NOT EXISTS "InventoryCountDocument_shop_status_idx" ON "InventoryCountDocument"("shop", "status");
CREATE INDEX IF NOT EXISTS "InventoryCountDocument_shop_updatedAt_idx" ON "InventoryCountDocument"("shop", "updatedAt");
CREATE UNIQUE INDEX IF NOT EXISTS "InventoryCountDocumentChunk_documentId_chunkIndex_key" ON "InventoryCountDocumentChunk"("documentId", "chunkIndex");
CREATE INDEX IF NOT EXISTS "InventoryCountDocumentChunk_documentId_idx" ON "InventoryCountDocumentChunk"("documentId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'InventoryCountDocumentChunk_documentId_fkey'
  ) THEN
    ALTER TABLE "InventoryCountDocumentChunk"
      ADD CONSTRAINT "InventoryCountDocumentChunk_documentId_fkey"
      FOREIGN KEY ("documentId") REFERENCES "InventoryCountDocument"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
