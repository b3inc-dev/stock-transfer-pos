/**
 * サーバー側で Shopify inventorySetQuantities を実行する共通ロジック
 * api.inventory.apply-change および app.inventory-count から利用
 * 失敗しないための追求: 429/5xx 時にリトライする。
 */

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
 * 在庫数を指定値に設定（inventorySetQuantities）。250件超はチャンク分割。
 */
export async function setInventoryQuantitiesServer(
  admin: { graphql: AdminGraphql },
  locationId: string,
  items: Array<{ inventoryItemId: string; quantity: number }>,
  referenceDocumentUri?: string | null
): Promise<{ ok: boolean; invalidCount?: number; error?: string }> {
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
  for (let i = 0; i < validQuantities.length; i += INVENTORY_SET_QUANTITIES_MAX) {
    const chunk = validQuantities.slice(i, i + INVENTORY_SET_QUANTITIES_MAX);
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
        const errMsg = (json as any)?.errors?.[0]?.message ?? resp.statusText ?? `HTTP ${resp.status}`;
        return { ok: false, error: errMsg };
      }
      const data = (json as any)?.data?.inventorySetQuantities;
      const errs = data?.userErrors ?? [];
      if (errs.length) {
        return { ok: false, error: errs.map((e: { message?: string }) => e.message).join(" / ") };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
  }
  return { ok: true, invalidCount: invalidCount > 0 ? invalidCount : undefined };
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
    const quantities = (json as any)?.data?.inventoryItem?.inventoryLevel?.quantities;
    const q = Array.isArray(quantities) ? quantities.find((x: { name?: string }) => x?.name === "available") : null;
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
    return { ok: false, invalidCount, error: "有効な変更がありません" };
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
        const errMsg = (json as any)?.errors?.[0]?.message ?? resp.statusText ?? `HTTP ${resp.status}`;
        return { ok: false, error: errMsg };
      }
      const data = (json as any)?.data?.inventoryAdjustQuantities;
      const errs = data?.userErrors ?? [];
      if (errs.length) {
        return { ok: false, error: errs.map((e: { message?: string }) => e.message).join(" / ") };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
  }
  return { ok: true, invalidCount: invalidCount > 0 ? invalidCount : undefined };
}
