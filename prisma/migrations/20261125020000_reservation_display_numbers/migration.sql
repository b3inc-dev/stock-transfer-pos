-- Keep the UUID as the internal/replay key. Give every shop its own human-readable number.
-- The trigger also numbers inserts from an older app instance during rolling deployment.
BEGIN;
LOCK TABLE "StockReservation" IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE "StockReservation" ADD COLUMN "number" INTEGER;
-- Older records did not persist the intake switch; do not invent an intake method.
ALTER TABLE "StockReservation" ADD COLUMN "intakeMethod" TEXT;
ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_intakeMethod_valid" CHECK ("intakeMethod" IS NULL OR "intakeMethod" IN ('in_person', 'inquiry'));
ALTER TABLE "StockReservationSettings" ADD COLUMN "nextReservationNumber" INTEGER NOT NULL DEFAULT 1;

WITH numbered AS (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "shop" ORDER BY "createdAt", "id")::INTEGER AS n
  FROM "StockReservation"
)
UPDATE "StockReservation" r SET "number" = numbered.n FROM numbered WHERE r."id" = numbered."id";

CREATE UNIQUE INDEX "StockReservation_shop_number_key" ON "StockReservation"("shop", "number");
ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_number_positive" CHECK ("number" IS NULL OR "number" > 0);
INSERT INTO "StockReservationSettings" ("shop", "nextReservationNumber", "updatedAt")
SELECT "shop", MAX("number") + 1, CURRENT_TIMESTAMP FROM "StockReservation" GROUP BY "shop"
ON CONFLICT ("shop") DO UPDATE SET "nextReservationNumber" = GREATEST("StockReservationSettings"."nextReservationNumber", EXCLUDED."nextReservationNumber");

CREATE FUNCTION "assign_stock_reservation_number"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."number" IS NULL THEN
    INSERT INTO "StockReservationSettings" ("shop", "nextReservationNumber", "updatedAt")
    VALUES (NEW."shop", 2, CURRENT_TIMESTAMP)
    ON CONFLICT ("shop") DO UPDATE
      SET "nextReservationNumber" = "StockReservationSettings"."nextReservationNumber" + 1,
          "updatedAt" = CURRENT_TIMESTAMP
    RETURNING "nextReservationNumber" - 1 INTO NEW."number";
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "StockReservation_assign_number" BEFORE INSERT ON "StockReservation"
FOR EACH ROW EXECUTE FUNCTION "assign_stock_reservation_number"();
COMMIT;
