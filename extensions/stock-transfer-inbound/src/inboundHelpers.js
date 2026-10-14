export const readValue = (eOrValue) => {
  if (typeof eOrValue === "string" || typeof eOrValue === "number") return String(eOrValue);
  return String(
    eOrValue?.currentTarget?.value ??
      eOrValue?.target?.value ??
      eOrValue?.detail?.value ??
      eOrValue?.currentValue?.value ??
      ""
  );
};

export function safeParseJson(s, fallback) {
  if (!s) return fallback;
  try {
    return JSON.parse(String(s));
  } catch {
    return fallback;
  }
}

export function getStateSlice(appState, key, fallback = {}) {
  const s = appState?.[key];
  return s && typeof s === "object" ? s : fallback;
}

export function setStateSlice(setAppState, key, patch) {
  setAppState((prev) => {
    const cur = (prev && typeof prev === "object" ? prev : {})[key];
    const base = cur && typeof cur === "object" ? cur : {};
    const next = typeof patch === "function" ? patch(base) : { ...base, ...(patch || {}) };
    return { ...(prev && typeof prev === "object" ? prev : {}), [key]: next };
  });
}

export async function adminGraphql(query, variables, opts = {}) {
  const timeoutMsRaw = opts?.timeoutMs;
  const timeoutMs = Number.isFinite(Number(timeoutMsRaw)) ? Number(timeoutMsRaw) : 20000;
  const controller = new AbortController();
  const parentSignal = opts?.signal;
  const onAbort = () => controller.abort(parentSignal?.reason || new Error("aborted"));
  if (parentSignal) {
    if (parentSignal.aborted) onAbort();
    else parentSignal.addEventListener("abort", onAbort, { once: true });
  }
  let done = false;
  let iv = null;
  const timeoutPromise = new Promise((_, reject) => {
    const started = Date.now();
    iv = setInterval(() => {
      if (done) return;
      if (Date.now() - started >= timeoutMs) {
        try { controller.abort(new Error(`timeout ${timeoutMs}ms`)); } catch {}
        reject(new Error(`timeout ${timeoutMs}ms`));
      }
    }, 200);
  });
  const cleanQuery = String(query || "").replace(/^#graphql\s*/m, "").trim();
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

/**
 * POS UI 公式 Badge（s-badge）用の tone（入庫・配送ステータス用）
 * バッジにはメインのステータスのみ表示し、補足（一部入庫・予定超過など）はバッジの後にテキストで表示する
 */
export function getStatusBadgeTone(statusLabel) {
  const s = String(statusLabel || "").trim();
  if (!s) return "neutral";
  if (/下書き/i.test(s)) return "caution";
  if (/配送準備完了/i.test(s)) return "success";
  if (/配送中|処理中|進行中/i.test(s)) return "info";
  if (/入庫済み|TRANSFERRED/i.test(s)) return "info";
  if (/入庫/i.test(s)) return "success";
  if (/キャンセル/i.test(s)) return "critical";
  return "neutral";
}

export function assertNoUserErrors(payload, label = "Mutation") {
  const errs = payload?.userErrors ?? [];
  if (!Array.isArray(errs) || errs.length === 0) return;
  const msg = errs.map((e) => e?.message).filter(Boolean).join(" / ");
  throw new Error(`${label} failed: ${msg || JSON.stringify(errs)}`);
}

export function toUserMessage(e) {
  const m = e?.message ?? String(e);
  try {
    const parsed = JSON.parse(m);
    if (Array.isArray(parsed)) return parsed.map((x) => x?.message ?? JSON.stringify(x)).join(" / ");
  } catch {}
  return m;
}
