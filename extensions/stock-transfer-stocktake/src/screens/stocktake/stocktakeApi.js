const NS = "stock_transfer_pos";
const PRODUCT_GROUPS_KEY = "product_groups_v1";
const INVENTORY_COUNTS_KEY = "inventory_counts_v1";
const SHOPIFY = globalThis?.shopify ?? {};

/** 管理画面・POS で全明細を確実に読むため：1チャンクあたりの最大バイト数（応答の切り詰めを防ぐ。管理画面と同一） */
const INVENTORY_COUNTS_CHUNK_BYTES = 32_000;
const INVENTORY_COUNTS_CHUNK_KEY_PREFIX = "inventory_counts_v1_c";
const METAFIELDS_SET_MAX = 25;

/** 一覧用軽量メタフィールド（id, locationId, status, countName, createdAt, productGroupIds のみ） */
const INVENTORY_COUNTS_LIST_KEY = "inventory_counts_list_v1";
const INVENTORY_COUNTS_LIST_CHUNK_PREFIX = "inventory_counts_list_v1_c";
/** 棚卸ID → チャンク番号のインデックス（readInventoryCountById で全チャンク読まないため） */
const INVENTORY_COUNT_INDEX_KEY = "inventory_count_index_v1";
/** 書き込み前の1世代バックアップ用（復元用。list の軽量JSONのみ） */
const INVENTORY_COUNTS_BACKUP_KEY = "inventory_counts_backup_v1";
const INVENTORY_COUNTS_BACKUP_MAX_BYTES = 60_000;

