-- AlterTable: OrderPendingLocation に locationId を追加（同一注文で同一商品が2ロケーションから出荷される場合のマッチ用）
ALTER TABLE "OrderPendingLocation" ADD COLUMN "locationId" TEXT NOT NULL DEFAULT '';

-- DropIndex: 旧ユニークを削除
DROP INDEX "OrderPendingLocation_shop_orderId_inventoryItemId_key";

-- CreateIndex: 新ユニーク（locationId を含む）
CREATE UNIQUE INDEX "OrderPendingLocation_shop_orderId_inventoryItemId_locationId_key" ON "OrderPendingLocation"("shop", "orderId", "inventoryItemId", "locationId");

-- DropIndex: 旧インデックスを削除
DROP INDEX "OrderPendingLocation_shop_inventoryItemId_orderCreatedAt_idx";

-- CreateIndex: 新インデックス（locationId を含む。inventory_levels/update の findMany 用）
CREATE INDEX "OrderPendingLocation_shop_inventoryItemId_locationId_orderCreatedAt_idx" ON "OrderPendingLocation"("shop", "inventoryItemId", "locationId", "orderCreatedAt");
