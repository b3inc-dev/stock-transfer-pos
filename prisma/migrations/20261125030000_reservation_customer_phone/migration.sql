ALTER TABLE "StockReservation" ADD COLUMN "customerPhoneSaveState" TEXT;
ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_customerPhoneSaveState_check"
CHECK ("customerPhoneSaveState" IS NULL OR "customerPhoneSaveState" IN ('pending', 'saving', 'saved', 'failed', 'unknown', 'conflict'));
