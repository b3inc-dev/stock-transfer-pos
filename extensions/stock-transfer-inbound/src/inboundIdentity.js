/**
 * 入庫スキャンの安定 identity（照合の正）。
 * 優先順: inventoryItemId → 正規化 barcode（予定行 ID 欠落時）→ 正規化 SKU（JAN 空時のみ）
 */

export function normalizeInboundCode(code) {
  const s = String(code ?? "").trim();
  if (!s) return "";
  return s.replace(/\s+/g, "").toUpperCase().replace(/[^0-9A-Z._-]/g, "");
}

/**
 * 解決結果 / 予定外行から安定 identity キーを作る。
 * @returns {string} e.g. "inv:gid://..." | "bc:490..." | "sku:ABC" | ""
 */
export function identityKeyFromFields(fields) {
  const inv = String(fields?.inventoryItemId || "").trim();
  if (inv) return `inv:${inv}`;
  const bc = normalizeInboundCode(fields?.barcode);
  if (bc) return `bc:${bc}`;
  const sk = normalizeInboundCode(fields?.sku);
  if (sk) return `sku:${sk}`;
  return "";
}

/** 予定外 React key。Date.now() 禁止。 */
export function extraReactKeyFromIdentity(identity) {
  const id = String(identity || "").trim();
  return id ? `extra-${id}` : "";
}

/**
 * 予定行がスキャン解決結果と同一 identity か。
 * - 解決側に inventoryItemId があるとき: 同 ID のみ本命。予定行 ID が空のときだけ JAN/SKU 救済。
 * - 解決側 ID が空のとき: JAN →（JAN 空なら）SKU。
 * ID 解決済みの行を JAN だけで別商品へ寄せない。
 */
export function rowMatchesResolved(row, resolved) {
  if (!row || !resolved) return false;
  const resolvedInv = String(resolved.inventoryItemId || "").trim();
  const rowInv = String(row.inventoryItemId || "").trim();

  if (resolvedInv) {
    if (rowInv) return rowInv === resolvedInv;
    const bc = normalizeInboundCode(resolved.barcode);
    if (bc) return normalizeInboundCode(row.barcode) === bc;
    const sk = normalizeInboundCode(resolved.sku);
    if (sk) return normalizeInboundCode(row.sku) === sk;
    return false;
  }

  const bc = normalizeInboundCode(resolved.barcode);
  if (bc) return normalizeInboundCode(row.barcode) === bc;
  const sk = normalizeInboundCode(resolved.sku);
  if (sk) return normalizeInboundCode(row.sku) === sk;
  return false;
}

/** 予定外行 vs 解決結果（identity 同一ならマージ対象） */
export function extraMatchesResolved(extra, resolved) {
  if (!extra || !resolved) return false;
  const a = identityKeyFromFields(extra);
  const b = identityKeyFromFields(resolved);
  if (a && b) return a === b;
  return rowMatchesResolved(extra, resolved);
}

export function remainingPlannedQty(row) {
  const planned = Math.floor(Number(row?.plannedQty || 0));
  const received = Math.floor(Number(row?.receiveQty || 0));
  return Math.max(0, planned - received);
}

/**
 * 同一 identity の候補から加算先を1行選ぶ。
 * multi: 残予定 > 0 が最大の行。全充足なら allowOverReceive 時のみ既存行へ。
 * 単一配送でも候補が1件ならその行。
 */
export function pickBestPlannedRow(candidates, { allowOverReceive = true } = {}) {
  const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
  if (list.length === 0) return { row: null, reason: "none" };
  if (list.length === 1) {
    const rem = remainingPlannedQty(list[0]);
    if (rem > 0) return { row: list[0], reason: "remaining" };
    if (allowOverReceive) return { row: list[0], reason: "over" };
    return { row: null, reason: "over_denied" };
  }

  let best = null;
  let bestRem = -1;
  for (const r of list) {
    const rem = remainingPlannedQty(r);
    if (rem > bestRem) {
      bestRem = rem;
      best = r;
    }
  }
  if (bestRem > 0) return { row: best, reason: "remaining" };
  if (allowOverReceive) return { row: list[0], reason: "over" };
  return { row: null, reason: "over_denied" };
}

/**
 * 下書き extras を identity で再キー＋同一 identity 合算。
 * 旧 `extra-*-timestamp` も畳む。
 */
export function normalizeExtrasByIdentity(extras) {
  const map = new Map();
  for (const x of Array.isArray(extras) ? extras : []) {
    const qty = Math.max(0, Math.floor(Number(x?.receiveQty || 0)));
    if (qty <= 0) continue;
    const idKey = identityKeyFromFields(x);
    if (!idKey) continue;
    const key = extraReactKeyFromIdentity(idKey);
    const prev = map.get(key);
    if (prev) {
      prev.receiveQty = Math.max(0, Number(prev.receiveQty || 0) + qty);
      if (!prev.inventoryItemId && x.inventoryItemId) prev.inventoryItemId = String(x.inventoryItemId).trim();
      if (!prev.barcode && x.barcode) prev.barcode = String(x.barcode || "");
      if (!prev.sku && x.sku) prev.sku = String(x.sku || "");
      if ((!prev.title || prev.title === "(unknown)") && x.title) prev.title = x.title;
      if (!prev.imageUrl && x.imageUrl) prev.imageUrl = x.imageUrl;
    } else {
      map.set(key, {
        key,
        inventoryItemId: String(x.inventoryItemId || "").trim(),
        title: x.title || x.sku || "(unknown)",
        sku: x.sku || "",
        barcode: x.barcode || "",
        imageUrl: x.imageUrl || "",
        receiveQty: qty,
      });
    }
  }
  return Array.from(map.values());
}
