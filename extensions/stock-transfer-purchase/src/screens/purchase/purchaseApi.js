// 仕入用API（拡張内で完結。出庫 orderApi と同じ構成）
const PURCHASE_NS = "stock_transfer_pos";
const PURCHASE_KEY = "purchase_entries_v1";

const SHOPIFY = globalThis?.shopify ?? {};

async function graphql(query, variables, opts = {}) {
  const cleanQuery = String(query || "").replace(/^#graphql\s*/m, "").trim();
  const timeoutMs = Number.isFinite(Number(opts?.timeoutMs)) ? Number(opts.timeoutMs) : 20000;
  const controller = new AbortController();
  let done = false;
  let iv = null;
  const timeoutPromise = new Promise((_, reject) => {
    const start = Date.now();
    iv = setInterval(() => {
      if (done) return;
      if (Date.now() - start >= timeoutMs) {
        try {
          controller.abort();
        } catch {}
        reject(new Error(`timeout ${timeoutMs}ms`));
      }
    }, 200);
  });
  const fetchPromise = (async () => {
    const res = await fetch("shopify:admin/api/graphql.json", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: cleanQuery, variables }),
      signal: controller.signal,
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
    }
    const json = text ? JSON.parse(text) : {};
    if (json.errors?.length) throw new Error(JSON.stringify(json.errors));
    return json.data;
  })();
  try {
    return await Promise.race([fetchPromise, timeoutPromise]);
  } finally {
    done = true;
    if (iv) clearInterval(iv);
  }
}

export function readValue(e) {
  return String(
    (e && e.currentTarget && "value" in e.currentTarget && e.currentTarget.value) ??
      (e && e.target && "value" in e.target && e.target.value) ??
      e?.currentValue?.value ??
      ""
  );
}

export async function fetchLocations() {
  const gql = `#graphql
    query Locations($first: Int!) {
      locations(first: $first) { nodes { id name } }
    }`;
  const d = await graphql(gql, { first: 250 });
  return d?.locations?.nodes ?? [];
}

// 設定は既存の settings_v1 を流用（carriers / purchase.suppliers を参照）
const SETTINGS_NS = "stock_transfer_pos";
const SETTINGS_KEY = "settings_v1";

export async function fetchSettings() {
  const gql = `#graphql
    query Settings {
      currentAppInstallation {
        metafield(namespace: "${SETTINGS_NS}", key: "${SETTINGS_KEY}") { value type }
      }
    }`;
  try {
    const data = await graphql(gql);
    const raw = data?.currentAppInstallation?.metafield?.value ?? null;
    if (!raw) return { version: 1, carriers: [], purchase: { suppliers: [] } };
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === 1) {
      return parsed;
    }
    return { version: 1, carriers: [], purchase: { suppliers: [] } };
  } catch (e) {
    console.error("[purchaseApi.fetchSettings] error:", e);
    return { version: 1, carriers: [], purchase: { suppliers: [] } };
  }
}

// ---------- 仕入エントリ読み書き（v2: チャンク分割取得） ----------
const PURCHASE_V2_META_KEY = "purchase_entries_v2_meta";
const PURCHASE_V2_CHUNK_PREFIX = "purchase_entries_v2_";
const CHUNK_SIZE_DEFAULT = 100;
const METAFIELDS_SET_MAX = 25;

async function getPurchaseChunkSize() {
  const settings = await fetchSettings();
  const n = Number(settings?.outbound?.historyInitialLimit ?? CHUNK_SIZE_DEFAULT);
  return Math.max(1, Math.min(250, n));
}

async function readPurchaseManifest() {
  const gql = `#graphql
    query PurchaseMeta {
      currentAppInstallation {
        metafield(namespace: "${PURCHASE_NS}", key: "${PURCHASE_V2_META_KEY}") { value }
      }
    }`;
  const d = await graphql(gql);
  const raw = d?.currentAppInstallation?.metafield?.value;
  if (raw == null || raw === "") return null;
  try {
    const o = JSON.parse(raw);
    if (o && typeof o.chunkSize === "number" && typeof o.chunkCount === "number") return o;
  } catch {}
  return null;
}

