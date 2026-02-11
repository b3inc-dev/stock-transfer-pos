-- CreateTable
CREATE TABLE "OrderPendingLocation" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderCreatedAt" TIMESTAMP(3) NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderPendingLocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrderPendingLocation_shop_orderId_inventoryItemId_key" ON "OrderPendingLocation"("shop", "orderId", "inventoryItemId");

-- CreateIndex
CREATE INDEX "OrderPendingLocation_shop_inventoryItemId_orderCreatedAt_idx" ON "OrderPendingLocation"("shop", "inventoryItemId", "orderCreatedAt");
