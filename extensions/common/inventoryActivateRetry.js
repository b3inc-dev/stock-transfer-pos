/**
 * 在庫有効化が失敗したときに SKU/バーコードで再検索して行の inventoryItemId を更新し、再試行する。
 * 出庫・入庫・棚卸・在庫調整など POS 拡張で共通利用。
 */

export function normalizeScanCodeForRetry(code) {
  const s = String(code ?? "").trim();
  if (!s) return "";
  return s
    .replace(/\s+/g, "")
    .toUpperCase()
    .replace(/[^0-9A-Z._-]/g, "");
}

export function pickBestVariantFromSearchList(codeRaw, list) {
  const code = normalizeScanCodeForRetry(codeRaw);
  if (!code) return null;
  const arr = Array.isArray(list) ? list : [];
  if (arr.length === 0) return null;
  const byBarcode = arr.find((x) => normalizeScanCodeForRetry(x?.barcode) === code);
  if (byBarcode) return byBarcode;
  const bySku = arr.find((x) => normalizeScanCodeForRetry(x?.sku) === code);
  if (bySku) return bySku;
  return arr[0];
}

/**
 * 検索結果を行オブジェクトにマージ（余計なフィールドは ...line で保持）
 */
export function mergeInventoryRowWithResolvedVariant(line, v) {
  if (!v?.variantId || !v?.inventoryItemId) return null;
  const productTitle = String(v.productTitle || "").trim();
  const variantTitle = String(v.variantTitle || "").trim();
  const sku = String(v.sku || "").trim();
  const label =
    productTitle || variantTitle || sku
      ? `${productTitle} / ${variantTitle}${sku ? `（${sku}）` : ""}`.trim()
      : String(line?.label || "").trim();

  return {
    ...line,
    variantId: v.variantId,
    inventoryItemId: v.inventoryItemId,
    sku: sku || line.sku,
    barcode: String(v.barcode || "").trim() || line.barcode,
    productTitle: productTitle || line.productTitle,
    variantTitle: variantTitle || line.variantTitle,
    imageUrl: v.imageUrl || line.imageUrl,
    label: label || line.label,
  };
}

/**
 * @param {object} line
 * @param {{ searchVariants: (q: string, opts?: object) => Promise<{ nodes?: unknown[] }>, variantCache?: { delete?: (c: string) => Promise<void>, put?: (c: string, o: object) => Promise<void> }, includeImages?: boolean }} ctx
 */
export async function tryRefreshInventoryRowFromShopify(line, { searchVariants, variantCache, includeImages = false } = {}) {
  const oldInv = String(line?.inventoryItemId || "").trim();
  const barcodeRaw = String(line?.barcode || "").trim();
  const skuRaw = String(line?.sku || "").trim();

  async function fetchFresh(rawQuery, pickNormSource) {
    const norm = normalizeScanCodeForRetry(pickNormSource || rawQuery);
    if (!norm) return null;
    try {
      await variantCache?.delete?.(norm);
    } catch (_) {}
    const res = await searchVariants(rawQuery, { includeImages });
    const nodes = Array.isArray(res?.nodes) ? res.nodes : [];
    const v = pickBestVariantFromSearchList(norm, nodes);
    if (!v?.variantId || !v?.inventoryItemId) return null;
    if (String(v.inventoryItemId).trim() === oldInv) return null;
    return v;
  }

  let v = await fetchFresh(barcodeRaw, barcodeRaw);
  if (!v) v = await fetchFresh(skuRaw, skuRaw);
  if (!v) return null;

  const merged = mergeInventoryRowWithResolvedVariant(line, v);
  if (!merged) return null;

  const cacheObj = {
    variantId: merged.variantId,
    inventoryItemId: merged.inventoryItemId,
    sku: merged.sku || "",
    barcode: merged.barcode || "",
    productTitle: merged.productTitle || "",
    variantTitle: merged.variantTitle || "",
    imageUrl: merged.imageUrl || "",
  };
  const keys = new Set(
    [
      normalizeScanCodeForRetry(merged.barcode),
      normalizeScanCodeForRetry(merged.sku),
      normalizeScanCodeForRetry(barcodeRaw),
      normalizeScanCodeForRetry(skuRaw),
    ].filter(Boolean)
  );
  for (const k of keys) {
    try {
      await variantCache?.put?.(k, cacheObj);
    } catch (_) {}
  }
  return merged;
}

export async function refreshInventoryRowsByItemIds(lines, problematicIds, ctx) {
  const idSet =
    problematicIds instanceof Set
      ? problematicIds
      : new Set(
          Array.isArray(problematicIds)
            ? problematicIds.map((x) => String(x || "").trim()).filter(Boolean)
            : []
        );

  let changed = 0;
  const next = [];

  for (const line of lines) {
    const inv = String(line?.inventoryItemId || "").trim();
    if (!idSet.has(inv)) {
      next.push(line);
      continue;
    }
    const refreshed = await tryRefreshInventoryRowFromShopify(line, ctx);
    if (refreshed) {
      next.push(refreshed);
      changed++;
    } else {
      next.push(line);
    }
  }

  return { lines: next, changed };
}

