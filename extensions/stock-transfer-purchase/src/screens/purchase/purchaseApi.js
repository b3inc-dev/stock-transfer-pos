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

// ---------- 仕入エントリ読み書き（管理画面と同じ metafield） ----------
export async function readPurchaseEntries() {
  const gql = `#graphql
    query PurchaseEntries {
      currentAppInstallation {
        id
        metafield(namespace: "${PURCHASE_NS}", key: "${PURCHASE_KEY}") { id value type }
      }
    }`;
  const d = await graphql(gql);
  const raw = d?.currentAppInstallation?.metafield?.value ?? "[]";
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export async function writePurchaseEntries(entries) {
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
  const res = await graphql(mutation, {
    metafields: [{
      ownerId,
      namespace: PURCHASE_NS,
      key: PURCHASE_KEY,
      type: "json",
      value: JSON.stringify(Array.isArray(entries) ? entries : []),
    }],
  });
  const errs = res?.metafieldsSet?.userErrors ?? [];
  if (errs.length) throw new Error(errs.map((e) => e.message).join(" / "));
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

export async function searchVariants(q, opts = {}) {
  const includeImages = opts?.includeImages !== false;
  const firstRaw = Number(opts?.first ?? opts?.limit ?? 50);
  const first = Math.max(10, Math.min(50, Number.isFinite(firstRaw) ? firstRaw : 50));
  const query = buildVariantSearchQuery(q);
  if (!query) return [];

  const nodesQuery = includeImages
    ? `nodes { id title sku barcode image { url } inventoryItem { id } product { title featuredImage { url } } }`
    : `nodes { id title sku barcode inventoryItem { id } product { title } }`;
  const gql = `#graphql
    query GetVariants($first: Int!, $query: String!) {
      productVariants(first: $first, query: $query) { ${nodesQuery} }
    }`;
  const d = await graphql(gql, { first, query });
  const nodes = d?.productVariants?.nodes ?? [];
  return nodes.map((n) => ({
    variantId: n.id,
    inventoryItemId: n.inventoryItem?.id,
    productTitle: n.product?.title ?? "",
    variantTitle: n.title ?? "",
    sku: n.sku ?? "",
    barcode: n.barcode ?? "",
    imageUrl: n.image?.url ?? n.product?.featuredImage?.url ?? "",
  }));
}

export async function resolveVariantByCode(codeRaw, opts = {}) {
  const code = String(codeRaw ?? "").trim().replace(/\s+/g, "").toUpperCase();
  if (!code) return null;
  const list = await searchVariants(code, { includeImages: opts?.includeImages !== false });
  const v = list.find((x) => x.barcode === code || x.sku === code) || list[0];
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

