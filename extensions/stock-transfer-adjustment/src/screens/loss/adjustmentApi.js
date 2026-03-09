const ADJUSTMENT_NS = "stock_transfer_pos";
const ADJUSTMENT_KEY = "adjustment_entries_v1";
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
    if (!res.ok) {
      // エラーメッセージを改善
      let errorMsg = `HTTP ${res.status}: ${text || res.statusText}`;
      try {
        const errorJson = text ? JSON.parse(text) : {};
        if (errorJson.error) {
          errorMsg = `HTTP ${res.status}: ${JSON.stringify(errorJson.error)}`;
        } else if (errorJson.errors) {
          errorMsg = `HTTP ${res.status}: ${JSON.stringify(errorJson.errors)}`;
        }
      } catch {}
      throw new Error(errorMsg);
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

function buildVariantSearchQuery(raw) {
  const q = String(raw || "").trim();
  if (!q) return "";

  const isDigitsOnly = /^\d+$/.test(q);
  const hasAlpha = /[A-Za-z]/.test(q);
  const hasSkuLikeSymbol = /[-_./]/.test(q);
  const hasCJK = /[\u3040-\u30ff\u3400-\u9fff]/.test(q);

  const parts = [];

  // ✅ 1文字から検索可能に変更
  // バーコード検索：数字のみの場合（1文字以上）
  if (isDigitsOnly) {
    // 8桁以上なら barcode 検索、それ以下は通常検索
    if (q.length >= 8) {
      parts.push(`barcode:${q}`);
    } else {
      parts.push(q); // 短い数字も通常検索に含める
    }
  }

  // SKU検索：英字や記号が含まれる場合（1文字以上）
  if (hasAlpha || hasSkuLikeSymbol) {
    parts.push(`sku:${q}`);
  }

  // フリーテキスト検索：1文字から検索可能
  parts.push(q);

  // 重複を除去して結合
  const uniq = Array.from(new Set(parts));
  return uniq.join(" OR ");
}

// ✅ 戻り値: { nodes, pageInfo }。呼び出し側は result.nodes を使用
export async function searchVariants(q, opts = {}) {
  const includeImages = opts?.includeImages !== false;
  const after = opts?.after ?? null;
  const firstRaw = Number(opts?.first ?? opts?.limit ?? 50);
  const first = Math.max(10, Math.min(250, Number.isFinite(firstRaw) ? firstRaw : 50));
  const query = buildVariantSearchQuery(q);
  if (!query) return { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };

  const variables = { first, query };
  if (after) variables.after = after;
  const nodesQuery = includeImages
    ? `nodes { id title sku barcode image { url } inventoryItem { id } product { title featuredImage { url } } }`
    : `nodes { id title sku barcode inventoryItem { id } product { title } }`;
  const gql = `#graphql
    query GetVariants($first: Int!, $query: String!, $after: String) {
      productVariants(first: $first, query: $query, after: $after) {
        ${nodesQuery}
        pageInfo { hasNextPage endCursor }
      }
    }`;
  const d = await graphql(gql, variables);
  const conn = d?.productVariants ?? {};
  const nodes = (conn.nodes ?? []).map((n) => ({
    variantId: n.id,
    inventoryItemId: n.inventoryItem?.id,
    productTitle: n.product?.title ?? "",
    variantTitle: n.title ?? "",
    sku: n.sku ?? "",
    barcode: n.barcode ?? "",
    imageUrl: includeImages ? (n.image?.url ?? n.product?.featuredImage?.url ?? "") : "",
  }));
  const pageInfo = conn.pageInfo ?? { hasNextPage: false, endCursor: null };
  return { nodes, pageInfo };
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

// =========================
// VariantCache（出庫/入庫と同じ実装）
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
  if (cached?.variantId && cached?.inventoryItemId) return cached;

  // 2) network (searchVariants)
  const { nodes } = await searchVariants(code, { includeImages });
  const v = pickBestVariant_(code, nodes);
  if (!v?.variantId || !v?.inventoryItemId) return null;

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

// variantIdから画像URLを取得する関数
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

// ---------- 調整エントリ v2: チャンク分割取得 ----------
const ADJUSTMENT_V2_META_KEY = "adjustment_entries_v2_meta";
const ADJUSTMENT_V2_CHUNK_PREFIX = "adjustment_entries_v2_";
const ADJUSTMENT_CHUNK_SIZE_DEFAULT = 100;
const ADJUSTMENT_METAFIELDS_SET_MAX = 25;

async function getAdjustmentChunkSize() {
  const settings = await fetchSettings();
  const n = Number(settings?.outbound?.historyInitialLimit ?? ADJUSTMENT_CHUNK_SIZE_DEFAULT);
  return Math.max(1, Math.min(250, n));
}

async function readAdjustmentManifest() {
  const gql = `#graphql query AdjMeta { currentAppInstallation { metafield(namespace: "${ADJUSTMENT_NS}", key: "${ADJUSTMENT_V2_META_KEY}") { value } } }`;
  const d = await graphql(gql);
  const raw = d?.currentAppInstallation?.metafield?.value;
  if (raw == null || raw === "") return null;
  try {
    const o = JSON.parse(raw);
    if (o && typeof o.chunkSize === "number" && typeof o.chunkCount === "number") return o;
  } catch {}
  return null;
}

async function migrateAdjustmentV1ToV2() {
  const gqlV1 = `#graphql query AdjV1 { currentAppInstallation { id metafield(namespace: "${ADJUSTMENT_NS}", key: "${ADJUSTMENT_KEY}") { id value type } } }`;
  const d = await graphql(gqlV1);
  const raw = d?.currentAppInstallation?.metafield?.value ?? "[]";
  let arr = [];
  try {
    const parsed = JSON.parse(raw);
    arr = Array.isArray(parsed) ? parsed : [];
  } catch {
    arr = [];
  }
  const chunkSize = await getAdjustmentChunkSize();
  const chunks = [];
  for (let i = 0; i < arr.length; i += chunkSize) {
    chunks.push(arr.slice(i, i + chunkSize));
  }
  if (chunks.length === 0) chunks.push([]);
  const ownerId = d?.currentAppInstallation?.id;
  if (!ownerId) throw new Error("currentAppInstallation.id が取得できません");
  const mutation = `#graphql mutation SetAdjChunks($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { metafields { id namespace key } userErrors { field message } } }`;
  const metaValue = JSON.stringify({ chunkSize, chunkCount: chunks.length });
  const metafields = [
    { ownerId, namespace: ADJUSTMENT_NS, key: ADJUSTMENT_V2_META_KEY, type: "json", value: metaValue },
    ...chunks.map((chunk, i) => ({ ownerId, namespace: ADJUSTMENT_NS, key: `${ADJUSTMENT_V2_CHUNK_PREFIX}${i}`, type: "json", value: JSON.stringify(chunk) })),
  ];
  for (let off = 0; off < metafields.length; off += ADJUSTMENT_METAFIELDS_SET_MAX) {
    const batch = metafields.slice(off, off + ADJUSTMENT_METAFIELDS_SET_MAX);
    const res = await graphql(mutation, { metafields: batch });
    const errs = res?.metafieldsSet?.userErrors ?? [];
    if (errs.length) throw new Error(errs.map((e) => e.message).join(" / "));
  }
}

async function getAdjustmentInitialDisplayLimit() {
  const n = await getAdjustmentChunkSize();
  return Math.max(1, Math.min(250, n));
}

export async function readAdjustmentEntriesFirstPage() {
  let manifest = await readAdjustmentManifest();
  if (!manifest) {
    await migrateAdjustmentV1ToV2();
    manifest = await readAdjustmentManifest();
  }
  if (!manifest || manifest.chunkCount === 0) return { entries: [], hasMore: false, chunkCount: 0 };
  const chunkKey0 = `${ADJUSTMENT_V2_CHUNK_PREFIX}0`;
  const gql = `#graphql query AdjFirstPage { currentAppInstallation { meta: metafield(namespace: "${ADJUSTMENT_NS}", key: "${ADJUSTMENT_V2_META_KEY}") { value } chunk0: metafield(namespace: "${ADJUSTMENT_NS}", key: "${chunkKey0}") { value } } }`;
  const data = await graphql(gql);
  const chunkRaw = data?.currentAppInstallation?.chunk0?.value ?? "[]";
  try {
    const list = JSON.parse(chunkRaw);
    const fullList = Array.isArray(list) ? list : [];
    const limit = await getAdjustmentInitialDisplayLimit();
    const entries = fullList.slice(0, limit);
    const hasMore = fullList.length > limit || manifest.chunkCount > 1;
    return { entries, hasMore, chunkCount: manifest.chunkCount };
  } catch {
    return { entries: [], hasMore: false, chunkCount: manifest.chunkCount };
  }
}

/** 指定IDのエントリを1件取得（一覧タップ後の詳細用） */
export async function readAdjustmentEntryById(entryId) {
  if (!entryId) return null;
  const id = String(entryId).trim();
  let manifest = await readAdjustmentManifest();
  if (!manifest) {
    await migrateAdjustmentV1ToV2();
    manifest = await readAdjustmentManifest();
  }
  if (!manifest || manifest.chunkCount === 0) return null;
  for (let i = 0; i < manifest.chunkCount; i++) {
    const key = `${ADJUSTMENT_V2_CHUNK_PREFIX}${i}`;
    const gql = `#graphql query AdjChunk($key: String!) { currentAppInstallation { metafield(namespace: "${ADJUSTMENT_NS}", key: $key) { value } } }`;
    const d = await graphql(gql, { key });
    const raw = d?.currentAppInstallation?.metafield?.value ?? "[]";
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        const found = arr.find((e) => String(e?.id ?? "").trim() === id);
        if (found) return found;
      }
    } catch {}
  }
  return null;
}