/**
 * @param {object} options
 * @param {unknown[]} options.initialRows — inventoryItemId / sku / barcode を持つ行（quantity は任意）
 * @param {(uniqueIds: string[], workingRows: unknown[]) => Promise<{ ok?: boolean, activated?: Array<{ inventoryItemId?: string }>, errors?: Array<{ inventoryItemId?: string, message?: string }> }>} options.runActivate
 * @param {(q: string, opts?: object) => Promise<{ nodes?: unknown[] }>} options.searchVariants
 * @param {{ delete?: (c: string) => Promise<void>, put?: (c: string, o: object) => Promise<void> }} [options.variantCache]
 * @param {(rows: unknown[]) => void} [options.setRows]
 * @param {(msg: string) => void} [options.toastFn]
 * @param {string} [options.phaseLabel]
 * @param {number} [options.maxAttempts]
 */
export async function ensureInventoryActivatedWithSkuBarcodeRetry({
  initialRows,
  runActivate,
  searchVariants,
  variantCache,
  setRows,
  toastFn,
  phaseLabel = "在庫追跡有効化",
  maxAttempts = 3,
}) {
  let working = initialRows.map((r) => ({ ...r }));

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const inventoryItemIds = working
      .map((r) => String(r?.inventoryItemId || "").trim())
      .filter(Boolean);
    if (inventoryItemIds.length === 0) {
      return { ok: true, rows: working };
    }

    const requestedUnique = [...new Set(inventoryItemIds)];

    if (typeof toastFn === "function") {
      toastFn(
        attempt === 0
          ? `${phaseLabel}中... (${inventoryItemIds.length}件)`
          : `${phaseLabel}中... 再試行 (${attempt + 1}/${maxAttempts})`
      );
    }

    const activateResult = await runActivate(requestedUnique, working);

    const activatedSet = new Set(
      (activateResult?.activated || [])
        .map((a) => String(a?.inventoryItemId || "").trim())
        .filter(Boolean)
    );
    const errorIds = new Set(
      (activateResult?.errors || [])
        .map((e) => String(e?.inventoryItemId || "").trim())
        .filter(Boolean)
    );
    const missingFromActivated = requestedUnique.filter((id) => !activatedSet.has(id));
    const problematicIds = new Set([...errorIds, ...missingFromActivated]);

    const fullyCovered = activateResult?.ok === true && missingFromActivated.length === 0;

    if (fullyCovered) {
      if (typeof toastFn === "function") {
        toastFn(`${phaseLabel}完了 (${requestedUnique.length}件)`);
      }
      if (typeof setRows === "function") setRows(working);
      return { ok: true, rows: working };
    }

    if (attempt >= maxAttempts - 1) {
      const errorDetails = (activateResult?.errors || [])
        .map((e) => {
          const meta = working.find(
            (l) => String(l?.inventoryItemId || "").trim() === String(e?.inventoryItemId || "").trim()
          );
          const itemName =
            meta?.productTitle || meta?.title || meta?.label || e?.inventoryItemId || "不明";
          return `${itemName}: ${e?.message || ""}`;
        })
        .filter(Boolean);
      let msg = `${phaseLabel}に失敗しました`;
      if (errorDetails.length) msg += `:\n${errorDetails.join("\n")}`;
      else if (missingFromActivated.length) {
        msg += `（無効な在庫アイテムIDの可能性: ${missingFromActivated.length}件）`;
      }
      if (typeof toastFn === "function") toastFn(msg);
      return { ok: false, rows: working, message: msg };
    }

    if (problematicIds.size === 0) {
      const msg = `${phaseLabel}に失敗しました（想定外の応答です）`;
      if (typeof toastFn === "function") toastFn(msg);
      return { ok: false, rows: working, message: msg };
    }

    if (typeof toastFn === "function") {
      toastFn("有効化エラーのため、SKU/バーコードで再検索してIDを更新します…");
    }

    const refreshResult = await refreshInventoryRowsByItemIds(working, problematicIds, {
      searchVariants,
      variantCache,
      includeImages: false,
    });

    if (refreshResult.changed === 0) {
      const msg = `${phaseLabel}に失敗しました（SKU/バーコードでの再検索でもIDを更新できませんでした）`;
      if (typeof toastFn === "function") toastFn(msg);
      return { ok: false, rows: working, message: msg };
    }

    working = refreshResult.lines;
    if (typeof setRows === "function") setRows(working);
    if (typeof toastFn === "function") {
      toastFn(`商品IDを ${refreshResult.changed} 件更新しました。もう一度有効化します…`);
    }
  }

  return { ok: false, rows: working, message: `${phaseLabel}に失敗しました（再試行上限）` };
}
