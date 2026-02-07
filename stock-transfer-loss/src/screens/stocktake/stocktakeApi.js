const NS = "stock_transfer_pos";
const PRODUCT_GROUPS_KEY = "product_groups_v1";
const INVENTORY_COUNTS_KEY = "inventory_counts_v1";
const SHOPIFY = globalThis?.shopify ?? {};

async function graphql(query, variables, opts = {}) {
  // #graphqlコメントを削除（GraphQLクエリから除外）
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
        try { controller.abort(); } catch {}
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
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
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

function buildVariantSearchQuery(raw) {
  const q = String(raw || "").trim();
  if (!q) return "";
  const isDigitsOnly = /^\d+$/.test(q);
  const hasAlpha = /[A-Za-z]/.test(q);
  const hasSkuLike = /[-_./]/.test(q);
  const parts = [];
  if (isDigitsOnly && q.length >= 8) parts.push(`barcode:${q}`);
  else if (isDigitsOnly) parts.push(q);
  if (hasAlpha || hasSkuLike) parts.push(`sku:${q}`);
  parts.push(q);
  return [...new Set(parts)].join(" OR ");
}

// コード正規化（JAN/SKU 共通）
function normalizeScanCode_(code) {
  const s = String(code ?? "").trim();
  if (!s) return "";
  // 改行や空白は落とす、英字は大文字
  // SKUにハイフン等がある想定で「英数+._-」は残す
  return s
    .replace(/\s+/g, "")
    .toUpperCase()
    .replace(/[^0-9A-Z._-]/g, "");
}

export async function searchVariants(q, opts = {}) {
  const includeImages = opts?.includeImages !== false;
  const first = Math.max(10, Math.min(50, Number(opts?.first) || 50));
  const query = buildVariantSearchQuery(q);
  if (!query) return [];

  // 画像不要なら最初から軽量クエリへ
  if (!includeImages) {
    const gql = `#graphql
      query GetVariants($first: Int!, $query: String!) {
        productVariants(first: $first, query: $query) {
          nodes { id title sku barcode inventoryItem { id } product { title } }
        }
      }`;
    const data = await graphql(gql, { first, query });
    const nodes = data?.productVariants?.nodes ?? [];
    return nodes.map((n) => ({
      variantId: n.id,
      inventoryItemId: n.inventoryItem?.id,
      productTitle: n.product?.title ?? "",
      variantTitle: n.title ?? "",
      sku: n.sku ?? "",
      barcode: n.barcode ?? "",
      imageUrl: "",
    }));
  }

  // 画像あり
  try {
    const gql = `#graphql
      query GetVariants($first: Int!, $query: String!) {
        productVariants(first: $first, query: $query) {
          nodes {
            id
            title
            sku
            barcode
            image { url }
            inventoryItem { id }
            product {
              title
              featuredImage { url }
            }
          }
        }
      }`;
    const data = await graphql(gql, { first, query });
    const nodes = data?.productVariants?.nodes ?? [];
    return nodes.map((n) => ({
      variantId: n.id,
      inventoryItemId: n.inventoryItem?.id,
      productTitle: n.product?.title ?? "",
      variantTitle: n.title ?? "",
      sku: n.sku ?? "",
      barcode: n.barcode ?? "",
      imageUrl: n.image?.url ?? n.product?.featuredImage?.url ?? "",
    }));
  } catch (e) {
    // フォールバック: 画像なしで再試行
    const gql = `#graphql
      query GetVariants($first: Int!, $query: String!) {
        productVariants(first: $first, query: $query) {
          nodes { id title sku barcode inventoryItem { id } product { title } }
        }
      }`;
    const data = await graphql(gql, { first, query });
    const nodes = data?.productVariants?.nodes ?? [];
    return nodes.map((n) => ({
      variantId: n.id,
      inventoryItemId: n.inventoryItem?.id,
      productTitle: n.product?.title ?? "",
      variantTitle: n.title ?? "",
      sku: n.sku ?? "",
      barcode: n.barcode ?? "",
      imageUrl: "",
    }));
  }
}

export async function readInventoryCounts() {
  const gql = `#graphql
    query InventoryCounts {
      currentAppInstallation {
        id
        metafield(namespace: "${NS}", key: "${INVENTORY_COUNTS_KEY}") { id value type }
      }
    }`;
  const d = await graphql(gql);
  const raw = d?.currentAppInstallation?.metafield?.value ?? "[]";
  try {
    const arr = JSON.parse(raw);
    const counts = Array.isArray(arr) ? arr : [];
    
    // ✅ 既存データにcountNameがない場合、生成して付与
    const hasMissingCountName = counts.some((c) => !c.countName);
    
    // ✅ 完了判定を修正：全グループが完了している場合のみ完了ステータスにする
    let needsUpdate = false;
    const countsFixed = counts.map((c) => {
      const allIds = Array.isArray(c.productGroupIds) && c.productGroupIds.length > 0
        ? c.productGroupIds
        : c.productGroupId ? [c.productGroupId] : [];
      
      if (allIds.length === 0) {
        // 商品グループがない場合は既存のステータスを保持
        return c;
      }
      
      const groupItemsMap = c?.groupItems && typeof c.groupItems === "object" ? c.groupItems : {};
      // ✅ 全グループが完了しているか判定：groupItems[id]が存在し、かつ配列の長さが0より大きい
      const allDone = allIds.every((id) => {
        const items = groupItemsMap[id];
        return Array.isArray(items) && items.length > 0;
      });
      
      // ✅ 商品グループが1つの場合のみ、古いデータ形式（itemsフィールド）を後方互換性として使用
      // ✅ 複数商品グループがある場合は、必ずgroupItemsで判定する（itemsは使用しない）
      const isSingleGroup = allIds.length === 1;
      const hasItems = Array.isArray(c.items) && c.items.length > 0;
      const hasNoGroupItems = Object.keys(groupItemsMap).length === 0;
      const isCompleted = allDone || (isSingleGroup && hasItems && hasNoGroupItems);
      
      // ✅ 全グループが完了していない場合は必ず"in_progress"に設定（既存のstatusを保持しない）
      if (!isCompleted && c.status === "completed") {
        needsUpdate = true;
        return {
          ...c,
          status: "in_progress",
          completedAt: undefined,
        };
      }
      
      // ✅ 全グループが完了している場合は"completed"に設定
      if (isCompleted && c.status !== "completed") {
        needsUpdate = true;
        return {
          ...c,
          status: "completed",
          completedAt: c.completedAt || new Date().toISOString(),
        };
      }
      
      return c;
    });
    
    // 作成日時順にソートして連番を振る
    const sortedCounts = [...countsFixed].sort((a, b) => {
      const aTime = new Date(a.createdAt || 0).getTime();
      const bTime = new Date(b.createdAt || 0).getTime();
      return aTime - bTime;
    });
    
    const countsWithName = countsFixed.map((c) => {
      if (c.countName) return c; // 既にcountNameがある場合はそのまま
      const sortedIndex = sortedCounts.findIndex((x) => x.id === c.id);
      const countName = `#C${String((sortedIndex >= 0 ? sortedIndex : 0) + 1).padStart(4, "0")}`;
      return { ...c, countName };
    });
    
    // ✅ countNameが追加された場合、またはステータスが修正された場合は保存（次回から反映される）
    if (hasMissingCountName || needsUpdate) {
      try {
        await writeInventoryCounts(countsWithName);
      } catch (e) {
        console.error("Failed to update inventory counts:", e);
        // エラー時もcountsWithNameを返す（表示は反映される）
      }
    }
    
    return countsWithName;
  } catch {
    return [];
  }
}

export async function writeInventoryCounts(counts) {
  const gqlApp = `#graphql query AppId { currentAppInstallation { id } }`;
  const d = await graphql(gqlApp);
  const ownerId = d?.currentAppInstallation?.id;
  if (!ownerId) throw new Error("currentAppInstallation.id が取得できません");
  const mutation = `#graphql
    mutation SetInventoryCounts($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id namespace key }
        userErrors { field message }
      }
    }`;
  const res = await graphql(mutation, {
    metafields: [{
      ownerId,
      namespace: NS,
      key: INVENTORY_COUNTS_KEY,
      type: "json",
      value: JSON.stringify(Array.isArray(counts) ? counts : []),
    }],
  });
  const errs = res?.metafieldsSet?.userErrors ?? [];
  if (errs.length) throw new Error(errs.map((e) => e.message).join(" / "));
}

export async function readProductGroups() {
  const gql = `#graphql
    query ProductGroups {
      currentAppInstallation {
        id
        metafield(namespace: "${NS}", key: "${PRODUCT_GROUPS_KEY}") { id value type }
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

// 商品グループに含まれる商品を取得（コレクションから）
// 単一商品グループ用（後方互換性のため残す）
export async function fetchProductsByGroup(productGroupId, locationId) {
  return fetchProductsByGroups([productGroupId], locationId);
}

// 複数商品グループに含まれる商品を取得（コレクションから）
// locationIdが指定されている場合、在庫レベルがある商品のみを返す（初期表示用）
// ✅ inventoryItemIdsByGroupが指定されている場合は、それを使用して商品をフィルタリング（生成時の状態を保持）
export async function fetchProductsByGroups(productGroupIds, locationId, opts = {}) {
  const { filterByInventoryLevel = true, includeImages = false, inventoryItemIdsByGroup = null } = opts;
  const groups = await readProductGroups();
  const targetGroups = groups.filter((g) => Array.isArray(productGroupIds) && productGroupIds.includes(g.id));
  if (targetGroups.length === 0) return [];

  const allVariants = [];
  for (const group of targetGroups) {
    // ✅ inventoryItemIdsByGroupが指定されている場合は、それを使用（生成時の状態を保持）
    const savedInventoryItemIds = inventoryItemIdsByGroup?.[group.id];
    if (savedInventoryItemIds && Array.isArray(savedInventoryItemIds) && savedInventoryItemIds.length > 0) {
      // ✅ 保存されたinventoryItemIdsを使用して商品を取得（GraphQLで直接取得）
      // ✅ 保存されたinventoryItemIdsを使用して商品を取得
      // ✅ inventoryItemからvariantを取得するため、バッチで取得
      const batchSize = 50;
      for (let i = 0; i < savedInventoryItemIds.length; i += batchSize) {
        const batch = savedInventoryItemIds.slice(i, i + batchSize);
        const gql = includeImages
          ? `#graphql
            query InventoryItems($ids: [ID!]!) {
              nodes(ids: $ids) {
                ... on InventoryItem {
                  id
                  variant {
                    id
                    title
                    sku
                    barcode
                    image { url }
                    product {
                      title
                      featuredImage { url }
                    }
                  }
                }
              }
            }`
          : `#graphql
            query InventoryItems($ids: [ID!]!) {
              nodes(ids: $ids) {
                ... on InventoryItem {
                  id
                  variant {
                    id
                    title
                    sku
                    barcode
                    product {
                      title
                    }
                  }
                }
              }
            }`;
        try {
          const data = await graphql(gql, { ids: batch });
          const nodes = data?.nodes ?? [];
          for (const node of nodes) {
            if (node?.variant && node.id) {
              const v = node.variant;
              const p = v.product || {};
              allVariants.push({
                variantId: v.id,
                inventoryItemId: node.id,
                productTitle: p.title ?? "",
                variantTitle: v.title ?? "",
                sku: v.sku ?? "",
                barcode: v.barcode ?? "",
                imageUrl: includeImages ? (v.image?.url ?? p.featuredImage?.url ?? "") : "",
              });
            }
          }
        } catch (e) {
          console.error(`InventoryItems fetch error for group ${group.id} (batch ${i}-${i + batch.length}):`, e);
          // エラー時は通常の処理にフォールバック（コレクションから取得）
        }
      }
      continue; // ✅ 保存されたinventoryItemIdsを使用した場合は、通常のコレクション取得処理をスキップ
    }
    
    // ✅ 通常の処理：コレクションから商品を取得
    if (!group.collectionIds?.length) continue;
    for (const collectionId of group.collectionIds) {
      // ✅ collectionConfigsからselectedVariantIdsを取得
      const collectionConfig = group.collectionConfigs?.find((c) => c.collectionId === collectionId);
      const selectedVariantIds = collectionConfig?.selectedVariantIds || [];
      // ✅ selectedVariantIdsが空の場合は全選択（既存の動作を維持）
      const shouldFilterBySelected = selectedVariantIds.length > 0;
      
      const gql = includeImages
        ? `#graphql
          query CollectionProducts($id: ID!, $first: Int!) {
            collection(id: $id) {
              products(first: $first) {
                nodes {
                  title
                  featuredImage { url }
                  variants(first: 250) {
                    nodes {
                      id
                      title
                      sku
                      barcode
                      image { url }
                      inventoryItem { id }
                    }
                  }
                }
              }
            }
          }`
        : `#graphql
          query CollectionProducts($id: ID!, $first: Int!) {
            collection(id: $id) {
              products(first: $first) {
                nodes {
                  title
                  variants(first: 250) {
                    nodes {
                      id
                      title
                      sku
                      barcode
                      inventoryItem { id }
                    }
                  }
                }
              }
            }
          }`;
      try {
        const productFirst = Math.max(1, Math.min(250, Number(opts?.productFirst ?? opts?.initialLimit ?? 250)));
        const data = await graphql(gql, { id: collectionId, first: productFirst });
        const products = data?.collection?.products?.nodes ?? [];
        for (const p of products) {
          const variants = p.variants?.nodes ?? [];
          for (const v of variants) {
            if (v.inventoryItem?.id) {
              // ✅ selectedVariantIdsが指定されている場合は、選択されたバリアントのみを追加
              if (shouldFilterBySelected && !selectedVariantIds.includes(v.id)) {
                continue; // 選択されていないバリアントはスキップ
              }
              allVariants.push({
                variantId: v.id,
                inventoryItemId: v.inventoryItem.id,
                productTitle: p.title ?? "",
                variantTitle: v.title ?? "",
                sku: v.sku ?? "",
                barcode: v.barcode ?? "",
                imageUrl: includeImages ? (v.image?.url ?? p.featuredImage?.url ?? "") : "",
              });
            }
          }
        }
      } catch (e) {
        console.error(`Collection ${collectionId} fetch error:`, e);
      }
    }
  }

  // 重複除去
  const seen = new Set();
  let uniqueVariants = allVariants.filter((v) => {
    const key = v.inventoryItemId;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // 在庫レベルでフィルタリング（初期表示用）
  if (filterByInventoryLevel && locationId && uniqueVariants.length > 0) {
    const variantsWithInventory = [];
    for (const v of uniqueVariants) {
      try {
        const qty = await getCurrentQuantity(v.inventoryItemId, locationId);
        // 在庫レベルが存在する（0以上）商品のみを返す
        if (qty !== null && qty !== undefined) {
          variantsWithInventory.push(v);
        }
      } catch (e) {
        // エラー時はスキップ（在庫レベルがない商品として扱う）
        console.error(`Failed to get inventory level for ${v.inventoryItemId}:`, e);
      }
    }
    return variantsWithInventory;
  }

  return uniqueVariants;
}

// 現在の在庫数を取得
// 在庫レベルが存在しない場合はnullを返す（在庫レベルがない商品の判定用）
export async function getCurrentQuantity(inventoryItemId, locationId, opts = {}) {
  // ✅ キャッシュを無効化するために、タイムスタンプを変数に追加（オプション）
  const cacheBuster = opts?.noCache ? `_${Date.now()}` : "";
  const gql = `#graphql
    query CurrentQuantity${cacheBuster}($id: ID!, $loc: ID!) {
      inventoryItem(id: $id) {
        inventoryLevel(locationId: $loc) {
          quantities(names: ["available"]) { name quantity }
        }
      }
    }`;
  try {
    const d = await graphql(gql, { id: inventoryItemId, loc: locationId });
    const level = d?.inventoryItem?.inventoryLevel;
    if (!level) return null; // 在庫レベルが存在しない
    const qty = level.quantities?.find((x) => x.name === "available")?.quantity;
    return qty !== null && qty !== undefined ? Number(qty) : 0;
  } catch (e) {
    // エラー時はnullを返す（在庫レベルがない商品として扱う）
    return null;
  }
}

// locationIdをGID形式に変換（ロスと同じ処理）
function toLocationGid(s) {
  if (!s) return null;
  const str = String(s).trim();
  if (str.startsWith("gid://shopify/Location/")) return str;
  // 数字だけならGID化
  if (/^\d+$/.test(str)) return `gid://shopify/Location/${str}`;
  // 既にGID形式の可能性がある場合はそのまま
  if (str.includes("gid://")) return str;
  return null;
}

// inventoryItemIdをGID形式に変換（ロスと同じ処理）
function toInventoryItemGid(s) {
  if (!s) return null;
  const str = String(s).trim();
  if (str.startsWith("gid://shopify/InventoryItem/")) return str;
  // 数字だけならGID化
  if (/^\d+$/.test(str)) return `gid://shopify/InventoryItem/${str}`;
  // 既にGID形式の可能性がある場合はそのまま
  if (str.includes("gid://")) return str;
  return null;
}

// 在庫を実数に設定（ロスと同じ処理方法：inventorySetQuantitiesで絶対値設定）
export async function adjustInventoryToActual({ locationId, items }) {
  // items: [{ inventoryItemId, currentQuantity, actualQuantity }]
  // 実数（actualQuantity）を直接設定する
  const quantities = (items ?? [])
    .filter((x) => x?.inventoryItemId && Number.isFinite(Number(x?.actualQuantity)))
    .map((x) => {
      const inventoryItemGid = toInventoryItemGid(x.inventoryItemId);
      if (!inventoryItemGid) return null;
      const actual = Math.max(0, Math.floor(Number(x.actualQuantity) || 0));
      const current = Number.isFinite(Number(x.currentQuantity)) ? Math.max(0, Math.floor(Number(x.currentQuantity) || 0)) : 0;
      return { inventoryItemId: inventoryItemGid, quantity: actual, compareQuantity: current };
    })
    .filter((x) => x !== null);

  if (!locationId || quantities.length === 0) {
    if (quantities.length === 0 && items.length > 0) {
      throw new Error("有効な在庫アイテムIDがありません");
    }
    return;
  }

  // locationIdをGID形式に変換
  const locationGid = toLocationGid(locationId);
  if (!locationGid) {
    throw new Error(`無効なロケーションID: ${locationId}`);
  }

  // inventorySetQuantities を使用（絶対値設定）
  const m = `#graphql
    mutation Set($input: InventorySetQuantitiesInput!) {
      inventorySetQuantities(input: $input) {
        inventoryAdjustmentGroup { id }
        userErrors { field message }
      }
    }`;
  
  try {
    const d = await graphql(m, {
      input: {
        name: "available",
        reason: "correction",
        quantities: quantities.map((q) => ({
          inventoryItemId: q.inventoryItemId,
          locationId: locationGid,
          quantity: q.quantity,
          compareQuantity: q.compareQuantity,
        })),
      },
    });
    
    // レスポンスが空の場合はエラー
    if (!d || !d.inventorySetQuantities) {
      throw new Error("GraphQL response is invalid");
    }
    
    const errs = d?.inventorySetQuantities?.userErrors ?? [];
    if (errs.length) throw new Error(errs.map((e) => e.message).join(" / "));
    return d?.inventorySetQuantities?.inventoryAdjustmentGroup ?? null;
  } catch (e) {
    const msg = String(e?.message ?? e);
    console.error("[adjustInventoryToActual] Error:", {
      error: msg,
      locationGid,
      quantitiesCount: quantities.length,
      quantitiesSample: quantities.slice(0, 2).map((q) => ({
        inventoryItemId: q.inventoryItemId?.substring(0, 30),
        quantity: q.quantity,
        compareQuantity: q.compareQuantity,
      })),
    });
    // HTTP 400エラーなどの場合は、より詳細なエラーメッセージを投げる
    if (msg.includes("HTTP 400") || msg.includes("Invalid request")) {
      const quantitiesSummary = quantities.slice(0, 3).map((q) => ({
        id: q.inventoryItemId?.substring(0, 30) + "...",
        quantity: q.quantity,
        compareQuantity: q.compareQuantity,
      }));
      throw new Error(`在庫調整エラー: ${msg}\nロケーション: ${locationGid?.substring(0, 30)}...\n変更数: ${quantities.length}件`);
    }
    throw e;
  }
}

export async function fetchLocations() {
  const gql = `#graphql
    query Locations($first: Int!) {
      locations(first: $first) { nodes { id name } }
    }`;
  const d = await graphql(gql, { first: 250 });
  return d?.locations?.nodes ?? [];
}

// ロケーションIDからロケーション名を取得（キャッシュ付き）
const locationCache = new Map();
export async function getLocationName(locationId) {
  if (!locationId) return null;
  if (locationCache.has(locationId)) {
    return locationCache.get(locationId);
  }
  try {
    const locations = await fetchLocations();
    const loc = locations.find((l) => l.id === locationId);
    const name = loc?.name || null;
    locationCache.set(locationId, name);
    return name;
  } catch (e) {
    console.error(`Failed to get location name for ${locationId}:`, e);
    return null;
  }
}

// 商品グループIDから商品グループ名を取得
export async function getProductGroupName(productGroupId) {
  const groups = await readProductGroups();
  const group = groups.find((g) => g.id === productGroupId);
  return group?.name || null;
}

// =========================
// VariantCache（出庫/入庫/ロスと同じ実装）
// =========================

const VARIANT_CACHE_NS = "stock_transfer_pos_variant_cache_v1";
const VARIANT_CACHE_META_KEY = `${VARIANT_CACHE_NS}:meta`;
const VARIANT_CACHE_CHUNK_PREFIX = `${VARIANT_CACHE_NS}:chunk:`;

// 6000SKU想定なら 32〜48 くらいが扱いやすい（1チャンク 125〜190件目安）
const VARIANT_CACHE_CHUNKS = 32;

// flush（永続書き込み）を頻繁にやらない
const VARIANT_CACHE_FLUSH_MS = 2500;

// ざっくりハッシュ（チャンク振り分け用）
function hashString_(s) {
  // djb2
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return Math.abs(h) >>> 0;
}

function chunkIndexForCode_(code) {
  const n = hashString_(code);
  return n % VARIANT_CACHE_CHUNKS;
}

function chunkKey_(idx) {
  return `${VARIANT_CACHE_CHUNK_PREFIX}${String(idx).padStart(2, "0")}`;
}

/**
 * VariantCache: lazy-load chunk, batched flush
 */
const VariantCache = (() => {
  let inited = false;
  let initPromise = null;

  // chunkIdx -> object map
  const chunks = new Map();
  const loadingChunkPromises = new Map();

  const dirtyChunks = new Set();
  let flushTimer = null;

  async function ensureStorage_() {
    if (!SHOPIFY?.storage?.get || !SHOPIFY?.storage?.set) return false;
    return true;
  }

  async function init_() {
    if (inited) return true;
    if (initPromise) return initPromise;

    initPromise = (async () => {
      const ok = await ensureStorage_();
      if (!ok) {
        inited = true; // storage無しでも inited 扱い（メモリのみ動作）
        return false;
      }
      try {
        // metaは今はほぼ使わない（将来のバージョン用）
        const meta = await SHOPIFY.storage.get(VARIANT_CACHE_META_KEY);
        if (!meta || typeof meta !== "object") {
          await SHOPIFY.storage.set(VARIANT_CACHE_META_KEY, {
            v: 1,
            chunks: VARIANT_CACHE_CHUNKS,
            savedAt: Date.now(),
          });
        }
      } catch (_) {
        // metaが取れなくても運用はできる
      }
      inited = true;
      return true;
    })();

    return initPromise;
  }

  async function loadChunk_(idx) {
    await init_();
    const key = chunkKey_(idx);

    if (chunks.has(idx)) return chunks.get(idx);

    if (loadingChunkPromises.has(idx)) return loadingChunkPromises.get(idx);

    const p = (async () => {
      const hasStorage = await ensureStorage_();
      if (!hasStorage) {
        const empty = {};
        chunks.set(idx, empty);
        return empty;
      }

      try {
        const obj = await SHOPIFY.storage.get(key);
        const map = obj && typeof obj === "object" ? obj : {};
        chunks.set(idx, map);
        return map;
      } catch {
        const empty = {};
        chunks.set(idx, empty);
        return empty;
      } finally {
        loadingChunkPromises.delete(idx);
      }
    })();

    loadingChunkPromises.set(idx, p);
    return p;
  }

  function scheduleFlush_() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush_().catch(() => {});
    }, VARIANT_CACHE_FLUSH_MS);
  }

  async function flush_() {
    const hasStorage = await ensureStorage_();
    if (!hasStorage) {
      dirtyChunks.clear();
      return;
    }

    const idxs = Array.from(dirtyChunks.values());
    if (idxs.length === 0) return;

    try {
      for (const idx of idxs) {
        const key = chunkKey_(idx);
        const map = chunks.get(idx) || {};
        await SHOPIFY.storage.set(key, map);
      }
      dirtyChunks.clear();

      try {
        await SHOPIFY.storage.set(VARIANT_CACHE_META_KEY, {
          v: 1,
          chunks: VARIANT_CACHE_CHUNKS,
          savedAt: Date.now(),
          dirtyFlushedAt: Date.now(),
        });
      } catch (_) {}
    } catch (_) {
      // flush失敗時は dirty を保持（次回flushに回る）
    }
  }

  async function get(codeRaw) {
    const code = normalizeScanCode_(codeRaw);
    if (!code) return null;

    const idx = chunkIndexForCode_(code);
    const map = await loadChunk_(idx);
    const v = map?.[code] ?? null;
    return v && typeof v === "object" ? v : null;
  }

  async function put(codeRaw, valueObj) {
    const code = normalizeScanCode_(codeRaw);
    if (!code) return;

    const idx = chunkIndexForCode_(code);
    const map = await loadChunk_(idx);

    map[code] = {
      // 最小限（重くしない）
      variantId: valueObj?.variantId ?? null,
      inventoryItemId: valueObj?.inventoryItemId ?? null,
      sku: valueObj?.sku ?? "",
      barcode: valueObj?.barcode ?? "",
      productTitle: valueObj?.productTitle ?? "",
      variantTitle: valueObj?.variantTitle ?? "",
      // 画像は任意（liteMode/画像OFF時は空にしてOK）
      imageUrl: valueObj?.imageUrl ?? "",
      updatedAt: Date.now(),
    };

    chunks.set(idx, map);
    dirtyChunks.add(idx);
    scheduleFlush_();
  }

  async function clearAll() {
    const hasStorage = await ensureStorage_();
    chunks.clear();
    dirtyChunks.clear();
    if (!hasStorage) return;

    try {
      await SHOPIFY.storage.delete(VARIANT_CACHE_META_KEY);
    } catch (_) {}
    for (let i = 0; i < VARIANT_CACHE_CHUNKS; i++) {
      try {
        await SHOPIFY.storage.delete(chunkKey_(i));
      } catch (_) {}
    }
  }

  return {
    init: init_,
    get,
    put,
    flush: flush_,
    clearAll,
  };
})();