export async function readAdjustmentEntriesPage(pageIndex) {
  const manifest = await readAdjustmentManifest();
  if (!manifest || pageIndex < 0 || pageIndex >= manifest.chunkCount) return { entries: [] };
  const key = `${ADJUSTMENT_V2_CHUNK_PREFIX}${pageIndex}`;
  const gql = `#graphql query AdjChunk($key: String!) { currentAppInstallation { metafield(namespace: "${ADJUSTMENT_NS}", key: $key) { value } } }`;
  const d = await graphql(gql, { key });
  const raw = d?.currentAppInstallation?.metafield?.value ?? "[]";
  try {
    const arr = JSON.parse(raw);
    return { entries: Array.isArray(arr) ? arr : [] };
  } catch {
    return { entries: [] };
  }
}

export async function readAdjustmentEntriesFull() {
  let manifest = await readAdjustmentManifest();
  if (!manifest) {
    await migrateAdjustmentV1ToV2();
    manifest = await readAdjustmentManifest();
  }
  if (!manifest || manifest.chunkCount === 0) return [];
  const all = [];
  for (let i = 0; i < manifest.chunkCount; i++) {
    const key = `${ADJUSTMENT_V2_CHUNK_PREFIX}${i}`;
    const gql = `#graphql query AdjChunk($key: String!) { currentAppInstallation { metafield(namespace: "${ADJUSTMENT_NS}", key: $key) { value } } }`;
    const d = await graphql(gql, { key });
    const raw = d?.currentAppInstallation?.metafield?.value ?? "[]";
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) all.push(...arr);
    } catch {}
  }
  return all;
}