/** #C0001 形式の countName から数値（1）を取得。パースできない場合は 0 */
function parseCountNameNumber(countName) {
  if (!countName || typeof countName !== "string") return 0;
  const m = countName.trim().match(/^#C0*(\d+)$/i);
  return m ? Math.max(0, parseInt(m[1], 10)) : 0;
}
/** 商品グループ軽量：ID一覧・ID→名前（一覧表示でフル取得を避ける） */
const PRODUCT_GROUP_IDS_KEY = "product_group_ids_v1";
const PRODUCT_GROUP_NAMES_KEY = "product_group_names_v1";

async function graphql(query, variables, opts = {}) {
  // #graphqlコメントを削除（GraphQLクエリから除外）
  const cleanQuery = String(query || "").replace(/^#graphql\s*/m, "").trim();
  
  /** デフォルト60秒（大グループ・追加読み込みで20秒だと切れるため） */
  const timeoutMs = Number.isFinite(Number(opts?.timeoutMs)) ? Number(opts.timeoutMs) : 60000;
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

// ✅ 戻り値: { nodes, pageInfo }（検索の「さらに読み込む」用）。従来の配列を期待する呼び出しは result?.nodes を使用
export async function searchVariants(q, opts = {}) {
  const includeImages = opts?.includeImages !== false;
  const after = opts?.after ?? null;
  const first = Math.max(10, Math.min(50, Number(opts?.first) || 50));
  const query = buildVariantSearchQuery(q);
  if (!query) return { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };

  const variables = { first, query };
  if (after) variables.after = after;

  const mapNode = (n, withImg) => ({
    variantId: n.id,
    inventoryItemId: n.inventoryItem?.id,
    productTitle: n.product?.title ?? "",
    variantTitle: n.title ?? "",
    sku: n.sku ?? "",
    barcode: n.barcode ?? "",
    imageUrl: withImg ? (n.image?.url ?? n.product?.featuredImage?.url ?? "") : "",
  });

  // 画像不要なら最初から軽量クエリへ
  if (!includeImages) {
    const gql = `#graphql
      query GetVariants($first: Int!, $query: String!, $after: String) {
        productVariants(first: $first, query: $query, after: $after) {
          nodes { id title sku barcode inventoryItem { id } product { title } }
          pageInfo { hasNextPage endCursor }
        }
      }`;
    const data = await graphql(gql, variables);
    const conn = data?.productVariants ?? {};
    const nodes = (conn.nodes ?? []).map((n) => mapNode(n, false));
    const pageInfo = conn.pageInfo ?? { hasNextPage: false, endCursor: null };
    return { nodes, pageInfo };
  }

  // 画像あり
  try {
    const gql = `#graphql
      query GetVariants($first: Int!, $query: String!, $after: String) {
        productVariants(first: $first, query: $query, after: $after) {
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
          pageInfo { hasNextPage endCursor }
        }
      }`;
    const data = await graphql(gql, variables);
    const conn = data?.productVariants ?? {};
    const nodes = (conn.nodes ?? []).map((n) => mapNode(n, true));
    const pageInfo = conn.pageInfo ?? { hasNextPage: false, endCursor: null };
    return { nodes, pageInfo };
  } catch (e) {
    // フォールバック: 画像なしで再試行
    const gql = `#graphql
      query GetVariants($first: Int!, $query: String!, $after: String) {
        productVariants(first: $first, query: $query, after: $after) {
          nodes { id title sku barcode inventoryItem { id } product { title } }
          pageInfo { hasNextPage endCursor }
        }
      }`;
    const data = await graphql(gql, variables);
    const conn = data?.productVariants ?? {};
    const nodes = (conn.nodes ?? []).map((n) => mapNode(n, false));
    const pageInfo = conn.pageInfo ?? { hasNextPage: false, endCursor: null };
    return { nodes, pageInfo };
  }
}

/** パート配列を1件の棚卸に結合する（管理画面と同一ロジック）。countMeta が無いパートのみの場合は countId を id にフォールバック */
function mergeCountParts(parts) {
  const sorted = [...parts].sort((a, b) => (a.partIndex || 0) - (b.partIndex || 0));
  const first = sorted[0];
  const base = first?.countMeta && typeof first.countMeta === "object" ? { ...first.countMeta } : {};
  if (!base.id && first?.countId) base.id = first.countId;
  const groupItems = {};
  const items = [];
  for (const p of sorted) {
    if (p.groupItems && typeof p.groupItems === "object") {
      for (const [k, arr] of Object.entries(p.groupItems)) {
        if (Array.isArray(arr)) {
          if (!groupItems[k]) groupItems[k] = [];
          groupItems[k].push(...arr);
        }
      }
    }
    if (Array.isArray(p.items)) items.push(...p.items);
  }
  base.groupItems = groupItems;
  base.items = items;
  return base;
}

/**
 * 棚卸メタフィールドをチャンク対応で読み込む（管理画面と同一ロジック。パート形式にも対応）。
 * 副作用なし（readProductGroups・countName補正・内部writeは行わない）。確定時の軽量読み取り用に export。
 */
export async function readInventoryCountsRaw() {
  const gql = `#graphql
    query InventoryCounts {
      currentAppInstallation {
        id
        metafield(namespace: "${NS}", key: "${INVENTORY_COUNTS_KEY}") { id value type }
      }
    }`;
  const d = await graphql(gql);
  const raw = d?.currentAppInstallation?.metafield?.value ?? "[]";
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (Array.isArray(parsed)) return parsed;
  if (!parsed?._chunked || typeof parsed.totalChunks !== "number" || parsed.totalChunks < 1) return [];
  const fullCounts = [];
  const partsByCountId = new Map();
  for (let i = 0; i < parsed.totalChunks; i++) {
    const key = `${INVENTORY_COUNTS_CHUNK_KEY_PREFIX}${i}`;
    const gqlChunk = `#graphql
      query InventoryCountChunk($key: String!) {
        currentAppInstallation {
          metafield(namespace: "${NS}", key: $key) { value }
        }
      }`;
    let chunkRaw = null;
    try {
      const chunkData = await graphql(gqlChunk, { key });
      chunkRaw = chunkData?.currentAppInstallation?.metafield?.value;
    } catch (e) {
      throw new Error(`棚卸チャンク${i}の読み取りに失敗しました（部分保存で他データが消えるのを防ぐため中断）: ${e?.message ?? e}`);
    }
    if (chunkRaw == null) {
      throw new Error(`棚卸チャンク${i}が存在しません。メタフィールドが欠落している可能性があります（上書きで他データが消えるのを防ぐため読み取りを中断します）。`);
    }
    let chunk;
    try {
      chunk = JSON.parse(chunkRaw);
    } catch (e) {
      throw new Error(`棚卸チャンク${i}のパースに失敗しました: ${e?.message ?? e}`);
    }
    if (!Array.isArray(chunk)) {
      throw new Error(`棚卸チャンク${i}が配列ではありません（上書きで他データが消えるのを防ぐため中断）`);
    }
    for (const el of chunk) {
      if (el && typeof el === "object" && el._part === true) {
        const list = partsByCountId.get(el.countId) ?? [];
        list.push(el);
        partsByCountId.set(el.countId, list);
      } else {
        fullCounts.push(el);
      }
    }
  }
  for (const parts of partsByCountId.values()) {
    fullCounts.push(mergeCountParts(parts));
  }
  return fullCounts;
}

/** 1チャンク分の配列をパート結合して返す（分割取得用） */
function parseChunkAndMergeParts(chunk) {
  if (!Array.isArray(chunk)) return [];
  const fullCounts = [];
  const partsByCountId = new Map();
  for (const el of chunk) {
    if (el && typeof el === "object" && el._part === true) {
      const list = partsByCountId.get(el.countId) ?? [];
      list.push(el);
      partsByCountId.set(el.countId, list);
    } else {
      fullCounts.push(el);
    }
  }
  for (const parts of partsByCountId.values()) {
    fullCounts.push(mergeCountParts(parts));
  }
  return fullCounts;
}

/** グループが存在するか（productGroups 配列または groupIds Set で判定） */
function groupExists(productGroupsOrGroupIds, groupId) {
  if (!groupId) return false;
  const n = normalizeIdForMatch(groupId);
  if (Array.isArray(productGroupsOrGroupIds)) {
    return productGroupsOrGroupIds.some((g) => String(g.id) === String(groupId) || normalizeIdForMatch(g.id) === n);
  }
  if (productGroupsOrGroupIds instanceof Set) {
    return productGroupsOrGroupIds.has(n) || productGroupsOrGroupIds.has(groupId);
  }
  return false;
}

/** キャンセル済みグループIDの Set（正規化済み）。管理画面でキャンセルしたグループを「完了」とみなす。POS商品グループ一覧のステータス表示でも使用 */
export function getCancelledGroupIdSet(c) {
  const arr = Array.isArray(c?.cancelledGroupIds) ? c.cancelledGroupIds : [];
  return new Set(arr.map((id) => normalizeIdForMatch(id)));
}

/** ステータスだけ補正（countNameは付けない。部分取得時は全件ソートできないため）。キャンセル済みグループは「完了」とみなす。
 * 確定済み（completed）は groupItems が部分取得等で欠けていても「未処理」に戻さない（一覧・再読み込みで完了が消える不具合防止）。 */
function fixCountsStatusOnly(counts, productGroupsOrGroupIds) {
  if (!Array.isArray(counts)) return [];
  return counts.map((c) => {
    if (c?.status === "cancelled") return c;
    if (c?.status === "completed") return c;
    const allIds = Array.isArray(c.productGroupIds) && c.productGroupIds.length > 0
      ? c.productGroupIds
      : c.productGroupId ? [c.productGroupId] : [];
    if (allIds.length === 0) return c;
    const cancelledSet = getCancelledGroupIdSet(c);
    const groupItemsMap = c?.groupItems && typeof c.groupItems === "object" ? c.groupItems : {};
    const hasGroupItems = groupItemsMap && Object.keys(groupItemsMap).length > 0;
    const allDone = allIds.every((id) => {
      if (cancelledSet.has(normalizeIdForMatch(id))) return true;
      if (!groupExists(productGroupsOrGroupIds, id)) return true;
      const items = getGroupItemsByKey(groupItemsMap, id);
      return items.length > 0;
    });
    if (!hasGroupItems) {
      const allCancelled = allIds.length > 0 && allIds.every((id) => cancelledSet.has(normalizeIdForMatch(id)));
      const allDoneOrMissing = allIds.every((id) => cancelledSet.has(normalizeIdForMatch(id)) || !groupExists(productGroupsOrGroupIds, id));
      if (allDoneOrMissing) {
        return allCancelled
          ? { ...c, status: "cancelled", completedAt: undefined }
          : { ...c, status: "completed", completedAt: c.completedAt || new Date().toISOString() };
      }
      return c;
    }
    // completed は上書きしない（部分取得・list で groupItems が欠けていても「未処理」に戻さない）
    if (!allDone && c.status === "completed") return c;
    if (allDone && c.status !== "completed") {
      return { ...c, status: "completed", completedAt: c.completedAt || new Date().toISOString() };
    }
    return c;
  });
}

export async function getStocktakeListLimit() {
  const settings = await fetchSettings();
  const n = Number(settings?.outbound?.historyInitialLimit ?? 100);
  return Math.max(1, Math.min(250, n));
}

/** 一覧用ミニマムオブジェクト（groupItems/items なし）。管理画面のキャンセルと同期するため cancelledGroupIds と productGroupNames を含める */
function toMinimalCountForList(c) {
  if (!c || typeof c !== "object") return null;
  return {
    id: c.id,
    locationId: c.locationId,
    status: c.status,
    countName: c.countName,
    createdAt: c.createdAt,
    productGroupIds: Array.isArray(c.productGroupIds) ? c.productGroupIds : c.productGroupId ? [c.productGroupId] : [],
    productGroupNames: Array.isArray(c.productGroupNames) ? c.productGroupNames : undefined,
    cancelledGroupIds: Array.isArray(c.cancelledGroupIds) ? c.cancelledGroupIds : undefined,
  };
}

/**
 * 一覧用：先頭1チャンクだけ取得（読込スピード統一）。
 * ディスクリプタ・商品グループ・表示件数を Promise.all で並列取得し、一覧用メタフィールドがあればそれを使用。
 */
export async function readInventoryCountsFirstPage() {
  const gqlMain = `#graphql
    query InventoryCountsMain {
      currentAppInstallation {
        main: metafield(namespace: "${NS}", key: "${INVENTORY_COUNTS_KEY}") { value }
        list: metafield(namespace: "${NS}", key: "${INVENTORY_COUNTS_LIST_KEY}") { value }
      }
    }`;
  const [d, productGroups, listLimit] = await Promise.all([
    graphql(gqlMain),
    readProductGroups(),
    getStocktakeListLimit(),
  ]);
  const raw = d?.currentAppInstallation?.main?.value ?? d?.currentAppInstallation?.metafield?.value ?? "[]";
  const listRaw = d?.currentAppInstallation?.list?.value ?? null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { counts: [], hasMore: false, chunkCount: 0, loadedChunkCount: 0, productGroups: productGroups || [], listLimit, useListMetafield: false };
  }
  let listParsed = null;
  if (listRaw) {
    try {
      listParsed = JSON.parse(listRaw);
    } catch {}
  }
  const useListMetafield = listParsed?._chunked === true && typeof listParsed.totalChunks === "number" && listParsed.totalChunks > 0;

  if (useListMetafield) {
    const totalChunks = listParsed.totalChunks;
    const gqlChunk = `#graphql
      query InventoryCountListChunk($key: String!) {
        currentAppInstallation {
          metafield(namespace: "${NS}", key: $key) { value }
        }
      }`;
    // ✅ 全チャンクを並列取得して初回表示を高速化（アプリタイルの待機時間削減）
    const chunkPromises = [];
    for (let i = 0; i < totalChunks; i++) {
      const chunkIndex = totalChunks - 1 - i;
      const key = `${INVENTORY_COUNTS_LIST_CHUNK_PREFIX}${chunkIndex}`;
      chunkPromises.push(graphql(gqlChunk, { key }).then((dChunk) => ({ chunkIndex, dChunk })));
    }
    const chunkResults = await Promise.all(chunkPromises);
    chunkResults.sort((a, b) => a.chunkIndex - b.chunkIndex);
    let accumulated = [];
    for (const { dChunk } of chunkResults) {
      const chunkRaw = dChunk?.currentAppInstallation?.metafield?.value;
      let chunkCounts = [];
      if (chunkRaw) {
        try {
          const chunk = JSON.parse(chunkRaw);
          chunkCounts = Array.isArray(chunk) ? chunk : [];
        } catch {}
      }
      chunkCounts = fixCountsStatusOnly(chunkCounts, productGroups || []);
      accumulated = accumulated.concat(chunkCounts);
    }
    const limited = accumulated.slice(0, listLimit);
    const hasMore = accumulated.length > listLimit || chunkResults.length < totalChunks;
    return {
      counts: limited,
      hasMore,
      chunkCount: totalChunks,
      loadedChunkCount: chunkResults.length,
      productGroups: productGroups || [],
      listLimit,
      useListMetafield: true,
    };
  }

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      return { counts: [], hasMore: false, chunkCount: 0, loadedChunkCount: 0, productGroups: productGroups || [], listLimit, useListMetafield: false };
    }
    const key0 = `${INVENTORY_COUNTS_CHUNK_KEY_PREFIX}0`;
    const gql0 = `#graphql
      query InventoryCountChunk0 {
        currentAppInstallation {
          metafield(namespace: "${NS}", key: "${key0}") { value }
        }
      }`;
    const d0 = await graphql(gql0);
    const chunkRaw = d0?.currentAppInstallation?.metafield?.value;
    const chunk0Exists = chunkRaw != null;
    if (!chunk0Exists) {
      await writeInventoryCounts(parsed);
    }
    let counts = [];
    if (chunk0Exists) {
      counts = await readInventoryCountsRaw();
    } else if (chunkRaw) {
      try {
        const chunk = JSON.parse(chunkRaw);
        counts = parseChunkAndMergeParts(chunk);
      } catch {}
    }
    const totalChunks = 1;
    counts = fixCountsStatusOnly(counts, productGroups || []);
    const limited = counts.slice(0, listLimit);
    const hasMore = counts.length > listLimit || totalChunks > 1;
    return { counts: limited, hasMore, chunkCount: totalChunks, loadedChunkCount: 1, productGroups: productGroups || [], listLimit, useListMetafield: false };
  }

  if (!parsed?._chunked || typeof parsed.totalChunks !== "number" || parsed.totalChunks < 1) {
    return { counts: [], hasMore: false, chunkCount: 0, loadedChunkCount: 0, productGroups: productGroups || [], listLimit, useListMetafield: false };
  }
  const totalChunks = parsed.totalChunks;
  const gqlChunkMain = `#graphql
    query InventoryCountChunk($key: String!) {
      currentAppInstallation {
        metafield(namespace: "${NS}", key: $key) { value }
      }
    }`;
  // ✅ 全チャンクを並列取得して初回表示を高速化（アプリタイルの待機時間削減）
  const chunkPromises = [];
  for (let i = 0; i < totalChunks; i++) {
    const chunkIndex = totalChunks - 1 - i;
    const key = `${INVENTORY_COUNTS_CHUNK_KEY_PREFIX}${chunkIndex}`;
    chunkPromises.push(graphql(gqlChunkMain, { key }).then((dChunk) => ({ chunkIndex, dChunk })));
  }
  const chunkResults = await Promise.all(chunkPromises);
  chunkResults.sort((a, b) => a.chunkIndex - b.chunkIndex);
  let accumulated = [];
  for (const { dChunk } of chunkResults) {
    const chunkRaw = dChunk?.currentAppInstallation?.metafield?.value;
    let chunkCounts = [];
    if (chunkRaw) {
      try {
        const chunk = JSON.parse(chunkRaw);
        chunkCounts = parseChunkAndMergeParts(chunk);
      } catch {}
    }
    chunkCounts = fixCountsStatusOnly(chunkCounts, productGroups || []);
    accumulated = accumulated.concat(chunkCounts);
  }
  const limited = accumulated.slice(0, listLimit);
  const hasMore = accumulated.length > listLimit || chunkResults.length < totalChunks;
  return {
    counts: limited,
    hasMore,
    chunkCount: totalChunks,
    loadedChunkCount: chunkResults.length,
    productGroups: productGroups || [],
    listLimit,
    useListMetafield: false,
  };
}

