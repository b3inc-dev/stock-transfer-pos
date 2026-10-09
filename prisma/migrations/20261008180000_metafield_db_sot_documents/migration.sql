-- Metafield → DB SoT staged migration tables
-- inventory_counts already has InventoryCountDocument*; this adds groups / entries / daily snapshots.
-- settings_v1 and Transfer/Shipment remain outside app DB.

CREATE TABLE IF NOT EXISTS "ProductGroupDocument" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "name" TEXT,
    "payloadJson" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "source" TEXT NOT NULL DEFAULT 'db',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductGroupDocument_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ProductGroupDocument_shop_groupId_key" ON "ProductGroupDocument"("shop", "groupId");
CREATE INDEX IF NOT EXISTS "ProductGroupDocument_shop_updatedAt_idx" ON "ProductGroupDocument"("shop", "updatedAt");
CREATE INDEX IF NOT EXISTS "ProductGroupDocument_shop_name_idx" ON "ProductGroupDocument"("shop", "name");

CREATE TABLE IF NOT EXISTS "AppEntryDocument" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "entryType" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "status" TEXT,
    "name" TEXT,
    "locationId" TEXT,
    "payloadJson" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "source" TEXT NOT NULL DEFAULT 'db',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppEntryDocument_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AppEntryDocument_shop_entryType_entryId_key" ON "AppEntryDocument"("shop", "entryType", "entryId");
CREATE INDEX IF NOT EXISTS "AppEntryDocument_shop_entryType_updatedAt_idx" ON "AppEntryDocument"("shop", "entryType", "updatedAt");
CREATE INDEX IF NOT EXISTS "AppEntryDocument_shop_entryType_status_idx" ON "AppEntryDocument"("shop", "entryType", "status");
CREATE INDEX IF NOT EXISTS "AppEntryDocument_shop_entryType_createdAt_idx" ON "AppEntryDocument"("shop", "entryType", "createdAt");

CREATE TABLE IF NOT EXISTS "InventoryDailySnapshotRow" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "locationName" TEXT,
    "totalQuantity" INTEGER NOT NULL DEFAULT 0,
    "totalRetailValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalCompareAtPriceValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalCostValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "snapshotUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryDailySnapshotRow_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "InventoryDailySnapshotRow_shop_date_locationId_key" ON "InventoryDailySnapshotRow"("shop", "date", "locationId");
CREATE INDEX IF NOT EXISTS "InventoryDailySnapshotRow_shop_date_idx" ON "InventoryDailySnapshotRow"("shop", "date");
CREATE INDEX IF NOT EXISTS "InventoryDailySnapshotRow_shop_updatedAt_idx" ON "InventoryDailySnapshotRow"("shop", "updatedAt");
