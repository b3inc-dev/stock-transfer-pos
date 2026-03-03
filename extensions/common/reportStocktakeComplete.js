/**
 * POS 棚卸確定完了をアプリサーバーに 1 回だけ報告する。
 * メタの read/merge/write はサーバー側で行うため、タイルはこの送信だけ行う。
 * @param {Object} opts
 * @param {string} opts.countId - 棚卸 ID
 * @param {string} [opts.groupId] - 単一グループ確定時のグループ ID
 * @param {Array<{ inventoryItemId: string; currentQuantity: number; actualQuantity: number; variantId?: string; sku?: string; title?: string }>} [opts.items] - 単一グループ時の items
 * @param {Array<{ groupId: string; items: Array<{ inventoryItemId: string; currentQuantity: number; actualQuantity: number; variantId?: string; sku?: string; title?: string }> }>} [opts.completedGroups] - 複数グループ一括確定時
 * @returns {Promise<{ ok: boolean; error?: string }>} - 成功時 { ok: true }、失敗時 throw または { ok: false, error }
 */
export async function reportStocktakeCompleteToApi({ countId, groupId, items, completedGroups }) {
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
  // 原因特定用: 送信先を記録（Render ログと突き合わせ可能。本番で STOCKTAKE_API_ORIGIN を検索）
  try {
    const urlObj = new URL(apiUrl);
    console.warn("STOCKTAKE_API_ORIGIN [client] sending POST to", urlObj.origin + urlObj.pathname);
  } catch (_) {
    console.warn("STOCKTAKE_API_ORIGIN [client] apiUrl invalid:", apiUrl);
  }

  const body =
    Array.isArray(completedGroups) && completedGroups.length > 0
      ? { countId, completedGroups }
      : groupId && Array.isArray(items)
        ? { countId, groupId, items }
        : null;
  if (!body || !countId) {
    return { ok: false, error: "countId と groupId/items または completedGroups が必要です" };
  }

  // 確定API はサーバー側で read/write 全チャンクを行うため時間がかかることがある。履歴API との違い（「返ってこない」対策）。
  const STOCKTAKE_COMPLETE_TIMEOUT_MS = 90000; // 90秒
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
      return { ok: false, error: msg };
    }
    if (data?.ok === false) {
      const msg = data?.error ?? "保存に失敗しました";
      console.warn("[reportStocktakeCompleteToApi] API returned ok:false:", msg);
      return { ok: false, error: msg };
    }
    return { ok: true };
  } catch (e) {
    clearTimeout(timeoutId);
    const msg = e?.message ?? String(e);
    const name = e?.name ?? "";
    const cause = e?.cause != null ? String(e.cause) : "";
    const isAbort = name === "AbortError" || /abort|timeout/i.test(String(msg));
    console.error("[reportStocktakeCompleteToApi] Request failed:", msg);
    // 原因特定用: fetch が throw した内容をそのまま記録（仮説ではなく事実）
    console.error("STOCKTAKE_API_ORIGIN [client] fetch threw:", { message: msg, name, cause: cause || "(none)", isAbort });
    if (isAbort) {
      return { ok: false, error: "応答が返ってくるまでに時間がかかりすぎました（90秒）。棚卸データが大きい場合があります。しばらくしてから再度確定してください。" };
    }
    // ブラウザの fetch がレスポンスを受け取る前に失敗した場合（接続不可・CORS・ネットワーク）は「Load failed」等になる
    const isNetworkFailure = /load failed|failed to fetch|network error|connection refused|net::/i.test(String(msg));
    const userMessage = isNetworkFailure
      ? "サーバーに接続できませんでした。ネットワークとアプリURL（開発時はトンネルURL）を確認してください。"
      : msg;
    return { ok: false, error: userMessage };
  }
}
