export const readValue = (eOrValue) => {
  if (typeof eOrValue === "string" || typeof eOrValue === "number") {
    return String(eOrValue);
  }
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

export function fieldPath(field) {
  if (!Array.isArray(field) || field.length === 0) return "";
  let out = "";
  for (const part of field) {
    const p = String(part);
    if (/^\d+$/.test(p)) out += `[${p}]`;
    else out += (out ? "." : "") + p;
  }
  return out;
}

export function formatUserErrors(userErrors, lineItemsMeta) {
  const errs = Array.isArray(userErrors) ? userErrors : [];
  if (errs.length === 0) return [];
  const lines = errs.map((e) => {
    const fp = fieldPath(e?.field);
    const msg = String(e?.message ?? "Unknown error");
    let itemHint = "";
    if (fp) {
      const m = fp.match(/lineItems\[(\d+)\]/);
      if (m?.[1] && Array.isArray(lineItemsMeta)) {
        const idx = Number(m[1]);
        const meta = lineItemsMeta[idx];
        if (meta?.label) itemHint = `（${meta.label}）`;
      }
    }
    return `- ${msg}${itemHint}${fp ? ` [${fp}]` : ""}`;
  });
  return Array.from(new Set(lines));
}

export function assertNoUserErrors(payload, label = "Mutation", lineItemsMeta) {
  const errs = payload?.userErrors ?? [];
  if (!Array.isArray(errs) || errs.length === 0) return;
  const formatted = formatUserErrors(errs, lineItemsMeta);
  const msg = formatted.length ? formatted.join("\n") : errs.map((e) => e?.message).join(" / ");
  throw new Error(`${label} failed:\n${msg}`);
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
      const elapsed = Date.now() - started;
      if (elapsed >= timeoutMs) {
        try {
          controller.abort(new Error(`timeout ${timeoutMs}ms`));
        } catch {}
        reject(new Error(`timeout ${timeoutMs}ms`));
      }
    }, 200);
  });
  const fetchPromise = (async () => {
    const res = await fetch("shopify:admin/api/graphql.json", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
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

export function normalizeVariantTitleForDisplay_(productTitle, variantTitle) {
  const p = String(productTitle || "").trim();
  const v = String(variantTitle || "").trim();
  if (!v) return "";
  if (v.toLowerCase() === "default title") return "";
  if (p && v === p) return "";
  return v;
}

export function normalizeVariantOptions_(productTitle, variantTitle) {
  const v = normalizeVariantTitleForDisplay_(productTitle, variantTitle);
  if (!v) return [];
  const parts = v.split("/").map((s) => s.trim()).filter(Boolean);
  return parts;
}

export function formatOptionsLine_(options) {
  const ops = Array.isArray(options) ? options.filter(Boolean) : [];
  if (ops.length === 0) return "";
  return ops.join(" / ");
}

/**
 * ステータスバッジ用の色（未登録のようなピル型バッジ）
 * 戻り値: { backgroundColor, color }
 * @deprecated POS UI の Box は style をサポートしないため、getStatusBadgeTone + s-badge を使用すること
 */
export function getStatusBadgeStyle(statusLabel) {
  const s = String(statusLabel || "").trim();
  if (!s) return { backgroundColor: "#6c757d", color: "#fff" };
  if (/下書き/i.test(s)) return { backgroundColor: "#e6b800", color: "#1a1a1a" };
  if (/配送準備完了/i.test(s)) return { backgroundColor: "#2d8a3e", color: "#fff" };
  if (/処理中|進行中/i.test(s)) return { backgroundColor: "#6b8cce", color: "#fff" };
  if (/入庫済み|TRANSFERRED/i.test(s)) return { backgroundColor: "#4a90d9", color: "#fff" };
  if (/入庫/i.test(s)) return { backgroundColor: "#3d9a4e", color: "#fff" };
  if (/キャンセル|強制キャンセル/i.test(s)) return { backgroundColor: "#b33", color: "#fff" };
  return { backgroundColor: "#6c757d", color: "#fff" };
}

/**
 * POS UI 公式 Badge（s-badge）用の tone
 * POS UI の Box は任意の style をサポートしないため、s-badge + tone でステータス表示する
 * tone: 'auto' | 'neutral' | 'info' | 'success' | 'caution' | 'warning' | 'critical'
 */
export function getStatusBadgeTone(statusLabel) {
  const s = String(statusLabel || "").trim();
  if (!s) return "neutral";
  if (/下書き/i.test(s)) return "caution";
  if (/配送準備完了/i.test(s)) return "success";
  if (/処理中|進行中/i.test(s)) return "info";
  if (/入庫済み|TRANSFERRED/i.test(s)) return "info";
  if (/入庫/i.test(s)) return "success";
  if (/キャンセル|強制キャンセル/i.test(s)) return "critical";
  return "neutral";
}

/**
 * 配送リストと同じ形式で Shipment ID を表示する（Transfer 名から番号部分を取得）
 * 例: transferName "T0127", index 1 → "#T0127-1"
 */
export function formatShipmentDisplayId(transferName, shipmentIndex1Based) {
  const base = String(transferName || "").trim() || "T0000";
  const match = base.match(/(T?\d+)$/);
  const numPart = match ? match[1] : base;
  const idx = Math.max(1, Number(shipmentIndex1Based) || 1);
  return `#${numPart}-${idx}`;
}