export async function readAdjustmentEntries() {
  return readAdjustmentEntriesFull();
}

export async function writeAdjustmentEntries(entries) {
  const arr = Array.isArray(entries) ? entries : [];
  const chunkSize = await getAdjustmentChunkSize();
  const chunks = [];
  for (let i = 0; i < arr.length; i += chunkSize) {
    chunks.push(arr.slice(i, i + chunkSize));
  }
  if (chunks.length === 0) chunks.push([]);
  const gqlApp = `#graphql query AppId { currentAppInstallation { id } }`;
  const d = await graphql(gqlApp);
  const ownerId = d?.currentAppInstallation?.id;
  if (!ownerId) throw new Error("currentAppInstallation.id が取得できません");
  const mutation = `#graphql mutation SetAdjustment($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { metafields { id namespace key } userErrors { field message } } }`;
  const metaValue = JSON.stringify({ chunkSize, chunkCount: chunks.length });
  const metafields = [
    { ownerId, namespace: ADJUSTMENT_NS, key: ADJUSTMENT_V2_META_KEY, type: "json", value: metaValue },
    ...chunks.map((chunk, i) => ({ ownerId, namespace: ADJUSTMENT_NS, key: `${ADJUSTMENT_V2_CHUNK_PREFIX}${i}`, type: "json", value: JSON.stringify(chunk) })),
  ];
  for (let off = 0; off < metafields.length; off += ADJUSTMENT_METAFIELDS_SET_MAX) {
    const batch = metafields.slice(off, off + ADJUSTMENT_METAFIELDS_SET_MAX);
    const res = await graphql(mutation, { metafields: batch });
    const errs = res?.metafieldsSet?.userErrors ?? [];
    if (errs.length) throw new Error(errs.map((e) => e.message).join(" / "));
  }
}

