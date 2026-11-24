/** Pure product-list updates; all quantities and identity checks precede draft writes. */
export function addReservationProduct(draft, product, quantity = 1) {
  if (!product?.id || product.eligible === false) throw new Error("この店舗で在庫追跡している商品を選んでください");
  const increment = Number(quantity);
  if (!Number.isInteger(increment) || increment < 1) throw new Error("数量は1以上の整数で入力してください");
  const existing = draft.lines.find(line => line.variantId === product.id);
  if (!existing && draft.lines.length >= 250) throw new Error("商品は250種類までです");
  if ((existing?.quantity || 0) + increment > 9999) throw new Error("数量は9999以下で入力してください");
  return { ...draft, lines: existing ? draft.lines.map(line => line.variantId === product.id ? { ...line, quantity: line.quantity + increment } : line) : [
    { variantId: product.id, title: product.displayName, productTitle: product.productTitle, variantTitle: product.variantTitle, sku: product.sku, barcode: product.barcode, imageUrl: product.imageUrl, available: product.available, quantity: increment }, ...draft.lines,
  ] };
}
export function exactScanProduct(code, products, pageInfo = {}) {
  if (pageInfo.hasNextPage) throw new Error("同じコードの候補が多いため、検索結果から商品を選んでください");
  const value = String(code || "").trim();
  const barcode = products.filter(product => String(product.barcode || "").trim() === value);
  const matches = barcode.length ? barcode : products.filter(product => String(product.sku || "").trim() === value);
  if (matches.length !== 1) throw new Error(matches.length ? "同じコードの商品が複数あります。検索結果から選んでください" : "コードに一致する商品が見つかりません");
  return matches[0];
}
export function createReservationScanQueue({ resolve, commit, onError, now = Date.now }) {
  const queue = []; let working = false, active = true, lastCode = "", lastTime = -Infinity;
  const drain = async () => {
    if (working || !active) return;
    working = true;
    try {
      while (active && queue.length) {
        const code = queue.shift();
        try { const product = await resolve(code); if (active) await commit(product); } catch (error) { if (active) onError(error); }
      }
    } finally { working = false; }
  };
  return {
    enqueue(raw) { const code = String(raw || "").trim(); if (!active || !code) return; const time = now(); if (code === lastCode && time - lastTime < 350) return; lastCode = code; lastTime = time; queue.push(code); void drain(); },
    stop() { active = false; queue.length = 0; },
  };
}
