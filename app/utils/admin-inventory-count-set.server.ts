/**
 * 管理画面の棚卸の確定・取り消し（app.inventory-count.tsx）から在庫を数で書く（inventorySetQuantities）。
 * 前は画面のファイルの中にあった adjustInventoryQuantitiesServer を、テストできるようにここへ移した（中身の動きは同じ）。
 *
 * 足したもの（docs/IDEMPOTENT_MIGRATION.md 4.6 の K・2 段目）:
 * - `@idempotent(key: $idempotencyKey)`。キーは画面の opKey + 棚卸 + 動き + グループ、段 `set`、チャンク `i/n`、回（admin-op-key.server.ts）
 * - 429・503 の送り直し（withGraphQLRetry）と IDEMPOTENCY_CONCURRENT_REQUEST の送り直しは同じキー
 * - 答えを 3 つに分ける: done（全部書けた）・rejected（はっきり断られた）・uncertain（分からない）
 *
 * 変えていないもの: 250 件ずつに分ける・途中のチャンクで止まったら先のチャンクは戻さない・`changeFromQuantity: null`（確かめない）
 */
import { retryWhileIdempotencyConcurrent } from "./graphql-with-retry";
import {
  classifyIdempotencyErrors,
  formatIdempotencyChunk,
  type IdempotencyIssue,
} from "./idempotency-key.server";
import {
  adminIdempotencyKey,
  classifyAdminWrite,
  type AdminIdempotency,
  type AdminOpKeyResult,
} from "./admin-op-key.server";

/** Shopify inventorySetQuantities の quantities 配列の最大件数（API 制限） */
export const INVENTORY_SET_QUANTITIES_MAX = 250;

/** 段の名前（キーの材料。変えない） */
export const INVENTORY_COUNT_SET_STAGE = "set";

export const INVENTORY_COUNT_SET_MUTATION = `#graphql
  mutation InventorySetQuantities($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
    inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
      inventoryAdjustmentGroup { id }
      userErrors { field message code }
    }
  }
`;

