/**
 * 管理画面の仕入れの確定・取り消し（app.purchase.tsx）の在庫の足し引き（inventoryAdjustQuantities）。
 * docs/IDEMPOTENT_MIGRATION.md 4.6 の M（2 段目）。
 *
 * - `@idempotent(key: $idempotencyKey)`。キーは画面の opKey + 仕入れの ID + `receive`／`cancel`、段 `adjust`、チャンク `1/1`、回
 * - 2026-04 で必須になる `changeFromQuantity` は、D9 のとおり `null`（確かめない）をはっきり書く
 * - 足し引き（delta）なので、同じ中身を新しいキーで送ると二重に足される。結果が分からないときはキーを変えない
 *
 * 前のコードと同じく 1 回で送る（250 件ずつには分けない。仕入れ 1 件の明細はそれより少ない前提。推測）。
 */
import { retryWhileIdempotencyConcurrent } from "./graphql-with-retry";
import { classifyIdempotencyErrors, type IdempotencyIssue } from "./idempotency-key.server";
import {
  adminIdempotencyKey,
  classifyAdminWrite,
  type AdminIdempotency,
  type AdminOpKeyResult,
} from "./admin-op-key.server";

export const PURCHASE_ADJUST_STAGE = "adjust";

export const PURCHASE_ADJUST_MUTATION = `#graphql
    mutation InventoryAdjustQuantities($input: InventoryAdjustQuantitiesInput!, $idempotencyKey: String!) {
      inventoryAdjustQuantities(input: $input) @idempotent(key: $idempotencyKey) {
        inventoryAdjustmentGroup { id }
        userErrors { field message code }
      }
    }`;

export type PurchaseAdjustChange = {
  inventoryItemId: string;
  locationId: string;
  delta: number;
  /** 2026-04 で必須。確かめないので null */
  changeFromQuantity: null;
};

export type PurchaseAdjustResult =
  | { ok: true; adjustmentGroupId: string | null; opKeyResult: "done" }
  | { ok: false; error: string; opKeyResult: Exclude<AdminOpKeyResult, "done">; idempotencyIssue?: IdempotencyIssue | null };

type AdminGraphql = { graphql: (q: string, v?: { variables?: Record<string, unknown> }) => Promise<Response> };

/** 送る形を作る（テストと画面で同じものを使う） */
export function buildPurchaseAdjustChanges(
  items: ReadonlyArray<{ inventoryItemId: string; quantity?: number | string | null }>,
  locationGid: string,
  normalizeInventoryItemGid: (id: string) => string,
  sign: 1 | -1
): PurchaseAdjustChange[] {
  return items
    .map((item) => {
      const invId = normalizeInventoryItemGid(item.inventoryItemId);
      const qty = Math.max(0, Number(item.quantity || 0));
      if (!invId || qty === 0) return null;
      return { inventoryItemId: invId, locationId: locationGid, delta: sign * qty, changeFromQuantity: null };
    })
    .filter((c): c is PurchaseAdjustChange => c !== null);
}

/**
 * 1 回送る。例外（通信の失敗）は投げずに uncertain で返す。
 * @param logLabel ログの頭（`executePurchaseReceive` など）
 */
export async function sendPurchaseAdjustQuantities(
  admin: AdminGraphql,
  changes: PurchaseAdjustChange[],
  idem: AdminIdempotency,
  logLabel: string
): Promise<PurchaseAdjustResult> {
  const variables = {
    input: { reason: "correction", name: "available", changes },
    idempotencyKey: adminIdempotencyKey(idem, PURCHASE_ADJUST_STAGE, "1/1"),
  };
  console.log(`[${logLabel}] Sending inventoryAdjustQuantities: changes=${changes.length} round=${idem.round}`);
  type AdjustJson = {
    data?: {
      inventoryAdjustQuantities?: {
        userErrors?: Array<{ field?: unknown; message?: string; code?: string }>;
        inventoryAdjustmentGroup?: { id?: string } | null;
      } | null;
    };
    errors?: Array<{ message?: string; extensions?: { code?: unknown } }>;
  };
  let json: AdjustJson;
  let concurrentExhausted = false;
  try {
    const sent = await retryWhileIdempotencyConcurrent<AdjustJson>(
      async () => (await (await admin.graphql(PURCHASE_ADJUST_MUTATION, { variables })).json()) as AdjustJson,
      (j) => classifyIdempotencyErrors(j?.data?.inventoryAdjustQuantities?.userErrors, j?.errors) === "concurrent",
      idem.concurrentRetryDelaysMs
    );
    json = sent.result;
    concurrentExhausted = sent.concurrentExhausted;
  } catch (error: unknown) {
    console.error(`[${logLabel}] Exception caught:`, error);
    const err = error as { message?: string; body?: { errors?: Array<{ message?: string }> } };
    const message = err?.message ?? err?.body?.errors?.[0]?.message ?? String(error);
    return { ok: false, error: message, opKeyResult: "uncertain", idempotencyIssue: null };
  }
  const payload = json?.data?.inventoryAdjustQuantities;
  const c = classifyAdminWrite(payload?.userErrors, json?.errors, concurrentExhausted);
  if (c.outcome === "rejected") {
    console.error(`[${logLabel}] User errors:`, JSON.stringify(payload?.userErrors ?? []));
    return { ok: false, error: c.message, opKeyResult: "rejected" };
  }
  if (c.outcome === "uncertain") {
    console.warn(`[${logLabel}] uncertain issue=${c.idempotencyIssue ?? "none"}: ${c.message}`);
    return { ok: false, error: c.message, opKeyResult: "uncertain", idempotencyIssue: c.idempotencyIssue };
  }
  return { ok: true, adjustmentGroupId: payload?.inventoryAdjustmentGroup?.id || null, opKeyResult: "done" };
}