// locationIdをGID形式に変換（OutboundListと同じ処理）
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

// inventoryItemIdをGID形式に変換
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

/** Throttled 時リトライ（棚卸と同様） */
const THROTTLE_RETRY_DELAY_MS = 3000;
const THROTTLE_RETRY_MAX = 4;
/** バッチ間の待機（ms）。連続書き込みで Throttled になりにくくする */
const BATCH_WRITE_DELAY_MS = 350;
/** Shopify API: inventorySetQuantities の quantities は250件まで */
const INVENTORY_SET_QUANTITIES_MAX = 250;

async function runWithThrottleRetry(fn, maxRetries = THROTTLE_RETRY_MAX) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const msg = String(e?.message ?? e);
      if ((/throttle/i.test(msg) || /429/.test(msg)) && attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, THROTTLE_RETRY_DELAY_MS));
        continue;
      }
      throw e;
    }
  }
}

/**
 * 指定ロケーションで在庫レベルがないアイテムを有効化する（棚卸と同様）。
 * inventorySetQuantities は「ロケーションに在庫レベルがない」と失敗するため、確定前に実行する。
 */
async function ensureInventoryActivatedAtLocation({ locationGid, items }) {
  const activated = [];
  const errors = [];
  if (!locationGid || !Array.isArray(items) || items.length === 0) {
    return { ok: true, activated, errors };
  }
  const ids = items.map((x) => x?.inventoryItemId).filter(Boolean);
  if (ids.length === 0) return { ok: true, activated, errors };

  const quantityByItemId = new Map(items.map((x) => [x.inventoryItemId, x.quantity]));
  const toProcess = [];

  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    try {
      const d = await graphql(
        `#graphql
          query CheckInventoryItems($ids: [ID!]!, $locationId: ID!) {
            nodes(ids: $ids) {
              ... on InventoryItem {
                id
                tracked
                inventoryLevel(locationId: $locationId) { id }
              }
            }
          }`,
        { ids: chunk, locationId: locationGid }
      );
      const nodes = Array.isArray(d?.nodes) ? d.nodes : [];
      const processedIds = new Set();
      for (const node of nodes) {
        const inventoryItemId = String(node?.id || "").trim();
        if (!inventoryItemId) continue;
        processedIds.add(inventoryItemId);
        const hasLevel = !!node?.inventoryLevel?.id;
        const tracked = node?.tracked === true;
        if (!hasLevel || !tracked) {
          toProcess.push({
            inventoryItemId,
            needsTrackedUpdate: !tracked,
            needsActivate: !hasLevel,
          });
        } else {
          activated.push({ inventoryItemId, locationId: locationGid });
        }
      }
      for (const id of chunk) {
        if (!processedIds.has(id)) {
          toProcess.push({
            inventoryItemId: id,
            needsTrackedUpdate: true,
            needsActivate: true,
          });
        }
      }
    } catch (e) {
      for (const inventoryItemId of chunk) {
        toProcess.push({
          inventoryItemId,
          needsTrackedUpdate: true,
          needsActivate: true,
        });
      }
    }
  }

  const maxAttempts = 4;
  const delayAfterTrackedMs = 1000;
  const delayBetweenItemsMs = 150;

  for (let idx = 0; idx < toProcess.length; idx++) {
    const item = toProcess[idx];
    const { inventoryItemId, needsTrackedUpdate, needsActivate } = item;
    const initialQty = quantityByItemId.get(inventoryItemId);
    if (idx > 0) await new Promise((r) => setTimeout(r, delayBetweenItemsMs));
    let lastError = null;
    let succeeded = false;
    for (let attempt = 1; attempt <= maxAttempts && !succeeded; attempt++) {
      try {
        if (needsTrackedUpdate) {
          const updateRes = await graphql(
            `#graphql
              mutation UpdateInventoryItem($id: ID!, $input: InventoryItemInput!) {
                inventoryItemUpdate(id: $id, input: $input) {
                  inventoryItem { id tracked }
                  userErrors { field message }
                }
              }`,
            { id: inventoryItemId, input: { tracked: true } }
          );
          const updateErrs = updateRes?.inventoryItemUpdate?.userErrors ?? [];
          if (updateErrs.length > 0) {
            lastError = updateErrs.map((e) => e?.message).filter(Boolean).join(" / ") || "在庫追跡の有効化に失敗しました";
            if (attempt < maxAttempts) {
              await new Promise((r) => setTimeout(r, 800 * attempt));
              continue;
            }
          } else {
            await new Promise((r) => setTimeout(r, delayAfterTrackedMs));
          }
        }
        if (!needsActivate) {
          activated.push({ inventoryItemId, locationId: locationGid });
          succeeded = true;
          break;
        }
        const withQty = attempt === 1 && initialQty != null && Number.isFinite(Number(initialQty));
        const vars = { inventoryItemId, locationId: locationGid };
        if (withQty) {
          const q = Math.floor(Number(initialQty));
          vars.available = q;
          vars.onHand = q;
        }
        const actRes = await graphql(
          `#graphql
            mutation ActivateInventoryItem(
              $inventoryItemId: ID!
              $locationId: ID!
              $available: Int
              $onHand: Int
            ) {
              inventoryActivate(
                inventoryItemId: $inventoryItemId
                locationId: $locationId
                available: $available
                onHand: $onHand
              ) {
                inventoryLevel { id }
                userErrors { field message }
              }
            }`,
          vars
        );
        const payload = actRes?.inventoryActivate;
        const userErrs = payload?.userErrors ?? [];
        if (userErrs.length > 0) {
          const errMsg = userErrs.map((e) => e?.message).filter(Boolean).join(" / ") || "unknown";
          const alreadyActivated = /already|既に|activated|在庫レベル|already has/i.test(errMsg);
          if (alreadyActivated) {
            const check = await graphql(
              `#graphql
                query CheckLevel($ids: [ID!]!, $locationId: ID!) {
                  nodes(ids: $ids) {
                    ... on InventoryItem {
                      id
                      inventoryLevel(locationId: $locationId) { id }
                    }
                  }
                }`,
              { ids: [inventoryItemId], locationId: locationGid }
            );
            const node = (check?.nodes ?? [])[0];
            if (node?.inventoryLevel?.id) {
              activated.push({ inventoryItemId, locationId: locationGid });
              succeeded = true;
              break;
            }
          }
          lastError = errMsg;
          if (attempt < maxAttempts) {
            await new Promise((r) => setTimeout(r, 800 * attempt));
            continue;
          }
          if (!succeeded) errors.push({ inventoryItemId, message: lastError });
          break;
        }
        if (payload?.inventoryLevel?.id) {
          activated.push({ inventoryItemId, locationId: locationGid });
          succeeded = true;
        } else {
          lastError = "inventoryLevel が返されませんでした";
          if (attempt < maxAttempts) {
            await new Promise((r) => setTimeout(r, 800 * attempt));
            continue;
          }
          if (!succeeded) errors.push({ inventoryItemId, message: lastError });
        }
        break;
      } catch (e) {
        lastError = String(e?.message ?? e);
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 800 * attempt));
          continue;
        }
        if (!succeeded) errors.push({ inventoryItemId, message: lastError });
      }
    }
  }
  return { ok: errors.length === 0, activated, errors };
}

