ALTER TABLE "OutboundRequestSettings" ADD COLUMN "receiptLayout" JSONB, ADD COLUMN "receiptVersion" INTEGER NOT NULL DEFAULT 0;
