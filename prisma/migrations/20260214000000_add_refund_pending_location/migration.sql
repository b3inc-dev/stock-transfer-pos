-- CreateTable
CREATE TABLE "RefundPendingLocation" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "refundId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "refundCreatedAt" TIMESTAMP(3) NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefundPendingLocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RefundPendingLocation_shop_refundId_inventoryItemId_locationId_key" ON "RefundPendingLocation"("shop", "refundId", "inventoryItemId", "locationId");

-- CreateIndex
CREATE INDEX "RefundPendingLocation_shop_inventoryItemId_locationId_refundCre_idx" ON "RefundPendingLocation"("shop", "inventoryItemId", "locationId", "refundCreatedAt");