// 在庫を実数に設定（棚卸と同様：在庫有効化→250件チャンク→Throttleリトライ）
export async function adjustInventoryToActual({ locationId, items, referenceDocumentUri }) {
  const locationGid = toLocationGid(locationId);
  if (!locationGid) {
    throw new Error(`無効なロケーションID: ${locationId}`);
  }

  // 調整も棚卸と同様にマイナス在庫を許可するため Math.max(0,...) は適用しない
  const validItems = (items ?? []).filter((x) => x?.inventoryItemId && Number.isFinite(Number(x?.actualQuantity)));
  const quantitiesWithStatus = validItems.map((x) => {
    const inventoryItemGid = toInventoryItemGid(x.inventoryItemId);
    if (!inventoryItemGid) return { valid: false, item: x };
    const quantity = Math.floor(Number(x.actualQuantity) || 0);
    return { valid: true, inventoryItemId: inventoryItemGid, quantity, compareQuantity: 0 };
  });

  const quantities = quantitiesWithStatus.filter((x) => x.valid);
  const invalidCount = quantitiesWithStatus.filter((x) => !x.valid).length;

  if (invalidCount > 0) {
    console.warn(`[adjustInventoryToActual] ${invalidCount}件の不正なinventoryItemIdを除外しました`);
  }

  if (!locationId || quantities.length === 0) {
    if (quantities.length === 0 && (items ?? []).length > 0) {
      const errMsg = invalidCount > 0
        ? `有効な在庫アイテムIDがありません（${invalidCount}件が不正なIDのため除外されました）`
        : "有効な在庫アイテムIDがありません";
      throw new Error(errMsg);
    }
    return { adjustmentGroup: null, invalidCount, processedCount: 0 };
  }

  // ロケーションに在庫レベルがないアイテムがあると inventorySetQuantities が失敗するため、先に在庫有効化（棚卸と同様）
  let activateResult = await ensureInventoryActivatedAtLocation({
    locationGid,
    items: quantities.map((q) => ({ inventoryItemId: q.inventoryItemId, quantity: q.quantity })),
  });
  const maxActivateRetries = 2;
  for (let r = 0; r < maxActivateRetries && (activateResult.errors ?? []).length > 0; r++) {
    const failedIds = new Set((activateResult.errors ?? []).map((e) => e.inventoryItemId));
    const failedItems = quantities.filter((q) => failedIds.has(q.inventoryItemId));
    if (failedItems.length === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 1000 * (r + 1)));
    activateResult = await ensureInventoryActivatedAtLocation({
      locationGid,
      items: failedItems.map((q) => ({ inventoryItemId: q.inventoryItemId, quantity: q.quantity })),
    });
  }
  if ((activateResult.errors ?? []).length > 0) {
    throw new Error("在庫有効化に失敗しました");
  }

  const uri = referenceDocumentUri ? `gid://stock-transfer-pos/AdjustmentEntry/${referenceDocumentUri}` : null;
  const maxRetries = 3;
  const retryDelayMs = 1000;
  const m = `#graphql
    mutation Set($input: InventorySetQuantitiesInput!) {
      inventorySetQuantities(input: $input) {
        inventoryAdjustmentGroup { id }
        userErrors { field message }
      }
    }`;

  let lastAdjustmentGroup = null;
  let lastError;

  for (let chunkStart = 0; chunkStart < quantities.length; chunkStart += INVENTORY_SET_QUANTITIES_MAX) {
    const chunk = quantities.slice(chunkStart, chunkStart + INVENTORY_SET_QUANTITIES_MAX);
    const input = {
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
    if (uri) input.referenceDocumentUri = uri;

    let chunkSuccess = false;
    for (let attempt = 1; attempt <= maxRetries && !chunkSuccess; attempt++) {
      try {
        const d = await runWithThrottleRetry(() => graphql(m, { input }));
        if (!d || !d.inventorySetQuantities) throw new Error("GraphQL response is invalid");
        const errs = d?.inventorySetQuantities?.userErrors ?? [];
        if (errs.length) throw new Error(errs.map((e) => e.message).join(" / "));
        lastAdjustmentGroup = d.inventorySetQuantities.inventoryAdjustmentGroup ?? null;
        chunkSuccess = true;
        if (chunkStart + chunk.length < quantities.length) {
          await new Promise((resolve) => setTimeout(resolve, BATCH_WRITE_DELAY_MS));
        }
      } catch (e) {
        lastError = e;
        const msg = String(e?.message ?? e);
        const isRetryable =
          msg.includes("timeout") ||
          msg.includes("network") ||
          msg.includes("fetch") ||
          msg.includes("HTTP 5") ||
          /throttle/i.test(msg) ||
          /429/.test(msg);
        if (!isRetryable || attempt === maxRetries) break;
        console.warn(`[adjustInventoryToActual] チャンク ${chunkStart / INVENTORY_SET_QUANTITIES_MAX + 1} リトライ ${attempt}/${maxRetries}: ${msg}`);
        await new Promise((r) => setTimeout(r, retryDelayMs * attempt));
      }
    }
    if (!chunkSuccess) {
      const msg = String(lastError?.message ?? lastError);
      if (msg.includes("HTTP 400") || msg.includes("Invalid request") || msg.includes("maximum allowed")) {
        throw new Error(`在庫調整エラー: ${msg}\nロケーション: ${locationGid?.substring(0, 30)}...\n変更数: ${quantities.length}件（250件ずつ分割して送信中）`);
      }
      throw lastError;
    }
  }

  return {
    adjustmentGroup: lastAdjustmentGroup,
    invalidCount,
    processedCount: quantities.length,
  };
}