/**
 * searchVariants の結果から「一番それっぽい1件」を選ぶ
 * - バーコード完全一致 > SKU完全一致 > 先頭
 */
function pickBestVariant_(codeRaw, list) {
  const code = normalizeScanCode_(codeRaw);
  if (!code) return null;
  const arr = Array.isArray(list) ? list : [];
  if (arr.length === 0) return null;

  // barcode exact
  const byBarcode = arr.find((x) => normalizeScanCode_(x?.barcode) === code);
  if (byBarcode) return byBarcode;

  // sku exact
  const bySku = arr.find((x) => normalizeScanCode_(x?.sku) === code);
  if (bySku) return bySku;

  return arr[0];
}

/**
 * JAN/SKU -> variant 解決（キャッシュ優先）
 * - includeImages は "候補検索" の負荷に関わるので必要時だけtrue
 */
export async function resolveVariantByCode(codeRaw, { includeImages = false } = {}) {
  const code = normalizeScanCode_(codeRaw);
  if (!code) return null;

  // 1) cache hit
  const cached = await VariantCache.get(code);
  // ✅ includeImagesがtrueの場合、キャッシュに画像URLがない場合は再取得
  if (cached?.variantId && cached?.inventoryItemId) {
    if (!includeImages || cached.imageUrl) {
      return cached;
    }
    // ✅ キャッシュに画像URLがない場合は、ネットワークから再取得
  }

  // 2) network (searchVariants)
  const list = await searchVariants(code, { includeImages, first: 50 });
  const v = pickBestVariant_(code, list);
  if (!v?.variantId || !v?.inventoryItemId) {
    // ✅ ネットワークから取得できなかった場合、キャッシュがあればそれを返す
    if (cached?.variantId && cached?.inventoryItemId) {
      return cached;
    }
    return null;
  }

  const resolved = {
    variantId: v.variantId,
    inventoryItemId: v.inventoryItemId,
    sku: v.sku || "",
    barcode: v.barcode || "",
    productTitle: v.productTitle || "",
    variantTitle: v.variantTitle || "",
    imageUrl: v.imageUrl || "",
  };

  // 3) write-through cache（次回からネット0）
  await VariantCache.put(code, resolved);

  // ついでに SKU / barcode でも引けるように別名で入れる（効きが良い）
  if (resolved.sku) await VariantCache.put(resolved.sku, resolved);
  if (resolved.barcode) await VariantCache.put(resolved.barcode, resolved);

  return resolved;
}
