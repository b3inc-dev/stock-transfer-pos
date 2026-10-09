/**
 * POS 棚卸確定完了をアプリサーバーに 1 回だけ報告する。
 * メタの read/merge/write はサーバー側で行うため、タイルはこの送信だけ行う。
 * @param {Object} opts
 * @param {string} opts.countId - 棚卸 ID
 * @param {string} [opts.groupId] - 単一グループ確定時のグループ ID
 * @param {Array} [opts.items] - 単一グループ時の items
 * @param {Array} [opts.completedGroups] - 複数グループ一括確定時
 * @param {boolean} [opts.retryOnly] - メタ更新のみ再試行（バックアップから復元）
 * @returns {Promise<{ ok: boolean; error?: string; needMetafieldRetry?: boolean; countId?: string; completedGroupIds?: string[]; status?: string; completedAt?: string }>}
 */
export async function reportStocktakeCompleteToApi({ countId, groupId, items, completedGroups, retryOnly }) {
  const session = globalThis?.shopify?.session;
  if (!session?.getSessionToken) {
    console.warn("[reportStocktakeCompleteToApi] No session or getSessionToken");
    return { ok: false, error: "セッションが取得できません" };
  }
  let token;
  try {
    token = await session.getSessionToken();
  } catch (e) {
    console.warn("[reportStocktakeCompleteToApi] getSessionToken failed:", e?.message ?? e);
    return { ok: false, error: "認証トークンの取得に失敗しました" };
  }
  if (!token) {
    return { ok: false, error: "認証トークンが取得できませんでした" };
  }

  const { getAppUrl } = await import("./appUrl.js");
  const appUrl = getAppUrl();
  const apiUrl = `${appUrl}/api/pos-stocktake-complete`;
  try {
    const urlObj = new URL(apiUrl);
    console.warn("STOCKTAKE_API_ORIGIN [client] sending POST to", urlObj.origin + urlObj.pathname);
  } catch (_) {
    console.warn("STOCKTAKE_API_ORIGIN [client] apiUrl invalid:", apiUrl);
  }

  let body;
  if (retryOnly) {
    body = { countId, retryOnly: true };
  } else if (Array.isArray(completedGroups) && completedGroups.length > 0) {
    body = { countId, completedGroups };
  } else if (groupId && Array.isArray(items)) {
    body = { countId, groupId, items };
  } else {
    body = null;
  }
  if (!body || !countId) {
    return { ok: false, error: "countId と groupId/items または completedGroups が必要です" };
  }

  const STOCKTAKE_COMPLETE_TIMEOUT_MS = 90000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), STOCKTAKE_COMPLETE_TIMEOUT_MS);

  try {
    const resp = await fetch(apiUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const msg = data?.error ?? `HTTP ${resp.status}`;
      console.warn("[reportStocktakeCompleteToApi] HTTP error:", resp.status, msg);
      return {
        ok: false,
        error: msg,
        needMetafieldRetry: Boolean(data?.needMetafieldRetry),
        countId: data?.countId,
        completedGroupIds: data?.completedGroupIds,
      };
    }
    if (data?.ok === false) {
      const msg = data?.error ?? "保存に失敗しました";
      console.warn("[reportStocktakeCompleteToApi] API returned ok:false:", msg);
      return {
        ok: false,
        error: msg,
        needMetafieldRetry: Boolean(data?.needMetafieldRetry),
        countId: data?.countId ?? countId,
        completedGroupIds: data?.completedGroupIds,
      };
    }
    return {
      ok: true,
      status: typeof data?.status === "string" ? data.status : undefined,
      completedAt: typeof data?.completedAt === "string" ? data.completedAt : undefined,
      countId: data?.countId ?? countId,
    };
  } catch (e) {
    clearTimeout(timeoutId);
    const msg = e?.message ?? String(e);
    const name = e?.name ?? "";
    const cause = e?.cause != null ? String(e.cause) : "";
    const isAbort = name === "AbortError" || /abort|timeout/i.test(String(msg));
    console.error("[reportStocktakeCompleteToApi] Request failed:", msg);
    console.error("STOCKTAKE_API_ORIGIN [client] fetch threw:", { message: msg, name, cause: cause || "(none)", isAbort });
    if (isAbort) {
      return {
        ok: false,
        error: "応答が返ってくるまでに時間がかかりすぎました（90秒）。棚卸データが大きい場合があります。しばらくしてから再度確定してください。",
        needMetafieldRetry: true,
        countId,
      };
    }
    const isNetworkFailure = /load failed|failed to fetch|network error|connection refused|net::/i.test(String(msg));
    const userMessage = isNetworkFailure
      ? "サーバーに接続できませんでした。ネットワークとアプリURL（開発時はトンネルURL）を確認してください。"
      : msg;
    return { ok: false, error: userMessage, needMetafieldRetry: true, countId };
  }
}
