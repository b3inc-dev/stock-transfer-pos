/**
 * サーバー側で Shopify inventorySetQuantities を実行する共通ロジック
 * api.inventory.apply-change および app.inventory-count から利用
 * 失敗しないための追求: 429/5xx 時にリトライする。
 */

import type {
  GraphQLUserError,
  InventorySetQuantitiesJson,
  InventoryAdjustQuantitiesJson,
  QuantityNameValue,
} from "../types/graphql-responses";

const INVENTORY_SET_QUANTITIES_MAX = 250;

/** Shopify API 呼び出しの最大リトライ回数（一時的なレート制限・サーバーエラー対策） */
const SHOPIFY_API_RETRY_MAX = 3;
/** リトライ間隔（ミリ秒）。指数バックオフ 1s → 2s */
const SHOPIFY_API_RETRY_DELAY_MS = 1000;

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 503 || (status >= 500 && status < 600);
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export type AdminGraphql = (query: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response>;

/**
 * admin.graphql を 429/5xx 時にリトライして実行し、レスポンスと JSON を返す。
 */
async function graphqlWithRetry(
  admin: { graphql: AdminGraphql },
  query: string,
  variables?: Record<string, unknown>
): Promise<{ response: Response; json: unknown }> {
  let lastResp: Response | null = null;
  for (let attempt = 1; attempt <= SHOPIFY_API_RETRY_MAX; attempt++) {
    const response = await admin.graphql(query, { variables });
    lastResp = response;
    if (response.ok) {
      const json = await response.json().catch(() => ({}));
      return { response, json };
    }
    if (!isRetryableStatus(response.status) || attempt >= SHOPIFY_API_RETRY_MAX) {
      const json = await response.json().catch(() => ({}));
      return { response, json };
    }
    const waitMs = SHOPIFY_API_RETRY_DELAY_MS * Math.min(attempt, 2);
    console.warn(
      `[inventory-set-quantities-server] GraphQL attempt ${attempt}/${SHOPIFY_API_RETRY_MAX} failed (status=${response.status}), retrying in ${waitMs}ms`
    );
    await delay(waitMs);
  }
  const json = await lastResp?.json().catch(() => ({})) ?? {};
  return { response: lastResp!, json };
}

function toRawId(id: string | number | null | undefined): string {
  if (id == null) return "";
  const s = String(id).trim();
  if (s.startsWith("gid://")) {
    const last = s.split("/").pop();
    return last || s;
  }
  return s;
}

function toLocationGid(locationId: string): string {
  const s = String(locationId || "").trim();
  if (s.startsWith("gid://")) return s;
  const raw = toRawId(locationId);
  return raw ? `gid://shopify/Location/${raw}` : s;
}

function toInventoryItemGid(inventoryItemId: string): string | null {
  const str = String(inventoryItemId || "").trim();
  if (!str) return null;
  if (/^\d+$/.test(str)) return `gid://shopify/InventoryItem/${str}`;
  if (str.includes("gid://")) return str;
  return null;
}

/**
 * 指定チャンクの inventoryItemId について、locationId の現在の available 数量を一括取得する。
 * 返り値: quantities（取得成功分）と failedGids（取得失敗分）を分離して返す。
 * 失敗分を 0 にフォールバックしないことで、ロールバック時に在庫が誤って 0 にリセットされる
 * 問題を防ぐ。
 */
async function fetchChunkQuantities(
  admin: { graphql: AdminGraphql },
  locationGid: string,
  inventoryItemGids: string[]
): Promise<{ quantities: Map<string, number>; failedGids: string[] }> {
  const quantities = new Map<string, number>();
  const failedGids: string[] = [];
  // 1件ずつ取得（既存の fetchCurrentQuantityServer と同じ方式）
  for (const itemGid of inventoryItemGids) {
    try {
      const { json } = await graphqlWithRetry(admin, `#graphql
          query FetchQty($id: ID!, $loc: ID!) {
            inventoryItem(id: $id) {
              inventoryLevel(locationId: $loc) {
                quantities(names: ["available"]) { name quantity }
              }
            }
          }
        `, { id: itemGid, loc: locationGid });
      const quantitiesArr = (json as { data?: { inventoryItem?: { inventoryLevel?: { quantities?: QuantityNameValue[] } } } })?.data?.inventoryItem?.inventoryLevel?.quantities;
      const q = Array.isArray(quantitiesArr) ? quantitiesArr.find((x) => x?.name === "available") : null;
      if (q?.quantity != null) {
        quantities.set(itemGid, Number(q.quantity));
      } else {
        // inventoryLevel が未設定のアイテム（ロケーションに紐付いていない）は 0 として扱う
        quantities.set(itemGid, 0);
      }
    } catch {
      // ネットワーク障害等で取得不能な場合はロールバック不可として扱う
      failedGids.push(itemGid);
    }
  }
  return { quantities, failedGids };
}

/**
 * 在庫数を指定値に設定（inventorySetQuantities）。250件超はチャンク分割。
 * チャンク N が失敗した場合、適用済みチャンク 1..N-1 を元の数量に戻すロールバックを試みる。
 */
export async function setInventoryQuantitiesServer(
  admin: { graphql: AdminGraphql },
  locationId: string,
  items: Array<{ inventoryItemId: string; quantity: number }>,
  referenceDocumentUri?: string | null
): Promise<{ ok: boolean; invalidCount?: number; error?: string; rolledBack?: boolean; partiallyApplied?: boolean }> {
  const locationGid = toLocationGid(locationId);
  const quantities = (items ?? [])
    .filter((x) => x?.inventoryItemId && Number.isFinite(Number(x?.quantity)))
    .map((x) => {
      const gid = toInventoryItemGid(x.inventoryItemId);
      const quantity = Math.floor(Number(x.quantity) ?? 0);
      return gid ? { valid: true as const, inventoryItemId: gid, quantity, compareQuantity: 0 } : { valid: false as const };
    });
  const validQuantities = quantities.filter((q) => q.valid);
  const invalidCount = quantities.filter((q) => !q.valid).length;
  if (validQuantities.length === 0) {
    return { ok: false, invalidCount, error: "有効な在庫アイテムがありません" };
  }
  const refUri =
    referenceDocumentUri == null || referenceDocumentUri === ""
      ? undefined
      : String(referenceDocumentUri).trim().startsWith("gid://")
        ? referenceDocumentUri.trim()
        : `gid://stock-transfer-pos/InventoryCount/${referenceDocumentUri}`;

  // チャンクごとの適用前スナップショット（ロールバック用）
  // canRollback: false のチャンクが存在する場合はロールバックを中断し、呼び出し元に通知する
  const beforeStates: Array<{
    chunkIndex: number;
    quantities: Array<{ inventoryItemId: string; quantity: number }>;
    canRollback: boolean;
  }> = [];

  for (let i = 0; i < validQuantities.length; i += INVENTORY_SET_QUANTITIES_MAX) {
    const chunk = validQuantities.slice(i, i + INVENTORY_SET_QUANTITIES_MAX);
    const chunkIndex = Math.floor(i / INVENTORY_SET_QUANTITIES_MAX);

    // 適用前の数量を取得してスナップショットを保存
    const chunkItemGids = chunk.map((q) => q.inventoryItemId);
    const { quantities: beforeMap, failedGids } = await fetchChunkQuantities(admin, locationGid, chunkItemGids);
    if (failedGids.length > 0) {
      console.warn(
        `[inventory-set-quantities-server] チャンク${chunkIndex}のスナップショット取得失敗 (${failedGids.length}件): ${failedGids.join(", ")} ` +
        `― このチャンクが失敗した場合のロールバックは安全に実行できません`
      );
    }
    beforeStates.push({
      chunkIndex,
      quantities: chunkItemGids
        .filter((gid) => !failedGids.includes(gid))
        .map((gid) => ({ inventoryItemId: gid, quantity: beforeMap.get(gid) ?? 0 })),
      canRollback: failedGids.length === 0,
    });

    const input: Record<string, unknown> = {
      name: "available",
      reason: "correction",
      ignoreCompareQuantity: true,
      quantities: chunk.map((q) => ({
        inventoryItemId: q.inventoryItemId,
        locationId: locationGid,
        quantity: q.quantity,
        compareQuantity: q.compareQuantity,
      })),
    };
    if (refUri) input.referenceDocumentUri = refUri;

    let chunkFailed = false;
    let chunkError = "";
    try {
      const { response: resp, json } = await graphqlWithRetry(admin, `#graphql
          mutation InventorySetQuantities($input: InventorySetQuantitiesInput!) {
            inventorySetQuantities(input: $input) {
              inventoryAdjustmentGroup { id }
              userErrors { field message }
            }
          }
        `, { input });
      if (!resp.ok) {
        const errJson = json as InventorySetQuantitiesJson;
        chunkError = errJson?.errors?.[0]?.message ?? resp.statusText ?? `HTTP ${resp.status}`;
        chunkFailed = true;
      } else {
        const data = (json as InventorySetQuantitiesJson)?.data?.inventorySetQuantities;
        const errs = data?.userErrors ?? [];
        if (errs.length) {
          chunkError = errs.map((e: GraphQLUserError) => e.message ?? "").join(" / ");
          chunkFailed = true;
        }
      }
    } catch (e) {
      chunkError = e instanceof Error ? e.message : String(e);
      chunkFailed = true;
    }

    if (chunkFailed) {
      // チャンク N の失敗 — 適用済みチャンク（beforeStates の最後のエントリを除く）をロールバック
      const appliedSnapshots = beforeStates.slice(0, -1); // 現在のチャンクは適用されていないので除外
      if (appliedSnapshots.length === 0) {
        // 最初のチャンクが失敗 — ロールバック不要
        return { ok: false, error: chunkError, rolledBack: false };
      }

      // スナップショット取得が失敗していたチャンクがある場合、安全にロールバックできないため中断する
      const nonRollbackable = appliedSnapshots.filter((s) => !s.canRollback);
      if (nonRollbackable.length > 0) {
        const msg =
          `[inventory-set-quantities-server] チャンク${nonRollbackable.map((s) => s.chunkIndex).join(",")}の` +
          `スナップショット取得が失敗しているためロールバック不可 — 手動復旧が必要です。` +
          ` 元のエラー: ${chunkError}。` +
          ` スナップショット: ${JSON.stringify(appliedSnapshots)}`;
        console.error(msg);
        return { ok: false, error: chunkError, rolledBack: false, partiallyApplied: true };
      }

      let rollbackOk = true;
      let rollbackErrorMsg = "";
      // 逆順でロールバック
      for (let ri = appliedSnapshots.length - 1; ri >= 0; ri--) {
        const snapshot = appliedSnapshots[ri];
        const rollbackInput: Record<string, unknown> = {
          name: "available",
          reason: "correction",
          ignoreCompareQuantity: true,
          quantities: snapshot.quantities.map((q) => ({
            inventoryItemId: q.inventoryItemId,
            locationId: locationGid,
            quantity: q.quantity,
            compareQuantity: 0,
          })),
        };
        try {
          const { response: rbResp, json: rbJson } = await graphqlWithRetry(admin, `#graphql
              mutation InventorySetQuantities($input: InventorySetQuantitiesInput!) {
                inventorySetQuantities(input: $input) {
                  inventoryAdjustmentGroup { id }
                  userErrors { field message }
                }
              }
            `, { input: rollbackInput });
          if (!rbResp.ok) {
            rollbackOk = false;
            const rbErrJson = rbJson as InventorySetQuantitiesJson;
            rollbackErrorMsg = rbErrJson?.errors?.[0]?.message ?? rbResp.statusText ?? `HTTP ${rbResp.status}`;
          } else {
            const rbData = (rbJson as InventorySetQuantitiesJson)?.data?.inventorySetQuantities;
            const rbErrs = rbData?.userErrors ?? [];
            if (rbErrs.length) {
              rollbackOk = false;
              rollbackErrorMsg = rbErrs.map((e: GraphQLUserError) => e.message ?? "").join(" / ");
            }
          }
        } catch (rbErr) {
          rollbackOk = false;
          rollbackErrorMsg = rbErr instanceof Error ? rbErr.message : String(rbErr);
        }
        if (!rollbackOk) break;
      }
      if (!rollbackOk) {
        console.error(
          `[inventory-set-quantities-server] ロールバック失敗 — 手動復旧が必要です。` +
          ` 元のエラー: ${chunkError}。ロールバックエラー: ${rollbackErrorMsg}。` +
          ` スナップショット: ${JSON.stringify(appliedSnapshots)}`
        );
        return { ok: false, error: chunkError, rolledBack: false, partiallyApplied: true };
      }
      return { ok: false, error: chunkError, rolledBack: true };
    }
  }
  return { ok: true, invalidCount: invalidCount > 0 ? invalidCount : undefined, rolledBack: false };
}

/**
 * 1アイテム・1ロケーションの現在の available 数量を取得
 */
export async function fetchCurrentQuantityServer(
  admin: { graphql: AdminGraphql },
  locationId: string,
  inventoryItemId: string
): Promise<number> {
  const locationGid = toLocationGid(locationId);
  const itemGid = toInventoryItemGid(inventoryItemId);
  if (!itemGid) return 0;
  try {
    const { json } = await graphqlWithRetry(admin, `#graphql
        query Cur($id: ID!, $loc: ID!) {
          inventoryItem(id: $id) {
            inventoryLevel(locationId: $loc) {
              quantities(names: ["available"]) { name quantity }
            }
          }
        }
      `, { id: itemGid, loc: locationGid });
    const data = (json as { data?: { inventoryItem?: { inventoryLevel?: { quantities?: QuantityNameValue[] } } } })?.data?.inventoryItem?.inventoryLevel?.quantities;
    const q = Array.isArray(data) ? data.find((x) => x?.name === "available") : null;
    return Number(q?.quantity ?? 0) || 0;
  } catch {
    return 0;
  }
}

const INVENTORY_ADJUST_MAX = 250;

/**
 * 相対 delta で在庫を増減（inventoryAdjustQuantities）。ロス・仕入用。
 */
export async function adjustInventoryQuantitiesServer(
  admin: { graphql: AdminGraphql },
  locationId: string,
  changes: Array<{ inventoryItemId: string; delta: number }>,
  referenceDocumentUri?: string | null
): Promise<{ ok: boolean; invalidCount?: number; error?: string }> {
  const locationGid = toLocationGid(locationId);
  const valid = (changes ?? [])
    .filter((c) => c?.inventoryItemId && Number.isFinite(Number(c?.delta)) && Number(c.delta) !== 0)
    .map((c) => {
      const gid = toInventoryItemGid(c.inventoryItemId);
      return gid ? { inventoryItemId: gid, delta: Math.floor(Number(c.delta)) } : null;
    })
    .filter((x): x is { inventoryItemId: string; delta: number } => x != null);
  const invalidCount = (changes ?? []).length - valid.length;
  if (valid.length === 0) {
    // delta=0 のみ、または有効なアイテムが存在しない場合は変更なしで成功として扱う
    return { ok: true, invalidCount };
  }
  const uri = referenceDocumentUri
    ? (referenceDocumentUri.startsWith("gid://") ? referenceDocumentUri : `gid://stock-transfer-pos/LossEntry/${referenceDocumentUri}`)
    : undefined;
  for (let i = 0; i < valid.length; i += INVENTORY_ADJUST_MAX) {
    const chunk = valid.slice(i, i + INVENTORY_ADJUST_MAX);
    const input: Record<string, unknown> = {
      reason: "correction",
      name: "available",
      changes: chunk.map((c) => ({ inventoryItemId: c.inventoryItemId, locationId: locationGid, delta: c.delta })),
    };
    if (uri) input.referenceDocumentUri = uri;
    try {
      const { response: resp, json } = await graphqlWithRetry(admin, `#graphql
          mutation Adjust($input: InventoryAdjustQuantitiesInput!) {
            inventoryAdjustQuantities(input: $input) {
              inventoryAdjustmentGroup { id }
              userErrors { field message }
            }
          }
        `, { input });
      if (!resp.ok) {
        const errJson = json as InventoryAdjustQuantitiesJson;
        const errMsg = errJson?.errors?.[0]?.message ?? resp.statusText ?? `HTTP ${resp.status}`;
        return { ok: false, error: errMsg };
      }
      const adjustData = (json as InventoryAdjustQuantitiesJson)?.data?.inventoryAdjustQuantities;
      const errs = adjustData?.userErrors ?? [];
      if (errs.length) {
        return { ok: false, error: errs.map((e: GraphQLUserError) => e.message ?? "").join(" / ") };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
  }
  return { ok: true, invalidCount: invalidCount > 0 ? invalidCount : undefined };
}