async function migratePurchaseV1ToV2() {
  const gqlV1 = `#graphql
    query PurchaseV1 {
      currentAppInstallation {
        id
        metafield(namespace: "${PURCHASE_NS}", key: "${PURCHASE_KEY}") { id value type }
      }
    }`;
  const d = await graphql(gqlV1);
  const raw = d?.currentAppInstallation?.metafield?.value ?? "[]";
  let arr = [];
  try {
    const parsed = JSON.parse(raw);
    arr = Array.isArray(parsed) ? parsed : [];
  } catch {
    arr = [];
  }
  const chunkSize = await getPurchaseChunkSize();
  const chunks = [];
  for (let i = 0; i < arr.length; i += chunkSize) {
    chunks.push(arr.slice(i, i + chunkSize));
  }
  if (chunks.length === 0) chunks.push([]);
  const ownerId = d?.currentAppInstallation?.id;
  if (!ownerId) throw new Error("currentAppInstallation.id が取得できません");
  const mutation = `#graphql
    mutation SetPurchaseChunks($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id namespace key }
        userErrors { field message }
      }
    }`;
  const metaValue = JSON.stringify({ chunkSize, chunkCount: chunks.length });
  const metafields = [
    { ownerId, namespace: PURCHASE_NS, key: PURCHASE_V2_META_KEY, type: "json", value: metaValue },
    ...chunks.map((chunk, i) => ({
      ownerId,
      namespace: PURCHASE_NS,
      key: `${PURCHASE_V2_CHUNK_PREFIX}${i}`,
      type: "json",
      value: JSON.stringify(chunk),
    })),
  ];
  for (let off = 0; off < metafields.length; off += METAFIELDS_SET_MAX) {
    const batch = metafields.slice(off, off + METAFIELDS_SET_MAX);
    const res = await graphql(mutation, { metafields: batch });
    const errs = res?.metafieldsSet?.userErrors ?? [];
    if (errs.length) throw new Error(errs.map((e) => e.message).join(" / "));
  }
}

export async function readPurchaseEntriesFirstPage() {
  let manifest = await readPurchaseManifest();
  if (!manifest) {
    await migratePurchaseV1ToV2();
    manifest = await readPurchaseManifest();
  }
  if (!manifest || manifest.chunkCount === 0) {
    return { entries: [], hasMore: false, chunkCount: 0 };
  }
  const chunkKey0 = `${PURCHASE_V2_CHUNK_PREFIX}0`;
  const gql = `#graphql
    query PurchaseFirstPage {
      currentAppInstallation {
        meta: metafield(namespace: "${PURCHASE_NS}", key: "${PURCHASE_V2_META_KEY}") { value }
        chunk0: metafield(namespace: "${PURCHASE_NS}", key: "${chunkKey0}") { value }
      }
    }`;
  const data = await graphql(gql);
  const chunkRaw = data?.currentAppInstallation?.chunk0?.value ?? "[]";
  try {
    const entries = JSON.parse(chunkRaw);
    const list = Array.isArray(entries) ? entries : [];
    return { entries: list, hasMore: manifest.chunkCount > 1, chunkCount: manifest.chunkCount };
  } catch {
    return { entries: [], hasMore: false, chunkCount: manifest.chunkCount };
  }
}

export async function readPurchaseEntriesPage(pageIndex) {
  const manifest = await readPurchaseManifest();
  if (!manifest || pageIndex < 0 || pageIndex >= manifest.chunkCount) return { entries: [] };
  const key = `${PURCHASE_V2_CHUNK_PREFIX}${pageIndex}`;
  const gql = `#graphql
    query PurchaseChunk($key: String!) {
      currentAppInstallation {
        metafield(namespace: "${PURCHASE_NS}", key: $key) { value }
      }
    }`;
  const d = await graphql(gql, { key });
  const raw = d?.currentAppInstallation?.metafield?.value ?? "[]";
  try {
    const arr = JSON.parse(raw);
    return { entries: Array.isArray(arr) ? arr : [] };
  } catch {
    return { entries: [] };
  }
}

export async function readPurchaseEntriesFull() {
  let manifest = await readPurchaseManifest();
  if (!manifest) {
    await migratePurchaseV1ToV2();
    manifest = await readPurchaseManifest();
  }
  if (!manifest || manifest.chunkCount === 0) return [];
  const all = [];
  for (let i = 0; i < manifest.chunkCount; i++) {
    const key = `${PURCHASE_V2_CHUNK_PREFIX}${i}`;
    const gql = `#graphql query PurchaseChunk($key: String!) { currentAppInstallation { metafield(namespace: "${PURCHASE_NS}", key: $key) { value } } }`;
    const d = await graphql(gql, { key });
    const raw = d?.currentAppInstallation?.metafield?.value ?? "[]";
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) all.push(...arr);
    } catch {}
  }
  return all;
}

