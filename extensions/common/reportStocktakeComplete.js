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

  const body =
    Array.isArray(completedGroups) && completedGroups.length > 0
      ? { countId, completedGroups }
      : groupId && Array.isArray(items)
        ? { countId, groupId, items }
        : null;
  if (!body || !countId) {
    return { ok: false, error: "countId と groupId/items または completedGroups が必要です" };
  }

  try {
    const resp = await fetch(apiUrl, {
      method: "POST",
      mode: "cors",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
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
    const msg = e?.message ?? String(e);
    console.error("[reportStocktakeCompleteToApi] Request failed:", msg);
    // ブラウザの fetch がレスポンスを受け取る前に失敗した場合（接続不可・CORS・ネットワーク）は「Load failed」等になる
    const isNetworkFailure = /load failed|failed to fetch|network error|connection refused|net::/i.test(String(msg));
    const userMessage = isNetworkFailure
      ? "サーバーに接続できませんでした。ネットワークとアプリURL（開発時はトンネルURL）を確認してください。"
      : msg;
    return { ok: false, error: userMessage };
  }
}
