-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryChangeLog" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryChangeLog_pkey" PRIMARY KEY ("id")
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
