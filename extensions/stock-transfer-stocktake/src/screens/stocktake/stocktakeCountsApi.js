/**
 * 棚卸の読み取りをサーバー（/api/pos-stocktake-counts）経由で行う。
 * サーバーが db モードのときだけ使い、legacy / dual・通信失敗・旧サーバーでは null を返して
 * 呼び出し側が従来のメタフィールド読み書きに戻る。
 */

const MODE_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 20_000;

let modeCache = { mode: null, at: 0 };
let dbListCache = null;

export function resetStocktakeCountsApiCache() {
  modeCache = { mode: null, at: 0 };
  dbListCache = null;
}

export function cachedStorageMode(now = Date.now()) {
  return modeCache.mode && now - modeCache.at < MODE_TTL_MS ? modeCache.mode : null;
}

export function rememberStorageMode(mode, now = Date.now()) {
  modeCache = { mode: mode || null, at: now };
}

/** 新しい順のリストを pageSize ごとに分け、既存 UI の chunkIndex（末尾から読む）に対応させる */
export function pageForChunkIndex(newestFirst, pageSize, chunkIndex) {
  const list = Array.isArray(newestFirst) ? newestFirst : [];
  const size = Math.max(1, Math.floor(Number(pageSize)) || 1);
  const totalPages = Math.max(1, Math.ceil(list.length / size));
  const pageNumber = totalPages - 1 - chunkIndex;
  if (pageNumber < 0 || pageNumber >= totalPages) return [];
  return list.slice(pageNumber * size, pageNumber * size + size);
}

export function totalPagesFor(length, pageSize) {
  const size = Math.max(1, Math.floor(Number(pageSize)) || 1);
  return Math.max(1, Math.ceil((Number(length) || 0) / size));
}

export function setDbListCache(counts, listLimit) {
  dbListCache = { counts: Array.isArray(counts) ? counts : [], listLimit };
}

export function getDbListCache() {
  return cachedStorageMode() === "db" ? dbListCache : null;
}

async function postCountsApi(body) {
  const session = globalThis?.shopify?.session;
  if (!session?.getSessionToken) return null;
  let token;
  try {
    token = await session.getSessionToken();
  } catch {
    return null;
  }
  if (!token) return null;
  const { getAppUrl } = await import("../../../../common/appUrl.js");
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
  try {
    const resp = await fetch(`${getAppUrl()}/api/pos-stocktake-counts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!resp.ok) return null;
    return await resp.json().catch(() => null);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * db モードなら API の応答を返す。それ以外（legacy / dual / 失敗）は null。
 * legacy / dual と分かっている間（60 秒）は API を呼ばない。
 */
export async function tryCountsApi(op, countId, deps = { post: postCountsApi }) {
  const cached = cachedStorageMode();
  if (cached && cached !== "db") return null;
  const res = await deps.post(countId ? { op, countId } : { op });
  if (!res || res.ok !== true) {
    // 旧サーバー（404）・通信失敗の間に毎回 API を待たせない
    if (!cached && !res?.storageMode) rememberStorageMode("legacy");
    return null;
  }
  rememberStorageMode(res.storageMode);
  return res.storageMode === "db" ? res : null;
}