type AdminGraphql = { graphql: (q: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response> };

/** 管理画面から棚卸確定・リセット時に在庫を反映するためのヘルパー。ID を数字だけにする */
export function toRawIdForCount(id: string | number | null | undefined): string {
  if (id == null) return "";
  const s = String(id).trim();
  if (s.startsWith("gid://")) {
    const last = s.split("/").pop();
    return last || s;
  }
  return s;
}
export function toLocationGidForCount(locationId: string): string {
  const s = String(locationId || "").trim();
  if (s.startsWith("gid://")) return s;
  const raw = toRawIdForCount(locationId);
  return raw ? `gid://shopify/Location/${raw}` : s;
}
export function toInventoryItemGidForCount(inventoryItemId: string): string | null {
  const str = String(inventoryItemId || "").trim();
  if (!str) return null;
  if (/^\d+$/.test(str)) return `gid://shopify/InventoryItem/${str}`;
  if (str.includes("gid://")) return str;
  return null;
}

export type InventoryCountSetResult = {
  ok: boolean;
  invalidCount?: number;
  error?: string;
  /** 画面の opKey をどうするか（done = 作り直す・rejected = 回を増やす・uncertain = そのまま） */
  opKeyResult: AdminOpKeyResult;
  /** 書けたチャンクの件数（途中で止まったとき、先に書けた分） */
  appliedCount: number;
  idempotencyIssue?: IdempotencyIssue | null;
};

/**
 * 管理画面から inventorySetQuantities で在庫を設定（POS の adjustInventoryToActual と同様）。250件超はチャンク分割して複数回実行。
 * 有効な商品が無いときは Shopify に送らないので「はっきり断られた」と同じ扱い（rejected）にする。
 */
export async function adjustInventoryQuantitiesServer(
  admin: AdminGraphql,
  locationId: string,
  items: Array<{ inventoryItemId: string; quantity: number }>,
  referenceDocumentUri: string | null | undefined,
  idem: AdminIdempotency
): Promise<InventoryCountSetResult> {
  const locationGid = toLocationGidForCount(locationId);
  const quantities = (items ?? [])
    .filter((x) => x?.inventoryItemId && Number.isFinite(Number(x?.quantity)))
    .map((x) => {
      const gid = toInventoryItemGidForCount(x.inventoryItemId);
      const quantity = Math.floor(Number(x.quantity) ?? 0);
      return gid ? { valid: true as const, inventoryItemId: gid, quantity } : { valid: false as const };
    });
  const validQuantities = quantities.filter((q) => q.valid);
  const invalidCount = quantities.filter((q) => !q.valid).length;
  if (validQuantities.length === 0) {
    return { ok: false, invalidCount, error: "有効な在庫アイテムがありません", opKeyResult: "rejected", appliedCount: 0 };
  }
  const refUri = referenceDocumentUri
    ? `gid://stock-transfer-pos/InventoryCount/${referenceDocumentUri}`
    : undefined;
  const total = Math.ceil(validQuantities.length / INVENTORY_SET_QUANTITIES_MAX);
  let appliedCount = 0;
  for (let ci = 0; ci < total; ci++) {
    const chunk = validQuantities.slice(ci * INVENTORY_SET_QUANTITIES_MAX, (ci + 1) * INVENTORY_SET_QUANTITIES_MAX);
    const input: Record<string, unknown> = {
      name: "available",
      reason: "correction",
      quantities: chunk.map((q) => ({
        inventoryItemId: q.inventoryItemId,
        locationId: locationGid,
        quantity: q.quantity,
        changeFromQuantity: null,
      })),
    };
    if (refUri) input.referenceDocumentUri = refUri;
    // 送り直し（429/503・処理中）でも同じ variables＝同じキーを送る
    const variables = {
      input,
      idempotencyKey: adminIdempotencyKey(idem, INVENTORY_COUNT_SET_STAGE, formatIdempotencyChunk(ci, total)),
    };
    type SetJson = {
      data?: { inventorySetQuantities?: { userErrors?: Array<{ field?: unknown; message?: string; code?: string }> } | null };
      errors?: Array<{ message?: string; extensions?: { code?: unknown } }>;
    };
    let json: SetJson;
    let concurrentExhausted = false;
    try {
      const sent = await retryWhileIdempotencyConcurrent<SetJson>(
        async () => (await (await admin.graphql(INVENTORY_COUNT_SET_MUTATION, { variables })).json()) as SetJson,
        (j) => classifyIdempotencyErrors(j?.data?.inventorySetQuantities?.userErrors, j?.errors) === "concurrent",
        idem.concurrentRetryDelaysMs
      );
      json = sent.result;
      concurrentExhausted = sent.concurrentExhausted;
    } catch (e) {
      // 通信の失敗・例外: 書けたか分からない。キーを変えずに押し直せば、通っていれば Shopify は 2 回目を動かさない
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg, opKeyResult: "uncertain", appliedCount, idempotencyIssue: null };
    }
    const c = classifyAdminWrite(json?.data?.inventorySetQuantities?.userErrors, json?.errors, concurrentExhausted);
    if (c.outcome === "rejected") {
      return { ok: false, error: c.message, opKeyResult: "rejected", appliedCount };
    }
    if (c.outcome === "uncertain") {
      console.warn(
        `[inventory-count] inventorySetQuantities uncertain chunk=${ci + 1}/${total} issue=${c.idempotencyIssue ?? "none"}`
      );
      return { ok: false, error: c.message, opKeyResult: "uncertain", appliedCount, idempotencyIssue: c.idempotencyIssue };
    }
    appliedCount += chunk.length;
  }
  return { ok: true, invalidCount: invalidCount > 0 ? invalidCount : undefined, opKeyResult: "done", appliedCount };
}