export async function fetchLocations() {
  const gql = `#graphql
    query Locations($first: Int!) {
      locations(first: $first) { nodes { id name } }
    }`;
  const d = await graphql(gql, { first: 250 });
  return d?.locations?.nodes ?? [];
}

export function getSessionStaffMemberId() {
  try {
    return SHOPIFY?.session?.currentSession?.staffMemberId ?? null;
  } catch {
    return null;
  }
}

// バリアントの在庫数を取得（OutboundListと同じ処理）
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

// スタッフ一覧を取得（バックエンドAPI経由）
export async function fetchStaffMembers() {
  try {
    // POS UI Extensionからセッショントークンを取得
    const session = SHOPIFY?.session;
    if (!session?.getSessionToken) {
      console.warn("[fetchStaffMembers] Session API not available");
      return [];
    }

    const token = await session.getSessionToken();
    if (!token) {
      console.warn("[fetchStaffMembers] Failed to get session token");
      return [];
    }

    // アプリURLを取得（共通設定から読み込み）
    const currentSession = session?.currentSession;
    const shopDomain = currentSession?.shopDomain;
    
    // 公開アプリ本番: getAppUrl() → https://pos-stock.onrender.com
    const { getAppUrl } = await import("../../../../common/appUrl.js");
    const appUrl = getAppUrl();
    
    const apiUrl = `${appUrl}/api/staff-members`;

    const res = await fetch(apiUrl, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
    }

    const json = await res.json();

    if (!json.ok) {
      throw new Error(json.error || "Failed to fetch staff members");
    }

    const staffList = Array.isArray(json.staffMembers) ? json.staffMembers : [];
    return staffList;
  } catch {
    return [];
  }
}

