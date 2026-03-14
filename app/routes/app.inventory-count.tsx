// app/routes/app.inventory-count.tsx
// 棚卸（商品グループ設定・棚卸ID発行・履歴管理）画面
import { randomBytes } from "crypto";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { useState, useMemo, useEffect, useRef } from "react";
import { authenticate } from "../shopify.server";
import { withGraphQLRetry } from "../utils/graphql-with-retry";
import { getDateInShopTimezone, extractDateFromISO, formatDateTimeInShopTimezone, getShopTimezone } from "../utils/timezone";
import db from "../db.server";

const NS = "stock_transfer_pos";
const PRODUCT_GROUPS_KEY = "product_groups_v1";
const INVENTORY_COUNTS_KEY = "inventory_counts_v1";
const SETTINGS_KEY = "settings_v1";
const INVENTORY_COUNTS_LIST_KEY = "inventory_counts_list_v1";
const INVENTORY_COUNTS_LIST_CHUNK_PREFIX = "inventory_counts_list_v1_c";
const INVENTORY_COUNT_INDEX_KEY = "inventory_count_index_v1";
const INVENTORY_COUNTS_BACKUP_KEY = "inventory_counts_backup_v1";
const INVENTORY_COUNTS_BACKUP_MAX_BYTES = 60_000;
/** 次の棚卸番号（#C0001 の 1 部分）。チャンクを読まずに新規発行するために使用 */
const INVENTORY_COUNT_NEXT_KEY = "inventory_count_next_v1";
/** 楽観ロック用。保存のたびに +1 し、同時編集で競合検出に使う */
const INVENTORY_COUNTS_VERSION_KEY = "inventory_counts_version_v1";
const PRODUCT_GROUP_IDS_KEY = "product_group_ids_v1";
const PRODUCT_GROUP_NAMES_KEY = "product_group_names_v1";

/**
 * 管理画面・POS で全明細を確実に読むため：1チャンクあたりの最大バイト数。
 * GraphQL のメタフィールド応答が大きいと切り詰められるため、32KB に抑えて確実に全件読めるようにする。
 * 1件の棚卸がこれを超える場合は groupItems/items を複数パートに分割して保存する。
 */
const INVENTORY_COUNTS_CHUNK_BYTES = 32_000;
const INVENTORY_COUNTS_CHUNK_KEY_PREFIX = "inventory_counts_v1_c";
const METAFIELDS_SET_MAX = 25;
const ADMIN_GRAPHQL_API_VERSION = "2026-01";

/** 商品グループ保存用メタフィールド（本體・ID一覧・ID→名前）。POS の一覧で軽量読取用 */
function productGroupsMetafields(
  ownerId: string,
  productGroups: Array<{ id: string; name?: string | null }>
): Array<{ ownerId: string; namespace: string; key: string; type: string; value: string }> {
  return [
    { ownerId, namespace: NS, key: PRODUCT_GROUPS_KEY, type: "json", value: JSON.stringify(productGroups) },
    { ownerId, namespace: NS, key: PRODUCT_GROUP_IDS_KEY, type: "json", value: JSON.stringify(productGroups.map((g) => g.id)) },
    { ownerId, namespace: NS, key: PRODUCT_GROUP_NAMES_KEY, type: "json", value: JSON.stringify(Object.fromEntries(productGroups.map((g) => [g.id, g.name ?? ""]))) },
  ];
}

/** 1件の棚卸が CHUNK_BYTES を超える場合の「パート」形式（読込時に結合する） */
type CountPart = {
  _part: true;
  countId: string;
  partIndex: number;
  totalParts: number;
  countMeta?: Record<string, unknown>;
  groupItems?: Record<string, unknown[]>;
  items?: unknown[];
};

// 棚卸履歴CSV列（設定の「棚卸履歴CSV出力項目設定」と一致。明細あり用）
const STOCKTAKE_CSV_COLUMN_IDS = [
  "countId", "name", "date", "completedDate", "location", "productGroup", "status",
  "productTitle", "sku", "barcode", "option1", "option2", "option3",
  "currentQty", "actualQty", "delta", "kind",
] as const;
const STOCKTAKE_SUMMARY_IDS = ["countId", "name", "date", "completedDate", "location", "productGroup", "status"];
const STOCKTAKE_CSV_LABELS: Record<string, string> = {
  countId: "棚卸ID", name: "名称", date: "日付", completedDate: "完了日", location: "ロケーション", productGroup: "商品グループ", status: "ステータス",
  productTitle: "商品名", sku: "SKU", barcode: "JAN", option1: "オプション1", option2: "オプション2", option3: "オプション3",
  currentQty: "在庫", actualQty: "実数", delta: "差分", kind: "種別",
};
const DEFAULT_STOCKTAKE_CSV_COLUMNS = [...STOCKTAKE_CSV_COLUMN_IDS];

/**
 * 商品名＋オプション表示用に title を分解する。
 * 区切りは " / "（スペース+スラッシュ+スペース）のみ。オプション値内の "/"（例: iPhone7/8）は分割しない。
 * item に option1/option2/option3 がある場合はそれを優先する。
 */
function parseTitleToProductAndOptions(
  titleRaw: string,
  item?: { option1?: string; option2?: string; option3?: string }
): { productName: string; option1: string; option2: string; option3: string } {
  const raw = String(titleRaw || "").trim();
  const hasExplicitOptions = item && (
    (item.option1 !== undefined && item.option1 !== "") ||
    (item.option2 !== undefined && item.option2 !== "") ||
    (item.option3 !== undefined && item.option3 !== "")
  );
  if (hasExplicitOptions) {
    const productName = raw.includes(" / ") ? raw.split(" / ")[0].trim() || raw : raw;
    return {
      productName: productName || "（商品名なし）",
      option1: String(item!.option1 ?? "").trim(),
      option2: String(item!.option2 ?? "").trim(),
      option3: String(item!.option3 ?? "").trim(),
    };
  }
  const idx = raw.indexOf(" / ");
  if (idx >= 0) {
    const productName = raw.slice(0, idx).trim();
    const variantPart = raw.slice(idx + 3).trim();
    return { productName: productName || raw, option1: variantPart, option2: "", option3: "" };
  }
  return { productName: raw || "（商品名なし）", option1: "", option2: "", option3: "" };
}

// POS と同一の正規化：groupItems キー照合で管理画面とタイルの表示を一致させる
export function normalizeIdForMatch(id: string | number | undefined | null): string {
  const s = String(id ?? "").trim();
  const lastSegment = s.split("/").pop() || s;
  return lastSegment;
}

/** 同一ショップで複数ブラウザが重い棚卸モーダルを同時に開いた際の負荷軽減：get_incomplete_group_products のレスポンスをショップ・棚卸・グループ・offset 単位でキャッシュ（TTL 2 分）。棚卸更新時に無効化。 */
const INCOMPLETE_GROUP_PRODUCTS_CACHE_TTL_MS = 2 * 60 * 1000;
const incompleteGroupProductsCache = new Map<
  string,
  { data: { ok: true; countId: string; groupId: string; products: unknown[]; hasMore: boolean; offset: number }; expiresAt: number }
>();
function invalidateIncompleteGroupProductsCacheForCount(shop: string, countId: string) {
  const norm = normalizeIdForMatch(countId);
  const prefix = `incomplete:${shop}:${norm}:`;
  for (const key of incompleteGroupProductsCache.keys()) {
    if (key.startsWith(prefix)) incompleteGroupProductsCache.delete(key);
  }
}
export function getGroupItemsByKey(
  groupItemsMap: Record<string, unknown[]> | undefined,
  groupId: string
): unknown[] {
  if (!groupId || !groupItemsMap || typeof groupItemsMap !== "object") return [];
  if (Array.isArray(groupItemsMap[groupId])) return groupItemsMap[groupId];
  const n = normalizeIdForMatch(groupId);
  const key = Object.keys(groupItemsMap).find((k) => normalizeIdForMatch(k) === n);
  return key && Array.isArray(groupItemsMap[key]) ? groupItemsMap[key] : [];
}

/**
 * 表示用ステータス（保存はしない）。
 * 元の「完了なのに1グループ未完了」の誤表示を防ぐ：status=completed でも groupItems で未完了なら in_progress を返す。
 */
function getDisplayStatusForCount(c: InventoryCount | null | undefined): "draft" | "in_progress" | "completed" | "cancelled" {
  if (!c?.status) return "in_progress";
  if (c.status === "cancelled") return "cancelled";
  if (c.status !== "completed") return c.status as "draft" | "in_progress";
  const groupItemsMap = (c as any)?.groupItems && typeof (c as any).groupItems === "object" ? (c as any).groupItems as Record<string, unknown[]> : {};
  if (Object.keys(groupItemsMap).length === 0) return "completed";
  const allIds = Array.isArray(c.productGroupIds) && c.productGroupIds.length > 0 ? c.productGroupIds : (c.productGroupId ? [c.productGroupId] : []);
  if (allIds.length === 0) return "completed";
  const cancelledSet = new Set((Array.isArray((c as any).cancelledGroupIds) ? (c as any).cancelledGroupIds : []).map((id: string) => normalizeIdForMatch(id)));
  const allDone = allIds.every((id) => {
    if (cancelledSet.has(normalizeIdForMatch(id))) return true;
    const items = getGroupItemsByKey(groupItemsMap, id);
    return Array.isArray(items) && items.length > 0;
  });
  return allDone ? "completed" : "in_progress";
}

/** パート配列を1件の棚卸に結合する */
function mergeCountParts(parts: CountPart[]): InventoryCount {
  const sorted = [...parts].sort((a, b) => a.partIndex - b.partIndex);
  const first = sorted[0];
  const base = (first?.countMeta ? { ...first.countMeta } : {}) as Record<string, unknown>;
  if (!base.id && first?.countId) base.id = first.countId;
  const groupItems: Record<string, unknown[]> = {};
  const items: unknown[] = [];
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
  return base as InventoryCount;
}

const CHUNK_FETCH_CONCURRENCY = 8; // チャンク並列取得数（502/タイムアウト・レート制限のバランス）
const CHUNK_FETCH_RETRY = 2; // 2回リトライ（計3回）。Throttle・一時的な502を拾い直す
const CHUNK_FETCH_RETRY_DELAY_MS = 2000; // リトライ前の待機（Throttle 解消を待つ）
const CHUNK_WRITE_RETRY = 2; // 書き込み：2回リトライ（計3回）。503/Throttle を拾い直す
const CHUNK_WRITE_RETRY_DELAY_MS = 2000; // 書き込みリトライ前の待機

/**
 * GraphQL レスポンスを安全に JSON パースする。空や不正な body で「syntax error, unexpected end of file」等を防ぐ。
 */
async function safeJsonFromResponse(resp: Response): Promise<unknown> {
  const text = await resp.text();
  if (text == null || String(text).trim() === "") {
    throw new Error("API が空の応答を返しました。しばらくしてから再試行してください。");
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`API の応答の解析に失敗しました（${msg}）。しばらくしてから再試行してください。`);
  }
}

/**
 * ローダー用：.json() の代わりに使う。空 body やパース失敗時は throw せず defaultVal を返し、ページが落ちないようにする。
 * 「syntax error, unexpected end of file」の原因（空/不正な API 応答の .json()）を潰す。
 */
async function safeJsonFromResponseForLoader<T>(resp: Response, defaultVal: T): Promise<T | unknown> {
  let text: string;
  try {
    text = await resp.text();
  } catch {
    return defaultVal;
  }
  if (text == null || String(text).trim() === "") {
    return defaultVal;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return defaultVal;
  }
}

async function fetchOneChunk(
  admin: { graphql: (q: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response> },
  key: string,
  chunkIndex: number
): Promise<string | null> {
  const gql = `#graphql
    query InventoryCountChunk($key: String!) {
      currentAppInstallation {
        metafield(namespace: "${NS}", key: $key) { value }
      }
    }
  `;
  for (let attempt = 0; attempt <= CHUNK_FETCH_RETRY; attempt++) {
    try {
      if (attempt > 0) {
        await new Promise<void>((r) => setTimeout(r, CHUNK_FETCH_RETRY_DELAY_MS));
      }
      const resp = await admin.graphql(gql, { variables: { key } });
      const json = (await safeJsonFromResponseForLoader(resp, {})) as { data?: { currentAppInstallation?: { metafield?: { value?: string } } } };
      const chunkRaw = json?.data?.currentAppInstallation?.metafield?.value;
      if (chunkRaw != null && chunkRaw !== "") return chunkRaw;
    } catch (e) {
      if (attempt === CHUNK_FETCH_RETRY) {
        console.warn(`[inventory-count] chunk ${chunkIndex} fetch failed after retry:`, (e as Error)?.message ?? e);
        return null;
      }
    }
  }
  return null;
}

/** 管理者用：セッションで GraphQL を直接 fetch し、metafield.value のみ返す（admin.graphql の syntax error を避ける） */
async function graphqlMetafieldValueDirect(
  shop: string,
  accessToken: string,
  key: string
): Promise<string | null> {
  const gql = `#graphql query MetafieldByKey($key: String!) { currentAppInstallation { metafield(namespace: "${NS}", key: $key) { value } } }`;
  const resp = await fetch(`https://${shop}/admin/api/${ADMIN_GRAPHQL_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
    body: JSON.stringify({ query: gql.replace(/^#graphql\s*/m, "").trim(), variables: { key } }),
  });
  const data = (await safeJsonFromResponseForLoader(resp, {})) as Record<string, unknown>;
  return getMetafieldValueFromData(data ?? {});
}

/** 管理者用：メタフィールドの健全性チェック結果（throw しない） */
export type MetafieldHealthResult = {
  status: "ok" | "warning" | "error";
  message?: string;
  mainKey: "missing" | "single" | "chunked";
  mainTotalChunks?: number;
  mainChunksFound?: number;
  mainMissingChunkIndices?: number[];
  listKey?: "missing" | "single" | "chunked";
  listTotalChunks?: number;
};

/**
 * 管理者用：棚卸メタフィールドの状態を取得する。例外は出さず結果で返す。
 * session を渡すと GraphQL を直接 fetch し、admin.graphql の「syntax error, unexpected end of file」を避ける。
 */
export async function getMetafieldHealth(
  admin: { graphql: (q: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response> },
  session?: { shop?: string; accessToken?: string } | null
): Promise<MetafieldHealthResult> {
  const shop = session?.shop ?? "";
  const accessToken = session?.accessToken ?? "";
  const useDirectFetch = Boolean(shop && accessToken);
  const getMainValue = useDirectFetch
    ? () => graphqlMetafieldValueDirect(shop, accessToken, INVENTORY_COUNTS_KEY)
    : async () => {
        const mainGql = `#graphql query InventoryCountMain { currentAppInstallation { metafield(namespace: "${NS}", key: "${INVENTORY_COUNTS_KEY}") { value } } }`;
        const mainResp = await admin.graphql(mainGql);
        const mainJson = (await safeJsonFromResponseForLoader(mainResp, null)) as { data?: { currentAppInstallation?: { metafield?: { value?: string } } } } | null;
        return mainJson?.data?.currentAppInstallation?.metafield?.value ?? null;
      };
  const getChunkValue = useDirectFetch
    ? (i: number) => graphqlMetafieldValueDirect(shop, accessToken, `${INVENTORY_COUNTS_CHUNK_KEY_PREFIX}${i}`)
    : (i: number) => fetchOneChunk(admin, `${INVENTORY_COUNTS_CHUNK_KEY_PREFIX}${i}`, i);

  try {
    const raw = await getMainValue();
    if (raw == null || raw === "") {
      return { status: "ok", mainKey: "missing", message: "メインキーなし（棚卸データ未登録）" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { status: "error", mainKey: "single", message: "メインキーの値が不正なJSONです。" };
    }
    if (Array.isArray(parsed)) {
      return { status: "ok", mainKey: "single", message: `単一キー（${(parsed as unknown[]).length}件）` };
    }
    const desc = parsed as { _chunked?: boolean; totalChunks?: number };
    if (!desc?._chunked || typeof desc.totalChunks !== "number" || desc.totalChunks < 1) {
      return { status: "ok", mainKey: "single", message: "メインキー（非チャンク形式）" };
    }
    const totalChunks = desc.totalChunks;
    const BATCH = 25;
    const missing: number[] = [];
    for (let start = 0; start < totalChunks; start += BATCH) {
      const batch = Array.from({ length: Math.min(BATCH, totalChunks - start) }, (_, j) => start + j);
      const results = await Promise.all(batch.map((i) => getChunkValue(i)));
      results.forEach((v, j) => {
        if (v == null || v === "") missing.push(batch[j]);
      });
    }
    const onlyLastMissing = missing.length === 1 && missing[0] === totalChunks - 1;
    if (missing.length === 0) {
      return {
        status: "ok",
        mainKey: "chunked",
        mainTotalChunks: totalChunks,
        mainChunksFound: totalChunks,
        message: `チャンク形式（${totalChunks}件すべて存在）`,
      };
    }
    if (onlyLastMissing) {
      return {
        status: "warning",
        mainKey: "chunked",
        mainTotalChunks: totalChunks,
        mainChunksFound: totalChunks - 1,
        mainMissingChunkIndices: missing,
        message: `最終チャンク（${totalChunks - 1}）が欠落しています。修復可能です。`,
      };
    }
    return {
      status: "error",
      mainKey: "chunked",
      mainTotalChunks: totalChunks,
      mainChunksFound: totalChunks - missing.length,
      mainMissingChunkIndices: missing,
      message: `チャンク ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? " …" : ""} が欠落しています。最終チャンク以外の欠損は自動修復できません。`,
    };
  } catch (e) {
    console.warn("[inventory-count] getMetafieldHealth failed:", e instanceof Error ? e.message : e);
    return {
      status: "error",
      mainKey: "missing",
      message: "状態の取得に失敗しました: " + (e instanceof Error ? e.message : String(e)),
    };
  }
}

/**
 * 一覧用メタフィールド（list）をチャンク並列で読み込む。list が無い場合は空配列を返す。
 */
async function readInventoryCountsListChunked(admin: { graphql: (q: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response> }): Promise<InventoryCount[]> {
  const listResp = await admin.graphql(
    `#graphql
      query InventoryCountListMain {
        currentAppInstallation {
          metafield(namespace: "${NS}", key: "${INVENTORY_COUNTS_LIST_KEY}") { value }
        }
      }
    `
  );
  const listJson = (await safeJsonFromResponseForLoader(listResp, {})) as { data?: { currentAppInstallation?: { metafield?: { value?: string } } } };
  const listRaw = listJson?.data?.currentAppInstallation?.metafield?.value;
  if (listRaw == null || listRaw === "") return [];
  let listParsed: { _chunked?: boolean; totalChunks?: number };
  try {
    listParsed = JSON.parse(listRaw);
  } catch {
    return [];
  }
  if (!listParsed?._chunked || typeof listParsed.totalChunks !== "number" || listParsed.totalChunks < 1) return [];
  const totalChunks = listParsed.totalChunks;
  const chunkIndices = Array.from({ length: totalChunks }, (_, i) => i);
  const chunks: (string | null)[] = [];
  for (let start = 0; start < chunkIndices.length; start += CHUNK_FETCH_CONCURRENCY) {
    const batch = chunkIndices.slice(start, start + CHUNK_FETCH_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map((i) => fetchOneChunk(admin, `${INVENTORY_COUNTS_LIST_CHUNK_PREFIX}${i}`, i))
    );
    chunks.push(...batchResults);
  }
  const counts: InventoryCount[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunkRaw = chunks[i];
    if (chunkRaw == null) {
      throw new Error(`棚卸一覧チャンク${i}が存在しません。メタフィールドが欠落している可能性があります。`);
    }
    try {
      const chunk = JSON.parse(chunkRaw);
      if (Array.isArray(chunk)) counts.push(...(chunk as InventoryCount[]));
    } catch (e) {
      // チャンク中身が空・不正JSONでもページを落とさない（syntax error 表示を防ぐ）
      console.warn(`[inventory-count] 棚卸一覧チャンク${i}のパースに失敗しました:`, e instanceof Error ? e.message : String(e));
    }
  }
  return counts;
}

/** readInventoryCountsChunked のオプション（修復時のみ使用） */
export type ReadInventoryCountsChunkedOptions = {
  /** true のときは欠落チャンクがあってもスキップして読み続ける（メタフィールド修復用。通常運用では使わない） */
  allowMissingChunksForRepair?: boolean;
};

/**
 * 棚卸メタフィールドをチャンク対応で読み込む（管理画面・応答サイズ制限で明細が欠ける問題を解消）。
 * 単一 key の場合は従来どおり。_chunked の場合は複数 key を並列取得して結合する（502/タイムアウト対策）。
 * チャンク内に「パート」形式（_part: true）が含まれる場合は countId ごとに結合してから返す。
 * メイン読み取り・チャンク取得は Throttle/一時失敗時にリトライし、発行できないエラーを減らす。
 */
export async function readInventoryCountsChunked(
  admin: { graphql: (q: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response> },
  options?: ReadInventoryCountsChunkedOptions
): Promise<InventoryCount[]> {
  const allowMissingChunksForRepair = options?.allowMissingChunksForRepair === true;
  const mainGql = `#graphql
      query InventoryCountMain {
        currentAppInstallation {
          metafield(namespace: "${NS}", key: "${INVENTORY_COUNTS_KEY}") { value }
        }
      }
    `;
  let mainJson: { data?: { currentAppInstallation?: { metafield?: { value?: string | null } } } } | null = null;
  for (let attempt = 0; attempt <= 1; attempt++) {
    try {
      if (attempt > 0) await new Promise<void>((r) => setTimeout(r, CHUNK_FETCH_RETRY_DELAY_MS));
      const mainResp = await admin.graphql(mainGql);
      mainJson = (await safeJsonFromResponseForLoader(mainResp, null)) as { data?: { currentAppInstallation?: { metafield?: { value?: string | null } } } } | null;
      break;
    } catch (e) {
      if (attempt === 1) throw e;
      console.warn("[inventory-count] readInventoryCountsChunked main read failed, retrying:", (e as Error)?.message ?? e);
    }
  }
  const raw = mainJson?.data?.currentAppInstallation?.metafield?.value;
  if (raw == null || raw === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (Array.isArray(parsed)) return parsed as InventoryCount[];
  const desc = parsed as { _chunked?: boolean; totalChunks?: number };
  if (!desc._chunked || typeof desc.totalChunks !== "number" || desc.totalChunks < 1) return [];
  const fullCounts: InventoryCount[] = [];
  const partsByCountId = new Map<string, CountPart[]>();
  const totalChunks = desc.totalChunks;
  const chunkIndices = Array.from({ length: totalChunks }, (_, i) => i);
  const chunkRaws: (string | null)[] = [];
  for (let start = 0; start < chunkIndices.length; start += CHUNK_FETCH_CONCURRENCY) {
    const batch = chunkIndices.slice(start, start + CHUNK_FETCH_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map((i) => fetchOneChunk(admin, `${INVENTORY_COUNTS_CHUNK_KEY_PREFIX}${i}`, i))
    );
    chunkRaws.push(...batchResults);
  }
  for (let i = 0; i < chunkRaws.length; i++) {
    let chunkRaw = chunkRaws[i];
    // チャンクが null のときは一時的な Throttle/取得失敗の可能性があるため、1回だけ再取得を試す
    if (chunkRaw == null) {
      await new Promise<void>((r) => setTimeout(r, CHUNK_FETCH_RETRY_DELAY_MS));
      chunkRaw = await fetchOneChunk(admin, `${INVENTORY_COUNTS_CHUNK_KEY_PREFIX}${i}`, i);
      chunkRaws[i] = chunkRaw;
    }
    if (chunkRaw == null) {
      // 最後の1チャンクだけ欠けている場合、または修復モード時：欠落を空として扱い読み続け、後続の write でメタを正しい状態に直せるようにする
      if (i === totalChunks - 1 || allowMissingChunksForRepair) {
        console.warn(`[inventory-count] 棚卸チャンク${i}が存在しません。${allowMissingChunksForRepair ? "修復モードのため" : "最終チャンクのため"}空として読み取りを続行します。`);
        continue;
      }
      throw new Error(
        `棚卸チャンク${i}が存在しません。メタフィールドが欠落している可能性があります（上書きで他データが消えるのを防ぐため読み取りを中断します）。`
      );
    }
    let chunk: unknown;
    try {
      chunk = JSON.parse(chunkRaw);
    } catch (e) {
      // チャンク中身が空・不正JSONでもページを落とさない（syntax error, unexpected end of file を防ぐ）
      console.warn(`[inventory-count] 棚卸チャンク${i}のパースに失敗しました:`, e instanceof Error ? e.message : String(e));
      continue;
    }
    if (!Array.isArray(chunk)) {
      console.warn(`[inventory-count] 棚卸チャンク${i}が配列ではありません`);
      continue;
    }
    for (const el of chunk) {
      if (el && typeof el === "object" && (el as CountPart)._part === true) {
        const part = el as CountPart;
        const list = partsByCountId.get(part.countId) ?? [];
        list.push(part);
        partsByCountId.set(part.countId, list);
      } else {
        fullCounts.push(el as InventoryCount);
      }
    }
  }
  for (const parts of partsByCountId.values()) {
    fullCounts.push(mergeCountParts(parts));
  }
  return fullCounts;
}

/** 1件の棚卸を CHUNK_BYTES 以下に収まるパートに分割する（groupItems/items のみ分割、メタは part 0 に） */
function splitCountIntoParts(count: InventoryCount): CountPart[] {
  const c = count as Record<string, unknown>;
  const groupItems = (c.groupItems && typeof c.groupItems === "object" ? c.groupItems : {}) as Record<string, unknown[]>;
  const items = Array.isArray(c.items) ? c.items : [];
  const countMeta: Record<string, unknown> = { ...c };
  delete countMeta.groupItems;
  delete countMeta.items;

  type Entry = { g: string; item: unknown };
  const entries: Entry[] = [];
  for (const [g, arr] of Object.entries(groupItems)) {
    if (Array.isArray(arr)) for (const item of arr) entries.push({ g, item });
  }
  for (const item of items) entries.push({ g: "_legacy", item });

  if (entries.length === 0) {
    return [{ _part: true, countId: count.id, partIndex: 0, totalParts: 1, countMeta, groupItems: {}, items: [] }];
  }

  const parts: CountPart[] = [];
  let partIndex = 0;
  let current: { groupItems: Record<string, unknown[]>; items: unknown[] } = { groupItems: {}, items: [] };

  function flush() {
    if (Object.keys(current.groupItems).length === 0 && current.items.length === 0) return;
    parts.push({
      _part: true,
      countId: count.id,
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
      countId: count.id,
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
      if (addToGroup) current.groupItems[g]!.pop();
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
 * メタフィールド書き込みをリトライ付きで実行する。
 * HTTP エラー・例外発生時のみリトライ。userErrors はリトライせず呼び出し元に委ねる。
 * 全リトライ失敗時は throw せず、userErrors 形式のオブジェクトを返して呼び出し元の既存チェックで拾えるようにする。
 */
async function metafieldSetWithRetry(
  admin: { graphql: (q: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response> },
  mutation: string,
  variables: Record<string, unknown>,
  gql: ((query: string, variables?: Record<string, unknown>) => Promise<unknown>) | null
): Promise<Record<string, unknown>> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= CHUNK_WRITE_RETRY; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, CHUNK_WRITE_RETRY_DELAY_MS));
      console.warn(`[writeInventoryCountsChunked] metafield write retry ${attempt}/${CHUNK_WRITE_RETRY}`);
    }
    try {
      if (gql) {
        return (await gql(mutation, variables)) as Record<string, unknown>;
      }
      const resp = await admin.graphql(mutation, { variables });
      if (!resp.ok) {
        lastError = new Error(`HTTP ${resp.status}`);
        if (attempt < CHUNK_WRITE_RETRY) continue;
        break;
      }
      return (await safeJsonFromResponseForLoader(resp, {})) as Record<string, unknown>;
    } catch (e) {
      lastError = e;
      if (attempt < CHUNK_WRITE_RETRY) {
        console.warn(
          `[writeInventoryCountsChunked] metafield write attempt ${attempt + 1}/${CHUNK_WRITE_RETRY + 1} failed, retrying:`,
          (e as Error)?.message ?? e
        );
      }
    }
  }
  // 全リトライ失敗時: throw せず userErrors 形式で返す（呼び出し元の既存チェックで拾える）
  const errMsg = (lastError as Error)?.message ?? "メタフィールドの書き込みに失敗しました";
  console.error(`[writeInventoryCountsChunked] metafield write failed after ${CHUNK_WRITE_RETRY + 1} attempts:`, errMsg);
  return { data: { metafieldsSet: { userErrors: [{ message: `保存に失敗しました（${errMsg}）。しばらくしてから再試行してください。` }] } } };
}

function toMinimalCountForList(c: InventoryCount): Record<string, unknown> {
  return {
    id: c.id,
    locationId: c.locationId,
    status: c.status,
    countName: c.countName,
    createdAt: c.createdAt,
    productGroupIds: Array.isArray(c.productGroupIds) ? c.productGroupIds : c.productGroupId ? [c.productGroupId] : [],
    productGroupNames: Array.isArray((c as any).productGroupNames) ? (c as any).productGroupNames : undefined,
    cancelledGroupIds: Array.isArray((c as any).cancelledGroupIds) ? (c as any).cancelledGroupIds : undefined,
  };
}

/** 楽観ロック用。保存成功時にバージョンメタを更新する */
async function writeInventoryCountsVersion(
  admin: { graphql: (q: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response> },
  ownerId: string,
  newVersion: number
): Promise<void> {
  await admin.graphql(
    `#graphql mutation SetVersion($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { userErrors { message } } }`,
    {
      variables: {
        metafields: [
          { ownerId, namespace: NS, key: INVENTORY_COUNTS_VERSION_KEY, type: "single_line_text_field", value: String(newVersion) },
        ],
      },
    }
  );
}

/** 修復時などで direct fetch と既存データを渡すオプション（syntax error 回避・再読取スキップ） */
export type WriteInventoryCountsChunkedOptions = {
  session?: { shop: string; accessToken: string } | null;
  /** 渡すと初回の readInventoryCountsChunked をスキップしてこれを使う（修復時に必須） */
  existingCounts?: InventoryCount[] | null;
};

/**
 * 棚卸メタフィールドをチャンク対応で保存（単体が CHUNK_BYTES を超える場合は groupItems/items をパート分割）。
 * 一覧用軽量メタフィールド（list）と棚卸ID→チャンク番号インデックスも同時に保存。
 * 書き込み前に既存データから locationId / productGroupIds / groupItems 等を補完し、空白で上書きしない。
 * expectedVersion を渡した場合、現在のバージョンと一致しないと競合として保存しない（楽観ロック）。
 * options.session を渡すと GraphQL を direct fetch で実行し syntax error を避ける。options.existingCounts を渡すと初回読取をスキップ（修復用）。
 */
export async function writeInventoryCountsChunked(
  admin: { graphql: (q: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response> },
  counts: InventoryCount[],
  ownerId: string,
  expectedVersion?: number,
  options?: WriteInventoryCountsChunkedOptions | null
): Promise<{ userErrors: Array<{ message?: string }> }> {
  const useDirectFetch = Boolean(options?.session?.shop && options?.session?.accessToken);
  const shop = options?.session?.shop ?? "";
  const accessToken = options?.session?.accessToken ?? "";
  const gql = useDirectFetch
    ? (query: string, variables?: Record<string, unknown>) => loaderGraphql(shop, accessToken, query, variables)
    : null;

  let existing: InventoryCount[] = [];
  if (options?.existingCounts != null && Array.isArray(options.existingCounts)) {
    existing = options.existingCounts;
  } else {
    try {
      existing = await readInventoryCountsChunked(admin);
    } catch {
      // 既存読取失敗時はマージせずそのまま書く（新規ショップ等）
    }
  }
  // ✅ 読取失敗で existing=[] のとき、実はストアにデータがあるなら上書きしない（チャンク欠落等で読めなかっただけの可能性）
  if (existing.length === 0 && Array.isArray(counts) && counts.length > 0) {
    const main = await readMainKeyOnly(admin);
    if (main !== null) {
      return {
        userErrors: [
          { message: "棚卸データの読み取りに一時的に失敗しています。しばらくしてから再試行するか、修復を試してください。" },
        ],
      };
    }
  }
  const currentVersion = await getInventoryCountsVersion(admin, options?.session ?? undefined);
  if (expectedVersion != null && currentVersion !== expectedVersion) {
    return {
      userErrors: [{ message: "他の操作でデータが更新されています。画面を再読み込みしてから再度お試しください。" }],
    };
  }
  const merged = mergeExistingNonBlank(Array.isArray(counts) ? counts : [], existing);
  const withNames = ensureCountNamesOnCounts(merged);
  const arr = filterInvalidCountsBeforeWrite(withNames);
  try {
    const toMinimal = (c: InventoryCount) =>
      c
        ? {
            id: c.id,
            locationId: c.locationId,
            status: c.status,
            countName: c.countName,
            createdAt: c.createdAt,
            productGroupIds: Array.isArray(c.productGroupIds) ? c.productGroupIds : c.productGroupId ? [c.productGroupId] : [],
            productGroupNames: Array.isArray(c.productGroupNames) ? c.productGroupNames : undefined,
            cancelledGroupIds: Array.isArray(c.cancelledGroupIds) ? c.cancelledGroupIds : undefined,
          }
        : null;
    const backupList = (existing.length > 0 ? existing : arr).map(toMinimal).filter(Boolean);
    const backupValue = JSON.stringify(backupList);
    if (backupValue.length <= INVENTORY_COUNTS_BACKUP_MAX_BYTES) {
      const backupMutation = `#graphql mutation SetBackup($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { userErrors { message } } }`;
      const vars = { metafields: [{ ownerId, namespace: NS, key: INVENTORY_COUNTS_BACKUP_KEY, type: "json", value: backupValue }] };
      if (gql) {
        await gql(backupMutation, vars);
      } else {
        const resp = await admin.graphql(backupMutation, { variables: vars });
        const data = (await safeJsonFromResponseForLoader(resp, {})) as Record<string, unknown>;
        if (Array.isArray((data?.data as { metafieldsSet?: { userErrors?: unknown[] } })?.metafieldsSet?.userErrors)) {
          // バックアップの userErrors は無視（本体の書き込みは続行）
        }
      }
    }
  } catch {
    // バックアップ失敗時は無視（本体の書き込みは続行）
  }
  const payloads: (InventoryCount | CountPart)[][] = [];
  const countIdToChunkIndices = new Map<string, Set<number>>();
  let current: (InventoryCount | CountPart)[] = [];
  let currentSize = 2;

  function recordChunk(chunkIndex: number, items: (InventoryCount | CountPart)[]) {
    for (const it of items) {
      const cid = (it as InventoryCount).id ?? (it as CountPart).countId;
      if (cid) {
        if (!countIdToChunkIndices.has(cid)) countIdToChunkIndices.set(cid, new Set());
        countIdToChunkIndices.get(cid)!.add(chunkIndex);
      }
    }
  }

  for (const count of arr) {
    const countStr = JSON.stringify(count);
    if (countStr.length <= INVENTORY_COUNTS_CHUNK_BYTES) {
      if (currentSize + countStr.length + 1 > INVENTORY_COUNTS_CHUNK_BYTES && current.length > 0) {
        const chunkIndex = payloads.length;
        payloads.push(current);
        recordChunk(chunkIndex, current);
        current = [];
        currentSize = 2;
      }
      current.push(count);
      currentSize += countStr.length + 1;
    } else {
      if (current.length > 0) {
        const chunkIndex = payloads.length;
        payloads.push(current);
        recordChunk(chunkIndex, current);
        current = [];
        currentSize = 2;
      }
      const parts = splitCountIntoParts(count);
      for (const part of parts) {
        const partStr = JSON.stringify(part);
        if (currentSize + partStr.length + 1 > INVENTORY_COUNTS_CHUNK_BYTES && current.length > 0) {
          const chunkIndex = payloads.length;
          payloads.push(current);
          recordChunk(chunkIndex, current);
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
    recordChunk(chunkIndex, current);
  }

  if (payloads.length === 0) {
    // ✅ 既存の棚卸データがある場合は空で上書きしない（監査 STOCKTAKE_IMPLEMENTATION_AUDIT.md §7）
    if (existing.length > 0) {
      throw new Error(
        "棚卸データを空にすることはできません。既存の棚卸IDが消えるため、空配列での上書きをブロックしました。"
      );
    }
    // ✅ read 失敗で existing=[] のときも、実際のメタにデータがあれば空で上書きしない（POS と同様の二重ガード）
    // ✅ メインキー確認で例外（ネットワーク等）が出た場合も空で上書きしない（状態が不明なときは安全側に倒す）
    const mainKeyQuery = `#graphql query MainKey { currentAppInstallation { metafield(namespace: "${NS}", key: "${INVENTORY_COUNTS_KEY}") { value } } }`;
    try {
      const checkJson = gql
        ? await gql(mainKeyQuery)
        : (await safeJsonFromResponseForLoader(await admin.graphql(mainKeyQuery), {})) as Record<string, unknown>;
      const raw = (checkJson?.data as { currentAppInstallation?: { metafield?: { value?: string } } })?.currentAppInstallation?.metafield?.value;
      if (raw != null && raw !== "" && raw !== "[]") {
        const parsed = JSON.parse(raw);
        const desc = parsed as { _chunked?: boolean; totalChunks?: number } | null;
        const hasData = Array.isArray(parsed) ? parsed.length > 0 : !!(desc?._chunked && typeof desc?.totalChunks === "number" && desc.totalChunks > 0);
        if (hasData) {
          throw new Error(
            "棚卸データを空にすることはできません。既存の棚卸IDが消えるため、空配列での上書きをブロックしました。"
          );
        }
      }
    } catch (e: unknown) {
      if (e instanceof Error && e.message.includes("ブロックしました")) throw e;
      // メインキー確認が例外で終わった場合は状態不明のため空で上書きしない
      throw new Error(
        "棚卸データの状態を確認できませんでした。空での上書きはブロックしました。しばらくしてから再試行するか、修復を試してください。"
      );
    }
    const metafields = [
      { ownerId, namespace: NS, key: INVENTORY_COUNTS_KEY, type: "json", value: "[]" },
      { ownerId, namespace: NS, key: INVENTORY_COUNTS_LIST_KEY, type: "json", value: "[]" },
      { ownerId, namespace: NS, key: INVENTORY_COUNT_INDEX_KEY, type: "json", value: "{}" },
      { ownerId, namespace: NS, key: INVENTORY_COUNTS_VERSION_KEY, type: "single_line_text_field", value: String(currentVersion + 1) },
    ];
    const emptyMutation = `#graphql mutation SetInventoryCounts($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { userErrors { field message } } }`;
    const emptyVars = { metafields };
    const emptyJson = await metafieldSetWithRetry(admin, emptyMutation, emptyVars, gql);
    const data = (emptyJson?.data as { metafieldsSet?: { userErrors?: Array<{ message?: string }> } })?.metafieldsSet;
    return { userErrors: data?.userErrors ?? [] };
  }

  if (payloads.length === 1 && payloads[0].length === 1 && !(payloads[0][0] as CountPart)._part) {
    const full = JSON.stringify(payloads[0]);
    if (full.length <= INVENTORY_COUNTS_CHUNK_BYTES) {
      const singleMutation = `#graphql mutation SetInventoryCounts($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { userErrors { field message } } }`;
      const singleVars = {
        metafields: [
          { ownerId, namespace: NS, key: INVENTORY_COUNTS_KEY, type: "json", value: full },
          { ownerId, namespace: NS, key: INVENTORY_COUNTS_VERSION_KEY, type: "single_line_text_field", value: String(currentVersion + 1) },
        ],
      };
      const singleJson = await metafieldSetWithRetry(admin, singleMutation, singleVars, gql);
      const data = (singleJson?.data as { metafieldsSet?: { userErrors?: Array<{ message?: string }> } })?.metafieldsSet;
      return { userErrors: data?.userErrors ?? [] };
    }
  }

  const chunks = payloads.map((p) => JSON.stringify(p));
  const descriptor = JSON.stringify({ _chunked: true, totalChunks: chunks.length });
  // ディスクリプタは最後に書く。途中でバッチが失敗しても「totalChunks はあるが最後のチャンクが無い」状態を避け、メタを壊しにくくする
  const metafields: Array<{ ownerId: string; namespace: string; key: string; type: string; value: string }> = [
    ...chunks.map((value, i) => ({
      ownerId,
      namespace: NS,
      key: `${INVENTORY_COUNTS_CHUNK_KEY_PREFIX}${i}`,
      type: "json" as const,
      value,
    })),
    { ownerId, namespace: NS, key: INVENTORY_COUNTS_KEY, type: "json", value: descriptor },
  ];
  const chunkMutation = `#graphql mutation SetInventoryCountsChunk($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { userErrors { field message } } }`;
  for (let i = 0; i < metafields.length; i += METAFIELDS_SET_MAX) {
    const batch = metafields.slice(i, i + METAFIELDS_SET_MAX);
    const chunkVars = { metafields: batch };
    const chunkJson = await metafieldSetWithRetry(admin, chunkMutation, chunkVars, gql);
    const data = (chunkJson?.data as { metafieldsSet?: { userErrors?: Array<{ message?: string }> } })?.metafieldsSet;
    if (data?.userErrors?.length) return { userErrors: data.userErrors };
  }

  const listItems = arr.map(toMinimalCountForList);
  const listPayloads: string[] = [];
  let listCurrent: Record<string, unknown>[] = [];
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
  // 一覧用もディスクリプタを最後に書く（メタを壊さない堅牢さ）
  const listMetafields: Array<{ ownerId: string; namespace: string; key: string; type: string; value: string }> = [
    ...listPayloads.map((value, i) => ({
      ownerId,
      namespace: NS,
      key: `${INVENTORY_COUNTS_LIST_CHUNK_PREFIX}${i}`,
      type: "json" as const,
      value,
    })),
    { ownerId, namespace: NS, key: INVENTORY_COUNTS_LIST_KEY, type: "json", value: listDescriptor },
    { ownerId, namespace: NS, key: INVENTORY_COUNT_INDEX_KEY, type: "json", value: indexValue },
  ];
  const listChunkMutation = `#graphql mutation SetInventoryCountsListChunk($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { userErrors { field message } } }`;
  for (let i = 0; i < listMetafields.length; i += METAFIELDS_SET_MAX) {
    const batch = listMetafields.slice(i, i + METAFIELDS_SET_MAX);
    const listVars = { metafields: batch };
    const listJson = await metafieldSetWithRetry(admin, listChunkMutation, listVars, gql);
    const data = (listJson?.data as { metafieldsSet?: { userErrors?: Array<{ message?: string }> } })?.metafieldsSet;
    if (data?.userErrors?.length) return { userErrors: data.userErrors };
  }
  const nextNum = arr.reduce((max, c) => Math.max(max, parseCountNameNumber(c?.countName)), 0) + 1;
  const setNextMutation = `#graphql mutation SetNext($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { userErrors { message } } }`;
  const setNextVars = {
    metafields: [
      { ownerId, namespace: NS, key: INVENTORY_COUNT_NEXT_KEY, type: "json", value: String(nextNum) },
      { ownerId, namespace: NS, key: INVENTORY_COUNTS_VERSION_KEY, type: "single_line_text_field", value: String(currentVersion + 1) },
    ],
  };
  // setNext は棚卸ID連番カウンタとバージョン更新。失敗しても本体データは保存済みのため非クリティカル扱い
  await metafieldSetWithRetry(admin, setNextMutation, setNextVars, gql).catch((e) => {
    console.warn("[writeInventoryCountsChunked] setNext write failed (non-critical):", (e as Error)?.message ?? e);
  });
  return { userErrors: [] };
}

export type LocationNode = { id: string; name: string };
export type CollectionNode = { 
  id: string; 
  title: string;
  image?: {
    url: string;
    altText?: string;
  } | null;
};

export type CollectionConfig = {
  collectionId: string; // コレクションID
  selectedVariantIds: string[]; // 選択されたバリアントIDの配列（空配列=全選択）
  totalVariantCount?: number; // コレクション内の全バリアント数（0/0表示用）
};

export type ProductGroup = {
  id: string; // グループID（自動生成）
  name: string; // グループ名
  collectionIds: string[]; // ShopifyコレクションIDの配列（後方互換性のため残す）
  collectionConfigs?: CollectionConfig[]; // コレクションごとの選択商品設定（新規）
  productIds?: string[]; // 直接指定する商品ID（オプション）
  variantIds?: string[]; // 直接指定するバリアントID（オプション）
  skus?: string[]; // グループ名＋SKUで指定する場合のSKU一覧（コレクションに依存しない）
  inventoryItemIds?: string[]; // ✅ 商品グループに含まれるinventoryItemIdのリスト（判定用に保存）
  parentGroupId?: string; // 親グループID（ネスト用）
  createdAt: string; // 作成日時（ISO）
};

export type CollectionProduct = {
  variantId: string;
  inventoryItemId: string;
  productTitle: string;
  variantTitle: string;
  sku: string;
  barcode?: string;
};

export type InventoryCount = {
  id: string; // 棚卸ID（自動生成: count_${timestamp}_${random}）
  countName?: string; // 表示用名称（#C0000形式）
  locationId: string; // ロケーションID
  locationName?: string;
  productGroupId?: string; // 商品グループID（後方互換性のため残す）
  productGroupIds: string[]; // 商品グループIDの配列（複数選択対応）
  productGroupName?: string; // 後方互換性のため残す
  productGroupNames?: string[]; // 商品グループ名の配列
  inventoryItemIdsByGroup?: Record<string, string[]>; // ✅ 商品グループごとのinventoryItemIds（生成時の状態を保持）
  /** メタフィールドサイズ制限のためIDを保存せず省略した場合 true。POSはコレクション/SKUから読み込む */
  inventoryItemIdsOmittedDueToSize?: boolean;
  status: "draft" | "in_progress" | "completed" | "cancelled";
  createdAt: string; // 作成日時（ISO）
  completedAt?: string; // 完了日時（ISO）
  items?: Array<{
    inventoryItemId: string;
    variantId?: string;
    sku?: string;
    title?: string;
    currentQuantity?: number; // 現在の在庫数
    actualQuantity?: number; // 実数
    delta?: number; // 差分（actualQuantity - currentQuantity）
  }>;
};

/** 管理画面から棚卸確定・リセット時に在庫を反映するためのヘルパー。IDをGIDに正規化 */
function toRawIdForCount(id: string | number | null | undefined): string {
  if (id == null) return "";
  const s = String(id).trim();
  if (s.startsWith("gid://")) {
    const last = s.split("/").pop();
    return last || s;
  }
  return s;
}
function toLocationGidForCount(locationId: string): string {
  const s = String(locationId || "").trim();
  if (s.startsWith("gid://")) return s;
  const raw = toRawIdForCount(locationId);
  return raw ? `gid://shopify/Location/${raw}` : s;
}
function toInventoryItemGidForCount(inventoryItemId: string): string | null {
  const str = String(inventoryItemId || "").trim();
  if (!str) return null;
  if (/^\d+$/.test(str)) return `gid://shopify/InventoryItem/${str}`;
  if (str.includes("gid://")) return str;
  return null;
}

/** Shopify inventorySetQuantities の quantities 配列の最大件数（API 制限） */
const INVENTORY_SET_QUANTITIES_MAX = 250;

/** 管理画面から inventorySetQuantities で在庫を設定（POS の adjustInventoryToActual と同様）。250件超はチャンク分割して複数回実行。 */
async function adjustInventoryQuantitiesServer(
  admin: { graphql: (q: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response> },
  locationId: string,
  items: Array<{ inventoryItemId: string; quantity: number }>,
  referenceDocumentUri?: string | null
): Promise<{ ok: boolean; invalidCount?: number; error?: string }> {
  const locationGid = toLocationGidForCount(locationId);
  const quantities = (items ?? [])
    .filter((x) => x?.inventoryItemId && Number.isFinite(Number(x?.quantity)))
    .map((x) => {
      const gid = toInventoryItemGidForCount(x.inventoryItemId);
      const quantity = Math.floor(Number(x.quantity) ?? 0);
      return gid ? { valid: true as const, inventoryItemId: gid, quantity, compareQuantity: 0 } : { valid: false as const };
    });
  const validQuantities = quantities.filter((q) => q.valid);
  const invalidCount = quantities.filter((q) => !q.valid).length;
  if (validQuantities.length === 0) {
    return { ok: false, invalidCount, error: "有効な在庫アイテムがありません" };
  }
  const refUri = referenceDocumentUri
    ? `gid://stock-transfer-pos/InventoryCount/${referenceDocumentUri}`
    : undefined;
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
      const resp = await admin.graphql(
        `#graphql
          mutation InventorySetQuantities($input: InventorySetQuantitiesInput!) {
            inventorySetQuantities(input: $input) {
              inventoryAdjustmentGroup { id }
              userErrors { field message }
            }
          }
        `,
        { variables: { input } }
      );
      const json = await resp.json();
      const data = json?.data?.inventorySetQuantities;
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

/** 管理画面から棚卸確定・リセット時の変動ログを DB に記録（api/log-inventory-change と同様のロジック） */
async function logInventoryChangeServer(
  dbInstance: typeof db,
  shop: string,
  dateUtc: string,
  entries: Array<{
    inventoryItemId: string;
    variantId?: string | null;
    sku?: string;
    locationId: string;
    locationName: string;
    delta: number;
    quantityAfter: number | null;
    sourceId: string | null;
    timestamp: Date;
  }>,
  activity: string
): Promise<void> {
  for (const e of entries) {
    const rawItemId = toRawIdForCount(e.inventoryItemId);
    const rawLocId = toRawIdForCount(e.locationId);
    const ts = e.timestamp;
    const tsRounded = new Date(Math.floor(ts.getTime() / 1000) * 1000);
    const idempotencyKey = e.sourceId
      ? `${shop}_${activity}_${e.inventoryItemId}_${e.locationId}_${e.sourceId}`
      : `${shop}_${activity}_${rawItemId}_${rawLocId}_${tsRounded.toISOString()}`;
    await dbInstance.inventoryChangeLog.upsert({
      where: { shop_idempotencyKey: { shop, idempotencyKey } },
      create: {
        shop,
        timestamp: ts,
        date: dateUtc,
        inventoryItemId: rawItemId,
        variantId: e.variantId ?? null,
        sku: e.sku ?? "",
        locationId: rawLocId,
        locationName: e.locationName,
        activity,
        delta: e.delta,
        quantityAfter: e.quantityAfter,
        sourceType: activity,
        sourceId: e.sourceId,
        idempotencyKey,
        note: null,
      },
      update: {
        delta: e.delta,
        quantityAfter: e.quantityAfter,
        locationName: e.locationName,
        sourceId: e.sourceId,
        note: null,
      },
    });
  }
}

/** loader 用: セッションで GraphQL を 1 回 fetch し、安全にパースして返す（throw しない） */
async function loaderGraphql(
  shop: string,
  accessToken: string,
  query: string,
  variables?: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const resp = await fetch(`https://${shop}/admin/api/${ADMIN_GRAPHQL_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
    body: JSON.stringify({ query: query.replace(/^#graphql\s*/m, "").trim(), variables: variables ?? {} }),
  });
  const out = (await safeJsonFromResponseForLoader(resp, {})) as Record<string, unknown>;
  return out ?? {};
}

/** GraphQL の metafield.value を list 用にパース → InventoryCount[]（配列でなければ []） */
function parseListMetafieldValue(raw: string | null | undefined): InventoryCount[] {
  if (raw == null || raw === "") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as InventoryCount[]) : [];
  } catch {
    return [];
  }
}

/** list の value がチャンク用ディスクリプタかどうかと totalChunks を返す */
function parseListDescriptor(raw: string | null | undefined): { chunked: true; totalChunks: number } | null {
  if (raw == null || raw === "") return null;
  try {
    const parsed = JSON.parse(raw) as { _chunked?: boolean; totalChunks?: number };
    if (parsed?._chunked && typeof parsed.totalChunks === "number" && parsed.totalChunks >= 1) return { chunked: true, totalChunks: parsed.totalChunks };
  } catch {
    return null;
  }
  return null;
}

/** direct fetch で list チャンクを並列取得して結合（loader 用。list がチャンク形式のとき一覧を表示するため） */
async function fetchListChunksViaLoader(
  shop: string,
  accessToken: string,
  totalChunks: number
): Promise<InventoryCount[]> {
  const LIST_CHUNK_QUERY = `#graphql query ListChunk($key: String!) { currentAppInstallation { metafield(namespace: "${NS}", key: $key) { value } } }`;
  const counts: InventoryCount[] = [];
  for (let start = 0; start < totalChunks; start += CHUNK_FETCH_CONCURRENCY) {
    const batch = Array.from({ length: Math.min(CHUNK_FETCH_CONCURRENCY, totalChunks - start) }, (_, i) => start + i);
    const results = await Promise.all(
      batch.map(async (i) => {
        const key = `${INVENTORY_COUNTS_LIST_CHUNK_PREFIX}${i}`;
        const json = await loaderGraphql(shop, accessToken, LIST_CHUNK_QUERY, { key });
        const value = (json?.data as { currentAppInstallation?: { metafield?: { value?: string } } })?.currentAppInstallation?.metafield?.value;
        return value ?? null;
      })
    );
    for (const chunkRaw of results) {
      if (chunkRaw == null || chunkRaw === "") continue;
      try {
        const chunk = JSON.parse(chunkRaw) as unknown;
        if (Array.isArray(chunk)) counts.push(...(chunk as InventoryCount[]));
      } catch {
        // スキップ
      }
    }
  }
  return counts;
}

/** direct fetch で main チャンクを並列取得して結合（loader 用。list が空で main がチャンク形式のとき一覧を表示するため） */
const MAIN_CHUNK_QUERY = `#graphql query MainChunk($key: String!) { currentAppInstallation { metafield(namespace: "${NS}", key: $key) { value } } }`;
async function fetchMainChunksViaLoader(
  shop: string,
  accessToken: string,
  totalChunks: number
): Promise<InventoryCount[]> {
  const fullCounts: InventoryCount[] = [];
  const partsByCountId = new Map<string, CountPart[]>();
  for (let start = 0; start < totalChunks; start += CHUNK_FETCH_CONCURRENCY) {
    const batch = Array.from({ length: Math.min(CHUNK_FETCH_CONCURRENCY, totalChunks - start) }, (_, j) => start + j);
    const results = await Promise.all(
      batch.map(async (i) => {
        const key = `${INVENTORY_COUNTS_CHUNK_KEY_PREFIX}${i}`;
        const json = await loaderGraphql(shop, accessToken, MAIN_CHUNK_QUERY, { key });
        const value = (json?.data as { currentAppInstallation?: { metafield?: { value?: string } } })?.currentAppInstallation?.metafield?.value;
        return value ?? null;
      })
    );
    for (const chunkRaw of results) {
      if (chunkRaw == null || chunkRaw === "") continue;
      try {
        const chunk = JSON.parse(chunkRaw) as unknown[];
        if (!Array.isArray(chunk)) continue;
        for (const el of chunk) {
          if (el && typeof el === "object" && (el as CountPart)._part === true) {
            const part = el as CountPart;
            const list = partsByCountId.get(part.countId) ?? [];
            list.push(part);
            partsByCountId.set(part.countId, list);
          } else {
            fullCounts.push(el as InventoryCount);
          }
        }
      } catch {
        // スキップ
      }
    }
  }
  for (const parts of partsByCountId.values()) {
    fullCounts.push(mergeCountParts(parts));
  }
  return fullCounts;
}

/** GraphQL の metafield.value を main 用にパース → { chunked, array } | { chunked, totalChunks } | null */
function parseMainMetafieldValue(raw: string | null | undefined): { chunked: false; array: InventoryCount[] } | { chunked: true; totalChunks: number } | null {
  if (raw == null || raw === "") return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return { chunked: false, array: parsed as InventoryCount[] };
    const desc = parsed as { _chunked?: boolean; totalChunks?: number };
    if (desc?._chunked && typeof desc.totalChunks === "number" && desc.totalChunks >= 1) return { chunked: true, totalChunks: desc.totalChunks };
  } catch {
    return null;
  }
  return null;
}

/** GraphQL の metafield.value を version 用にパース → number */
function parseVersionMetafieldValue(raw: string | null | undefined): number {
  if (raw == null || raw === "") return 1;
  const n = parseInt(String(raw).trim(), 10);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

/** GraphQL 応答 { data: { currentAppInstallation: { metafield: { value } } } } から value を抜き出す */
function getMetafieldValueFromData(response: Record<string, unknown>): string | null {
  const data = response?.data as Record<string, unknown> | undefined;
  const inst = data?.currentAppInstallation as Record<string, unknown> | undefined;
  const m = inst?.metafield as { value?: string } | undefined;
  return (m?.value ?? null) as string | null;
}

export async function loader({ request }: LoaderFunctionArgs) {
  try {
  let { admin, session } = await authenticate.admin(request);
  admin = withGraphQLRetry(admin);

  let shopTimezone = "UTC";
  try {
    shopTimezone = (await getShopTimezone(admin)) || "UTC";
  } catch {
    shopTimezone = "UTC";
  }

  // session.shop が null になるリクエストがあるため、URL の shop パラメータで補完（履歴が出ない原因の回避）
  let shop = session?.shop ?? "";
  let shopSource: "session" | "url" | "none" = shop ? "session" : "none";
  if (!shop) {
    try {
      const urlShop = new URL(request.url).searchParams.get("shop") ?? "";
      if (urlShop) {
        shop = urlShop;
        shopSource = "url";
      }
    } catch {
      shop = "";
    }
  }
  const accessToken = session?.accessToken ?? "";
  const useDirectFetch = Boolean(shop && accessToken);
  // 履歴が出ない原因をログで確定できるようにする（useDirectFetch が false の理由を明示）
  const directFetchReason = useDirectFetch
    ? `ok shopSource=${shopSource}`
    : `no shop=${shop ? "set" : "empty"} accessToken=${accessToken ? "set" : "empty"}`;
  console.log("[inventory-count] loader directFetch:", directFetchReason);

  const LOCATIONS_QUERY = `#graphql query Locations($first: Int!) { locations(first: $first) { nodes { id name } } }`;
  const APP_QUERY = `#graphql query InventoryCountData { currentAppInstallation { productGroupsMetafield: metafield(namespace: "${NS}", key: "${PRODUCT_GROUPS_KEY}") { value } } }`;
  const SETTINGS_QUERY = `#graphql query StocktakeSettings { currentAppInstallation { metafield(namespace: "${NS}", key: "${SETTINGS_KEY}") { value } } }`;
  const LIST_QUERY = `#graphql query List { currentAppInstallation { metafield(namespace: "${NS}", key: "${INVENTORY_COUNTS_LIST_KEY}") { value } } }`;
  const MAIN_QUERY = `#graphql query Main { currentAppInstallation { metafield(namespace: "${NS}", key: "${INVENTORY_COUNTS_KEY}") { value } } }`;
  const VERSION_QUERY = `#graphql query Version { currentAppInstallation { metafield(namespace: "${NS}", key: "${INVENTORY_COUNTS_VERSION_KEY}") { value } } }`;

  let locData: Record<string, unknown>;
  let appData: Record<string, unknown>;
  let settingsData: Record<string, unknown>;
  let listCountsOnly: InventoryCount[];
  let mainKeyResult: { chunked: false; array: InventoryCount[] } | { chunked: true; totalChunks: number } | null;
  let inventoryCountsVersion: number;

  if (useDirectFetch) {
    const [loc, app, set, list, main, ver] = await Promise.all([
      loaderGraphql(shop, accessToken, LOCATIONS_QUERY, { first: 250 }),
      loaderGraphql(shop, accessToken, APP_QUERY),
      loaderGraphql(shop, accessToken, SETTINGS_QUERY),
      loaderGraphql(shop, accessToken, LIST_QUERY),
      loaderGraphql(shop, accessToken, MAIN_QUERY),
      loaderGraphql(shop, accessToken, VERSION_QUERY),
    ]);
    locData = loc;
    appData = app;
    settingsData = set;
    const listRaw = getMetafieldValueFromData(list);
    listCountsOnly = parseListMetafieldValue(listRaw);
    mainKeyResult = parseMainMetafieldValue(getMetafieldValueFromData(main));
    inventoryCountsVersion = parseVersionMetafieldValue(getMetafieldValueFromData(ver));
    // list がチャンク形式（ディスクリプタのみ）のときは list チャンクを取得して一覧を表示する
    if (listCountsOnly.length === 0) {
      const listDesc = parseListDescriptor(listRaw);
      if (listDesc) {
        try {
          listCountsOnly = await fetchListChunksViaLoader(shop, accessToken, listDesc.totalChunks);
        } catch (e) {
          console.warn("[inventory-count] loader list chunks fetch failed:", e instanceof Error ? e.message : e);
        }
      }
    }
    // list が空で main がチャンク形式のときは main チャンクから一覧を表示（ID発行で list 未更新でも表示される）
    if (listCountsOnly.length === 0 && mainKeyResult?.chunked) {
      try {
        listCountsOnly = await fetchMainChunksViaLoader(shop, accessToken, mainKeyResult.totalChunks);
      } catch (e) {
        console.warn("[inventory-count] loader main chunks fallback failed:", e instanceof Error ? e.message : e);
      }
    }
  } else {
    const graphqlOrEmpty = async (query: string, vars?: { variables?: Record<string, unknown> }): Promise<Response> => {
      try {
        return await admin.graphql(query, vars);
      } catch (e) {
        console.warn("[inventory-count] loader graphql failed:", e instanceof Error ? e.message : String(e));
        return new Response(JSON.stringify({ data: {} }));
      }
    };
    const [locResp, appResp, setResp] = await Promise.all([
      graphqlOrEmpty(LOCATIONS_QUERY, { variables: { first: 250 } }),
      graphqlOrEmpty(APP_QUERY),
      graphqlOrEmpty(SETTINGS_QUERY),
    ]);
    locData = (await safeJsonFromResponseForLoader(locResp, {})) as Record<string, unknown>;
    appData = (await safeJsonFromResponseForLoader(appResp, {})) as Record<string, unknown>;
    settingsData = (await safeJsonFromResponseForLoader(setResp, {})) as Record<string, unknown>;
    listCountsOnly = [];
    mainKeyResult = null;
    inventoryCountsVersion = 1;
  }

  const usedListMetafield = listCountsOnly.length > 0;
  const inventoryCountsRaw: InventoryCount[] = usedListMetafield
    ? listCountsOnly
    : (mainKeyResult && !mainKeyResult.chunked ? mainKeyResult.array : []);

  // 履歴件数と取得経路をログで確定（「履歴が出ない」時の原因切り分け用）
  const sourceLabel = usedListMetafield ? "list" : (mainKeyResult?.chunked ? "mainChunked" : mainKeyResult ? "main" : "none");
  console.log("[inventory-count] loader result: useDirectFetch=" + useDirectFetch + " inventoryCounts=" + inventoryCountsRaw.length + " source=" + sourceLabel);

  const locations: LocationNode[] = ((locData?.data as { locations?: { nodes?: LocationNode[] } })?.locations?.nodes) ?? [];

  // コレクション: 検索時のみ action で取得するため、loader では返さない（重いストア対策）
  const collections: CollectionNode[] = [];

  let productGroups: ProductGroup[] = [];
  const groupsRaw = (appData?.data as { currentAppInstallation?: { productGroupsMetafield?: { value?: string } } })?.currentAppInstallation?.productGroupsMetafield?.value;
  if (typeof groupsRaw === "string" && groupsRaw) {
    try {
      const parsed = JSON.parse(groupsRaw);
      productGroups = Array.isArray(parsed) ? parsed : [];
    } catch {
      productGroups = [];
    }
  }

  let inventoryCounts: InventoryCount[] = Array.isArray(inventoryCountsRaw) ? inventoryCountsRaw : [];
  // ✅ 一覧は棚卸IDの番号が新しい順（#C0025, #C0024… #C0001）で表示
  if (inventoryCounts.length > 1) {
    inventoryCounts = [...inventoryCounts].sort((a, b) => {
      const na = parseCountNameNumber((a as { countName?: string }).countName);
      const nb = parseCountNameNumber((b as { countName?: string }).countName);
      return nb - na;
    });
  }
  if (inventoryCounts.length > 0 && usedListMetafield) {
    try {
      // ✅ list 由来データ用：過去にキャンセルしたが当時のバグで status が "in_progress" のまま保存されている件を表示時補正（全グループが cancelledGroupIds に含まれるなら status を "cancelled" に）
      inventoryCounts = inventoryCounts.map((c) => {
        const allIds = Array.isArray(c.productGroupIds) && c.productGroupIds.length > 0
          ? c.productGroupIds
          : c.productGroupId ? [c.productGroupId] : [];
        if (allIds.length === 0) return c;
        const cancelledArr = Array.isArray((c as any).cancelledGroupIds) ? (c as any).cancelledGroupIds : [];
        const cancelledSet = new Set(cancelledArr.map((id: string) => normalizeIdForMatch(id)));
        const allCancelled = allIds.every((id) => cancelledSet.has(normalizeIdForMatch(id)));
        if (allCancelled && c.status !== "cancelled") {
          return { ...c, status: "cancelled" as const, completedAt: undefined };
        }
        return c;
      });
    } catch {
      // 補正失敗時はそのまま
    }
  }
  if (inventoryCounts.length > 0 && !usedListMetafield) {
    try {
      // ✅ 完了判定を修正：全グループが完了している場合のみ完了ステータスにする（フルデータ時のみ。list 一覧用のときは groupItems がないためスキップ）
      inventoryCounts = inventoryCounts.map((c) => {
        const allIds = Array.isArray(c.productGroupIds) && c.productGroupIds.length > 0
          ? c.productGroupIds
          : c.productGroupId ? [c.productGroupId] : [];
        
        if (allIds.length === 0) {
          return c;
        }
        
        const groupItemsMap = (c as any)?.groupItems && typeof (c as any).groupItems === "object" ? (c as any).groupItems : {};
        const countItemsLegacy = Array.isArray(c.items) && c.items.length > 0 ? c.items : [];
        const allDone = allIds.every((id) => {
          const productGroup = productGroups.find((g) => String(g.id) === String(id));
          if (!productGroup) return true;
          let groupItems = getGroupItemsByKey(groupItemsMap as Record<string, unknown[]>, String(id));
          if (groupItems.length === 0 && countItemsLegacy.length > 0) {
            const groupInventoryItemIds = productGroup?.inventoryItemIds || [];
            if (groupInventoryItemIds.length > 0) {
              const groupInventoryItemIdsSet = new Set(groupInventoryItemIds);
              groupItems = countItemsLegacy.filter((item) => {
                const itemId = String(item?.inventoryItemId || "").trim();
                return groupInventoryItemIdsSet.has(itemId);
              });
            } else if (allIds.length === 1) {
              groupItems = countItemsLegacy;
            }
          }
          return groupItems.length > 0;
        });
        
        const isCompleted = allDone;
        // ✅ 完了を未処理に戻さない：groupItems のキー/構造で allDone が false になっても downgrade しない（多発していた不具合防止）
        if (isCompleted && c.status !== "completed") {
          return { ...c, status: "completed", completedAt: c.completedAt || new Date().toISOString() };
        }
        return c;
      });
    } catch {
      inventoryCounts = [];
    }
  }

  // SKU一覧: 検索時のみ action で取得するため、loader では返さない（重いストア対策）
  const skuVariantList: Array<{ variantId: string; inventoryItemId: string; sku: string; barcode?: string; variantTitle: string; productTitle: string; title: string; option1?: string; option2?: string; option3?: string }> = [];

  // 右パネル表示用: 登録済みグループで参照されているコレクションIDのみ取得（全件取得しない）
  const collectionIdsInGroups = new Set<string>();
  for (const g of productGroups) {
    for (const cid of g.collectionIds ?? []) collectionIdsInGroups.add(cid);
  }
  let collectionDisplayMap: Record<string, CollectionNode> = {};
  if (collectionIdsInGroups.size > 0) {
    const ids = Array.from(collectionIdsInGroups);
    try {
      const nodesResp = await admin.graphql(
        `#graphql
          query GetCollectionNodes($ids: [ID!]!) {
            nodes(ids: $ids) {
              ... on Collection {
                id
                title
                image { url altText }
              }
            }
          }
        `,
        { variables: { ids } }
      );
      const nodesJson = (await safeJsonFromResponseForLoader(nodesResp, {})) as { data?: { nodes?: Array<{ id?: string; title?: string; image?: { url?: string; altText?: string } | null }> } };
      const nodes = nodesJson?.data?.nodes ?? [];
      for (const n of nodes) {
        if (n?.id) collectionDisplayMap[n.id] = { id: n.id, title: n.title ?? "", image: n.image ?? null };
      }
    } catch {
      collectionDisplayMap = {};
    }
  }

  // サーバー側で「今日の日付」を計算
  const todayInShopTimezone = getDateInShopTimezone(new Date(), shopTimezone);

  // 設定から棚卸CSV出力項目を取得（明細あり用）
  let stocktakeCsvExportColumns: string[] = DEFAULT_STOCKTAKE_CSV_COLUMNS;
  const settingsRaw = (settingsData?.data as { currentAppInstallation?: { metafield?: { value?: string } } })?.currentAppInstallation?.metafield?.value;
  if (typeof settingsRaw === "string" && settingsRaw) {
    try {
      const parsed = JSON.parse(settingsRaw);
      const cols = Array.isArray(parsed?.inventoryCount?.csvExportColumns) ? parsed.inventoryCount.csvExportColumns : [];
      const valid = (cols as string[]).filter((id: string) => STOCKTAKE_CSV_COLUMN_IDS.includes(id as any));
      if (valid.length > 0) stocktakeCsvExportColumns = valid;
    } catch {
      // 失敗時はデフォルト
    }
  }

  // ✅ 39グループ×5600SKU等でApplication Errorを防ぐ：クライアントには inventoryItemIdsByGroup を返さない（モーダルは action get_incomplete_group_products で取得）
  const inventoryCountsForClient = inventoryCounts.map((c) => {
    const { inventoryItemIdsByGroup: _omit, ...rest } = c as InventoryCount & { inventoryItemIdsByGroup?: unknown };
    return rest;
  });

  return {
    locations,
    collections,
    collectionDisplayMap,
    productGroups,
    inventoryCounts: inventoryCountsForClient,
    inventoryCountsVersion: Number(inventoryCountsVersion) || 1,
    skuVariantList,
    shopTimezone,
    todayInShopTimezone,
    stocktakeCsvExportColumns,
    loadError: false as const,
    loadErrorMessage: undefined,
  };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const stack = e instanceof Error ? e.stack : undefined;
    console.error("[inventory-count] loader error:", message, stack ?? "");
    // 原因特定のため: 「syntax error」系のときはスタックを必ず記録（Render ログで SYNTAX_ERROR_ORIGIN を検索）
    if (/syntax\s*error|unexpected\s*end\s*of\s*file/i.test(String(message))) {
      console.error("SYNTAX_ERROR_ORIGIN [inventory-count loader] 上記の stack の先頭が発生箇所です:", stack ?? "no stack");
    }
    return {
      locations: [] as LocationNode[],
      collections: [],
      collectionDisplayMap: {} as Record<string, CollectionNode>,
      productGroups: [] as ProductGroup[],
      inventoryCounts: [] as InventoryCount[],
      inventoryCountsVersion: 1,
      skuVariantList: [],
      shopTimezone: "Asia/Tokyo",
      todayInShopTimezone: new Date().toISOString().slice(0, 10),
      stocktakeCsvExportColumns: DEFAULT_STOCKTAKE_CSV_COLUMNS,
      loadError: true as const,
      loadErrorMessage: message,
    };
  }
}

function generateId(prefix: string, existingIds: string[] = []): string {
  let id: string;
  let attempts = 0;
  do {
    const random = randomBytes(6).toString("hex"); // 48-bit entropy
    id = `${prefix}_${Date.now()}_${random}`;
    attempts++;
    if (attempts > 100) break; // safety valve
  } while (existingIds.includes(id));
  return id;
}

/** #C0001 形式の countName から数値を取得。# なし（C0017）にも対応。パースできない場合は 0 */
function parseCountNameNumber(countName: string | null | undefined): number {
  if (!countName || typeof countName !== "string") return 0;
  const s = countName.trim();
  const m = s.match(/^#?C0*(\d+)$/i) ?? s.match(/^0*(\d+)$/);
  return m ? Math.max(0, parseInt(m[1], 10)) : 0;
}

const NEXT_KEY_QUERY = `#graphql query NextKey { currentAppInstallation { metafield(namespace: "${NS}", key: "${INVENTORY_COUNT_NEXT_KEY}") { value } } }`;
const BACKUP_KEY_QUERY = `#graphql query BackupKey { currentAppInstallation { metafield(namespace: "${NS}", key: "${INVENTORY_COUNTS_BACKUP_KEY}") { value } } }`;

/**
 * チャンクを読まずに「次の棚卸番号」（名称＋1）を確実に取得する。
 * session を渡すと direct fetch で syntax error を避ける（棚卸ID発行用）。
 */
async function getNextCountNumber(
  admin: { graphql: (q: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response> },
  session?: { shop?: string; accessToken?: string } | null
): Promise<number> {
  const useDirect = Boolean(session?.shop && session?.accessToken);
  const shopStr = useDirect ? (session!.shop as string) : "";
  const tokenStr = useDirect ? (session!.accessToken as string) : "";
  try {
    const nextJson = useDirect
      ? await loaderGraphql(shopStr, tokenStr, NEXT_KEY_QUERY)
      : (await safeJsonFromResponse(await admin.graphql(NEXT_KEY_QUERY))) as { data?: { currentAppInstallation?: { metafield?: { value?: string } } } };
    const nextVal = (nextJson?.data as { currentAppInstallation?: { metafield?: { value?: string } } })?.currentAppInstallation?.metafield?.value;
    if (nextVal != null && nextVal !== "") {
      const n = parseInt(String(nextVal).trim(), 10);
      if (Number.isInteger(n) && n >= 1) return n;
    }
    const backupJson = useDirect
      ? await loaderGraphql(shopStr, tokenStr, BACKUP_KEY_QUERY)
      : (await safeJsonFromResponse(await admin.graphql(BACKUP_KEY_QUERY))) as { data?: { currentAppInstallation?: { metafield?: { value?: string } } } };
    const backupRaw = (backupJson?.data as { currentAppInstallation?: { metafield?: { value?: string } } })?.currentAppInstallation?.metafield?.value;
    if (backupRaw != null && backupRaw !== "") {
      try {
        const list = JSON.parse(backupRaw) as Array<{ countName?: string | null }>;
        if (Array.isArray(list) && list.length > 0) {
          const maxNum = list.reduce((max, c) => Math.max(max, parseCountNameNumber(c?.countName)), 0);
          if (maxNum >= 0) return maxNum + 1;
        }
      } catch {
        // バックアップパース失敗は次へ
      }
    }
    const [listArr, mainResult] = await Promise.all([readListMainKeyOnly(admin, session), readMainKeyOnly(admin, session)]);
    const candidates = listArr?.length ? listArr : (mainResult && !mainResult.chunked ? mainResult.array : []);
    if (Array.isArray(candidates) && candidates.length > 0) {
      const maxNum = candidates.reduce((max, c) => Math.max(max, parseCountNameNumber((c as { countName?: string }).countName)), 0);
      return maxNum + 1;
    }
  } catch {
    // 単一キー取得失敗時は 1
  }
  return 1;
}

const MAIN_KEY_QUERY = `#graphql query InventoryCountMain { currentAppInstallation { metafield(namespace: "${NS}", key: "${INVENTORY_COUNTS_KEY}") { value } } }`;

/**
 * メインキー（inventory_counts_v1）の値だけを取得。チャンクは読まない。
 * session を渡すと direct fetch で syntax error を避ける。
 */
async function readMainKeyOnly(
  admin: { graphql: (q: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response> },
  session?: { shop?: string; accessToken?: string } | null
): Promise<{ chunked: false; array: InventoryCount[] } | { chunked: true; totalChunks: number } | null> {
  try {
    const mainJson = session?.shop && session?.accessToken
      ? await loaderGraphql(session.shop, session.accessToken, MAIN_KEY_QUERY)
      : (await safeJsonFromResponseForLoader(await admin.graphql(MAIN_KEY_QUERY), null)) as { data?: { currentAppInstallation?: { metafield?: { value?: string } } } } | null;
    const raw = (mainJson?.data as { currentAppInstallation?: { metafield?: { value?: string } } })?.currentAppInstallation?.metafield?.value;
    if (raw == null || raw === "") return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (Array.isArray(parsed)) return { chunked: false, array: parsed as InventoryCount[] };
    const desc = parsed as { _chunked?: boolean; totalChunks?: number };
    if (desc?._chunked && typeof desc.totalChunks === "number" && desc.totalChunks >= 1) {
      return { chunked: true, totalChunks: desc.totalChunks };
    }
    return null;
  } catch (e) {
    // admin.graphql() 内の Shopify API クライアントが空/不正レスポンスで throw する場合がある（syntax error, unexpected end of file）。loader を落とさないため null を返す。
    console.warn("[inventory-count] readMainKeyOnly failed:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

const LIST_MAIN_KEY_QUERY = `#graphql query InventoryCountListMain { currentAppInstallation { metafield(namespace: "${NS}", key: "${INVENTORY_COUNTS_LIST_KEY}") { value } } }`;

/**
 * 一覧用キー（inventory_counts_list_v1）の値だけを取得。チャンクは読まない。
 * session を渡すと direct fetch で syntax error を避ける。
 */
async function readListMainKeyOnly(
  admin: { graphql: (q: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response> },
  session?: { shop?: string; accessToken?: string } | null
): Promise<InventoryCount[]> {
  try {
    const listJson = session?.shop && session?.accessToken
      ? await loaderGraphql(session.shop, session.accessToken, LIST_MAIN_KEY_QUERY)
      : (await safeJsonFromResponseForLoader(await admin.graphql(LIST_MAIN_KEY_QUERY), {})) as { data?: { currentAppInstallation?: { metafield?: { value?: string } } } };
    const raw = (listJson?.data as { currentAppInstallation?: { metafield?: { value?: string } } })?.currentAppInstallation?.metafield?.value;
    if (raw == null || raw === "") return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (Array.isArray(parsed)) return parsed as InventoryCount[];
    const desc = parsed as { _chunked?: boolean; totalChunks?: number };
    if (desc?._chunked && typeof desc.totalChunks === "number") return [];
    return [];
  } catch (e) {
    // admin.graphql() 内の Shopify API クライアントが空/不正レスポンスで throw する場合がある（syntax error, unexpected end of file）。loader を落とさないため [] を返す。
    console.warn("[inventory-count] readListMainKeyOnly failed:", e instanceof Error ? e.message : String(e));
    return [];
  }
}

const VERSION_QUERY_INTERNAL = `#graphql query Version { currentAppInstallation { metafield(namespace: "${NS}", key: "${INVENTORY_COUNTS_VERSION_KEY}") { value } } }`;

/** 楽観ロック用。棚卸一覧のバージョン（保存のたびに +1）を取得。無ければ 1。session を渡すと direct fetch で syntax error を避ける（修復用） */
async function getInventoryCountsVersion(
  admin: { graphql: (q: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response> },
  session?: { shop?: string; accessToken?: string } | null
): Promise<number> {
  try {
    if (session?.shop && session?.accessToken) {
      const json = await loaderGraphql(session.shop, session.accessToken, VERSION_QUERY_INTERNAL);
      const v = (json?.data as { currentAppInstallation?: { metafield?: { value?: string } } })?.currentAppInstallation?.metafield?.value;
      if (v == null || v === "") return 1;
      const n = parseInt(String(v).trim(), 10);
      return Number.isInteger(n) && n >= 1 ? n : 1;
    }
    const resp = await admin.graphql(VERSION_QUERY_INTERNAL);
    const json = (await safeJsonFromResponseForLoader(resp, {})) as { data?: { currentAppInstallation?: { metafield?: { value?: string } } } };
    const v = json?.data?.currentAppInstallation?.metafield?.value;
    if (v == null || v === "") return 1;
    const n = parseInt(String(v).trim(), 10);
    return Number.isInteger(n) && n >= 1 ? n : 1;
  } catch (e) {
    console.warn("[inventory-count] getInventoryCountsVersion failed:", e instanceof Error ? e.message : String(e));
    return 1;
  }
}

const CHUNK_QUERY_VAR = `#graphql query Chunk($key: String!) { currentAppInstallation { metafield(namespace: "${NS}", key: $key) { value } } }`;
const SET_COUNTS_MUTATION = `#graphql mutation SetCounts($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { userErrors { field message } } }`;
const SET_CHUNK_MUTATION = `#graphql mutation SetChunk($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { userErrors { field message } } }`;
const SET_NEXT_MUTATION = `#graphql mutation SetNext($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { userErrors { message } } }`;
const SET_BACKUP_MUTATION = `#graphql mutation SetBackup($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { userErrors { message } } }`;

/**
 * チャンクを全て読まずに、新規棚卸1件だけを末尾に追加する。
 * session を渡すと direct fetch で syntax error を避ける（棚卸ID発行用）。
 */
async function appendNewCountToChunked(
  admin: { graphql: (q: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response> },
  newCount: InventoryCount,
  ownerId: string,
  expectedVersion?: number,
  session?: { shop?: string; accessToken?: string } | null
): Promise<{ userErrors: Array<{ message?: string }> }> {
  const useDirect = Boolean(session?.shop && session?.accessToken);
  const shop = session?.shop ?? "";
  const accessToken = session?.accessToken ?? "";
  const gql = useDirect ? (q: string, v?: Record<string, unknown>) => loaderGraphql(shop, accessToken, q, v) : null;
  const fetchChunk = async (key: string, index: number): Promise<string | null> => {
    if (useDirect) {
      const j = await loaderGraphql(shop, accessToken, CHUNK_QUERY_VAR, { key });
      const val = (j?.data as { currentAppInstallation?: { metafield?: { value?: string } } })?.currentAppInstallation?.metafield?.value;
      return val ?? null;
    }
    return fetchOneChunk(admin, key, index);
  };

  const main = await readMainKeyOnly(admin, session);
  if (!main) {
    const single = [newCount];
    const value = JSON.stringify(single);
    const metafields = [{ ownerId, namespace: NS, key: INVENTORY_COUNTS_KEY, type: "json", value }];
    const res = gql ? await gql(SET_COUNTS_MUTATION, { metafields }) : (await safeJsonFromResponse(await admin.graphql(SET_COUNTS_MUTATION, { variables: { metafields } }))) as Record<string, unknown>;
    const errs = (res?.data as { metafieldsSet?: { userErrors?: Array<{ message?: string }> } })?.metafieldsSet?.userErrors;
    if (errs?.length) return { userErrors: errs };
    return updateNextNumberAndBackupAfterAppend(admin, newCount, ownerId, single, session);
  }
  if (!main.chunked) {
    const fullList = [...main.array, newCount];
    const withNames = ensureCountNamesOnCounts(fullList);
    const opts = useDirect ? { session: { shop, accessToken } } : undefined;
    const { userErrors } = await writeInventoryCountsChunked(admin, withNames as InventoryCount[], ownerId, expectedVersion, opts);
    return userErrors.length ? { userErrors } : updateNextNumberAndBackupAfterAppend(admin, newCount, ownerId, fullList, session);
  }
  const N = main.totalChunks;
  let lastExistingIndex = N - 1;
  for (; lastExistingIndex >= 0; lastExistingIndex--) {
    const raw = await fetchChunk(`${INVENTORY_COUNTS_CHUNK_KEY_PREFIX}${lastExistingIndex}`, lastExistingIndex);
    if (raw != null && raw !== "") break;
  }
  if (lastExistingIndex < 0) {
    return { userErrors: [{ message: "棚卸チャンクが1つも取得できません。修復または再試行してください。" }] };
  }
  const isFillingGap = lastExistingIndex < N - 1;
  if (isFillingGap) {
    const gapChunkIndex = lastExistingIndex + 1;
    const metafields = [{ ownerId, namespace: NS, key: `${INVENTORY_COUNTS_CHUNK_KEY_PREFIX}${gapChunkIndex}`, type: "json", value: JSON.stringify([newCount]) }];
    const res = gql ? await gql(SET_CHUNK_MUTATION, { metafields }) : (await safeJsonFromResponse(await admin.graphql(SET_CHUNK_MUTATION, { variables: { metafields } }))) as { data?: { metafieldsSet?: { userErrors?: Array<{ message?: string }> } } };
    const data = (res?.data as { metafieldsSet?: { userErrors?: Array<{ message?: string }> } })?.metafieldsSet ?? (res as { data?: { metafieldsSet?: { userErrors?: Array<{ message?: string }> } } })?.data?.metafieldsSet;
    if (data?.userErrors?.length) return { userErrors: data.userErrors };
  } else {
    let lastChunk: (InventoryCount | CountPart)[];
    try {
      lastChunk = JSON.parse((await fetchChunk(`${INVENTORY_COUNTS_CHUNK_KEY_PREFIX}${lastExistingIndex}`, lastExistingIndex)) ?? "[]");
    } catch {
      return { userErrors: [{ message: "最後のチャンクのパースに失敗しました。" }] };
    }
    if (!Array.isArray(lastChunk)) lastChunk = [];
    lastChunk = [...lastChunk, newCount];
    const newChunkValue = JSON.stringify(lastChunk);
    const needNewChunk = newChunkValue.length > INVENTORY_COUNTS_CHUNK_BYTES;
    if (needNewChunk) {
      lastChunk = lastChunk.slice(0, -1);
      const onlyNew = [newCount];
      const chunkIndexToWrite = lastExistingIndex + 1;
      const descNew = JSON.stringify({ _chunked: true, totalChunks: N + 1 });
      const batch = [
        { ownerId, namespace: NS, key: INVENTORY_COUNTS_KEY, type: "json" as const, value: descNew },
        { ownerId, namespace: NS, key: `${INVENTORY_COUNTS_CHUNK_KEY_PREFIX}${lastExistingIndex}`, type: "json" as const, value: JSON.stringify(lastChunk) },
        { ownerId, namespace: NS, key: `${INVENTORY_COUNTS_CHUNK_KEY_PREFIX}${chunkIndexToWrite}`, type: "json" as const, value: JSON.stringify(onlyNew) },
      ];
      const res = gql ? await gql(SET_CHUNK_MUTATION, { metafields: batch }) : (await safeJsonFromResponse(await admin.graphql(SET_CHUNK_MUTATION, { variables: { metafields: batch } }))) as { data?: { metafieldsSet?: { userErrors?: Array<{ message?: string }> } } };
      const data = (res?.data as { metafieldsSet?: { userErrors?: Array<{ message?: string }> } })?.metafieldsSet ?? (res as { data?: { metafieldsSet?: { userErrors?: Array<{ message?: string }> } } })?.data?.metafieldsSet;
      if (data?.userErrors?.length) return { userErrors: data.userErrors };
    } else {
      const metafields = [{ ownerId, namespace: NS, key: `${INVENTORY_COUNTS_CHUNK_KEY_PREFIX}${lastExistingIndex}`, type: "json", value: newChunkValue }];
      const res = gql ? await gql(SET_CHUNK_MUTATION, { metafields }) : (await safeJsonFromResponse(await admin.graphql(SET_CHUNK_MUTATION, { variables: { metafields } }))) as { data?: { metafieldsSet?: { userErrors?: Array<{ message?: string }> } } };
      const data = (res?.data as { metafieldsSet?: { userErrors?: Array<{ message?: string }> } })?.metafieldsSet ?? (res as { data?: { metafieldsSet?: { userErrors?: Array<{ message?: string }> } } })?.data?.metafieldsSet;
      if (data?.userErrors?.length) return { userErrors: data.userErrors };
    }
  }
  const nextNum = parseCountNameNumber(newCount.countName) + 1;
  const setNextVars = { metafields: [{ ownerId, namespace: NS, key: INVENTORY_COUNT_NEXT_KEY, type: "json", value: String(nextNum) }] };
  if (gql) await gql(SET_NEXT_MUTATION, setNextVars); else await admin.graphql(SET_NEXT_MUTATION, { variables: setNextVars });
  const toMinimal = (c: InventoryCount) =>
    c
      ? {
          id: c.id,
          locationId: c.locationId,
          status: c.status,
          countName: c.countName,
          createdAt: c.createdAt,
          productGroupIds: Array.isArray(c.productGroupIds) ? c.productGroupIds : c.productGroupId ? [c.productGroupId] : [],
          productGroupNames: Array.isArray((c as any).productGroupNames) ? (c as any).productGroupNames : undefined,
          cancelledGroupIds: Array.isArray((c as any).cancelledGroupIds) ? (c as any).cancelledGroupIds : undefined,
        }
      : null;
  const minimalItem = toMinimal(newCount) as Record<string, unknown>;

  // 履歴一覧は list メタから表示するため、新規1件を list にも追加する（追加しないと発行直後に履歴に表示されない）
  // main がチャンクのとき list が空なら上書きしない（list=[新規1件]にすると既存一覧が消える。loader の main フォールバックで表示される）
  try {
    const listMainJson = gql
      ? await gql(LIST_MAIN_KEY_QUERY)
      : (await safeJsonFromResponseForLoader(await admin.graphql(LIST_MAIN_KEY_QUERY), {})) as { data?: { currentAppInstallation?: { metafield?: { value?: string } } } };
    const listRaw = (listMainJson?.data as { currentAppInstallation?: { metafield?: { value?: string } } })?.currentAppInstallation?.metafield?.value ?? "";
    const listEmpty = listRaw === "" || listRaw === "[]" || !listRaw.trim();
    if (listEmpty) {
      // main はチャンクなので list を [新規1件] で上書きすると既存が消える。スキップ。loader が main チャンクから表示する。
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(listRaw);
      } catch {
        parsed = null;
      }
      const desc = parsed as { _chunked?: boolean; totalChunks?: number } | null;
      if (desc?._chunked && typeof desc.totalChunks === "number" && desc.totalChunks >= 1) {
        const totalChunks = desc.totalChunks;
        const lastIndex = totalChunks - 1;
        const lastKey = `${INVENTORY_COUNTS_LIST_CHUNK_PREFIX}${lastIndex}`;
        const lastRaw = await fetchChunk(lastKey, lastIndex);
        let lastChunk: Record<string, unknown>[] = [];
        if (lastRaw) try {
          const a = JSON.parse(lastRaw);
          if (Array.isArray(a)) lastChunk = a as Record<string, unknown>[];
        } catch {}
        lastChunk.push(minimalItem);
        const newChunkValue = JSON.stringify(lastChunk);
        if (newChunkValue.length <= INVENTORY_COUNTS_CHUNK_BYTES) {
          const listChunkSet = [{ ownerId, namespace: NS, key: lastKey, type: "json" as const, value: newChunkValue }];
          const listChunkRes = gql ? await gql(SET_COUNTS_MUTATION, { metafields: listChunkSet }) : (await safeJsonFromResponse(await admin.graphql(SET_COUNTS_MUTATION, { variables: { metafields: listChunkSet } }))) as Record<string, unknown>;
          if (Array.isArray((listChunkRes?.data as { metafieldsSet?: { userErrors?: unknown[] } })?.metafieldsSet?.userErrors) && (listChunkRes?.data as { metafieldsSet?: { userErrors: unknown[] } }).metafieldsSet!.userErrors.length > 0) {
            console.warn("[inventory-count] appendNewCount: list chunk write userErrors", (listChunkRes?.data as { metafieldsSet?: { userErrors: unknown[] } }).metafieldsSet?.userErrors);
          }
        } else {
          lastChunk.pop();
          const listChunkSet = [
            { ownerId, namespace: NS, key: lastKey, type: "json" as const, value: JSON.stringify(lastChunk) },
            { ownerId, namespace: NS, key: `${INVENTORY_COUNTS_LIST_CHUNK_PREFIX}${totalChunks}`, type: "json" as const, value: JSON.stringify([minimalItem]) },
            { ownerId, namespace: NS, key: INVENTORY_COUNTS_LIST_KEY, type: "json" as const, value: JSON.stringify({ _chunked: true, totalChunks: totalChunks + 1 }) },
          ];
          const listChunkRes = gql ? await gql(SET_COUNTS_MUTATION, { metafields: listChunkSet }) : (await safeJsonFromResponse(await admin.graphql(SET_COUNTS_MUTATION, { variables: { metafields: listChunkSet } }))) as Record<string, unknown>;
          if (Array.isArray((listChunkRes?.data as { metafieldsSet?: { userErrors?: unknown[] } })?.metafieldsSet?.userErrors) && (listChunkRes?.data as { metafieldsSet?: { userErrors: unknown[] } }).metafieldsSet!.userErrors.length > 0) {
            console.warn("[inventory-count] appendNewCount: list new chunk write userErrors", (listChunkRes?.data as { metafieldsSet?: { userErrors: unknown[] } }).metafieldsSet?.userErrors);
          }
        }
      } else if (Array.isArray(parsed)) {
        const arr = [...(parsed as Record<string, unknown>[]), minimalItem];
        const listValue = JSON.stringify(arr);
        if (listValue.length <= INVENTORY_COUNTS_CHUNK_BYTES) {
          const listSet = [{ ownerId, namespace: NS, key: INVENTORY_COUNTS_LIST_KEY, type: "json" as const, value: listValue }];
          const listRes = gql ? await gql(SET_COUNTS_MUTATION, { metafields: listSet }) : (await safeJsonFromResponse(await admin.graphql(SET_COUNTS_MUTATION, { variables: { metafields: listSet } }))) as Record<string, unknown>;
          if (Array.isArray((listRes?.data as { metafieldsSet?: { userErrors?: unknown[] } })?.metafieldsSet?.userErrors) && (listRes?.data as { metafieldsSet?: { userErrors: unknown[] } }).metafieldsSet!.userErrors.length > 0) {
            console.warn("[inventory-count] appendNewCount: list (array) write userErrors", (listRes?.data as { metafieldsSet?: { userErrors: unknown[] } }).metafieldsSet?.userErrors);
          }
        }
      }
    }
  } catch (e) {
    console.warn("[inventory-count] appendNewCount: list metafield append failed (history may not show new count until next save):", e instanceof Error ? e.message : e);
  }

  const backupQuery = `#graphql query Backup { currentAppInstallation { metafield(namespace: "${NS}", key: "${INVENTORY_COUNTS_BACKUP_KEY}") { value } } }`;
  const backupJson = gql ? await gql(backupQuery) : (await safeJsonFromResponse(await admin.graphql(backupQuery))) as { data?: { currentAppInstallation?: { metafield?: { value?: string } } } };
  const backupRaw = (backupJson?.data as { currentAppInstallation?: { metafield?: { value?: string } } })?.currentAppInstallation?.metafield?.value;
  let list: Array<Record<string, unknown>> = [];
  if (backupRaw) try {
    list = JSON.parse(backupRaw);
  } catch {}
  if (!Array.isArray(list)) list = [];
  list.push(minimalItem);
  const backupValue = JSON.stringify(list);
  if (backupValue.length <= INVENTORY_COUNTS_BACKUP_MAX_BYTES) {
    const backupMetafields = [{ ownerId, namespace: NS, key: INVENTORY_COUNTS_BACKUP_KEY, type: "json", value: backupValue }];
    if (gql) await gql(SET_BACKUP_MUTATION, { metafields: backupMetafields }); else await admin.graphql(SET_BACKUP_MUTATION, { variables: { metafields: backupMetafields } });
  }
  return { userErrors: [] };
}

async function updateNextNumberAndBackupAfterAppend(
  admin: { graphql: (q: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response> },
  newCount: InventoryCount,
  ownerId: string,
  fullList: InventoryCount[],
  session?: { shop?: string; accessToken?: string } | null
): Promise<{ userErrors: Array<{ message?: string }> }> {
  const useDirect = Boolean(session?.shop && session?.accessToken);
  const nextNum = fullList.reduce((max, c) => Math.max(max, parseCountNameNumber(c.countName)), 0) + 1;
  const setNextVars = { metafields: [{ ownerId, namespace: NS, key: INVENTORY_COUNT_NEXT_KEY, type: "json", value: String(nextNum) }] };
  if (useDirect) await loaderGraphql(session!.shop as string, session!.accessToken as string, SET_NEXT_MUTATION, setNextVars);
  else await admin.graphql(SET_NEXT_MUTATION, { variables: setNextVars });
  const toMinimal = (c: InventoryCount) =>
    c
      ? {
          id: c.id,
          locationId: c.locationId,
          status: c.status,
          countName: c.countName,
          createdAt: c.createdAt,
          productGroupIds: Array.isArray(c.productGroupIds) ? c.productGroupIds : c.productGroupId ? [c.productGroupId] : [],
          productGroupNames: Array.isArray((c as any).productGroupNames) ? (c as any).productGroupNames : undefined,
          cancelledGroupIds: Array.isArray((c as any).cancelledGroupIds) ? (c as any).cancelledGroupIds : undefined,
        }
      : null;
  const backupValue = JSON.stringify(fullList.map(toMinimal).filter(Boolean));
  if (backupValue.length <= INVENTORY_COUNTS_BACKUP_MAX_BYTES) {
    const backupMetafields = [{ ownerId, namespace: NS, key: INVENTORY_COUNTS_BACKUP_KEY, type: "json", value: backupValue }];
    if (useDirect) await loaderGraphql(session!.shop as string, session!.accessToken as string, SET_BACKUP_MUTATION, { metafields: backupMetafields });
    else await admin.graphql(SET_BACKUP_MUTATION, { variables: { metafields: backupMetafields } });
  }
  return { userErrors: [] };
}

/**
 * 書き込み前に、渡された counts のうち locationId / productGroupIds / groupItems などが
 * 空白の件について、既存ストレージの値を補完する。何らかのアクション・表示・読み込み・確定時に
 * 空白で上書きされて「IDだけ残った」レコードが増えるのを防ぐ。
 */
function mergeExistingNonBlank(counts: InventoryCount[], existing: InventoryCount[]): InventoryCount[] {
  if (!Array.isArray(counts) || counts.length === 0) return counts;
  if (!Array.isArray(existing) || existing.length === 0) return counts;
  const existingById = new Map<string, InventoryCount>();
  for (const e of existing) {
    const id = e?.id ?? (e as { countId?: string }).countId;
    if (id) existingById.set(String(id), e);
  }
  return counts.map((c) => {
    const id = c?.id ?? (c as { countId?: string }).countId;
    if (!id) return c;
    const ex = existingById.get(String(id));
    if (!ex || typeof ex !== "object") return c;
    const out = { ...c };
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
    if (!hasGroupItems && exGroupItems) {
      out.groupItems = ex.groupItems;
    } else if (hasGroupItems && exGroupItems) {
      // ✅ 1グループだけ更新したときに他グループを消さない（既存をベースに payload で上書き）
      out.groupItems = { ...exGroupItems, ...out.groupItems };
    }
    const hasItems = Array.isArray(out.items) && out.items.length > 0;
    const exItems = Array.isArray(ex.items) && ex.items.length > 0;
    if (!hasItems && exItems) out.items = ex.items;
    // ✅ 完了・キャンセルを未処理に戻さない：payload に status が含まれていないときは既存を維持（部分書き・一覧由来で status が欠けることがあるため）
    if (!out.status) {
      if (ex.status) out.status = ex.status;
      if (ex.completedAt) out.completedAt = ex.completedAt;
    } else if ((ex.status === "completed" || ex.status === "cancelled") && !out.completedAt && ex.completedAt) {
      out.completedAt = ex.completedAt;
    }
    // ✅ 既存が完了/キャンセルのとき、payload の in_progress や draft で上書きしない（多発していた「完了→未処理」の要因を残さない）
    if (ex.status === "completed" || ex.status === "cancelled") {
      if (out.status !== "completed" && out.status !== "cancelled") {
        out.status = ex.status;
        out.completedAt = ex.completedAt ?? out.completedAt;
      }
    }
    return out;
  });
}

/**
 * 書き込み直前：id があるのに countName または locationId が空白のレコードは保存しない。
 * 絶対に「空白のID」を新規に永続化しないための最終ガード。
 */
function filterInvalidCountsBeforeWrite(counts: InventoryCount[]): InventoryCount[] {
  if (!Array.isArray(counts) || counts.length === 0) return counts;
  const hasCountName = (c: InventoryCount) => c?.countName != null && String(c.countName).trim() !== "";
  const hasLocationId = (c: InventoryCount) => c?.locationId != null && String(c.locationId).trim() !== "";
  return counts.filter((c) => {
    const id = c?.id ?? (c as { countId?: string }).countId;
    if (!id) return true;
    return hasCountName(c) && hasLocationId(c);
  });
}

/**
 * 欠けている countName にのみ番号を付与する（既存の countName は変更しない）。
 * 管理画面の「棚卸IDを修復」で使用。POS の ensureCountNamesBeforeWrite と同様のロジック。
 */
function ensureCountNamesOnCounts(counts: InventoryCount[]): InventoryCount[] {
  if (!Array.isArray(counts) || counts.length === 0) return counts;
  const hasMissing = counts.some(
    (c) => !c?.countName || String(c.countName).trim() === ""
  );
  if (!hasMissing) return counts;
  const maxExistingNumber = counts.reduce(
    (max, c) => Math.max(max, parseCountNameNumber(c?.countName)),
    0
  );
  const missingCountNameCounts = [...counts]
    .filter((c) => !c?.countName || String(c.countName).trim() === "")
    .sort((a, b) => {
      const aTime = new Date(a?.createdAt ?? 0).getTime();
      const bTime = new Date(b?.createdAt ?? 0).getTime();
      if (aTime !== bTime) return aTime - bTime;
      return String(a?.id ?? "").localeCompare(String(b?.id ?? ""), undefined, { numeric: true });
    });
  const assignedCountNameById = new Map<string, string>();
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

const SKU_BATCH_SIZE = 25;
const SKU_BATCH_CONCURRENCY = 10;
/** Shopify GraphQL nodes(ids) の最大件数（250を超えるとエラーになるため編集時の商品リスト取得でチャンクに分割） */
const NODES_IDS_MAX = 250;

/**
 * SKU一覧をShopify APIで検索し、対応するinventoryItemIdの配列を返す。
 * コレクションに依存せず「グループ名＋SKU」で商品グループを定義するために使用。
 * 行数が多いCSV用に、複数SKUを1クエリ（OR）でバッチ取得し、並列実行で時間を短縮する。
 */
async function resolveSkusToInventoryItemIds(
  admin: { graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response> },
  skus: string[]
): Promise<string[]> {
  const trimmed = [...new Set(skus.map((s) => String(s ?? "").trim()).filter(Boolean))];
  if (trimmed.length === 0) return [];

  const escapeSku = (s: string) => `sku:${s.replace(/"/g, '\\"')}`;

  // ✅ 戻り値は常に入力 skus の並び順（CSV登録順の表示に合わせる）
  if (trimmed.length <= 3) {
    const ids: string[] = [];
    for (const sku of trimmed) {
      try {
        const resp = await admin.graphql(
          `#graphql
            query VariantBySku($first: Int!, $query: String!) {
              productVariants(first: $first, query: $query) {
                nodes { id inventoryItem { id } }
              }
            }
          `,
          { variables: { first: 1, query: escapeSku(sku) } }
        );
        const json = await resp.json();
        const nodes = json?.data?.productVariants?.nodes ?? [];
        for (const node of nodes) {
          if (node?.inventoryItem?.id && !ids.includes(node.inventoryItem.id)) {
            ids.push(node.inventoryItem.id);
          }
        }
      } catch {
        // SKU resolve failed for this row; skip
      }
    }
    return ids;
  }

  const batches: string[][] = [];
  for (let i = 0; i < trimmed.length; i += SKU_BATCH_SIZE) {
    batches.push(trimmed.slice(i, i + SKU_BATCH_SIZE));
  }

  // SKU → inventoryItemId のマップを貯め、最後に trimmed の並びで返す（表示を skus 順に統一）
  const skuToId = new Map<string, string>();

  const runBatch = async (batch: string[]): Promise<Map<string, string>> => {
    const queryStr = batch.map(escapeSku).join(" OR ");
    if (!queryStr) return new Map();
    try {
      const resp = await admin.graphql(
        `#graphql
          query VariantsBySkus($first: Int!, $query: String!) {
            productVariants(first: $first, query: $query) {
              nodes { id sku inventoryItem { id } }
            }
          }
        `,
        { variables: { first: batch.length + 10, query: queryStr } }
      );
      const json = await resp.json();
      const nodes = json?.data?.productVariants?.nodes ?? [];
      const map = new Map<string, string>();
      for (const node of nodes) {
        const sku = node?.sku != null ? String(node.sku).trim() : "";
        if (sku && node?.inventoryItem?.id && !map.has(sku)) map.set(sku, node.inventoryItem.id);
      }
      return map;
    } catch {
      const map = new Map<string, string>();
      for (const sku of batch) {
        try {
          const resp = await admin.graphql(
            `#graphql
              query VariantBySku($first: Int!, $query: String!) {
                productVariants(first: $first, query: $query) {
                  nodes { id sku inventoryItem { id } }
                }
              }
            `,
            { variables: { first: 1, query: escapeSku(sku) } }
          );
          const json = await resp.json();
          const nodes = json?.data?.productVariants?.nodes ?? [];
          for (const node of nodes) {
            const s = node?.sku != null ? String(node.sku).trim() : "";
            if (s && node?.inventoryItem?.id && !map.has(s)) map.set(s, node.inventoryItem.id);
          }
        } catch {
          //
        }
      }
      return map;
    }
  };

  for (let i = 0; i < batches.length; i += SKU_BATCH_CONCURRENCY) {
    const chunk = batches.slice(i, i + SKU_BATCH_CONCURRENCY);
    const results = await Promise.all(chunk.map(runBatch));
    for (const map of results) {
      for (const [sku, id] of map) {
        if (!skuToId.has(sku)) skuToId.set(sku, id);
      }
    }
  }

  const inventoryItemIds: string[] = [];
  const seenIds = new Set<string>();
  for (const sku of trimmed) {
    const id = skuToId.get(sku);
    if (id && !seenIds.has(id)) {
      seenIds.add(id);
      inventoryItemIds.push(id);
    }
  }
  return inventoryItemIds;
}

/**
 * 商品グループの inventoryItemIds を取得する。
 * 既に保存されていればそれを返し、なければコレクションまたはSKUから取得する。
 * 棚卸作成時に全グループ分の商品リストを count に保存するために使用。
 */
async function getInventoryItemIdsForGroup(
  admin: { graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response> },
  group: ProductGroup
): Promise<string[]> {
  if (group.inventoryItemIds && group.inventoryItemIds.length > 0) {
    return [...group.inventoryItemIds];
  }
  const ids: string[] = [];
  if (group.collectionIds?.length) {
    const collectionConfigs = group.collectionConfigs ?? [];
    for (const collectionId of group.collectionIds) {
      const config = collectionConfigs.find((c) => c.collectionId === collectionId);
      const selectedVariantIds = config?.selectedVariantIds ?? [];
      try {
        const productsResp = await admin.graphql(
          `#graphql
            query CollectionProducts($id: ID!, $first: Int!) {
              collection(id: $id) {
                id
                products(first: $first) {
                  nodes {
                    id
                    variants(first: 250) {
                      nodes {
                        id
                        inventoryItem { id }
                      }
                    }
                  }
                }
              }
            }
          `,
          { variables: { id: collectionId, first: 250 } }
        );
        const productsData = (await safeJsonFromResponse(productsResp)) as Record<string, unknown>;
        const collection = (productsData?.data as Record<string, unknown>)?.collection as Record<string, unknown> | undefined;
        if (collection) {
          const nodes = (collection.products as Record<string, unknown> | undefined)?.nodes as Array<Record<string, unknown>> | undefined;
          for (const product of nodes ?? []) {
            const variantNodes = (product.variants as Record<string, unknown> | undefined)?.nodes as Array<Record<string, unknown>> | undefined;
            for (const variant of variantNodes ?? []) {
              const invItem = (variant as Record<string, unknown>)?.inventoryItem as Record<string, unknown> | undefined;
              const invId = invItem?.id as string | undefined;
              if (invId) {
                const vId = (variant as Record<string, unknown>).id as string | undefined;
                if (selectedVariantIds.length === 0 || (vId && selectedVariantIds.includes(vId))) {
                  if (!ids.includes(invId)) {
                    ids.push(invId);
                  }
                }
              }
            }
          }
        }
      } catch (e) {
        console.error(`Failed to get inventoryItemIds from collection ${collectionId}:`, e);
      }
    }
  }
  if (ids.length > 0) return ids;
  if (group.skus?.length) {
    return resolveSkusToInventoryItemIds(admin, group.skus);
  }
  return [];
}

export async function action({ request }: ActionFunctionArgs) {
  let { admin, session } = await authenticate.admin(request);
  admin = withGraphQLRetry(admin);
  const formData = await request.formData();
  const actionType = (formData.get("action") ?? formData.get("actionType")) as string;
  const expectedVersionRaw = formData.get("inventoryCountsVersion");
  const expectedVersion =
    expectedVersionRaw != null && String(expectedVersionRaw).trim() !== ""
      ? parseInt(String(expectedVersionRaw).trim(), 10)
      : undefined;
  const expectedVersionNum = Number.isInteger(expectedVersion) ? expectedVersion : undefined;

  try {
  // SKU検索は metafield 不要のため先に実行（ownerId 未取得で早期 return されないようにする）
  if (actionType === "search_variants_by_sku") {
    const query = (formData.get("query") as string)?.trim();
    if (!query || query.length < 1) {
      return { ok: true, variants: [] };
    }
    try {
      const resp = await admin.graphql(
        `#graphql
          query SearchVariants($first: Int!, $query: String!) {
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
          }
        `,
        { variables: { first: 50, query: `sku:${query.replace(/"/g, '\\"')}` } }
      );
      const json = await resp.json();
      const nodes = json?.data?.productVariants?.nodes ?? [];
      const variants = nodes.map((n: { id: string; title?: string; sku?: string; barcode?: string; inventoryItem?: { id: string }; product?: { title?: string } }) => ({
        variantId: n.id,
        inventoryItemId: n.inventoryItem?.id,
        sku: n.sku ?? "",
        barcode: n.barcode ?? "",
        variantTitle: n.title ?? "",
        productTitle: n.product?.title ?? "",
        title: (n.product?.title ?? "") + (n.title && n.title !== "Default Title" ? ` / ${n.title}` : ""),
      })).filter((v: { inventoryItemId?: string }) => v.inventoryItemId);
      return { ok: true, variants };
    } catch {
      return { ok: true, variants: [] };
    }
  }

  // 棚卸: コレクション検索（検索結果のみ返す。全件読み込みを避ける）
  if (actionType === "searchCollectionsForInventoryCount") {
    const query = String(formData.get("query") ?? "").trim();
    if (!query) return { ok: true, collections: [] };
    try {
      const gql = `#graphql
        query SearchCollections($first: Int!, $query: String!) {
          collections(first: $first, query: $query) {
            nodes {
              id
              title
              image { url altText }
            }
          }
        }`;
      const variables = { first: 50, query: query.replace(/"/g, '\\"') };
      const resp = await admin.graphql(gql, { variables });
      const json = await resp.json();
      const nodes = json?.data?.collections?.nodes ?? [];
      const collections = nodes.map((c: { id: string; title?: string; image?: { url?: string; altText?: string } | null }) => ({
        id: c.id,
        title: c.title ?? "",
        image: c.image ?? null,
      }));
      return { ok: true, collections };
    } catch {
      return { ok: true, collections: [] };
    }
  }

  // 棚卸: バリアント検索（SKU・商品名。仕入と同様に検索結果のみ返す）
  if (actionType === "searchVariantsForInventoryCount") {
    const query = String(formData.get("query") ?? "").trim();
    if (!query) return { ok: true, variants: [] };
    try {
      const gql = `#graphql
        query SearchVariantsForInventoryCount($first: Int!, $query: String!) {
          productVariants(first: $first, query: $query) {
            nodes {
              id
              title
              sku
              barcode
              inventoryItem { id }
              product { title }
              selectedOptions { name value }
            }
          }
        }`;
      const escaped = query.replace(/"/g, '\\"');
      const resp = await admin.graphql(gql, {
        variables: { first: 50, query: `sku:*${escaped}* OR title:*${escaped}*` },
      });
      const json = await resp.json();
      const nodes = json?.data?.productVariants?.nodes ?? [];
      const variants = nodes.map((v: { id: string; title?: string; sku?: string; barcode?: string; inventoryItem?: { id: string }; product?: { title?: string }; selectedOptions?: Array<{ value?: string }> }) => {
        const opts = v.selectedOptions ?? [];
        const productTitle = v.product?.title ?? "";
        const variantTitle = v.title ?? "";
        return {
          variantId: v.id,
          inventoryItemId: v.inventoryItem?.id ?? "",
          sku: v.sku ?? "",
          barcode: v.barcode ?? "",
          variantTitle,
          productTitle,
          title: productTitle + (variantTitle && variantTitle !== "Default Title" ? ` / ${variantTitle}` : ""),
          option1: opts[0]?.value?.trim() || undefined,
          option2: opts[1]?.value?.trim() || undefined,
          option3: opts[2]?.value?.trim() || undefined,
        };
      }).filter((v: { inventoryItemId: string }) => v.inventoryItemId);
      return { ok: true, variants };
    } catch {
      return { ok: true, variants: [] };
    }
  }

  // 棚卸: 編集時・選択済み表示用にコレクション id/title を取得
  if (actionType === "getCollectionsByIds") {
    const idsStr = formData.get("ids") as string;
    let ids: string[] = [];
    try {
      if (idsStr) ids = JSON.parse(idsStr);
      if (!Array.isArray(ids)) ids = [];
    } catch {}
    if (ids.length === 0) return { ok: true, collections: [] };
    try {
      const gql = `#graphql
        query GetCollectionNodes($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Collection {
              id
              title
              image { url altText }
            }
          }
        }`;
      const resp = await admin.graphql(gql, { variables: { ids } });
      const json = await resp.json();
      const nodes = json?.data?.nodes ?? [];
      const collections = nodes
        .filter((n: unknown) => n && typeof n === "object" && "id" in n)
        .map((c: { id: string; title?: string; image?: { url?: string; altText?: string } | null }) => ({
          id: c.id,
          title: c.title ?? "",
          image: c.image ?? null,
        }));
      return { ok: true, collections };
    } catch {
      return { ok: true, collections: [] };
    }
  }

  // 棚卸: 編集時・選択済み表示用に inventoryItemId からバリアント情報を取得（nodes(ids) は250件までなのでチャンク分割）
  if (actionType === "getVariantsByInventoryItemIds") {
    const idsStr = formData.get("ids") as string;
    let ids: string[] = [];
    try {
      if (idsStr) ids = JSON.parse(idsStr);
      if (!Array.isArray(ids)) ids = [];
    } catch {}
    if (ids.length === 0) return { ok: true, variants: [] };
    try {
      const gql = `#graphql
        query GetInventoryItemNodes($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on InventoryItem {
              id
              variant {
                id
                title
                sku
                barcode
                inventoryItem { id }
                product { title }
                selectedOptions { name value }
              }
            }
          }
        }`;
      const variants: SkuSearchVariant[] = [];
      const seenIds = new Set<string>();
      for (let i = 0; i < ids.length; i += NODES_IDS_MAX) {
        const chunk = ids.slice(i, i + NODES_IDS_MAX);
        const resp = await admin.graphql(gql, { variables: { ids: chunk } });
        const json = await resp.json();
        const nodes = json?.data?.nodes ?? [];
        for (const n of nodes) {
          const v = n?.variant;
          if (!v?.inventoryItem?.id) continue;
          if (seenIds.has(v.inventoryItem.id)) continue;
          seenIds.add(v.inventoryItem.id);
          const opts = v.selectedOptions ?? [];
          const productTitle = v.product?.title ?? "";
          const variantTitle = v.title ?? "";
          variants.push({
            variantId: v.id,
            inventoryItemId: v.inventoryItem.id,
            sku: v.sku ?? "",
            barcode: v.barcode ?? "",
            variantTitle,
            productTitle,
            title: productTitle + (variantTitle && variantTitle !== "Default Title" ? ` / ${variantTitle}` : ""),
            option1: opts[0]?.value?.trim() || undefined,
            option2: opts[1]?.value?.trim() || undefined,
            option3: opts[2]?.value?.trim() || undefined,
          });
        }
      }
      // 表示を skus（＝CSV登録順）に合わせて、要求した ids の並びでソート
      const idToIndex = new Map(ids.map((id, idx) => [id, idx]));
      variants.sort((a, b) => (idToIndex.get(a.inventoryItemId) ?? 999999) - (idToIndex.get(b.inventoryItemId) ?? 999999));
      return { ok: true, variants };
    } catch {
      return { ok: true, variants: [] };
    }
  }

  // 棚卸: 編集時・CSV由来など「skus はあるが inventoryItemIds が空」のグループ用に SKU からバリアント情報を取得（nodes(ids) は250件までなのでチャンク分割）
  if (actionType === "getVariantsBySkus") {
    const skusStr = formData.get("skus") as string;
    let skus: string[] = [];
    try {
      if (skusStr) skus = JSON.parse(skusStr);
      if (!Array.isArray(skus)) skus = [];
    } catch {}
    if (skus.length === 0) return { ok: true, variants: [] };
    try {
      const ids = await resolveSkusToInventoryItemIds(admin, skus);
      if (ids.length === 0) return { ok: true, variants: [] };
      const gql = `#graphql
        query GetInventoryItemNodes($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on InventoryItem {
              id
              variant {
                id
                title
                sku
                barcode
                inventoryItem { id }
                product { title }
                selectedOptions { name value }
              }
            }
          }
        }`;
      const variants: SkuSearchVariant[] = [];
      const seenIds = new Set<string>();
      for (let i = 0; i < ids.length; i += NODES_IDS_MAX) {
        const chunk = ids.slice(i, i + NODES_IDS_MAX);
        const resp = await admin.graphql(gql, { variables: { ids: chunk } });
        const json = await resp.json();
        const nodes = json?.data?.nodes ?? [];
        for (const n of nodes) {
          const v = n?.variant;
          if (!v?.inventoryItem?.id) continue;
          if (seenIds.has(v.inventoryItem.id)) continue;
          seenIds.add(v.inventoryItem.id);
          const opts = v.selectedOptions ?? [];
          const productTitle = v.product?.title ?? "";
          const variantTitle = v.title ?? "";
          variants.push({
            variantId: v.id,
            inventoryItemId: v.inventoryItem.id,
            sku: v.sku ?? "",
            barcode: v.barcode ?? "",
            variantTitle,
            productTitle,
            title: productTitle + (variantTitle && variantTitle !== "Default Title" ? ` / ${variantTitle}` : ""),
            option1: opts[0]?.value?.trim() || undefined,
            option2: opts[1]?.value?.trim() || undefined,
            option3: opts[2]?.value?.trim() || undefined,
          });
        }
      }
      // 表示を skus（＝CSV登録順）に合わせて、resolve 済み ids（skus 順）でソート
      const idToIndex = new Map(ids.map((id, idx) => [id, idx]));
      variants.sort((a, b) => (idToIndex.get(a.inventoryItemId) ?? 999999) - (idToIndex.get(b.inventoryItemId) ?? 999999));
      return { ok: true, variants };
    } catch {
      return { ok: true, variants: [] };
    }
  }

  const appInstResp = await admin.graphql(
    `#graphql
      query GetAppInstallation {
        currentAppInstallation { id }
      }
    `
  );
  const appInstJson = await appInstResp.json();
  const ownerId = appInstJson?.data?.currentAppInstallation?.id as string;

  if (!ownerId) {
    return { ok: false, error: "currentAppInstallation.id が取得できませんでした" as const };
  }

  if (actionType === "repair_count_names") {
    try {
      const counts = await readInventoryCountsChunked(admin);
      const countsWithName = ensureCountNamesOnCounts(counts);
      const repairedCount = countsWithName.filter(
        (c, i) => !counts[i]?.countName || String(counts[i].countName).trim() === ""
      ).length;
      const { userErrors } = await writeInventoryCountsChunked(admin, countsWithName, ownerId, expectedVersionNum);
      if (userErrors.length) {
        return { ok: false, error: userErrors.map((e) => e?.message ?? "").join(" / ") as const };
      }
      return { ok: true, repaired: repairedCount } as const;
    } catch (e) {
      console.error("[inventory-count] repair_count_names failed:", e);
      return { ok: false, error: "棚卸IDの修復中にエラーが発生しました。時間をおいて再度お試しください。" as const };
    }
  }

  if (actionType === "metafield_health") {
    try {
      const health = await getMetafieldHealth(admin, session);
      return { ok: true, health } as const;
    } catch (e) {
      console.error("[inventory-count] metafield_health failed:", e);
      return { ok: false, error: "状態の取得に失敗しました。" as const };
    }
  }

  if (actionType === "metafield_repair") {
    try {
      const health = await getMetafieldHealth(admin, session);
      if (health.status === "ok" && health.mainKey !== "chunked") {
        return { ok: true, repaired: false, message: "修復の必要はありません。" } as const;
      }
      // 修復時のみ欠落チャンクをスキップして読み進める（通常の防御は外す）
      const counts = await readInventoryCountsChunked(admin, { allowMissingChunksForRepair: true });
      // 修復時の write は session で direct fetch を使い、既読の counts を渡して syntax error を避ける
      const version = await getInventoryCountsVersion(admin, session);
      const repairSession = session?.shop && session?.accessToken ? { shop: session.shop, accessToken: session.accessToken } : undefined;
      const { userErrors } = await writeInventoryCountsChunked(admin, counts, ownerId, version, {
        session: repairSession ?? undefined,
        existingCounts: counts,
      });
      if (userErrors.length) {
        return { ok: false, error: userErrors.map((e) => e?.message ?? "").join(" / ") as const };
      }
      return { ok: true, repaired: true, message: "メタフィールドを再書き込みし、不整合を解消しました。" } as const;
    } catch (e) {
      console.error("[inventory-count] metafield_repair failed:", e);
      return { ok: false, error: "修復中にエラーが発生しました: " + (e instanceof Error ? e.message : String(e)) as const };
    }
  }

  // 現在のデータを取得（商品グループは常に取得。棚卸フルデータは create 以外で取得。create はチャンクを読まず append で発行する）
  const needInventoryCounts =
    actionType === "update_stocktake_quantity" ||
    actionType === "confirm_stocktake_group" ||
    actionType === "reset_stocktake_group" ||
    actionType === "confirm_stocktake_all" ||
    actionType === "reset_stocktake_all" ||
    actionType === "cancel_stocktake_group" ||
    actionType === "cancel_stocktake" ||
    actionType === "get_count_full" ||
    actionType === "restore_count_as_completed" ||
    actionType === "redistribute_count_group_items" ||
    actionType === "ensure_count_groups_completed" ||
    actionType === "sort_counts_by_count_name";
  const [currentResp, inventoryCountsFromChunked] = await Promise.all([
    admin.graphql(
      `#graphql
        query GetCurrentData {
          currentAppInstallation {
            productGroupsMetafield: metafield(namespace: "${NS}", key: "${PRODUCT_GROUPS_KEY}") { value }
          }
        }
      `
    ),
    needInventoryCounts ? readInventoryCountsChunked(admin) : Promise.resolve([]),
  ]);
  const currentJson = await currentResp.json();
  let productGroups: ProductGroup[] = [];
  let inventoryCounts: InventoryCount[] = Array.isArray(inventoryCountsFromChunked) ? inventoryCountsFromChunked : [];

  const groupsRaw = currentJson?.data?.currentAppInstallation?.productGroupsMetafield?.value;
  if (typeof groupsRaw === "string" && groupsRaw) {
    try {
      productGroups = JSON.parse(groupsRaw) || [];
    } catch {}
  }

  // ✅ 欠損した棚卸を「指定の棚卸ID・ロケーション・商品グループ」で復元し、現在在庫で完了確定する（一時対応）
  if (actionType === "restore_count_as_completed") {
    const countId = (formData.get("countId") as string)?.trim();
    const countName = (formData.get("countName") as string)?.trim();
    const locationIdParam = (formData.get("locationId") as string)?.trim();
    const productGroupIdsStr = formData.get("productGroupIds") as string;
    const productGroupNamesStr = formData.get("productGroupNames") as string | null;
    if (!countId || !countName || !locationIdParam || !productGroupIdsStr) {
      return { ok: false, error: "countId, countName, locationId, productGroupIds は必須です" as const };
    }
    let productGroupIds: string[] = [];
    let productGroupNames: string[] | undefined;
    try {
      productGroupIds = JSON.parse(productGroupIdsStr);
      if (!Array.isArray(productGroupIds)) productGroupIds = [];
    } catch {
      return { ok: false, error: "productGroupIds は JSON 配列で指定してください" as const };
    }
    if (productGroupIds.length === 0) {
      return { ok: false, error: "商品グループを1つ以上指定してください" as const };
    }
    if (productGroupNamesStr) {
      try {
        const parsed = JSON.parse(productGroupNamesStr);
        productGroupNames = Array.isArray(parsed) ? parsed : undefined;
      } catch {}
    }
    const count = inventoryCounts.find((c) => String(c.id) === String(countId) || normalizeIdForMatch(c.id) === normalizeIdForMatch(countId));
    if (!count) return { ok: false, error: "指定された棚卸が見つかりません" as const };
    const duplicateName = inventoryCounts.find((c) => String(c.countName || "").trim() === String(countName).trim() && String(c.id) !== String(countId));
    if (duplicateName) return { ok: false, error: `棚卸ID「${countName}」は既に別の棚卸で使用されています` as const };
    let locationId = locationIdParam;
    if (!locationId.startsWith("gid://")) {
      const numMatch = locationId.match(/\d+/);
      if (numMatch) locationId = `gid://shopify/Location/${numMatch[0]}`;
    }
    const groupItemsMap = (count as any).groupItems && typeof (count as any).groupItems === "object" ? (count as any).groupItems : {};
    const itemsLegacy = Array.isArray(count.items) ? count.items : [];
    const allEntries: Array<{ inventoryItemId: string; [k: string]: unknown }> = [];
    for (const arr of Object.values(groupItemsMap)) {
      if (Array.isArray(arr)) allEntries.push(...arr.map((it: any) => ({ ...it, inventoryItemId: String(it?.inventoryItemId ?? "").trim() })));
    }
    if (allEntries.length === 0 && itemsLegacy.length > 0) {
      itemsLegacy.forEach((it: any) => allEntries.push({ ...it, inventoryItemId: String(it?.inventoryItemId ?? "").trim() }));
    }
    allEntries.forEach((e, idx) => {
      if (!(e as any).inventoryItemId && (e as any).id) (e as any).inventoryItemId = (e as any).id;
    });
    const BATCH = 5;
    const DELAY_MS = 200;
    const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    for (let i = 0; i < allEntries.length; i += BATCH) {
      if (i > 0) await delay(DELAY_MS);
      const batch = allEntries.slice(i, i + BATCH);
      const results = await Promise.all(
        batch.map(async (it: any) => {
          const id = String(it?.inventoryItemId ?? it?.id ?? "").trim();
          if (!id) return { ...it, currentQuantity: 0, actualQuantity: 0, delta: 0 };
          const gid = id.startsWith("gid://") ? id : `gid://shopify/InventoryItem/${id.replace(/\D/g, "") || id}`;
          try {
            const resp = await admin.graphql(
              `#graphql
              query ItemLevel($id: ID!, $loc: ID!) {
                inventoryItem(id: $id) {
                  id
                  inventoryLevel(locationId: $loc) {
                    quantities(names: ["available"]) { name quantity }
                  }
                }
              }
            `,
              { variables: { id: gid, loc: locationId } }
            );
            const json = await resp.json();
            const item = json?.data?.inventoryItem;
            const qty = item?.inventoryLevel?.quantities?.find((x: { name?: string }) => x.name === "available")?.quantity;
            const currentQuantity = qty != null ? Number(qty) : 0;
            return { ...it, currentQuantity, actualQuantity: currentQuantity, delta: 0 };
          } catch {
            return { ...it, currentQuantity: 0, actualQuantity: 0, delta: 0 };
          }
        })
      );
      for (let j = 0; j < results.length; j++) {
        allEntries[i + j] = results[j];
      }
    }
    // 複数グループ時は商品グループの inventoryItemIds で所属を判定し、グループごとに振り分ける（アプリタイルで「一番上だけ処理済み」にならないようにする）
    const invIdToGroupId = new Map<string, string>();
    for (const gid of productGroupIds) {
      const g = productGroups.find((gr) => gr.id === gid || normalizeIdForMatch(gr.id) === normalizeIdForMatch(gid));
      const ids = (g as any)?.inventoryItemIds ?? [];
      if (Array.isArray(ids)) {
        for (const id of ids) {
          const n = normalizeIdForMatch(String(id ?? "").trim());
          if (n && !invIdToGroupId.has(n)) invIdToGroupId.set(n, gid);
        }
      }
    }
    const groupItemsNew: Record<string, unknown[]> = {};
    for (const gid of productGroupIds) {
      const normalizedGid = normalizeIdForMatch(gid);
      groupItemsNew[gid] = allEntries.filter((it: any) => {
        const invNorm = normalizeIdForMatch(String(it?.inventoryItemId ?? "").trim());
        const assigned = invIdToGroupId.get(invNorm);
        return assigned != null && normalizeIdForMatch(assigned) === normalizedGid;
      });
    }
    const assignedCount = Object.values(groupItemsNew).reduce((s, a) => s + (Array.isArray(a) ? a.length : 0), 0);
    if (assignedCount < allEntries.length && productGroupIds.length > 0) {
      const firstGroupId = productGroupIds[0];
      const unassigned = allEntries.filter((it: any) => {
        const invNorm = normalizeIdForMatch(String(it?.inventoryItemId ?? "").trim());
        return !invIdToGroupId.has(invNorm);
      });
      if (unassigned.length > 0) {
        const existing = (groupItemsNew[firstGroupId] as unknown[]) ?? [];
        (groupItemsNew as Record<string, unknown[]>)[firstGroupId] = [...existing, ...unassigned];
      }
    }
    const namesFromGroups = productGroupNames && productGroupNames.length > 0
      ? productGroupNames
      : productGroupIds.map((id) => productGroups.find((g) => g.id === id)?.name ?? "");
    const updatedCount: InventoryCount = {
      ...count,
      countName: countName.trim(),
      locationId,
      productGroupIds,
      productGroupNames: namesFromGroups,
      groupItems: groupItemsNew,
      items: [...allEntries],
      status: "completed",
      completedAt: new Date().toISOString(),
    };
    const updatedCounts = inventoryCounts.map((c) =>
      String(c.id) === String(countId) || normalizeIdForMatch(c.id) === normalizeIdForMatch(countId) ? updatedCount : c
    );
    const { userErrors } = await writeInventoryCountsChunked(admin, updatedCounts as InventoryCount[], ownerId, expectedVersionNum);
    if (userErrors.length) return { ok: false, error: userErrors.map((e) => e?.message ?? "").join(" / ") as const };
    return { ok: true, restored: true } as const;
  }

  // ✅ 復元時に1グループにまとめて保存されてしまった棚卸の groupItems を、商品グループごとに正しく振り分け直す
  if (actionType === "redistribute_count_group_items") {
    const countId = (formData.get("countId") as string)?.trim();
    if (!countId) return { ok: false, error: "countId は必須です" as const };
    const count = inventoryCounts.find((c) => String(c.id) === String(countId) || normalizeIdForMatch(c.id) === normalizeIdForMatch(countId));
    if (!count) return { ok: false, error: "指定された棚卸が見つかりません" as const };
    const productGroupIds = Array.isArray(count.productGroupIds) && count.productGroupIds.length > 0
      ? count.productGroupIds
      : count.productGroupId
        ? [count.productGroupId]
        : [];
    if (productGroupIds.length < 2) return { ok: false, error: "複数グループの棚卸のみ振り分け対象です" as const };
    const groupItemsMap = (count as any).groupItems && typeof (count as any).groupItems === "object" ? (count as any).groupItems : {};
    const allEntries: Array<{ inventoryItemId: string; [k: string]: unknown }> = [];
    for (const arr of Object.values(groupItemsMap)) {
      if (Array.isArray(arr)) allEntries.push(...arr.map((it: any) => ({ ...it, inventoryItemId: String(it?.inventoryItemId ?? "").trim() })));
    }
    const itemsLegacy = Array.isArray(count.items) ? count.items : [];
    if (allEntries.length === 0 && itemsLegacy.length > 0) {
      itemsLegacy.forEach((it: any) => allEntries.push({ ...it, inventoryItemId: String(it?.inventoryItemId ?? "").trim() }));
    }
    if (allEntries.length === 0) return { ok: false, error: "振り分けする商品がありません" as const };
    const invIdToGroupId = new Map<string, string>();
    for (const gid of productGroupIds) {
      const g = productGroups.find((gr) => gr.id === gid || normalizeIdForMatch(gr.id) === normalizeIdForMatch(gid));
      const ids = (g as any)?.inventoryItemIds ?? [];
      if (Array.isArray(ids)) {
        for (const id of ids) {
          const n = normalizeIdForMatch(String(id ?? "").trim());
          if (n && !invIdToGroupId.has(n)) invIdToGroupId.set(n, gid);
        }
      }
    }
    const groupItemsNew: Record<string, unknown[]> = {};
    for (const gid of productGroupIds) {
      const normalizedGid = normalizeIdForMatch(gid);
      groupItemsNew[gid] = allEntries.filter((it: any) => {
        const invNorm = normalizeIdForMatch(String(it?.inventoryItemId ?? "").trim());
        const assigned = invIdToGroupId.get(invNorm);
        return assigned != null && normalizeIdForMatch(assigned) === normalizedGid;
      });
    }
    const assignedCount = Object.values(groupItemsNew).reduce((s, a) => s + (Array.isArray(a) ? a.length : 0), 0);
    if (assignedCount < allEntries.length && productGroupIds.length > 0) {
      const firstGroupId = productGroupIds[0];
      const unassigned = allEntries.filter((it: any) => {
        const invNorm = normalizeIdForMatch(String(it?.inventoryItemId ?? "").trim());
        return !invIdToGroupId.has(invNorm);
      });
      if (unassigned.length > 0) {
        const existing = (groupItemsNew[firstGroupId] as unknown[]) ?? [];
        (groupItemsNew as Record<string, unknown[]>)[firstGroupId] = [...existing, ...unassigned];
      }
    }
    const updatedCount: InventoryCount = {
      ...count,
      groupItems: groupItemsNew,
      items: [...allEntries],
    };
    const updatedCounts = inventoryCounts.map((c) =>
      String(c.id) === String(countId) || normalizeIdForMatch(c.id) === normalizeIdForMatch(countId) ? updatedCount : c
    );
    const { userErrors } = await writeInventoryCountsChunked(admin, updatedCounts as InventoryCount[], ownerId, expectedVersionNum);
    if (userErrors.length) return { ok: false, error: userErrors.map((e) => e?.message ?? "").join(" / ") as const };
    return { ok: true, redistributed: true } as const;
  }

  // ✅ 履歴棚卸で「IDは完了だが商品グループが全て未完了」の状態を解消：各グループの現在在庫を取得し、グループごとに完了として保存する
  if (actionType === "ensure_count_groups_completed") {
    const countId = (formData.get("countId") as string)?.trim();
    if (!countId) return { ok: false, error: "countId は必須です" as const };
    const count = inventoryCounts.find((c) => String(c.id) === String(countId) || normalizeIdForMatch(c.id) === normalizeIdForMatch(countId));
    if (!count) return { ok: false, error: "指定された棚卸が見つかりません" as const };
    let locationId = String(count.locationId ?? "").trim();
    if (!locationId) return { ok: false, error: "棚卸にロケーションが設定されていません" as const };
    if (!locationId.startsWith("gid://")) {
      const numMatch = locationId.match(/\d+/);
      if (numMatch) locationId = `gid://shopify/Location/${numMatch[0]}`;
    }
    const productGroupIds = Array.isArray(count.productGroupIds) && count.productGroupIds.length > 0
      ? count.productGroupIds
      : count.productGroupId
        ? [count.productGroupId]
        : [];
    if (productGroupIds.length === 0) return { ok: false, error: "商品グループが設定されていません" as const };

    const BATCH_SIZE = 5;
    const DELAY_MS = 180;
    const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const groupItemsNew: Record<string, unknown[]> = {};
    const allItems: Array<{ variantId: string; inventoryItemId: string; sku: string; title: string; currentQuantity: number; actualQuantity: number; [k: string]: unknown }> = [];

    for (const gid of productGroupIds) {
      const group = productGroups.find((g) => g.id === gid || normalizeIdForMatch(g.id) === normalizeIdForMatch(gid));
      if (!group) continue;
      let ids: string[] = (group as any).inventoryItemIds && Array.isArray((group as any).inventoryItemIds) ? [...(group as any).inventoryItemIds] : [];
      if (ids.length === 0) {
        try {
          ids = await getInventoryItemIdsForGroup(admin, group);
        } catch {
          continue;
        }
      }
      const groupEntries: Array<{ variantId: string; inventoryItemId: string; sku: string; title: string; currentQuantity: number; actualQuantity: number; [k: string]: unknown }> = [];
      for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        if (i > 0) await delay(DELAY_MS);
        const batch = ids.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(
          batch.map(async (inventoryItemId) => {
            const id = String(inventoryItemId ?? "").trim();
            const gidForm = id.startsWith("gid://") ? id : `gid://shopify/InventoryItem/${id.replace(/\D/g, "") || id}`;
            try {
              const resp = await admin.graphql(
                `#graphql
                query ItemAndLevelForEnsure($id: ID!, $loc: ID!) {
                  inventoryItem(id: $id) {
                    id
                    variant {
                      id
                      title
                      sku
                      barcode
                      product { title }
                    }
                    inventoryLevel(locationId: $loc) {
                      quantities(names: ["available"]) { name quantity }
                    }
                  }
                }
              `,
                { variables: { id: gidForm, loc: locationId } }
              );
              const json = await resp.json();
              const item = json?.data?.inventoryItem;
              if (!item?.variant) return null;
              const productTitle = item.variant.product?.title ?? "";
              const variantTitle = item.variant.title ?? "";
              const fullTitle = variantTitle && variantTitle !== "Default Title" ? `${productTitle} / ${variantTitle}` : productTitle;
              const qty = item.inventoryLevel?.quantities?.find((x: { name?: string; quantity?: string }) => x.name === "available")?.quantity;
              const currentQuantity = qty != null ? Number(qty) : 0;
              return {
                variantId: item.variant.id,
                inventoryItemId: item.id,
                sku: item.variant.sku ?? "",
                title: fullTitle,
                currentQuantity,
                actualQuantity: currentQuantity,
              };
            } catch {
              return null;
            }
          })
        );
        for (const r of results) {
          if (r) {
            groupEntries.push(r);
            allItems.push(r);
          }
        }
      }
      groupItemsNew[gid] = groupEntries;
    }

    const productGroupNames = Array.isArray(count.productGroupNames) && count.productGroupNames.length > 0
      ? count.productGroupNames
      : productGroupIds.map((id) => productGroups.find((g) => g.id === id)?.name ?? "");
    const updatedCount: InventoryCount = {
      ...count,
      countName: (count as { countName?: string }).countName ?? count.countName,
      groupItems: groupItemsNew,
      items: [...allItems],
      productGroupNames: productGroupNames.length > 0 ? productGroupNames : undefined,
      status: "completed",
      completedAt: count.completedAt || new Date().toISOString(),
    };
    const updatedCounts = inventoryCounts.map((c) =>
      String(c.id) === String(countId) || normalizeIdForMatch(c.id) === normalizeIdForMatch(countId) ? updatedCount : c
    );
    const { userErrors } = await writeInventoryCountsChunked(admin, updatedCounts as InventoryCount[], ownerId, expectedVersionNum);
    if (userErrors.length) return { ok: false, error: userErrors.map((e) => e?.message ?? "").join(" / ") as const };
    return { ok: true, groupsCompleted: true } as const;
  }

  // ✅ 一度だけ：棚卸一覧を棚卸ID（#C0001, #C0002…）の数値順に並び替えて保存する（main 全件をソートして list/main 両方書き直す）
  if (actionType === "sort_counts_by_count_name") {
    const sorted = [...inventoryCounts].sort((a, b) => {
      const na = parseCountNameNumber((a as { countName?: string }).countName);
      const nb = parseCountNameNumber((b as { countName?: string }).countName);
      return na - nb;
    });
    const { userErrors } = await writeInventoryCountsChunked(admin, sorted as InventoryCount[], ownerId, expectedVersionNum);
    if (userErrors.length) return { ok: false, error: userErrors.map((e) => e?.message ?? "").join(" / ") as const };
    return { ok: true, sortedByCountName: true } as const;
  }

  if (actionType === "save_product_group") {
    const id = formData.get("id") as string;
    const name = formData.get("name") as string;
    const collectionIdsStr = formData.get("collectionIds") as string;
    const collectionIds = collectionIdsStr ? collectionIdsStr.split(",").filter(Boolean) : [];
    const collectionConfigsStr = formData.get("collectionConfigs") as string;
    let collectionConfigs: CollectionConfig[] = [];
    if (collectionConfigsStr) {
      try {
        collectionConfigs = JSON.parse(collectionConfigsStr);
      } catch {
        collectionConfigs = [];
      }
    }
    const inventoryItemIdsStr = formData.get("inventoryItemIds") as string;
    const skusStr = formData.get("skus") as string;
    let directInventoryItemIds: string[] = [];
    let directSkus: string[] = [];
    if (inventoryItemIdsStr) {
      try {
        directInventoryItemIds = JSON.parse(inventoryItemIdsStr);
        if (!Array.isArray(directInventoryItemIds)) directInventoryItemIds = [];
      } catch {}
    }
    if (skusStr) {
      try {
        directSkus = JSON.parse(skusStr);
        if (!Array.isArray(directSkus)) directSkus = [];
      } catch {}
    }

    if (!name?.trim()) {
      return { ok: false, error: "グループ名は必須です" as const };
    }

    // パターン: SKU選択から作成（inventoryItemIds を直接渡した場合）
    if (directInventoryItemIds.length > 0) {
      const index = id ? productGroups.findIndex((g) => g.id === id) : -1;
      // 編集時: 一覧にないSKU（preserved）の skus は既存グループから補完する
      let finalSkus: string[] = directSkus.length > 0 ? [...directSkus] : [];
      if (index >= 0 && directInventoryItemIds.length > directSkus.length) {
        const existing = productGroups[index];
        const existingIds = existing.inventoryItemIds ?? [];
        const existingSkus = existing.skus ?? [];
        for (let i = directSkus.length; i < directInventoryItemIds.length; i++) {
          const invId = directInventoryItemIds[i];
          const idx = existingIds.indexOf(invId);
          if (idx >= 0 && existingSkus[idx] !== undefined) finalSkus.push(existingSkus[idx]);
        }
      }
      const newGroup: ProductGroup = {
        id: index >= 0 ? productGroups[index].id : generateId("group"),
        name: name.trim(),
        collectionIds: index >= 0 ? productGroups[index].collectionIds ?? [] : [],
        collectionConfigs: index >= 0 ? productGroups[index].collectionConfigs : undefined,
        skus: finalSkus.length > 0 ? finalSkus : (index >= 0 ? productGroups[index].skus : undefined),
        inventoryItemIds: directInventoryItemIds,
        createdAt: index >= 0 ? (productGroups[index].createdAt ?? new Date().toISOString()) : new Date().toISOString(),
      };
      if (index >= 0) {
        productGroups[index] = { ...productGroups[index], ...newGroup };
      } else {
        productGroups.push(newGroup);
      }
      const saveResp = await admin.graphql(
        `#graphql
          mutation SaveProductGroups($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
              metafields { id namespace key type }
              userErrors { field message }
            }
          }
        `,
        {
          variables: {
            metafields: productGroupsMetafields(ownerId, productGroups),
          },
        }
      );
      const saveJson = await saveResp.json();
      const errs = saveJson?.data?.metafieldsSet?.userErrors ?? [];
      if (errs.length) {
        return { ok: false, error: errs.map((e: { message?: string }) => e.message).join(" / ") as const };
      }
      return { ok: true };
    }

    // ✅ 商品グループに含まれる商品リスト（inventoryItemIds）を取得（コレクションから）
    const inventoryItemIds: string[] = [];
    try {
      for (const collectionId of collectionIds) {
        const config = collectionConfigs.find((c) => c.collectionId === collectionId);
        
        // コレクションから商品を取得
        const productsResp = await admin.graphql(
          `#graphql
            query CollectionProducts($id: ID!, $first: Int!) {
              collection(id: $id) {
                id
                title
                products(first: $first) {
                  nodes {
                    id
                    title
                    variants(first: 250) {
                      nodes {
                        id
                        title
                        sku
                        barcode
                        inventoryItem {
                          id
                        }
                      }
                    }
                  }
                }
              }
            }
          `,
          { variables: { id: collectionId, first: 250 } }
        );

        const productsData = await productsResp.json();
        const collection = productsData?.data?.collection;
        if (collection) {
          // collectionConfigsで選択された商品のみをフィルタリング
          const selectedVariantIds = config?.selectedVariantIds || [];
          
          for (const product of collection.products?.nodes || []) {
            for (const variant of product.variants?.nodes || []) {
              if (variant.inventoryItem?.id) {
                // 選択された商品のみを追加（selectedVariantIdsが空の場合は全選択）
                if (selectedVariantIds.length === 0 || selectedVariantIds.includes(variant.id)) {
                  const inventoryItemId = variant.inventoryItem.id;
                  if (!inventoryItemIds.includes(inventoryItemId)) {
                    inventoryItemIds.push(inventoryItemId);
                  }
                }
              }
            }
          }
        }
      }
    } catch (e) {
      console.error("Failed to get inventory item IDs:", e);
      // エラーが発生しても保存は続行（商品リストなしで保存）
    }

    // 編集時・コレクション未選択: CSVで登録したSKUベースのグループは既存のinventoryItemIds/skusを維持
    let finalInventoryItemIds = inventoryItemIds.length > 0 ? inventoryItemIds : undefined;
    if (id && collectionIds.length === 0) {
      const existing = productGroups.find((g) => g.id === id);
      if (existing?.inventoryItemIds?.length) {
        finalInventoryItemIds = existing.inventoryItemIds;
      }
    }

    if (id) {
      // 編集
      const index = productGroups.findIndex((g) => g.id === id);
      if (index >= 0) {
        const existing = productGroups[index];
        productGroups[index] = {
          ...existing,
          name: name.trim(),
          collectionIds,
          collectionConfigs: collectionConfigs.length > 0 ? collectionConfigs : undefined,
          inventoryItemIds: finalInventoryItemIds ?? existing.inventoryItemIds,
          skus: existing.skus,
        };
      }
    } else {
      // 新規作成（フォームからはコレクション指定のみ。SKU指定はCSVインポートで行う）
      productGroups.push({
        id: generateId("group"),
        name: name.trim(),
        collectionIds,
        collectionConfigs: collectionConfigs.length > 0 ? collectionConfigs : undefined,
        inventoryItemIds: finalInventoryItemIds ?? (inventoryItemIds.length > 0 ? inventoryItemIds : undefined),
        createdAt: new Date().toISOString(),
      });
    }

    const saveResp = await admin.graphql(
      `#graphql
        mutation SaveProductGroups($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields { id namespace key type }
            userErrors { field message }
          }
        }
      `,
      {
        variables: {
          metafields: productGroupsMetafields(ownerId, productGroups),
        },
      }
    );

    const saveJson = await saveResp.json();
    const errs = saveJson?.data?.metafieldsSet?.userErrors ?? [];
    if (errs.length) {
      return { ok: false, error: errs.map((e: any) => e.message).join(" / ") as const };
    }

    return { ok: true };
  }

  if (actionType === "delete_product_group") {
    const id = formData.get("id") as string;
    productGroups = productGroups.filter((g) => g.id !== id);

    const saveResp = await admin.graphql(
      `#graphql
        mutation SaveProductGroups($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields { id namespace key type }
            userErrors { field message }
          }
        }
      `,
      {
        variables: {
          metafields: productGroupsMetafields(ownerId, productGroups),
        },
      }
    );

    const saveJson = await saveResp.json();
    const errs = saveJson?.data?.metafieldsSet?.userErrors ?? [];
    if (errs.length) {
      return { ok: false, error: errs.map((e: any) => e.message).join(" / ") as const };
    }

    return { ok: true };
  }

  // CSVプレビュー: パースのみ行い、行リストを返す（保存しない）。仕入同様アップロード後にリスト表示してからグループを追加する用
  if (actionType === "preview_csv_inventory_count") {
    const csvRaw = formData.get("csv") as string;
    if (!csvRaw || typeof csvRaw !== "string") {
      return { ok: false, error: "CSVデータが送信されていません" as const };
    }
    const parseCsvLine = (line: string): string[] => {
      const result: string[] = [];
      let current = "";
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') {
          inQuotes = !inQuotes;
        } else if ((c === "," && !inQuotes) || (c === "\t" && !inQuotes)) {
          result.push(current.trim());
          current = "";
        } else {
          current += c;
        }
      }
      result.push(current.trim());
      return result;
    };
    const isHeader = (cells: string[]) =>
      cells.length >= 2 &&
      (cells[0] === "グループ名" || cells[0].toLowerCase() === "group" || cells[0] === "group_name") &&
      (cells[1] === "SKU" || cells[1].toLowerCase() === "sku");

    const lines = csvRaw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const rows: { groupName: string; sku: string }[] = [];
    const firstCells = lines[0] ? parseCsvLine(lines[0]) : [];
    const startIndex = isHeader(firstCells) ? 1 : 0;
    for (let i = startIndex; i < lines.length; i++) {
      const cells = parseCsvLine(lines[i]);
      const groupName = cells[0]?.trim() ?? "";
      const sku = cells[1]?.trim() ?? "";
      if (groupName && sku) rows.push({ groupName, sku });
    }
    return { ok: true, rows };
  }

  // CSVインポート: グループ名＋SKUの行で商品グループを一括登録（コレクションに依存しない）
  // 1ファイル: グループ数は無制限、SKU行数は最大10000行（バッチ＋並列でAPI呼び出しを削減）
  if (actionType === "import_product_groups_csv") {
    const CSV_MAX_ROWS = 10000;
    const csvRaw = formData.get("csv") as string;
    if (!csvRaw || typeof csvRaw !== "string") {
      return { ok: false, error: "CSVデータが送信されていません" as const };
    }
    const csvImportMode = (formData.get("csvImportMode") as string) || "append";

    const lines = csvRaw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) {
      return { ok: false, error: "CSVに有効な行がありません" as const };
    }

    // 1行目がヘッダーかどうか（グループ名, SKU など）
    const parseCsvLine = (line: string): string[] => {
      const result: string[] = [];
      let current = "";
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') {
          inQuotes = !inQuotes;
        } else if ((c === "," && !inQuotes) || (c === "\t" && !inQuotes)) {
          result.push(current.trim());
          current = "";
        } else {
          current += c;
        }
      }
      result.push(current.trim());
      return result;
    };

    const isHeader = (cells: string[]) =>
      cells.length >= 2 &&
      (cells[0] === "グループ名" || cells[0].toLowerCase() === "group" || cells[0] === "group_name") &&
      (cells[1] === "SKU" || cells[1].toLowerCase() === "sku");

    const groupNameToSkus = new Map<string, string[]>();
    let startIndex = 0;
    const firstCells = parseCsvLine(lines[0]);
    if (isHeader(firstCells)) {
      startIndex = 1;
    }

    for (let i = startIndex; i < lines.length; i++) {
      const cells = parseCsvLine(lines[i]);
      const groupName = cells[0]?.trim();
      const sku = cells[1]?.trim();
      if (!groupName) continue;
      if (!sku) continue;
      const list = groupNameToSkus.get(groupName) ?? [];
      if (!list.includes(sku)) list.push(sku);
      groupNameToSkus.set(groupName, list);
    }

    const totalRows = Array.from(groupNameToSkus.values()).reduce((sum, arr) => sum + arr.length, 0);
    if (totalRows > CSV_MAX_ROWS) {
      return { ok: false, error: `CSVのSKU行数が上限（${CSV_MAX_ROWS}行）を超えています（現在${totalRows}行）。ファイルを分割するか行数を減らしてください。` as const };
    }

    if (groupNameToSkus.size === 0) {
      return { ok: false, error: "CSVから有効な「グループ名, SKU」の行がありません。1行目はヘッダー（グループ名,SKU）にできます。" as const };
    }

    let importedCount = 0;
    for (const [name, skus] of groupNameToSkus) {
      const existing = productGroups.find((g) => g.name === name);
      const inventoryItemIds = await resolveSkusToInventoryItemIds(admin, skus);

      if (existing) {
        if (csvImportMode === "new_only") {
          continue;
        }
        if (csvImportMode === "replace") {
          const idx = productGroups.findIndex((g) => g.id === existing.id);
          if (idx >= 0) {
            productGroups[idx] = {
              ...existing,
              skus: [...skus],
              inventoryItemIds: inventoryItemIds.length > 0 ? inventoryItemIds : undefined,
            };
            importedCount++;
          }
        } else {
          const group = {
            ...existing,
            skus: [...new Set([...(existing.skus ?? []), ...skus])],
            inventoryItemIds: [...new Set([...(existing.inventoryItemIds ?? []), ...inventoryItemIds])],
          };
          const idx = productGroups.findIndex((g) => g.id === existing.id);
          if (idx >= 0) {
            productGroups[idx] = group;
            importedCount++;
          }
        }
      } else {
        productGroups.push({
          id: generateId("group"),
          name,
          collectionIds: [],
          skus: [...skus],
          inventoryItemIds: inventoryItemIds.length > 0 ? inventoryItemIds : undefined,
          createdAt: new Date().toISOString(),
        });
        importedCount++;
      }
    }

    const saveResp = await admin.graphql(
      `#graphql
        mutation SaveProductGroups($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields { id namespace key type }
            userErrors { field message }
          }
        }
      `,
      {
        variables: {
          metafields: productGroupsMetafields(ownerId, productGroups),
        },
      }
    );

    const saveJson = await saveResp.json();
    const errs = saveJson?.data?.metafieldsSet?.userErrors ?? [];
    if (errs.length) {
      return { ok: false, error: errs.map((e: { message?: string }) => e.message).join(" / ") as const };
    }

    return { ok: true, imported: importedCount };
  }

  if (actionType === "create_inventory_count") {
    try {
      const locationId = formData.get("locationId") as string;
      const productGroupIdStr = formData.get("productGroupId") as string; // 後方互換性のため残す
      const productGroupIdsStr = formData.get("productGroupIds") as string; // 複数選択対応

      if (!locationId) {
        return { ok: false, error: "ロケーションは必須です" as const };
      }

      // 複数選択対応：productGroupIdsがあればそれを使用、なければproductGroupIdを使用（後方互換性）
      let targetProductGroupIds: string[] = [];
      if (productGroupIdsStr) {
        try {
          targetProductGroupIds = JSON.parse(productGroupIdsStr);
        } catch {
          targetProductGroupIds = productGroupIdsStr.split(",").filter(Boolean);
        }
      } else if (productGroupIdStr) {
        targetProductGroupIds = [productGroupIdStr];
      }

      if (targetProductGroupIds.length === 0) {
        return { ok: false, error: "商品グループは必須です" as const };
      }

      // ※ グループ数制限は解除済み。後で「1グループあたりのSKU制限」「1IDあたりの商品グループ制限」を設定予定。

      // ロケーションを取得（session あれば direct fetch で syntax error 回避）
      const LOCATIONS_QUERY_CREATE = `#graphql query Locations($first: Int!) { locations(first: $first) { nodes { id name } } }`;
      const locData = session?.shop && session?.accessToken
        ? (await loaderGraphql(session.shop, session.accessToken, LOCATIONS_QUERY_CREATE, { first: 250 })) as { data?: { locations?: { nodes?: LocationNode[] } } }
        : (await safeJsonFromResponse(await admin.graphql(LOCATIONS_QUERY_CREATE, { variables: { first: 250 } }))) as { data?: { locations?: { nodes?: LocationNode[] } } };
      const locations: LocationNode[] = locData?.data?.locations?.nodes ?? [];

      // 商品グループ名とinventoryItemIdsを取得（全グループ分を取得してPOSのまとめて表示で読めるようにする）
      // ✅ 制限: リクエストタイムアウト（例: Render 30秒）を避けるため、一定時間を超えたら残りはスキップして保存する
      const INVENTORY_IDS_FETCH_MS = 25_000; //  platform の 30 秒タイムアウトより手前に収める
      const DELAY_BETWEEN_GROUPS_MS = 120; // グループ間の待機（Shopify GraphQL レート制限・スロットルによる500を防ぐ）
      const fetchStart = Date.now();
      const groupNames: string[] = [];
      const inventoryItemIdsByGroup: Record<string, string[]> = {};
      for (let i = 0; i < targetProductGroupIds.length; i++) {
        if (Date.now() - fetchStart > INVENTORY_IDS_FETCH_MS) {
          console.warn("[inventory-count] inventoryItemIds fetch time budget exceeded, saving count with partial groups");
          break;
        }
        const groupId = targetProductGroupIds[i];
        const group = productGroups.find((g) => g.id === groupId);
        if (!group) {
          return { ok: false, error: `商品グループが見つかりません: ${groupId}` as const };
        }
        groupNames.push(group.name);
        try {
          const ids = await getInventoryItemIdsForGroup(admin, group);
          if (ids.length > 0) {
            inventoryItemIdsByGroup[groupId] = ids;
          }
        } catch (e) {
          console.error(`[inventory-count] getInventoryItemIdsForGroup failed for group ${groupId}:`, e);
          // 1グループ失敗しても他は続行し、取得できた分だけ保存する
        }
        // 次のグループの前に短い待機（レート制限を避け、graphQLErrors による 500 を減らす）
        if (i < targetProductGroupIds.length - 1 && DELAY_BETWEEN_GROUPS_MS > 0) {
          await new Promise<void>((r) => setTimeout(r, DELAY_BETWEEN_GROUPS_MS));
        }
      }

      const loc = locations.find((l) => l.id === locationId);
      // チャンクを読まずに次の番号を取得し、1件だけ末尾に追加する（session で direct fetch して syntax error 回避）
      const nextNum = await getNextCountNumber(admin, session);
      const assignedCountName = `#C${String(nextNum).padStart(4, "0")}`;

      // メタフィールド値は 2MB 制限（API 2026-04 以降は 16KB の可能性あり）。大きすぎる場合は ID を保存せず POS でコレクションから読む
      const METAFIELD_VALUE_MAX_BYTES = 500_000; // 500KB に抑えてリクエストタイムアウト・保存失敗を防ぐ
      let inventoryItemIdsOmittedDueToSize = false;
      let inventoryItemIdsToSave: Record<string, string[]> | undefined =
        Object.keys(inventoryItemIdsByGroup).length > 0 ? inventoryItemIdsByGroup : undefined;

      const newCount: InventoryCount = {
        id: generateId("count", inventoryCounts.map((c) => c.id)),
        countName: assignedCountName,
        locationId,
        locationName: loc?.name,
        productGroupId: targetProductGroupIds[0],
        productGroupIds: targetProductGroupIds,
        productGroupName: groupNames[0],
        productGroupNames: groupNames,
        inventoryItemIdsByGroup: inventoryItemIdsToSave,
        inventoryItemIdsOmittedDueToSize,
        status: "draft",
        createdAt: new Date().toISOString(),
      };

      const { userErrors: saveErrs } = await appendNewCountToChunked(admin, newCount, ownerId, expectedVersionNum, session);
      if (saveErrs.length) {
        return { ok: false, error: saveErrs.map((e: { message?: string }) => e.message).join(" / ") as const };
      }

      return {
        ok: true,
        inventoryCountId: newCount.id,
        countName: assignedCountName,
        inventoryItemIdsOmittedDueToSize,
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[inventory-count] create_inventory_count failed:", e);
      // 要因の例: getNextCountNumber の GraphQL 失敗、appendNewCountToChunked 内の updateNextNumberAndBackupAfterAppend 失敗、main 非チャンク時の writeInventoryCountsChunked 内で read がスローした場合など
      return {
        ok: false,
        error: msg && msg.length > 0 && msg.length <= 200 ? `棚卸IDの発行中にエラーが発生しました: ${msg}` as const : "棚卸IDの発行中にエラーが発生しました。時間をおいて再度お試しください。" as const,
      };
    }
  }

  if (actionType === "get_collection_products") {
    const collectionId = formData.get("collectionId") as string;
    if (!collectionId) {
      return { ok: false, error: "コレクションIDは必須です" as const };
    }

    try {
      const COLLECTION_PRODUCTS_QUERY = `#graphql
        query CollectionProducts($id: ID!, $first: Int!, $after: String) {
          collection(id: $id) {
            id
            title
            products(first: $first, after: $after) {
              nodes {
                id
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
        }
      `;

      const products: CollectionProduct[] = [];
      let collectionTitle = "";
      let productsCursor: string | null = null;

      do {
        const productsResp = await admin.graphql(COLLECTION_PRODUCTS_QUERY, {
          variables: { id: collectionId, first: 250, after: productsCursor },
        });
        const productsData = await productsResp.json();
        const collection = productsData?.data?.collection;
        if (!collection) {
          return { ok: false, error: "コレクションが見つかりません" as const };
        }
        collectionTitle = collection.title || "";

        const productNodes = collection.products?.nodes ?? [];
        const pageInfo = collection.products?.pageInfo ?? {};
        for (const product of productNodes) {
          for (const variant of product.variants?.nodes ?? []) {
            if (variant?.inventoryItem?.id) {
              products.push({
                variantId: variant.id,
                inventoryItemId: variant.inventoryItem.id,
                productTitle: product.title || "",
                variantTitle: variant.title || "",
                sku: variant.sku || "",
                barcode: variant.barcode || "",
              });
            }
          }
        }
        productsCursor = pageInfo.hasNextPage ? pageInfo.endCursor ?? null : null;
      } while (productsCursor);

      return {
        ok: true,
        collectionTitle,
        products,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `商品取得エラー: ${errorMessage}` as const };
    }
  }

  // ✅ 未完了グループの商品リストと在庫数を取得（棚卸IDを開いたときの500防止：バッチ間待機・1グループあたり件数上限。offset で「さらに読み込む」対応）
  // ✅ countId をリクエスト・レスポンスに含め、モーダル閉じ後や別棚卸開き直し時の古いレスポンスを無視するため）
  if (actionType === "get_incomplete_group_products") {
    const countId = (formData.get("countId") as string)?.trim() ?? "";
    const groupId = formData.get("groupId") as string;
    let locationId = (formData.get("locationId") as string)?.trim() ?? "";
    const offset = Math.max(0, Number(formData.get("offset") || 0));
    if (!groupId || !locationId) {
      return { ok: false, error: "グループIDまたはロケーションIDが指定されていません" as const };
    }
    // ✅ 同一ショップ複数ブラウザ対策：キャッシュヒット時は Shopify API を叩かず即返す
    const shop = session?.shop ?? "";
    const cacheKey = `incomplete:${shop}:${normalizeIdForMatch(countId)}:${normalizeIdForMatch(groupId)}:${offset}`;
    const cached = incompleteGroupProductsCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.data;

    const DELAY_BETWEEN_BATCHES_MS = 180; // レート制限を避ける（80→180ms：根本対策）
    const MAX_PRODUCTS_PER_GROUP = 600;   // 1リクエストあたりの取得上限（タイムアウト・500防止）
    const THROTTLE_RETRY_DELAY_MS = 1500; // Throttled 時に1回だけリトライするまでの待機（明細欠け対策）
    const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    // ✅ GraphQL inventoryLevel(locationId) 用に GID 形式に正規化（数値のみのとき在庫が取れない場合があるため）
    if (!locationId.startsWith("gid://")) {
      const numMatch = locationId.match(/\d+/);
      if (numMatch) locationId = `gid://shopify/Location/${numMatch[0]}`;
    }

    try {
      const productGroup = productGroups.find((g) => g.id === groupId);
      if (!productGroup) {
        const emptyRes = { ok: true as const, countId, groupId, products: [] as unknown[], hasMore: false, offset: 0 };
        incompleteGroupProductsCache.set(cacheKey, { data: emptyRes, expiresAt: Date.now() + INCOMPLETE_GROUP_PRODUCTS_CACHE_TTL_MS });
        return emptyRes;
      }

      const products: Array<{
        variantId: string;
        inventoryItemId: string;
        productTitle: string;
        variantTitle: string;
        sku: string;
        barcode?: string;
        title: string;
      }> = [];

      // パターン1: inventoryItemIds のみ（CSVインポート等）→ 並列で商品情報＋在庫を取得
      if ((!productGroup.collectionIds?.length) && productGroup.inventoryItemIds?.length) {
        const BATCH_SIZE = 5; // 同時並列数を減らして Throttled を防ぐ（根本対策）
        const ids = productGroup.inventoryItemIds.slice(offset, offset + MAX_PRODUCTS_PER_GROUP);
        const hasMore = productGroup.inventoryItemIds.length > offset + MAX_PRODUCTS_PER_GROUP;
        const allResults: Array<{
          variantId: string;
          inventoryItemId: string;
          productTitle: string;
          variantTitle: string;
          sku: string;
          barcode?: string;
          title: string;
          currentQuantity: number;
          actualQuantity: number;
          delta: number;
        }> = [];
        for (let i = 0; i < ids.length; i += BATCH_SIZE) {
          if (i > 0) await delay(DELAY_BETWEEN_BATCHES_MS);
          const batch = ids.slice(i, i + BATCH_SIZE);
          const results = await Promise.all(
            batch.map(async (inventoryItemId) => {
              try {
                const resp = await admin.graphql(
                  `#graphql
                    query ItemAndLevel($id: ID!, $loc: ID!) {
                      inventoryItem(id: $id) {
                        id
                        variant {
                          id
                          title
                          sku
                          barcode
                          product { title }
                        }
                        inventoryLevel(locationId: $loc) {
                          quantities(names: ["available"]) { name quantity }
                        }
                      }
                    }
                  `,
                  { variables: { id: inventoryItemId, loc: locationId } }
                );
                let json = await resp.json();
                if (Array.isArray(json?.errors) && json.errors.length > 0) {
                  console.error("[inventory-count] get_incomplete_group_products GraphQL errors (pattern1):", JSON.stringify(json.errors));
                  // 根本対策：errors に Throttled が含まれていて data が無い場合は1回だけリトライ
                  const hasThrottledInErrors = json.errors.some((e: { message?: string }) => /throttle/i.test(String(e?.message ?? "")));
                  if (hasThrottledInErrors && !json?.data?.inventoryItem) {
                    await delay(THROTTLE_RETRY_DELAY_MS);
                    const respRetry = await admin.graphql(
                      `#graphql
                    query ItemAndLevel($id: ID!, $loc: ID!) {
                      inventoryItem(id: $id) {
                        id
                        variant {
                          id
                          title
                          sku
                          barcode
                          product { title }
                        }
                        inventoryLevel(locationId: $loc) {
                          quantities(names: ["available"]) { name quantity }
                        }
                      }
                    }
                  `,
                      { variables: { id: inventoryItemId, loc: locationId } }
                    );
                    json = await respRetry.json();
                    if (Array.isArray(json?.errors) && json.errors.length > 0) {
                      console.error("[inventory-count] get_incomplete_group_products GraphQL errors (pattern1 errors-retry):", JSON.stringify(json.errors));
                    }
                  }
                }
                const item = json?.data?.inventoryItem;
                if (!item?.variant) return null;
                const productTitle = item.variant.product?.title ?? "";
                const variantTitle = item.variant.title ?? "";
                const fullTitle = variantTitle && variantTitle !== "Default Title" ? `${productTitle} / ${variantTitle}` : productTitle;
                const qty = item.inventoryLevel?.quantities?.find((x: { name?: string; quantity?: string }) => x.name === "available")?.quantity;
                const currentQuantity = qty !== null && qty !== undefined ? Number(qty) : 0;
                return {
                  variantId: item.variant.id,
                  inventoryItemId: item.id,
                  productTitle,
                  variantTitle,
                  sku: item.variant.sku ?? "",
                  barcode: item.variant.barcode,
                  title: fullTitle,
                  currentQuantity,
                  actualQuantity: 0,
                  delta: 0,
                };
              } catch (e) {
                const errMsg = (e as Error)?.message ?? String(e);
                const isThrottled = /throttle/i.test(errMsg);
                if (isThrottled) {
                  await delay(THROTTLE_RETRY_DELAY_MS);
                  try {
                    const resp2 = await admin.graphql(
                      `#graphql
                    query ItemAndLevel($id: ID!, $loc: ID!) {
                      inventoryItem(id: $id) {
                        id
                        variant {
                          id
                          title
                          sku
                          barcode
                          product { title }
                        }
                        inventoryLevel(locationId: $loc) {
                          quantities(names: ["available"]) { name quantity }
                        }
                      }
                    }
                  `,
                      { variables: { id: inventoryItemId, loc: locationId } }
                    );
                    const json2 = await resp2.json();
                    if (Array.isArray(json2?.errors) && json2.errors.length > 0) {
                      console.error("[inventory-count] get_incomplete_group_products GraphQL errors (pattern1 retry):", JSON.stringify(json2.errors));
                      return null;
                    }
                    const item2 = json2?.data?.inventoryItem;
                    if (!item2?.variant) return null;
                    const productTitle2 = item2.variant.product?.title ?? "";
                    const variantTitle2 = item2.variant.title ?? "";
                    const fullTitle2 = variantTitle2 && variantTitle2 !== "Default Title" ? `${productTitle2} / ${variantTitle2}` : productTitle2;
                    const qty2 = item2.inventoryLevel?.quantities?.find((x: { name?: string; quantity?: string }) => x.name === "available")?.quantity;
                    const currentQuantity2 = qty2 !== null && qty2 !== undefined ? Number(qty2) : 0;
                    return {
                      variantId: item2.variant.id,
                      inventoryItemId: item2.id,
                      productTitle: productTitle2,
                      variantTitle: variantTitle2,
                      sku: item2.variant.sku ?? "",
                      barcode: item2.variant.barcode,
                      title: fullTitle2,
                      currentQuantity: currentQuantity2,
                      actualQuantity: 0,
                      delta: 0,
                    };
                  } catch (e2) {
                    console.error("[inventory-count] get_incomplete_group_products item failed (pattern1 retry):", inventoryItemId, (e2 as Error)?.message ?? String(e2));
                    return null;
                  }
                }
                console.error("[inventory-count] get_incomplete_group_products item failed (pattern1):", inventoryItemId, errMsg);
                return null;
              }
            })
          );
          const valid = results.filter((r): r is NonNullable<typeof r> => r != null);
          allResults.push(...valid);
        }
        // 表示を skus（＝CSV登録順）に合わせて、ids の並びでソート
        const idToIndex = new Map(ids.map((id, idx) => [id, idx]));
        allResults.sort((a, b) => (idToIndex.get(a.inventoryItemId) ?? 999999) - (idToIndex.get(b.inventoryItemId) ?? 999999));
        const res = { ok: true as const, countId, groupId, products: allResults, hasMore, offset };
        incompleteGroupProductsCache.set(cacheKey, { data: res, expiresAt: Date.now() + INCOMPLETE_GROUP_PRODUCTS_CACHE_TTL_MS });
        return res;
      }

      // パターン1b: skus のみ（CSV等で inventoryItemIds が未保存のグループ）→ SKU から ID 解決してから商品・在庫取得
      if ((!productGroup.collectionIds?.length) && (!productGroup.inventoryItemIds?.length) && productGroup.skus?.length) {
        const resolvedIds = await resolveSkusToInventoryItemIds(admin, productGroup.skus);
        const ids = resolvedIds.slice(offset, offset + MAX_PRODUCTS_PER_GROUP);
        const hasMore1b = resolvedIds.length > offset + MAX_PRODUCTS_PER_GROUP;
        if (ids.length > 0) {
          const BATCH_SIZE = 5; // 同時並列数を減らして Throttled を防ぐ（根本対策）
          const allResults: Array<{
            variantId: string;
            inventoryItemId: string;
            productTitle: string;
            variantTitle: string;
            sku: string;
            barcode?: string;
            title: string;
            currentQuantity: number;
            actualQuantity: number;
            delta: number;
          }> = [];
          for (let i = 0; i < ids.length; i += BATCH_SIZE) {
            if (i > 0) await delay(DELAY_BETWEEN_BATCHES_MS);
            const batch = ids.slice(i, i + BATCH_SIZE);
            const results = await Promise.all(
              batch.map(async (inventoryItemId) => {
                try {
                  const resp = await admin.graphql(
                    `#graphql
                      query ItemAndLevel($id: ID!, $loc: ID!) {
                        inventoryItem(id: $id) {
                          id
                          variant {
                            id
                            title
                            sku
                            barcode
                            product { title }
                          }
                          inventoryLevel(locationId: $loc) {
                            quantities(names: ["available"]) { name quantity }
                          }
                        }
                      }
                    `,
                    { variables: { id: inventoryItemId, loc: locationId } }
                  );
                  let json = await resp.json();
                  if (Array.isArray(json?.errors) && json.errors.length > 0) {
                    console.error("[inventory-count] get_incomplete_group_products GraphQL errors (pattern1b):", JSON.stringify(json.errors));
                    const hasThrottledInErrors = json.errors.some((e: { message?: string }) => /throttle/i.test(String(e?.message ?? "")));
                    if (hasThrottledInErrors && !json?.data?.inventoryItem) {
                      await delay(THROTTLE_RETRY_DELAY_MS);
                      const respRetry = await admin.graphql(
                        `#graphql
                      query ItemAndLevel($id: ID!, $loc: ID!) {
                        inventoryItem(id: $id) {
                          id
                          variant {
                            id
                            title
                            sku
                            barcode
                            product { title }
                          }
                          inventoryLevel(locationId: $loc) {
                            quantities(names: ["available"]) { name quantity }
                          }
                        }
                      }
                    `,
                        { variables: { id: inventoryItemId, loc: locationId } }
                      );
                      json = await respRetry.json();
                      if (Array.isArray(json?.errors) && json.errors.length > 0) {
                        console.error("[inventory-count] get_incomplete_group_products GraphQL errors (pattern1b errors-retry):", JSON.stringify(json.errors));
                      }
                    }
                  }
                  const item = json?.data?.inventoryItem;
                  if (!item?.variant) return null;
                  const productTitle = item.variant.product?.title ?? "";
                  const variantTitle = item.variant.title ?? "";
                  const fullTitle = variantTitle && variantTitle !== "Default Title" ? `${productTitle} / ${variantTitle}` : productTitle;
                  const qty = item.inventoryLevel?.quantities?.find((x: { name?: string; quantity?: string }) => x.name === "available")?.quantity;
                  const currentQuantity = qty !== null && qty !== undefined ? Number(qty) : 0;
                  return {
                    variantId: item.variant.id,
                    inventoryItemId: item.id,
                    productTitle,
                    variantTitle,
                    sku: item.variant.sku ?? "",
                    barcode: item.variant.barcode,
                    title: fullTitle,
                    currentQuantity,
                    actualQuantity: 0,
                    delta: 0,
                  };
                } catch (e) {
                  const errMsg = (e as Error)?.message ?? String(e);
                  const isThrottled = /throttle/i.test(errMsg);
                  if (isThrottled) {
                    await delay(THROTTLE_RETRY_DELAY_MS);
                    try {
                      const resp2 = await admin.graphql(
                        `#graphql
                      query ItemAndLevel($id: ID!, $loc: ID!) {
                        inventoryItem(id: $id) {
                          id
                          variant {
                            id
                            title
                            sku
                            barcode
                            product { title }
                          }
                          inventoryLevel(locationId: $loc) {
                            quantities(names: ["available"]) { name quantity }
                          }
                        }
                      }
                    `,
                        { variables: { id: inventoryItemId, loc: locationId } }
                      );
                      const json2 = await resp2.json();
                      if (Array.isArray(json2?.errors) && json2.errors.length > 0) {
                        console.error("[inventory-count] get_incomplete_group_products GraphQL errors (pattern1b retry):", JSON.stringify(json2.errors));
                        return null;
                      }
                      const item2 = json2?.data?.inventoryItem;
                      if (!item2?.variant) return null;
                      const productTitle2 = item2.variant.product?.title ?? "";
                      const variantTitle2 = item2.variant.title ?? "";
                      const fullTitle2 = variantTitle2 && variantTitle2 !== "Default Title" ? `${productTitle2} / ${variantTitle2}` : productTitle2;
                      const qty2 = item2.inventoryLevel?.quantities?.find((x: { name?: string; quantity?: string }) => x.name === "available")?.quantity;
                      const currentQuantity2 = qty2 !== null && qty2 !== undefined ? Number(qty2) : 0;
                      return {
                        variantId: item2.variant.id,
                        inventoryItemId: item2.id,
                        productTitle: productTitle2,
                        variantTitle: variantTitle2,
                        sku: item2.variant.sku ?? "",
                        barcode: item2.variant.barcode,
                        title: fullTitle2,
                        currentQuantity: currentQuantity2,
                        actualQuantity: 0,
                        delta: 0,
                      };
                    } catch (e2) {
                      console.error("[inventory-count] get_incomplete_group_products item failed (pattern1b retry):", inventoryItemId, (e2 as Error)?.message ?? String(e2));
                      return null;
                    }
                  }
                  console.error("[inventory-count] get_incomplete_group_products item failed (pattern1b):", inventoryItemId, errMsg);
                  return null;
                }
              })
            );
            const valid = results.filter((r): r is NonNullable<typeof r> => r != null);
            allResults.push(...valid);
          }
          // 表示を skus（＝CSV登録順）に合わせて、ids（resolve 済み＝skus 順）でソート
          const idToIndex1b = new Map(ids.map((id, idx) => [id, idx]));
          allResults.sort((a, b) => (idToIndex1b.get(a.inventoryItemId) ?? 999999) - (idToIndex1b.get(b.inventoryItemId) ?? 999999));
          const res1b = { ok: true as const, countId, groupId, products: allResults, hasMore: hasMore1b, offset };
          incompleteGroupProductsCache.set(cacheKey, { data: res1b, expiresAt: Date.now() + INCOMPLETE_GROUP_PRODUCTS_CACHE_TTL_MS });
          return res1b;
        }
      }

      // パターン2: コレクションから商品を取得
      if (!productGroup.collectionIds?.length) {
        const emptyRes2 = { ok: true as const, countId, groupId, products: [] as unknown[], hasMore: false, offset: 0 };
        incompleteGroupProductsCache.set(cacheKey, { data: emptyRes2, expiresAt: Date.now() + INCOMPLETE_GROUP_PRODUCTS_CACHE_TTL_MS });
        return emptyRes2;
      }

      let collectionIndex = 0;
      for (const collectionId of productGroup.collectionIds) {
        if (collectionIndex > 0) await delay(DELAY_BETWEEN_BATCHES_MS);
        collectionIndex++;
        const config = productGroup.collectionConfigs?.find((c) => c.collectionId === collectionId);
        const selectedVariantIds = config?.selectedVariantIds || [];

        const productsResp = await admin.graphql(
          `#graphql
            query CollectionProducts($id: ID!, $first: Int!) {
              collection(id: $id) {
                id
                title
                products(first: $first) {
                  nodes {
                    id
                    title
                    variants(first: 250) {
                      nodes {
                        id
                        title
                        sku
                        barcode
                        inventoryItem {
                          id
                        }
                      }
                    }
                  }
                }
              }
            }
          `,
          { variables: { id: collectionId, first: 250 } }
        );

        const productsData = await productsResp.json();
        const collection = productsData?.data?.collection;
        if (collection) {
          for (const product of collection.products?.nodes || []) {
            for (const variant of product.variants?.nodes || []) {
              if (variant.inventoryItem?.id) {
                // 選択された商品のみを追加（selectedVariantIdsが空の場合は全選択）
                if (selectedVariantIds.length === 0 || selectedVariantIds.includes(variant.id)) {
                  const title = product.title || "";
                  const variantTitle = variant.title || "";
                  const fullTitle = variantTitle && variantTitle !== "Default Title" ? `${title} / ${variantTitle}` : title;
                  products.push({
                    variantId: variant.id,
                    inventoryItemId: variant.inventoryItem.id,
                    productTitle: title,
                    variantTitle: variantTitle,
                    sku: variant.sku || "",
                    barcode: variant.barcode || "",
                    title: fullTitle,
                  });
                }
              }
            }
          }
        }
      }

      // 重複除去
      const seen = new Set<string>();
      const uniqueProductsFull = products.filter((p) => {
        if (seen.has(p.inventoryItemId)) return false;
        seen.add(p.inventoryItemId);
        return true;
      });
      const uniqueProducts = uniqueProductsFull.slice(offset, offset + MAX_PRODUCTS_PER_GROUP);
      const hasMoreCollection = uniqueProductsFull.length > offset + MAX_PRODUCTS_PER_GROUP;

      // 各商品の在庫数を取得（並列化：バッチごとに同時リクエスト。バッチ間に待機で500防止）
      const BATCH_SIZE = 15;
      const productsWithQuantity: Array<{
        variantId: string;
        inventoryItemId: string;
        productTitle: string;
        variantTitle: string;
        sku: string;
        barcode?: string;
        title: string;
        currentQuantity: number;
        actualQuantity: number;
        delta: number;
      }> = [];
      for (let i = 0; i < uniqueProducts.length; i += BATCH_SIZE) {
        if (i > 0) await delay(DELAY_BETWEEN_BATCHES_MS);
        const batch = uniqueProducts.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(
          batch.map(async (product) => {
            try {
              const qtyResp = await admin.graphql(
                `#graphql
                  query CurrentQuantity($id: ID!, $loc: ID!) {
                    inventoryItem(id: $id) {
                      inventoryLevel(locationId: $loc) {
                        quantities(names: ["available"]) { name quantity }
                      }
                    }
                  }
                `,
                { variables: { id: product.inventoryItemId, loc: locationId } }
              );
              const qtyData = await qtyResp.json();
              if (Array.isArray(qtyData?.errors) && qtyData.errors.length > 0) {
                console.error("[inventory-count] get_incomplete_group_products GraphQL errors (pattern2 qty):", JSON.stringify(qtyData.errors));
              }
              const level = qtyData?.data?.inventoryItem?.inventoryLevel;
              const qty = level?.quantities?.find((x: { name?: string; quantity?: string }) => x.name === "available")?.quantity;
              const currentQuantity = qty !== null && qty !== undefined ? Number(qty) : 0;
              return {
                ...product,
                currentQuantity,
                actualQuantity: 0,
                delta: 0,
              };
            } catch {
              return {
                ...product,
                currentQuantity: 0,
                actualQuantity: 0,
                delta: 0,
              };
            }
          })
        );
        productsWithQuantity.push(...results);
      }

      const res2 = {
        ok: true as const,
        countId,
        groupId,
        products: productsWithQuantity,
        hasMore: hasMoreCollection,
        offset,
      };
      incompleteGroupProductsCache.set(cacheKey, { data: res2, expiresAt: Date.now() + INCOMPLETE_GROUP_PRODUCTS_CACHE_TTL_MS });
      return res2;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `商品取得エラー: ${errorMessage}` as const };
    }
  }

  // ✅ 履歴モーダル用：list 由来で groupItems がない棚卸のフルデータを1件取得（ステータス・完了/未完了表示の正確化）
  if (actionType === "get_count_full") {
    const countId = (formData.get("countId") as string)?.trim();
    if (!countId) return { ok: false, error: "countId は必須です" as const };
    const count = inventoryCounts.find((c) => String(c.id) === String(countId) || normalizeIdForMatch(c.id) === normalizeIdForMatch(countId));
    if (!count) return { ok: false, error: "棚卸が見つかりません" as const };
    const { inventoryItemIdsByGroup: _omit, ...rest } = count as InventoryCount & { inventoryItemIdsByGroup?: unknown };
    return { ok: true, count: rest };
  }

  // ---------- 履歴モーダル：数量編集・確定・リセット・キャンセル ----------
  if (actionType === "update_stocktake_quantity") {
    const countId = formData.get("countId") as string;
    const groupId = formData.get("groupId") as string | null;
    const itemsJson = formData.get("items") as string | null;
    const groupsJson = formData.get("groups") as string | null; // optional: { [groupId]: items[] } で複数グループ一括
    if (!countId) return { ok: false, error: "countId は必須です" as const };
    const count = inventoryCounts.find((c) => String(c.id) === String(countId) || normalizeIdForMatch(c.id) === normalizeIdForMatch(countId));
    if (!count) return { ok: false, error: "棚卸が見つかりません" as const };
    const groupItemsMap = (count as any).groupItems && typeof (count as any).groupItems === "object" ? { ...(count as any).groupItems } : {};
    const applyGroup = (gId: string, items: Array<{ inventoryItemId: string; actualQuantity: number; currentQuantity?: number; variantId?: string; sku?: string; title?: string }>) => {
      const existingGroup = getGroupItemsByKey(groupItemsMap as Record<string, unknown[]>, gId);
      const byItemId = new Map(items.map((i) => [String(i.inventoryItemId).trim(), i]));
      const merged =
        existingGroup.length > 0
          ? existingGroup.map((it: any) => {
              const id = String(it?.inventoryItemId ?? "").trim();
              const edited = byItemId.get(id);
              if (edited != null && Number.isFinite(Number(edited.actualQuantity))) {
                const actual = Number(edited.actualQuantity);
                const current = Number(it?.currentQuantity ?? 0);
                return { ...it, actualQuantity: actual, delta: actual - current };
              }
              return it;
            })
          : items.map((i) => {
              const current = Number(i.currentQuantity ?? 0);
              const actual = Number(i.actualQuantity ?? 0);
              return { ...i, currentQuantity: current, actualQuantity: actual, delta: actual - current };
            });
      const key = Object.keys(groupItemsMap).find((k) => normalizeIdForMatch(k) === normalizeIdForMatch(gId)) ?? gId;
      (groupItemsMap as Record<string, unknown[]>)[key] = merged;
    };
    if (groupsJson) {
      try {
        const groups = JSON.parse(groupsJson) as Record<string, Array<{ inventoryItemId: string; actualQuantity: number; currentQuantity?: number; variantId?: string; sku?: string; title?: string }>>;
        for (const [gId, items] of Object.entries(groups)) {
          if (Array.isArray(items) && items.length > 0) applyGroup(gId, items);
        }
      } catch {
        return { ok: false, error: "groups の形式が不正です" as const };
      }
    } else if (groupId && itemsJson) {
      let items: Array<{ inventoryItemId: string; actualQuantity: number; currentQuantity?: number; variantId?: string; sku?: string; title?: string }>;
      try {
        items = JSON.parse(itemsJson);
      } catch {
        return { ok: false, error: "items の形式が不正です" as const };
      }
      applyGroup(groupId, items);
    } else {
      return { ok: false, error: "groupId と items、または groups は必須です" as const };
    }
    const updatedCounts = inventoryCounts.map((c) =>
      String(c.id) === String(countId) || normalizeIdForMatch(c.id) === normalizeIdForMatch(countId)
        ? { ...c, groupItems: groupItemsMap }
        : c
    );
    const { userErrors } = await writeInventoryCountsChunked(admin, updatedCounts as InventoryCount[], ownerId, expectedVersionNum);
    if (userErrors.length) return { ok: false, error: userErrors.map((e) => e.message).join(" / ") as const };
    invalidateIncompleteGroupProductsCacheForCount(session?.shop ?? "", countId);
    return { ok: true };
  }

  if (actionType === "confirm_stocktake_group") {
    const countId = formData.get("countId") as string;
    const groupId = formData.get("groupId") as string;
    const itemsJson = formData.get("items") as string;
    if (!countId || !groupId || !itemsJson) {
      return { ok: false, error: "countId, groupId, items は必須です" as const };
    }
    let items: Array<{ inventoryItemId: string; currentQuantity: number; actualQuantity: number; variantId?: string; sku?: string; title?: string }>;
    try {
      items = JSON.parse(itemsJson);
    } catch {
      return { ok: false, error: "items の形式が不正です" as const };
    }
    const count = inventoryCounts.find((c) => String(c.id) === String(countId) || normalizeIdForMatch(c.id) === normalizeIdForMatch(countId));
    if (!count) return { ok: false, error: "棚卸が見つかりません" as const };
    const toAdjust = items.filter((i) => Number(i.actualQuantity) !== Number(i.currentQuantity));
    const shop = session?.shop ?? "";
    const shopTimezone = await getShopTimezone(admin);
    const dateUtc = getDateInShopTimezone(new Date(), shopTimezone);
    if (toAdjust.length > 0) {
      const adjustResult = await adjustInventoryQuantitiesServer(
        admin,
        count.locationId,
        toAdjust.map((i) => ({ inventoryItemId: i.inventoryItemId, quantity: Number(i.actualQuantity) })),
        countId
      );
      if (!adjustResult.ok) return { ok: false, error: (adjustResult.error ?? "在庫調整に失敗しました") as const };
      await logInventoryChangeServer(
        db,
        shop,
        dateUtc,
        toAdjust.map((i) => ({
          inventoryItemId: i.inventoryItemId,
          variantId: i.variantId ?? null,
          sku: i.sku ?? "",
          locationId: count.locationId,
          locationName: count.locationName ?? count.locationId,
          delta: Number(i.actualQuantity) - Number(i.currentQuantity),
          quantityAfter: Number(i.actualQuantity),
          sourceId: countId,
          timestamp: new Date(),
        })),
        "inventory_count"
      );
    }
    const groupItemsMap = (count as any).groupItems && typeof (count as any).groupItems === "object" ? { ...(count as any).groupItems } : {};
    const entry = items.map((i) => ({
      inventoryItemId: i.inventoryItemId,
      variantId: i.variantId,
      sku: i.sku ?? "",
      title: i.title ?? "",
      currentQuantity: Number(i.currentQuantity),
      actualQuantity: Number(i.actualQuantity),
      delta: Number(i.actualQuantity) - Number(i.currentQuantity),
    }));
    const key = Object.keys(groupItemsMap).find((k) => normalizeIdForMatch(k) === normalizeIdForMatch(groupId)) ?? groupId;
    (groupItemsMap as Record<string, unknown[]>)[key] = entry;
    const allIds = Array.isArray(count.productGroupIds) && count.productGroupIds.length > 0 ? count.productGroupIds : count.productGroupId ? [count.productGroupId] : [];
    const allDone = allIds.length > 0 && allIds.every((id) => {
      const items = getGroupItemsByKey(groupItemsMap as Record<string, unknown[]>, id);
      return items.length > 0 && (items as Array<{ actualQuantity?: number | null }>).some(
        (item) => item.actualQuantity != null
      );
    });
    const updatedCounts = inventoryCounts.map((c) =>
      String(c.id) === String(countId) || normalizeIdForMatch(c.id) === normalizeIdForMatch(countId)
        ? { ...c, groupItems: groupItemsMap, status: allDone ? "completed" : "in_progress", completedAt: allDone ? new Date().toISOString() : undefined }
        : c
    );
    const { userErrors } = await writeInventoryCountsChunked(admin, updatedCounts as InventoryCount[], ownerId, expectedVersionNum);
    if (userErrors.length) return { ok: false, error: userErrors.map((e) => e.message).join(" / ") as const };
    return { ok: true };
  }

  if (actionType === "reset_stocktake_group") {
    const countId = formData.get("countId") as string;
    const groupId = formData.get("groupId") as string;
    if (!countId || !groupId) return { ok: false, error: "countId, groupId は必須です" as const };
    const count = inventoryCounts.find((c) => String(c.id) === String(countId) || normalizeIdForMatch(c.id) === normalizeIdForMatch(countId));
    if (!count) return { ok: false, error: "棚卸が見つかりません" as const };
    const groupItemsMap = (count as any).groupItems && typeof (count as any).groupItems === "object" ? { ...(count as any).groupItems } : {};
    const groupItems = getGroupItemsByKey(groupItemsMap as Record<string, unknown[]>, groupId);
    if (groupItems.length === 0) return { ok: false, error: "このグループは確定されていません" as const };
    const toRevert = groupItems
      .map((it: any) => ({ ...it, currentQuantity: Number(it?.currentQuantity ?? 0), actualQuantity: Number(it?.actualQuantity ?? 0) }))
      .filter((it: any) => it.currentQuantity !== it.actualQuantity);
    const shop = session?.shop ?? "";
    const shopTimezone = await getShopTimezone(admin);
    const dateUtc = getDateInShopTimezone(new Date(), shopTimezone);
    if (toRevert.length > 0) {
      const revertResult = await adjustInventoryQuantitiesServer(
        admin,
        count.locationId,
        toRevert.map((it: any) => ({ inventoryItemId: it.inventoryItemId, quantity: it.currentQuantity })),
        null
      );
      if (!revertResult.ok) return { ok: false, error: (revertResult.error ?? "在庫の取り消しに失敗しました") as const };
      await logInventoryChangeServer(
        db,
        shop,
        dateUtc,
        toRevert.map((it: any) => ({
          inventoryItemId: it.inventoryItemId,
          variantId: it.variantId ?? null,
          sku: it.sku ?? "",
          locationId: count.locationId,
          locationName: count.locationName ?? count.locationId,
          delta: it.currentQuantity - it.actualQuantity,
          quantityAfter: it.currentQuantity,
          sourceId: countId,
          timestamp: new Date(),
        })),
        "inventory_count"
      );
    }
    const keyToDelete = Object.keys(groupItemsMap).find((k) => normalizeIdForMatch(k) === normalizeIdForMatch(groupId));
    if (keyToDelete) delete (groupItemsMap as Record<string, unknown>)[keyToDelete];
    const allIds = Array.isArray(count.productGroupIds) && count.productGroupIds.length > 0 ? count.productGroupIds : count.productGroupId ? [count.productGroupId] : [];
    const allDone = allIds.every((id) => getGroupItemsByKey(groupItemsMap as Record<string, unknown[]>, id).length > 0);
    const updatedCounts = inventoryCounts.map((c) =>
      String(c.id) === String(countId) || normalizeIdForMatch(c.id) === normalizeIdForMatch(countId)
        ? { ...c, groupItems: groupItemsMap, status: allDone ? "completed" : "in_progress", completedAt: allDone ? new Date().toISOString() : undefined }
        : c
    );
    const { userErrors } = await writeInventoryCountsChunked(admin, updatedCounts as InventoryCount[], ownerId, expectedVersionNum);
    if (userErrors.length) return { ok: false, error: userErrors.map((e) => e.message).join(" / ") as const };
    invalidateIncompleteGroupProductsCacheForCount(session?.shop ?? "", countId);
    return { ok: true };
  }

  if (actionType === "confirm_stocktake_all") {
    const countId = formData.get("countId") as string;
    const incompleteGroupsJson = formData.get("incompleteGroupsItems") as string | null; // optional: { [groupId]: items[] }
    if (!countId) return { ok: false, error: "countId は必須です" as const };
    const count = inventoryCounts.find((c) => String(c.id) === String(countId) || normalizeIdForMatch(c.id) === normalizeIdForMatch(countId));
    if (!count) return { ok: false, error: "棚卸が見つかりません" as const };
    const groupItemsMap = (count as any).groupItems && typeof (count as any).groupItems === "object" ? { ...(count as any).groupItems } : {};
    const allIds = Array.isArray(count.productGroupIds) && count.productGroupIds.length > 0 ? count.productGroupIds : count.productGroupId ? [count.productGroupId] : [];
    let incompletePayload: Record<string, Array<{ inventoryItemId: string; currentQuantity: number; actualQuantity: number; variantId?: string; sku?: string; title?: string }>> = {};
    if (incompleteGroupsJson) {
      try {
        incompletePayload = JSON.parse(incompleteGroupsJson);
      } catch {}
    }
    const shop = session?.shop ?? "";
    const shopTimezone = await getShopTimezone(admin);
    const dateUtc = getDateInShopTimezone(new Date(), shopTimezone);
    const allEntries: Array<{ inventoryItemId: string; currentQuantity: number; actualQuantity: number; variantId?: string; sku?: string; title?: string; groupId: string }> = [];
    for (const groupId of allIds) {
      const existing = getGroupItemsByKey(groupItemsMap as Record<string, unknown[]>, groupId);
      const items = existing.length > 0 ? existing : (incompletePayload[groupId] ?? []);
      for (const it of items) {
        const cur = Number((it as any)?.currentQuantity ?? 0);
        const act = Number((it as any)?.actualQuantity ?? 0);
        if (cur !== act) allEntries.push({ ...(it as any), currentQuantity: cur, actualQuantity: act, groupId });
      }
    }
    if (allEntries.length > 0) {
      const adjustResult = await adjustInventoryQuantitiesServer(
        admin,
        count.locationId,
        allEntries.map((e) => ({ inventoryItemId: e.inventoryItemId, quantity: e.actualQuantity })),
        countId
      );
      if (!adjustResult.ok) return { ok: false, error: (adjustResult.error ?? "在庫調整に失敗しました") as const };
      await logInventoryChangeServer(
        db,
        shop,
        dateUtc,
        allEntries.map((e) => ({
          inventoryItemId: e.inventoryItemId,
          variantId: e.variantId ?? null,
          sku: e.sku ?? "",
          locationId: count.locationId,
          locationName: count.locationName ?? count.locationId,
          delta: e.actualQuantity - e.currentQuantity,
          quantityAfter: e.actualQuantity,
          sourceId: countId,
          timestamp: new Date(),
        })),
        "inventory_count"
      );
    }
    for (const groupId of allIds) {
      const existing = getGroupItemsByKey(groupItemsMap as Record<string, unknown[]>, groupId);
      const items = existing.length > 0 ? existing : (incompletePayload[groupId] ?? []);
      if (items.length > 0) {
        const entry = items.map((it: any) => ({
          inventoryItemId: it.inventoryItemId,
          variantId: it.variantId,
          sku: it.sku ?? "",
          title: it.title ?? "",
          currentQuantity: Number(it?.currentQuantity ?? 0),
          actualQuantity: Number(it?.actualQuantity ?? 0),
          delta: Number(it?.actualQuantity ?? 0) - Number(it?.currentQuantity ?? 0),
        }));
        const key = Object.keys(groupItemsMap).find((k) => normalizeIdForMatch(k) === normalizeIdForMatch(groupId)) ?? groupId;
        (groupItemsMap as Record<string, unknown[]>)[key] = entry;
      }
    }
    const allDone = allIds.every((id) => getGroupItemsByKey(groupItemsMap as Record<string, unknown[]>, id).length > 0);
    const updatedCounts = inventoryCounts.map((c) =>
      String(c.id) === String(countId) || normalizeIdForMatch(c.id) === normalizeIdForMatch(countId)
        ? { ...c, groupItems: groupItemsMap, status: allDone ? "completed" : "in_progress", completedAt: allDone ? new Date().toISOString() : undefined }
        : c
    );
    const { userErrors } = await writeInventoryCountsChunked(admin, updatedCounts as InventoryCount[], ownerId, expectedVersionNum);
    if (userErrors.length) return { ok: false, error: userErrors.map((e) => e.message).join(" / ") as const };
    invalidateIncompleteGroupProductsCacheForCount(session?.shop ?? "", countId);
    return { ok: true };
  }

  if (actionType === "reset_stocktake_all") {
    const countId = formData.get("countId") as string;
    if (!countId) return { ok: false, error: "countId は必須です" as const };
    const count = inventoryCounts.find((c) => String(c.id) === String(countId) || normalizeIdForMatch(c.id) === normalizeIdForMatch(countId));
    if (!count) return { ok: false, error: "棚卸が見つかりません" as const };
    const groupItemsMap = (count as any).groupItems && typeof (count as any).groupItems === "object" ? { ...(count as any).groupItems } : {};
    const allIds = Array.isArray(count.productGroupIds) && count.productGroupIds.length > 0 ? count.productGroupIds : count.productGroupId ? [count.productGroupId] : [];
    const shop = session?.shop ?? "";
    const shopTimezone = await getShopTimezone(admin);
    const dateUtc = getDateInShopTimezone(new Date(), shopTimezone);
    for (const groupId of allIds) {
      const groupItems = getGroupItemsByKey(groupItemsMap as Record<string, unknown[]>, groupId);
      const toRevert = groupItems
        .map((it: any) => ({ ...it, currentQuantity: Number(it?.currentQuantity ?? 0), actualQuantity: Number(it?.actualQuantity ?? 0) }))
        .filter((it: any) => it.currentQuantity !== it.actualQuantity);
      if (toRevert.length > 0) {
        await adjustInventoryQuantitiesServer(admin, count.locationId, toRevert.map((it: any) => ({ inventoryItemId: it.inventoryItemId, quantity: it.currentQuantity })), null);
        await logInventoryChangeServer(
          db,
          shop,
          dateUtc,
          toRevert.map((it: any) => ({
            inventoryItemId: it.inventoryItemId,
            variantId: it.variantId ?? null,
            sku: it.sku ?? "",
            locationId: count.locationId,
            locationName: count.locationName ?? count.locationId,
            delta: it.currentQuantity - it.actualQuantity,
            quantityAfter: it.currentQuantity,
            sourceId: countId,
            timestamp: new Date(),
          })),
          "inventory_count"
        );
      }
    }
    const updatedCounts = inventoryCounts.map((c) =>
      String(c.id) === String(countId) || normalizeIdForMatch(c.id) === normalizeIdForMatch(countId)
        ? { ...c, groupItems: {}, status: "in_progress" as const, completedAt: undefined }
        : c
    );
    const { userErrors } = await writeInventoryCountsChunked(admin, updatedCounts as InventoryCount[], ownerId, expectedVersionNum);
    if (userErrors.length) return { ok: false, error: userErrors.map((e) => e.message).join(" / ") as const };
    invalidateIncompleteGroupProductsCacheForCount(session?.shop ?? "", countId);
    return { ok: true };
  }

  if (actionType === "cancel_stocktake_group") {
    const countId = formData.get("countId") as string;
    const groupId = formData.get("groupId") as string;
    if (!countId || !groupId) return { ok: false, error: "countId, groupId は必須です" as const };
    const count = inventoryCounts.find((c) => String(c.id) === String(countId) || normalizeIdForMatch(c.id) === normalizeIdForMatch(countId));
    if (!count) return { ok: false, error: "棚卸が見つかりません" as const };
    const cancelledGroupIds: string[] = Array.isArray((count as any).cancelledGroupIds) ? [...(count as any).cancelledGroupIds] : [];
    if (!cancelledGroupIds.includes(groupId)) {
      const n = normalizeIdForMatch(groupId);
      if (!cancelledGroupIds.some((id) => normalizeIdForMatch(id) === n)) cancelledGroupIds.push(groupId);
    }
    const groupItemsMap = (count as any).groupItems && typeof (count as any).groupItems === "object" ? (count as any).groupItems : {};
    const allIds = Array.isArray(count.productGroupIds) && count.productGroupIds.length > 0 ? count.productGroupIds : count.productGroupId ? [count.productGroupId] : [];
    const cancelledSet = new Set(cancelledGroupIds.map((id) => normalizeIdForMatch(id)));
    const allDone = allIds.length > 0 && allIds.every((id) => getGroupItemsByKey(groupItemsMap as Record<string, unknown[]>, id).length > 0 || cancelledSet.has(normalizeIdForMatch(id)));
    const allCancelled = allIds.length > 0 && allIds.every((id) => cancelledSet.has(normalizeIdForMatch(id)));
    const nextStatus = allDone ? (allCancelled ? "cancelled" as const : "completed" as const) : (count as any).status;
    const nextCompletedAt = allDone && nextStatus === "completed" ? (count.completedAt || new Date().toISOString()) : (nextStatus === "cancelled" ? undefined : (count as any).completedAt);
    const updatedCounts = inventoryCounts.map((c) =>
      String(c.id) === String(countId) || normalizeIdForMatch(c.id) === normalizeIdForMatch(countId)
        ? { ...c, cancelledGroupIds, status: nextStatus, completedAt: nextCompletedAt }
        : c
    );
    const { userErrors } = await writeInventoryCountsChunked(admin, updatedCounts as InventoryCount[], ownerId, expectedVersionNum);
    if (userErrors.length) return { ok: false, error: userErrors.map((e) => e.message).join(" / ") as const };
    invalidateIncompleteGroupProductsCacheForCount(session?.shop ?? "", countId);
    return { ok: true };
  }

  if (actionType === "cancel_stocktake") {
    const countId = formData.get("countId") as string;
    if (!countId) return { ok: false, error: "countId は必須です" as const };
    const count = inventoryCounts.find((c) => String(c.id) === String(countId) || normalizeIdForMatch(c.id) === normalizeIdForMatch(countId));
    if (!count) return { ok: false, error: "棚卸が見つかりません" as const };
    const groupItemsMap = (count as any).groupItems && typeof (count as any).groupItems === "object" ? (count as any).groupItems : {};
    const allIds = Array.isArray(count.productGroupIds) && count.productGroupIds.length > 0 ? count.productGroupIds : count.productGroupId ? [count.productGroupId] : [];
    const completedIds = allIds.filter((id) => getGroupItemsByKey(groupItemsMap as Record<string, unknown[]>, id).length > 0);
    const cancelledGroupIds: string[] = Array.isArray((count as any).cancelledGroupIds) ? [...(count as any).cancelledGroupIds] : [];
    if (completedIds.length === 0) {
      const updatedCounts = inventoryCounts.map((c) =>
        String(c.id) === String(countId) || normalizeIdForMatch(c.id) === normalizeIdForMatch(countId)
          ? { ...c, status: "cancelled" as const, completedAt: undefined }
          : c
      );
      const { userErrors } = await writeInventoryCountsChunked(admin, updatedCounts as InventoryCount[], ownerId, expectedVersionNum);
      if (userErrors.length) return { ok: false, error: userErrors.map((e) => e.message).join(" / ") as const };
      invalidateIncompleteGroupProductsCacheForCount(session?.shop ?? "", countId);
      return { ok: true };
    }
    const incompleteIds = allIds.filter((id) => getGroupItemsByKey(groupItemsMap as Record<string, unknown[]>, id).length === 0);
    for (const id of incompleteIds) {
      const n = normalizeIdForMatch(id);
      if (!cancelledGroupIds.some((cid) => normalizeIdForMatch(cid) === n)) cancelledGroupIds.push(id);
    }
    const cancelledSet = new Set(cancelledGroupIds.map((id) => normalizeIdForMatch(id)));
    const allDone = allIds.length > 0 && allIds.every((id) => getGroupItemsByKey(groupItemsMap as Record<string, unknown[]>, id).length > 0 || cancelledSet.has(normalizeIdForMatch(id)));
    const allCancelled = allIds.length > 0 && allIds.every((id) => cancelledSet.has(normalizeIdForMatch(id)));
    const nextStatus = allDone ? (allCancelled ? "cancelled" as const : "completed" as const) : "in_progress";
    const nextCompletedAt = allDone && nextStatus === "completed" ? (count.completedAt || new Date().toISOString()) : undefined;
    const updatedCounts = inventoryCounts.map((c) =>
      String(c.id) === String(countId) || normalizeIdForMatch(c.id) === normalizeIdForMatch(countId)
        ? { ...c, cancelledGroupIds, status: nextStatus, completedAt: nextCompletedAt }
        : c
    );
    const { userErrors } = await writeInventoryCountsChunked(admin, updatedCounts as InventoryCount[], ownerId, expectedVersionNum);
    if (userErrors.length) return { ok: false, error: userErrors.map((e) => e.message).join(" / ") as const };
    invalidateIncompleteGroupProductsCacheForCount(session?.shop ?? "", countId);
    return { ok: true };
  }

  return { ok: false, error: "不明なアクション" as const };
  } catch (e) {
    const err = e as { message?: string; errors?: { graphQLErrors?: unknown[] }; body?: { errors?: { graphQLErrors?: unknown[] } } };
    if (Array.isArray(err?.errors?.graphQLErrors) && err.errors.graphQLErrors.length > 0) {
      console.error("[inventory-count] action error graphQLErrors:", JSON.stringify(err.errors.graphQLErrors));
    } else if (Array.isArray(err?.body?.errors?.graphQLErrors) && err.body.errors.graphQLErrors.length > 0) {
      console.error("[inventory-count] action error graphQLErrors (body):", JSON.stringify(err.body.errors.graphQLErrors));
    }
    console.error("[inventory-count] action error:", err?.message ?? e);
    // 棚卸チャンク欠落・パース失敗など既知のメッセージはそのまま返し、原因を把握しやすくする
    const msg = String(err?.message ?? e ?? "").trim();
    const isKnownError =
      msg.includes("棚卸チャンク") ||
      msg.includes("棚卸一覧チャンク") ||
      msg.includes("パースに失敗") ||
      msg.includes("配列ではありません");
    const errorText = isKnownError
      ? `${msg} 棚卸IDを修復するか、しばらくしてから再試行してください。`
      : "処理中にエラーが発生しました。しばらくしてからお試しください。";
    return { ok: false, error: errorText as const };
  }
}

function escapeCsv(s: string) {
  return `"${String(s).replace(/"/g, '""')}"`;
}

export type SkuSearchVariant = {
  variantId: string;
  inventoryItemId: string;
  sku: string;
  barcode?: string;
  variantTitle: string;
  productTitle: string;
  title: string;
  option1?: string;
  option2?: string;
  option3?: string;
};

export default function InventoryCountPage() {
  const loaderData = useLoaderData<typeof loader>();
  const { locations, collections, collectionDisplayMap = {}, productGroups, inventoryCounts, inventoryCountsVersion = 1, skuVariantList, shopTimezone, todayInShopTimezone, stocktakeCsvExportColumns, loadError = false, loadErrorMessage } = loaderData || {
    locations: [],
    collections: [],
    collectionDisplayMap: {} as Record<string, CollectionNode>,
    productGroups: [],
    inventoryCounts: [],
    skuVariantList: [],
    shopTimezone: "UTC",
    stocktakeCsvExportColumns: DEFAULT_STOCKTAKE_CSV_COLUMNS,
    loadError: false,
  };
  const csvColumns = stocktakeCsvExportColumns ?? DEFAULT_STOCKTAKE_CSV_COLUMNS;
  const csvColumnsSummary = csvColumns.filter((id) => STOCKTAKE_SUMMARY_IDS.includes(id));
  const fetcher = useFetcher<typeof action>();
  // 棚卸: 検索結果のみ表示（loader の全件取得は廃止）。検索結果・選択済みは state で保持。
  const [collectionSearchResults, setCollectionSearchResults] = useState<CollectionNode[]>([]);
  const [selectedCollectionInfo, setSelectedCollectionInfo] = useState<Map<string, CollectionNode>>(new Map());
  const collectionSearchFetcher = useFetcher<typeof action>();
  const collectionResolveFetcher = useFetcher<typeof action>();
  const [skuSearchResults, setSkuSearchResults] = useState<SkuSearchVariant[]>([]);
  const [skuSearchQuery, setSkuSearchQuery] = useState("");
  const [showOnlySelectedSku, setShowOnlySelectedSku] = useState(false);
  const [selectedSkuVariants, setSelectedSkuVariants] = useState<SkuSearchVariant[]>([]);
  const skuSearchFetcher = useFetcher<typeof action>();
  const skuResolveFetcher = useFetcher<typeof action>();

  // 検索結果の反映（コレクション）
  useEffect(() => {
    const d = collectionSearchFetcher.data;
    if (d && (d as { ok?: boolean }).ok && Array.isArray((d as { collections?: CollectionNode[] }).collections)) {
      setCollectionSearchResults((d as { collections: CollectionNode[] }).collections);
    }
  }, [collectionSearchFetcher.data]);

  // 検索結果の反映（SKU）
  useEffect(() => {
    const d = skuSearchFetcher.data;
    if (d && (d as { ok?: boolean }).ok && Array.isArray((d as { variants?: SkuSearchVariant[] }).variants)) {
      setSkuSearchResults((d as { variants: SkuSearchVariant[] }).variants);
    }
  }, [skuSearchFetcher.data]);

  const [activeTab, setActiveTab] = useState<"groups" | "create" | "history">("groups");
  const [groupCreateMethod, setGroupCreateMethod] = useState<"collection" | "sku" | "csv">("sku");
  // SKU/CSV由来のグループ編集時、loader一覧にないinventoryItemIdを保存しておき、更新時に欠落しないようにする
  const [editingSkuOnlyPreservedIds, setEditingSkuOnlyPreservedIds] = useState<string[]>([]);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [groupName, setGroupName] = useState("");
  const [selectedCollectionIds, setSelectedCollectionIds] = useState<string[]>([]);
  const [collectionConfigs, setCollectionConfigs] = useState<Map<string, CollectionConfig>>(new Map()); // コレクションごとの選択商品設定
  const [showOnlySelectedCollection, setShowOnlySelectedCollection] = useState(false);

  // 表示用: コレクションは検索結果 or 選択済みのみ。選択済みは selectedCollectionInfo から表示
  const displayCollections = useMemo(() => {
    if (showOnlySelectedCollection) {
      return selectedCollectionIds.map((id) => selectedCollectionInfo.get(id)).filter(Boolean) as CollectionNode[];
    }
    return collectionSearchResults;
  }, [showOnlySelectedCollection, selectedCollectionIds, selectedCollectionInfo, collectionSearchResults]);

  const displaySkuVariants = useMemo(() => {
    if (showOnlySelectedSku) {
      return selectedSkuVariants; // 選択済みは state のリストをそのまま表示
    }
    return skuSearchResults;
  }, [showOnlySelectedSku, selectedSkuVariants, skuSearchResults]);

  // コレクション検索・モーダル関連
  const [collectionSearchQuery, setCollectionSearchQuery] = useState("");
  const [collectionModalOpen, setCollectionModalOpen] = useState(false);
  const [collectionModalCollectionId, setCollectionModalCollectionId] = useState<string | null>(null);
  const [collectionModalProducts, setCollectionModalProducts] = useState<CollectionProduct[]>([]);
  const [collectionModalSelectedVariantIds, setCollectionModalSelectedVariantIds] = useState<Set<string>>(new Set());
  const [collectionModalLoading, setCollectionModalLoading] = useState(false);
  const [collectionModalProductGroupId, setCollectionModalProductGroupId] = useState<string | null>(null); // 右側から開いた場合の商品グループID
  const [collectionModalSearchQuery, setCollectionModalSearchQuery] = useState("");
  const [showOnlySelectedInModal, setShowOnlySelectedInModal] = useState(false);
  const [collectionModalPage, setCollectionModalPage] = useState(1);
  const collectionProductsFetcher = useFetcher<typeof action>();
  const MODAL_ITEMS_PER_PAGE = 1000;
  /** モーダルを開いて商品リストを初めて受け取った1回だけ「全選択」初期化するためのフラグ（全解除ボタン押下で effect が再実行されないようにする） */
  const collectionModalInitialSelectionDoneRef = useRef(false);

  const filteredModalProducts = useMemo(() => {
    const list = collectionModalProducts;
    if (!collectionModalSearchQuery.trim()) return list;
    const q = collectionModalSearchQuery.trim().toLowerCase();
    return list.filter(
      (p) =>
        (p.sku || "").toLowerCase().includes(q) ||
        (p.barcode || "").toLowerCase().includes(q) ||
        (p.productTitle || "").toLowerCase().includes(q) ||
        (p.variantTitle || "").toLowerCase().includes(q)
    );
  }, [collectionModalProducts, collectionModalSearchQuery]);
  const displayModalProducts = useMemo(() => {
    if (!showOnlySelectedInModal) return filteredModalProducts;
    const selectedSet = collectionModalSelectedVariantIds;
    return filteredModalProducts.filter((p) => selectedSet.has(p.variantId));
  }, [showOnlySelectedInModal, filteredModalProducts, collectionModalSelectedVariantIds]);
  const paginatedModalProducts = useMemo(() => {
    const start = (collectionModalPage - 1) * MODAL_ITEMS_PER_PAGE;
    return displayModalProducts.slice(start, start + MODAL_ITEMS_PER_PAGE);
  }, [displayModalProducts, collectionModalPage]);
  const modalTotalPages = Math.max(1, Math.ceil(displayModalProducts.length / MODAL_ITEMS_PER_PAGE));
  useEffect(() => {
    setCollectionModalPage(1);
  }, [collectionModalSearchQuery, showOnlySelectedInModal]);

  const [createLocationId, setCreateLocationId] = useState("");
  const [createLocationSearchQuery, setCreateLocationSearchQuery] = useState("");
  const [createProductGroupId, setCreateProductGroupId] = useState("");
  const [createProductGroupIds, setCreateProductGroupIds] = useState<string[]>([]);

  // イベントから値を読み取るヘルパー関数
  const readValue = (e: any) => String(e?.currentTarget?.value ?? e?.currentValue?.value ?? e ?? "");

  const [locationFilters, setLocationFilters] = useState<Set<string>>(new Set());
  const [statusFilters, setStatusFilters] = useState<Set<string>>(new Set());
  const [countNameSortOrder, setCountNameSortOrder] = useState<"asc" | "desc">("desc");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [modalOpen, setModalOpen] = useState(false);
  const [modalCount, setModalCount] = useState<InventoryCount | null>(null);
  const [modalEditMode, setModalEditMode] = useState(false);
  // 棚卸「復元して完了確定」フォーム（メタ欠損時のみ表示）
  const [restoreCountName, setRestoreCountName] = useState("");
  const [restoreLocationId, setRestoreLocationId] = useState("");
  const [restoreProductGroupIds, setRestoreProductGroupIds] = useState<string[]>([]);
  const [modalEditedQuantities, setModalEditedQuantities] = useState<Record<string, Record<string, number>>>({});
  const historyActionFetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  // 棚卸ID修復成功時に一覧を再取得
  useEffect(() => {
    const d = fetcher.data;
    if (d && (d as { ok?: boolean }).ok && typeof (d as { repaired?: number }).repaired === "number") {
      revalidator.revalidate();
    }
    // ✅ 復元・振り分け・グループ完了は書き込み直後に revalidate すると loader のチャンク読込が Throttled 等で失敗し「再読込してください」になりがちなため、モーダルだけ閉じる（一覧はユーザーがページ再読み込みで更新）
    if (d && (d as { ok?: boolean }).ok && (d as { restored?: boolean }).restored === true) {
      setModalOpen(false);
      setModalCount(null);
      setRestoreCountName("");
      setRestoreLocationId("");
      setRestoreProductGroupIds([]);
    }
    if (d && (d as { ok?: boolean }).ok && (d as { redistributed?: boolean }).redistributed === true) {
      setModalOpen(false);
      setModalCount(null);
    }
    if (d && (d as { ok?: boolean }).ok && (d as { groupsCompleted?: boolean }).groupsCompleted === true) {
      setModalOpen(false);
      setModalCount(null);
    }
  }, [fetcher.data, revalidator]);
  // ✅ list 由来で groupItems がない棚卸のフルデータ取得（モーダルでステータス・完了/未完了を正しく表示するため）
  const countFullFetcher = useFetcher<typeof action>();
  // ✅ 履歴一覧：各行の「N件 N/N」をバックグラウンドで取得（先に描画し数値は後から流し込む）
  const listRowDetailFetcher = useFetcher<typeof action>();
  const [listCountDetails, setListCountDetails] = useState<Record<string, InventoryCount>>({});
  const [loadingListDetailIds, setLoadingListDetailIds] = useState<Set<string>>(new Set());
  const listDetailQueueRef = useRef<string[]>([]);
  // ✅ 未完了グループの商品リストを取得するためのfetcherとstate（モーダル用）
  const incompleteGroupProductsFetcher = useFetcher<typeof action>();
  const incompleteGroupProductsFetcher2 = useFetcher<typeof action>();
  const incompleteGroupProductsFetcher3 = useFetcher<typeof action>();
  const [incompleteGroupProducts, setIncompleteGroupProducts] = useState<Map<string, Array<any>>>(new Map());
  const [incompleteGroupHasMore, setIncompleteGroupHasMore] = useState<Map<string, boolean>>(new Map());
  const [loadingMoreIncompleteGroupId, setLoadingMoreIncompleteGroupId] = useState<string | null>(null);
  // ✅ 取得中の未完了グループID（キー型の差で先頭グループが「まだ処理されていません」になるのを防ぐ＋ローディング表示用）
  const [loadingIncompleteGroupIds, setLoadingIncompleteGroupIds] = useState<Set<string>>(new Set());
  const incompleteGroupFetchIndexRef = useRef<number>(0);
  const incompleteGroupIdsRef = useRef<string[]>([]);
  // ✅ 並列取得用キュー（先頭3件を3fetcherに振り、残りは完了したfetcherに順次渡す）
  const incompleteGroupQueueRef = useRef<string[]>([]);
  // ✅ 各並列fetcherで「最後に処理したgroupId」（二重マージ防止・次リクエスト割り当て用）。モーダル閉じでリセット
  const lastProcessedIncompleteByFetcherRef = useRef<{ f1: string | null; f2: string | null; f3: string | null }>({ f1: null, f2: null, f3: null });
  // ✅ 直前に submit した groupId（エラー応答時に loading を解除するため）
  const lastSubmittedGroupIdRef = useRef<string | null>(null);
  // ✅ モーダルを閉じて再度開いたときに fetcher.data の古いレスポンスを無視するため。「今回のオープンで submit した countId+groupId」と一致するレスポンスだけ処理する
  const lastSubmittedForModalRef = useRef<{ countId: string; groupId: string } | null>(null);
  // ✅ incompleteGroupProducts のキーは常に文字列で統一（productGroupIds が number のときの照合漏れを防ぐ）
  const getIncompleteProductsForGroup = (groupId: string | number): Array<any> => {
    const sk = String(groupId);
    return incompleteGroupProducts.get(sk) ?? incompleteGroupProducts.get(groupId as string) ?? [];
  };
  const getIncompleteGroupHasMore = (groupId: string | number): boolean =>
    incompleteGroupHasMore.get(String(groupId)) ?? false;
  // ✅ 商品グループIDを名前で表示（list 由来で productGroupNames が無い場合に productGroups から解決）
  const getGroupDisplayName = (groupId: string | number): string =>
    productGroups.find((g) => String(g.id) === String(groupId) || normalizeIdForMatch(g.id) === normalizeIdForMatch(groupId))?.name ?? String(groupId);
  const handleLoadMoreIncompleteGroup = (groupId: string) => {
    if (!modalCount || loadingMoreIncompleteGroupId) return;
    if (incompleteGroupProductsFetcher.state !== "idle") return;
    const currentProducts = getIncompleteProductsForGroup(groupId);
    setLoadingMoreIncompleteGroupId(groupId);
    lastSubmittedForModalRef.current = { countId: String(modalCount.id), groupId };
    const formData = new FormData();
    formData.append("action", "get_incomplete_group_products");
    formData.append("countId", String(modalCount.id));
    formData.append("groupId", groupId);
    formData.append("locationId", modalCount.locationId);
    formData.append("offset", String(currentProducts.length));
    incompleteGroupProductsFetcher.submit(formData, { method: "post" });
  };
  
  const csvFileInputRef = useRef<HTMLInputElement>(null);
  const [csvImportMode, setCsvImportMode] = useState<"append" | "replace" | "new_only">("append");
  const [csvPreviewRows, setCsvPreviewRows] = useState<{ groupName: string; sku: string }[]>([]);
  const [csvPreviewSelected, setCsvPreviewSelected] = useState<Set<number>>(new Set());
  const [csvShowOnlySelected, setCsvShowOnlySelected] = useState(false);
  const csvPreviewFetcher = useFetcher<typeof action>();
  const adminMetafieldFetcher = useFetcher<typeof action>();
  const [adminMetafieldUnlocked, setAdminMetafieldUnlocked] = useState(false);
  const [adminUnlockCodeInput, setAdminUnlockCodeInput] = useState("");
  const ADMIN_UNLOCK_CODE = "metafield";
  /** 管理者用メタフィールド復元UI（コード入力＋修復ボタン）を表示するか。true にすると再有効化 */
  const SHOW_METAFIELD_RESTORE_UI = false;

  const editingGroup = editingGroupId
    ? productGroups.find((g) => g.id === editingGroupId)
    : null;

  // 編集モードの初期化（editingGroupId が変わったときだけ実行）
  // ✅ SKU/CSV由来の場合は getVariantsByInventoryItemIds または getVariantsBySkus で選択済み情報を取得。コレクション由来の場合は getCollectionsByIds で取得。
  useEffect(() => {
    if (!editingGroupId) return;
    const g = productGroups.find((pg) => pg.id === editingGroupId);
    if (!g) return;

    setGroupName(g.name);
    const hasInventoryItemIds = (g.inventoryItemIds ?? []).length > 0;
    const hasSkus = (g.skus ?? []).length > 0;
    const isSkuOnly = (g.collectionIds?.length ?? 0) === 0 && (hasInventoryItemIds || hasSkus);

    if (isSkuOnly) {
      setGroupCreateMethod("sku");
      const ids = g.inventoryItemIds ?? [];
      const skus = g.skus ?? [];
      setEditingSkuOnlyPreservedIds([]);
      setSelectedCollectionIds([]);
      setCollectionConfigs(new Map());
      if (ids.length > 0) {
        const fd = new FormData();
        fd.set("action", "getVariantsByInventoryItemIds");
        fd.set("ids", JSON.stringify(ids));
        skuResolveFetcher.submit(fd, { method: "post" });
      } else if (skus.length > 0) {
        // CSVアップロード等で inventoryItemIds が空・未保存の場合でも skus からバリアント一覧を取得
        const fd = new FormData();
        fd.set("action", "getVariantsBySkus");
        fd.set("skus", JSON.stringify(skus));
        skuResolveFetcher.submit(fd, { method: "post" });
      } else {
        setSelectedSkuVariants([]);
      }
    } else {
      setGroupCreateMethod("collection");
      setSelectedCollectionIds(g.collectionIds || []);
      setEditingSkuOnlyPreservedIds([]);
      const configMap = new Map<string, CollectionConfig>();
      if (g.collectionConfigs && g.collectionConfigs.length > 0) {
        for (const config of g.collectionConfigs) {
          configMap.set(config.collectionId, config);
        }
      }
      setCollectionConfigs(configMap);
      if ((g.collectionIds ?? []).length > 0) {
        const fd = new FormData();
        fd.set("action", "getCollectionsByIds");
        fd.set("ids", JSON.stringify(g.collectionIds));
        collectionResolveFetcher.submit(fd, { method: "post" });
      } else {
        setSelectedCollectionInfo(new Map());
      }
    }
  }, [editingGroupId]);

  // getCollectionsByIds の結果を selectedCollectionInfo に反映
  useEffect(() => {
    const d = collectionResolveFetcher.data;
    if (d && (d as { ok?: boolean }).ok && Array.isArray((d as { collections?: CollectionNode[] }).collections)) {
      const list = (d as { collections: CollectionNode[] }).collections;
      setSelectedCollectionInfo((prev) => {
        const next = new Map(prev);
        for (const c of list) next.set(c.id, c);
        return next;
      });
    }
  }, [collectionResolveFetcher.data]);

  // getVariantsByInventoryItemIds の結果を selectedSkuVariants に反映
  useEffect(() => {
    const d = skuResolveFetcher.data;
    if (d && (d as { ok?: boolean }).ok && Array.isArray((d as { variants?: SkuSearchVariant[] }).variants)) {
      setSelectedSkuVariants((d as { variants: SkuSearchVariant[] }).variants);
    }
  }, [skuResolveFetcher.data]);

  // ✅ モーダルが開いたときに未完了グループの商品リストを取得。編集状態のリセットはモーダルを閉じたときのみ行う（開いたまま modalCount が get_count_full 等で更新されると modalCount?.id の参照が変わり effect が再実行されて編集モードが戻ってしまうため）
  useEffect(() => {
    if (!modalOpen || !modalCount) {
      setIncompleteGroupProducts(new Map());
      setLoadingIncompleteGroupIds(new Set());
      incompleteGroupFetchIndexRef.current = 0;
      incompleteGroupIdsRef.current = [];
      incompleteGroupQueueRef.current = [];
      lastSubmittedForModalRef.current = null;
      lastProcessedIncompleteByFetcherRef.current = { f1: null, f2: null, f3: null };
      setModalEditMode(false);
      setModalEditedQuantities({});
      return;
    }

    // ✅ 今回のオープンで「どの submit のレスポンスを有効とするか」をリセット。閉じて再度開いたときの古い fetcher.data を処理しないようにする
    lastSubmittedForModalRef.current = null;
    lastProcessedIncompleteByFetcherRef.current = { f1: null, f2: null, f3: null };

    const allGroupIds = Array.isArray(modalCount.productGroupIds) && modalCount.productGroupIds.length > 0
      ? modalCount.productGroupIds
      : modalCount.productGroupId ? [modalCount.productGroupId] : [];
    const groupItemsMap = (modalCount as any)?.groupItems && typeof (modalCount as any).groupItems === "object" ? (modalCount as any).groupItems : {};

    // 未完了グループの商品リストを取得（3 fetcher で並列取得し、完了した fetcher にキューから次を割り当て）
    // ✅ 完了判定と同じロジック：getGroupItemsByKey で POS と同一の正規化キー照合
    const incompleteGroupIds = allGroupIds.filter((groupId) => {
      const groupItems = getGroupItemsByKey(groupItemsMap as Record<string, unknown[]>, String(groupId));
      return groupItems.length === 0;
    });

    const incompleteGroupIdsStr = incompleteGroupIds.map((id) => String(id));
    incompleteGroupIdsRef.current = incompleteGroupIdsStr;
    incompleteGroupFetchIndexRef.current = 0;
    setIncompleteGroupHasMore(new Map());
    setLoadingMoreIncompleteGroupId(null);
    setLoadingIncompleteGroupIds(new Set(incompleteGroupIdsStr));

    const countIdStr = String(modalCount.id);
    const locationIdStr = modalCount.locationId ?? "";
    const submitOne = (groupId: string, fetcher: ReturnType<typeof useFetcher<typeof action>>) => {
      const formData = new FormData();
      formData.append("action", "get_incomplete_group_products");
      formData.append("countId", countIdStr);
      formData.append("groupId", groupId);
      formData.append("locationId", locationIdStr);
      formData.append("offset", "0");
      fetcher.submit(formData, { method: "post" });
    };

    if (incompleteGroupIdsStr.length > 0) {
      // 先頭3件を3 fetcher に並列で送信し、残りをキューに
      if (incompleteGroupIdsStr.length > 0) submitOne(incompleteGroupIdsStr[0], incompleteGroupProductsFetcher);
      if (incompleteGroupIdsStr.length > 1) submitOne(incompleteGroupIdsStr[1], incompleteGroupProductsFetcher2);
      if (incompleteGroupIdsStr.length > 2) submitOne(incompleteGroupIdsStr[2], incompleteGroupProductsFetcher3);
      incompleteGroupQueueRef.current = incompleteGroupIdsStr.slice(3);
    } else {
      incompleteGroupQueueRef.current = [];
    }
  }, [modalOpen, modalCount?.id]);

  const lastRequestedFullCountIdRef = useRef<string | null>(null);
  // ✅ list 由来で groupItems がない棚卸をモーダルで開いたとき、フルデータを取得してステータス・完了/未完了表示を正確にする（同一IDで二重送信しない）
  useEffect(() => {
    if (!modalOpen || !modalCount) {
      if (!modalOpen) lastRequestedFullCountIdRef.current = null;
      return;
    }
    const hasGroupItems = (modalCount as any)?.groupItems && typeof (modalCount as any).groupItems === "object" && Object.keys((modalCount as any).groupItems || {}).length > 0;
    const hasItems = Array.isArray(modalCount.items) && modalCount.items.length > 0;
    if (hasGroupItems || hasItems) return;
    const countIdStr = String(modalCount.id);
    if (lastRequestedFullCountIdRef.current === countIdStr) return;
    lastRequestedFullCountIdRef.current = countIdStr;
    const fd = new FormData();
    fd.set("action", "get_count_full");
    fd.set("countId", countIdStr);
    countFullFetcher.submit(fd, { method: "post" });
  }, [modalOpen, modalCount?.id]);

  // ✅ get_count_full のレスポンスを modalCount にマージ（同じ棚卸IDのときのみ。別の棚卸を開き直した場合は無視）
  useEffect(() => {
    const data = countFullFetcher.data;
    if (!data || !(data as { ok?: boolean }).ok || !(data as { count?: InventoryCount }).count) return;
    const fullCount = (data as { count: InventoryCount }).count;
    if (!modalCount) return;
    if (String(modalCount.id) !== String(fullCount.id) && normalizeIdForMatch(modalCount.id) !== normalizeIdForMatch(fullCount.id)) return;
    setModalCount((prev) => {
      if (!prev || (String(prev.id) !== String(fullCount.id) && normalizeIdForMatch(prev.id) !== normalizeIdForMatch(fullCount.id))) return prev;
      return { ...prev, ...fullCount };
    });
  }, [countFullFetcher.data, modalCount?.id]);

  // ✅ 履歴一覧：list 由来で groupItems がない行をキューに追加
  useEffect(() => {
    const list = Array.isArray(inventoryCounts) ? inventoryCounts : [];
    const queue = listDetailQueueRef.current;
    const details = listCountDetails;
    for (const c of list) {
      const id = c?.id;
      if (!id || details[id]) continue;
      const hasDetail = (c as any)?.groupItems && typeof (c as any).groupItems === "object" && Object.keys((c as any).groupItems || {}).length > 0;
      if (hasDetail) continue;
      if (Array.isArray(c.items) && c.items.length > 0) continue;
      if (queue.includes(id)) continue;
      queue.push(id);
    }
  }, [inventoryCounts, listCountDetails]);

  // ✅ 履歴一覧：キューから1件ずつ get_count_full を送信
  useEffect(() => {
    if (listRowDetailFetcher.state !== "idle") return;
    const queue = listDetailQueueRef.current;
    if (queue.length === 0) return;
    const id = queue.shift()!;
    setLoadingListDetailIds((prev) => new Set(prev).add(id));
    const fd = new FormData();
    fd.set("action", "get_count_full");
    fd.set("countId", id);
    listRowDetailFetcher.submit(fd, { method: "post" });
  }, [inventoryCounts, listCountDetails, listRowDetailFetcher.state]);

  // ✅ 履歴一覧：get_count_full レスポンスを listCountDetails にマージ
  useEffect(() => {
    const data = listRowDetailFetcher.data;
    if (!data || !(data as { ok?: boolean }).ok || !(data as { count?: InventoryCount }).count) return;
    const fullCount = (data as { count: InventoryCount }).count;
    const id = String(fullCount.id);
    setListCountDetails((prev) => ({ ...prev, [id]: fullCount }));
    setLoadingListDetailIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, [listRowDetailFetcher.data]);

  // ✅ 未完了グループの商品リスト取得完了時の処理（3 fetcher 並列：成功時はマージ・loading 解除・キューから次をその fetcher に submit）
  const processIncompleteFetcherData = (
    data: any,
    fetcherKey: "f1" | "f2" | "f3",
    submitNext: (groupId: string) => void
  ) => {
    if (!data || !modalCount) return;
    const responseCountId = data?.countId != null ? String(data.countId) : null;
    const responseGroupId = data?.groupId != null ? String(data.groupId) : null;
    const currentCountId = String(modalCount.id);
    if (responseCountId !== "" && currentCountId && normalizeIdForMatch(responseCountId) !== normalizeIdForMatch(currentCountId)) return;

    const lastProcessed = lastProcessedIncompleteByFetcherRef.current[fetcherKey];
    const isLoadMore = Number(data?.offset ?? 0) > 0;

    if (data?.ok && data?.products != null && data?.groupId != null) {
      const { groupId, products, hasMore, offset } = data;
      const groupKey = String(groupId);
      if (!isLoadMore && lastProcessed === groupKey) return; // 同一レスポンスの二重処理防止
      setLoadingMoreIncompleteGroupId(null);
      setLoadingIncompleteGroupIds((prev) => {
        const next = new Set(prev);
        next.delete(groupKey);
        return next;
      });
      setIncompleteGroupProducts((prev) => {
        const newMap = new Map(prev);
        if (Number(offset) > 0) {
          const existing = newMap.get(groupKey) ?? [];
          newMap.set(groupKey, [...existing, ...products]);
        } else {
          newMap.set(groupKey, products);
        }
        return newMap;
      });
      setIncompleteGroupHasMore((prev) => {
        const next = new Map(prev);
        next.set(groupKey, Boolean(hasMore));
        return next;
      });
      if (!isLoadMore) {
        lastProcessedIncompleteByFetcherRef.current[fetcherKey] = groupKey;
        const nextGroupId = incompleteGroupQueueRef.current.shift();
        if (nextGroupId && modalCount) {
          submitNext(nextGroupId);
        }
      }
      return;
    }
    if (responseGroupId != null) {
      setLoadingIncompleteGroupIds((prev) => {
        const next = new Set(prev);
        next.delete(String(responseGroupId));
        return next;
      });
    }
  };

  useEffect(() => {
    if (!modalCount) return;
    const loc = modalCount.locationId ?? "";
    const countIdStr = String(modalCount.id);
    const submitOne = (groupId: string, fetcher: ReturnType<typeof useFetcher<typeof action>>) => {
      const formData = new FormData();
      formData.append("action", "get_incomplete_group_products");
      formData.append("countId", countIdStr);
      formData.append("groupId", groupId);
      formData.append("locationId", loc);
      formData.append("offset", "0");
      fetcher.submit(formData, { method: "post" });
    };
    processIncompleteFetcherData(
      incompleteGroupProductsFetcher.data,
      "f1",
      (groupId) => submitOne(groupId, incompleteGroupProductsFetcher)
    );
    processIncompleteFetcherData(
      incompleteGroupProductsFetcher2.data,
      "f2",
      (groupId) => submitOne(groupId, incompleteGroupProductsFetcher2)
    );
    processIncompleteFetcherData(
      incompleteGroupProductsFetcher3.data,
      "f3",
      (groupId) => submitOne(groupId, incompleteGroupProductsFetcher3)
    );
  }, [
    incompleteGroupProductsFetcher.data,
    incompleteGroupProductsFetcher2.data,
    incompleteGroupProductsFetcher3.data,
    modalCount,
  ]);

  // ✅ 履歴モーダルでの確定・リセット・キャンセル・数量保存成功時に一覧を再取得
  useEffect(() => {
    if (historyActionFetcher.data && (historyActionFetcher.data as { ok?: boolean }).ok) {
      revalidator.revalidate();
      setModalEditMode(false);
      setModalEditedQuantities({});
    }
    if (historyActionFetcher.data && !(historyActionFetcher.data as { ok?: boolean }).ok && (historyActionFetcher.data as { error?: string }).error) {
      alert((historyActionFetcher.data as { error?: string }).error);
    }
  }, [historyActionFetcher.data, revalidator]);

  // ✅ モーダル表示中の棚卸を loader の最新データと同期（確定・キャンセル後に revalidate で一覧が更新されたらモーダル内のステータスも更新）
  // list 由来の found には groupItems/items や cancelledGroupIds が無い場合があるため、ある項目はマージ。変更があるときだけ set してループ防止。
  useEffect(() => {
    if (!modalOpen || !modalCount || !Array.isArray(inventoryCounts) || inventoryCounts.length === 0) return;
    const found = inventoryCounts.find(
      (c) => String(c.id) === String(modalCount.id) || normalizeIdForMatch(c.id) === normalizeIdForMatch(modalCount.id)
    );
    if (!found) return;
    const nextStatus = (found as any).status;
    const nextCancelled = Array.isArray((found as any).cancelledGroupIds) ? (found as any).cancelledGroupIds : (modalCount as any).cancelledGroupIds;
    if (nextStatus === (modalCount as any).status && JSON.stringify(nextCancelled ?? []) === JSON.stringify((modalCount as any).cancelledGroupIds ?? [])) return;
    const merged = {
      ...found,
      productGroupNames: Array.isArray((found as any).productGroupNames) && (found as any).productGroupNames.length > 0 ? (found as any).productGroupNames : (modalCount as any).productGroupNames,
      cancelledGroupIds: nextCancelled,
      groupItems: (found as any).groupItems && typeof (found as any).groupItems === "object" && Object.keys((found as any).groupItems || {}).length > 0 ? (found as any).groupItems : (modalCount as any).groupItems,
      items: Array.isArray((found as any).items) && (found as any).items.length > 0 ? (found as any).items : (modalCount as any).items,
    };
    setModalCount(merged);
  }, [modalOpen, modalCount?.id, inventoryCounts]);

  const ITEMS_PER_PAGE = 1000;
  const [collectionPage, setCollectionPage] = useState(1);
  const [skuPage, setSkuPage] = useState(1);
  const paginatedCollections = useMemo(() => {
    const start = (collectionPage - 1) * ITEMS_PER_PAGE;
    return displayCollections.slice(start, start + ITEMS_PER_PAGE);
  }, [displayCollections, collectionPage]);
  const paginatedSkuVariants = useMemo(() => {
    const start = (skuPage - 1) * ITEMS_PER_PAGE;
    return displaySkuVariants.slice(start, start + ITEMS_PER_PAGE);
  }, [displaySkuVariants, skuPage]);
  const collectionTotalPages = Math.max(1, Math.ceil(displayCollections.length / ITEMS_PER_PAGE));
  const skuTotalPages = Math.max(1, Math.ceil(displaySkuVariants.length / ITEMS_PER_PAGE));

  useEffect(() => {
    setCollectionPage(1);
  }, [collectionSearchQuery, showOnlySelectedCollection]);
  useEffect(() => {
    setSkuPage(1);
  }, [skuSearchQuery, showOnlySelectedSku]);

  // コレクション選択時に商品リストを取得
  const handleOpenCollectionModal = async (collectionId: string, productGroupId?: string) => {
    setCollectionModalCollectionId(collectionId);
    setCollectionModalProductGroupId(productGroupId || null); // 右側から開いた場合は商品グループIDを保存
    setCollectionModalOpen(true);
    setCollectionModalLoading(true);
    setCollectionModalProducts([]);
    setCollectionModalSearchQuery("");
    setShowOnlySelectedInModal(false);
    setCollectionModalPage(1);
    collectionModalInitialSelectionDoneRef.current = false; // 商品取得後の「初回だけ全選択」を有効にする

    // 既存の設定があれば復元（商品リスト取得前に設定）
    // 右側から開いた場合は、その商品グループの設定を読み込む
    let existingConfig: CollectionConfig | undefined;
    if (productGroupId) {
      const group = productGroups.find((g) => g.id === productGroupId);
      if (group?.collectionConfigs) {
        existingConfig = group.collectionConfigs.find((c) => c.collectionId === collectionId);
      }
    } else {
      existingConfig = collectionConfigs.get(collectionId);
    }

    if (existingConfig && existingConfig.selectedVariantIds.length > 0) {
      setCollectionModalSelectedVariantIds(new Set(existingConfig.selectedVariantIds));
    } else {
      // 既存設定がない場合は空セット（商品リスト取得後に全選択にする）
      setCollectionModalSelectedVariantIds(new Set());
    }

    const formData = new FormData();
    formData.append("action", "get_collection_products");
    formData.append("collectionId", collectionId);
    collectionProductsFetcher.submit(formData, { method: "post" });
  };

  // 商品リスト取得完了時の処理（初回のみ「既存設定がなければ全選択」を行い、全選択/全解除ボタンの上書きを防ぐ）
  useEffect(() => {
    if (collectionProductsFetcher.data?.ok && collectionProductsFetcher.data.products) {
      const products = collectionProductsFetcher.data.products;
      setCollectionModalProducts(products);
      // このモーダル表示中に初めて商品を受け取ったときだけ、既存設定がなければ全選択する
      if (!collectionModalInitialSelectionDoneRef.current) {
        collectionModalInitialSelectionDoneRef.current = true;
        if (collectionModalSelectedVariantIds.size === 0) {
          const allVariantIds = new Set(products.map((p) => p.variantId));
          setCollectionModalSelectedVariantIds(allVariantIds);
        }
      }
      setCollectionModalLoading(false);
    } else if (collectionProductsFetcher.data?.error) {
      alert(collectionProductsFetcher.data.error);
      setCollectionModalLoading(false);
    }
  }, [collectionProductsFetcher.data]);

  // モーダルで選択商品を確定
  const handleConfirmCollectionSelection = () => {
    if (!collectionModalCollectionId) return;

    const selectedIds = Array.from(collectionModalSelectedVariantIds);
    const total = collectionModalProducts.length;
    const config: CollectionConfig = {
      collectionId: collectionModalCollectionId,
      selectedVariantIds: selectedIds,
      totalVariantCount: total,
    };

    // 右側から開いた場合（商品グループIDがある場合）は、直接商品グループを更新
    if (collectionModalProductGroupId) {
      const group = productGroups.find((g) => g.id === collectionModalProductGroupId);
      if (group) {
        const updatedConfigs = group.collectionConfigs ? [...group.collectionConfigs] : [];
        const existingIndex = updatedConfigs.findIndex((c) => c.collectionId === collectionModalCollectionId);
        if (existingIndex >= 0) {
          updatedConfigs[existingIndex] = config;
        } else {
          updatedConfigs.push(config);
        }

        const formData = new FormData();
        formData.append("action", "save_product_group");
        formData.append("id", collectionModalProductGroupId);
        formData.append("name", group.name);
        formData.append("collectionIds", group.collectionIds.join(","));
        formData.append("collectionConfigs", JSON.stringify(updatedConfigs));
        fetcher.submit(formData, { method: "post" });
      }
    } else {
      // 編集モード時は、collectionConfigsに保存
      const newConfigs = new Map(collectionConfigs);
      newConfigs.set(collectionModalCollectionId, config);
      setCollectionConfigs(newConfigs);

      // collectionIdsにも追加（まだない場合）
      if (!selectedCollectionIds.includes(collectionModalCollectionId)) {
        setSelectedCollectionIds([...selectedCollectionIds, collectionModalCollectionId]);
      }
    }

    setCollectionModalOpen(false);
    setCollectionModalCollectionId(null);
    setCollectionModalProductGroupId(null);
    setCollectionModalProducts([]);
    setCollectionModalSelectedVariantIds(new Set());
  };

  const filteredCounts = useMemo(() => {
    let list = [...inventoryCounts];
    // ロケーションフィルター（複数選択対応）
    if (locationFilters.size > 0) {
      list = list.filter((c) => locationFilters.has(c.locationId));
    }
    // ステータスフィルター（複数選択対応）
    if (statusFilters.size > 0) {
      list = list.filter((c) => statusFilters.has(c.status));
    }
    // 棚卸IDの並び順（昇順 or 降順は countNameSortOrder で切り替え）
    return list.sort((a, b) => {
      const na = parseCountNameNumber((a as { countName?: string }).countName);
      const nb = parseCountNameNumber((b as { countName?: string }).countName);
      return countNameSortOrder === "desc" ? nb - na : na - nb;
    });
  }, [inventoryCounts, locationFilters, statusFilters, countNameSortOrder]);

  // ✅ 一覧表示で未完了グループの商品リストを取得
  // ✅ 502根本対策：一覧では未完了グループの母数を取得しない（get_incomplete_group_products はモーダルを開いたときのみ呼ぶ）。
  // 履歴タブを開いている間の長時間 POST 連続を防ぎ、GET（loader）のタイムアウト・502 を解消する。

  const locationById = useMemo(() => {
    const m: Record<string, string> = {};
    locations.forEach((l) => {
      m[l.id] = l.name;
    });
    return m;
  }, [locations]);

  const getLocationName = (id: string) =>
    locationById[id] ?? (inventoryCounts.find((c) => c.locationId === id)?.locationName ?? id);

  const getStatusLabel = (status: string) => {
    const labels: Record<string, string> = {
      draft: "下書き",
      in_progress: "進行中",
      completed: "完了",
      cancelled: "キャンセル",
    };
    return (status && (labels[status] || status)) || "不明";
  };

  // ステータスバッジ用スタイル（アプリと同様のバッチ表示）
  const getStatusBadgeStyle = (status: string): React.CSSProperties => {
    const base = { display: "inline-block" as const, padding: "2px 8px", borderRadius: "9999px", fontSize: "12px", fontWeight: 600 };
    if (status === "completed") return { ...base, backgroundColor: "#d4edda", color: "#155724" };
    if (status === "cancelled") return { ...base, backgroundColor: "#e2e3e5", color: "#383d41" };
    if (status === "draft") return { ...base, backgroundColor: "#e2e3e5", color: "#383d41" };
    return { ...base, backgroundColor: "#cce5ff", color: "#004085" }; // in_progress
  };

  // ロケーション検索結果
  const filteredLocations = useMemo(() => {
    if (!createLocationSearchQuery.trim()) {
      return locations;
    }
    const query = createLocationSearchQuery.toLowerCase();
    return locations.filter((loc) => loc.name.toLowerCase().includes(query));
  }, [locations, createLocationSearchQuery]);

  const handleSaveGroup = () => {
    if (!groupName.trim()) {
      alert("グループ名を入力してください");
      return;
    }

    const formData = new FormData();
    formData.append("action", "save_product_group");
    if (editingGroupId) formData.append("id", editingGroupId);
    formData.append("name", groupName);
    formData.append("collectionIds", selectedCollectionIds.join(","));
    // collectionConfigsをJSON形式で送信
    const configsArray = Array.from(collectionConfigs.values());
    formData.append("collectionConfigs", JSON.stringify(configsArray));
    // ✅ collectionConfigsから商品リストを取得するための情報を送信（action関数内で処理）

    fetcher.submit(formData, { method: "post" });
    setGroupName("");
    setSelectedCollectionIds([]);
    setCollectionConfigs(new Map());
    setEditingGroupId(null);
  };

  const handleDeleteGroup = (id: string) => {
    if (!confirm("この商品グループを削除しますか？")) return;

    const formData = new FormData();
    formData.append("action", "delete_product_group");
    formData.append("id", id);
    fetcher.submit(formData, { method: "post" });
  };

  const handleCsvImportClick = () => {
    csvFileInputRef.current?.click();
  };

  const handleCsvFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result : "";
      if (!text.trim()) {
        alert("CSVファイルの内容が空です。");
        return;
      }
      const formData = new FormData();
      formData.append("action", "preview_csv_inventory_count");
      formData.append("csv", text);
      csvPreviewFetcher.submit(formData, { method: "post" });
    };
    reader.readAsText(file, "UTF-8");
    e.target.value = "";
  };

  useEffect(() => {
    const d = csvPreviewFetcher.data;
    if (d && (d as { ok?: boolean }).ok && Array.isArray((d as { rows?: { groupName: string; sku: string }[] }).rows)) {
      const rows = (d as { rows: { groupName: string; sku: string }[] }).rows;
      setCsvPreviewRows(rows);
      setCsvPreviewSelected(new Set(rows.map((_, i) => i)));
      setCsvShowOnlySelected(false);
    }
  }, [csvPreviewFetcher.data]);

  const handleCsvGroupAdd = () => {
    const selectedRows = csvPreviewRows.filter((_, i) => csvPreviewSelected.has(i));
    if (selectedRows.length === 0) {
      alert("1行以上選択してください。");
      return;
    }
    const csvContent = [["グループ名", "SKU"], ...selectedRows.map((r) => [r.groupName, r.sku])]
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const formData = new FormData();
    formData.append("action", "import_product_groups_csv");
    formData.append("csv", csvContent);
    formData.append("csvImportMode", csvImportMode);
    fetcher.submit(formData, { method: "post" });
    setCsvPreviewRows([]);
    setCsvPreviewSelected(new Set());
  };

  const toggleSkuVariant = (v: SkuSearchVariant) => {
    setSelectedSkuVariants((prev) => {
      const has = prev.some((x) => x.inventoryItemId === v.inventoryItemId);
      if (has) return prev.filter((x) => x.inventoryItemId !== v.inventoryItemId);
      return [...prev, v];
    });
  };

  const handleSaveGroupFromSkuSelection = () => {
    if (!groupName.trim()) {
      alert("グループ名を入力してください");
      return;
    }
    const mergedIds = [...selectedSkuVariants.map((v) => v.inventoryItemId), ...editingSkuOnlyPreservedIds];
    if (mergedIds.length === 0) {
      alert("SKUを1件以上選択するか、既存のSKUを維持してください");
      return;
    }
    const formData = new FormData();
    formData.append("action", "save_product_group");
    if (editingGroupId) formData.append("id", editingGroupId);
    formData.append("name", groupName.trim());
    formData.append("inventoryItemIds", JSON.stringify(mergedIds));
    formData.append("skus", JSON.stringify(selectedSkuVariants.map((v) => v.sku)));
    fetcher.submit(formData, { method: "post" });
    setGroupName("");
    setSelectedSkuVariants([]);
    setEditingGroupId(null);
    setEditingSkuOnlyPreservedIds([]);
  };

  const handleCsvTemplateDownload = () => {
    const sample = [
      ["グループ名", "SKU"],
      ["食品", "SKU-001"],
      ["食品", "SKU-002"],
      ["衣類", "SKU-003"],
    ];
    const csvContent = sample.map((row) => row.map(escapeCsv).join(",")).join("\n");
    const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "商品グループ_テンプレート.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  /** 登録済み商品グループをCSVでダウンロード（グループ名,SKU 形式）。編集して再アップロード可能。 */
  const handleCsvExport = () => {
    const rows: [string, string][] = [["グループ名", "SKU"]];
    for (const g of productGroups) {
      const skus = g.skus ?? [];
      if (skus.length === 0 && (g.inventoryItemIds?.length ?? 0) > 0) {
        continue;
      }
      for (const sku of skus) {
        rows.push([g.name, sku]);
      }
    }
    if (rows.length <= 1) {
      alert("SKU指定のグループがありません。コレクションのみのグループはCSVに含まれません。");
      return;
    }
    const csvContent = rows.map((row) => row.map(escapeCsv).join(",")).join("\n");
    const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "商品グループ_登録済み.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCreateCount = () => {
    if (!createLocationId) {
      alert("ロケーションを選択してください");
      return;
    }
    if (createProductGroupIds.length === 0 && !createProductGroupId) {
      alert("商品グループを選択してください");
      return;
    }

    const formData = new FormData();
    formData.append("action", "create_inventory_count");
    formData.append("inventoryCountsVersion", String(inventoryCountsVersion));
    formData.append("locationId", createLocationId);
    // 複数選択対応：productGroupIdsを優先、なければproductGroupIdを使用（後方互換性）
    if (createProductGroupIds.length > 0) {
      formData.append("productGroupIds", JSON.stringify(createProductGroupIds));
    } else if (createProductGroupId) {
      formData.append("productGroupId", createProductGroupId);
    }
    fetcher.submit(formData, { method: "post" });
    setCreateLocationId("");
    setCreateProductGroupId("");
    setCreateProductGroupIds([]);
  };

  const toggleProductGroup = (groupId: string) => {
    setCreateProductGroupIds((prev) => {
      if (prev.includes(groupId)) {
        return prev.filter((id) => id !== groupId);
      } else {
        return [...prev, groupId];
      }
    });
  };

  // 全選択/全解除（コメントアウトされたコード内で参照されているため定義）
  const toggleSelectAll = () => {
    if (selectedIds.size === filteredCounts.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredCounts.map((c) => c.id)));
    }
  };

  const exportCsv = (detail = false) => {
    if (selectedIds.size === 0) {
      alert("CSV出力する履歴を選択してください");
      return;
    }

    const selectedCounts = filteredCounts.filter((c) => selectedIds.has(c.id));
    const cols = detail ? csvColumns : csvColumnsSummary;
    const headers = cols.map((id) => STOCKTAKE_CSV_LABELS[id] ?? id);
    const toRow = (rowObj: Record<string, string | number>) => cols.map((id) => String(rowObj[id] ?? ""));

    const dateOnly = (iso?: string) => (iso ? new Date(iso).toISOString().split("T")[0] : "");
    const rows: string[][] = [];
    selectedCounts.forEach((c) => {
      const locName = getLocationName(c.locationId);
      const statusLabel = getStatusLabel(getDisplayStatusForCount(c));
      const countName = c.countName || c.id;

      const groupNames = Array.isArray(c.productGroupNames) && c.productGroupNames.length > 0
        ? c.productGroupNames.join(", ")
        : Array.isArray(c.productGroupIds) && c.productGroupIds.length > 0
        ? c.productGroupIds.join(", ")
        : c.productGroupName || c.productGroupId || "-";

      const baseRow: Record<string, string | number> = {
        countId: c.id,
        name: countName,
        date: dateOnly(c.createdAt),
        completedDate: dateOnly(c.completedAt),
        location: locName,
        productGroup: groupNames,
        status: statusLabel,
      };

      if (detail && c.items?.length) {
        c.items.forEach((it) => {
          const parsed = parseTitleToProductAndOptions(String(it.title || "").trim(), it as any);
          const productName = parsed.productName || (it as any).sku || "-";
          const { option1, option2, option3 } = parsed;
          const sku = String((it as any).sku ?? "").trim();
          const jan = String((it as any).barcode ?? "").trim();
          const kindLabel = (it as any).isExtra ? "予定外" : "";

          rows.push(toRow({
            ...baseRow,
            productTitle: productName,
            sku,
            barcode: jan,
            option1,
            option2,
            option3,
            currentQty: it.currentQuantity ?? "",
            actualQty: it.actualQuantity ?? "",
            delta: it.delta ?? "",
            kind: kindLabel,
          }));
        });
      } else {
        rows.push(toRow(baseRow));
      }
    });

    const csvContent = [headers, ...rows]
      .map((row) => row.map(escapeCsv).join(","))
      .join("\n");
    const blob = new Blob(["\uFEFF" + csvContent], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `棚卸履歴_${todayInShopTimezone}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };


  return (
    <s-page heading="棚卸">
      <s-scroll-box padding="base">
        <s-stack gap="base">
          {loadError && (
            <div style={{ padding: "12px 16px", background: "#fff4e5", border: "1px solid #e0b252", borderRadius: "8px", marginBottom: "8px" }}>
              <strong>データの読み込みに失敗しました。</strong>
              <span style={{ marginLeft: "4px" }}>ページを再読み込みしてください。</span>
              {loadErrorMessage && (
                <div style={{ marginTop: "8px", fontSize: "12px", wordBreak: "break-all", color: "#5c5c5c" }}>
                  原因: {loadErrorMessage}
                </div>
              )}
            </div>
          )}
          {/* 上部タブナビゲーション（設定画面とトンマナを揃える） */}
          <s-box padding="none">
            <div
              style={{
                display: "flex",
                gap: "8px",
                padding: "0 16px 8px",
                borderBottom: "1px solid #e1e3e5",
                flexWrap: "wrap",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                {[
                  { id: "groups" as const, label: "商品グループ設定" },
                  { id: "create" as const, label: "棚卸ID発行" },
                  { id: "history" as const, label: "履歴" },
                ].map((tab) => {
                  const selected = activeTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setActiveTab(tab.id)}
                      style={{
                        border: "none",
                        backgroundColor: selected ? "#e5e7eb" : "transparent",
                        borderRadius: 8,
                        padding: "6px 12px",
                        cursor: "pointer",
                        fontSize: 14,
                        fontWeight: selected ? 600 : 500,
                      }}
                    >
                      {tab.label}
                    </button>
                  );
                })}
              </div>
              {/* 管理者用：コード入力＋ボタンでメタフィールド復旧セクションを表示（SHOW_METAFIELD_RESTORE_UI を true にすると再有効化） */}
              {SHOW_METAFIELD_RESTORE_UI && (
              <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                <input
                  type="text"
                  value={adminUnlockCodeInput}
                  onChange={(e) => setAdminUnlockCodeInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      if (adminUnlockCodeInput.trim() === ADMIN_UNLOCK_CODE) setAdminMetafieldUnlocked(true);
                    }
                  }}
                  placeholder=""
                  autoComplete="off"
                  style={{
                    width: "72px",
                    padding: "4px 6px",
                    fontSize: 12,
                    border: "1px solid #e1e3e5",
                    borderRadius: 6,
                  }}
                />
                <button
                  type="button"
                  onClick={() => {
                    if (adminUnlockCodeInput.trim() === ADMIN_UNLOCK_CODE) setAdminMetafieldUnlocked(true);
                  }}
                  style={{
                    padding: "4px 8px",
                    fontSize: 12,
                    border: "1px solid #d1d5db",
                    borderRadius: 6,
                    background: "#f9fafb",
                    cursor: "pointer",
                  }}
                >
                  表示
                </button>
              </div>
              )}
            </div>
          </s-box>

          {/* 管理者用：コードで表示したメタフィールド復旧（adminMetafieldUnlocked 時のみ表示）。SHOW_METAFIELD_RESTORE_UI が true のときだけ枠ごと表示 */}
          {SHOW_METAFIELD_RESTORE_UI && adminMetafieldUnlocked && (
            <div style={{ margin: "12px 16px", padding: "12px", background: "#f9fafb", borderRadius: "8px", border: "1px solid #e5e7eb" }}>
              <div style={{ fontSize: "12px", color: "#6d7175", marginBottom: "8px" }}>管理者用：メタフィールド復旧</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginBottom: "8px" }}>
                <button
                  type="button"
                  onClick={() => adminMetafieldFetcher.submit({ action: "metafield_health" }, { method: "post" })}
                  disabled={adminMetafieldFetcher.state !== "idle"}
                  style={{
                    padding: "6px 12px",
                    fontSize: "12px",
                    border: "1px solid #d1d5db",
                    borderRadius: "6px",
                    background: "#fff",
                    cursor: adminMetafieldFetcher.state !== "idle" ? "not-allowed" : "pointer",
                  }}
                >
                  {adminMetafieldFetcher.state !== "idle" ? "確認中…" : "状態を確認"}
                </button>
                <button
                  type="button"
                  onClick={() => adminMetafieldFetcher.submit({ action: "metafield_repair", inventoryCountsVersion: String(inventoryCountsVersion) }, { method: "post" })}
                  disabled={adminMetafieldFetcher.state !== "idle"}
                  style={{
                    padding: "6px 12px",
                    fontSize: "12px",
                    border: "1px solid #b45309",
                    borderRadius: "6px",
                    background: "#fffbeb",
                    color: "#b45309",
                    cursor: adminMetafieldFetcher.state !== "idle" ? "not-allowed" : "pointer",
                  }}
                >
                  {adminMetafieldFetcher.state !== "idle" ? "実行中…" : "修復を実行"}
                </button>
              </div>
              {adminMetafieldFetcher.data?.ok && (adminMetafieldFetcher.data as { health?: MetafieldHealthResult }).health && (
                <div style={{ fontSize: "12px", marginTop: "8px", padding: "8px", background: "#fff", borderRadius: "6px", border: "1px solid #e5e7eb" }}>
                  <div style={{ fontWeight: 600, marginBottom: "4px" }}>
                    状態: {(adminMetafieldFetcher.data as { health: MetafieldHealthResult }).health.status === "ok" && "正常"}
                    {(adminMetafieldFetcher.data as { health: MetafieldHealthResult }).health.status === "warning" && "要修復（最終チャンク欠損）"}
                    {(adminMetafieldFetcher.data as { health: MetafieldHealthResult }).health.status === "error" && "エラー"}
                  </div>
                  <div style={{ color: "#6d7175" }}>{(adminMetafieldFetcher.data as { health: MetafieldHealthResult }).health.message}</div>
                  {(adminMetafieldFetcher.data as { health: MetafieldHealthResult }).health.mainTotalChunks != null && (
                    <div style={{ marginTop: "4px" }}>
                      メイン: {(adminMetafieldFetcher.data as { health: MetafieldHealthResult }).health.mainKey} / totalChunks={(adminMetafieldFetcher.data as { health: MetafieldHealthResult }).health.mainTotalChunks}
                      {((adminMetafieldFetcher.data as { health: MetafieldHealthResult }).health.mainMissingChunkIndices ?? []).length > 0 ? ` / 欠落: [${((adminMetafieldFetcher.data as { health: MetafieldHealthResult }).health.mainMissingChunkIndices ?? []).join(", ")}]` : ""}
                    </div>
                  )}
                </div>
              )}
              {adminMetafieldFetcher.data?.ok && typeof (adminMetafieldFetcher.data as { repaired?: boolean }).repaired === "boolean" && (
                <div style={{ fontSize: "12px", marginTop: "8px", padding: "8px", background: (adminMetafieldFetcher.data as { repaired: boolean }).repaired ? "#ecfdf5" : "#f0fdf4", borderRadius: "6px", border: "1px solid #a7f3d0" }}>
                  <strong>{(adminMetafieldFetcher.data as { repaired: boolean; message?: string }).repaired ? "修復しました" : "修復不要"}</strong>
                  {" "}{(adminMetafieldFetcher.data as { message?: string }).message}
                </div>
              )}
              {adminMetafieldFetcher.data && !(adminMetafieldFetcher.data as { ok?: boolean }).ok && (
                <div style={{ fontSize: "12px", marginTop: "8px", padding: "8px", background: "#fef2f2", borderRadius: "6px", border: "1px solid #fecaca", color: "#b91c1c" }}>
                  {(adminMetafieldFetcher.data as { error?: string }).error}
                </div>
              )}
            </div>
          )}

          {/* 商品グループ設定 */}
          {activeTab === "groups" && (
            <s-box padding="base">
              <div style={{ display: "flex", gap: "24px", alignItems: "flex-start", flexWrap: "wrap" }}>
                {/* 左側: タイトル＋説明 ＋ 作成フォーム（フォーム領域を白カードに） */}
                <div style={{ flex: "1 1 320px", minWidth: 0 }}>
                  <s-stack gap="base">
                    {/* タイトル＋説明 */}
                    <div>
                      <div
                        style={{
                          fontWeight: 600,
                          fontSize: 14,
                          marginBottom: 4,
                        }}
                      >
                        商品グループ設定
                      </div>
                      <s-text color="subdued">
                        棚卸で使う商品グループを作成・編集します。作成方法を選び、グループ内容を設定してください。
                      </s-text>
                    </div>

                    {/* 作成フォーム（白カード） */}
                    <div
                      style={{
                        background: "#ffffff",
                        borderRadius: 12,
                        boxShadow: "0 0 0 1px #e1e3e5",
                        padding: 16,
                      }}
                    >
                      <s-stack gap="base">
                        <s-text type="strong">商品グループ</s-text>
                        <div style={{ display: "flex", gap: "4px", alignItems: "center", flexWrap: "wrap" }}>
                        <button
                          type="button"
                          onClick={() => setGroupCreateMethod("sku")}
                          style={{
                            padding: "8px 16px",
                            border: "none",
                            borderRadius: "8px",
                            background: groupCreateMethod === "sku" ? "#e5e7eb" : "transparent",
                            color: "#202223",
                            fontSize: "14px",
                            fontWeight: 500,
                            cursor: "pointer",
                          }}
                        >
                          商品検索
                        </button>
                        <button
                          type="button"
                          onClick={() => setGroupCreateMethod("collection")}
                          style={{
                            padding: "8px 16px",
                            border: "none",
                            borderRadius: "8px",
                            background: groupCreateMethod === "collection" ? "#e5e7eb" : "transparent",
                            color: "#202223",
                            fontSize: "14px",
                            fontWeight: 500,
                            cursor: "pointer",
                          }}
                        >
                          コレクション検索
                        </button>
                        <button
                          type="button"
                          onClick={() => setGroupCreateMethod("csv")}
                          style={{
                            padding: "8px 16px",
                            border: "none",
                            borderRadius: "8px",
                            background: groupCreateMethod === "csv" ? "#e5e7eb" : "transparent",
                            color: "#202223",
                            fontSize: "14px",
                            fontWeight: 500,
                            cursor: "pointer",
                          }}
                        >
                          CSVアップロード
                        </button>
                      </div>
                      <s-divider />

                      {/* 1. コレクション検索（レイアウト・背景・ボタン位置を商品検索と同じに） */}
                      {groupCreateMethod === "collection" && (
                        <s-stack gap="base">
                          {editingGroupId && editingGroup && (
                            <div style={{ width: "100%", minWidth: 0, maxWidth: "100%", boxSizing: "border-box", padding: "12px 16px", background: "#e5e7eb", border: "1px solid #d1d5db", borderRadius: "8px", overflowWrap: "break-word", wordBreak: "break-word" }}>
                              <span style={{ fontWeight: 600, fontSize: "14px", whiteSpace: "normal" }}>「{editingGroup.name}」編集中</span>
                            </div>
                          )}
                          <s-text type="strong">コレクション検索</s-text>
                          <s-text color="subdued">
                            グループ名を入力し、コレクションを検索して選択し、グループを作成します。検索結果のみ表示されるため、多数のコレクションがあるストアでも軽く使えます。
                          </s-text>
                          <s-text color="subdued">
                            並び順：コレクション選択順＋コレクション表示順
                          </s-text>
                          <s-text-field
                            label="グループ名"
                            value={groupName}
                            onInput={(e: any) => setGroupName(readValue(e))}
                            onChange={(e: any) => setGroupName(readValue(e))}
                            placeholder="例: 食品、衣類、雑貨"
                          />
                          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                            <input
                              type="text"
                              value={collectionSearchQuery}
                              onChange={(e) => setCollectionSearchQuery(e.target.value)}
                              placeholder="コレクション名で検索"
                              style={{
                                flex: "1 1 auto",
                                minWidth: 0,
                                padding: "8px 12px",
                                border: "1px solid #d1d5db",
                                borderRadius: "6px",
                                fontSize: "14px",
                                boxSizing: "border-box",
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" && collectionSearchQuery.trim() && collectionSearchFetcher.state !== "submitting") {
                                  e.preventDefault();
                                  const fd = new FormData();
                                  fd.set("action", "searchCollectionsForInventoryCount");
                                  fd.set("query", collectionSearchQuery.trim());
                                  collectionSearchFetcher.submit(fd, { method: "post" });
                                }
                              }}
                            />
                            <button
                              type="button"
                              onClick={() => {
                                if (!collectionSearchQuery.trim() || collectionSearchFetcher.state === "submitting") return;
                                const fd = new FormData();
                                fd.set("action", "searchCollectionsForInventoryCount");
                                fd.set("query", collectionSearchQuery.trim());
                                collectionSearchFetcher.submit(fd, { method: "post" });
                              }}
                              disabled={!collectionSearchQuery.trim() || collectionSearchFetcher.state === "submitting"}
                              style={{
                                padding: "6px 12px",
                                backgroundColor: !collectionSearchQuery.trim() || collectionSearchFetcher.state === "submitting" ? "#d1d5db" : "#2563eb",
                                color: "#ffffff",
                                border: "none",
                                borderRadius: "6px",
                                fontSize: "13px",
                                fontWeight: 500,
                                cursor: !collectionSearchQuery.trim() || collectionSearchFetcher.state === "submitting" ? "not-allowed" : "pointer",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {collectionSearchFetcher.state === "submitting" ? "検索中..." : "検索"}
                            </button>
                          </div>
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}>
                            <s-text color="subdued">
                              {showOnlySelectedCollection
                                ? `選択済み: ${displayCollections.length}件`
                                : displayCollections.length <= ITEMS_PER_PAGE
                                  ? `表示: ${displayCollections.length}件`
                                  : `表示: ${(collectionPage - 1) * ITEMS_PER_PAGE + 1}-${Math.min(collectionPage * ITEMS_PER_PAGE, displayCollections.length)}件 / ${displayCollections.length}件`}
                            </s-text>
                            <div style={{ display: "flex", gap: "8px" }}>
                              <button
                                type="button"
                                onClick={() => setShowOnlySelectedCollection((prev) => !prev)}
                                disabled={selectedCollectionIds.length === 0}
                                style={{
                                  padding: "4px 12px",
                                  borderRadius: "6px",
                                  border: "1px solid #d1d5db",
                                  backgroundColor: showOnlySelectedCollection && selectedCollectionIds.length > 0 ? "#eff6ff" : selectedCollectionIds.length === 0 ? "#f3f4f6" : "#ffffff",
                                  color: selectedCollectionIds.length === 0 ? "#9ca3af" : "#202223",
                                  fontSize: "12px",
                                  fontWeight: 500,
                                  cursor: selectedCollectionIds.length === 0 ? "not-allowed" : "pointer",
                                }}
                              >
                                選択済み ({selectedCollectionIds.length})
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setSelectedCollectionIds([]);
                                  setCollectionConfigs(new Map());
                                  setSelectedCollectionInfo(new Map());
                                  setShowOnlySelectedCollection(false);
                                }}
                                disabled={selectedCollectionIds.length === 0}
                                style={{
                                  padding: "4px 12px",
                                  borderRadius: "6px",
                                  border: "1px solid #d1d5db",
                                  backgroundColor: selectedCollectionIds.length === 0 ? "#f3f4f6" : "#ffffff",
                                  color: selectedCollectionIds.length === 0 ? "#9ca3af" : "#d72c0d",
                                  fontSize: "12px",
                                  fontWeight: 500,
                                  cursor: selectedCollectionIds.length === 0 ? "not-allowed" : "pointer",
                                }}
                              >
                                選択解除
                              </button>
                            </div>
                          </div>
                          <div style={{ maxHeight: "280px", overflowY: "auto", border: "1px solid #e1e3e5", borderRadius: "8px", padding: "6px" }}>
                            {displayCollections.length === 0 ? (
                              <s-box padding="base">
                                <s-text color="subdued">
                                  {showOnlySelectedCollection ? "選択済みのコレクションがありません" : collectionSearchFetcher.state === "submitting" ? "検索中..." : collectionSearchFetcher.data?.collections?.length === 0 && collectionSearchQuery.trim() ? "別キーワードで検索してください" : "コレクション名を入力して検索してください"}
                                </s-text>
                              </s-box>
                            ) : (
                              <>
                                {paginatedCollections.map((col, colIndex) => {
                                  const isSelected = selectedCollectionIds.includes(col.id);
                                  const config = collectionConfigs.get(col.id);
                                  const selectedCount = config?.selectedVariantIds?.length ?? 0;
                                  const totalCount = config?.totalVariantCount ?? 0;

                                  return (
                                    <div
                                      key={col.id}
                                      style={{
                                        padding: "10px 12px",
                                        borderRadius: "6px",
                                        cursor: "pointer",
                                        backgroundColor: isSelected ? "#eff6ff" : "transparent",
                                        border: isSelected ? "1px solid #2563eb" : "1px solid transparent",
                                        marginTop: colIndex === 0 ? 0 : "4px",
                                        display: "flex",
                                        alignItems: "center",
                                        gap: "8px",
                                      }}
                                    >
                                      <input
                                        type="checkbox"
                                        checked={isSelected}
                                        readOnly
                                        style={{ width: "16px", height: "16px", flexShrink: 0 }}
                                        onClick={(e) => e.stopPropagation()}
                                      />
                                      <div
                                        style={{ flex: "1 1 auto", minWidth: 0 }}
                                        onClick={() => {
                                          const nextSelected = isSelected ? selectedCollectionIds.filter((id) => id !== col.id) : [...selectedCollectionIds, col.id];
                                          setSelectedCollectionIds(nextSelected);
                                          setSelectedCollectionInfo((prev) => {
                                            const next = new Map(prev);
                                            if (isSelected) next.delete(col.id);
                                            else next.set(col.id, col);
                                            return next;
                                          });
                                          if (isSelected) {
                                            const newConfigs = new Map(collectionConfigs);
                                            newConfigs.delete(col.id);
                                            setCollectionConfigs(newConfigs);
                                          }
                                        }}
                                      >
                                        <span style={{ fontWeight: isSelected ? 600 : 500, overflow: "hidden", textOverflow: "ellipsis", display: "block" }}>
                                          {col.title}
                                        </span>
                                        <span style={{ fontSize: "12px", color: "#6d7175" }}>
                                          {selectedCount} / {totalCount}
                                        </span>
                                      </div>
                                      {isSelected && (
                                        <button
                                          type="button"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            setSelectedCollectionIds(selectedCollectionIds.filter((id) => id !== col.id));
                                            setSelectedCollectionInfo((prev) => {
                                              const next = new Map(prev);
                                              next.delete(col.id);
                                              return next;
                                            });
                                            const newConfigs = new Map(collectionConfigs);
                                            newConfigs.delete(col.id);
                                            setCollectionConfigs(newConfigs);
                                          }}
                                          style={{
                                            fontSize: "12px",
                                            color: "#d72c0d",
                                            background: "none",
                                            border: "none",
                                            cursor: "pointer",
                                            textDecoration: "underline",
                                            padding: "4px 8px",
                                            flexShrink: 0,
                                          }}
                                        >
                                          解除
                                        </button>
                                      )}
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleOpenCollectionModal(col.id);
                                        }}
                                        style={{
                                          padding: "4px 8px",
                                          fontSize: "12px",
                                          border: "1px solid #c9cccf",
                                          borderRadius: "6px",
                                          background: "#fff",
                                          cursor: "pointer",
                                          flexShrink: 0,
                                        }}
                                      >
                                        商品を選ぶ
                                      </button>
                                    </div>
                                  );
                                })}
                              </>
                            )}
                          </div>
                          {displayCollections.length > ITEMS_PER_PAGE && (
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "12px", padding: "8px 0" }}>
                              <button
                                type="button"
                                onClick={() => setCollectionPage((p) => Math.max(1, p - 1))}
                                disabled={collectionPage <= 1}
                                style={{
                                  padding: "6px 12px",
                                  border: "1px solid #c9cccf",
                                  borderRadius: "6px",
                                  background: collectionPage <= 1 ? "#f6f6f7" : "#fff",
                                  cursor: collectionPage <= 1 ? "not-allowed" : "pointer",
                                  fontSize: "13px",
                                  color: collectionPage <= 1 ? "#8c9196" : "#202223",
                                }}
                              >
                                前へ
                              </button>
                              <span style={{ fontSize: "13px", color: "#6d7175" }}>
                                {(collectionPage - 1) * ITEMS_PER_PAGE + 1}-{Math.min(collectionPage * ITEMS_PER_PAGE, displayCollections.length)} / {displayCollections.length}件
                              </span>
                              <button
                                type="button"
                                onClick={() => setCollectionPage((p) => Math.min(collectionTotalPages, p + 1))}
                                disabled={collectionPage >= collectionTotalPages}
                                style={{
                                  padding: "6px 12px",
                                  border: "1px solid #c9cccf",
                                  borderRadius: "6px",
                                  background: collectionPage >= collectionTotalPages ? "#f6f6f7" : "#fff",
                                  cursor: collectionPage >= collectionTotalPages ? "not-allowed" : "pointer",
                                  fontSize: "13px",
                                  color: collectionPage >= collectionTotalPages ? "#8c9196" : "#202223",
                                }}
                              >
                                次へ
                              </button>
                            </div>
                          )}
                          {selectedCollectionIds.length > 0 && (
                            <s-text color="subdued">
                              選択中: {selectedCollectionIds.length}件
                            </s-text>
                          )}
                          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                            <button
                              type="button"
                              onClick={handleSaveGroup}
                              disabled={fetcher.state !== "idle" || !groupName.trim()}
                              style={{
                                padding: "8px 16px",
                                backgroundColor: fetcher.state !== "idle" || !groupName.trim() ? "#d1d5db" : "#2563eb",
                                color: "#ffffff",
                                border: "none",
                                borderRadius: "6px",
                                fontSize: "14px",
                                fontWeight: 600,
                                cursor: fetcher.state !== "idle" || !groupName.trim() ? "not-allowed" : "pointer",
                                width: "100%",
                              }}
                            >
                              {editingGroupId ? "更新" : "グループを追加"}
                            </button>
                            {editingGroupId && (
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingGroupId(null);
                                  setGroupName("");
                                  setSelectedCollectionIds([]);
                                  setCollectionConfigs(new Map());
                                }}
                                style={{
                                  padding: "8px 16px",
                                  backgroundColor: "#ffffff",
                                  color: "#d72c0d",
                                  border: "1px solid #d1d5db",
                                  borderRadius: "6px",
                                  fontSize: "14px",
                                  fontWeight: 500,
                                  cursor: "pointer",
                                  width: "100%",
                                }}
                              >
                                キャンセル
                              </button>
                            )}
                          </div>
                        </s-stack>
                      )}

                      {/* 2. 商品検索 */}
                      {groupCreateMethod === "sku" && (
                        <s-stack gap="base">
                          {editingGroupId && editingGroup && (
                            <div style={{ width: "100%", minWidth: 0, maxWidth: "100%", boxSizing: "border-box", padding: "12px 16px", background: "#e5e7eb", border: "1px solid #d1d5db", borderRadius: "8px", overflowWrap: "break-word", wordBreak: "break-word" }}>
                              <span style={{ fontWeight: 600, fontSize: "14px", whiteSpace: "normal" }}>「{editingGroup.name}」編集中</span>
                            </div>
                          )}
                          <s-text type="strong">商品検索</s-text>
                          <s-text color="subdued">
                            グループ名を入力し、SKU・商品名で検索して選択し、グループを作成します。検索結果のみ表示されるため、商品が多いストアでも軽く使えます。
                          </s-text>
                          <s-text color="subdued">
                            並び順：選択順
                          </s-text>
                          <s-text-field
                            label="グループ名"
                            value={groupName}
                            onInput={(e: any) => setGroupName(readValue(e))}
                            onChange={(e: any) => setGroupName(readValue(e))}
                            placeholder="例: 雑貨グループ"
                          />
                          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                            <input
                              type="text"
                              value={skuSearchQuery}
                              onChange={(e) => setSkuSearchQuery(e.target.value)}
                              placeholder="SKU・商品名・JANの一部を入力"
                              style={{
                                flex: "1 1 auto",
                                minWidth: 0,
                                padding: "8px 12px",
                                border: "1px solid #d1d5db",
                                borderRadius: "6px",
                                fontSize: "14px",
                                boxSizing: "border-box",
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" && skuSearchQuery.trim() && skuSearchFetcher.state !== "submitting") {
                                  e.preventDefault();
                                  const fd = new FormData();
                                  fd.set("action", "searchVariantsForInventoryCount");
                                  fd.set("query", skuSearchQuery.trim());
                                  skuSearchFetcher.submit(fd, { method: "post" });
                                }
                              }}
                            />
                            <button
                              type="button"
                              onClick={() => {
                                if (!skuSearchQuery.trim() || skuSearchFetcher.state === "submitting") return;
                                const fd = new FormData();
                                fd.set("action", "searchVariantsForInventoryCount");
                                fd.set("query", skuSearchQuery.trim());
                                skuSearchFetcher.submit(fd, { method: "post" });
                              }}
                              disabled={!skuSearchQuery.trim() || skuSearchFetcher.state === "submitting"}
                              style={{
                                padding: "6px 12px",
                                backgroundColor: !skuSearchQuery.trim() || skuSearchFetcher.state === "submitting" ? "#d1d5db" : "#2563eb",
                                color: "#ffffff",
                                border: "none",
                                borderRadius: "6px",
                                fontSize: "13px",
                                fontWeight: 500,
                                cursor: !skuSearchQuery.trim() || skuSearchFetcher.state === "submitting" ? "not-allowed" : "pointer",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {skuSearchFetcher.state === "submitting" ? "検索中..." : "検索"}
                            </button>
                          </div>
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}>
                            <s-text color="subdued">
                              {showOnlySelectedSku
                                ? `選択済み: ${displaySkuVariants.length}件`
                                : displaySkuVariants.length <= ITEMS_PER_PAGE
                                  ? `表示: ${displaySkuVariants.length}件`
                                  : `表示: ${(skuPage - 1) * ITEMS_PER_PAGE + 1}-${Math.min(skuPage * ITEMS_PER_PAGE, displaySkuVariants.length)}件 / ${displaySkuVariants.length}件`}
                            </s-text>
                            <div style={{ display: "flex", gap: "8px" }}>
                              <button
                                type="button"
                                onClick={() => setShowOnlySelectedSku((prev) => !prev)}
                                disabled={selectedSkuVariants.length === 0}
                                style={{
                                  padding: "4px 12px",
                                  borderRadius: "6px",
                                  border: "1px solid #d1d5db",
                                  backgroundColor: showOnlySelectedSku && selectedSkuVariants.length > 0 ? "#eff6ff" : selectedSkuVariants.length === 0 ? "#f3f4f6" : "#ffffff",
                                  color: selectedSkuVariants.length === 0 ? "#9ca3af" : "#202223",
                                  fontSize: "12px",
                                  fontWeight: 500,
                                  cursor: selectedSkuVariants.length === 0 ? "not-allowed" : "pointer",
                                }}
                              >
                                選択済み ({selectedSkuVariants.length})
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setSelectedSkuVariants([]);
                                  setShowOnlySelectedSku(false);
                                }}
                                disabled={selectedSkuVariants.length === 0}
                                style={{
                                  padding: "4px 12px",
                                  borderRadius: "6px",
                                  border: "1px solid #d1d5db",
                                  backgroundColor: selectedSkuVariants.length === 0 ? "#f3f4f6" : "#ffffff",
                                  color: selectedSkuVariants.length === 0 ? "#9ca3af" : "#d72c0d",
                                  fontSize: "12px",
                                  fontWeight: 500,
                                  cursor: selectedSkuVariants.length === 0 ? "not-allowed" : "pointer",
                                }}
                              >
                                選択解除
                              </button>
                            </div>
                          </div>
                          <div style={{ maxHeight: "280px", overflowY: "auto", border: "1px solid #e1e3e5", borderRadius: "8px", padding: "6px" }}>
                            {displaySkuVariants.length > 0 ? paginatedSkuVariants.map((v, skuIndex) => {
                              const isSelected = selectedSkuVariants.some((x) => x.inventoryItemId === v.inventoryItemId);
                              return (
                                <div
                                  key={v.inventoryItemId}
                                  onClick={() => toggleSkuVariant(v)}
                                  style={{
                                    padding: "10px 12px",
                                    borderRadius: "6px",
                                    cursor: "pointer",
                                    backgroundColor: isSelected ? "#eff6ff" : "transparent",
                                    border: isSelected ? "1px solid #2563eb" : "1px solid transparent",
                                    marginTop: skuIndex === 0 ? 0 : "4px",
                                    display: "flex",
                                    alignItems: "center",
                                    gap: "8px",
                                  }}
                                >
                                  <input type="checkbox" checked={isSelected} readOnly style={{ width: "16px", height: "16px", flexShrink: 0 }} />
                                  <div style={{ flex: "1 1 auto", minWidth: 0 }}>
                                    <span style={{ fontWeight: isSelected ? 600 : 500, overflow: "hidden", textOverflow: "ellipsis", display: "block" }}>
                                      {v.productTitle || "(商品名なし)"}
                                    </span>
                                    {v.sku ? (
                                      <span style={{ fontSize: "12px", color: "#6d7175", display: "block" }}>SKU：{v.sku}</span>
                                    ) : null}
                                    {v.barcode ? (
                                      <span style={{ fontSize: "12px", color: "#6d7175", display: "block" }}>JAN：{v.barcode}</span>
                                    ) : null}
                                    {(v.option1 || v.option2 || v.option3) ? (
                                      <span style={{ fontSize: "11px", color: "#8c9196", display: "block" }}>
                                        {[v.option1, v.option2, v.option3].filter(Boolean).join(" / ")}
                                      </span>
                                    ) : null}
                                  </div>
                                </div>
                              );
                            }) : (
                              <s-box padding="base">
                                <s-text color="subdued">
                                  {showOnlySelectedSku ? "選択済みの商品がありません" : skuSearchFetcher.state === "submitting" ? "検索中..." : (skuSearchFetcher.data?.variants?.length === 0 && skuSearchQuery.trim()) ? "別キーワードで検索してください" : "キーワードを入力して検索してください"}
                                </s-text>
                              </s-box>
                            )}
                          </div>
                          {displaySkuVariants.length > ITEMS_PER_PAGE && (
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "12px", padding: "8px 0" }}>
                              <button
                                type="button"
                                onClick={() => setSkuPage((p) => Math.max(1, p - 1))}
                                disabled={skuPage <= 1}
                                style={{
                                  padding: "6px 12px",
                                  border: "1px solid #c9cccf",
                                  borderRadius: "6px",
                                  background: skuPage <= 1 ? "#f6f6f7" : "#fff",
                                  cursor: skuPage <= 1 ? "not-allowed" : "pointer",
                                  fontSize: "13px",
                                  color: skuPage <= 1 ? "#8c9196" : "#202223",
                                }}
                              >
                                前へ
                              </button>
                              <span style={{ fontSize: "13px", color: "#6d7175" }}>
                                {(skuPage - 1) * ITEMS_PER_PAGE + 1}-{Math.min(skuPage * ITEMS_PER_PAGE, displaySkuVariants.length)} / {displaySkuVariants.length}件
                              </span>
                              <button
                                type="button"
                                onClick={() => setSkuPage((p) => Math.min(skuTotalPages, p + 1))}
                                disabled={skuPage >= skuTotalPages}
                                style={{
                                  padding: "6px 12px",
                                  border: "1px solid #c9cccf",
                                  borderRadius: "6px",
                                  background: skuPage >= skuTotalPages ? "#f6f6f7" : "#fff",
                                  cursor: skuPage >= skuTotalPages ? "not-allowed" : "pointer",
                                  fontSize: "13px",
                                  color: skuPage >= skuTotalPages ? "#8c9196" : "#202223",
                                }}
                              >
                                次へ
                              </button>
                            </div>
                          )}
                          {(selectedSkuVariants.length > 0 || editingSkuOnlyPreservedIds.length > 0) && (
                            <s-text color="subdued">
                              {editingGroupId && editingSkuOnlyPreservedIds.length > 0
                                ? `選択中: ${selectedSkuVariants.length}件（一覧外のSKU: ${editingSkuOnlyPreservedIds.length}件を含む）`
                                : `選択中: ${selectedSkuVariants.length}件`}
                            </s-text>
                          )}
                          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                            <button
                              type="button"
                              onClick={handleSaveGroupFromSkuSelection}
                              disabled={fetcher.state !== "idle" || !groupName.trim() || (selectedSkuVariants.length === 0 && editingSkuOnlyPreservedIds.length === 0)}
                              style={{
                                padding: "8px 16px",
                                backgroundColor: fetcher.state !== "idle" || !groupName.trim() || (selectedSkuVariants.length === 0 && editingSkuOnlyPreservedIds.length === 0) ? "#d1d5db" : "#2563eb",
                                color: "#ffffff",
                                border: "none",
                                borderRadius: "6px",
                                fontSize: "14px",
                                fontWeight: 600,
                                cursor: fetcher.state !== "idle" || !groupName.trim() || (selectedSkuVariants.length === 0 && editingSkuOnlyPreservedIds.length === 0) ? "not-allowed" : "pointer",
                                width: "100%",
                              }}
                            >
                              {editingGroupId ? "更新" : "グループを追加"}
                            </button>
                            {editingGroupId && (
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingGroupId(null);
                                  setGroupName("");
                                  setSelectedSkuVariants([]);
                                  setEditingSkuOnlyPreservedIds([]);
                                }}
                                style={{
                                  padding: "8px 16px",
                                  backgroundColor: "#ffffff",
                                  color: "#d72c0d",
                                  border: "1px solid #d1d5db",
                                  borderRadius: "6px",
                                  fontSize: "14px",
                                  fontWeight: 500,
                                  cursor: "pointer",
                                  width: "100%",
                                }}
                              >
                                キャンセル
                              </button>
                            )}
                          </div>
                        </s-stack>
                      )}

                      {/* 3. CSVアップロード（仕入同様: アップロード後にリスト表示 → チェックで選択 → グループを追加） */}
                      {groupCreateMethod === "csv" && (
                        <s-stack gap="base">
                          <s-text type="strong">CSVアップロード（グループ名＋SKU）</s-text>
                          <s-text color="subdued">
                            テンプレートをダウンロードしてCSVを作成し、アップロードしてください。アップロード後にリストが表示されるので、チェックした行だけ「グループを追加」で追加します。
                          </s-text>
                          <s-text color="subdued">
                            並び順：グループ名行順＋CSV行順
                          </s-text>
                          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                            <s-text color="subdued">インポート時の動作</s-text>
                            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                              <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
                                <input
                                  type="radio"
                                  name="csvImportMode"
                                  checked={csvImportMode === "new_only"}
                                  onChange={() => setCsvImportMode("new_only")}
                                />
                                <span>新規作成（既存のグループ名はスキップし、存在しない名前だけ新規グループを作成）</span>
                              </label>
                              <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
                                <input
                                  type="radio"
                                  name="csvImportMode"
                                  checked={csvImportMode === "append"}
                                  onChange={() => setCsvImportMode("append")}
                                />
                                <span>追加（同じグループ名のSKUを既存に足す）</span>
                              </label>
                              <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
                                <input
                                  type="radio"
                                  name="csvImportMode"
                                  checked={csvImportMode === "replace"}
                                  onChange={() => setCsvImportMode("replace")}
                                />
                                <span>上書き（同じグループ名のSKUをCSVの内容で置き換える）</span>
                              </label>
                            </div>
                          </div>
                          <input
                            type="file"
                            ref={csvFileInputRef}
                            accept=".csv,text/csv"
                            style={{ display: "none" }}
                            onChange={handleCsvFileChange}
                          />
                          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                            <button
                              type="button"
                              onClick={() => {
                                setCsvPreviewRows([]);
                                setCsvPreviewSelected(new Set());
                                csvFileInputRef.current?.click();
                              }}
                              disabled={csvPreviewFetcher.state === "submitting"}
                              style={{
                                padding: "6px 12px",
                                border: "1px solid #d1d5db",
                                borderRadius: "6px",
                                background: "#fff",
                                cursor: csvPreviewFetcher.state === "submitting" ? "not-allowed" : "pointer",
                                fontSize: "13px",
                              }}
                            >
                              {csvPreviewFetcher.state === "submitting" ? "読み込み中..." : "CSVアップロード"}
                            </button>
                            <button
                              type="button"
                              onClick={handleCsvTemplateDownload}
                              style={{
                                padding: "6px 12px",
                                border: "1px solid #d1d5db",
                                borderRadius: "6px",
                                background: "#fff",
                                cursor: "pointer",
                                fontSize: "13px",
                              }}
                            >
                              テンプレートダウンロード
                            </button>
                            <button
                              type="button"
                              onClick={handleCsvExport}
                              disabled={productGroups.length === 0}
                              style={{
                                padding: "6px 12px",
                                border: "1px solid #d1d5db",
                                borderRadius: "6px",
                                background: productGroups.length === 0 ? "#f3f4f6" : "#fff",
                                cursor: productGroups.length === 0 ? "not-allowed" : "pointer",
                                fontSize: "13px",
                              }}
                            >
                              登録済みをCSVダウンロード
                            </button>
                          </div>
                          {csvPreviewRows.length > 0 && (
                            <>
                              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}>
                                <s-text color="subdued">
                                  {csvShowOnlySelected
                                    ? `選択済み: ${csvPreviewSelected.size}件`
                                    : `表示: ${csvPreviewRows.length}件 / 選択中: ${csvPreviewSelected.size}件`}
                                </s-text>
                                <div style={{ display: "flex", gap: "8px" }}>
                                  <button
                                    type="button"
                                    onClick={() => setCsvShowOnlySelected((prev) => !prev)}
                                    disabled={csvPreviewSelected.size === 0}
                                    style={{
                                      padding: "4px 12px",
                                      borderRadius: "6px",
                                      border: "1px solid #d1d5db",
                                      backgroundColor: csvShowOnlySelected && csvPreviewSelected.size > 0 ? "#eff6ff" : csvPreviewSelected.size === 0 ? "#f3f4f6" : "#ffffff",
                                      color: csvPreviewSelected.size === 0 ? "#9ca3af" : "#202223",
                                      fontSize: "12px",
                                      cursor: csvPreviewSelected.size === 0 ? "not-allowed" : "pointer",
                                    }}
                                  >
                                    選択済み ({csvPreviewSelected.size})
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setCsvPreviewSelected(new Set());
                                      setCsvShowOnlySelected(false);
                                    }}
                                    disabled={csvPreviewSelected.size === 0}
                                    style={{
                                      padding: "4px 12px",
                                      borderRadius: "6px",
                                      border: "1px solid #d1d5db",
                                      backgroundColor: csvPreviewSelected.size === 0 ? "#f3f4f6" : "#ffffff",
                                      color: csvPreviewSelected.size === 0 ? "#9ca3af" : "#d72c0d",
                                      fontSize: "12px",
                                      cursor: csvPreviewSelected.size === 0 ? "not-allowed" : "pointer",
                                    }}
                                  >
                                    選択解除
                                  </button>
                                </div>
                              </div>
                              <div style={{ maxHeight: "280px", overflowY: "auto", border: "1px solid #e1e3e5", borderRadius: "8px", padding: "6px" }}>
                                {(csvShowOnlySelected ? csvPreviewRows.map((row, i) => ({ row, i })).filter(({ i }) => csvPreviewSelected.has(i)) : csvPreviewRows.map((row, i) => ({ row, i }))).map(({ row, i: realIndex }, listIndex) => {
                                  const isSelected = csvPreviewSelected.has(realIndex);
                                  return (
                                    <div
                                      key={`${realIndex}-${row.groupName}-${row.sku}`}
                                      role="button"
                                      tabIndex={0}
                                      onClick={() => {
                                        setCsvPreviewSelected((prev) => {
                                          const next = new Set(prev);
                                          if (next.has(realIndex)) next.delete(realIndex);
                                          else next.add(realIndex);
                                          return next;
                                        });
                                      }}
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter" || e.key === " ") {
                                          e.preventDefault();
                                          setCsvPreviewSelected((prev) => {
                                            const next = new Set(prev);
                                            if (next.has(realIndex)) next.delete(realIndex);
                                            else next.add(realIndex);
                                            return next;
                                          });
                                        }
                                      }}
                                      style={{
                                        padding: "10px 12px",
                                        borderRadius: "6px",
                                        cursor: "pointer",
                                        marginTop: listIndex === 0 ? 0 : "4px",
                                        backgroundColor: isSelected ? "#eff6ff" : "transparent",
                                        border: isSelected ? "1px solid #2563eb" : "1px solid transparent",
                                        display: "flex",
                                        alignItems: "center",
                                        gap: "8px",
                                      }}
                                    >
                                      <input
                                        type="checkbox"
                                        checked={isSelected}
                                        readOnly
                                        style={{ width: "16px", height: "16px", flexShrink: 0 }}
                                      />
                                      <div style={{ flex: "1 1 auto", minWidth: 0 }}>
                                        <span style={{ fontWeight: isSelected ? 600 : 500, display: "block" }}>{row.groupName}</span>
                                        <span style={{ fontSize: "12px", color: "#6d7175", display: "block" }}>SKU：{row.sku}</span>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                              <button
                                type="button"
                                onClick={handleCsvGroupAdd}
                                disabled={fetcher.state !== "idle" || csvPreviewSelected.size === 0}
                                style={{
                                  padding: "8px 16px",
                                  backgroundColor: fetcher.state !== "idle" || csvPreviewSelected.size === 0 ? "#d1d5db" : "#2563eb",
                                  color: "#ffffff",
                                  border: "none",
                                  borderRadius: "6px",
                                  fontSize: "14px",
                                  fontWeight: 600,
                                  cursor: fetcher.state !== "idle" || csvPreviewSelected.size === 0 ? "not-allowed" : "pointer",
                                  width: "100%",
                                }}
                              >
                                {fetcher.state !== "idle" ? "登録中..." : "グループを追加"}
                              </button>
                            </>
                          )}
                          <s-text color="subdued">
                            登録済みをCSVダウンロードで現在のグループ（SKU指定のみ）を取得できます。編集して「上書き」で再アップロードすると同じグループ名のSKUが置き換わります。
                          </s-text>
                          {fetcher.data && (fetcher.data as { ok?: boolean; imported?: number }).imported !== undefined && (fetcher.data as { ok?: boolean; imported?: number }).ok === true && (
                            <s-text tone="success">
                              {(fetcher.data as { imported: number }).imported}件のグループをインポートしました
                            </s-text>
                          )}
                          {fetcher.data && (fetcher.data as { ok?: boolean; error?: string }).error && (
                            <s-text tone="critical">
                              {(fetcher.data as { error: string }).error}
                            </s-text>
                          )}
                        </s-stack>
                      )}
                      </s-stack>
                    </div>
                  </s-stack>
                </div>

                {/* 右側: 登録済み商品グループリスト（白カードで囲む） */}
                <div style={{ flex: "1 1 400px", minWidth: 0, width: "100%" }}>
                  <div
                    style={{
                      background: "#ffffff",
                      borderRadius: 12,
                      boxShadow: "0 0 0 1px #e1e3e5",
                      padding: 16,
                    }}
                  >
                    <s-stack gap="base">
                      <s-stack direction="inline" gap="base" justifyContent="space-between">
                        <s-text type="strong">登録済み商品グループ</s-text>
                        {productGroups.length > 0 && (
                          <s-text color="subdued">
                            {productGroups.length}件のグループ
                          </s-text>
                        )}
                      </s-stack>
                      {productGroups.length === 0 ? (
                        <s-box padding="base" background="subdued">
                          <s-text color="subdued">商品グループが登録されていません</s-text>
                        </s-box>
                      ) : (
                        <s-stack gap="base">
                          {productGroups.map((g) => {
                            const collectionConfigsMap = new Map<string, CollectionConfig>();
                            if (g.collectionConfigs && g.collectionConfigs.length > 0) {
                              for (const config of g.collectionConfigs) {
                                collectionConfigsMap.set(config.collectionId, config);
                              }
                            }

                            let groupSelectedTotal = 0;
                            let groupTotalTotal = 0;
                            g.collectionIds.forEach((cid) => {
                              const cfg = collectionConfigsMap.get(cid);
                              const sel = cfg?.selectedVariantIds?.length ?? 0;
                              const tot = cfg?.totalVariantCount ?? 0;
                              groupSelectedTotal += sel;
                              groupTotalTotal += tot;
                            });
                            const skuCount = g.skus?.length ?? g.inventoryItemIds?.length ?? 0;
                            const isSkuOnly = (g.collectionIds?.length ?? 0) === 0 && skuCount > 0;

                            return (
                              <s-box key={g.id} padding="base" background="subdued">
                                <s-stack gap="base">
                                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
                                    <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
                                      <s-text type="strong">{g.name}</s-text>
                                      <s-text color="subdued">
                                        {isSkuOnly ? `SKU指定: ${skuCount}件` : `合計: 選択 ${groupSelectedTotal} / ${groupTotalTotal}`}
                                      </s-text>
                                    </div>
                                    <div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
                                      <s-button
                                       
                                        onClick={() => {
                                          setEditingGroupId(g.id);
                                          setGroupName(g.name);
                                          if (isSkuOnly) {
                                            setGroupCreateMethod("sku");
                                            setSelectedCollectionIds([]);
                                            setCollectionConfigs(new Map());
                                            setEditingSkuOnlyPreservedIds([]);
                                          } else {
                                            setGroupCreateMethod("collection");
                                            setSelectedCollectionIds(g.collectionIds || []);
                                            const configMap = new Map<string, CollectionConfig>();
                                            if (g.collectionConfigs && g.collectionConfigs.length > 0) {
                                              for (const config of g.collectionConfigs) {
                                                configMap.set(config.collectionId, config);
                                              }
                                            }
                                            setCollectionConfigs(configMap);
                                            setEditingSkuOnlyPreservedIds([]);
                                          }
                                        }}
                                      >
                                        編集
                                      </s-button>
                                      <s-button
                                       
                                        tone="critical"
                                        onClick={() => handleDeleteGroup(g.id)}
                                      >
                                        削除
                                      </s-button>
                                    </div>
                                  </div>
                                  {g.collectionIds.length > 0 ? (
                                    <div style={{ display: "flex", flexDirection: "column", gap: "6px", width: "100%" }}>
                                      {g.collectionIds.map((cid) => {
                                        const col = collectionDisplayMap[cid] ?? collections.find((c) => c.id === cid);
                                        const config = collectionConfigsMap.get(cid);
                                        const selectedCount = config?.selectedVariantIds?.length ?? 0;
                                        const totalCount = config?.totalVariantCount ?? 0;

                                        return (
                                          <div
                                            key={cid}
                                            onClick={() => handleOpenCollectionModal(cid, g.id)}
                                            style={{
                                              cursor: "pointer",
                                              border: "1px solid #e1e3e5",
                                              borderRadius: "8px",
                                              padding: "8px",
                                              backgroundColor: "#ffffff",
                                              transition: "all 0.2s",
                                              width: "100%",
                                              display: "flex",
                                              alignItems: "center",
                                              gap: "10px",
                                            }}
                                            onMouseEnter={(e) => {
                                              e.currentTarget.style.borderColor = "#2563eb";
                                              e.currentTarget.style.backgroundColor = "#f9fafb";
                                            }}
                                            onMouseLeave={(e) => {
                                              e.currentTarget.style.borderColor = "#e1e3e5";
                                              e.currentTarget.style.backgroundColor = "#ffffff";
                                            }}
                                          >
                                            <div style={{
                                              width: "40px",
                                              height: "40px",
                                              backgroundColor: "#f6f6f7",
                                              borderRadius: "4px",
                                              display: "flex",
                                              alignItems: "center",
                                              justifyContent: "center",
                                              overflow: "hidden",
                                              flexShrink: 0,
                                            }}>
                                              {col?.image?.url ? (
                                                <img
                                                  src={col.image.url}
                                                  alt={col.image.altText || col.title || cid}
                                                  style={{
                                                    width: "100%",
                                                    height: "100%",
                                                    objectFit: "cover",
                                                  }}
                                                />
                                              ) : (
                                                <div style={{
                                                  color: "#8c9196",
                                                  fontSize: "20px",
                                                  fontWeight: "bold",
                                                }}>
                                                  {col?.title?.charAt(0).toUpperCase() || "?"}
                                                </div>
                                              )}
                                            </div>
                                            <div style={{ flex: "1 1 auto", minWidth: 0 }}>
                                              <div style={{
                                                fontSize: "14px",
                                                fontWeight: "500",
                                                color: "#202223",
                                                marginBottom: "4px",
                                                overflow: "hidden",
                                                textOverflow: "ellipsis",
                                                whiteSpace: "nowrap",
                                              }}>
                                                {col?.title || cid}
                                              </div>
                                              <div style={{
                                                fontSize: "12px",
                                                color: "#6d7175",
                                              }}>
                                                {selectedCount} / {totalCount}
                                              </div>
                                            </div>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  ) : isSkuOnly ? (
                                    <div
                                      role="button"
                                      tabIndex={0}
                                      onClick={() => {
                                        setEditingGroupId(g.id);
                                        setGroupName(g.name);
                                        setGroupCreateMethod("sku");
                                        setSelectedCollectionIds([]);
                                        setCollectionConfigs(new Map());
                                        setEditingSkuOnlyPreservedIds([]);
                                      }}
                                      onKeyDown={(e: React.KeyboardEvent) => {
                                        if (e.key === "Enter" || e.key === " ") {
                                          e.preventDefault();
                                          (e.currentTarget as HTMLElement).click();
                                        }
                                      }}
                                      style={{
                                        cursor: "pointer",
                                        border: "1px solid #e1e3e5",
                                        borderRadius: "8px",
                                        padding: "10px 12px",
                                        backgroundColor: "#ffffff",
                                        transition: "all 0.2s",
                                        width: "100%",
                                      }}
                                      onMouseEnter={(e) => {
                                        e.currentTarget.style.borderColor = "#2563eb";
                                        e.currentTarget.style.backgroundColor = "#f9fafb";
                                      }}
                                      onMouseLeave={(e) => {
                                        e.currentTarget.style.borderColor = "#e1e3e5";
                                        e.currentTarget.style.backgroundColor = "#ffffff";
                                      }}
                                    >
                                      <s-text color="subdued">
                                        SKU一覧（{skuCount}件）を確認・編集
                                      </s-text>
                                      <s-text color="subdued">
                                        クリックで「商品検索」で一覧を表示
                                      </s-text>
                                    </div>
                                  ) : (
                                    <s-text color="subdued">コレクション: なし</s-text>
                                  )}
                                </s-stack>
                              </s-box>
                            );
                          })}
                        </s-stack>
                      )}
                    </s-stack>
                  </div>
                </div>
              </div>
            </s-box>
          )}

          {/* 棚卸ID発行（商品グループ設定タブと同じUI：白カード＋グループを追加と同じボタンスタイル） */}
          {activeTab === "create" && (
            <s-box padding="base">
              <div style={{ display: "flex", gap: "24px", alignItems: "flex-start", flexWrap: "wrap" }}>
                {/* 左側: タイトル＋説明 ＋ 発行フォーム（商品グループ設定と同じ白カード構成） */}
                <div style={{ flex: "1 1 320px", minWidth: 0 }}>
                  <s-stack gap="base">
                    {/* タイトル＋説明（商品グループ設定タブと同様） */}
                    <div>
                      <div
                        style={{
                          fontWeight: 600,
                          fontSize: 14,
                          marginBottom: 4,
                        }}
                      >
                        棚卸ID発行
                      </div>
                      <s-text color="subdued">
                        ロケーションと商品グループを選んで棚卸IDを発行します。発行後はPOS側で棚卸を行えます。
                      </s-text>
                    </div>

                    {/* 発行フォーム（商品グループ「グループを追加」と同じ白カード） */}
                    <div
                      style={{
                        background: "#ffffff",
                        borderRadius: 12,
                        boxShadow: "0 0 0 1px #e1e3e5",
                        padding: 16,
                      }}
                    >
                      <s-stack gap="base">
                        <s-text type="strong">棚卸ID発行</s-text>
                        <s-divider />
                        {/* Step 1: ロケーション選択 */}
                        <s-stack gap="base">
                          <s-text type="strong">1. ロケーション選択</s-text>
                          <s-text color="subdued">
                            棚卸を行うロケーションを1つ選びます。
                          </s-text>
                          <s-text-field
                            label="ロケーション検索"
                            value={createLocationSearchQuery}
                            onInput={(e: any) => setCreateLocationSearchQuery(readValue(e))}
                            onChange={(e: any) => setCreateLocationSearchQuery(readValue(e))}
                            placeholder="ロケーション名で検索..."
                          />
                          <div style={{ maxHeight: "220px", overflowY: "auto", border: "1px solid #e1e3e5", borderRadius: "8px", padding: "8px" }}>
                            {filteredLocations.length === 0 ? (
                              <s-text color="subdued">ロケーションが見つかりません</s-text>
                            ) : (
                              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                                {filteredLocations.map((loc) => {
                                  const isSelected = createLocationId === loc.id;
                                  return (
                                    <div
                                      key={loc.id}
                                      onClick={() => setCreateLocationId(isSelected ? "" : loc.id)}
                                      style={{
                                        cursor: "pointer",
                                        padding: "10px 12px",
                                        borderRadius: "8px",
                                        border: isSelected ? "2px solid #2563eb" : "1px solid #e1e3e5",
                                        backgroundColor: isSelected ? "#eff6ff" : "#ffffff",
                                      }}
                                    >
                                      <span style={{ fontWeight: isSelected ? 600 : 500 }}>{isSelected ? "✓ " : ""}{loc.name}</span>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                          {createLocationId && (
                            <s-text color="subdued">
                              選択中: {locations.find((l) => l.id === createLocationId)?.name || createLocationId}
                            </s-text>
                          )}
                        </s-stack>
                        <s-divider />

                        {/* Step 2: 商品グループ選択 */}
                        <s-stack gap="base">
                          <s-text type="strong">2. 商品グループ選択（複数可）</s-text>
                          <s-text color="subdued">
                            対象の商品グループを1つ以上選びます。
                          </s-text>
                          <div style={{ maxHeight: "240px", overflowY: "auto", border: "1px solid #e1e3e5", borderRadius: "8px", padding: "8px" }}>
                            {productGroups.length === 0 ? (
                              <s-text color="subdued">商品グループがありません。先に「商品グループ設定」で作成してください。</s-text>
                            ) : (
                              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                                {productGroups.map((g) => {
                                  const isSelected = createProductGroupIds.includes(g.id);
                                  const skuCount = g.skus?.length ?? g.inventoryItemIds?.length ?? 0;
                                  const isSkuOnly = (g.collectionIds?.length ?? 0) === 0 && skuCount > 0;
                                  const subLabel = isSkuOnly ? `SKU指定: ${skuCount}件` : `コレクション: ${g.collectionIds?.length ?? 0}件`;
                                  return (
                                    <div
                                      key={g.id}
                                      onClick={() => toggleProductGroup(g.id)}
                                      style={{
                                        cursor: "pointer",
                                        padding: "10px 12px",
                                        borderRadius: "8px",
                                        border: isSelected ? "2px solid #2563eb" : "1px solid #e1e3e5",
                                        backgroundColor: isSelected ? "#eff6ff" : "#ffffff",
                                        display: "flex",
                                        alignItems: "center",
                                        gap: "10px",
                                      }}
                                    >
                                      <input
                                        type="checkbox"
                                        checked={isSelected}
                                        onChange={() => toggleProductGroup(g.id)}
                                        onClick={(e) => e.stopPropagation()}
                                        style={{ width: "18px", height: "18px", flexShrink: 0 }}
                                      />
                                      <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{ fontWeight: isSelected ? 600 : 500 }}>{g.name}</div>
                                        <div style={{ fontSize: "12px", color: "#6d7175" }}>{subLabel}</div>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                          {createProductGroupIds.length > 0 && (
                            <s-text color="subdued">
                              選択中: {createProductGroupIds.length}グループ
                            </s-text>
                          )}
                        </s-stack>
                        <s-divider />

                        {/* グループを追加と同じボタンスタイル */}
                        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                          <button
                            type="button"
                            onClick={handleCreateCount}
                            disabled={fetcher.state !== "idle" || !createLocationId || createProductGroupIds.length === 0}
                            style={{
                              padding: "8px 16px",
                              backgroundColor: fetcher.state !== "idle" || !createLocationId || createProductGroupIds.length === 0 ? "#d1d5db" : "#2563eb",
                              color: "#ffffff",
                              border: "none",
                              borderRadius: "6px",
                              fontSize: "14px",
                              fontWeight: 600,
                              cursor: fetcher.state !== "idle" || !createLocationId || createProductGroupIds.length === 0 ? "not-allowed" : "pointer",
                              width: "100%",
                            }}
                          >
                            棚卸IDを発行
                          </button>
                          {/* 復旧完了のため棚卸ID修復ボタンは非表示（必要なら false を true に変更して再有効化） */}
                          {false && (
                            <>
                              <button
                                type="button"
                                onClick={() => fetcher.submit({ action: "repair_count_names", inventoryCountsVersion: String(inventoryCountsVersion) }, { method: "post" })}
                                disabled={fetcher.state !== "idle"}
                                style={{
                                  padding: "8px 16px",
                                  backgroundColor: fetcher.state !== "idle" ? "#e5e7eb" : "#f3f4f6",
                                  color: "#6b7280",
                                  border: "1px solid #e5e7eb",
                                  borderRadius: "6px",
                                  fontSize: "13px",
                                  cursor: fetcher.state !== "idle" ? "not-allowed" : "pointer",
                                  width: "100%",
                                }}
                              >
                                棚卸IDを修復
                              </button>
                              <s-text color="subdued" style={{ display: "block", marginTop: "-4px" }}>
                                表示が空白の棚卸IDに番号を再付与します。一覧に0件と出ていても、メタフィールドにデータがあれば修復できます。POS・履歴を再読み込みすると反映されます。
                              </s-text>
                            </>
                          )}
                        </div>
                        {false && fetcher.data?.ok && typeof (fetcher.data as { repaired?: number }).repaired === "number" && (
                          <s-box padding="base" background="subdued">
                            <s-text type="strong" tone="success">
                              棚卸IDを{(fetcher.data as { repaired: number }).repaired}件修復しました。
                            </s-text>
                            <s-text color="subdued" style={{ display: "block", marginTop: "4px" }}>
                              POS・履歴タブを再読み込みすると反映されます。
                            </s-text>
                          </s-box>
                        )}
                        {fetcher.data?.ok && (fetcher.data as { restored?: boolean }).restored === true && (
                          <s-box padding="base" background="subdued">
                            <s-text type="strong" tone="success">
                              棚卸を復元しました（指定のID・ロケーション・グループで現在在庫のまま完了確定）。
                            </s-text>
                          </s-box>
                        )}
                        {fetcher.data?.ok && (fetcher.data as { redistributed?: boolean }).redistributed === true && (
                          <s-box padding="base" background="subdued">
                            <s-text type="strong" tone="success">
                              グループ振り分けを修正しました。一覧を更新するにはページを再読み込みしてください。
                            </s-text>
                          </s-box>
                        )}
                        {fetcher.data?.ok && (fetcher.data as { groupsCompleted?: boolean }).groupsCompleted === true && (
                          <s-box padding="base" background="subdued">
                            <s-text type="strong" tone="success">
                              商品グループをすべて完了にしました（現在在庫で確定）。一覧を更新するにはページを再読み込みしてください。
                            </s-text>
                          </s-box>
                        )}
                        {fetcher.data?.ok && fetcher.data.inventoryCountId && (
                          <s-box padding="base" background="subdued">
                            <s-text type="strong" tone="success">
                              発行完了: {fetcher.data.countName ?? fetcher.data.inventoryCountId}
                            </s-text>
                            <s-text color="subdued" style={{ display: "block", marginTop: "4px" }}>
                              履歴タブで確認・CSV出力できます。
                            </s-text>
                            {fetcher.data.inventoryItemIdsOmittedDueToSize && (
                              <s-text color="subdued" style={{ display: "block", marginTop: "6px" }}>
                                商品数が多いため、POSではコレクションから商品を読み込みます。
                              </s-text>
                            )}
                          </s-box>
                        )}

                      </s-stack>
                    </div>
                  </s-stack>
                </div>

                  {/* 右側: 発行の流れ・直近一覧（白カードで囲む） */}
                  <div style={{ flex: "1 1 400px", minWidth: 0, width: "100%" }}>
                    <div
                      style={{
                        background: "#ffffff",
                        borderRadius: 12,
                        boxShadow: "0 0 0 1px #e1e3e5",
                        padding: 16,
                      }}
                    >
                    <s-stack gap="base">
                      <s-text type="strong">発行の流れ</s-text>
                      <s-box padding="base" background="subdued" style={{ borderRadius: "8px" }}>
                        <s-stack gap="base">
                          <div style={{ display: "flex", gap: "8px", alignItems: "flex-start" }}>
                            <span style={{ fontWeight: 700, color: "#2563eb", minWidth: "20px" }}>1</span>
                            <span>ロケーションと商品グループを選び「棚卸IDを発行」を押します。</span>
                          </div>
                          <div style={{ display: "flex", gap: "8px", alignItems: "flex-start" }}>
                            <span style={{ fontWeight: 700, color: "#2563eb", minWidth: "20px" }}>2</span>
                            <span>発行された棚卸IDがPOSに表示されます。</span>
                          </div>
                          <div style={{ display: "flex", gap: "8px", alignItems: "flex-start" }}>
                            <span style={{ fontWeight: 700, color: "#2563eb", minWidth: "20px" }}>3</span>
                            <span>POSで棚卸IDを選び、実数入力して完了させます。</span>
                          </div>
                        </s-stack>
                      </s-box>
                      <s-text type="strong">直近の発行</s-text>
                      {inventoryCounts.length === 0 ? (
                        <s-text color="subdued">まだ発行されていません。</s-text>
                      ) : (
                        <div style={{ maxHeight: "280px", overflowY: "auto", border: "1px solid #e1e3e5", borderRadius: "8px", padding: "8px" }}>
                          <s-stack gap="base">
                            {[...inventoryCounts]
                              .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
                              .slice(0, 10)
                              .map((c) => (
                              <div
                                key={c.id}
                                style={{
                                  padding: "10px",
                                  borderBottom: "1px solid #eee",
                                  fontSize: "13px",
                                }}
                              >
                                <div style={{ fontWeight: 600 }}>{c.countName ?? c.id}</div>
                                <div style={{ color: "#6d7175", fontSize: "12px", marginTop: "2px" }}>
                                  {locations.find((l) => l.id === c.locationId)?.name ?? c.locationId} · {getStatusLabel(getDisplayStatusForCount(c))} · {formatDateTimeInShopTimezone(c.createdAt, shopTimezone)}
                                </div>
                              </div>
                            ))}
                          </s-stack>
                          <s-text color="subdued" style={{ display: "block", marginTop: "8px" }}>
                            一覧は「履歴」タブで確認できます。
                          </s-text>
                        </div>
                      )}
                    </s-stack>
                    </div>
                  </div>
                </div>
              </s-box>
          )}

          {/* 履歴 */}
          {activeTab === "history" && (
            <s-box padding="base">
              <div style={{ display: "flex", gap: "24px", alignItems: "flex-start", flexWrap: "wrap" }}>
                {/* 左: タイトル＋説明 ＋ フィルター（白カード） */}
                <div style={{ flex: "1 1 260px", minWidth: 0 }}>
                  <s-stack gap="base">
                    <div>
                      <div
                        style={{
                          fontWeight: 600,
                          fontSize: 14,
                          marginBottom: 4,
                        }}
                      >
                        棚卸履歴
                      </div>
                      <s-text color="subdued">
                        条件で絞り込みを行い、棚卸履歴を表示します。
                      </s-text>
                    </div>

                    <div
                      style={{
                        background: "#ffffff",
                        borderRadius: 12,
                        boxShadow: "0 0 0 1px #e1e3e5",
                        padding: 16,
                      }}
                    >
                      <s-stack gap="base">
                        <s-text type="strong">フィルター</s-text>
                        <s-text color="subdued">
                          ロケーション・ステータスを選ぶと一覧が絞り込まれます。
                        </s-text>
                        <s-divider />
                        <s-text type="strong">ロケーション</s-text>
                        <div style={{ maxHeight: "200px", overflowY: "auto", border: "1px solid #e1e3e5", borderRadius: "8px", padding: "6px" }}>
                          <div
                            onClick={() => setLocationFilters(new Set())}
                            style={{
                              padding: "10px 12px",
                              borderRadius: "6px",
                              cursor: "pointer",
                              backgroundColor: locationFilters.size === 0 ? "#eff6ff" : "transparent",
                              border: locationFilters.size === 0 ? "1px solid #2563eb" : "1px solid transparent",
                              display: "flex",
                              alignItems: "center",
                              gap: "8px",
                            }}
                          >
                            <input type="checkbox" checked={locationFilters.size === 0} readOnly style={{ width: "16px", height: "16px", flexShrink: 0 }} />
                            <span style={{ fontWeight: locationFilters.size === 0 ? 600 : 500 }}>全て</span>
                          </div>
                          {locations.map((loc) => {
                            const isSelected = locationFilters.has(loc.id);
                            return (
                              <div
                                key={loc.id}
                                onClick={() => {
                                  const newFilters = new Set(locationFilters);
                                  if (isSelected) {
                                    newFilters.delete(loc.id);
                                  } else {
                                    newFilters.add(loc.id);
                                  }
                                  setLocationFilters(newFilters);
                                }}
                                style={{
                                  padding: "10px 12px",
                                  borderRadius: "6px",
                                  cursor: "pointer",
                                  backgroundColor: isSelected ? "#eff6ff" : "transparent",
                                  border: isSelected ? "1px solid #2563eb" : "1px solid transparent",
                                  marginTop: "4px",
                                  display: "flex",
                                  alignItems: "center",
                                  gap: "8px",
                                }}
                              >
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  readOnly
                                  style={{ width: "16px", height: "16px", flexShrink: 0 }}
                                />
                                <span style={{ fontWeight: isSelected ? 600 : 500, overflow: "hidden", textOverflow: "ellipsis" }}>{loc.name}</span>
                              </div>
                            );
                          })}
                        </div>
                        <s-text type="strong">ステータス</s-text>
                        <div style={{ maxHeight: "180px", overflowY: "auto", border: "1px solid #e1e3e5", borderRadius: "8px", padding: "6px" }}>
                          <div
                            onClick={() => setStatusFilters(new Set())}
                            style={{
                              padding: "10px 12px",
                              borderRadius: "6px",
                              cursor: "pointer",
                              backgroundColor: statusFilters.size === 0 ? "#eff6ff" : "transparent",
                              border: statusFilters.size === 0 ? "1px solid #2563eb" : "1px solid transparent",
                              display: "flex",
                              alignItems: "center",
                              gap: "8px",
                            }}
                          >
                            <input type="checkbox" checked={statusFilters.size === 0} readOnly style={{ width: "16px", height: "16px", flexShrink: 0 }} />
                            <span style={{ fontWeight: statusFilters.size === 0 ? 600 : 500 }}>全て</span>
                          </div>
                          {["draft", "in_progress", "completed", "cancelled"].map((s) => {
                            const isSelected = statusFilters.has(s);
                            return (
                              <div
                                key={s}
                                onClick={() => {
                                  const newFilters = new Set(statusFilters);
                                  if (isSelected) {
                                    newFilters.delete(s);
                                  } else {
                                    newFilters.add(s);
                                  }
                                  setStatusFilters(newFilters);
                                }}
                                style={{
                                  padding: "10px 12px",
                                  borderRadius: "6px",
                                  cursor: "pointer",
                                  backgroundColor: isSelected ? "#eff6ff" : "transparent",
                                  border: isSelected ? "1px solid #2563eb" : "1px solid transparent",
                                  marginTop: "4px",
                                  display: "flex",
                                  alignItems: "center",
                                  gap: "8px",
                                }}
                              >
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  readOnly
                                  style={{ width: "16px", height: "16px", flexShrink: 0 }}
                                />
                                <span style={{ fontWeight: isSelected ? 600 : 500 }}>{getStatusLabel(s)}</span>
                              </div>
                            );
                          })}
                        </div>
                      </s-stack>
                    </div>

                    {/* ソート: 棚卸ID 昇順 / 降順 */}
                    <div
                      style={{
                        background: "#ffffff",
                        borderRadius: 12,
                        boxShadow: "0 0 0 1px #e1e3e5",
                        padding: 16,
                      }}
                    >
                      <s-stack gap="base">
                        <s-text type="strong">ソート</s-text>
                        <s-text color="subdued">
                          棚卸IDの表示順を選びます。
                        </s-text>
                        <s-divider />
                        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                          <div
                            onClick={() => setCountNameSortOrder("desc")}
                            style={{
                              padding: "10px 12px",
                              borderRadius: "6px",
                              cursor: "pointer",
                              backgroundColor: countNameSortOrder === "desc" ? "#eff6ff" : "transparent",
                              border: countNameSortOrder === "desc" ? "1px solid #2563eb" : "1px solid #e1e3e5",
                              display: "flex",
                              alignItems: "center",
                              gap: "8px",
                            }}
                          >
                            <input type="radio" checked={countNameSortOrder === "desc"} readOnly style={{ width: "16px", height: "16px", flexShrink: 0 }} />
                            <span style={{ fontWeight: countNameSortOrder === "desc" ? 600 : 500 }}>棚卸ID 降順（新しい順）</span>
                          </div>
                          <div
                            onClick={() => setCountNameSortOrder("asc")}
                            style={{
                              padding: "10px 12px",
                              borderRadius: "6px",
                              cursor: "pointer",
                              backgroundColor: countNameSortOrder === "asc" ? "#eff6ff" : "transparent",
                              border: countNameSortOrder === "asc" ? "1px solid #2563eb" : "1px solid #e1e3e5",
                              display: "flex",
                              alignItems: "center",
                              gap: "8px",
                            }}
                          >
                            <input type="radio" checked={countNameSortOrder === "asc"} readOnly style={{ width: "16px", height: "16px", flexShrink: 0 }} />
                            <span style={{ fontWeight: countNameSortOrder === "asc" ? 600 : 500 }}>棚卸ID 昇順（古い順）</span>
                          </div>
                        </div>
                      </s-stack>
                    </div>
                  </s-stack>
                </div>

                {/* 右: 履歴一覧（白カード） */}
                <div style={{ flex: "1 1 400px", minWidth: 0, width: "100%" }}>
                  <div
                    style={{
                      background: "#ffffff",
                      borderRadius: 12,
                      boxShadow: "0 0 0 1px #e1e3e5",
                      padding: 16,
                    }}
                  >
                    <s-stack gap="base">
                      <s-text color="subdued">
                        表示: {filteredCounts.length}件 / {inventoryCounts.length}件
                      </s-text>
                      {filteredCounts.length === 0 ? (
                        <s-box padding="base">
                          <s-text color="subdued">履歴がありません</s-text>
                        </s-box>
                      ) : (
                        <s-stack gap="none">
                  {filteredCounts.map((c) => {
                    // ✅ バックグラウンドで取得したフルデータがあればそれを使用（N件 N/N を表示）
                    const displayCount = listCountDetails[c.id] ?? c;
                    const isDetailLoading = loadingListDetailIds.has(c.id);
                    const isSelected = selectedIds.has(c.id);
                    const locName = getLocationName(displayCount.locationId);
                    const statusLabel = getStatusLabel(getDisplayStatusForCount(displayCount));
                    const countName = displayCount.countName || displayCount.id;
                    const date = extractDateFromISO(displayCount.createdAt, shopTimezone);
                    // ✅ 複数商品グループがある場合はgroupItemsを優先、単一グループの場合はitemsフィールドを後方互換性として使用
                    const groupItemsMap = (displayCount as any)?.groupItems && typeof (displayCount as any).groupItems === "object" ? (displayCount as any).groupItems : {};
                    const hasMultipleGroups = Array.isArray(displayCount.productGroupIds) && displayCount.productGroupIds.length > 1;
                    const allGroupIds = Array.isArray(displayCount.productGroupIds) && displayCount.productGroupIds.length > 0
                      ? displayCount.productGroupIds
                      : displayCount.productGroupId ? [displayCount.productGroupId] : [];
                    
                    // ✅ 完了済みグループの商品を取得（getGroupItemsByKey で POS と同一の正規化キー照合）
                    const itemsFromGroup = allGroupIds.flatMap((id) => getGroupItemsByKey(groupItemsMap as Record<string, unknown[]>, String(id)));
                    
                    // ✅ 502根本対策：一覧では未完了グループの母数取得をしないため、未完了分の商品は一覧に含めない（母数は「-」表示）
                    const itemsFromIncompleteGroups: unknown[] = [];
                    const hasIncompleteGroup = allGroupIds.some((groupId) => getGroupItemsByKey(groupItemsMap as Record<string, unknown[]>, String(groupId)).length === 0);
                    
                    // ✅ 複数グループの場合、未完了グループの商品も含めるため、itemsフィールドから取得（後方互換性）
                    // ✅ itemsフィールドには全グループの商品が含まれている（確定処理で修正済み）
                    // ✅ ただし、groupItemsMapに含まれているグループの商品は重複を避けるため、itemsから除外
                    const completedGroupInventoryItemIds = new Set(itemsFromGroup.map((it: any) => it.inventoryItemId));
                    const incompleteGroupInventoryItemIds = new Set(itemsFromIncompleteGroups.map((it: any) => it.inventoryItemId));
                    const itemsFromItemsForIncomplete = hasMultipleGroups && Array.isArray(displayCount.items) && displayCount.items.length > 0
                      ? displayCount.items.filter((it: any) => !completedGroupInventoryItemIds.has(it.inventoryItemId) && !incompleteGroupInventoryItemIds.has(it.inventoryItemId))
                      : [];
                    
                    // ✅ 完了済みグループの商品 + 未完了分（一覧では未取得のため空）+ items 後方互換
                    // ✅ 単一グループの場合でも、未完了グループの商品リストを含める
                    const allGroupItems = hasMultipleGroups
                      ? [...itemsFromGroup, ...itemsFromIncompleteGroups, ...itemsFromItemsForIncomplete]
                      : (itemsFromGroup.length > 0 
                          ? itemsFromGroup 
                          : (itemsFromIncompleteGroups.length > 0 
                              ? itemsFromIncompleteGroups 
                              : (Array.isArray(displayCount.items) && displayCount.items.length > 0 ? displayCount.items : [])));
                    
                    const itemCount = allGroupItems.length;
                    const totalQty = allGroupItems.reduce((s: number, it: any) => s + (it.actualQuantity || 0), 0);
                    const currentQty = allGroupItems.reduce((s: number, it: any) => s + (it.currentQuantity || 0), 0);
                    // ✅ 合計数（在庫数）の表示：currentQtyが0より大きい場合は表示、そうでない場合は"-"を表示
                    // ✅ 進捗状況のグループ別表示と同じロジック（1997行目参照）
                    const isCompleted = displayCount.status === "completed";

                    const groupNames = Array.isArray(displayCount.productGroupNames) && displayCount.productGroupNames.length > 0
                      ? displayCount.productGroupNames.join(", ")
                      : Array.isArray(displayCount.productGroupIds) && displayCount.productGroupIds.length > 0
                      ? displayCount.productGroupIds.join(", ")
                      : displayCount.productGroupName || displayCount.productGroupId || "-";

                    return (
                      <div key={c.id}>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "flex-start",
                            padding: "12px",
                            cursor: "pointer",
                          }}
                          onClick={() => {
                            // ✅ バックグラウンド取得済みのフルデータまたは最新のinventoryCountsから該当のデータを取得
                            const withDetail = listCountDetails[c.id] ?? inventoryCounts.find((ic) => ic.id === c.id) ?? c;
                            const countToShow = withDetail;
                            if (!countToShow.countName && c.countName) {
                              (countToShow as any).countName = c.countName;
                            }
                            setModalCount(countToShow);
                            setModalOpen(true);
                          }}
                        >
                          {/* チェックボックスは非表示（仕様は残す） */}
                          {/* <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={(e) => {
                              e.stopPropagation();
                              const newSelected = new Set(selectedIds);
                              if (e.target.checked) {
                                newSelected.add(c.id);
                              } else {
                                newSelected.delete(c.id);
                              }
                              setSelectedIds(newSelected);
                            }}
                            onClick={(e) => e.stopPropagation()}
                            style={{
                              width: "18px",
                              height: "18px",
                              cursor: "pointer",
                              marginRight: "12px",
                              marginTop: "2px",
                            }}
                          /> */}
                          <div style={{ flex: "1 1 auto", minWidth: 0 }}>
                            <div
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                                marginBottom: "4px",
                              }}
                            >
                              <s-text
                                type="strong"
                                style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                              >
                                {countName}
                              </s-text>
                              <s-text color="subdued" style={{ whiteSpace: "nowrap", marginLeft: "8px" }}>
                                {date}
                              </s-text>
                            </div>
                            <div style={{ marginBottom: "2px" }}>
                              <s-text
                                color="subdued"
                               
                                style={{
                                  whiteSpace: "nowrap",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  display: "block",
                                }}
                              >
                                ロケーション: {locName || "—"}
                              </s-text>
                            </div>
                            <div>
                              <s-text
                                color="subdued"
                               
                                style={{
                                  whiteSpace: "nowrap",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  display: "block",
                                }}
                              >
                                商品グループ: {(groupNames && groupNames !== "-") ? groupNames : "—"}
                              </s-text>
                            </div>
                            <div
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                                marginTop: "4px",
                              }}
                            >
                              <s-text color="subdued" style={{ whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: "4px" }}>
                                <span style={getStatusBadgeStyle(getDisplayStatusForCount(displayCount))}>{statusLabel}</span>
                              </s-text>
                              <s-text color="subdued" style={{ whiteSpace: "nowrap" }}>
                                {isDetailLoading ? "…" : `${itemCount}件・実数${totalQty}${hasIncompleteGroup ? "/-" : currentQty > 0 ? `/${currentQty}` : "/-"}`}
                              </s-text>
                            </div>
                          </div>
                        </div>
                        <s-divider />
                      </div>
                    );
                  })}
                </s-stack>
              )}
                    </s-stack>
                  </div>
                </div>
              </div>
            </s-box>
          )}

          {fetcher.data?.error && (
            <s-box padding="base" background="critical-subdued">
              <s-text tone="critical">{fetcher.data.error}</s-text>
            </s-box>
          )}

          {/* 商品リストモーダル（入出庫履歴と同じ形式） */}
          {modalOpen && modalCount && (
            <div
              style={{
                position: "fixed",
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                backgroundColor: "rgba(0, 0, 0, 0.5)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                zIndex: 1000,
              }}
              onClick={() => {
                setModalOpen(false);
                setModalCount(null);
                setRestoreCountName("");
                setRestoreLocationId("");
                setRestoreProductGroupIds([]);
              }}
            >
              <div
                style={{
                  backgroundColor: "white",
                  borderRadius: "8px",
                  padding: "24px",
                  maxWidth: "90%",
                  maxHeight: "90%",
                  overflow: "auto",
                  boxShadow: "0 4px 6px rgba(0, 0, 0, 0.1)",
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <div style={{ marginBottom: "16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <h2 style={{ margin: 0, fontSize: "20px", fontWeight: "bold" }}>
                    商品リスト
                  </h2>
                  <button
                    onClick={() => {
                      setModalOpen(false);
                      setModalCount(null);
                      setRestoreCountName("");
                      setRestoreLocationId("");
                      setRestoreProductGroupIds([]);
                    }}
                    style={{
                      background: "none",
                      border: "none",
                      fontSize: "24px",
                      cursor: "pointer",
                      padding: "0",
                      width: "32px",
                      height: "32px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    ×
                  </button>
                </div>

                {fetcher.data && !(fetcher.data as { ok?: boolean }).ok && (fetcher.data as { error?: string }).error && (
                  <div style={{ marginBottom: "16px", padding: "12px", backgroundColor: "#fef2f2", border: "1px solid #ef4444", borderRadius: "6px", fontSize: "13px", color: "#b91c1c" }}>
                    <strong>処理に失敗しました。</strong> {(fetcher.data as { error?: string }).error}
                  </div>
                )}

                {modalCount && (
                  <>
                  {/* 復元時に1グループにまとめて保存されてしまった棚卸：グループ振り分けを修正するボタン */}
                  {Array.isArray(modalCount.productGroupIds) && modalCount.productGroupIds.length > 1 &&
                    Object.keys((modalCount as any)?.groupItems || {}).length === 1 && (
                    <div style={{ marginBottom: "16px", padding: "12px", backgroundColor: "#f0fdf4", border: "1px solid #22c55e", borderRadius: "6px", fontSize: "13px" }}>
                      <div style={{ fontWeight: 600, marginBottom: "6px", color: "#166534" }}>グループ振り分けの修正</div>
                      <p style={{ margin: "0 0 10px 0", color: "#15803d" }}>
                        この棚卸は復元時に全商品が1つのグループにまとめて保存されています。商品グループごとに振り分けを修正すると、アプリ・管理画面で各グループが正しく「完了」で表示され、数量も正しくなります。
                      </p>
                      <button
                        type="button"
                        disabled={fetcher.state !== "idle"}
                        onClick={() => {
                          const fd = new FormData();
                          fd.set("action", "redistribute_count_group_items");
                          fd.set("inventoryCountsVersion", String(inventoryCountsVersion));
                          fd.set("countId", String(modalCount.id));
                          fetcher.submit(fd, { method: "post" });
                        }}
                        style={{
                          padding: "8px 16px",
                          backgroundColor: fetcher.state !== "idle" ? "#bbf7d0" : "#22c55e",
                          color: "white",
                          border: "none",
                          borderRadius: "6px",
                          cursor: fetcher.state !== "idle" ? "not-allowed" : "pointer",
                          fontSize: "13px",
                          fontWeight: 600,
                        }}
                      >
                        {fetcher.state !== "idle" ? "処理中..." : "グループ振り分けを修正"}
                      </button>
                    </div>
                  )}
                  {/* 復旧完了のため非表示（必要なら false を true に変更して再有効化） */}
                  {false && modalCount.status === "completed" &&
                    Array.isArray(modalCount.productGroupIds) && modalCount.productGroupIds.length > 0 && (
                    <div style={{ marginBottom: "16px", padding: "12px", backgroundColor: "#eff6ff", border: "1px solid #3b82f6", borderRadius: "6px", fontSize: "13px" }}>
                      <div style={{ fontWeight: 600, marginBottom: "6px", color: "#1e40af" }}>商品グループをすべて完了にする</div>
                      <p style={{ margin: "0 0 10px 0", color: "#1d4ed8" }}>
                        この棚卸はIDは完了ですが、商品グループが未完了表示になっている場合があります。現在の在庫数で各グループを「完了」として保存し直すと、アプリ・管理画面でグループごとに正しく完了で表示されます（在庫調整は行いません）。
                      </p>
                      <button
                        type="button"
                        disabled={fetcher.state !== "idle"}
                        onClick={() => {
                          const fd = new FormData();
                          fd.set("action", "ensure_count_groups_completed");
                          fd.set("inventoryCountsVersion", String(inventoryCountsVersion));
                          fd.set("countId", String(modalCount.id));
                          fetcher.submit(fd, { method: "post" });
                        }}
                        style={{
                          padding: "8px 16px",
                          backgroundColor: fetcher.state !== "idle" ? "#bfdbfe" : "#3b82f6",
                          color: "white",
                          border: "none",
                          borderRadius: "6px",
                          cursor: fetcher.state !== "idle" ? "not-allowed" : "pointer",
                          fontSize: "13px",
                          fontWeight: 600,
                        }}
                      >
                        {fetcher.state !== "idle" ? "処理中..." : "商品グループをすべて完了にする"}
                      </button>
                    </div>
                  )}
                  {((): boolean => {
                    const hasMeta = (modalCount.locationId && String(modalCount.locationId).trim() !== "") ||
                      (Array.isArray(modalCount.productGroupIds) && modalCount.productGroupIds.length > 0) ||
                      (modalCount.productGroupId && String(modalCount.productGroupId).trim() !== "");
                    const hasProductData = ((modalCount as any)?.groupItems && typeof (modalCount as any).groupItems === "object" && Object.keys((modalCount as any).groupItems || {}).length > 0) ||
                      (Array.isArray(modalCount.items) && modalCount.items.length > 0);
                    return !hasMeta && hasProductData;
                  })() && (
                    <>
                      <div style={{ marginBottom: "12px", padding: "10px 12px", backgroundColor: "#fff4e5", border: "1px solid #ff9800", borderRadius: "6px", fontSize: "13px", color: "#e65100" }}>
                        <strong>情報の一部が欠損しています。</strong> ロケーション・商品グループ・ステータス・作成日時は、過去の不具合でメタフィールドから失われています。棚卸IDと商品リストのみ表示しています。編集・確定は行わず、参照用としてご利用ください。
                      </div>
                      <div style={{ marginBottom: "16px", padding: "12px", backgroundColor: "#f0f9ff", border: "1px solid #0ea5e9", borderRadius: "6px", fontSize: "13px" }}>
                        <div style={{ fontWeight: 600, marginBottom: "8px", color: "#0369a1" }}>元の棚卸IDで復元し、現在在庫で完了確定する</div>
                        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                          <label style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                            <span style={{ minWidth: "120px" }}>復元する棚卸ID:</span>
                            <input
                              type="text"
                              value={restoreCountName}
                              onChange={(e) => setRestoreCountName(e.target.value)}
                              placeholder="#C0017"
                              style={{ padding: "6px 10px", border: "1px solid #e1e3e5", borderRadius: "4px", width: "140px" }}
                            />
                          </label>
                          <label style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                            <span style={{ minWidth: "120px" }}>ロケーション:</span>
                            <select
                              value={restoreLocationId}
                              onChange={(e) => setRestoreLocationId(e.target.value)}
                              style={{ padding: "6px 10px", border: "1px solid #e1e3e5", borderRadius: "4px", minWidth: "200px" }}
                            >
                              <option value="">選択してください</option>
                              {locations.map((loc) => (
                                <option key={loc.id} value={loc.id}>{loc.name}</option>
                              ))}
                            </select>
                          </label>
                          <div style={{ display: "flex", alignItems: "flex-start", gap: "8px", flexWrap: "wrap" }}>
                            <span style={{ minWidth: "120px", paddingTop: "6px" }}>商品グループ:</span>
                            <div style={{ display: "flex", flexDirection: "column", gap: "4px", maxHeight: "120px", overflowY: "auto", border: "1px solid #e1e3e5", borderRadius: "4px", padding: "6px", minWidth: "200px" }}>
                              {productGroups.length === 0 ? (
                                <span style={{ color: "#6d7175", fontSize: "12px" }}>商品グループがありません</span>
                              ) : (
                                productGroups.map((g) => (
                                  <label key={g.id} style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
                                    <input
                                      type="checkbox"
                                      checked={restoreProductGroupIds.includes(g.id)}
                                      onChange={(e) => {
                                        if (e.target.checked) setRestoreProductGroupIds((prev) => [...prev, g.id]);
                                        else setRestoreProductGroupIds((prev) => prev.filter((id) => id !== g.id));
                                      }}
                                    />
                                    <span>{g.name || g.id}</span>
                                  </label>
                                ))
                              )}
                            </div>
                          </div>
                          <div style={{ marginTop: "4px" }}>
                            <button
                              type="button"
                              disabled={fetcher.state !== "idle" || !restoreCountName.trim() || !restoreLocationId || restoreProductGroupIds.length === 0}
                              onClick={() => {
                                const fd = new FormData();
                                fd.set("action", "restore_count_as_completed");
                                fd.set("inventoryCountsVersion", String(inventoryCountsVersion));
                                fd.set("countId", String(modalCount.id));
                                fd.set("countName", restoreCountName.trim());
                                fd.set("locationId", restoreLocationId);
                                fd.set("productGroupIds", JSON.stringify(restoreProductGroupIds));
                                fetcher.submit(fd, { method: "post" });
                              }}
                              style={{
                                padding: "8px 16px",
                                backgroundColor: "#0ea5e9",
                                color: "white",
                                border: "none",
                                borderRadius: "6px",
                                cursor: fetcher.state !== "idle" ? "not-allowed" : "pointer",
                                fontSize: "13px",
                              }}
                            >
                              {fetcher.state !== "idle" ? "処理中..." : "復元して完了確定"}
                            </button>
                          </div>
                        </div>
                      </div>
                    </>
                  )}
                  <div style={{ marginBottom: "16px", padding: "12px", backgroundColor: "#f5f5f5", borderRadius: "4px" }}>
                    <div style={{ fontSize: "14px", marginBottom: "4px" }}>
                      <strong>棚卸ID:</strong> {modalCount.countName || modalCount.id}
                    </div>
                    <div style={{ fontSize: "14px", marginBottom: "4px" }}>
                      <strong>ロケーション:</strong> {getLocationName(modalCount.locationId) || "—"}
                    </div>
                    <div style={{ fontSize: "14px", marginBottom: "4px" }}>
                      <strong>商品グループ:</strong> {
                        (() => {
                          const ids = Array.isArray(modalCount.productGroupIds) && modalCount.productGroupIds.length > 0
                            ? modalCount.productGroupIds
                            : modalCount.productGroupId ? [modalCount.productGroupId] : [];
                          if (ids.length === 0) return (modalCount.productGroupName || modalCount.productGroupId || "—") as string;
                          if (Array.isArray(modalCount.productGroupNames) && modalCount.productGroupNames.length > 0)
                            return modalCount.productGroupNames.map((n, i) => n || getGroupDisplayName(ids[i])).join(", ");
                          return ids.map((id) => getGroupDisplayName(id)).join(", ");
                        })()
                      }
                    </div>
                    <div style={{ fontSize: "14px", marginBottom: "4px" }}>
                      <strong>ステータス:</strong>{" "}
                      <span style={getStatusBadgeStyle(getDisplayStatusForCount(modalCount))}>{getStatusLabel(getDisplayStatusForCount(modalCount))}</span>
                    </div>
                    <div style={{ fontSize: "14px", marginBottom: "4px" }}>
                      <strong>作成日時:</strong> {modalCount.createdAt ? extractDateFromISO(modalCount.createdAt, shopTimezone) : "—"}
                    </div>
                    {modalCount.completedAt && (
                      <div style={{ fontSize: "14px", marginBottom: "4px" }}>
                        <strong>完了日時:</strong> {extractDateFromISO(modalCount.completedAt, shopTimezone)}
                      </div>
                    )}
                    {(() => {
                      // ✅ 商品グループがある場合：各グループの進捗状況を表示（情報欄の最下部・入出庫と同様）
                      const allGroupIds = Array.isArray(modalCount.productGroupIds) && modalCount.productGroupIds.length > 0
                        ? modalCount.productGroupIds
                        : modalCount.productGroupId ? [modalCount.productGroupId] : [];
                      const groupItemsMap = (modalCount as any)?.groupItems && typeof (modalCount as any).groupItems === "object" ? (modalCount as any).groupItems : {};
                      
                      if (allGroupIds.length > 0) {
                        const cancelledSetForProgress = new Set(
                          (Array.isArray((modalCount as any)?.cancelledGroupIds) ? (modalCount as any).cancelledGroupIds : []).map((id: string) => normalizeIdForMatch(id))
                        );
                        // ✅ 後方互換性：groupItemsがない場合、itemsフィールドから該当グループの商品をフィルタリング
                        const countItemsLegacy = Array.isArray(modalCount.items) ? modalCount.items : [];
                        const progressInfo = allGroupIds.map((groupId) => {
                          const isCancelled = cancelledSetForProgress.has(normalizeIdForMatch(groupId));
                          let groupItems = getGroupItemsByKey(groupItemsMap as Record<string, unknown[]>, String(groupId));
                          // ✅ 後方互換性：groupItemsがない場合、itemsフィールドから該当グループの商品をフィルタリング
                          if (groupItems.length === 0 && countItemsLegacy.length > 0) {
                            // ✅ 商品グループのinventoryItemIdsを取得（保存されている場合）
                            const productGroup = productGroups.find((g) => g.id === groupId);
                            const groupInventoryItemIds = productGroup?.inventoryItemIds || [];
                            
                            if (groupInventoryItemIds.length > 0) {
                              // ✅ inventoryItemIdsが保存されている場合、それを使ってフィルタリング
                              const groupInventoryItemIdsSet = new Set(groupInventoryItemIds);
                              groupItems = countItemsLegacy.filter((item) => {
                                const itemId = String(item?.inventoryItemId || "").trim();
                                return groupInventoryItemIdsSet.has(itemId);
                              });
                            } else if (allGroupIds.length === 1) {
                              // ✅ 単一グループの場合、itemsフィールドのデータをそのまま使用（後方互換性）
                              groupItems = countItemsLegacy;
                            }
                            // ✅ 複数グループでinventoryItemIdsが保存されていない場合は、groupItemsが空のまま（完了と判定しない）
                          }
                          // ✅ 未完了グループの商品リストを取得（キー正規化で先頭グループの照合漏れを防ぐ）
                          const incompleteProducts = getIncompleteProductsForGroup(groupId);
                          // ✅ 完了判定：groupItems[groupId]が存在し、かつ配列の長さが0より大きい場合に完了と判定
                          const isCompleted = groupItems.length > 0;
                          // ✅ 完了済みの場合はgroupItemsを使用、未完了の場合はincompleteProductsを使用
                          const displayItems = isCompleted ? groupItems : incompleteProducts;
                          
                          const groupName = Array.isArray(modalCount.productGroupNames) && modalCount.productGroupNames.length > 0
                            ? modalCount.productGroupNames[allGroupIds.indexOf(groupId)] || getGroupDisplayName(groupId)
                            : getGroupDisplayName(groupId);
                          // ✅ グループごとの進捗数を計算
                          const groupTotalQty = displayItems.reduce((sum, it) => sum + (Number(it?.currentQuantity || 0)), 0);
                          const groupActualQty = displayItems.reduce((sum, it) => sum + (Number(it?.actualQuantity || 0)), 0);
                          return { groupId, groupName, isCompleted, isCancelled, totalQty: groupTotalQty, actualQty: groupActualQty };
                        });
                        const extraCount = allGroupIds.reduce((sum, id) => {
                          const arr = getGroupItemsByKey(groupItemsMap as Record<string, unknown[]>, String(id));
                          return sum + arr.filter((it: any) => it?.isExtra).length;
                        }, 0);
                        
                        return (
                          <div style={{ fontSize: "14px" }}>
                            <strong>進捗状況:</strong>
                            <div style={{ marginTop: "4px", marginLeft: "16px" }}>
                              {progressInfo.map((info) => (
                                <div key={info.groupId} style={{ fontSize: "13px", color: info.isCancelled ? "#666" : info.isCompleted ? "#28a745" : "#ffc107" }}>
                                  {info.groupName}: {info.isCancelled ? "キャンセル済み" : info.isCompleted ? "完了済み" : "未完了"}
                                  {info.totalQty > 0 || info.actualQty > 0 ? (
                                    <span style={{ marginLeft: "8px", color: "#666" }}>
                                      （{info.actualQty}/{info.totalQty > 0 ? info.totalQty : "-"}）
                                    </span>
                                  ) : null}
                                </div>
                              ))}
                              {extraCount > 0 && (
                                <div style={{ fontSize: "13px", color: "#666" }}>
                                  予定外: {extraCount}件
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      }
                      return null;
                    })()}
                  </div>
                  </>
                )}

                {(() => {
                  // ✅ 複数商品グループがある場合：groupItemsから各グループのデータを取得
                  const allGroupIds = Array.isArray(modalCount.productGroupIds) && modalCount.productGroupIds.length > 0
                    ? modalCount.productGroupIds
                    : modalCount.productGroupId ? [modalCount.productGroupId] : [];
                  const groupItemsMap = (modalCount as any)?.groupItems && typeof (modalCount as any).groupItems === "object" ? (modalCount as any).groupItems : {};
                  const hasMultipleGroups = allGroupIds.length > 1;
                  const cancelledGroupIdsSet = new Set(
                    (Array.isArray((modalCount as any)?.cancelledGroupIds) ? (modalCount as any).cancelledGroupIds : []).map((id: string) => normalizeIdForMatch(id))
                  );
                  // ✅ 商品グループごとのデータを取得
                  // ✅ CSV出力と同じロジックを使用
                  const itemsByGroup = new Map<string, typeof modalCount.items>();
                  // ✅ 完了済みグループを追跡するためのMap（groupId -> true/false）
                  // ✅ このMapはitemsByGroupの構築時と完了判定時の両方で使用される
                  const completedGroupsMap = new Map<string, boolean>();
                  const countItemsLegacy = Array.isArray(modalCount.items) && modalCount.items.length > 0 ? modalCount.items : [];
                  if (hasMultipleGroups) {
                    // ✅ 複数グループの場合：CSV出力と同じロジック
                    for (const groupId of allGroupIds) {
                      // ✅ groupItemsMapからデータを取得（getGroupItemsByKey で POS と同一の正規化キー照合）
                      let groupItems = getGroupItemsByKey(groupItemsMap as Record<string, unknown[]>, String(groupId));
                      // ✅ 後方互換性：groupItemsがない場合、itemsフィールドから該当グループの商品をフィルタリング
                      if (groupItems.length === 0 && countItemsLegacy.length > 0) {
                        // ✅ 商品グループのinventoryItemIdsを取得（保存されている場合）
                        const productGroup = productGroups.find((g) => g.id === groupId);
                        const groupInventoryItemIds = productGroup?.inventoryItemIds || [];
                        
                        if (groupInventoryItemIds.length > 0) {
                          // ✅ inventoryItemIdsが保存されている場合、それを使ってフィルタリング
                          const groupInventoryItemIdsSet = new Set(groupInventoryItemIds);
                          groupItems = countItemsLegacy.filter((item) => {
                            const itemId = String(item?.inventoryItemId || "").trim();
                            return groupInventoryItemIdsSet.has(itemId);
                          });
                        }
                      }
                      const isGroupCompleted = groupItems.length > 0;
                      // ✅ 完了済みグループを追跡
                      completedGroupsMap.set(groupId, isGroupCompleted);
                      if (isGroupCompleted) {
                        // ✅ 完了済みの場合はgroupItemsを使用（予定外商品を最後にソート）
                        const normalItemsForGroup = groupItems.filter((it) => !(it as any).isExtra);
                        const extraItemsForGroup = groupItems.filter((it) => !!(it as any).isExtra);
                        const sortedGroupItems = [...normalItemsForGroup, ...extraItemsForGroup];
                        itemsByGroup.set(groupId, sortedGroupItems);
                      } else {
                        // ✅ 未完了グループの商品リストを取得（キー正規化で先頭グループの照合漏れを防ぐ）
                        const incompleteProducts = getIncompleteProductsForGroup(groupId);
                        itemsByGroup.set(groupId, incompleteProducts);
                      }
                    }
                  } else {
                    // ✅ 単一グループの場合：後方互換性の処理（getGroupItemsByKey で POS と同一の正規化キー照合）
                    const groupId = allGroupIds[0];
                    let groupItems = getGroupItemsByKey(groupItemsMap as Record<string, unknown[]>, String(groupId));
                    if (groupItems.length === 0) {
                      const countItemsLegacy = Array.isArray(modalCount.items) ? modalCount.items : [];
                      if (countItemsLegacy.length > 0) {
                        groupItems = countItemsLegacy;
                      }
                    }
                    const isGroupCompleted = groupItems.length > 0;
                    // ✅ 完了済みグループを追跡
                    completedGroupsMap.set(groupId, isGroupCompleted);
                    if (isGroupCompleted) {
                      // ✅ 予定外商品を最後にソート
                      const normalItemsForGroup = groupItems.filter((it) => !(it as any).isExtra);
                      const extraItemsForGroup = groupItems.filter((it) => !!(it as any).isExtra);
                      const sortedGroupItems = [...normalItemsForGroup, ...extraItemsForGroup];
                      itemsByGroup.set(groupId, sortedGroupItems);
                    } else {
                      const incompleteProducts = getIncompleteProductsForGroup(groupId);
                      itemsByGroup.set(groupId, incompleteProducts);
                    }
                  }
                  
                  // ✅ 表示用のデータを準備（完了済みと未完了の両方を含む）
                  // ✅ CSV出力と同じロジック（ただし、単一グループの場合でもitemsByGroupから取得）
                  const displayItems = itemsByGroup.size > 0
                    ? Array.from(itemsByGroup.values()).flat()
                    : (Array.isArray(modalCount.items) && modalCount.items.length > 0 ? modalCount.items : []);
                  
                  // ✅ 合計の在庫数と実数を計算（未完了グループも含む）
                  const totalCurrentQty = displayItems.reduce((sum, it) => sum + (Number(it?.currentQuantity || 0)), 0);
                  const totalActualQty = displayItems.reduce((sum, it) => sum + (Number(it?.actualQuantity || 0)), 0);
                  // ✅ list 由来の棚卸（groupItems/items なし）では商品は get_incomplete_group_products で取得。読込中は「読込中」表示
                  const hasGroupItemsData = (modalCount as any)?.groupItems && typeof (modalCount as any).groupItems === "object" && Object.keys((modalCount as any).groupItems).length > 0;
                  const hasItemsData = Array.isArray(modalCount.items) && modalCount.items.length > 0;
                  const isListOnlyCount = !hasGroupItemsData && !hasItemsData;
                  const isLoadingModalProducts = incompleteGroupProductsFetcher.state !== "idle" || (isListOnlyCount && allGroupIds.length > 0 && loadingIncompleteGroupIds.size > 0);
                  if (displayItems.length === 0) {
                    return (
                      <div style={{ padding: "24px", textAlign: "center" }}>
                        {isLoadingModalProducts ? (
                          <div>商品リストを読込中...</div>
                        ) : (
                          <div>商品明細がありません</div>
                        )}
                      </div>
                    );
                  }
                  
                  return (
                    <div>
                      <div style={{ marginBottom: "12px", fontSize: "14px", color: "#666" }}>
                        合計: {displayItems.length}件
                        {totalCurrentQty > 0 || totalActualQty > 0 ? (
                          <span style={{ marginLeft: "8px" }}>
                            （実数: {totalActualQty} / 在庫数: {totalCurrentQty > 0 ? totalCurrentQty : "-"}）
                          </span>
                        ) : null}
                        {hasMultipleGroups && allGroupIds.length > 0 && (
                          <div style={{ marginTop: "4px", fontSize: "12px" }}>
                            商品グループごとの進捗: {Array.from(completedGroupsMap.values()).filter(Boolean).length}/{allGroupIds.length}グループ完了
                          </div>
                        )}
                      </div>
                      <div style={{ maxHeight: "400px", overflowY: "auto" }}>
                        {hasMultipleGroups && itemsByGroup.size > 0 ? (
                          // ✅ 複数商品グループがある場合：グループごとにセクションを分けて表示
                          <div>
                            {allGroupIds.map((groupId) => {
                              // ✅ itemsByGroupから既に取得したデータを使用（完了済み・未完了の両方を含む）
                              const groupItems = itemsByGroup.get(groupId) || [];
                              
                              // ✅ 完了判定：getGroupItemsByKey で POS と同一の正規化キー照合
                              const groupItemsFromMap = getGroupItemsByKey(groupItemsMap as Record<string, unknown[]>, String(groupId));
                              // ✅ 完了判定：
                              // 1. groupItemsFromMapにデータがある場合（groupItemsが保存されている場合）→ 必ず完了済み（incompleteProductsForGroupの値は無視）
                              // 2. または、itemsByGroupの構築時に完了済みとして設定された場合（completedGroupsMapで追跡）
                              // ✅ 重要：groupItemsFromMapにデータがある場合、またはitemsByGroupの構築時に完了済みとして設定された場合は、incompleteProductsForGroupの値に関係なく完了済みと判定
                              const incompleteProductsForGroup = getIncompleteProductsForGroup(groupId);
                              const hasGroupItemsFromMap = groupItemsFromMap.length > 0;
                              const hasGroupItems = groupItems.length > 0;
                              // ✅ itemsByGroupの構築時に完了済みとして設定されたかどうかを確認
                              const wasCompletedInItemsByGroup = completedGroupsMap.get(groupId) === true;
                              // ✅ groupItemsFromMapにデータがある場合、またはitemsByGroupの構築時に完了済みとして設定された場合は、必ず完了済み（incompleteProductsForGroupの値は無視）
                              // ✅ それ以外（groupItems.length === 0 または incompleteProductsForGroup.length > 0）は未完了
                              const isGroupCompleted = hasGroupItemsFromMap 
                                ? true 
                                : (wasCompletedInItemsByGroup ? true : (hasGroupItems && incompleteProductsForGroup.length === 0));
                              const isGroupCancelled = cancelledGroupIdsSet.has(normalizeIdForMatch(groupId));
                              const groupName = Array.isArray(modalCount.productGroupNames) && modalCount.productGroupNames.length > 0
                                ? modalCount.productGroupNames[allGroupIds.indexOf(groupId)] || getGroupDisplayName(groupId)
                                : getGroupDisplayName(groupId);
                              
                              // ✅ グループ内は通常商品のみ表示（予定外は別ブロックで表示・入出庫と同様）
                              const normalItems = groupItems.filter((it) => !(it as any).isExtra);
                              const groupTotalQty = normalItems.reduce((sum, it) => sum + (Number(it?.currentQuantity || 0)), 0);
                              const groupActualQty = normalItems.reduce((sum, it) => sum + (Number(modalEditMode ? (modalEditedQuantities[groupId]?.[it.inventoryItemId] ?? it?.actualQuantity) : it?.actualQuantity) ?? 0), 0);
                              
                              return (
                                <div key={groupId} style={{ marginBottom: "24px", padding: "12px", backgroundColor: isGroupCancelled ? "#f5f5f5" : isGroupCompleted ? "#f0f8f0" : "#fff8f0", borderRadius: "4px" }}>
                                  <div style={{ marginBottom: "8px", fontSize: "14px", fontWeight: "bold", color: isGroupCancelled ? "#666" : isGroupCompleted ? "#28a745" : "#ffc107" }}>
                                    {groupName} {isGroupCancelled ? "（キャンセル済み）" : isGroupCompleted ? "（完了済み）" : "（未完了）"}
                                    {normalItems.length > 0 && (
                                      <span style={{ fontSize: "12px", fontWeight: "normal", marginLeft: "8px", color: "#666" }}>
                                        （{groupActualQty}/{groupTotalQty > 0 ? groupTotalQty : "-"}）
                                      </span>
                                    )}
                                  </div>
                                  {normalItems.length > 0 ? (
                                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px", backgroundColor: "transparent" }}>
                                      <thead>
                                        <tr style={{ backgroundColor: "#f5f5f5", borderBottom: "2px solid #ddd" }}>
                                          <th style={{ padding: "8px", textAlign: "left", borderRight: "1px solid #ddd" }}>商品グループ</th>
                                          <th style={{ padding: "8px", textAlign: "left", borderRight: "1px solid #ddd" }}>商品名</th>
                                          <th style={{ padding: "8px", textAlign: "left", borderRight: "1px solid #ddd" }}>SKU</th>
                                          <th style={{ padding: "8px", textAlign: "left", borderRight: "1px solid #ddd" }}>JAN</th>
                                          <th style={{ padding: "8px", textAlign: "left", borderRight: "1px solid #ddd" }}>オプション1</th>
                                          <th style={{ padding: "8px", textAlign: "left", borderRight: "1px solid #ddd" }}>オプション2</th>
                                          <th style={{ padding: "8px", textAlign: "left", borderRight: "1px solid #ddd" }}>オプション3</th>
                                          <th style={{ padding: "8px", textAlign: "right", borderRight: "1px solid #ddd" }}>在庫</th>
                                          <th style={{ padding: "8px", textAlign: "right", borderRight: "1px solid #ddd" }}>実数</th>
                                          <th style={{ padding: "8px", textAlign: "right" }}>差分</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {normalItems.map((it, idx) => {
                                          const parsed = parseTitleToProductAndOptions(String(it.title || "").trim(), it as any);
                                          const productName = parsed.productName || it.sku || "（商品名なし）";
                                          const { option1, option2, option3 } = parsed;
                                          const sku = String(it.sku || "").trim();
                                          const jan = String((it as any).barcode || "").trim();
                                          const cellStyle: React.CSSProperties = { padding: "8px", borderRight: "1px solid #eee" };
                                          return (
                                            <tr key={`${groupId}-${it.inventoryItemId}-${idx}`} style={{ borderBottom: "1px solid #eee" }}>
                                              <td style={{ ...cellStyle, fontWeight: "bold", color: isGroupCancelled ? "#666" : isGroupCompleted ? "#28a745" : "#ffc107" }}>
                                                {groupName}
                                                <div style={{ fontSize: "11px", color: "#666", marginTop: "2px" }}>
                                                  {isGroupCancelled ? "キャンセル" : isGroupCompleted ? "✓ 完了" : "未完了"}
                                                </div>
                                              </td>
                                              <td style={cellStyle}>{productName}</td>
                                              <td style={cellStyle}>{sku || "-"}</td>
                                              <td style={cellStyle}>{jan || "-"}</td>
                                              <td style={cellStyle}>{option1 || "-"}</td>
                                              <td style={cellStyle}>{option2 || "-"}</td>
                                              <td style={cellStyle}>{option3 || "-"}</td>
                                              <td style={{ ...cellStyle, textAlign: "right" }}>{it.currentQuantity ?? "-"}</td>
                                              <td style={{ ...cellStyle, textAlign: "right" }}>
                                                {modalEditMode && !isGroupCompleted && !isGroupCancelled ? (
                                                  <input
                                                    type="number"
                                                    value={modalEditedQuantities[groupId]?.[it.inventoryItemId] ?? it.actualQuantity ?? ""}
                                                    onChange={(e) => {
                                                      const v = e.target.value === "" ? 0 : parseInt(e.target.value, 10);
                                                      if (!Number.isFinite(v)) return;
                                                      setModalEditedQuantities((prev) => ({
                                                        ...prev,
                                                        [groupId]: { ...(prev[groupId] ?? {}), [it.inventoryItemId]: v },
                                                      }));
                                                    }}
                                                    style={{ width: "64px", padding: "4px" }}
                                                  />
                                                ) : (
                                                  it.actualQuantity ?? "-"
                                                )}
                                              </td>
                                              <td style={{ ...cellStyle, textAlign: "right", borderRight: "none" }}>
                                                {modalEditMode && !isGroupCompleted && !isGroupCancelled
                                                  ? (Number(modalEditedQuantities[groupId]?.[it.inventoryItemId] ?? it.actualQuantity) ?? 0) - Number(it.currentQuantity ?? 0)
                                                  : it.delta ?? "-"}
                                              </td>
                                            </tr>
                                          );
                                        })}
                                      </tbody>
                                    </table>
                                  ) : (
                                    <div style={{ padding: "8px", fontSize: "14px", color: "#666" }}>
                                      {loadingIncompleteGroupIds.has(String(groupId))
                                        ? "読み込み中..."
                                        : "この商品グループはまだ処理されていません"}
                                    </div>
                                  )}
                                  {!isGroupCompleted && !isGroupCancelled && (modalCount?.status !== "completed" && modalCount?.status !== "cancelled") && (
                                    <div style={{ marginTop: "8px", display: "flex", gap: "8px", flexWrap: "wrap" }}>
                                      <button
                                        type="button"
                                        disabled={historyActionFetcher.state !== "idle" || normalItems.length === 0}
                                        onClick={() => {
                                          if (!confirm("このグループを確定しますか？在庫数が実数に更新されます。")) return;
                                          const items = normalItems.map((it: any) => ({
                                            inventoryItemId: it.inventoryItemId,
                                            currentQuantity: Number(it?.currentQuantity ?? 0),
                                            actualQuantity: Number(modalEditedQuantities[groupId]?.[it.inventoryItemId] ?? it?.actualQuantity ?? 0),
                                            variantId: it.variantId,
                                            sku: it.sku,
                                            title: it.title,
                                          }));
                                          const fd = new FormData();
                                          fd.set("action", "confirm_stocktake_group");
                                          fd.set("inventoryCountsVersion", String(inventoryCountsVersion));
                                          fd.set("countId", modalCount.id);
                                          fd.set("groupId", groupId);
                                          fd.set("items", JSON.stringify(items));
                                          historyActionFetcher.submit(fd, { method: "post" });
                                        }}
                                        style={{ padding: "6px 12px", fontSize: "13px", borderRadius: "6px", border: "1px solid #2e7d32", background: "#2e7d32", color: "#fff", cursor: historyActionFetcher.state === "idle" && !loadingIncompleteGroupIds.has(String(groupId)) && incompleteGroupProductsFetcher.state === "idle" ? "pointer" : "not-allowed" }}
                                      >
                                        このグループを確定
                                      </button>
                                      <button
                                        type="button"
                                        disabled={historyActionFetcher.state !== "idle"}
                                        onClick={() => {
                                          if (!confirm("このグループをキャンセルしますか？在庫は変更されません。")) return;
                                          const fd = new FormData();
                                          fd.set("action", "cancel_stocktake_group");
                                          fd.set("inventoryCountsVersion", String(inventoryCountsVersion));
                                          fd.set("countId", modalCount.id);
                                          fd.set("groupId", groupId);
                                          historyActionFetcher.submit(fd, { method: "post" });
                                        }}
                                        style={{ padding: "6px 12px", fontSize: "13px", borderRadius: "6px", border: "1px solid #6d7175", background: "#fff", color: "#202223", cursor: historyActionFetcher.state === "idle" ? "pointer" : "not-allowed" }}
                                      >
                                        このグループをキャンセル
                                      </button>
                                    </div>
                                  )}
                                  {isGroupCompleted && (modalCount?.status !== "completed" && modalCount?.status !== "cancelled") && (
                                    <div style={{ marginTop: "8px" }}>
                                      <button
                                        type="button"
                                        disabled={historyActionFetcher.state !== "idle"}
                                        onClick={() => {
                                          if (!confirm("このグループの確定を取り消し、在庫を元に戻します。よろしいですか？")) return;
                                          const fd = new FormData();
                                          fd.set("action", "reset_stocktake_group");
                                          fd.set("inventoryCountsVersion", String(inventoryCountsVersion));
                                          fd.set("countId", modalCount.id);
                                          fd.set("groupId", groupId);
                                          historyActionFetcher.submit(fd, { method: "post" });
                                        }}
                                        style={{ padding: "6px 12px", fontSize: "13px", borderRadius: "6px", border: "1px solid #d72c0d", background: "#fff", color: "#d72c0d", cursor: historyActionFetcher.state === "idle" ? "pointer" : "not-allowed" }}
                                      >
                                        リセット
                                      </button>
                                    </div>
                                  )}
                                  {!isGroupCompleted && !isGroupCancelled && getIncompleteGroupHasMore(groupId) && (
                                    <div style={{ marginTop: "8px" }}>
                                      <button
                                        type="button"
                                        onClick={() => handleLoadMoreIncompleteGroup(groupId)}
                                        disabled={incompleteGroupProductsFetcher.state !== "idle" || loadingMoreIncompleteGroupId === groupId}
                                        style={{
                                          padding: "8px 16px",
                                          fontSize: "14px",
                                          backgroundColor: "#f0f0f0",
                                          border: "1px solid #ccc",
                                          borderRadius: "6px",
                                          cursor: incompleteGroupProductsFetcher.state === "idle" && loadingMoreIncompleteGroupId !== groupId ? "pointer" : "not-allowed",
                                        }}
                                      >
                                        {loadingMoreIncompleteGroupId === groupId ? "読込中..." : "さらに読み込む"}
                                      </button>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                            {(() => {
                              // ✅ 予定外を別ブロックで表示（入出庫の「予定外入庫」ブロックと同様）
                              const extraItemsAll = displayItems.filter((it) => !!(it as any).isExtra);
                              if (extraItemsAll.length === 0) return null;
                              const cellStyle: React.CSSProperties = { padding: "8px", borderRight: "1px solid #eee" };
                              return (
                                <div key="extras" style={{ marginBottom: "24px", padding: "12px", backgroundColor: "#fff5f5", borderRadius: "4px" }}>
                                  <div style={{ marginBottom: "8px", fontSize: "14px", fontWeight: "bold", color: "#666" }}>
                                    予定外（{extraItemsAll.length}件）
                                  </div>
                                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px", backgroundColor: "transparent" }}>
                                    <thead>
                                      <tr style={{ backgroundColor: "#f5f5f5", borderBottom: "2px solid #ddd" }}>
                                        <th style={{ padding: "8px", textAlign: "left", borderRight: "1px solid #ddd" }}>商品名</th>
                                        <th style={{ padding: "8px", textAlign: "left", borderRight: "1px solid #ddd" }}>SKU</th>
                                        <th style={{ padding: "8px", textAlign: "left", borderRight: "1px solid #ddd" }}>JAN</th>
                                        <th style={{ padding: "8px", textAlign: "left", borderRight: "1px solid #ddd" }}>オプション1</th>
                                        <th style={{ padding: "8px", textAlign: "left", borderRight: "1px solid #ddd" }}>オプション2</th>
                                        <th style={{ padding: "8px", textAlign: "left", borderRight: "1px solid #ddd" }}>オプション3</th>
                                        <th style={{ padding: "8px", textAlign: "right", borderRight: "1px solid #ddd" }}>在庫</th>
                                        <th style={{ padding: "8px", textAlign: "right", borderRight: "1px solid #ddd" }}>実数</th>
                                        <th style={{ padding: "8px", textAlign: "right" }}>差分</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {extraItemsAll.map((it, idx) => {
                                        const parsed = parseTitleToProductAndOptions(String(it.title || "").trim(), it as any);
                                        const productName = parsed.productName || it.sku || "（商品名なし）";
                                        const { option1, option2, option3 } = parsed;
                                        const sku = String(it.sku || "").trim();
                                        const jan = String((it as any).barcode || "").trim();
                                        return (
                                          <tr key={`extra-${idx}`} style={{ borderBottom: "1px solid #eee", backgroundColor: "#ffe6e6" }}>
                                            <td style={cellStyle}>{productName}</td>
                                            <td style={cellStyle}>{sku || "-"}</td>
                                            <td style={cellStyle}>{jan || "-"}</td>
                                            <td style={cellStyle}>{option1 || "-"}</td>
                                            <td style={cellStyle}>{option2 || "-"}</td>
                                            <td style={cellStyle}>{option3 || "-"}</td>
                                            <td style={{ ...cellStyle, textAlign: "right" }}>{it.currentQuantity ?? "-"}</td>
                                            <td style={{ ...cellStyle, textAlign: "right" }}>{it.actualQuantity ?? "-"}</td>
                                            <td style={{ ...cellStyle, textAlign: "right", borderRight: "none" }}>{it.delta ?? "-"}</td>
                                          </tr>
                                        );
                                      })}
                                    </tbody>
                                  </table>
                                </div>
                              );
                            })()}
                          </div>
                        ) : (
                          // ✅ 単一商品グループ：通常のみブロック＋予定外は別ブロック（入出庫と同様）
                          (() => {
                            const singleGroupId = allGroupIds.length > 0 ? allGroupIds[0] : "";
                            const singleGroupItems = singleGroupId ? (itemsByGroup.get(singleGroupId) || []) : displayItems;
                            const normalItems = singleGroupItems.filter((it) => !(it as any).isExtra);
                            const extraItems = singleGroupItems.filter((it) => !!(it as any).isExtra);
                            const groupItemsFromMapSingle = singleGroupId ? getGroupItemsByKey(groupItemsMap as Record<string, unknown[]>, String(singleGroupId)) : [];
                            const isGroupCompleted = groupItemsFromMapSingle.length > 0;
                            const isGroupCancelledSingle = singleGroupId ? cancelledGroupIdsSet.has(normalizeIdForMatch(singleGroupId)) : false;
                            const groupName = Array.isArray(modalCount.productGroupNames) && modalCount.productGroupNames.length > 0
                              ? modalCount.productGroupNames[0]
                              : singleGroupId
                              ? getGroupDisplayName(singleGroupId)
                              : (modalCount.productGroupName || modalCount.productGroupId || "-");
                            const groupTotalQty = normalItems.reduce((sum, it) => sum + (Number((it as any)?.currentQuantity || 0)), 0);
                            const groupActualQty = normalItems.reduce((sum, it) => sum + (Number(modalEditMode ? (modalEditedQuantities[singleGroupId]?.[it.inventoryItemId] ?? (it as any)?.actualQuantity) : (it as any)?.actualQuantity) ?? 0), 0);
                            const cellStyle: React.CSSProperties = { padding: "8px", borderRight: "1px solid #eee" };
                            return (
                              <>
                                <div style={{ marginBottom: "24px", padding: "12px", backgroundColor: isGroupCancelledSingle ? "#f5f5f5" : isGroupCompleted ? "#f0f8f0" : "#fff8f0", borderRadius: "4px" }}>
                                  <div style={{ marginBottom: "8px", fontSize: "14px", fontWeight: "bold", color: isGroupCancelledSingle ? "#666" : isGroupCompleted ? "#28a745" : "#ffc107" }}>
                                    {groupName} {isGroupCancelledSingle ? "（キャンセル済み）" : isGroupCompleted ? "（完了済み）" : "（未完了）"}
                                    {normalItems.length > 0 && (
                                      <span style={{ fontSize: "12px", fontWeight: "normal", marginLeft: "8px", color: "#666" }}>
                                        （{groupActualQty}/{groupTotalQty > 0 ? groupTotalQty : "-"}）
                                      </span>
                                    )}
                                  </div>
                                  {normalItems.length > 0 ? (
                                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px", backgroundColor: "transparent" }}>
                                      <thead>
                                        <tr style={{ backgroundColor: "#f5f5f5", borderBottom: "2px solid #ddd" }}>
                                          <th style={{ padding: "8px", textAlign: "left", borderRight: "1px solid #ddd" }}>商品グループ</th>
                                          <th style={{ padding: "8px", textAlign: "left", borderRight: "1px solid #ddd" }}>商品名</th>
                                          <th style={{ padding: "8px", textAlign: "left", borderRight: "1px solid #ddd" }}>SKU</th>
                                          <th style={{ padding: "8px", textAlign: "left", borderRight: "1px solid #ddd" }}>JAN</th>
                                          <th style={{ padding: "8px", textAlign: "left", borderRight: "1px solid #ddd" }}>オプション1</th>
                                          <th style={{ padding: "8px", textAlign: "left", borderRight: "1px solid #ddd" }}>オプション2</th>
                                          <th style={{ padding: "8px", textAlign: "left", borderRight: "1px solid #ddd" }}>オプション3</th>
                                          <th style={{ padding: "8px", textAlign: "right", borderRight: "1px solid #ddd" }}>在庫</th>
                                          <th style={{ padding: "8px", textAlign: "right", borderRight: "1px solid #ddd" }}>実数</th>
                                          <th style={{ padding: "8px", textAlign: "right" }}>差分</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {normalItems.map((it, idx) => {
                                          const titleRaw = String(it.title || "").trim();
                                          const parts = titleRaw.split("/").map((s) => s.trim()).filter(Boolean);
                                          const productName = parts[0] || titleRaw || it.sku || "（商品名なし）";
                                          const optionParts = parts.length >= 2 ? parts.slice(1) : [];
                                          const option1 = optionParts[0] || "";
                                          const option2 = optionParts[1] || "";
                                          const option3 = optionParts[2] || "";
                                          const sku = String(it.sku || "").trim();
                                          const jan = String((it as any).barcode || "").trim();
                                          return (
                                            <tr key={idx} style={{ borderBottom: "1px solid #eee" }}>
                                              <td style={{ ...cellStyle, fontWeight: "bold" }}>{groupName}</td>
                                              <td style={cellStyle}>{productName}</td>
                                              <td style={cellStyle}>{sku || "-"}</td>
                                              <td style={cellStyle}>{jan || "-"}</td>
                                              <td style={cellStyle}>{option1 || "-"}</td>
                                              <td style={cellStyle}>{option2 || "-"}</td>
                                              <td style={cellStyle}>{option3 || "-"}</td>
                                              <td style={{ ...cellStyle, textAlign: "right" }}>{it.currentQuantity ?? "-"}</td>
                                              <td style={{ ...cellStyle, textAlign: "right" }}>
                                                {modalEditMode && !isGroupCompleted && !isGroupCancelledSingle ? (
                                                  <input
                                                    type="number"
                                                    value={modalEditedQuantities[singleGroupId]?.[it.inventoryItemId] ?? it.actualQuantity ?? ""}
                                                    onChange={(e) => {
                                                      const v = e.target.value === "" ? 0 : parseInt(e.target.value, 10);
                                                      if (!Number.isFinite(v)) return;
                                                      setModalEditedQuantities((prev) => ({
                                                        ...prev,
                                                        [singleGroupId]: { ...(prev[singleGroupId] ?? {}), [it.inventoryItemId]: v },
                                                      }));
                                                    }}
                                                    style={{ width: "64px", padding: "4px" }}
                                                  />
                                                ) : (
                                                  it.actualQuantity ?? "-"
                                                )}
                                              </td>
                                              <td style={{ ...cellStyle, textAlign: "right" }}>
                                                {modalEditMode && !isGroupCompleted && !isGroupCancelledSingle
                                                  ? (Number(modalEditedQuantities[singleGroupId]?.[it.inventoryItemId] ?? it.actualQuantity) ?? 0) - Number(it.currentQuantity ?? 0)
                                                  : it.delta ?? "-"}
                                              </td>
                                            </tr>
                                          );
                                        })}
                                      </tbody>
                                    </table>
                                  ) : (
                                    <div style={{ padding: "8px", fontSize: "14px", color: "#666" }}>
                                      {loadingIncompleteGroupIds.has(String(singleGroupId))
                                        ? "読み込み中..."
                                        : "この商品グループはまだ処理されていません"}
                                    </div>
                                  )}
                                  {!isGroupCompleted && !isGroupCancelledSingle && singleGroupId && (modalCount?.status !== "completed" && modalCount?.status !== "cancelled") && (
                                    <div style={{ marginTop: "8px", display: "flex", gap: "8px", flexWrap: "wrap" }}>
                                      <button
                                        type="button"
                                        disabled={historyActionFetcher.state !== "idle" || normalItems.length === 0 || loadingIncompleteGroupIds.has(String(singleGroupId)) || incompleteGroupProductsFetcher.state !== "idle"}
                                        onClick={() => {
                                          if (!confirm("このグループを確定しますか？在庫数が実数に更新されます。")) return;
                                          const items = normalItems.map((it: any) => ({
                                            inventoryItemId: it.inventoryItemId,
                                            currentQuantity: Number(it?.currentQuantity ?? 0),
                                            actualQuantity: Number(modalEditedQuantities[singleGroupId]?.[it.inventoryItemId] ?? it?.actualQuantity ?? 0),
                                            variantId: it.variantId,
                                            sku: it.sku,
                                            title: it.title,
                                          }));
                                          const fd = new FormData();
                                          fd.set("action", "confirm_stocktake_group");
                                          fd.set("inventoryCountsVersion", String(inventoryCountsVersion));
                                          fd.set("countId", modalCount.id);
                                          fd.set("groupId", singleGroupId);
                                          fd.set("items", JSON.stringify(items));
                                          historyActionFetcher.submit(fd, { method: "post" });
                                        }}
                                        style={{ padding: "6px 12px", fontSize: "13px", borderRadius: "6px", border: "1px solid #2e7d32", background: "#2e7d32", color: "#fff", cursor: historyActionFetcher.state === "idle" && !loadingIncompleteGroupIds.has(String(singleGroupId)) && incompleteGroupProductsFetcher.state === "idle" ? "pointer" : "not-allowed" }}
                                      >
                                        このグループを確定
                                      </button>
                                      <button
                                        type="button"
                                        disabled={historyActionFetcher.state !== "idle"}
                                        onClick={() => {
                                          if (!confirm("このグループをキャンセルしますか？在庫は変更されません。")) return;
                                          const fd = new FormData();
                                          fd.set("action", "cancel_stocktake_group");
                                          fd.set("inventoryCountsVersion", String(inventoryCountsVersion));
                                          fd.set("countId", modalCount.id);
                                          fd.set("groupId", singleGroupId);
                                          historyActionFetcher.submit(fd, { method: "post" });
                                        }}
                                        style={{ padding: "6px 12px", fontSize: "13px", borderRadius: "6px", border: "1px solid #6d7175", background: "#fff", color: "#202223", cursor: historyActionFetcher.state === "idle" ? "pointer" : "not-allowed" }}
                                      >
                                        このグループをキャンセル
                                      </button>
                                    </div>
                                  )}
                                  {isGroupCompleted && singleGroupId && (modalCount?.status !== "completed" && modalCount?.status !== "cancelled") && (
                                    <div style={{ marginTop: "8px" }}>
                                      <button
                                        type="button"
                                        disabled={historyActionFetcher.state !== "idle"}
                                        onClick={() => {
                                          if (!confirm("このグループの確定を取り消し、在庫を元に戻します。よろしいですか？")) return;
                                          const fd = new FormData();
                                          fd.set("action", "reset_stocktake_group");
                                          fd.set("inventoryCountsVersion", String(inventoryCountsVersion));
                                          fd.set("countId", modalCount.id);
                                          fd.set("groupId", singleGroupId);
                                          historyActionFetcher.submit(fd, { method: "post" });
                                        }}
                                        style={{ padding: "6px 12px", fontSize: "13px", borderRadius: "6px", border: "1px solid #d72c0d", background: "#fff", color: "#d72c0d", cursor: historyActionFetcher.state === "idle" ? "pointer" : "not-allowed" }}
                                      >
                                        リセット
                                      </button>
                                    </div>
                                  )}
                                  {!isGroupCompleted && !isGroupCancelledSingle && singleGroupId && getIncompleteGroupHasMore(singleGroupId) && (
                                    <div style={{ marginTop: "8px" }}>
                                      <button
                                        type="button"
                                        onClick={() => handleLoadMoreIncompleteGroup(singleGroupId)}
                                        disabled={incompleteGroupProductsFetcher.state !== "idle" || loadingMoreIncompleteGroupId === singleGroupId}
                                        style={{
                                          padding: "8px 16px",
                                          fontSize: "14px",
                                          backgroundColor: "#f0f0f0",
                                          border: "1px solid #ccc",
                                          borderRadius: "6px",
                                          cursor: incompleteGroupProductsFetcher.state === "idle" && loadingMoreIncompleteGroupId !== singleGroupId ? "pointer" : "not-allowed",
                                        }}
                                      >
                                        {loadingMoreIncompleteGroupId === singleGroupId ? "読込中..." : "さらに読み込む"}
                                      </button>
                                    </div>
                                  )}
                                </div>
                                {extraItems.length > 0 && (
                                  <div style={{ marginBottom: "24px", padding: "12px", backgroundColor: "#fff5f5", borderRadius: "4px" }}>
                                    <div style={{ marginBottom: "8px", fontSize: "14px", fontWeight: "bold", color: "#666" }}>
                                      予定外（{extraItems.length}件）
                                    </div>
                                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px", backgroundColor: "transparent" }}>
                                      <thead>
                                        <tr style={{ backgroundColor: "#f5f5f5", borderBottom: "2px solid #ddd" }}>
                                          <th style={{ padding: "8px", textAlign: "left", borderRight: "1px solid #ddd" }}>商品名</th>
                                          <th style={{ padding: "8px", textAlign: "left", borderRight: "1px solid #ddd" }}>SKU</th>
                                          <th style={{ padding: "8px", textAlign: "left", borderRight: "1px solid #ddd" }}>JAN</th>
                                          <th style={{ padding: "8px", textAlign: "left", borderRight: "1px solid #ddd" }}>オプション1</th>
                                          <th style={{ padding: "8px", textAlign: "left", borderRight: "1px solid #ddd" }}>オプション2</th>
                                          <th style={{ padding: "8px", textAlign: "left", borderRight: "1px solid #ddd" }}>オプション3</th>
                                          <th style={{ padding: "8px", textAlign: "right", borderRight: "1px solid #ddd" }}>在庫</th>
                                          <th style={{ padding: "8px", textAlign: "right", borderRight: "1px solid #ddd" }}>実数</th>
                                          <th style={{ padding: "8px", textAlign: "right" }}>差分</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {extraItems.map((it, idx) => {
                                          const parsed = parseTitleToProductAndOptions(String(it.title || "").trim(), it as any);
                                          const productName = parsed.productName || it.sku || "（商品名なし）";
                                          const { option1, option2, option3 } = parsed;
                                          const sku = String(it.sku || "").trim();
                                          const jan = String((it as any).barcode || "").trim();
                                          return (
                                            <tr key={idx} style={{ borderBottom: "1px solid #eee", backgroundColor: "#ffe6e6" }}>
                                              <td style={cellStyle}>{productName}</td>
                                              <td style={cellStyle}>{sku || "-"}</td>
                                              <td style={cellStyle}>{jan || "-"}</td>
                                              <td style={cellStyle}>{option1 || "-"}</td>
                                              <td style={cellStyle}>{option2 || "-"}</td>
                                              <td style={cellStyle}>{option3 || "-"}</td>
                                              <td style={{ ...cellStyle, textAlign: "right" }}>{it.currentQuantity ?? "-"}</td>
                                              <td style={{ ...cellStyle, textAlign: "right" }}>{it.actualQuantity ?? "-"}</td>
                                              <td style={{ ...cellStyle, textAlign: "right" }}>{it.delta ?? "-"}</td>
                                            </tr>
                                          );
                                        })}
                                      </tbody>
                                    </table>
                                  </div>
                                )}
                              </>
                            );
                          })()
                        )}
                      </div>
                    </div>
                  );
                })()}

                <div style={{ marginTop: "24px", display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: "12px", alignItems: "center" }}>
                  {(() => {
                    const isCountFullyCompleted = modalCount?.status === "completed" || modalCount?.status === "cancelled";
                    return !modalEditMode ? (
                    <button
                      type="button"
                      disabled={isCountFullyCompleted}
                      onClick={() => setModalEditMode(true)}
                      style={{
                        padding: "8px 16px",
                        fontSize: "14px",
                        borderRadius: "6px",
                        border: "1px solid #2e7d32",
                        background: isCountFullyCompleted ? "#f0f0f0" : "#fff",
                        color: isCountFullyCompleted ? "#999" : "#2e7d32",
                        cursor: isCountFullyCompleted ? "not-allowed" : "pointer",
                      }}
                    >
                      編集
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        disabled={historyActionFetcher.state !== "idle"}
                        onClick={() => {
                          const allGroupIds = Array.isArray(modalCount.productGroupIds) && modalCount.productGroupIds.length > 0 ? modalCount.productGroupIds : modalCount.productGroupId ? [modalCount.productGroupId] : [];
                          const groupItemsMap = (modalCount as any)?.groupItems && typeof (modalCount as any).groupItems === "object" ? (modalCount as any).groupItems : {};
                          const groups: Record<string, Array<{ inventoryItemId: string; actualQuantity: number; currentQuantity?: number; variantId?: string; sku?: string; title?: string }>> = {};
                          for (const groupId of allGroupIds) {
                            const existing = getGroupItemsByKey(groupItemsMap as Record<string, unknown[]>, groupId);
                            const items = existing.length > 0 ? existing : getIncompleteProductsForGroup(groupId);
                            if (items.length === 0) continue;
                            groups[groupId] = items.map((it: any) => ({
                              inventoryItemId: it.inventoryItemId,
                              actualQuantity: Number(modalEditedQuantities[groupId]?.[it.inventoryItemId] ?? it?.actualQuantity ?? 0),
                              currentQuantity: Number(it?.currentQuantity ?? 0),
                              variantId: it.variantId,
                              sku: it.sku,
                              title: it.title,
                            }));
                          }
                          if (Object.keys(groups).length === 0) return;
                          const fd = new FormData();
                          fd.set("action", "update_stocktake_quantity");
                          fd.set("countId", modalCount.id);
                          fd.set("groups", JSON.stringify(groups));
                          historyActionFetcher.submit(fd, { method: "post" });
                        }}
                        style={{ padding: "8px 16px", fontSize: "14px", borderRadius: "6px", border: "1px solid #2e7d32", background: "#2e7d32", color: "#fff", cursor: historyActionFetcher.state === "idle" ? "pointer" : "not-allowed" }}
                      >
                        {historyActionFetcher.state !== "idle" ? "保存中..." : "保存"}
                      </button>
                      <button
                        type="button"
                        onClick={() => { setModalEditMode(false); setModalEditedQuantities({}); }}
                        style={{ padding: "8px 16px", fontSize: "14px", borderRadius: "6px", border: "1px solid #6d7175", background: "#fff", color: "#202223", cursor: "pointer" }}
                      >
                        キャンセル
                      </button>
                    </>
                  );
                  })()}
                  {(() => {
                    const isCountFullyCompleted = modalCount?.status === "completed" || modalCount?.status === "cancelled";
                    const allGroupIds = Array.isArray(modalCount.productGroupIds) && modalCount.productGroupIds.length > 0 ? modalCount.productGroupIds : modalCount.productGroupId ? [modalCount.productGroupId] : [];
                    const groupItemsMap = (modalCount as any)?.groupItems && typeof (modalCount as any).groupItems === "object" ? (modalCount as any).groupItems : {};
                    const cancelledSet = new Set((Array.isArray((modalCount as any)?.cancelledGroupIds) ? (modalCount as any).cancelledGroupIds : []).map((id: string) => normalizeIdForMatch(id)));
                    const completedCount = allGroupIds.filter((id) => getGroupItemsByKey(groupItemsMap as Record<string, unknown[]>, id).length > 0).length;
                    const allCompleted = allGroupIds.length > 0 && completedCount === allGroupIds.length;
                    const hasIncomplete = allGroupIds.some((id) => getGroupItemsByKey(groupItemsMap as Record<string, unknown[]>, id).length === 0 && !cancelledSet.has(normalizeIdForMatch(id)));
                    // ✅ 未完了グループのうち、商品リスト未読込のものがあるときは一括確定を無効化（送信してもサーバーに渡すデータが空になるため）
                    const incompleteGroupIds = allGroupIds.filter((id) => getGroupItemsByKey(groupItemsMap as Record<string, unknown[]>, id).length === 0 && !cancelledSet.has(normalizeIdForMatch(id)));
                    const hasIncompleteWithItems = incompleteGroupIds.some((id) => getIncompleteProductsForGroup(id).length > 0);
                    const stillLoadingIncomplete = incompleteGroupIds.length > 0 && (incompleteGroupProductsFetcher.state !== "idle" || loadingIncompleteGroupIds.size > 0);
                    const canConfirmAll = !isCountFullyCompleted && hasIncomplete && (stillLoadingIncomplete ? false : hasIncompleteWithItems);
                    return (
                      <>
                        <button
                          type="button"
                          disabled={isCountFullyCompleted || historyActionFetcher.state !== "idle" || !canConfirmAll}
                          onClick={() => {
                            if (!confirm("未完了のグループを一括で確定しますか？在庫数が実数に更新されます。")) return;
                            const incompletePayload: Record<string, Array<{ inventoryItemId: string; currentQuantity: number; actualQuantity: number; variantId?: string; sku?: string; title?: string }>> = {};
                            for (const groupId of allGroupIds) {
                              const existing = getGroupItemsByKey(groupItemsMap as Record<string, unknown[]>, groupId);
                              if (existing.length > 0) continue;
                              if (cancelledSet.has(normalizeIdForMatch(groupId))) continue;
                              const items = getIncompleteProductsForGroup(groupId);
                              if (items.length === 0) continue;
                              incompletePayload[groupId] = items.map((it: any) => ({
                                inventoryItemId: it.inventoryItemId,
                                currentQuantity: Number(it?.currentQuantity ?? 0),
                                actualQuantity: Number(modalEditedQuantities[groupId]?.[it.inventoryItemId] ?? it?.actualQuantity ?? 0),
                                variantId: it.variantId,
                                sku: it.sku,
                                title: it.title,
                              }));
                            }
                            const fd = new FormData();
                            fd.set("action", "confirm_stocktake_all");
                            fd.set("inventoryCountsVersion", String(inventoryCountsVersion));
                            fd.set("countId", modalCount.id);
                            fd.set("incompleteGroupsItems", JSON.stringify(incompletePayload));
                            historyActionFetcher.submit(fd, { method: "post" });
                          }}
                          title={hasIncomplete && !canConfirmAll && stillLoadingIncomplete ? "商品リストの読み込みが完了してから確定できます" : isCountFullyCompleted ? "完了済みのため操作できません" : undefined}
                          style={{
                            padding: "8px 16px",
                            fontSize: "14px",
                            borderRadius: "6px",
                            border: "1px solid #2e7d32",
                            background: isCountFullyCompleted || !canConfirmAll ? "#e0e0e0" : "#2e7d32",
                            color: isCountFullyCompleted || !canConfirmAll ? "#999" : "#fff",
                            cursor: historyActionFetcher.state === "idle" && canConfirmAll ? "pointer" : "not-allowed",
                          }}
                        >
                          {hasIncomplete && !canConfirmAll && stillLoadingIncomplete ? "一括確定（読込中）" : "一括確定"}
                        </button>
                        {allCompleted && !isCountFullyCompleted && (
                          <button
                            type="button"
                            disabled={historyActionFetcher.state !== "idle"}
                            onClick={() => {
                              if (!confirm("この棚卸の確定をすべて取り消し、在庫を元に戻します。よろしいですか？")) return;
                              const fd = new FormData();
                              fd.set("action", "reset_stocktake_all");
                              fd.set("inventoryCountsVersion", String(inventoryCountsVersion));
                              fd.set("countId", modalCount.id);
                              historyActionFetcher.submit(fd, { method: "post" });
                            }}
                            style={{ padding: "8px 16px", fontSize: "14px", borderRadius: "6px", border: "1px solid #d72c0d", background: "#fff", color: "#d72c0d", cursor: historyActionFetcher.state === "idle" ? "pointer" : "not-allowed" }}
                          >
                            一括リセット
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={isCountFullyCompleted || historyActionFetcher.state !== "idle"}
                          onClick={() => {
                            const incompleteCount = allGroupIds.filter((id) => getGroupItemsByKey(groupItemsMap as Record<string, unknown[]>, id).length === 0 && !cancelledSet.has(normalizeIdForMatch(id))).length;
                            const msg = incompleteCount === allGroupIds.length
                              ? "棚卸全体をキャンセルしますか？在庫は変更されません。"
                              : "未完了のグループのみキャンセルします。よろしいですか？";
                            if (!confirm(msg)) return;
                            const fd = new FormData();
                            fd.set("action", "cancel_stocktake");
                            fd.set("inventoryCountsVersion", String(inventoryCountsVersion));
                            fd.set("countId", modalCount.id);
                            historyActionFetcher.submit(fd, { method: "post" });
                          }}
                          style={{
                            padding: "8px 16px",
                            fontSize: "14px",
                            borderRadius: "6px",
                            border: "1px solid #6d7175",
                            background: isCountFullyCompleted ? "#f0f0f0" : "#fff",
                            color: isCountFullyCompleted ? "#999" : "#202223",
                            cursor: isCountFullyCompleted || historyActionFetcher.state !== "idle" ? "not-allowed" : "pointer",
                          }}
                        >
                          一括キャンセル
                        </button>
                      </>
                    );
                  })()}
                  <button
                    onClick={() => {
                      // ✅ 複数商品グループがある場合：groupItemsから各グループのデータを取得
                      // ✅ モーダル表示と同じロジックを使用（キーの型を考慮、後方互換性対応）
                      const allGroupIds = Array.isArray(modalCount.productGroupIds) && modalCount.productGroupIds.length > 0
                        ? modalCount.productGroupIds
                        : modalCount.productGroupId ? [modalCount.productGroupId] : [];
                      const groupItemsMap = (modalCount as any)?.groupItems && typeof (modalCount as any).groupItems === "object" ? (modalCount as any).groupItems : {};
                      const hasMultipleGroups = allGroupIds.length > 1;
                      
                      // ✅ 商品グループごとのデータを取得（モーダル表示と同じロジック）
                      const itemsByGroup = new Map<string, typeof modalCount.items>();
                      const countItemsLegacy = Array.isArray(modalCount.items) && modalCount.items.length > 0 ? modalCount.items : [];
                      if (hasMultipleGroups) {
                        // ✅ 複数グループの場合：モーダル表示と同じロジック
                        for (const groupId of allGroupIds) {
                          // ✅ groupItemsMapからデータを取得（getGroupItemsByKey で POS と同一の正規化キー照合）
                          let groupItems = getGroupItemsByKey(groupItemsMap as Record<string, unknown[]>, String(groupId));
                          // ✅ 後方互換性：groupItemsがない場合、itemsフィールドから該当グループの商品をフィルタリング
                          if (groupItems.length === 0 && countItemsLegacy.length > 0) {
                            const productGroup = productGroups.find((g) => g.id === groupId);
                            const groupInventoryItemIds = productGroup?.inventoryItemIds || [];
                            
                            if (groupInventoryItemIds.length > 0) {
                              const groupInventoryItemIdsSet = new Set(groupInventoryItemIds);
                              groupItems = countItemsLegacy.filter((item) => {
                                const itemId = String(item?.inventoryItemId || "").trim();
                                return groupInventoryItemIdsSet.has(itemId);
                              });
                            }
                          }
                          const isGroupCompleted = groupItems.length > 0;
                          if (isGroupCompleted) {
                            // ✅ 完了済みの場合はgroupItemsを使用（予定外商品を最後にソート）
                            const normalItemsForGroup = groupItems.filter((it) => !(it as any).isExtra);
                            const extraItemsForGroup = groupItems.filter((it) => !!(it as any).isExtra);
                            const sortedGroupItems = [...normalItemsForGroup, ...extraItemsForGroup];
                            itemsByGroup.set(groupId, sortedGroupItems);
                          } else {
                            // ✅ 未完了グループの商品リストを取得（キー正規化で先頭グループの照合漏れを防ぐ）
                            const incompleteProducts = getIncompleteProductsForGroup(groupId);
                            itemsByGroup.set(groupId, incompleteProducts);
                          }
                        }
                      } else {
                        // ✅ 単一グループの場合：モーダル表示と同じロジック（getGroupItemsByKey で POS と同一の正規化キー照合）
                        const groupId = allGroupIds[0];
                        let groupItems = getGroupItemsByKey(groupItemsMap as Record<string, unknown[]>, String(groupId));
                        // ✅ 後方互換性：groupItemsがない場合、itemsフィールドを使用
                        if (groupItems.length === 0) {
                          if (countItemsLegacy.length > 0) {
                            groupItems = countItemsLegacy;
                          }
                        }
                        const isGroupCompleted = groupItems.length > 0;
                        if (isGroupCompleted) {
                          // ✅ 予定外商品を最後にソート
                          const normalItemsForGroup = groupItems.filter((it) => !(it as any).isExtra);
                          const extraItemsForGroup = groupItems.filter((it) => !!(it as any).isExtra);
                          const sortedGroupItems = [...normalItemsForGroup, ...extraItemsForGroup];
                          itemsByGroup.set(groupId, sortedGroupItems);
                        } else {
                          // ✅ 未完了グループの商品リストを取得（キー正規化で先頭グループの照合漏れを防ぐ）
                          const incompleteProducts = getIncompleteProductsForGroup(groupId);
                          itemsByGroup.set(groupId, incompleteProducts);
                        }
                      }
                      
                      // ✅ 表示用のデータを準備（完了済みと未完了の両方を含む）
                      // ✅ 各商品にグループIDとグループ名、完了状態を追加
                      const displayItemsWithGroupInfo: Array<typeof modalCount.items[0] & { groupId: string; groupName: string; isGroupCompleted: boolean }> = [];
                      
                      if (itemsByGroup.size > 0) {
                        // ✅ itemsByGroupから取得した商品にグループ情報を追加
                        for (const [groupId, groupItems] of itemsByGroup.entries()) {
                          // ✅ グループ名を取得
                          const groupName = Array.isArray(modalCount.productGroupNames) && modalCount.productGroupNames.length > 0
                            ? modalCount.productGroupNames[allGroupIds.indexOf(groupId)] || groupId
                            : productGroups.find((g) => g.id === groupId)?.name || groupId;
                          
                          // ✅ グループの完了状態を判定（getGroupItemsByKey で POS と同一の正規化キー照合）
                          const groupItemsFromMap = getGroupItemsByKey(groupItemsMap as Record<string, unknown[]>, String(groupId));
                          const hasGroupItemsFromMap = groupItemsFromMap.length > 0;
                          const hasGroupItems = groupItems.length > 0;
                          const incompleteProductsForGroup = getIncompleteProductsForGroup(groupId);
                          const wasCompletedInItemsByGroup = hasGroupItems && incompleteProductsForGroup.length === 0;
                          const isGroupCompleted = hasGroupItemsFromMap || wasCompletedInItemsByGroup;
                          
                          // ✅ 各商品にグループ情報を追加
                          groupItems.forEach((item) => {
                            displayItemsWithGroupInfo.push({
                              ...item,
                              groupId,
                              groupName,
                              isGroupCompleted,
                            } as any);
                          });
                        }
                      } else {
                        // ✅ itemsByGroupが空の場合、modalCount.itemsを使用（単一グループの場合）
                        const groupId = allGroupIds[0] || "";
                        const groupName = Array.isArray(modalCount.productGroupNames) && modalCount.productGroupNames.length > 0
                          ? modalCount.productGroupNames[0]
                          : modalCount.productGroupName || modalCount.productGroupId || "-";
                        const groupItemsFromMap = getGroupItemsByKey(groupItemsMap as Record<string, unknown[]>, String(groupId));
                        const isGroupCompleted = groupItemsFromMap.length > 0;
                        
                        (modalCount.items || []).forEach((item) => {
                          displayItemsWithGroupInfo.push({
                            ...item,
                            groupId,
                            groupName,
                            isGroupCompleted,
                          } as any);
                        });
                      }
                      
                      if (!displayItemsWithGroupInfo || displayItemsWithGroupInfo.length === 0) {
                        alert("商品リストがありません");
                        return;
                      }

                      const headers = csvColumns.map((id) => STOCKTAKE_CSV_LABELS[id] ?? id);
                      const toRow = (rowObj: Record<string, string | number>) =>
                        csvColumns.map((id) => String(rowObj[id] ?? ""));

                      const dateOnly = (iso?: string) => extractDateFromISO(iso, shopTimezone);
                      const rows: string[][] = [];
                      displayItemsWithGroupInfo.forEach((it) => {
                        const locName = getLocationName(modalCount.locationId);
                        const countName = modalCount.countName || modalCount.id;
                        const groupName = (it as any).groupName || "-";
                        const isGroupCompleted = (it as any).isGroupCompleted || false;
                        const statusLabel = isGroupCompleted ? "完了" : "進行中";

                        const parsed = parseTitleToProductAndOptions(String(it.title || "").trim(), it as any);
                        const productName = parsed.productName || (it as any).sku || "-";
                        const { option1, option2, option3 } = parsed;
                        const sku = String((it as any).sku ?? "").trim();
                        const jan = String((it as any).barcode ?? "").trim();
                        const isExtra = !!(it as any).isExtra;
                        const kindLabel = isExtra ? "予定外" : "";

                        rows.push(toRow({
                          countId: modalCount.id,
                          name: countName,
                          date: dateOnly(modalCount.createdAt),
                          completedDate: dateOnly(modalCount.completedAt),
                          location: locName,
                          productGroup: groupName,
                          status: statusLabel,
                          productTitle: productName,
                          sku,
                          barcode: jan,
                          option1,
                          option2,
                          option3,
                          currentQty: it.currentQuantity ?? "",
                          actualQty: it.actualQuantity ?? "",
                          delta: it.delta ?? "",
                          kind: kindLabel,
                        }));
                      });

                      const csvContent = [headers, ...rows]
                        .map((row) => row.map(escapeCsv).join(","))
                        .join("\n");
                      const blob = new Blob(["\uFEFF" + csvContent], {
                        type: "text/csv;charset=utf-8;",
                      });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      const displayName = modalCount.countName || modalCount.id;
                      const safeName = String(displayName).replace(/[\\/:*?"<>|\s]/g, "_").trim() || "item";
                      a.download = `棚卸履歴_${safeName}_${todayInShopTimezone}.csv`;
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                    style={{
                      padding: "8px 16px",
                      backgroundColor: "#007bff",
                      color: "white",
                      border: "none",
                      borderRadius: "4px",
                      cursor: "pointer",
                      fontSize: "14px",
                    }}
                  >
                    CSV出力
                  </button>
                  <button
                    onClick={() => {
                      setModalOpen(false);
                      setModalCount(null);
                    }}
                    style={{
                      padding: "8px 16px",
                      backgroundColor: "#6c757d",
                      color: "white",
                      border: "none",
                      borderRadius: "4px",
                      cursor: "pointer",
                      fontSize: "14px",
                    }}
                  >
                    閉じる
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* コレクション商品選択モーダル（入出庫履歴と同じ形式） */}
          {collectionModalOpen && (
            <div
              style={{
                position: "fixed",
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                backgroundColor: "rgba(0, 0, 0, 0.5)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                zIndex: 1000,
              }}
              onClick={() => {
                setCollectionModalOpen(false);
                setCollectionModalCollectionId(null);
                setCollectionModalProducts([]);
                setCollectionModalSelectedVariantIds(new Set());
              }}
            >
              <div
                style={{
                  backgroundColor: "white",
                  borderRadius: "8px",
                  padding: "24px",
                  maxWidth: "90%",
                  maxHeight: "90%",
                  overflow: "auto",
                  boxShadow: "0 4px 6px rgba(0, 0, 0, 0.1)",
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <div style={{ marginBottom: "16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <h2 style={{ margin: 0, fontSize: "20px", fontWeight: "bold" }}>
                    商品選択: {collectionProductsFetcher.data?.collectionTitle || "コレクション"}
                  </h2>
                  <button
                    onClick={() => {
                      setCollectionModalOpen(false);
                      setCollectionModalCollectionId(null);
                      setCollectionModalProductGroupId(null);
                      setCollectionModalProducts([]);
                      setCollectionModalSelectedVariantIds(new Set());
                    }}
                    style={{
                      background: "none",
                      border: "none",
                      fontSize: "24px",
                      cursor: "pointer",
                      padding: "0",
                      width: "32px",
                      height: "32px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    ×
                  </button>
                </div>

                <div style={{ marginBottom: "16px", padding: "12px", backgroundColor: "#f5f5f5", borderRadius: "4px" }}>
                  <div style={{ fontSize: "14px", marginBottom: "4px" }}>
                    <strong>コレクション:</strong> {collectionProductsFetcher.data?.collectionTitle || "コレクション"}
                  </div>
                  <div style={{ fontSize: "14px" }}>
                    <strong>選択:</strong> {collectionModalSelectedVariantIds.size} / <strong>合計:</strong> {collectionModalProducts.length}
                  </div>
                </div>

                {collectionModalLoading ? (
                  <div style={{ padding: "24px", textAlign: "center" }}>
                    <div>商品リストを取得中...</div>
                  </div>
                ) : collectionModalProducts.length === 0 ? (
                  <div style={{ padding: "24px", textAlign: "center" }}>
                    <div>商品が見つかりません</div>
                  </div>
                ) : (
                  <div>
                    <div style={{ marginBottom: "12px" }}>
                      <input
                        type="text"
                        value={collectionModalSearchQuery}
                        onChange={(e) => setCollectionModalSearchQuery(e.target.value)}
                        placeholder="SKU・商品名・JANの一部で絞り込み"
                        style={{
                          width: "100%",
                          padding: "8px 12px",
                          border: "1px solid #e1e3e5",
                          borderRadius: "6px",
                          fontSize: "14px",
                          marginBottom: "8px",
                          boxSizing: "border-box",
                        }}
                      />
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}>
                        <span style={{ fontSize: "13px", color: "#6d7175" }}>
                          {showOnlySelectedInModal
                            ? `表示: 選択済み${displayModalProducts.length}件`
                            : displayModalProducts.length <= MODAL_ITEMS_PER_PAGE
                              ? `表示: ${displayModalProducts.length}件 / 全${collectionModalProducts.length}件`
                              : `表示: ${(collectionModalPage - 1) * MODAL_ITEMS_PER_PAGE + 1}-${Math.min(collectionModalPage * MODAL_ITEMS_PER_PAGE, displayModalProducts.length)}件 / 全${displayModalProducts.length}件`}
                        </span>
                        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                          <button
                            type="button"
                            onClick={() => setShowOnlySelectedInModal((prev) => !prev)}
                            style={{
                              padding: "6px 12px",
                              backgroundColor: showOnlySelectedInModal ? "#2563eb" : "#e5e7eb",
                              color: showOnlySelectedInModal ? "#fff" : "#202223",
                              border: "none",
                              borderRadius: "6px",
                              cursor: "pointer",
                              fontSize: "13px",
                            }}
                          >
                            {showOnlySelectedInModal ? "一覧表示に戻る" : "選択済み"}
                          </button>
                          <button
                            onClick={() => {
                              const allIds = new Set(collectionModalProducts.map((p) => p.variantId));
                              setCollectionModalSelectedVariantIds(allIds);
                            }}
                            style={{
                              padding: "6px 12px",
                              backgroundColor: "#007bff",
                              color: "white",
                              border: "none",
                              borderRadius: "6px",
                              cursor: "pointer",
                              fontSize: "13px",
                            }}
                          >
                            全選択
                          </button>
                          <button
                            onClick={() => setCollectionModalSelectedVariantIds(new Set())}
                            style={{
                              padding: "6px 12px",
                              backgroundColor: "#6c757d",
                              color: "white",
                              border: "none",
                              borderRadius: "6px",
                              cursor: "pointer",
                              fontSize: "13px",
                            }}
                          >
                            全解除
                          </button>
                        </div>
                      </div>
                    </div>
                    <div style={{ maxHeight: "400px", overflowY: "auto" }}>
                      {displayModalProducts.length === 0 ? (
                        <div style={{ padding: "24px", textAlign: "center", fontSize: "14px", color: "#6d7175" }}>
                          {showOnlySelectedInModal ? "選択済みの商品がありません" : "該当する商品がありません"}
                        </div>
                      ) : (
                        paginatedModalProducts.map((product) => {
                          const isSelected = collectionModalSelectedVariantIds.has(product.variantId);
                          const title = [product.productTitle, product.variantTitle]
                            .filter(Boolean)
                            .join(" / ");

                          return (
                            <div
                              key={product.variantId}
                              style={{
                                padding: "12px",
                                marginBottom: "0",
                                borderBottom: "1px solid #e5e7eb",
                                backgroundColor: isSelected ? "#e7f3ff" : "#f5f5f5",
                                borderRadius: "0",
                                display: "flex",
                                alignItems: "center",
                                gap: "12px",
                              }}
                            >
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={(e) => {
                                  const newSet = new Set(collectionModalSelectedVariantIds);
                                  if (e.target.checked) {
                                    newSet.add(product.variantId);
                                  } else {
                                    newSet.delete(product.variantId);
                                  }
                                  setCollectionModalSelectedVariantIds(newSet);
                                }}
                                style={{ width: "20px", height: "20px", cursor: "pointer" }}
                              />
                              <div style={{ flex: 1, fontSize: "14px" }}>
                                {title}
                                {product.sku && <span style={{ color: "#666", marginLeft: "8px" }}>(SKU: {product.sku})</span>}
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                    {displayModalProducts.length > MODAL_ITEMS_PER_PAGE && (
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "12px", padding: "12px 0" }}>
                        <button
                          type="button"
                          onClick={() => setCollectionModalPage((p) => Math.max(1, p - 1))}
                          disabled={collectionModalPage <= 1}
                          style={{
                            padding: "6px 12px",
                            border: "1px solid #c9cccf",
                            borderRadius: "6px",
                            background: collectionModalPage <= 1 ? "#f6f6f7" : "#fff",
                            cursor: collectionModalPage <= 1 ? "not-allowed" : "pointer",
                            fontSize: "13px",
                            color: collectionModalPage <= 1 ? "#8c9196" : "#202223",
                          }}
                        >
                          前へ
                        </button>
                        <span style={{ fontSize: "13px", color: "#6d7175" }}>
                          {(collectionModalPage - 1) * MODAL_ITEMS_PER_PAGE + 1}-{Math.min(collectionModalPage * MODAL_ITEMS_PER_PAGE, displayModalProducts.length)} / {displayModalProducts.length}件
                        </span>
                        <button
                          type="button"
                          onClick={() => setCollectionModalPage((p) => Math.min(modalTotalPages, p + 1))}
                          disabled={collectionModalPage >= modalTotalPages}
                          style={{
                            padding: "6px 12px",
                            border: "1px solid #c9cccf",
                            borderRadius: "6px",
                            background: collectionModalPage >= modalTotalPages ? "#f6f6f7" : "#fff",
                            cursor: collectionModalPage >= modalTotalPages ? "not-allowed" : "pointer",
                            fontSize: "13px",
                            color: collectionModalPage >= modalTotalPages ? "#8c9196" : "#202223",
                          }}
                        >
                          次へ
                        </button>
                      </div>
                    )}
                  </div>
                )}

                <div style={{ marginTop: "24px", display: "flex", justifyContent: "flex-end", gap: "12px" }}>
                  <button
                    onClick={() => {
                      setCollectionModalOpen(false);
                      setCollectionModalCollectionId(null);
                      setCollectionModalProductGroupId(null);
                      setCollectionModalProducts([]);
                      setCollectionModalSelectedVariantIds(new Set());
                    }}
                    style={{
                      padding: "8px 16px",
                      backgroundColor: "#6c757d",
                      color: "white",
                      border: "none",
                      borderRadius: "4px",
                      cursor: "pointer",
                      fontSize: "14px",
                    }}
                  >
                    キャンセル
                  </button>
                  <button
                    onClick={handleConfirmCollectionSelection}
                    style={{
                      padding: "8px 16px",
                      backgroundColor: "#28a745",
                      color: "white",
                      border: "none",
                      borderRadius: "4px",
                      cursor: "pointer",
                      fontSize: "14px",
                    }}
                  >
                    確定
                  </button>
                </div>
              </div>
            </div>
          )}
        </s-stack>
      </s-scroll-box>
    </s-page>
  );
}
