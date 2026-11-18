/**
 * サーバー側で Shopify inventorySetQuantities を実行する共通ロジック
 * api.inventory.apply-change および app.inventory-count から利用
 * 失敗しないための追求: 429/5xx 時にリトライする。
 */

import type {
  GraphQLUserError,
  InventorySetQuantitiesJson,
  InventoryAdjustQuantitiesJson,
} from "../types/graphql-responses";
import { isDefiniteUnaappliedRejection } from "./apply-change-outer-catch-guard";
import { readAvailableFromResponse, type CurrentQuantityRead } from "./current-quantity-read";

const INVENTORY_SET_QUANTITIES_MAX = 250;

/** Shopify API 呼び出しの最大リトライ回数（一時的なレート制限・サーバーエラー対策） */
const SHOPIFY_API_RETRY_MAX = 3;
/** リトライ間隔（ミリ秒）。指数バックオフ 1s → 2s */
const SHOPIFY_API_RETRY_DELAY_MS = 1000;

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 503 || (status >= 500 && status < 600);
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export type AdminGraphql = (query: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response>;

/**
 * admin.graphql を 429/5xx 時にリトライして実行し、レスポンスと JSON を返す。
 */
async function graphqlWithRetry(
  admin: { graphql: AdminGraphql },
  query: string,
  variables?: Record<string, unknown>,
  shouldRetryStatus: (status: number) => boolean = isRetryableStatus
): Promise<{ response: Response; json: unknown }> {
  let lastResp: Response | null = null;
  for (let attempt = 1; attempt <= SHOPIFY_API_RETRY_MAX; attempt++) {
    const response = await admin.graphql(query, { variables });
    lastResp = response;
    if (response.ok) {
      const json = await response.json().catch(() => ({}));
      return { response, json };
    }
    if (!shouldRetryStatus(response.status) || attempt >= SHOPIFY_API_RETRY_MAX) {
      const json = await response.json().catch(() => ({}));
      return { response, json };
    }
    const waitMs = SHOPIFY_API_RETRY_DELAY_MS * Math.min(attempt, 2);
    console.warn(
      `[inventory-set-quantities-server] GraphQL attempt ${attempt}/${SHOPIFY_API_RETRY_MAX} failed (status=${response.status}), retrying in ${waitMs}ms`
    );
    await delay(waitMs);
  }
  const json = await lastResp?.json().catch(() => ({})) ?? {};
  return { response: lastResp!, json };
}

function toRawId(id: string | number | null | undefined): string {
  if (id == null) return "";
  const s = String(id).trim();
  if (s.startsWith("gid://")) {
    const last = s.split("/").pop();
    return last || s;
  }
  return s;
}

function toLocationGid(locationId: string): string {
  const s = String(locationId || "").trim();
  if (s.startsWith("gid://")) return s;
  const raw = toRawId(locationId);
  return raw ? `gid://shopify/Location/${raw}` : s;
}

function toInventoryItemGid(inventoryItemId: string): string | null {
  const str = String(inventoryItemId || "").trim();
  if (!str) return null;
  if (/^\d+$/.test(str)) return `gid://shopify/InventoryItem/${str}`;
  if (str.includes("gid://")) return str;
  return null;
}

/**
 * 1 商品・1 店の今の available を読む（この file で今の在庫数を読むのはここだけ）。
 * 読み方は `readAvailableFromResponse` に合わせる:
 * その店に在庫の記録が無い（inventoryLevel が null）ときだけ 0、それ以外の失敗は「読めなかった」。
 */
async function readAvailableAt(
  admin: { graphql: AdminGraphql },
  locationGid: string,
  itemGid: string
): Promise<CurrentQuantityRead> {
  try {
    const { response, json } = await graphqlWithRetry(admin, `#graphql
        query Cur($id: ID!, $loc: ID!) {
          inventoryItem(id: $id) {
            inventoryLevel(locationId: $loc) {
              quantities(names: ["available"]) { name quantity }
            }
          }
        }
      `, { id: itemGid, loc: locationGid });
    return readAvailableFromResponse(response.ok, response.status, json);
  } catch (e: unknown) {
    return { ok: false, retryable: true, error: e instanceof Error ? e.message : String(e) };
  }
}

type ChunkSnapshot = Array<{ inventoryItemId: string; quantity: number }>;

/**
 * 元に戻す用に、チャンクの商品の今の数を控える。
 * 1 件でも読めなければ、0 にせず失敗を返す（0 で控えると、戻すときにその商品が 0 に書き換わる）。
 */
async function readChunkSnapshot(
  admin: { graphql: AdminGraphql },
  locationGid: string,
  inventoryItemGids: string[]
): Promise<
  | { ok: true; snapshot: ChunkSnapshot }
  | { ok: false; retryable: boolean; error: string; inventoryItemId: string }
> {
  const snapshot: ChunkSnapshot = [];
  for (const itemGid of inventoryItemGids) {
    const read = await readAvailableAt(admin, locationGid, itemGid);
    if (!read.ok) {
      return { ok: false, retryable: read.retryable, error: read.error, inventoryItemId: itemGid };
    }
    snapshot.push({ inventoryItemId: itemGid, quantity: read.quantity });
  }
  return { ok: true, snapshot };
}

export type SetInventoryQuantitiesResult = {
  ok: boolean;
  invalidCount?: number;
  error?: string;
  rolledBack?: boolean;
  /** チャンク分割で一部適用が残り、ロールバックできなかった / 適用有無が不明 */
  partiallyApplied?: boolean;
  /**
   * true: mutation 送信後に timeout/5xx/network 等で成否不明。
   * 自動再 set 禁止のため partiallyApplied と併用する。appliedInventoryItemIds は不完全な場合あり。
   */
  applicationUncertain?: boolean;
  /** Shopify に set できた inventoryItem GID（成功チャンク分。rollback 成功時は空） */
  appliedInventoryItemIds?: string[];
  /** 失敗したチャンク index（0-based）。部分失敗時のみ */
  failedChunkIndex?: number;
  /**
   * true: 250 件を超える補正で、元に戻す用の今の数を読めなかったので、在庫を 1 件も動かさずに止めた。
   * retryable が true なら、同じ内容で送り直してよい（在庫は動いていない）。
   */
  snapshotUnreadable?: boolean;
  retryable?: boolean;
};

/**
 * 在庫数を指定値に設定（inventorySetQuantities）。250件超はチャンク分割。
 * チャンク N が失敗した場合、適用済みチャンク 1..N-1 を元の数量に戻すロールバックを試みる。
 */
export async function setInventoryQuantitiesServer(
  admin: { graphql: AdminGraphql },
  locationId: string,
  items: Array<{ inventoryItemId: string; quantity: number }>,
  referenceDocumentUri?: string | null
): Promise<SetInventoryQuantitiesResult> {
  const locationGid = toLocationGid(locationId);
  const quantities = (items ?? [])
    .filter((x) => x?.inventoryItemId && Number.isFinite(Number(x?.quantity)))
    .map((x) => {
      const gid = toInventoryItemGid(x.inventoryItemId);
      const quantity = Math.floor(Number(x.quantity) ?? 0);
      return gid ? { valid: true as const, inventoryItemId: gid, quantity } : { valid: false as const };
    });
  const validQuantities = quantities.filter((q) => q.valid);
  const invalidCount = quantities.filter((q) => !q.valid).length;
  if (validQuantities.length === 0) {
    return { ok: false, invalidCount, error: "有効な在庫アイテムがありません", appliedInventoryItemIds: [] };
  }
  const refUri =
    referenceDocumentUri == null || referenceDocumentUri === ""
      ? undefined
      : String(referenceDocumentUri).trim().startsWith("gid://")
        ? referenceDocumentUri.trim()
        : `gid://stock-transfer-pos/InventoryCount/${referenceDocumentUri}`;

  const chunks: Array<typeof validQuantities> = [];
  for (let i = 0; i < validQuantities.length; i += INVENTORY_SET_QUANTITIES_MAX) {
    chunks.push(validQuantities.slice(i, i + INVENTORY_SET_QUANTITIES_MAX));
  }

  // 元に戻す用の控え（250 件を超えるときだけ）。
  // あとのチャンクがはっきり断られたら、先に入れたチャンクをこの数に戻す。
  // 戻すことがあるのは最後より前のチャンクだけなので、その分を「1 件も動かす前に」全部読む。
  // 1 件でも読めなければ補正を始めない（0 で控えると、戻すときにその商品が 0 に書き換わるため）。
  const snapshots: ChunkSnapshot[] = [];
  for (let ci = 0; ci < chunks.length - 1; ci++) {
    const read = await readChunkSnapshot(
      admin,
      locationGid,
      chunks[ci].map((q) => q.inventoryItemId)
    );
    if (!read.ok) {
      console.warn(
        `[inventory-set-quantities-server] 元に戻す用の数を読めないため補正を始めません（在庫は動かしていません）: ` +
          `chunk${ci} item=${read.inventoryItemId} error=${read.error}`
      );
      return {
        ok: false,
        error: read.error,
        rolledBack: false,
        snapshotUnreadable: true,
        retryable: read.retryable,
        appliedInventoryItemIds: [],
      };
    }
    snapshots.push(read.snapshot);
  }

  /** 成功確定したチャンクの inventoryItem GID（rollback 前まで蓄積） */
  const appliedInventoryItemIds: string[] = [];
  /**
   * いま Shopify にあるはずの数（このアプリが最後に書いた数）。
   * 戻すときの changeFromQuantity に入れ、書いたあとにだれかが動かしていたら Shopify に断ってもらう。
   */
  const lastWritten = new Map<string, number>();

  try {
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      const chunk = chunks[chunkIndex];
      const chunkItemGids = chunk.map((q) => q.inventoryItemId);

      const input: Record<string, unknown> = {
        name: "available",
        reason: "correction",
        quantities: chunk.map((q) => ({
          inventoryItemId: q.inventoryItemId,
          locationId: locationGid,
          quantity: q.quantity,
          changeFromQuantity: null,
        })),
      };
      if (refUri) input.referenceDocumentUri = refUri;

      let chunkFailed = false;
      let chunkError = "";
      let chunkHadUserErrors = false;
      try {
        const { response: resp, json } = await graphqlWithRetry(admin, `#graphql
            mutation InventorySetQuantities($input: InventorySetQuantitiesInput!) {
              inventorySetQuantities(input: $input) {
                inventoryAdjustmentGroup { id }
                userErrors { field message }
              }
            }
          `, { input });
        const errJson = json as InventorySetQuantitiesJson;
        const topLevelErrors = Array.isArray(errJson?.errors) ? errJson.errors : [];
        const data = errJson?.data?.inventorySetQuantities;
        if (!resp.ok) {
          chunkError = topLevelErrors[0]?.message ?? resp.statusText ?? `HTTP ${resp.status}`;
          chunkFailed = true;
          // HTTP エラーは適用済みの可能性を否定できない（userErrors なし）
        } else if (topLevelErrors.length > 0 && !data) {
          // HTTP 200 + top-level GraphQL errors / null data — 成功扱いにしない
          chunkError = topLevelErrors.map((e) => e?.message ?? "").filter(Boolean).join(" / ") || "GraphQL errors";
          chunkFailed = true;
        } else {
          const errs = data?.userErrors ?? [];
          if (errs.length) {
            chunkError = errs.map((e: GraphQLUserError) => e.message ?? "").join(" / ");
            chunkFailed = true;
            chunkHadUserErrors = true;
          }
        }
      } catch (e) {
        chunkError = e instanceof Error ? e.message : String(e);
        chunkFailed = true;
      }

      if (chunkFailed) {
        // userErrors 以外はすべて ambiguous（キーワード漏れで failed→再 set しない）
        const ambiguous = !isDefiniteUnaappliedRejection({ hadUserErrors: chunkHadUserErrors });
        // 成否不明: 自動再 set を避けるため partial 扱い。ロールバックもしない
        // （成功済み先行チャンクを戻すと、失敗チャンクが実は適用済みだった場合に更に壊れる）
        if (ambiguous) {
          console.error(
            `[inventory-set-quantities-server] ambiguous chunk${chunkIndex} failure (treat as partial/uncertain): ${chunkError}`
          );
          return {
            ok: false,
            error: chunkError,
            rolledBack: false,
            partiallyApplied: true,
            applicationUncertain: true,
            // 先行成功分は確実。当該チャンクは不明のため含めない
            appliedInventoryItemIds: [...appliedInventoryItemIds],
            failedChunkIndex: chunkIndex,
          };
        }

        if (chunkIndex === 0) {
          // 最初のチャンクが確定失敗（userErrors 等）— ロールバック不要
          return {
            ok: false,
            error: chunkError,
            rolledBack: false,
            appliedInventoryItemIds: [],
            failedChunkIndex: chunkIndex,
          };
        }

        // 先に入れたチャンク（0..chunkIndex-1）を、控えた数へ逆順に戻す。
        // 戻す書き込みは「いまが、さっき書いた数のままなら」の条件付き（changeFromQuantity）。
        // 書いたあとに売れた・入庫した商品があると Shopify が CHANGE_FROM_QUANTITY_STALE で断るので、
        // そのチャンクは戻さず（入ったまま）partial_failed にして管理者に回す（その売上・入庫を消さない）。
        let rollbackFailedAt = -1;
        let rollbackRefused = false;
        let rollbackStale = false;
        let rollbackErrorMsg = "";
        for (let ri = chunkIndex - 1; ri >= 0; ri--) {
          const rollbackInput: Record<string, unknown> = {
            name: "available",
            reason: "correction",
            quantities: snapshots[ri].map((q) => ({
              inventoryItemId: q.inventoryItemId,
              locationId: locationGid,
              quantity: q.quantity,
              changeFromQuantity: lastWritten.get(q.inventoryItemId) ?? null,
            })),
          };
          try {
            // 送り直すのは 429（Shopify が受け付けていない）だけ。5xx のあとに送り直すと、
            // 1 回目が入っていた場合に 2 回目が STALE で断られ、「戻せなかった」と取り違えるため。
            const { response: rbResp, json: rbJson } = await graphqlWithRetry(admin, `#graphql
                mutation InventorySetQuantities($input: InventorySetQuantitiesInput!) {
                  inventorySetQuantities(input: $input) {
                    inventoryAdjustmentGroup { id }
                    userErrors { field message code }
                  }
                }
              `, { input: rollbackInput }, (status) => status === 429);
            const rbErrJson = rbJson as InventorySetQuantitiesJson;
            const rbTopErrors = Array.isArray(rbErrJson?.errors) ? rbErrJson.errors : [];
            const rbData = rbErrJson?.data?.inventorySetQuantities;
            const rbErrs = rbData?.userErrors ?? [];
            if (!rbResp.ok) {
              rollbackErrorMsg = rbTopErrors[0]?.message ?? rbResp.statusText ?? `HTTP ${rbResp.status}`;
            } else if (rbTopErrors.length > 0 && !rbData) {
              rollbackErrorMsg =
                rbTopErrors.map((e) => e?.message ?? "").filter(Boolean).join(" / ") || "GraphQL errors";
            } else if (rbErrs.length) {
              rollbackErrorMsg = rbErrs.map((e: GraphQLUserError) => e.message ?? "").join(" / ");
              rollbackRefused = true;
              rollbackStale = rbErrs.some(
                (e) => (e as GraphQLUserError & { code?: string | null }).code === "CHANGE_FROM_QUANTITY_STALE"
              );
            } else {
              for (const q of snapshots[ri]) lastWritten.set(q.inventoryItemId, q.quantity);
              continue;
            }
          } catch (rbErr) {
            rollbackErrorMsg = rbErr instanceof Error ? rbErr.message : String(rbErr);
          }
          rollbackFailedAt = ri;
          break;
        }
        if (rollbackFailedAt >= 0) {
          // 戻す途中で失敗: まだ戻していないチャンクは入ったまま。戻せたチャンクは元の数。
          // 失敗したチャンクは、はっきり断られた（userErrors）なら入ったまま、それ以外は戻ったか分からない。
          // 一部だけ反映（partial_failed）にして、同じ ID でも自動で在庫を動かさない（STATE_MACHINE §6）。
          const stillAppliedChunks = rollbackRefused ? rollbackFailedAt + 1 : rollbackFailedAt;
          const stillApplied = chunks
            .slice(0, stillAppliedChunks)
            .flatMap((c) => c.map((q) => q.inventoryItemId));
          console.error(
            `[inventory-set-quantities-server] ロールバック失敗 — 手動復旧が必要です。` +
            ` 元のエラー: ${chunkError}。ロールバックエラー（chunk${rollbackFailedAt}）: ${rollbackErrorMsg}。` +
            ` スナップショット: ${JSON.stringify(snapshots.slice(0, chunkIndex))}`
          );
          return {
            ok: false,
            // 書いたあとに在庫が動いていて戻さなかったときは、管理者が分かるように理由を足す
            error: rollbackStale
              ? `${chunkError}（元に戻す前に店の在庫が動いていたため、戻していません: CHANGE_FROM_QUANTITY_STALE）`
              : chunkError,
            rolledBack: false,
            partiallyApplied: true,
            // 入ったと言い切れるのは stillApplied だけ。戻す処理がはっきり断られたのでなければ、
            // そのチャンクは戻ったか分からないので「不明」（行を failed にしない）
            applicationUncertain: !rollbackRefused,
            appliedInventoryItemIds: stillApplied,
            failedChunkIndex: chunkIndex,
          };
        }
        // ロールバック成功: Shopify 上は適用前に戻った
        return {
          ok: false,
          error: chunkError,
          rolledBack: true,
          appliedInventoryItemIds: [],
          failedChunkIndex: chunkIndex,
        };
      }

      // チャンク成功: 適用済み GID を記録
      for (const gid of chunkItemGids) appliedInventoryItemIds.push(gid);
      for (const q of chunk) lastWritten.set(q.inventoryItemId, q.quantity);
    }
    return {
      ok: true,
      invalidCount: invalidCount > 0 ? invalidCount : undefined,
      rolledBack: false,
      appliedInventoryItemIds,
    };
  } catch (unexpected: unknown) {
    // 適用済みチャンクがあるのに例外が外へ出ると、呼び出し側が failed→再試行で再 set し得る
    const msg = unexpected instanceof Error ? unexpected.message : String(unexpected);
    console.error(
      `[inventory-set-quantities-server] unexpected error after applied=${appliedInventoryItemIds.length}:`,
      msg
    );
    // 予期せぬ例外は成否不明として partial（failed→再 set を避ける）
    return {
      ok: false,
      error: msg || "unexpected error during setQuantities",
      rolledBack: false,
      partiallyApplied: true,
      applicationUncertain: true,
      appliedInventoryItemIds: [...appliedInventoryItemIds],
    };
  }
}

