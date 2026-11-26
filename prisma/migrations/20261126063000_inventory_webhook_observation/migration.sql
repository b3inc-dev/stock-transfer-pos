CREATE TABLE "InventoryWebhookObservation" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "available" INTEGER NOT NULL,
    "adjustmentGroupId" TEXT,
    "lastAttemptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InventoryWebhookObservation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "InventoryWebhookObservation_shop_idempotencyKey_key" ON "InventoryWebhookObservation"("shop", "idempotencyKey");
CREATE INDEX "InventoryWebhookObservation_shop_inventoryItemId_locationId_timestamp_idx" ON "InventoryWebhookObservation"("shop", "inventoryItemId", "locationId", "timestamp");
