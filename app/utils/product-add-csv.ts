export const PRODUCT_ADD_COMMANDS = ["search", "collections", "collectionProducts", "csv"];
export type ProductCsvRow = { rowNumber: number; sku: string; quantity: number; error?: string };
/** RFC4180の引用符・BOM・改行を処理する。数量の丸めや不正値→1への補完は行わない。 */
export function parseProductCsv(input: string): ProductCsvRow[] {
  if (typeof input !== "string" || input.length > 1024 * 1024 || new TextEncoder().encode(input).length > 1024 * 1024) throw new Error("CSVは1MB以下でアップロードしてください");
  const source = input.replace(/^\uFEFF/, "");
  const records: { cells: string[]; line: number }[] = [];
  let cells: string[] = [], value = "", quoted = false, closed = false, line = 1, start = 1;
  const finish = () => { cells.push(value.trim()); if (cells.some(Boolean)) records.push({ cells, line: start }); cells = []; value = ""; closed = false; start = line + 1; };
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) { if (char === '"') { if (source[i + 1] === '"') { value += '"'; i++; } else { quoted = false; closed = true; } } else { value += char; if (char === "\n") line++; } continue; }
    if (char === '"') { if (value.trim() || closed) throw new Error(`${line}行目の引用符を確認してください`); value = ""; quoted = true; }
    else if (char === ",") { cells.push(value.trim()); value = ""; closed = false; }
    else if (char === "\n" || char === "\r") { if (char === "\r" && source[i + 1] === "\n") i++; finish(); line++; }
    else { if (closed && char.trim()) throw new Error(`${line}行目の引用符の後に文字があります`); value += char; }
  }
  if (quoted) throw new Error(`${start}行目の引用符が閉じていません`);
  if (value || cells.length) finish();
  if (records[0]?.cells[0]?.toLowerCase() === "sku" && [undefined, "", "数量", "quantity"].includes(records[0].cells[1]?.toLowerCase())) records.shift();
  if (!records.length) throw new Error("CSVデータが空です。SKU,数量の行を入力してください");
  if (records.length > 3000) throw new Error("CSVは3000行以内に分けてください");
  const counts = new Map<string, number>(); for (const { cells } of records) counts.set(cells[0], (counts.get(cells[0]) || 0) + 1);
  return records.map(({ cells, line: rowNumber }) => {
    const sku = cells[0] || "", raw = cells[1] || "", quantity = raw === "" ? 1 : Number(raw);
    const error = cells.length > 2 ? "列はSKU,数量の2列で入力してください" : !sku ? "SKUがありません" : sku.length > 512 ? "SKUが長すぎます" : counts.get(sku)! > 1 ? "CSV内でSKUが重複しています。1行にまとめてください" : !/^\d*$/.test(raw) || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 999999 ? "数量は1〜999999の整数で入力してください" : undefined;
    return { rowNumber, sku, quantity, ...(error ? { error } : {}) };
  });
}