/**
 * 一覧用：指定インデックスのチャンクだけ取得。
 * opts.productGroups, opts.totalChunks, opts.useListMetafield を渡すとディスクリプタ・readProductGroups をスキップしチャンク1本だけ取得（軽量化）。
 */
export async function readInventoryCountsPage(pageIndex, opts = {}) {
  const { productGroups: optsProductGroups, totalChunks: optsTotalChunks, useListMetafield: optsUseListMetafield } = opts;
  const hasLightOpts = optsProductGroups != null && typeof optsTotalChunks === "number" && optsTotalChunks > 0;

  if (hasLightOpts && pageIndex >= 0 && pageIndex < optsTotalChunks) {
    const prefix = optsUseListMetafield ? INVENTORY_COUNTS_LIST_CHUNK_PREFIX : INVENTORY_COUNTS_CHUNK_KEY_PREFIX;
    const key = `${prefix}${pageIndex}`;
    const gqlChunk = `#graphql
      query InventoryCountChunk($key: String!) {
        currentAppInstallation {
          metafield(namespace: "${NS}", key: $key) { value }
        }
      }`;
    const dChunk = await graphql(gqlChunk, { key });
    const chunkRaw = dChunk?.currentAppInstallation?.metafield?.value;
    let counts = [];
    if (chunkRaw) {
      try {
        const chunk = JSON.parse(chunkRaw);
        counts = optsUseListMetafield ? (Array.isArray(chunk) ? chunk : []) : parseChunkAndMergeParts(chunk);
      } catch {}
    }
    counts = fixCountsStatusOnly(counts, optsProductGroups);
    return { counts };
  }

  const gqlMain = `#graphql
    query InventoryCountsMain {
      currentAppInstallation {
        metafield(namespace: "${NS}", key: "${INVENTORY_COUNTS_KEY}") { value }
      }
    }`;
  const d = await graphql(gqlMain);
  const raw = d?.currentAppInstallation?.metafield?.value ?? "[]";
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { counts: [] };
  }
  const productGroups = await readProductGroups();

  if (Array.isArray(parsed)) {
    const limit = await getStocktakeListLimit();
    const start = pageIndex * limit;
    const counts = parsed.slice(start, start + limit);
    const fixed = fixCountsStatusOnly(counts, productGroups);
    return { counts: fixed };
  }

  if (!parsed?._chunked || typeof parsed.totalChunks !== "number" || pageIndex < 0 || pageIndex >= parsed.totalChunks) {
    return { counts: [] };
  }
  const key = `${INVENTORY_COUNTS_CHUNK_KEY_PREFIX}${pageIndex}`;
  const gqlChunk = `#graphql
    query InventoryCountChunk($key: String!) {
      currentAppInstallation {
        metafield(namespace: "${NS}", key: $key) { value }
      }
    }`;
  const dChunk = await graphql(gqlChunk, { key });
  const chunkRaw = dChunk?.currentAppInstallation?.metafield?.value;
  let counts = [];
  if (chunkRaw) {
    try {
      const chunk = JSON.parse(chunkRaw);
      counts = parseChunkAndMergeParts(chunk);
    } catch {}
  }
  counts = fixCountsStatusOnly(counts, productGroups);
  return { counts };
}

/**
 * 棚卸IDで1件だけ取得（一覧タップ後の商品グループ読み込み用）。
 * インデックスメタフィールドがあれば該当チャンクのみ取得（全チャンク読まない）。
 */
export async function readInventoryCountById(countId) {
  if (!countId) return null;
  const id = String(countId).trim();
  const n = normalizeIdForMatch(id);

  const gqlIndex = `#graphql
    query InventoryCountIndex {
      currentAppInstallation {
        metafield(namespace: "${NS}", key: "${INVENTORY_COUNT_INDEX_KEY}") { value }
      }
    }`;
  try {
    const d = await graphql(gqlIndex);
    const raw = d?.currentAppInstallation?.metafield?.value;
    if (raw) {
      const index = JSON.parse(raw);
      if (index && typeof index === "object") {
        const chunkIndices =
          index[id] ??
          index[n] ??
          (() => {
            const k = Object.keys(index).find((key) => normalizeIdForMatch(key) === n);
            return k != null ? index[k] : undefined;
          })();
        const indices = Array.isArray(chunkIndices) ? chunkIndices : chunkIndices != null ? [chunkIndices] : null;
        if (indices && indices.length > 0) {
          const chunkPromises = indices.map((chunkIndex) => {
            const key = `${INVENTORY_COUNTS_CHUNK_KEY_PREFIX}${chunkIndex}`;
            return graphql(
              `#graphql query InventoryCountChunkByKey($key: String!) {
                currentAppInstallation { metafield(namespace: "${NS}", key: $key) { value } }
              }`,
              { key }
            );
          });
          const chunkResults = await Promise.all(chunkPromises);
          const parts = [];
          for (const res of chunkResults) {
            const chunkRaw = res?.currentAppInstallation?.metafield?.value;
            if (!chunkRaw) continue;
            try {
              const chunk = JSON.parse(chunkRaw);
              if (!Array.isArray(chunk)) continue;
              for (const el of chunk) {
                if (el && typeof el === "object" && (String(el.countId) === id || normalizeIdForMatch(el.countId) === n)) {
                  parts.push(el);
                } else if (el && typeof el === "object" && el.id && (String(el.id) === id || normalizeIdForMatch(el.id) === n)) {
                  const productGroups = await readProductGroups();
                  const fixed = fixCountsStatusOnly([el], productGroups);
                  return fixed[0] ?? null;
                }
              }
            } catch {}
          }
          if (parts.length > 0) {
            const merged = mergeCountParts(parts);
            const productGroups = await readProductGroups();
            const fixed = fixCountsStatusOnly([merged], productGroups);
            return fixed[0] ?? null;
          }
        }
      }
    }
  } catch {}

  const counts = await readInventoryCountsRaw();
  const found = counts.find((c) => String(c?.id) === id || normalizeIdForMatch(c?.id) === n);
  if (!found) return null;
  const productGroups = await readProductGroups();
  const fixed = fixCountsStatusOnly([found], productGroups);
  return fixed[0] ?? null;
}

