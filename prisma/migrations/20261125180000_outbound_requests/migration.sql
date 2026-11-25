CREATE TABLE "OutboundRequest" (
 "id" TEXT NOT NULL, "shop" TEXT NOT NULL, "number" TEXT NOT NULL,
 "originId" TEXT NOT NULL, "originName" TEXT NOT NULL, "destinationId" TEXT NOT NULL, "destinationName" TEXT NOT NULL,
 "dueDate" TEXT, "note" TEXT NOT NULL DEFAULT '', "lines" JSONB NOT NULL, "actualLines" JSONB NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'draft', "version" INTEGER NOT NULL DEFAULT 1,
 "owner" TEXT, "claimKey" TEXT, "operationId" TEXT, "execution" JSONB, "error" TEXT,
 "createdBy" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL, "completedAt" TIMESTAMP(3), CONSTRAINT "OutboundRequest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OutboundRequest_shop_number_key" ON "OutboundRequest"("shop", "number");
CREATE UNIQUE INDEX "OutboundRequest_operationId_key" ON "OutboundRequest"("operationId");
CREATE INDEX "OutboundRequest_shop_originId_status_createdAt_idx" ON "OutboundRequest"("shop", "originId", "status", "createdAt");
CREATE TABLE "OutboundRequestEvent" (
 "id" TEXT NOT NULL, "requestId" TEXT NOT NULL, "actor" TEXT NOT NULL, "action" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "OutboundRequestEvent_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "OutboundRequestEvent_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "OutboundRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "OutboundRequestEvent_requestId_createdAt_idx" ON "OutboundRequestEvent"("requestId", "createdAt");
CREATE TABLE "OutboundRequestSettings" (
 "shop" TEXT NOT NULL, "policy" JSONB NOT NULL, "version" INTEGER NOT NULL DEFAULT 1,
 "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "OutboundRequestSettings_pkey" PRIMARY KEY ("shop")
);