export async function readPurchaseEntries() {
  return readPurchaseEntriesFull();
}

export async function writePurchaseEntries(entries) {
  const arr = Array.isArray(entries) ? entries : [];
  const chunkSize = await getPurchaseChunkSize();
  const chunks = [];
  for (let i = 0; i < arr.length; i += chunkSize) {
    chunks.push(arr.slice(i, i + chunkSize));
  }
  if (chunks.length === 0) chunks.push([]);
  const gqlApp = `#graphql query AppId { currentAppInstallation { id } }`;
  const d = await graphql(gqlApp);
  const ownerId = d?.currentAppInstallation?.id;
  if (!ownerId) throw new Error("currentAppInstallation.id が取得できません");
  const mutation = `#graphql
    mutation SetPurchase($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id namespace key }
        userErrors { field message }
      }
    }`;
  const metaValue = JSON.stringify({ chunkSize, chunkCount: chunks.length });
  const metafields = [
    { ownerId, namespace: PURCHASE_NS, key: PURCHASE_V2_META_KEY, type: "json", value: metaValue },
    ...chunks.map((chunk, i) => ({
      ownerId,
      namespace: PURCHASE_NS,
      key: `${PURCHASE_V2_CHUNK_PREFIX}${i}`,
      type: "json",
      value: JSON.stringify(chunk),
    })),
  ];
  for (let off = 0; off < metafields.length; off += METAFIELDS_SET_MAX) {
    const batch = metafields.slice(off, off + METAFIELDS_SET_MAX);
    const res = await graphql(mutation, { metafields: batch });
    const errs = res?.metafieldsSet?.userErrors ?? [];
    if (errs.length) throw new Error(errs.map((e) => e.message).join(" / "));
  }
}

// ---------- GID 変換・在庫調整（ロスと同型、delta は正で入庫） ----------
function toLocationGid(s) {
  if (!s) return null;
  const str = String(s).trim();
  if (str.startsWith("gid://shopify/Location/")) return str;
  if (/^\d+$/.test(str)) return `gid://shopify/Location/${str}`;
  if (str.includes("gid://")) return str;
  return null;
}

function toInventoryItemGid(s) {
  if (!s) return null;
  const str = String(s).trim();
  if (str.startsWith("gid://shopify/InventoryItem/")) return str;
  if (/^\d+$/.test(str)) return `gid://shopify/InventoryItem/${str}`;
  if (str.includes("gid://")) return str;
  return null;
}

export async function adjustInventoryAtLocation({ locationId, deltas, referenceDocumentUri }) {
  const changes = (deltas ?? [])
    .map((x) => {
      const inventoryItemGid = toInventoryItemGid(x?.inventoryItemId);
      if (!inventoryItemGid || Number(x?.delta || 0) === 0) return null;
      return { inventoryItemId: inventoryItemGid, delta: Number(x.delta) };
    })
    .filter((x) => x !== null);

  if (!locationId || changes.length === 0) {
    if (changes.length === 0 && (deltas ?? []).length > 0) throw new Error("有効な在庫アイテムIDがありません");
    return null;
  }

  const locationGid = toLocationGid(locationId);
  if (!locationGid) throw new Error(`無効なロケーションID: ${locationId}`);

  const uri = referenceDocumentUri ? `gid://stock-transfer-pos/PurchaseEntry/${referenceDocumentUri}` : null;
  const input = {
    reason: "correction",
    name: "available",
    changes: changes.map((c) => ({
      inventoryItemId: c.inventoryItemId,
      locationId: locationGid,
      delta: c.delta,
    })),
  };
  if (uri) input.referenceDocumentUri = uri;

  const m1 = `#graphql
    mutation Adjust($input: InventoryAdjustQuantitiesInput!) {
      inventoryAdjustQuantities(input: $input) {
        inventoryAdjustmentGroup { id }
        userErrors { field message }
      }
    }`;
  const d1 = await graphql(m1, { input });
  if (!d1?.inventoryAdjustQuantities) throw new Error("GraphQL response is invalid");
  const errs = d1.inventoryAdjustQuantities.userErrors ?? [];
  if (errs.length) throw new Error(errs.map((e) => e.message).join(" / "));
  return d1.inventoryAdjustQuantities.inventoryAdjustmentGroup ?? null;
}