export async function readInventoryCounts() {
  const counts = await readInventoryCountsRaw();
  try {
    
    // ✅ 既存データにcountNameがない場合、生成して付与
    const hasMissingCountName = counts.some((c) => !c.countName);
    
    // ✅ 現在の商品グループ一覧（棚卸ID発行後に削除されたグループを「完了」とみなすため）
    const productGroups = await readProductGroups();
    
    // ✅ 完了判定：全グループが完了している場合のみ完了。管理画面と統一。削除済み・キャンセル済みグループは完了とみなす。
    let needsUpdate = false;
    const countsFixed = counts.map((c) => {
      if (c?.status === "cancelled") return c;
      if (c?.status === "completed") return c;
      const allIds = Array.isArray(c.productGroupIds) && c.productGroupIds.length > 0
        ? c.productGroupIds
        : c.productGroupId ? [c.productGroupId] : [];
      
      if (allIds.length === 0) {
        return c;
      }
      
      const cancelledSet = getCancelledGroupIdSet(c);
      const groupItemsMap = c?.groupItems && typeof c.groupItems === "object" ? c.groupItems : {};
      const allDone = allIds.every((id) => {
        if (cancelledSet.has(normalizeIdForMatch(id))) return true;
        const groupExists = productGroups.some((g) => String(g.id) === String(id));
        if (!groupExists) return true; // 削除済みグループは完了とみなす
        const items = getGroupItemsByKey(groupItemsMap, id);
        return items.length > 0;
      });
      const isCompleted = allDone;
      
      // 確定済み（completed）は groupItems が欠けていても「未処理」に戻さない（再読み込みで完了が消える不具合防止）
      if (!isCompleted && c.status === "completed") return c;
      
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
    
    // ✅ 一度振り分けた countName は固定（同じ棚卸IDには常に同じ番号名称）。既にある場合は変更しない。
    // 欠けている場合のみ、既存の最大番号+1 から作成日時順に付与して重複を防ぐ。
    const maxExistingNumber = countsFixed.reduce((max, c) => {
      const n = parseCountNameNumber(c.countName);
      return n > max ? n : max;
    }, 0);
    const missingCountNameCounts = [...countsFixed].filter((c) => !c.countName).sort((a, b) => {
      const aTime = new Date(a.createdAt || 0).getTime();
      const bTime = new Date(b.createdAt || 0).getTime();
      if (aTime !== bTime) return aTime - bTime;
      return String(a.id || "").localeCompare(String(b.id || ""), undefined, { numeric: true });
    });
    const assignedCountNameById = new Map();
    let nextNumber = maxExistingNumber + 1;
    for (const c of missingCountNameCounts) {
      assignedCountNameById.set(c.id, `#C${String(nextNumber).padStart(4, "0")}`);
      nextNumber += 1;
    }
    const countsWithName = countsFixed.map((c) => {
      if (c.countName) return c;
      const countName = assignedCountNameById.get(c.id);
      return countName ? { ...c, countName } : c;
    });
    const addedAnyCountName = missingCountNameCounts.length > 0;

    // ✅ countNameを新規付与した場合、またはステータスが修正された場合のみ保存（既存の countName は上書きしない）
    if (hasMissingCountName || needsUpdate || addedAnyCountName) {
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

/** 1件の棚卸を CHUNK_BYTES 以下に収まるパートに分割する（管理画面と同一ロジック） */
function splitCountIntoParts(count) {
  const c = count || {};
  const groupItems = c.groupItems && typeof c.groupItems === "object" ? c.groupItems : {};
  const items = Array.isArray(c.items) ? c.items : [];
  const countMeta = { ...c };
  delete countMeta.groupItems;
  delete countMeta.items;

  const entries = [];
  for (const [g, arr] of Object.entries(groupItems)) {
    if (Array.isArray(arr)) for (const item of arr) entries.push({ g, item });
  }
  for (const item of items) entries.push({ g: "_legacy", item });

  if (entries.length === 0) {
    return [{ _part: true, countId: c.id, partIndex: 0, totalParts: 1, countMeta, groupItems: {}, items: [] }];
  }

  const parts = [];
  let partIndex = 0;
  let current = { groupItems: {}, items: [] };

  function flush() {
    if (Object.keys(current.groupItems).length === 0 && current.items.length === 0) return;
    parts.push({
      _part: true,
      countId: c.id,
      partIndex,
      totalParts: 0,
      countMeta: partIndex === 0 ? countMeta : undefined,
      groupItems: { ...current.groupItems },
      items: [...current.items],
    });
    partIndex++;
    current = { groupItems: {}, items: [] };
  }

  function partSize() {
    return JSON.stringify({
      _part: true,
      countId: c.id,
      partIndex,
      totalParts: 0,
      countMeta: partIndex === 0 ? countMeta : undefined,
      groupItems: current.groupItems,
      items: current.items,
    }).length;
  }

  for (const { g, item } of entries) {
    const addToGroup = g !== "_legacy";
    if (addToGroup) {
      if (!current.groupItems[g]) current.groupItems[g] = [];
      current.groupItems[g].push(item);
    } else {
      current.items.push(item);
    }
    if (partSize() > INVENTORY_COUNTS_CHUNK_BYTES) {
      if (addToGroup) current.groupItems[g].pop();
      else current.items.pop();
      flush();
      if (addToGroup) {
        if (!current.groupItems[g]) current.groupItems[g] = [];
        current.groupItems[g].push(item);
      } else current.items.push(item);
    }
  }
  flush();
  parts.forEach((p) => (p.totalParts = parts.length));
  return parts;
}

/**
 * 書き込み前に、渡された counts のうち locationId / productGroupIds / groupItems などが
 * 空白の件について、既存ストレージの値を補完する。何らかのアクション・表示・読み込み・確定時に
 * 空白で上書きされて「IDだけ残った」レコードが増えるのを防ぐ。
 * existing は readInventoryCountsRaw() の戻り値（既存の全件）。
 */
function mergeExistingNonBlank(counts, existing) {
  if (!Array.isArray(counts) || counts.length === 0) return counts;
  if (!Array.isArray(existing) || existing.length === 0) return counts;
  const existingById = new Map();
  for (const e of existing) {
    const id = e?.id ?? e?.countId;
    if (id) existingById.set(String(id), e);
  }
  return counts.map((c) => {
    const id = c?.id ?? c?.countId;
    if (!id) return c;
    const ex = existingById.get(String(id));
    if (!ex || typeof ex !== "object") return c;
    const out = { ...c };
    // ✅ 完了確定時などで countName が空白で上書きされないよう、既存の countName を維持
    const outCountName = out.countName != null && String(out.countName).trim() !== "";
    const exCountName = ex.countName != null && String(ex.countName).trim() !== "";
    if (!outCountName && exCountName) out.countName = ex.countName;
    if (!out.locationId && ex.locationId) out.locationId = ex.locationId;
    if (ex.locationName && !out.locationName) out.locationName = ex.locationName;
    const hasPgIds = Array.isArray(out.productGroupIds) && out.productGroupIds.length > 0;
    const exPgIds = Array.isArray(ex.productGroupIds) && ex.productGroupIds.length > 0;
    if (!hasPgIds && exPgIds) out.productGroupIds = ex.productGroupIds;
    if (!hasPgIds && ex.productGroupId && !exPgIds) out.productGroupIds = [ex.productGroupId];
    if (!out.productGroupId && ex.productGroupId) out.productGroupId = ex.productGroupId;
    const exPgNames = Array.isArray(ex.productGroupNames) && ex.productGroupNames.length > 0;
    if ((!Array.isArray(out.productGroupNames) || out.productGroupNames.length === 0) && exPgNames) out.productGroupNames = ex.productGroupNames;
    const hasGroupItems = out.groupItems && typeof out.groupItems === "object" && Object.keys(out.groupItems).length > 0;
    const exGroupItems = ex.groupItems && typeof ex.groupItems === "object" && Object.keys(ex.groupItems).length > 0;
    if (!hasGroupItems && exGroupItems) out.groupItems = ex.groupItems;
    const hasItems = Array.isArray(out.items) && out.items.length > 0;
    const exItems = Array.isArray(ex.items) && ex.items.length > 0;
    if (!hasItems && exItems) out.items = ex.items;
    return out;
  });
}

/**
 * 書き込み直前：id があるのに countName または locationId が空白のレコードは保存しない。
 * 絶対に「空白のID」を新規に永続化しないための最終ガード。
 */
function filterInvalidCountsBeforeWrite(counts) {
  if (!Array.isArray(counts) || counts.length === 0) return counts;
  const hasCountName = (c) => c?.countName != null && String(c.countName).trim() !== "";
  const hasLocationId = (c) => c?.locationId != null && String(c.locationId).trim() !== "";
  return counts.filter((c) => {
    const id = c?.id ?? c?.countId;
    if (!id) return true;
    return hasCountName(c) && hasLocationId(c);
  });
}

/**
 * 書き込み前に countName が欠けている件にのみ付与する（既存の countName は変更しない）。
 * writeInventoryCounts から呼び、確定後バックグラウンドで readInventoryCountsRaw 由来の list を書くときに空白で上書きするのを防ぐ。
 */
function ensureCountNamesBeforeWrite(counts) {
  if (!Array.isArray(counts) || counts.length === 0) return counts;
  const hasMissing = counts.some((c) => !c?.countName || String(c.countName).trim() === "");
  if (!hasMissing) return counts;
  const maxExistingNumber = counts.reduce((max, c) => {
    const n = parseCountNameNumber(c?.countName);
    return n > max ? n : max;
  }, 0);
  const missingCountNameCounts = [...counts]
    .filter((c) => !c?.countName || String(c.countName).trim() === "")
    .sort((a, b) => {
      const aTime = new Date(a?.createdAt || 0).getTime();
      const bTime = new Date(b?.createdAt || 0).getTime();
      if (aTime !== bTime) return aTime - bTime;
      return String(a?.id ?? "").localeCompare(String(b?.id ?? ""), undefined, { numeric: true });
    });
  const assignedCountNameById = new Map();
  let nextNumber = maxExistingNumber + 1;
  for (const c of missingCountNameCounts) {
    if (c?.id) assignedCountNameById.set(c.id, `#C${String(nextNumber).padStart(4, "0")}`);
    nextNumber += 1;
  }
  return counts.map((c) => {
    if (c?.countName && String(c.countName).trim() !== "") return c;
    const countName = c?.id ? assignedCountNameById.get(c.id) : null;
    return countName ? { ...c, countName } : c;
  });
}

/**
 * 棚卸一覧をメタフィールドに保存する。必ず「全件」の配列を渡すこと。
 * 部分的な配列で呼ぶと他棚卸IDが消えるため、呼び出し元は read で取得した全件を更新してから渡すこと。
 * 書き込み前に (1) 既存データから locationId / productGroupIds / groupItems 等を補完（空白で上書きしない）、(2) countName が欠けている件には付与する。
 */
export async function writeInventoryCounts(counts) {
  const gqlApp = `#graphql query AppId { currentAppInstallation { id } }`;
  const d = await graphql(gqlApp);
  const ownerId = d?.currentAppInstallation?.id;
  if (!ownerId) throw new Error("currentAppInstallation.id が取得できません");

  let existing = [];
  try {
    existing = await readInventoryCountsRaw();
  } catch (e) {
    // 既存読取失敗時はマージせずそのまま書く（新規ショップ等）
  }
  const merged = mergeExistingNonBlank(Array.isArray(counts) ? counts : [], existing);
  const withNames = ensureCountNamesBeforeWrite(merged);
  const arr = filterInvalidCountsBeforeWrite(withNames);
  try {
    const backupList = (existing.length > 0 ? existing : withNames).map(toMinimalCountForList).filter(Boolean);
    const backupValue = JSON.stringify(backupList);
    if (backupValue.length <= INVENTORY_COUNTS_BACKUP_MAX_BYTES) {
      const mutation = `#graphql mutation SetBackup($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { userErrors { message } } }`;
      await graphql(mutation, {
        metafields: [{ ownerId, namespace: NS, key: INVENTORY_COUNTS_BACKUP_KEY, type: "json", value: backupValue }],
      });
    }
  } catch (e) {
    // バックアップ失敗時は無視（本体の書き込みは続行）
  }
  if (arr.length === 0) {
    const gqlCheck = `#graphql query MainKey { currentAppInstallation { metafield(namespace: "${NS}", key: "${INVENTORY_COUNTS_KEY}") { value } } }`;
    const check = await graphql(gqlCheck);
    const raw = check?.currentAppInstallation?.metafield?.value;
    if (raw && raw !== "[]") {
      try {
        const parsed = JSON.parse(raw);
        const hasData = Array.isArray(parsed) ? parsed.length > 0 : (parsed?._chunked && parsed?.totalChunks > 0);
        if (hasData) {
          throw new Error("棚卸データを空にすることはできません。既存の棚卸IDが消えるため、空配列での上書きをブロックしました。");
        }
      } catch (e) {
        if (e?.message?.includes("ブロックしました")) throw e;
      }
    }
  }
  const payloads = [];
  const countIdToChunkIndices = new Map();
  let current = [];
  let currentSize = 2;

  for (const count of arr) {
    const countStr = JSON.stringify(count);
    if (countStr.length <= INVENTORY_COUNTS_CHUNK_BYTES) {
      if (currentSize + countStr.length + 1 > INVENTORY_COUNTS_CHUNK_BYTES && current.length > 0) {
        const chunkIndex = payloads.length;
        payloads.push(current);
        for (const it of current) {
          const cid = it?.id ?? it?.countId;
          if (cid) {
            if (!countIdToChunkIndices.has(cid)) countIdToChunkIndices.set(cid, new Set());
            countIdToChunkIndices.get(cid).add(chunkIndex);
          }
        }
        current = [];
        currentSize = 2;
      }
      current.push(count);
      currentSize += countStr.length + 1;
    } else {
      if (current.length > 0) {
        const chunkIndex = payloads.length;
        payloads.push(current);
        for (const it of current) {
          const cid = it?.id ?? it?.countId;
          if (cid) {
            if (!countIdToChunkIndices.has(cid)) countIdToChunkIndices.set(cid, new Set());
            countIdToChunkIndices.get(cid).add(chunkIndex);
          }
        }
        current = [];
        currentSize = 2;
      }
      const parts = splitCountIntoParts(count);
      for (const part of parts) {
        const partStr = JSON.stringify(part);
        if (currentSize + partStr.length + 1 > INVENTORY_COUNTS_CHUNK_BYTES && current.length > 0) {
          const chunkIndex = payloads.length;
          payloads.push(current);
          for (const it of current) {
            const cid = it?.id ?? it?.countId;
            if (cid) {
              if (!countIdToChunkIndices.has(cid)) countIdToChunkIndices.set(cid, new Set());
              countIdToChunkIndices.get(cid).add(chunkIndex);
            }
          }
          current = [];
          currentSize = 2;
        }
        current.push(part);
        currentSize += partStr.length + 1;
      }
    }
  }
  if (current.length > 0) {
    const chunkIndex = payloads.length;
    payloads.push(current);
    for (const it of current) {
      const cid = it?.id ?? it?.countId;
      if (cid) {
        if (!countIdToChunkIndices.has(cid)) countIdToChunkIndices.set(cid, new Set());
        countIdToChunkIndices.get(cid).add(chunkIndex);
      }
    }
  }

  const mutation = `#graphql
    mutation SetInventoryCounts($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id namespace key }
        userErrors { field message }
      }
    }`;

  if (payloads.length === 0) {
    const metafields = [
      { ownerId, namespace: NS, key: INVENTORY_COUNTS_KEY, type: "json", value: "[]" },
      { ownerId, namespace: NS, key: INVENTORY_COUNTS_LIST_KEY, type: "json", value: "[]" },
      { ownerId, namespace: NS, key: INVENTORY_COUNT_INDEX_KEY, type: "json", value: "{}" },
    ];
    const res = await graphql(mutation, { metafields });
    const errs = res?.metafieldsSet?.userErrors ?? [];
    if (errs.length) throw new Error(errs.map((e) => e.message).join(" / "));
    return;
  }

  if (payloads.length === 1 && payloads[0].length === 1 && !payloads[0][0]._part) {
    const full = JSON.stringify(payloads[0]);
    if (full.length <= INVENTORY_COUNTS_CHUNK_BYTES) {
      const res = await graphql(mutation, {
        metafields: [{ ownerId, namespace: NS, key: INVENTORY_COUNTS_KEY, type: "json", value: full }],
      });
      const errs = res?.metafieldsSet?.userErrors ?? [];
      if (errs.length) throw new Error(errs.map((e) => e.message).join(" / "));
      return;
    }
  }

  const chunks = payloads.map((p) => JSON.stringify(p));
  const descriptor = JSON.stringify({ _chunked: true, totalChunks: chunks.length });
  const metafields = [
    { ownerId, namespace: NS, key: INVENTORY_COUNTS_KEY, type: "json", value: descriptor },
    ...chunks.map((value, i) => ({
      ownerId,
      namespace: NS,
      key: `${INVENTORY_COUNTS_CHUNK_KEY_PREFIX}${i}`,
      type: "json",
      value,
    })),
  ];
  for (let i = 0; i < metafields.length; i += METAFIELDS_SET_MAX) {
    const batch = metafields.slice(i, i + METAFIELDS_SET_MAX);
    const res = await graphql(mutation, { metafields: batch });
    const errs = res?.metafieldsSet?.userErrors ?? [];
    if (errs.length) throw new Error(errs.map((e) => e.message).join(" / "));
  }

  const listItems = arr.map(toMinimalCountForList).filter(Boolean);
  const listPayloads = [];
  let listCurrent = [];
  let listCurrentSize = 2;
  for (const item of listItems) {
    const itemStr = JSON.stringify(item);
    if (listCurrentSize + itemStr.length + 1 > INVENTORY_COUNTS_CHUNK_BYTES && listCurrent.length > 0) {
      listPayloads.push(JSON.stringify(listCurrent));
      listCurrent = [];
      listCurrentSize = 2;
    }
    listCurrent.push(item);
    listCurrentSize += itemStr.length + 1;
  }
  if (listCurrent.length > 0) listPayloads.push(JSON.stringify(listCurrent));

  const listDescriptor = JSON.stringify({ _chunked: true, totalChunks: listPayloads.length });
  const indexValue = JSON.stringify(
    Object.fromEntries([...countIdToChunkIndices].map(([id, set]) => [id, [...set].sort((a, b) => a - b)]))
  );
  const listMetafields = [
    { ownerId, namespace: NS, key: INVENTORY_COUNTS_LIST_KEY, type: "json", value: listDescriptor },
    ...listPayloads.map((value, i) => ({
      ownerId,
      namespace: NS,
      key: `${INVENTORY_COUNTS_LIST_CHUNK_PREFIX}${i}`,
      type: "json",
      value,
    })),
    { ownerId, namespace: NS, key: INVENTORY_COUNT_INDEX_KEY, type: "json", value: indexValue },
  ];
  for (let i = 0; i < listMetafields.length; i += METAFIELDS_SET_MAX) {
    const batch = listMetafields.slice(i, i + METAFIELDS_SET_MAX);
    const res = await graphql(mutation, { metafields: batch });
    const errs = res?.metafieldsSet?.userErrors ?? [];
    if (errs.length) throw new Error(errs.map((e) => e.message).join(" / "));
  }
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

/** 一覧用：商品グループID一覧のみ（軽量。未設定時は readProductGroups から導出） */
export async function readProductGroupIds() {
  const gql = `#graphql
    query ProductGroupIds {
      currentAppInstallation {
        metafield(namespace: "${NS}", key: "${PRODUCT_GROUP_IDS_KEY}") { value }
      }
    }`;
  try {
    const d = await graphql(gql);
    const raw = d?.currentAppInstallation?.metafield?.value ?? null;
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length > 0) return new Set(arr.map(String));
    }
  } catch {}
  const groups = await readProductGroups();
  return new Set((groups || []).map((g) => String(g.id)));
}

/** 一覧用：商品グループID→名前のみ（軽量。未設定時は readProductGroups から導出） */
export async function readProductGroupNames() {
  const gql = `#graphql
    query ProductGroupNames {
      currentAppInstallation {
        metafield(namespace: "${NS}", key: "${PRODUCT_GROUP_NAMES_KEY}") { value }
      }
    }`;
  try {
    const d = await graphql(gql);
    const raw = d?.currentAppInstallation?.metafield?.value ?? null;
    if (raw) {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === "object") return obj;
    }
  } catch {}
  const groups = await readProductGroups();
  return Object.fromEntries((groups || []).map((g) => [String(g.id), g.name ?? ""]));
}

// 商品グループに含まれる商品を取得（コレクションから）
// 単一商品グループ用（後方互換性のため残す）
export async function fetchProductsByGroup(productGroupId, locationId) {
  return fetchProductsByGroups([productGroupId], locationId);
}

// IDの正規化：GIDと数値IDの両方で照合できるようにする（管理画面とPOSで形式が異なる場合の対策）
// 商品グループ名の Map キー統一用に export（InventoryCountList 等で利用）
export function normalizeIdForMatch(id) {
  const s = String(id ?? "").trim();
  const lastSegment = s.split("/").pop() || s;
  return lastSegment;
}

// groupItems のキー照合（GID と数値 ID の混在で取れない不具合対策。管理画面とPOSで明細数・在庫数が一致するようにする）
export function getGroupItemsByKey(groupItemsMap, groupId) {
  if (!groupId || !groupItemsMap || typeof groupItemsMap !== "object") return [];
  if (Array.isArray(groupItemsMap[groupId])) return groupItemsMap[groupId];
  const n = normalizeIdForMatch(groupId);
  const key = Object.keys(groupItemsMap).find((k) => normalizeIdForMatch(k) === n);
  return key && Array.isArray(groupItemsMap[key]) ? groupItemsMap[key] : [];
}

function findInventoryItemIdsByGroupKey(inventoryItemIdsByGroup, groupId) {
  if (!inventoryItemIdsByGroup || typeof inventoryItemIdsByGroup !== "object") return undefined;
  if (inventoryItemIdsByGroup[groupId]) return inventoryItemIdsByGroup[groupId];
  const normalized = normalizeIdForMatch(groupId);
  const key = Object.keys(inventoryItemIdsByGroup).find(
    (k) => k === groupId || normalizeIdForMatch(k) === normalized
  );
  return key ? inventoryItemIdsByGroup[key] : undefined;
}

// 複数商品グループに含まれる商品を取得（コレクションから）
// locationIdが指定されている場合、在庫レベルがある商品のみを返す（初期表示用）
// ✅ inventoryItemIdsByGroupが指定されている場合は、それを使用して商品をフィルタリング（生成時の状態を保持）
// ✅ cachedProductGroups を渡すと readProductGroups() をスキップし、まとめて表示で全グループが同じスナップショットを参照して安定表示
export async function fetchProductsByGroups(productGroupIds, locationId, opts = {}) {
  const { filterByInventoryLevel = true, includeImages = false, inventoryItemIdsByGroup = null, cachedProductGroups = null, offset: optsOffset = 0, limit: optsLimit, collectionPageInfo: optsCollectionPageInfo = null, timeoutMs: optsTimeoutMs } = opts;
  const offset = Math.max(0, Number(optsOffset) || 0);
  const limit = optsLimit != null && optsLimit > 0 ? Math.max(1, Math.min(Number(optsLimit), 2000)) : null;
  /** タイムアウト：初回60秒・追加読み込み90秒（39グループ・約5600SKU等で20秒だと切れるため） */
  const timeoutMs = Number.isFinite(Number(optsTimeoutMs)) ? Number(optsTimeoutMs) : (offset > 0 ? 90000 : 60000);
  /** コレクション経路の「さらに読み込む」用。前回レスポンスの pageInfo を渡すと after で次ページを取得する */
  const collectionPageInfo = optsCollectionPageInfo && typeof optsCollectionPageInfo === "object" ? optsCollectionPageInfo : null;
  const rawGroups = (Array.isArray(cachedProductGroups) && cachedProductGroups.length > 0)
    ? cachedProductGroups
    : await readProductGroups();
  // ✅ null/undefined 対策：readProductGroups や cachedProductGroups が null の場合でも .filter で落ちないようにする
  const groups = Array.isArray(rawGroups) ? rawGroups : [];
  // ✅ まとめて表示で2つ目以降のグループが取れない対策：IDの正規化で照合（GIDと数値の差を吸収）
  const normalizedIds = new Set((productGroupIds || []).map(normalizeIdForMatch));
  const targetGroups = groups.filter(
    (g) => Array.isArray(productGroupIds) && (productGroupIds.includes(g.id) || normalizedIds.has(normalizeIdForMatch(g.id)))
  );
  if (targetGroups.length === 0) return [];

  const effectiveFirst = Math.max(1, Math.min(250, Number(opts?.productFirst ?? opts?.initialLimit ?? 250)));
  let hasMoreFromSavedIds = false;
  let usedSavedIdsPath = false;
  /** コレクション経路用：各コレクションの pageInfo（さらに読み込むでクライアントに返し、次回 after で渡す） */
  let collectionPageInfoResult = {};
  const allVariants = [];
  for (const group of targetGroups) {
    // ✅ inventoryItemIdsByGroupが指定されている場合は、それを使用（生成時の状態を保持）
    // ✅ キー照合を正規化して行い、管理画面とPOSでID形式が違っても取得できるようにする
    let idsToUse = findInventoryItemIdsByGroupKey(inventoryItemIdsByGroup, group.id);
    // ✅ CSV等でコレクションなしのグループ：棚卸に inventoryItemIdsByGroup が無い場合、product_groups_v1 の group.inventoryItemIds で取得（商品検索・CSVから作成はマスト）
    if ((!idsToUse || !Array.isArray(idsToUse) || idsToUse.length === 0) && Array.isArray(group.inventoryItemIds) && group.inventoryItemIds.length > 0) {
      idsToUse = group.inventoryItemIds;
    }
    if (idsToUse && Array.isArray(idsToUse) && idsToUse.length > 0) {
      // ✅ 表示件数：limit が明示されていればその範囲まで取得（単一グループ全件用）。未指定時は effectiveFirst でまとめて表示の負荷を抑える
      // ✅ 初回は limit 指定時は limit まで、未指定は effectiveFirst 件まで。さらに読み込むは offset + limit で続きを取得
      const pageSize = offset === 0
        ? (limit != null && limit > 0 ? Math.min(limit, 2000) : effectiveFirst)
        : (limit ?? effectiveFirst);
      const idsToFetch = idsToUse.slice(offset, offset + pageSize);
      if (idsToUse.length > offset + idsToFetch.length) hasMoreFromSavedIds = true;
      usedSavedIdsPath = true;
      const batchSize = 50;
      const groupVariants = []; // このグループ分だけ貯め、skus順（idsToFetch順）でソートしてから allVariants に追加
      for (let i = 0; i < idsToFetch.length; i += batchSize) {
        const batch = idsToFetch.slice(i, i + batchSize);
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
          const data = await graphql(gql, { ids: batch }, { timeoutMs });
          const nodes = data?.nodes ?? [];
          for (const node of nodes) {
            if (node?.variant && node.id) {
              const v = node.variant;
              const p = v.product || {};
              groupVariants.push({
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
      // ✅ 表示は常に skus の並び（idsToFetch＝inventoryItemIdsByGroup の順）に合わせる
      const idToIndex = new Map(idsToFetch.map((id, idx) => [String(id).trim(), idx]));
      groupVariants.sort((a, b) => (idToIndex.get(String(a.inventoryItemId).trim()) ?? 999999) - (idToIndex.get(String(b.inventoryItemId).trim()) ?? 999999));
      allVariants.push(...groupVariants);
      continue; // ✅ 保存されたinventoryItemIdsを使用した場合は、通常のコレクション取得処理をスキップ
    }
    
    // ✅ 通常の処理：コレクションから商品を取得（初回は first のみ、さらに読み込むは after で次ページ取得）
    if (!group.collectionIds?.length) continue;
    const productFirst = Math.max(1, Math.min(250, Number(opts?.productFirst ?? opts?.initialLimit ?? 250)));
    for (const collectionId of group.collectionIds) {
      // ✅ さらに読み込む時：このコレクションに cursor がある場合のみ次ページを取得
      if (offset > 0 && collectionPageInfo) {
        const pageInfo = collectionPageInfo[collectionId];
        if (!pageInfo?.hasNextPage || !pageInfo?.endCursor) continue;
        const gqlWithPageInfo = includeImages
          ? `#graphql
            query CollectionProductsPage($id: ID!, $first: Int!, $after: String) {
              collection(id: $id) {
                products(first: $first, after: $after) {
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
                  pageInfo { hasNextPage endCursor }
                }
              }
            }`
          : `#graphql
            query CollectionProductsPage($id: ID!, $first: Int!, $after: String) {
              collection(id: $id) {
                products(first: $first, after: $after) {
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
                  pageInfo { hasNextPage endCursor }
                }
              }
            }`;
        try {
          const data = await graphql(gqlWithPageInfo, { id: collectionId, first: productFirst, after: pageInfo.endCursor }, { timeoutMs });
          const products = data?.collection?.products?.nodes ?? [];
          const nextPageInfo = data?.collection?.products?.pageInfo ?? {};
          collectionPageInfoResult[collectionId] = { hasNextPage: !!nextPageInfo.hasNextPage, endCursor: nextPageInfo.endCursor ?? null };
          const collectionConfig = group.collectionConfigs?.find((c) => c.collectionId === collectionId);
          const selectedVariantIds = collectionConfig?.selectedVariantIds || [];
          const shouldFilterBySelected = selectedVariantIds.length > 0;
          for (const p of products) {
            const variants = p.variants?.nodes ?? [];
            for (const v of variants) {
              if (v.inventoryItem?.id) {
                if (shouldFilterBySelected && !selectedVariantIds.includes(v.id)) continue;
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
          console.error(`Collection ${collectionId} (next page) fetch error:`, e);
        }
        continue;
      }
      if (offset > 0) continue; // ✅ さらに読み込む時でこのコレクションに cursor がない場合はスキップ（初回取得で重複させない）

      // ✅ 初回取得：pageInfo を取得して返し、さらに読み込むで after に渡す
      const collectionConfig = group.collectionConfigs?.find((c) => c.collectionId === collectionId);
      const selectedVariantIds = collectionConfig?.selectedVariantIds || [];
      const shouldFilterBySelected = selectedVariantIds.length > 0;
      const gql = includeImages
        ? `#graphql
          query CollectionProducts($id: ID!, $first: Int!, $after: String) {
            collection(id: $id) {
              products(first: $first, after: $after) {
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
                pageInfo { hasNextPage endCursor }
              }
            }
          }`
        : `#graphql
          query CollectionProducts($id: ID!, $first: Int!, $after: String) {
            collection(id: $id) {
              products(first: $first, after: $after) {
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
                pageInfo { hasNextPage endCursor }
              }
            }
          }`;
      try {
        const data = await graphql(gql, { id: collectionId, first: productFirst, after: null }, { timeoutMs });
        const products = data?.collection?.products?.nodes ?? [];
        const pageInfo = data?.collection?.products?.pageInfo ?? {};
        collectionPageInfoResult[collectionId] = { hasNextPage: !!pageInfo.hasNextPage, endCursor: pageInfo.endCursor ?? null };
        for (const p of products) {
          const variants = p.variants?.nodes ?? [];
          for (const v of variants) {
            if (v.inventoryItem?.id) {
              if (shouldFilterBySelected && !selectedVariantIds.includes(v.id)) continue;
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

  // ✅ コレクション経路で「さらに読み込む」時は allVariants が「次ページ分だけ」なので offset でスライスしない
  const usedCollectionCursorPath = offset > 0 && collectionPageInfo && Object.keys(collectionPageInfoResult).length > 0;
  const hasMoreFromCollection = Object.values(collectionPageInfoResult).some((p) => p.hasNextPage);
  const variantsToProcess = usedSavedIdsPath
    ? uniqueVariants
    : usedCollectionCursorPath
      ? (limit != null ? uniqueVariants.slice(0, limit) : uniqueVariants)
      : (limit != null ? uniqueVariants.slice(offset, offset + limit) : uniqueVariants);
  // ✅ 初回(offset=0)で「1ページ分(effectiveFirst)以上」返している場合は hasMore を true にし、上限数以上あるのにさらに読み込みが出ない事態を防ぐ
  let hasMore = limit != null
    ? (uniqueVariants.length > offset + limit || hasMoreFromSavedIds || hasMoreFromCollection)
    : false;
  if (limit != null && offset === 0 && uniqueVariants.length >= effectiveFirst && !hasMore) {
    hasMore = true;
  }
  const mergedCollectionPageInfo = collectionPageInfo
    ? { ...collectionPageInfo, ...collectionPageInfoResult }
    : collectionPageInfoResult;

  // 在庫レベルでフィルタリング（初期表示用）・一括取得で currentQuantity 付きで返す
  if (filterByInventoryLevel && locationId && variantsToProcess.length > 0) {
    const ids = variantsToProcess.map((v) => v.inventoryItemId).filter(Boolean);
    const qtyMap = await getCurrentQuantitiesBulk(ids, locationId, { timeoutMs });
    const variantsWithInventory = variantsToProcess
      .map((v) => {
        const qty = v.inventoryItemId != null ? qtyMap.get(v.inventoryItemId) : null;
        if (qty !== null && qty !== undefined) return { ...v, currentQuantity: qty };
        return null;
      })
      .filter((r) => r != null);
    if (limit != null) {
      const out = { products: variantsWithInventory, hasMore };
      if (Object.keys(mergedCollectionPageInfo).length > 0) out.collectionPageInfo = mergedCollectionPageInfo;
      return out;
    }
    return variantsWithInventory;
  }

  if (limit != null) {
    const out = { products: variantsToProcess, hasMore };
    if (Object.keys(mergedCollectionPageInfo).length > 0) out.collectionPageInfo = mergedCollectionPageInfo;
    return out;
  }
  if (hasMoreFromSavedIds) return { products: variantsToProcess, hasMore: true };
  return variantsToProcess;
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
  const timeoutMs = Number.isFinite(Number(opts?.timeoutMs)) ? Number(opts.timeoutMs) : 60000;
  try {
    const d = await graphql(gql, { id: inventoryItemId, loc: locationId }, { timeoutMs });
    const level = d?.inventoryItem?.inventoryLevel;
    if (!level) return null; // 在庫レベルが存在しない
    const qty = level.quantities?.find((x) => x.name === "available")?.quantity;
    return qty !== null && qty !== undefined ? Number(qty) : 0;
  } catch (e) {
    // エラー時はnullを返す（在庫レベルがない商品として扱う）
    return null;
  }
}

/** 複数商品の在庫数を1リクエストで取得（nodes クエリで高速化）。返却: Map<inventoryItemId, number> */
const BULK_QTY_IDS_PER_REQUEST = 50;

export async function getCurrentQuantitiesBulk(inventoryItemIds, locationId, opts = {}) {
  const ids = (inventoryItemIds || []).filter((id) => id != null && String(id).trim() !== "");
  if (ids.length === 0) return new Map();
  const loc = toLocationGid(locationId);
  if (!loc) return new Map();
  const timeoutMs = Number.isFinite(Number(opts?.timeoutMs)) ? Number(opts.timeoutMs) : 60000;
  const noCache = opts?.noCache === true;
  const cacheBuster = noCache ? `_${Date.now()}` : "";
  const out = new Map();
  for (let i = 0; i < ids.length; i += BULK_QTY_IDS_PER_REQUEST) {
    const batch = ids.slice(i, i + BULK_QTY_IDS_PER_REQUEST);
    const gql = `#graphql
      query BulkCurrentQuantities${cacheBuster}($ids: [ID!]!, $loc: ID!) {
        nodes(ids: $ids) {
          ... on InventoryItem {
            id
            inventoryLevel(locationId: $loc) {
              quantities(names: ["available"]) { name quantity }
            }
          }
        }
      }`;
    try {
      const d = await graphql(gql, { ids: batch, loc }, { timeoutMs });
      const nodes = d?.nodes ?? [];
      for (const node of nodes) {
        if (!node?.id) continue;
        const level = node.inventoryLevel;
        const qty = level?.quantities?.find((x) => x.name === "available")?.quantity;
        const num = qty !== null && qty !== undefined ? Number(qty) : 0;
        out.set(node.id, num);
      }
    } catch (e) {
      console.error(`getCurrentQuantitiesBulk batch error (${batch.length} ids):`, e);
      for (const id of batch) out.set(id, 0);
    }
  }
  return out;
}

// locationIdをGID形式に変換（ロスと同じ処理）
export function toLocationGid(s) {
  if (!s) return null;
  const str = String(s).trim();
  if (str.startsWith("gid://shopify/Location/")) return str;
  if (/^\d+$/.test(str)) return `gid://shopify/Location/${str}`;
  const m = str.match(/Location\/(\d+)/);
  if (m?.[1]) return `gid://shopify/Location/${m[1]}`;
  if (str.includes("gid://")) return str;
  return null;
}

// ロケーションIDから数値部分のみ抽出（フィルタ比較用・GID/数値混在でも一致させる）
export function toLocationNumericId(s) {
  if (!s) return null;
  const str = String(s).trim();
  if (/^\d+$/.test(str)) return str;
  const m = str.match(/Location\/(\d+)/);
  return m?.[1] ?? null;
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

/**
 * 指定ロケーションで在庫レベルがないアイテムを有効化する（inventoryActivate）。
 * inventorySetQuantities は「ロケーションに在庫レベルがない」と失敗するため、
 * 確定前にこの処理を行う。
 * @param {{ locationGid: string, items: Array<{ inventoryItemId: string, quantity: number }> }}
 * @returns {{ ok: boolean, activated: Array, errors: Array }}
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
      // nodes に含まれなかった ID（存在しない or null）も有効化対象にする（漏れで「在庫がありません」エラーになるのを防ぐ）
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
            // 追跡ONに失敗しても activate を試す（既に追跡ONの場合は成功する）
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

// 在庫を実数に設定（ロスと同じ処理方法：inventorySetQuantitiesで絶対値設定）
export async function adjustInventoryToActual({ locationId, items, referenceDocumentUri }) {
  // items: [{ inventoryItemId, currentQuantity, actualQuantity }]
  // 実数（actualQuantity）を直接設定する
  const locationGid = toLocationGid(locationId);
  if (!locationGid) {
    throw new Error(`無効なロケーションID: ${locationId}`);
  }

  // ✅ 棚卸はマイナス在庫も入力可能なため Math.max(0,...) を適用しない
  const validItems = (items ?? []).filter((x) => x?.inventoryItemId && Number.isFinite(Number(x?.actualQuantity)));
  const quantitiesWithStatus = validItems.map((x) => {
    const inventoryItemGid = toInventoryItemGid(x.inventoryItemId);
    if (!inventoryItemGid) return { valid: false, item: x };
    const quantity = Math.floor(Number(x.actualQuantity) || 0);
    return { valid: true, inventoryItemId: inventoryItemGid, quantity, compareQuantity: 0 };
  });

  const quantities = quantitiesWithStatus.filter((x) => x.valid);
  const invalidCount = quantitiesWithStatus.filter((x) => !x.valid).length;

  // ✅ 不正な inventoryItemId を検出して通知
  if (invalidCount > 0) {
    console.warn(`[adjustInventoryToActual] ${invalidCount}件の不正なinventoryItemIdを除外しました`);
  }

  // ✅ ignoreCompareQuantity: true で比較チェックをスキップ（確定エラー防止）
  // ※ compareQuantity は必須フィールドのため 0 を渡すが、ignoreCompareQuantity により無視される

  if (!locationId || quantities.length === 0) {
    if (quantities.length === 0 && (items ?? []).length > 0) {
      const errMsg = invalidCount > 0 
        ? `有効な在庫アイテムIDがありません（${invalidCount}件が不正なIDのため除外されました）`
        : "有効な在庫アイテムIDがありません";
      throw new Error(errMsg);
    }
    return { adjustmentGroup: null, invalidCount, processedCount: 0 };
  }

  // ロケーションに在庫レベルがないアイテムがあると inventorySetQuantities が失敗するため、先に在庫有効化する（除外せず全件成功するまでリトライ）
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

  // referenceDocumentUriを生成（棚卸IDが指定されている場合）
  const uri = referenceDocumentUri ? `gid://stock-transfer-pos/InventoryCount/${referenceDocumentUri}` : null;

  // ✅ リトライ処理（ネットワークエラー・タイムアウト対応）
  const maxRetries = 3;
  const retryDelayMs = 1000;
  
  const m = `#graphql
    mutation Set($input: InventorySetQuantitiesInput!) {
      inventorySetQuantities(input: $input) {
        inventoryAdjustmentGroup { id }
        userErrors { field message }
      }
    }`;
  
  const input = {
    name: "available",
    reason: "correction",
    ignoreCompareQuantity: true,
    quantities: quantities.map((q) => ({
      inventoryItemId: q.inventoryItemId,
      locationId: locationGid,
      quantity: q.quantity,
      compareQuantity: q.compareQuantity,
    })),
  };
  
  // referenceDocumentUriが指定されている場合は追加
  if (uri) {
    input.referenceDocumentUri = uri;
  }

  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const d = await graphql(m, { input });
      
      // レスポンスが空の場合はエラー
      if (!d || !d.inventorySetQuantities) {
        throw new Error("GraphQL response is invalid");
      }
      
      const errs = d?.inventorySetQuantities?.userErrors ?? [];
      if (errs.length) throw new Error(errs.map((e) => e.message).join(" / "));
      
      // ✅ 成功時は不正ID件数も返す（全件有効化済みのため除外なし）
      return { 
        adjustmentGroup: d.inventorySetQuantities.inventoryAdjustmentGroup ?? null,
        invalidCount,
        processedCount: quantities.length,
      };
    } catch (e) {
      lastError = e;
      const msg = String(e?.message ?? e);
      const isRetryable = msg.includes("timeout") || msg.includes("network") || msg.includes("fetch") || msg.includes("HTTP 5");
      
      if (!isRetryable || attempt === maxRetries) {
        break;
      }
      
      console.warn(`[adjustInventoryToActual] リトライ ${attempt}/${maxRetries}: ${msg}`);
      await new Promise(resolve => setTimeout(resolve, retryDelayMs * attempt));
    }
  }
  
  const msg = String(lastError?.message ?? lastError);
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
  throw lastError;
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

// 商品グループ名取得用キャッシュ（一覧の名前表示で readProductGroups を繰り返し呼ばないように入庫並みに軽く）
const PRODUCT_GROUPS_CACHE_TTL_MS = 60000;
let productGroupsCache = { groups: null, at: 0 };
let productGroupNamesCache = { names: null, at: 0 };

export async function getProductGroupName(productGroupId) {
  if (!productGroupId) return null;
  const now = Date.now();
  if (!productGroupNamesCache.names || now - productGroupNamesCache.at > PRODUCT_GROUPS_CACHE_TTL_MS) {
    productGroupNamesCache = { names: await readProductGroupNames(), at: now };
  }
  const names = productGroupNamesCache.names || {};
  const n = normalizeIdForMatch(productGroupId);
  let name = names[productGroupId] ?? names[n];
  if (name != null) return name;
  const k = Object.keys(names).find((id) => normalizeIdForMatch(id) === n);
  if (k != null) return names[k];
  if (!productGroupsCache.groups || now - productGroupsCache.at > PRODUCT_GROUPS_CACHE_TTL_MS) {
    productGroupsCache = { groups: await readProductGroups(), at: now };
  }
  const group = productGroupsCache.groups?.find((g) => g.id === productGroupId || normalizeIdForMatch(g.id) === n);
  return group?.name ?? null;
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
  const result = await searchVariants(code, { includeImages, first: 50 });
  const list = result?.nodes ?? [];
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

// アプリ設定取得（棚卸用・ロス拡張と同じ AppInstallation metafield）
const SETTINGS_NS = "stock_transfer_pos";
const SETTINGS_KEY = "settings_v1";

function safeParseJson(raw, defaultVal) {
  if (raw == null || raw === "") return defaultVal;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === "object" ? parsed : defaultVal;
  } catch {
    return defaultVal;
  }
}

// 設定取得の簡易キャッシュ（getStocktakeListLimit 経由の初回読み込み遅延を軽減。TTL 2分）
const SETTINGS_CACHE_TTL_MS = 2 * 60 * 1000;
let settingsCache = { data: null, expiresAt: 0 };

export async function fetchSettings() {
  const now = Date.now();
  if (settingsCache.data != null && settingsCache.expiresAt > now) {
    return settingsCache.data;
  }
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
    const fallbackShape = {
      version: 1,
      carriers: [],
      outbound: { historyInitialLimit: 100 },
      productList: { initialLimit: 250 },
      searchList: { initialLimit: 50 },
      inventoryCount: { allowExtraCount: true },
    };
    const result =
      parsed && parsed.version === 1
        ? { ...fallbackShape, ...parsed, inventoryCount: { allowExtraCount: true, ...(parsed.inventoryCount || {}) } }
        : fallbackShape;
    settingsCache = { data: result, expiresAt: now + SETTINGS_CACHE_TTL_MS };
    return result;
  } catch (e) {
    console.error("[fetchSettings] error:", e);
    const fallback = {
      version: 1,
      carriers: [],
      outbound: { historyInitialLimit: 100 },
      productList: { initialLimit: 250 },
      searchList: { initialLimit: 50 },
      inventoryCount: { allowExtraCount: false },
    };
    settingsCache = { data: fallback, expiresAt: now + SETTINGS_CACHE_TTL_MS };
    return fallback;
  }
}
