-- CreateTable: 在庫変更イベント（Phase1 イベント先行）ヘッダ
CREATE TABLE "InventoryChangeEvent" (
    "id" TEXT NOT NULL,
    "appEventId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "activity" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "locationName" TEXT,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL,
    "errorSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryChangeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable: 在庫変更イベント明細
CREATE TABLE "InventoryChangeEventLine" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "variantId" TEXT,
    "sku" TEXT,
    "delta" INTEGER,
    "quantityBefore" INTEGER,
    "quantityAfterExpected" INTEGER,
    "quantityAfterActual" INTEGER,
    "shopifyAdjustmentGroupId" TEXT,
    "lineStatus" TEXT NOT NULL,
    "errorMessage" TEXT,
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryChangeEventLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InventoryChangeEvent_appEventId_key" ON "InventoryChangeEvent"("appEventId");
CREATE INDEX "InventoryChangeEvent_shop_status_idx" ON "InventoryChangeEvent"("shop", "status");
CREATE INDEX "InventoryChangeEvent_shop_appEventId_idx" ON "InventoryChangeEvent"("shop", "appEventId");
CREATE INDEX "InventoryChangeEvent_shop_requestedAt_idx" ON "InventoryChangeEvent"("shop", "requestedAt");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryChangeEventLine_eventId_inventoryItemId_key" ON "InventoryChangeEventLine"("eventId", "inventoryItemId");
CREATE INDEX "InventoryChangeEventLine_eventId_idx" ON "InventoryChangeEventLine"("eventId");

-- AddForeignKey
ALTER TABLE "InventoryChangeEventLine" ADD CONSTRAINT "InventoryChangeEventLine_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "InventoryChangeEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
