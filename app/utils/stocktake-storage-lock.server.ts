import type { Prisma } from "@prisma/client";
import db from "../db.server";
import { resolveEffectiveMode, type StocktakeStorageMode } from "./stocktake-count-store-logic";

type Tx = Prisma.TransactionClient;

export async function readMode(shop: string, tx: Tx) {
  const state = await tx.stocktakeStorageState.findUnique({ where: { shop } });
  return resolveEffectiveMode({
    envMode: process.env.STOCKTAKE_STORAGE_MODE,
    override: state?.modeOverride ?? null,
    backfilled: Boolean(state?.backfilledAt),
  });
}

// The transaction that owns the lock also owns all database work for this operation.
export function withMaintenanceLock<T>(shop: string, work: (tx: Tx) => Promise<T>): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"stocktake-mode:" + shop}, 0))`;
    return work(tx);
  }, { maxWait: 10_000, timeout: 120_000 });
}

export async function requireMode(shop: string, tx: Tx, expected: StocktakeStorageMode) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${"stocktake-mode:" + shop}, 0))`;
  if (expected === "legacy") {
    const [row] = await tx.$queryRaw<Array<{ installed: boolean }>>`SELECT to_regclass('"StocktakeStorageState"') IS NOT NULL AS installed`;
    if (!row.installed) return;
  }
  if (await readMode(shop, tx) !== expected) throw new Error("棚卸の保存先が変更されました。再読み込みしてください。");
}
