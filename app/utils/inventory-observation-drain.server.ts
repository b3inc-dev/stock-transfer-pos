import type { PrismaClient, InventoryWebhookObservation } from "@prisma/client";
import { findPreviousQuantity } from "./inventory-history-order";

type Db = Pick<PrismaClient, "inventoryWebhookObservation" | "inventoryChangeLog">;
type Observation = InventoryWebhookObservation;
export type ObservationRecovery = { scanned: number; attempted: number; completed: number; retained: number; failed: number; deferred: number; batchLimitReached: boolean };

/** Bounded work on the existing authenticated daily trigger, never a new timer. */
export async function drainInventoryObservations(args: {
  db: Db;
  replay: (observation: Observation) => Promise<Response>;
  nowMs?: () => number;
  limit?: number;
  budgetMs?: number;
}): Promise<ObservationRecovery> {
  const { db, replay } = args, now = args.nowMs ?? Date.now;
  if (!db.inventoryWebhookObservation) throw new Error("Inventory observation store unavailable");
  const limit = Math.max(1, Math.min(100, args.limit ?? 25));
  const budget = Math.max(1, args.budgetMs ?? 2000), started = now();
  const rows = await db.inventoryWebhookObservation.findMany({
    orderBy: [{ lastAttemptedAt: { sort: "asc", nulls: "first" } }, { timestamp: "asc" }, { idempotencyKey: "asc" }],
    take: limit,
  });
  const result: ObservationRecovery = { scanned: rows.length, attempted: 0, completed: 0, retained: 0, failed: 0, deferred: 0, batchLimitReached: rows.length === limit };
  for (const observation of rows) {
    if (now() - started >= budget) break;
    result.attempted++;
    let outcome: "completed" | "retained" | "failed" = "failed";
    try {
      const response = await replay(observation);
      if (response.status < 400) {
        const remaining = await db.inventoryWebhookObservation.findUnique({
          where: { shop_idempotencyKey: { shop: observation.shop, idempotencyKey: observation.idempotencyKey } },
        });
        if (!remaining) outcome = "completed";
        else {
          const rawItem = observation.inventoryItemId.replace(/^gid:\/\/shopify\/InventoryItem\//, "");
          const rawLocation = observation.locationId.replace(/^gid:\/\/shopify\/Location\//, "");
          const previous = await findPreviousQuantity(db, {
            shop: observation.shop,
            inventoryItemIds: [rawItem, `gid://shopify/InventoryItem/${rawItem}`],
            locationIds: [rawLocation, `gid://shopify/Location/${rawLocation}`],
          }, observation.timestamp);
          // An HTTP200 with a still-nonzero-required observation is not success.
          if (previous.prevAvailable === observation.available) outcome = "retained";
        }
      }
    } catch { /* Keep the durable observation; the next existing daily call retries. */ }
    try {
      await db.inventoryWebhookObservation.updateMany({
        where: { shop: observation.shop, idempotencyKey: observation.idempotencyKey },
        data: { lastAttemptedAt: new Date(now()) },
      });
    } catch { outcome = "failed"; }
    result[outcome]++;
  }
  result.deferred = result.scanned - result.attempted;
  return result;
}
