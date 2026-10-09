/**
 * POS 棚卸確定完了をアプリサーバーに 1 回だけ報告する。
 * メタの read/merge/write はサーバー側で行うため、タイルはこの送信だけ行う。
 * 在庫 setQuantities は呼ばない（二重調整防止。失敗時は needMetafieldRetry）。
 * @param {Object} opts
 * @param {string} opts.countId - 棚卸 ID
 * @param {string} [opts.groupId] - 単一グループ確定時のグループ ID
 * @param {Array} [opts.items] - 単一グループ時の items
 * @param {Array} [opts.completedGroups] - 複数グループ一括確定時
 * @param {boolean} [opts.retryOnly] - メタ更新のみ再試行（バックアップから復元）
 * @returns {Promise<{ ok: boolean; error?: string; needMetafieldRetry?: boolean; countId?: string; completedGroupIds?: string[]; status?: string; completedAt?: string; uncertain?: boolean; timedOut?: boolean; backupPersisted?: boolean }>}
 */

/** サーバ META_RETRY（最大3・間隔1.5s）＋ chunked metafield write を収める */
const STOCKTAKE_COMPLETE_TIMEOUT_MS = 120000;
/** 到達前の瞬断向け。長時間後の Failed to fetch はサーバ処理中切断の可能性 → 自動再送しない */
const NETWORK_FAST_FAIL_MS = 8000;
const NETWORK_MAX_ATTEMPTS = 3;
const NETWORK_RETRY_DELAY_MS = 700;

const NETWORK_FAIL_RE =
  /load failed|failed to fetch|network error|connection refused|net::|networkerror/i;

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isNetworkFailureMessage(msg) {
  return NETWORK_FAIL_RE.test(String(msg || ""));
}

function buildNetworkUserMessage() {
  return (
    "サーバーとの通信が途切れました。Wi‑Fiを確認し、「再試行」を押してください。" +
    "在庫調整済みの場合でも、この再試行はメタ更新のみで在庫を二重に変えません。"
  );
}

function buildTimeoutUserMessage() {
  return (
    "メタ更新の応答がタイムアウトしました（120秒）。サーバ側で完了している可能性があります。" +
    "「再試行」で確認してください（在庫の二重調整はしません）。"
  );
}

/**
 * @param {object} args
 * @returns {Promise<{ ok: boolean; error?: string; needMetafieldRetry?: boolean; countId?: string; completedGroupIds?: string[]; status?: string; completedAt?: string; uncertain?: boolean; timedOut?: boolean; backupPersisted?: boolean }>}
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

  const bodyJson = JSON.stringify(body);

  for (let attempt = 1; attempt <= NETWORK_MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), STOCKTAKE_COMPLETE_TIMEOUT_MS);
    const startedAt = Date.now();

    try {
      const resp = await fetch(apiUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: bodyJson,
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
          backupPersisted: data?.backupPersisted,
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
          backupPersisted: data?.backupPersisted,
        };
      }
      return {
        ok: true,
        status: typeof data?.status === "string" ? data.status : undefined,
        completedAt: typeof data?.completedAt === "string" ? data.completedAt : undefined,
        countId: data?.countId ?? countId,
        backupPersisted: data?.backupPersisted,
      };
    } catch (e) {
      clearTimeout(timeoutId);
      const msg = e?.message ?? String(e);
      const name = e?.name ?? "";
      const cause = e?.cause != null ? String(e.cause) : "";
      const elapsedMs = Date.now() - startedAt;
      const isAbort = name === "AbortError" || /abort|timeout/i.test(String(msg));
      console.error("[reportStocktakeCompleteToApi] Request failed:", msg);
      console.error("STOCKTAKE_API_ORIGIN [client] fetch threw:", {
        message: msg,
        name,
        cause: cause || "(none)",
        isAbort,
        attempt,
        elapsedMs,
      });

      if (isAbort) {
        return {
          ok: false,
          error: buildTimeoutUserMessage(),
          needMetafieldRetry: true,
          countId,
          uncertain: true,
          timedOut: true,
        };
      }

      if (isNetworkFailureMessage(msg)) {
        // 短時間失敗のみ自動再送（到達前瞬断）。長時間後はサーバ処理中切断の可能性 → ユーザ再試行へ。
        const canAutoRetry =
          elapsedMs < NETWORK_FAST_FAIL_MS && attempt < NETWORK_MAX_ATTEMPTS;
        if (canAutoRetry) {
          const waitMs = NETWORK_RETRY_DELAY_MS * attempt;
          console.warn(
            `[reportStocktakeCompleteToApi] fast network fail attempt ${attempt}/${NETWORK_MAX_ATTEMPTS}, retrying in ${waitMs}ms`
          );
          await delay(waitMs);
          // 401 以外のネット障害ではトークン再取得を試みる（短命トークン対策）
          try {
            const refreshed = await session.getSessionToken();
            if (refreshed) token = refreshed;
          } catch (_) {
            /* keep previous token */
          }
          continue;
        }
        return {
          ok: false,
          error: buildNetworkUserMessage(),
          needMetafieldRetry: true,
          countId,
          uncertain: true,
        };
      }

      return { ok: false, error: msg, needMetafieldRetry: true, countId, uncertain: true };
    }
  }

  return {
    ok: false,
    error: buildNetworkUserMessage(),
    needMetafieldRetry: true,
    countId,
    uncertain: true,
  };
}
