/**
 * ロス・仕入れなど「増減（delta）だけ」の明細を、今の在庫数から「変えたあとの数（quantityAfter）」に直す。
 *
 * 今の在庫数を読めなかったときに 0 として扱うと、在庫が「0 からの増減」で書き換わる
 * （例: 10 個あるのにロス 1 個で -1 個になる）。なので、読めなかったときは数を作らずに失敗として返す。
 * この段階ではイベントも作らず Shopify にも書かないので、同じ appEventId で送り直してよい。
 *
 * 外の import を持たない（テストからそのまま読み込めるようにするため）。
 */

export type CurrentQuantityRead =
  | { ok: true; quantity: number }
  | { ok: false; retryable: boolean; error: string };

type QuantityRow = { name?: string | null; quantity?: number | null } | null | undefined;
type CurrentQuantityJson = {
  data?: {
    inventoryItem?: {
      inventoryLevel?: { quantities?: QuantityRow[] | null } | null;
    } | null;
  } | null;
  errors?: Array<{ message?: string }> | unknown;
};

function firstErrorMessage(json: CurrentQuantityJson | null | undefined): string {
  const errors = json?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const msg = (errors[0] as { message?: unknown })?.message;
    return typeof msg === "string" && msg.trim() ? msg.trim() : "GraphQL error";
  }
  return "";
}

/**
 * `inventoryItem(id).inventoryLevel(locationId).quantities(["available"])` の応答を読む。
 * - 商品はあるが、その店に在庫の記録が無い（inventoryLevel が null）→ 0（このあと在庫を有効にしてから set する）
 * - HTTP の失敗・GraphQL の errors・data が無い・available が無い → 読めなかった（送り直してよい）
 * - 商品そのものが見つからない（inventoryItem が null）→ 読めなかった（送り直しても同じ）
 */
export function readAvailableFromResponse(
  httpOk: boolean,
  httpStatus: number,
  json: unknown
): CurrentQuantityRead {
  const body = (json && typeof json === "object" ? json : {}) as CurrentQuantityJson;
  const gqlError = firstErrorMessage(body);
  if (!httpOk) {
    return { ok: false, retryable: true, error: gqlError || `HTTP ${httpStatus}` };
  }
  if (gqlError) {
    return { ok: false, retryable: true, error: gqlError };
  }
  const data = body.data;
  if (!data || typeof data !== "object") {
    return { ok: false, retryable: true, error: "在庫数の応答に data がありません" };
  }
  const item = data.inventoryItem;
  if (item === null) {
    return { ok: false, retryable: false, error: "在庫アイテムが見つかりません" };
  }
  if (!item || typeof item !== "object") {
    return { ok: false, retryable: true, error: "在庫数の応答に inventoryItem がありません" };
  }
  if (item.inventoryLevel === null) {
    return { ok: true, quantity: 0 };
  }
  const rows = item.inventoryLevel?.quantities;
  const row = Array.isArray(rows) ? rows.find((x) => x?.name === "available") : null;
  const quantity = Number(row?.quantity);
  if (row?.quantity == null || !Number.isFinite(quantity)) {
    return { ok: false, retryable: true, error: "在庫数の応答に available がありません" };
  }
  return { ok: true, quantity };
}

export type DeltaEntry = {
  inventoryItemId: string;
  quantityAfter?: number | null;
  quantityBefore?: number | null;
  delta?: number | null;
};

export type NormalizeDeltaResult<T> =
  | { ok: true; entries: Array<T & { quantityAfter: number; quantityBefore?: number }> }
  | { ok: false; retryable: boolean; error: string; inventoryItemId: string };

/**
 * quantityAfter が無く delta だけの明細は、今の在庫数 + delta にする。
 * 1 件でも今の在庫数を読めなければ、どの明細も変えずに失敗を返す（一部の商品だけ動かさない）。
 * quantityAfter も delta も無い明細は除く（これまでと同じ）。
 */
export async function normalizeDeltaEntries<T extends DeltaEntry>(
  entries: T[],
  readCurrent: (inventoryItemId: string) => Promise<CurrentQuantityRead>
): Promise<NormalizeDeltaResult<T>> {
  const out: Array<T & { quantityAfter: number; quantityBefore?: number }> = [];
  for (const e of entries) {
    let qtyAfter = e.quantityAfter ?? null;
    let qtyBefore = e.quantityBefore ?? null;
    if (qtyAfter == null && e.delta != null) {
      let read: CurrentQuantityRead;
      try {
        read = await readCurrent(e.inventoryItemId);
      } catch (err: unknown) {
        read = { ok: false, retryable: true, error: err instanceof Error ? err.message : String(err) };
      }
      if (!read.ok) {
        return { ok: false, retryable: read.retryable, error: read.error, inventoryItemId: e.inventoryItemId };
      }
      qtyBefore = read.quantity;
      qtyAfter = read.quantity + Number(e.delta);
    }
    if (qtyAfter == null) continue;
    out.push({ ...e, quantityAfter: qtyAfter, quantityBefore: qtyBefore ?? undefined });
  }
  return { ok: true, entries: out };
}

export const CURRENT_QUANTITY_UNREADABLE_MESSAGE =
  "今の在庫数を Shopify から読めなかったため、在庫は変えていません。少し待ってから同じ内容でもう一度「確定」を押してください（同じ確定のため在庫は二重に変わりません）。";

export const INVENTORY_ITEM_NOT_FOUND_MESSAGE =
  "在庫アイテムが Shopify で見つからなかったため、在庫は変えていません。商品を確かめてください。";
