-- 10 か所を超えたロケーションの従量（App Events API）の報告記録
CREATE TABLE IF NOT EXISTS "AppUsageReport" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "periodEnd" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "eventHandle" TEXT NOT NULL,
    "locationsCount" INTEGER NOT NULL,
    "units" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "httpStatus" INTEGER,
    "lastError" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppUsageReport_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AppUsageReport_idempotencyKey_key" ON "AppUsageReport"("idempotencyKey");
CREATE UNIQUE INDEX IF NOT EXISTS "AppUsageReport_shop_periodEnd_key" ON "AppUsageReport"("shop", "periodEnd");
CREATE INDEX IF NOT EXISTS "AppUsageReport_status_idx" ON "AppUsageReport"("status");
