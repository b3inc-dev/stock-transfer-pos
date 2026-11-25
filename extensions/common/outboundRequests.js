const invalid = message => Object.assign(new Error(message), { code: "OUTBOUND_VALIDATION" });
export const OUTBOUND_REQUEST_LABELS = Object.freeze({ draft: "下書き", requested: "依頼中", working: "作業中", processing: "出庫処理中", uncertain: "要確認", retryable: "再開待ち", completed: "出庫完了", cancelled: "取消済み" });
export function outboundRequestTone(status) {
  if (status === "completed") return "success";
  if (["uncertain", "retryable"].includes(status)) return "warning";
  if (["requested", "working", "processing"].includes(status)) return "info";
  return "neutral";
}
export const DEFAULT_OUTBOUND_REQUEST_POLICY = Object.freeze({ allowUnder: false, underReason: "required", allowOver: false, overReason: "required", allowExtra: false, extraReason: "required", paperWidth: 80 });
/** @param {unknown} value */
export function normalizeOutboundRequestPolicy(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("差異設定を確認してください");
  const input = value;
  const result = { ...DEFAULT_OUTBOUND_REQUEST_POLICY };
  if (input.paperWidth !== undefined) {
    if (![58, 80].includes(input.paperWidth)) throw invalid("用紙幅は58mmか80mmを選択してください");
    result.paperWidth = input.paperWidth;
  }
  for (const key of ["allowUnder", "allowOver", "allowExtra"]) {
    if (input[key] !== undefined && typeof input[key] !== "boolean") throw invalid("許可設定を確認してください");
    if (input[key] !== undefined) result[key] = input[key];
  }
  for (const key of ["underReason", "overReason", "extraReason"]) {
    if (input[key] !== undefined && !["none", "optional", "required"].includes(input[key])) throw invalid("理由の設定を確認してください");
    if (input[key] !== undefined) result[key] = input[key];
  }
  return result;
}
export function outboundQuantity(value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 999999) throw invalid("数量は0〜999999の整数で入力してください");
  return value;
}
export function validOutboundDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
/** Keep requested quantities immutable. Extra products are a separate rule, not overages. */
export function validateOutboundActual(requested, actual, inputPolicy) {
  if (!Array.isArray(actual) || actual.length > 3000) throw invalid("検品明細を確認してください（最大3000件）");
  const policy = normalizeOutboundRequestPolicy(inputPolicy), values = new Map();
  for (const row of actual) {
    if (!/^gid:\/\/shopify\/InventoryItem\/\d+$/.test(row.inventoryItemId) || values.has(row.inventoryItemId)) throw invalid("商品IDまたは重複した明細を確認してください");
    const quantity = outboundQuantity(row.quantity);
    if (typeof row.reason !== "string" || row.reason.length > 500) throw invalid("理由は500文字以内で入力してください");
    values.set(row.inventoryItemId, { inventoryItemId: row.inventoryItemId, quantity, reason: row.reason.trim() });
  }
  const requestedIds = new Set(requested.map(row => row.inventoryItemId));
  const lines = requested.map(row => ({ ...row, requested: row.quantity, ...values.get(row.inventoryItemId), quantity: values.get(row.inventoryItemId)?.quantity ?? 0, reason: values.get(row.inventoryItemId)?.reason ?? "" }));
  for (const row of values.values()) if (!requestedIds.has(row.inventoryItemId) && row.quantity > 0) lines.push({ ...row, requested: 0 });
  const differences = [];
  for (const row of lines) {
    const kind = row.requested === 0 ? "extra" : row.quantity < row.requested ? "under" : row.quantity > row.requested ? "over" : null;
    if (!kind) { row.reason = ""; continue; }
    const allowed = policy[{ under: "allowUnder", over: "allowOver", extra: "allowExtra" }[kind]];
    if (!allowed) throw invalid(`${{ under: "過少出庫", over: "過剰出庫", extra: "依頼にない商品の追加" }[kind]}は許可されていません`);
    if (policy[`${kind}Reason`] === "required" && !row.reason) throw invalid("差異がある商品ごとに理由を入力してください");
    if (policy[`${kind}Reason`] === "none") row.reason = "";
    differences.push({ ...row, kind, delta: row.quantity - row.requested });
  }
  if (!lines.some(row => row.quantity > 0)) throw invalid("出庫する数量を入力してください");
  return { lines, differences };
}
export function outboundChunks(lines) {
  const positive = lines.filter(row => row.quantity > 0), chunks = [];
  for (let i = 0; i < positive.length; i += 250) chunks.push(positive.slice(i, i + 250));
  return chunks;
}
const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export function renderOutboundRequestReceipt(row, paperWidth = 80) {
  const actual = new Map((row.actualLines || []).map(line => [line.inventoryItemId, line]));
  const lines = [...row.lines, ...(row.actualLines || []).filter(line => !row.lines.some(item => item.inventoryItemId === line.inventoryItemId)).map(line => ({ ...line, quantity: 0 }))];
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>出庫依頼書</title><style>body{font:14px sans-serif;max-width:100%;width:${paperWidth === 58 ? 384 : 576}px;margin:0 auto;color:#000;background:#fff;overflow-wrap:anywhere}h1{font-size:20px}table{width:100%;border-collapse:collapse}td{border-bottom:1px solid;padding:8px 0;vertical-align:top}td:last-child{text-align:right;white-space:nowrap}small{display:block}p{white-space:pre-wrap}</style></head><body><h1>出庫依頼書</h1><p>${escape(row.number)}・版${escape(row.version)}<br>出庫元 ${escape(row.originName)}<br>移動先 ${escape(row.destinationName)}<br>希望日 ${escape(row.dueDate || "指定なし")}<br>${escape(OUTBOUND_REQUEST_LABELS[row.status])}</p><table><tbody>${lines.map(line => `<tr><td>${escape(line.title)}<small>SKU: ${escape(line.sku)}<br>JAN: ${escape(line.barcode)}</small>${actual.has(line.inventoryItemId) ? `<small>理由: ${escape(actual.get(line.inventoryItemId).reason)}</small>` : ""}</td><td>依頼 ${escape(line.quantity)}${actual.has(line.inventoryItemId) ? `<br>${row.status === "completed" ? "出庫" : "検品"} ${escape(actual.get(line.inventoryItemId).quantity)}` : ""}</td></tr>`).join("")}</tbody></table><p>${escape(row.note)}</p></body></html>`;
}
