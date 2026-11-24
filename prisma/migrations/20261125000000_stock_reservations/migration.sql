CREATE TABLE "StockReservation" (
 "id" TEXT NOT NULL PRIMARY KEY, "requestHash" TEXT, "shop" TEXT NOT NULL, "locationId" TEXT NOT NULL,
 "locationName" TEXT NOT NULL, "timezone" TEXT NOT NULL, "status" TEXT NOT NULL,
 "version" INTEGER NOT NULL DEFAULT 1, "customerId" TEXT, "guestName" TEXT, "contactPhone" TEXT,
 "lines" JSONB NOT NULL, "dueDate" TEXT NOT NULL, "nextFollowDate" TEXT,
 "checkoutKey" TEXT, "checkoutBy" TEXT, "checkoutDevice" TEXT, "orderId" TEXT, "operation" JSONB, "lastError" TEXT,
 "createdBy" TEXT NOT NULL, "endedBy" TEXT, "endedAt" TIMESTAMP(3), "anonymizedAt" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "StockReservation_checkoutKey_key" ON "StockReservation"("checkoutKey");
CREATE INDEX "StockReservation_shop_locationId_status_dueDate_idx" ON "StockReservation"("shop", "locationId", "status", "dueDate");
CREATE INDEX "StockReservation_shop_customerId_idx" ON "StockReservation"("shop", "customerId");
CREATE TABLE "StockReservationEvent" (
 "id" TEXT NOT NULL PRIMARY KEY, "reservationId" TEXT NOT NULL,
 "kind" TEXT NOT NULL, "actor" TEXT NOT NULL, "followDate" TEXT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "StockReservationEvent_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "StockReservation"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "StockReservationEvent_reservationId_createdAt_idx" ON "StockReservationEvent"("reservationId", "createdAt");
CREATE TABLE "StockReservationSettings" (
 "shop" TEXT NOT NULL PRIMARY KEY, "days" INTEGER NOT NULL DEFAULT 7, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "StockReservationPrivacyRequest" (
 "id" TEXT NOT NULL PRIMARY KEY, "shop" TEXT NOT NULL, "customerId" TEXT NOT NULL,
 "exportedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "StockReservationPrivacyRequest_shop_exportedAt_idx" ON "StockReservationPrivacyRequest"("shop", "exportedAt");