/** onInput/onChange から値を取得（Outbound readValue と同様） */
export function readValue(eOrValue) {
  if (typeof eOrValue === "string" || typeof eOrValue === "number") return String(eOrValue);
  const v = eOrValue?.currentTarget?.value ?? eOrValue?.target?.value ?? eOrValue?.currentValue?.value ?? "";
  return String(v ?? "");
}

// 設定を読み込む（出庫/入庫と同じ実装）
const SETTINGS_NS = "stock_transfer_pos";
const SETTINGS_KEY = "settings_v1";

function safeParseJson(raw, defaultVal) {
  if (typeof raw !== "string" || !raw) return defaultVal;
  try {
    return JSON.parse(raw);
  } catch {
    return defaultVal;
  }
}

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
    const parsed = safeParseJson(raw, null);
    const base = parsed && parsed.version === 1 ? parsed : {};

    // ✅ デフォルトのロス区分（破損・紛失）
    const defaultLossReasons = [
      { id: "damage", label: "破損", sortOrder: 1 },
      { id: "lost", label: "紛失", sortOrder: 2 },
    ];

    const lossReasonsRaw = Array.isArray(base.lossReasons) ? base.lossReasons : [];
    const lossReasons =
      lossReasonsRaw.length > 0
        ? lossReasonsRaw
        : defaultLossReasons;

    const allowCustomReason =
      base.loss && typeof base.loss.allowCustomReason === "boolean"
        ? !!base.loss.allowCustomReason
        : true;

    return {
      version: 1,
      carriers: Array.isArray(base.carriers) ? base.carriers : [],
      lossReasons,
      loss: {
        allowCustomReason,
      },
    };
  } catch (e) {
    console.error("[fetchSettings] error:", e);
    // エラー時も、ロス区分と「その他」許可フラグはデフォルトを返す
    return {
      version: 1,
      carriers: [],
      lossReasons: [
        { id: "damage", label: "破損", sortOrder: 1 },
        { id: "lost", label: "紛失", sortOrder: 2 },
      ],
      loss: {
        allowCustomReason: true,
      },
    };
  }
}