// ---------- バリアント検索・スキャン解決（拡張内完結） ----------
function buildVariantSearchQuery(raw) {
  const q = String(raw || "").trim();
  if (!q) return "";
  const isDigitsOnly = /^\d+$/.test(q);
  const hasAlpha = /[A-Za-z]/.test(q);
  const hasSkuLikeSymbol = /[-_./]/.test(q);
  const parts = [];
  if (isDigitsOnly) {
    if (q.length >= 8) parts.push(`barcode:${q}`);
    else parts.push(q);
  }
  if (hasAlpha || hasSkuLikeSymbol) parts.push(`sku:${q}`);
  parts.push(q);
  return Array.from(new Set(parts)).join(" OR ");
}

// ✅ 戻り値: { nodes, pageInfo }。呼び出し側は result.nodes を使用
export async function searchVariants(q, opts = {}) {
  const includeImages = opts?.includeImages !== false;
  const after = opts?.after ?? null;
  const firstRaw = Number(opts?.first ?? opts?.limit ?? 50);
  const first = Math.max(10, Math.min(250, Number.isFinite(firstRaw) ? firstRaw : 50));
  const query = buildVariantSearchQuery(q);
  if (!query) return { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };

  const nodesQuery = includeImages
    ? `nodes { id title sku barcode image { url } inventoryItem { id } product { title featuredImage { url } } }`
    : `nodes { id title sku barcode inventoryItem { id } product { title } }`;
  const gql = `#graphql
    query GetVariants($first: Int!, $query: String!, $after: String) {
      productVariants(first: $first, query: $query, after: $after) { ${nodesQuery} pageInfo { hasNextPage endCursor } }
    }`;
  const variables = { first, query };
  if (after) variables.after = after;
  const d = await graphql(gql, variables);
  const conn = d?.productVariants ?? {};
  const nodes = (conn.nodes ?? []).map((n) => ({
    variantId: n.id,
    inventoryItemId: n.inventoryItem?.id,
    productTitle: n.product?.title ?? "",
    variantTitle: n.title ?? "",
    sku: n.sku ?? "",
    barcode: n.barcode ?? "",
    imageUrl: n.image?.url ?? n.product?.featuredImage?.url ?? "",
  }));
  const pageInfo = conn.pageInfo ?? { hasNextPage: false, endCursor: null };
  return { nodes, pageInfo };
}

export async function resolveVariantByCode(codeRaw, opts = {}) {
  const code = String(codeRaw ?? "").trim().replace(/\s+/g, "").toUpperCase();
  if (!code) return null;
  const { nodes } = await searchVariants(code, { includeImages: opts?.includeImages !== false });
  const v = nodes.find((x) => x.barcode === code || x.sku === code) || nodes[0];
  return v ?? null;
}

export async function fetchVariantAvailable({ variantGid, locationGid }) {
  const query = `#graphql
    query VariantInv($variantId: ID!, $locationId: ID!) {
      productVariant(id: $variantId) {
        inventoryItem {
          id
          inventoryLevel(locationId: $locationId) {
            quantities(names: ["available"]) { name quantity }
          }
        }
      }
    }`;
  const data = await graphql(query, { variantId: variantGid, locationId: locationGid });
  const level = data?.productVariant?.inventoryItem?.inventoryLevel;
  const available = level?.quantities?.find((x) => x.name === "available")?.quantity ?? null;
  return { inventoryItemId: data?.productVariant?.inventoryItem?.id, available };
}

export async function fetchVariantImage(variantId) {
  if (!variantId) return "";
  const gql = `#graphql
    query GetVariantImage($id: ID!) {
      productVariant(id: $id) {
        id
        image { url }
        product { featuredImage { url } }
      }
    }`;
  try {
    const data = await graphql(gql, { id: variantId });
    return data?.productVariant?.image?.url || data?.productVariant?.product?.featuredImage?.url || "";
  } catch {
    return "";
  }
}

