-- 棚卸の 1件ずつ保存（db_v2）。追加のみで既存列は変更しない
ALTER TABLE "InventoryCountDocument" ADD COLUMN IF NOT EXISTS "listJson" TEXT;

CREATE TABLE IF NOT EXISTS "InventoryCountGroupResult" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "countId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "groupKey" TEXT NOT NULL,
    "itemsJson" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryCountGroupResult_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "InventoryCountGroupResult_documentId_groupKey_key" ON "InventoryCountGroupResult"("documentId", "groupKey");
CREATE INDEX IF NOT EXISTS "InventoryCountGroupResult_shop_countId_idx" ON "InventoryCountGroupResult"("shop", "countId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'InventoryCountGroupResult_documentId_fkey'
  ) THEN
    ALTER TABLE "InventoryCountGroupResult"
      ADD CONSTRAINT "InventoryCountGroupResult_documentId_fkey"
      FOREIGN KEY ("documentId") REFERENCES "InventoryCountDocument"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "StocktakePendingComplete" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "countId" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "savedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StocktakePendingComplete_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "StocktakePendingComplete_shop_countId_key" ON "StocktakePendingComplete"("shop", "countId");
CREATE INDEX IF NOT EXISTS "StocktakePendingComplete_shop_savedAt_idx" ON "StocktakePendingComplete"("shop", "savedAt");

CREATE TABLE IF NOT EXISTS "StocktakeStorageState" (
    "shop" TEXT NOT NULL,
    "modeOverride" TEXT,
    "backfilledAt" TIMESTAMP(3),
    "backfillLegacyVersion" INTEGER,
    "mirrorDirty" BOOLEAN NOT NULL DEFAULT false,
    "mirrorSeq" INTEGER NOT NULL DEFAULT 0,
    "mirroredAt" TIMESTAMP(3),
    "mirroredLegacyVersion" INTEGER,
    "lastLegacyIngestAt" TIMESTAMP(3),
    "lastError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StocktakeStorageState_pkey" PRIMARY KEY ("shop")
);
