/**
 * サーバー側で Shopify inventorySetQuantities を実行する共通ロジック
 * api.inventory.apply-change および app.inventory-count から利用
 * 失敗しないための追求: 429/5xx 時にリトライする。
 */

import type {
  GraphQLUserError,
  InventorySetQuantitiesJson,
  InventoryAdjustQuantitiesJson,
  QuantityNameValue,
} from "../types/graphql-responses";
import { isDefiniteUnaappliedRejection } from "./apply-change-outer-catch-guard";

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
  variables?: Record<string, unknown>
): Promise<{ response: Response; json: unknown }> {
  let lastResp: Response | null = null;
  for (let attempt = 1; attempt <= SHOPIFY_API_RETRY_MAX; attempt++) {
    const response = await admin.graphql(query, { variables });
    lastResp = response;
    if (response.ok) {
      const json = await response.json().catch(() => ({}));
      return { response, json };
    }
    if (!isRetryableStatus(response.status) || attempt >= SHOPIFY_API_RETRY_MAX) {
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
 * 指定チャンクの inventoryItemId について、locationId の現在の available 数量を一括取得する。
 * 返り値: quantities（取得成功分）と failedGids（取得失敗分）を分離して返す。
 * 失敗分を 0 にフォールバックしないことで、ロールバック時に在庫が誤って 0 にリセットされる
 * 問題を防ぐ。
 */
async function fetchChunkQuantities(
  admin: { graphql: AdminGraphql },
  locationGid: string,
  inventoryItemGids: string[]
): Promise<{ quantities: Map<string, number>; failedGids: string[] }> {
  const quantities = new Map<string, number>();
  const failedGids: string[] = [];
  for (const itemGid of inventoryItemGids) {
    try {
      const { json } = await graphqlWithRetry(admin, `#graphql
          query FetchQty($id: ID!, $loc: ID!) {
            inventoryItem(id: $id) {
              inventoryLevel(locationId: $loc) {
                quantities(names: ["available"]) { name quantity }
              }
            }
          }
        `, { id: itemGid, loc: locationGid });
      const quantitiesArr = (json as { data?: { inventoryItem?: { inventoryLevel?: { quantities?: QuantityNameValue[] } } } })?.data?.inventoryItem?.inventoryLevel?.quantities;
      const q = Array.isArray(quantitiesArr) ? quantitiesArr.find((x) => x?.name === "available") : null;
      if (q?.quantity != null) {
        quantities.set(itemGid, Number(q.quantity));
      } else {
        quantities.set(itemGid, 0);
      }
    } catch {
      failedGids.push(itemGid);
    }
  }
  return { quantities, failedGids };
}

/** Shopify changeFromQuantity CAS 不一致（同時売上/返品等）。message + code を見る。 */
export function isChangeFromQuantityStaleError(
  errorSummary: string | undefined,
  userErrors?: Array<{ message?: string; code?: string | null }>
): boolean {
  if (Array.isArray(userErrors)) {
    for (const e of userErrors) {
      const code = String(e?.code ?? "").toUpperCase();
      if (
        code.includes("CHANGE_FROM_QUANTITY") ||
        code === "STALE" ||
        code.includes("COMPARE")
      ) {
        return true;
      }
      const m = String(e?.message ?? "").toLowerCase();
      if (
        m.includes("changefromquantity") ||
        m.includes("change_from_quantity") ||
        m.includes("change from quantity")
      ) {
        return true;
      }
    }
  }
  if (!errorSummary) return false;
  const s = errorSummary.toLowerCase();
  return (
    s.includes("changefromquantity") ||
    s.includes("change_from_quantity") ||
    s.includes("change from quantity")
  );
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
};

export type SetInventoryQuantityItem = {
  inventoryItemId: string;
  quantity: number;
  /**
   * Shopify concurrency CAS（Admin API 2026-01+）。
   * - number: 期待する更新前 available
   * - null / 省略: 意図的オプトアウト（比較スキップ）
   * `options.casFromLiveSnapshot` 時はチャンク直前の再読取値で上書きする
   */
  changeFromQuantity?: number | null;
};

export type SetInventoryQuantitiesOptions = {
  /**
   * activate 後の絶対値 set（棚卸・調整）向け。
   * チャンク適用直前に読んだ available を changeFromQuantity に使い、
   * すでに目標値と一致する行は mutation から除外する。
   * スナップショット取得失敗時は null オプトアウトへ落とさず fail-closed。
   * ロールバックも再読取 CAS（書いた数量と live が一致する行のみ戻す）。
   */
  casFromLiveSnapshot?: boolean;
};

type BeforeSnapshot = {
  chunkIndex: number;
  /** 実際に書いた行のみ。quantity=適用前, writtenQuantity=適用した目標値 */
  quantities: Array<{ inventoryItemId: string; quantity: number; writtenQuantity: number }>;
  canRollback: boolean;
};

const SET_MUTATION = `#graphql
  mutation InventorySetQuantities($input: InventorySetQuantitiesInput!) {
    inventorySetQuantities(input: $input) {
      inventoryAdjustmentGroup { id }
      userErrors { field message code }
    }
  }
`;

async function mutateSetQuantities(
  admin: { graphql: AdminGraphql },
  input: Record<string, unknown>
): Promise<{ ok: boolean; error: string; userErrors: GraphQLUserError[]; hadUserErrors: boolean }> {
  try {
    const { response: resp, json } = await graphqlWithRetry(admin, SET_MUTATION, { input });
    const errJson = json as InventorySetQuantitiesJson;
    const topLevelErrors = Array.isArray(errJson?.errors) ? errJson.errors : [];
    const data = errJson?.data?.inventorySetQuantities;
    if (!resp.ok) {
      return {
        ok: false,
        error: topLevelErrors[0]?.message ?? resp.statusText ?? `HTTP ${resp.status}`,
        userErrors: [],
        hadUserErrors: false,
      };
    }
    if (topLevelErrors.length > 0 && !data) {
      return {
        ok: false,
        error: topLevelErrors.map((e) => e?.message ?? "").filter(Boolean).join(" / ") || "GraphQL errors",
        userErrors: [],
        hadUserErrors: false,
      };
    }
    const errs = (data?.userErrors ?? []) as GraphQLUserError[];
    if (errs.length) {
      return {
        ok: false,
        error: errs.map((e) => e.message ?? "").join(" / "),
        userErrors: errs,
        hadUserErrors: true,
      };
    }
    return { ok: true, error: "", userErrors: [], hadUserErrors: false };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      userErrors: [],
      hadUserErrors: false,
    };
  }
}

/**
 * 適用済みスナップショットを逆順ロールバック。
 * casMode: 再読取し、live===writtenQuantity の行だけ changeFromQuantity=live で戻す。
 * 同時変動で live がずれた行はスキップ（null 上書きで売上を消さない）。
 */
async function rollbackAppliedSnapshots(
  admin: { graphql: AdminGraphql },
  locationGid: string,
  appliedSnapshots: BeforeSnapshot[],
  casMode: boolean
): Promise<{ ok: boolean; errorMsg: string; skippedConcurrent: number }> {
  let skippedConcurrent = 0;
  for (let ri = appliedSnapshots.length - 1; ri >= 0; ri--) {
    const snapshot = appliedSnapshots[ri];
    let rollbackRows: Array<{ inventoryItemId: string; quantity: number; changeFromQuantity: number | null }> = [];

    if (!casMode) {
      rollbackRows = snapshot.quantities.map((q) => ({
        inventoryItemId: q.inventoryItemId,
        quantity: q.quantity,
        changeFromQuantity: null,
      }));
    } else {
      const gids = snapshot.quantities.map((q) => q.inventoryItemId);
      const { quantities: liveMap, failedGids } = await fetchChunkQuantities(admin, locationGid, gids);
      if (failedGids.length > 0) {
        return {
          ok: false,
          errorMsg: `rollback live read failed (${failedGids.length})`,
          skippedConcurrent,
        };
      }
      for (const q of snapshot.quantities) {
        const live = liveMap.get(q.inventoryItemId);
        if (live == null || !Number.isFinite(live)) {
          return { ok: false, errorMsg: `rollback live missing for ${q.inventoryItemId}`, skippedConcurrent };
        }
        if (live === q.quantity) {
          // 既に適用前へ戻っている／一致 → 触らない
          continue;
        }
        if (live !== q.writtenQuantity) {
          // 書いた後に同時変動あり → 巻き戻しで上書きしない
          skippedConcurrent += 1;
          console.warn(
            `[inventory-set-quantities-server] CAS rollback skip concurrent ` +
              `${q.inventoryItemId}: live=${live} written=${q.writtenQuantity} before=${q.quantity}`
          );
          continue;
        }
        rollbackRows.push({
          inventoryItemId: q.inventoryItemId,
          quantity: q.quantity,
          changeFromQuantity: Math.floor(live),
        });
      }
    }

    if (rollbackRows.length === 0) continue;

    const rollbackInput: Record<string, unknown> = {
      name: "available",
      reason: "correction",
      quantities: rollbackRows.map((q) => ({
        inventoryItemId: q.inventoryItemId,
        locationId: locationGid,
        quantity: q.quantity,
        changeFromQuantity: q.changeFromQuantity,
      })),
    };
    const rb = await mutateSetQuantities(admin, rollbackInput);
    if (!rb.ok) {
      // CAS stale on rollback: concurrent moved between our live read and mutate — skip force
      if (casMode && isChangeFromQuantityStaleError(rb.error, rb.userErrors)) {
        skippedConcurrent += rollbackRows.length;
        console.warn(
          `[inventory-set-quantities-server] CAS rollback stale; skip force overwrite: ${rb.error}`
        );
        continue;
      }
      return { ok: false, errorMsg: rb.error, skippedConcurrent };
    }
  }
  return { ok: true, errorMsg: "", skippedConcurrent };
}

/**
 * 在庫数を指定値に設定（inventorySetQuantities）。250件超はチャンク分割。
 * チャンク N が失敗した場合、適用済みチャンク 1..N-1 を元の数量に戻すロールバックを試みる。
 *
 * changeFromQuantity: number=CAS / null・省略=意図的オプトアウト。
 * casFromLiveSnapshot 時のロールバックは再読取 CAS（書いた行のみ・同時変動行はスキップ）。
 */
export async function setInventoryQuantitiesServer(
  admin: { graphql: AdminGraphql },
  locationId: string,
  items: Array<SetInventoryQuantityItem>,
  referenceDocumentUri?: string | null,
  options?: SetInventoryQuantitiesOptions
): Promise<SetInventoryQuantitiesResult> {
  const casFromLiveSnapshot = options?.casFromLiveSnapshot === true;
  const locationGid = toLocationGid(locationId);
  const quantities = (items ?? [])
    .filter((x) => x?.inventoryItemId && Number.isFinite(Number(x?.quantity)))
    .map((x) => {
      const gid = toInventoryItemGid(x.inventoryItemId);
      const quantity = Math.floor(Number(x.quantity) ?? 0);
      const changeFromQuantity =
        x.changeFromQuantity == null || !Number.isFinite(Number(x.changeFromQuantity))
          ? null
          : Math.floor(Number(x.changeFromQuantity));
      return gid
        ? { valid: true as const, inventoryItemId: gid, quantity, changeFromQuantity }
        : { valid: false as const };
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

  const beforeStates: BeforeSnapshot[] = [];
  const appliedInventoryItemIds: string[] = [];

  const failClosedReadError = (failedCount: number) =>
    `確定直前の在庫数を取得できませんでした（${failedCount}件）。` +
    `通信状況を確認してから再度確定してください。`;

  async function rollbackOrPartial(
    chunkError: string,
    appliedSnapshots: BeforeSnapshot[],
    failedChunkIndex?: number
  ): Promise<SetInventoryQuantitiesResult> {
    if (appliedSnapshots.length === 0) {
      return {
        ok: false,
        error: chunkError,
        rolledBack: false,
        appliedInventoryItemIds: [],
        failedChunkIndex,
      };
    }
    const nonRollbackable = appliedSnapshots.filter((s) => !s.canRollback);
    if (nonRollbackable.length > 0) {
      console.error(
        `[inventory-set-quantities-server] チャンク${nonRollbackable.map((s) => s.chunkIndex).join(",")}の` +
          `スナップショット取得が失敗しているためロールバック不可 — 手動復旧が必要です。` +
          ` 元のエラー: ${chunkError}。` +
          ` スナップショット: ${JSON.stringify(appliedSnapshots)}`
      );
      return {
        ok: false,
        error: chunkError,
        rolledBack: false,
        partiallyApplied: true,
        appliedInventoryItemIds: [...appliedInventoryItemIds],
        failedChunkIndex,
      };
    }
    const rb = await rollbackAppliedSnapshots(admin, locationGid, appliedSnapshots, casFromLiveSnapshot);
    if (!rb.ok) {
      console.error(
        `[inventory-set-quantities-server] ロールバック失敗 — 手動復旧が必要です。` +
          ` 元のエラー: ${chunkError}。ロールバックエラー: ${rb.errorMsg}。` +
          ` スナップショット: ${JSON.stringify(appliedSnapshots)}`
      );
      return {
        ok: false,
        error: chunkError,
        rolledBack: false,
        partiallyApplied: true,
        appliedInventoryItemIds: [...appliedInventoryItemIds],
        failedChunkIndex,
      };
    }
    if (rb.skippedConcurrent > 0) {
      console.warn(
        `[inventory-set-quantities-server] rollback completed with ${rb.skippedConcurrent} concurrent skip(s)`
      );
    }
    return {
      ok: false,
      error: chunkError,
      rolledBack: true,
      appliedInventoryItemIds: [],
      failedChunkIndex,
    };
  }

  try {
    for (let i = 0; i < validQuantities.length; i += INVENTORY_SET_QUANTITIES_MAX) {
      const chunk = validQuantities.slice(i, i + INVENTORY_SET_QUANTITIES_MAX);
      const chunkIndex = Math.floor(i / INVENTORY_SET_QUANTITIES_MAX);

      const chunkItemGids = chunk.map((q) => q.inventoryItemId);
      const { quantities: beforeMap, failedGids } = await fetchChunkQuantities(admin, locationGid, chunkItemGids);
      if (failedGids.length > 0) {
        console.warn(
          `[inventory-set-quantities-server] チャンク${chunkIndex}のスナップショット取得失敗 (${failedGids.length}件): ${failedGids.join(", ")} ` +
            `― このチャンクが失敗した場合のロールバックは安全に実行できません`
        );
        if (casFromLiveSnapshot) {
          return await rollbackOrPartial(failClosedReadError(failedGids.length), beforeStates, chunkIndex);
        }
      }

      // 目標値到達済みは skip。rollback 対象にも入れない（書いていない SKU を巻き戻さない）
      const writeChunk = casFromLiveSnapshot
        ? chunk.filter((q) => beforeMap.get(q.inventoryItemId) !== q.quantity)
        : chunk;
      if (writeChunk.length === 0) {
        continue;
      }

      const writeGids = writeChunk.map((q) => q.inventoryItemId);
      if (casFromLiveSnapshot) {
        const missingLive = writeGids.filter((gid) => {
          const live = beforeMap.get(gid);
          return live == null || !Number.isFinite(live);
        });
        if (missingLive.length > 0) {
          return await rollbackOrPartial(failClosedReadError(missingLive.length), beforeStates, chunkIndex);
        }
      }

      const writeSnapshotMissing = writeGids.filter((gid) => failedGids.includes(gid));
      beforeStates.push({
        chunkIndex,
        quantities: writeGids
          .filter((gid) => !failedGids.includes(gid))
          .map((gid) => {
            const row = writeChunk.find((q) => q.inventoryItemId === gid)!;
            return {
              inventoryItemId: gid,
              quantity: beforeMap.get(gid) ?? 0,
              writtenQuantity: row.quantity,
            };
          }),
        canRollback: writeSnapshotMissing.length === 0,
      });

      const input: Record<string, unknown> = {
        name: "available",
        reason: "correction",
        quantities: writeChunk.map((q) => {
          let changeFromQuantity: number | null = q.changeFromQuantity;
          if (casFromLiveSnapshot) {
            changeFromQuantity = Math.floor(Number(beforeMap.get(q.inventoryItemId)));
          }
          return {
            inventoryItemId: q.inventoryItemId,
            locationId: locationGid,
            quantity: q.quantity,
            changeFromQuantity,
          };
        }),
      };
      if (refUri) input.referenceDocumentUri = refUri;

      const mut = await mutateSetQuantities(admin, input);
      if (!mut.ok) {
        const ambiguous = !isDefiniteUnaappliedRejection({ hadUserErrors: mut.hadUserErrors });
        const appliedSnapshots = beforeStates.slice(0, -1);

        if (ambiguous) {
          console.error(
            `[inventory-set-quantities-server] ambiguous chunk${chunkIndex} failure (treat as partial/uncertain): ${mut.error}`
          );
          return {
            ok: false,
            error: mut.error,
            rolledBack: false,
            partiallyApplied: true,
            applicationUncertain: true,
            appliedInventoryItemIds: [...appliedInventoryItemIds],
            failedChunkIndex: chunkIndex,
          };
        }

        return await rollbackOrPartial(mut.error, appliedSnapshots, chunkIndex);
      }

      for (const gid of writeGids) appliedInventoryItemIds.push(gid);
    }
    return {
      ok: true,
      invalidCount: invalidCount > 0 ? invalidCount : undefined,
      rolledBack: false,
      appliedInventoryItemIds,
    };
  } catch (unexpected: unknown) {
    const msg = unexpected instanceof Error ? unexpected.message : String(unexpected);
    console.error(
      `[inventory-set-quantities-server] unexpected error after applied=${appliedInventoryItemIds.length}:`,
      msg
    );
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
 * 1アイテム・1ロケーションの現在の available 数量を取得
 */
export async function fetchCurrentQuantityServer(
  admin: { graphql: AdminGraphql },
  locationId: string,
  inventoryItemId: string
): Promise<number> {
  const locationGid = toLocationGid(locationId);
  const itemGid = toInventoryItemGid(inventoryItemId);
  if (!itemGid) return 0;
  try {
    const { json } = await graphqlWithRetry(admin, `#graphql
        query Cur($id: ID!, $loc: ID!) {
          inventoryItem(id: $id) {
            inventoryLevel(locationId: $loc) {
              quantities(names: ["available"]) { name quantity }
            }
          }
        }
      `, { id: itemGid, loc: locationGid });
    const data = (json as { data?: { inventoryItem?: { inventoryLevel?: { quantities?: QuantityNameValue[] } } } })?.data?.inventoryItem?.inventoryLevel?.quantities;
    const q = Array.isArray(data) ? data.find((x) => x?.name === "available") : null;
    return Number(q?.quantity ?? 0) || 0;
  } catch {
    return 0;
  }
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
