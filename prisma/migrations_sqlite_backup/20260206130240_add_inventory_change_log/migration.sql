-- CreateTable
CREATE TABLE "InventoryChangeLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "date" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "variantId" TEXT,
    "sku" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "locationName" TEXT NOT NULL,
    "activity" TEXT NOT NULL,
    "delta" INTEGER,
    "quantityAfter" INTEGER,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT,
    "adjustmentGroupId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "InventoryChangeLog_shop_date_idx" ON "InventoryChangeLog"("shop", "date");

-- CreateIndex
CREATE INDEX "InventoryChangeLog_shop_locationId_idx" ON "InventoryChangeLog"("shop", "locationId");

-- CreateIndex
CREATE INDEX "InventoryChangeLog_shop_inventoryItemId_idx" ON "InventoryChangeLog"("shop", "inventoryItemId");

-- CreateIndex
CREATE INDEX "InventoryChangeLog_shop_activity_idx" ON "InventoryChangeLog"("shop", "activity");

-- CreateIndex
CREATE INDEX "InventoryChangeLog_shop_timestamp_idx" ON "InventoryChangeLog"("shop", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryChangeLog_shop_idempotencyKey_key" ON "InventoryChangeLog"("shop", "idempotencyKey");
