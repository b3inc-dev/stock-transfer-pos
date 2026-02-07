const LOSS_NS = "stock_transfer_pos";
const LOSS_KEY = "loss_entries_v1";
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

export async function searchVariants(q, opts = {}) {
  const includeImages = opts?.includeImages !== false;

  const firstRaw = Number(opts?.first ?? opts?.limit ?? 50);
  const first = Math.max(10, Math.min(50, Number.isFinite(firstRaw) ? firstRaw : 50));

  const query = buildVariantSearchQuery(q);
  if (!query) return []; // ✅ ここで止めることで「1文字入力で固まる」を回避

  // 画像不要なら最初から軽量クエリへ
  if (!includeImages) {
    const requestBody = {
      query: `#graphql
        query GetVariants($first: Int!, $query: String!) {
          productVariants(first: $first, query: $query) {
            nodes {
              id
              title
              sku
              barcode
              inventoryItem { id }
              product { title }
            }
          }
        }`,
      variables: { first, query },
    };

    const res = await fetch("shopify:admin/api/graphql.json", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    const json = await res.json();
    if (json.errors?.length) throw new Error(JSON.stringify(json.errors));
    const nodes = json?.data?.productVariants?.nodes ?? [];

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

  // 画像あり（試す→ダメならフォールバック）
  try {
    const requestBody = {
      query: `#graphql
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
        }`,
      variables: { first, query },
    };

    const res = await fetch("shopify:admin/api/graphql.json", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    const json = await res.json();
    if (json.errors?.length) throw new Error(JSON.stringify(json.errors));
    const nodes = json?.data?.productVariants?.nodes ?? [];

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
    throw e;
  }
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
  const list = await searchVariants(code, { includeImages });
  const v = pickBestVariant_(code, list);
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

export async function readLossEntries() {
  const gql = `#graphql
    query LossEntries {
      currentAppInstallation {
        id
        metafield(namespace: "${LOSS_NS}", key: "${LOSS_KEY}") { id value type }
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

export async function writeLossEntries(entries) {
  const gqlApp = `#graphql query AppId { currentAppInstallation { id } }`;
  const d = await graphql(gqlApp);
  const ownerId = d?.currentAppInstallation?.id;
  if (!ownerId) throw new Error("currentAppInstallation.id が取得できません");
  const mutation = `#graphql
    mutation SetLoss($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id namespace key }
        userErrors { field message }
      }
    }`;
  const res = await graphql(mutation, {
    metafields: [{
      ownerId,
      namespace: LOSS_NS,
      key: LOSS_KEY,
      type: "json",
      value: JSON.stringify(Array.isArray(entries) ? entries : []),
    }],
  });
  const errs = res?.metafieldsSet?.userErrors ?? [];
  if (errs.length) throw new Error(errs.map((e) => e.message).join(" / "));
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

export async function adjustInventoryAtLocation({ locationId, deltas, referenceDocumentUri }) {
  // inventoryItemIdをGID形式に変換してから処理
  const changes = (deltas ?? [])
    .map((x) => {
      const inventoryItemGid = toInventoryItemGid(x?.inventoryItemId);
      if (!inventoryItemGid || Number(x?.delta || 0) === 0) return null;
      return { inventoryItemId: inventoryItemGid, delta: Number(x.delta) };
    })
    .filter((x) => x !== null);
  
  if (!locationId || changes.length === 0) {
    if (changes.length === 0 && deltas.length > 0) {
      throw new Error("有効な在庫アイテムIDがありません");
    }
    return;
  }
  
  // locationIdをGID形式に変換
  const locationGid = toLocationGid(locationId);
  if (!locationGid) {
    throw new Error(`無効なロケーションID: ${locationId}`);
  }
  
  // referenceDocumentUriを生成（転送IDが指定されている場合）
  const uri = referenceDocumentUri ? `gid://stock-transfer-pos/OutboundTransfer/${referenceDocumentUri}` : null;
  
  try {
    const m1 = `#graphql
      mutation Adjust($input: InventoryAdjustQuantitiesInput!) {
        inventoryAdjustQuantities(input: $input) {
          inventoryAdjustmentGroup { id }
          userErrors { field message }
        }
      }`;
    
    const input = {
      reason: "correction",
      name: "available",
      changes: changes.map((c) => ({
        inventoryItemId: c.inventoryItemId,
        locationId: locationGid,
        delta: c.delta,
      })),
    };
    
    // referenceDocumentUriが指定されている場合は追加
    if (uri) {
      input.referenceDocumentUri = uri;
    }
    
    const d1 = await graphql(m1, {
      input,
    });
    
    // レスポンスが空の場合はエラー
    if (!d1 || !d1.inventoryAdjustQuantities) {
      throw new Error("GraphQL response is invalid");
    }
    
    const errs = d1?.inventoryAdjustQuantities?.userErrors ?? [];
    if (errs.length) throw new Error(errs.map((e) => e.message).join(" / "));
    return d1?.inventoryAdjustQuantities?.inventoryAdjustmentGroup ?? null;
  } catch (e) {
    const msg = String(e?.message ?? e);
    // 特定のエラーのみfallbackに進む
    if (!/doesn't exist|Field .* doesn't exist|undefined/i.test(msg)) {
      // HTTP 400エラーなどの場合は、より詳細なエラーメッセージを投げる
      if (msg.includes("HTTP 400") || msg.includes("Invalid request")) {
        const changesSummary = changes.slice(0, 3).map((c) => ({
          id: c.inventoryItemId?.substring(0, 30) + "...",
          delta: c.delta,
        }));
        throw new Error(`在庫調整エラー: ${msg}\nロケーション: ${locationGid?.substring(0, 30)}...\n変更数: ${changes.length}件`);
      }
      throw e;
    }
  }
  // 2) fallback: inventorySetQuantities（現在値を読んでから new=cur+delta でセット）
  const currentMap = new Map();
  for (const c of changes) {
    const q = `#graphql
      query Cur($id: ID!, $loc: ID!) {
        inventoryItem(id: $id) {
          inventoryLevel(locationId: $loc) {
            quantities(names: ["available"]) { name quantity }
          }
        }
      }`;
    try {
      const d = await graphql(q, { id: c.inventoryItemId, loc: locationGid });
      const cur = d?.inventoryItem?.inventoryLevel?.quantities?.find((x) => x.name === "available")?.quantity ?? 0;
      currentMap.set(c.inventoryItemId, Number(cur || 0));
    } catch (e) {
      currentMap.set(c.inventoryItemId, 0);
    }
  }
  const quantities = changes.map((c) => {
    const cur = currentMap.get(c.inventoryItemId) ?? 0;
    return { inventoryItemId: c.inventoryItemId, locationId: locationGid, quantity: cur + c.delta, compareQuantity: cur };
  });
  
  const m2 = `#graphql
    mutation Set($input: InventorySetQuantitiesInput!) {
      inventorySetQuantities(input: $input) {
        inventoryAdjustmentGroup { id }
        userErrors { field message }
      }
    }`;
  
  const d2 = await graphql(m2, { input: { name: "available", reason: "correction", quantities } });
  const errs2 = d2?.inventorySetQuantities?.userErrors ?? [];
  if (errs2.length) throw new Error(errs2.map((e) => e.message).join(" / "));
  return d2?.inventorySetQuantities?.inventoryAdjustmentGroup ?? null;
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
    if (parsed && parsed.version === 1) {
      return parsed;
    }
    return { version: 1, carriers: [] };
  } catch (e) {
    console.error("[fetchSettings] error:", e);
    return { version: 1, carriers: [] };
  }
}

// =========================
// 発注エントリの読み書き
// =========================

const ORDER_NS = "stock_transfer_pos";
const ORDER_KEY = "order_request_entries_v1";

export async function readOrderEntries() {
  const gql = `#graphql
    query OrderEntries {
      currentAppInstallation {
        id
        metafield(namespace: "${ORDER_NS}", key: "${ORDER_KEY}") { id value type }
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

export async function writeOrderEntries(entries) {
  const gqlApp = `#graphql
    query AppId {
      currentAppInstallation { id }
    }`;
  const d = await graphql(gqlApp);
  const ownerId = d?.currentAppInstallation?.id;
  if (!ownerId) throw new Error("currentAppInstallation.id が取得できません");

  const mutation = `#graphql
    mutation SetOrderEntries($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id namespace key }
        userErrors { field message }
      }
    }`;

  const res = await graphql(mutation, {
    metafields: [
      {
        ownerId,
        namespace: ORDER_NS,
        key: ORDER_KEY,
        type: "json",
        value: JSON.stringify(Array.isArray(entries) ? entries : []),
      },
    ],
  });

  const errs = res?.metafieldsSet?.userErrors ?? [];
  if (errs.length) throw new Error(errs.map((e) => e.message).join(" / "));
}