/**
 * 1アイテム・1ロケーションの現在の available 数量を取得する。
 * 読めなかったとき（通信・HTTP・GraphQL の errors・形の違い）は 0 にせず ok:false を返す。
 * 0 にすると、delta の明細（ロス・仕入れ）で在庫が「0 からの増減」に書き換わるため。
 * その店に在庫の記録が無い（inventoryLevel が null）ときだけ 0（このあと在庫を有効にしてから set する）。
 */
export async function fetchCurrentQuantityServer(
  admin: { graphql: AdminGraphql },
  locationId: string,
  inventoryItemId: string
): Promise<CurrentQuantityRead> {
  const locationGid = toLocationGid(locationId);
  const itemGid = toInventoryItemGid(inventoryItemId);
  if (!itemGid) return { ok: false, retryable: false, error: `inventoryItemId が不正です: ${inventoryItemId}` };
  return readAvailableAt(admin, locationGid, itemGid);
}

const INVENTORY_ADJUST_MAX = 250;

/**
 * 相対 delta で在庫を増減（inventoryAdjustQuantities）。ロス・仕入用。
 */
export async function adjustInventoryQuantitiesServer(
  admin: { graphql: AdminGraphql },
  locationId: string,
  changes: Array<{ inventoryItemId: string; delta: number }>,
  referenceDocumentUri?: string | null
): Promise<{ ok: boolean; invalidCount?: number; error?: string }> {
  const locationGid = toLocationGid(locationId);
  const valid = (changes ?? [])
    .filter((c) => c?.inventoryItemId && Number.isFinite(Number(c?.delta)) && Number(c.delta) !== 0)
    .map((c) => {
      const gid = toInventoryItemGid(c.inventoryItemId);
      return gid ? { inventoryItemId: gid, delta: Math.floor(Number(c.delta)) } : null;
    })
    .filter((x): x is { inventoryItemId: string; delta: number } => x != null);
  const invalidCount = (changes ?? []).length - valid.length;
  if (valid.length === 0) {
    // delta=0 のみ、または有効なアイテムが存在しない場合は変更なしで成功として扱う
    return { ok: true, invalidCount };
  }
  const uri = referenceDocumentUri
    ? (referenceDocumentUri.startsWith("gid://") ? referenceDocumentUri : `gid://stock-transfer-pos/LossEntry/${referenceDocumentUri}`)
    : undefined;
  for (let i = 0; i < valid.length; i += INVENTORY_ADJUST_MAX) {
    const chunk = valid.slice(i, i + INVENTORY_ADJUST_MAX);
    const input: Record<string, unknown> = {
      reason: "correction",
      name: "available",
      changes: chunk.map((c) => ({ inventoryItemId: c.inventoryItemId, locationId: locationGid, delta: c.delta })),
    };
    if (uri) input.referenceDocumentUri = uri;
    try {
      const { response: resp, json } = await graphqlWithRetry(admin, `#graphql
          mutation Adjust($input: InventoryAdjustQuantitiesInput!) {
            inventoryAdjustQuantities(input: $input) {
              inventoryAdjustmentGroup { id }
              userErrors { field message }
            }
          }
        `, { input });
      if (!resp.ok) {
        const errJson = json as InventoryAdjustQuantitiesJson;
        const errMsg = errJson?.errors?.[0]?.message ?? resp.statusText ?? `HTTP ${resp.status}`;
        return { ok: false, error: errMsg };
      }
      const adjustData = (json as InventoryAdjustQuantitiesJson)?.data?.inventoryAdjustQuantities;
      const errs = adjustData?.userErrors ?? [];
      if (errs.length) {
        return { ok: false, error: errs.map((e: GraphQLUserError) => e.message ?? "").join(" / ") };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
  }
  return { ok: true, invalidCount: invalidCount > 0 ? invalidCount : undefined };
}
