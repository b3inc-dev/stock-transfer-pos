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
import { retryWhileIdempotencyConcurrent } from "./graphql-with-retry";
import {
  buildIdempotencyKeyServer,
  classifyIdempotencyErrors,
  formatIdempotencyChunk,
  resolveIdempotencyContext,
  IDEMPOTENCY_CONCURRENT_REQUEST,
  IDEMPOTENCY_KEY_PARAMETER_MISMATCH,
  type IdempotencyContext,
  type IdempotencyIssue,
} from "./idempotency-key.server";

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
 * inventorySetQuantities（前に進む書き込みも、元に戻す書き込みも同じ文）。
 * Admin API 2026-04 から @idempotent が無いと実行時にエラーになる。2026-01 でも付けてよい（docs/IDEMPOTENT_MIGRATION.md）。
 */
export const INVENTORY_SET_QUANTITIES_MUTATION = `#graphql
  mutation InventorySetQuantities($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
    inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
      inventoryAdjustmentGroup { id }
      userErrors { field message code }
    }
  }
`;

/** apply-change のキーの「操作の種類」 */
export const APPLY_CHANGE_IDEMPOTENCY_KIND = "apply_change";

type SetJsonLike = {
  errors?: Array<{ message?: string; extensions?: { code?: unknown } }>;
  data?: { inventorySetQuantities?: { userErrors?: Array<{ code?: unknown; message?: unknown }> } | null } | null;
};

function idempotencyIssueOfSetJson(json: unknown): IdempotencyIssue | null {
  const j = (json && typeof json === "object" ? json : {}) as SetJsonLike;
  return classifyIdempotencyErrors(
    j?.data?.inventorySetQuantities?.userErrors ?? [],
    Array.isArray(j?.errors) ? j.errors : []
  );
}

function idempotencyIssueMessage(issue: IdempotencyIssue, concurrentExhausted: boolean): string {
  if (issue === "mismatch") {
    return `${IDEMPOTENCY_KEY_PARAMETER_MISMATCH}: 同じキーで中身の違う書き込みが送られました（新しいキーでは送り直していません。Shopify で在庫を確かめてください）`;
  }
  return `${IDEMPOTENCY_CONCURRENT_REQUEST}: 同じキーの前の書き込みが処理中のままでした${concurrentExhausted ? "（待っても終わりませんでした）" : ""}（結果が分かりません。Shopify で在庫を確かめてください）`;
}

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

/** 書く直前の今の数をまとめて読むときの 1 回の件数（クエリの重さを抑える） */
const LIVE_READ_BATCH = 50;

/**
 * 棚卸の確定（compareWithLive）用: チャンクの商品の今の数を、nodes でまとめて読む。
 * 読み方の決まりは readAvailableFromResponse と同じ（在庫の記録が無いときだけ 0、それ以外の失敗は「読めなかった」）。
 * 1 件でも読めなければ失敗を返す（0 にしない）。
 */
async function readChunkLive(
  admin: { graphql: AdminGraphql },
  locationGid: string,
  inventoryItemGids: string[]
): Promise<
  | { ok: true; snapshot: ChunkSnapshot }
  | { ok: false; retryable: boolean; error: string; inventoryItemId: string }
> {
  const snapshot: ChunkSnapshot = [];
  for (let i = 0; i < inventoryItemGids.length; i += LIVE_READ_BATCH) {
    const ids = inventoryItemGids.slice(i, i + LIVE_READ_BATCH);
    let response: Response;
    let json: unknown;
    try {
      ({ response, json } = await graphqlWithRetry(admin, `#graphql
          query LiveAvailable($ids: [ID!]!, $loc: ID!) {
            nodes(ids: $ids) {
              ... on InventoryItem {
                id
                inventoryLevel(locationId: $loc) {
                  quantities(names: ["available"]) { name quantity }
                }
              }
            }
          }
        `, { ids, loc: locationGid }));
    } catch (e: unknown) {
      return { ok: false, retryable: true, error: e instanceof Error ? e.message : String(e), inventoryItemId: ids[0] };
    }
    const body = (json && typeof json === "object" ? json : {}) as {
      data?: { nodes?: unknown[] | null } | null;
      errors?: unknown;
    };
    const nodes = body?.data?.nodes;
    if (!response.ok || !Array.isArray(nodes) || nodes.length !== ids.length) {
      // 形が違う・HTTP の失敗・errors だけ → 1 件目の読み方で理由を作る
      const read = readAvailableFromResponse(response.ok, response.status, {
        errors: body?.errors,
        data: Array.isArray(nodes) ? {} : body?.data ?? null,
      });
      return {
        ok: false,
        retryable: read.ok ? true : read.retryable,
        error: read.ok ? "今の在庫数の応答の形が違います" : read.error,
        inventoryItemId: ids[0],
      };
    }
    for (let k = 0; k < ids.length; k++) {
      // 1 件ずつ、1 商品の応答と同じ形にして同じ決まりで読む
      const read = readAvailableFromResponse(true, 200, {
        errors: body?.errors,
        data: { inventoryItem: nodes[k] as never },
      });
      if (!read.ok) return { ok: false, retryable: read.retryable, error: read.error, inventoryItemId: ids[k] };
      snapshot.push({ inventoryItemId: ids[k], quantity: read.quantity });
    }
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
  /**
   * compareWithLive のとき: 書く直前の今の数を読めなかったので、在庫を 1 件も動かさずに止めた。
   * retryable が true なら、同じ内容で送り直してよい（在庫は動いていない）。
   */
  liveUnreadable?: boolean;
  /**
   * compareWithLive のとき: 読んでから書くまでに店で在庫が動いた（売れた・入庫した）商品。
   * 上書きせずに残した（appliedInventoryItemIds には入れない）。1 件でもあれば partiallyApplied。
   */
  concurrentChangedInventoryItemIds?: string[];
  /**
   * @idempotent の返事で止めたとき（IDEMPOTENCY_KEY_PARAMETER_MISMATCH・待ち切った IDEMPOTENCY_CONCURRENT_REQUEST）。
   * どちらも在庫が動いたか分からないので applicationUncertain と一緒に返す。新しいキーでは送り直さない。
   */
  idempotencyIssue?: IdempotencyIssue;
};

export type SetInventoryQuantitiesOptions = {
  /**
   * true: 各チャンクを書く直前に今の数を読み、その数を changeFromQuantity に入れて書く（棚卸の確定）。
   * - 今の数がもう目標の数なら書かない（入った扱い）
   * - 読んでから書くまでに店で在庫が動くと Shopify が CHANGE_FROM_QUANTITY_STALE で 1 件も書かずに断る。
   *   そのときは 1 回だけ読み直し、2 回の読みで数が変わった商品は上書きせずに残す（売れた分を消さない）
   * - 今の数を読めなければ 0 にせず止める（1 チャンク目なら在庫は動かない）
   * false（既定）: これまでどおり changeFromQuantity: null で書く。
   */
  compareWithLive?: boolean;
  /**
   * @idempotent のキーの材料（docs/IDEMPOTENT_MIGRATION.md 4.5）。
   * apply-change は shop・InventoryChangeEvent.id・呼ぶ場所ごとの round を渡す。
   * 渡さないときは、呼ぶたびに新しい操作の ID にする（同じ呼び出しの中の送り直しだけ同じキー）。
   */
  idempotency?: IdempotencyContext;
};

const CHANGE_FROM_QUANTITY_STALE = "CHANGE_FROM_QUANTITY_STALE";

function hasStaleUserError(errs: GraphQLUserError[]): boolean {
  return errs.some((e) => (e as GraphQLUserError & { code?: string | null }).code === CHANGE_FROM_QUANTITY_STALE);
}

/**
 * compareWithLive の 1 チャンク分の書く内容を決める（Shopify を呼ばない。テストで直接確かめる）。
 * - live が目標と同じ → skip（書かない・入った扱い）
 * - それ以外 → changeFromQuantity = live で書く
 * - previousLive が渡され、live と違う → conflict（読んでから書くまでに動いた。上書きしない）
 */
export function planCompareAndSetChunk(
  chunk: Array<{ inventoryItemId: string; quantity: number }>,
  live: Map<string, number>,
  previousLive?: Map<string, number>
): {
  write: Array<{ inventoryItemId: string; quantity: number; changeFromQuantity: number }>;
  skipped: string[];
  conflicts: string[];
} {
  const write: Array<{ inventoryItemId: string; quantity: number; changeFromQuantity: number }> = [];
  const skipped: string[] = [];
  const conflicts: string[] = [];
  for (const q of chunk) {
    const now = live.get(q.inventoryItemId);
    if (now == null) {
      // 読めていない商品は書かない（呼び出し側で読めなかったときは先に止めている）
      conflicts.push(q.inventoryItemId);
      continue;
    }
    if (previousLive && previousLive.has(q.inventoryItemId) && previousLive.get(q.inventoryItemId) !== now) {
      conflicts.push(q.inventoryItemId);
      continue;
    }
    if (now === q.quantity) {
      skipped.push(q.inventoryItemId);
      continue;
    }
    write.push({ inventoryItemId: q.inventoryItemId, quantity: q.quantity, changeFromQuantity: now });
  }
  return { write, skipped, conflicts };
}

/**
 * 在庫数を指定値に設定（inventorySetQuantities）。250件超はチャンク分割。
 * チャンク N が失敗した場合、適用済みチャンク 1..N-1 を元の数量に戻すロールバックを試みる。
 * options.compareWithLive（棚卸の確定）: 各チャンクを書く直前に今の数を読み、changeFromQuantity に入れて書く。
 * 読んでから書くまでに動いた商品は上書きせず concurrentChangedInventoryItemIds に返す（partiallyApplied）。
 */
export async function setInventoryQuantitiesServer(
  admin: { graphql: AdminGraphql },
  locationId: string,
  items: Array<{ inventoryItemId: string; quantity: number }>,
  referenceDocumentUri?: string | null,
  options: SetInventoryQuantitiesOptions = {}
): Promise<SetInventoryQuantitiesResult> {
  const compareWithLive = options.compareWithLive === true;
  const idem = resolveIdempotencyContext(options.idempotency);
  /** 前に進む書き込み・元に戻す書き込みのキー（チャンクごと・段ごとに違う。送り直しでは同じ） */
  const keyFor = (stage: "set_fwd" | "set_rb", index0: number, total: number, round: string) =>
    buildIdempotencyKeyServer({
      shop: idem.shop,
      kind: APPLY_CHANGE_IDEMPOTENCY_KIND,
      operationId: idem.operationId,
      stage,
      chunk: formatIdempotencyChunk(index0, total),
      round,
    });
  let idempotencyIssue: IdempotencyIssue | undefined;
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
  /** チャンクごとの「目標の数になっている」商品（戻すのに失敗したとき、入ったままの分を数える） */
  const appliedPerChunk: string[][] = [];
  /** compareWithLive: 読んでから書くまでに店で在庫が動いたので、上書きせずに残した商品 */
  const concurrentChanged: string[] = [];

  try {
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      const chunk = chunks[chunkIndex];
      const chunkItemGids = chunk.map((q) => q.inventoryItemId);

      let chunkFailed = false;
      let chunkError = "";
      let chunkHadUserErrors = false;
      /** このチャンクで「目標の数になっている」と言える商品（書いた分 + もう目標だったので書かなかった分） */
      const chunkApplied: string[] = [];
      /** このチャンクで実際に書いた商品と、書いた数 */
      const chunkWritten: Array<{ inventoryItemId: string; quantity: number }> = [];

      // 書く内容: 既定は changeFromQuantity: null。compareWithLive は書く直前の今の数を入れる。
      let plan:
        | { write: Array<{ inventoryItemId: string; quantity: number; changeFromQuantity: number | null }>; skipped: string[] }
        | null = { write: chunk.map((q) => ({ ...q, changeFromQuantity: null })), skipped: [] };
      let firstLive: Map<string, number> | null = null;
      if (compareWithLive) {
        const live = await readChunkLive(admin, locationGid, chunkItemGids);
        if (!live.ok) {
          if (chunkIndex === 0) {
            // まだ 1 件も書いていない。0 にせず止める（送り直してよい）
            console.warn(
              `[inventory-set-quantities-server] 書く直前の今の数を読めないため止めます（在庫は動かしていません）: item=${live.inventoryItemId} error=${live.error}`
            );
            return {
              ok: false,
              error: live.error,
              rolledBack: false,
              liveUnreadable: true,
              retryable: live.retryable,
              appliedInventoryItemIds: [],
            };
          }
          // 先のチャンクは入っている。このチャンクは 1 件も書いていない（はっきりした失敗）→ 下で戻す
          plan = null;
          chunkFailed = true;
          chunkHadUserErrors = true;
          chunkError = `書く直前の今の数を読めませんでした（${live.error}）`;
        } else {
          firstLive = new Map(live.snapshot.map((x) => [x.inventoryItemId, x.quantity]));
          const p = planCompareAndSetChunk(chunk, firstLive);
          plan = { write: p.write, skipped: p.skipped };
        }
      }

      // 書く。compareWithLive で STALE（読んでから書くまでに動いた）なら 1 回だけ読み直して書き直す。
      for (let attempt = 0; plan && !chunkFailed; attempt++) {
        if (plan.write.length === 0) {
          chunkApplied.push(...plan.skipped);
          break;
        }
        const input: Record<string, unknown> = {
          name: "available",
          reason: "correction",
          quantities: plan.write.map((q) => ({
            inventoryItemId: q.inventoryItemId,
            locationId: locationGid,
            quantity: q.quantity,
            changeFromQuantity: q.changeFromQuantity,
          })),
        };
        if (refUri) input.referenceDocumentUri = refUri;
        let staleRefused = false;
        // 回: 1 回目は呼び出し側の round。STALE のあとに読み直して中身（changeFromQuantity）を変えて書き直すときだけ変える。
        // 429・5xx・処理中の送り直しは同じキー（graphqlWithRetry・retryWhileIdempotencyConcurrent が同じ variables を送る）。
        const idempotencyKey = keyFor(
          "set_fwd",
          chunkIndex,
          chunks.length,
          attempt === 0 ? idem.round : `${idem.round}.stale${attempt}`
        );
        try {
          const sent = await retryWhileIdempotencyConcurrent(
            () => graphqlWithRetry(admin, INVENTORY_SET_QUANTITIES_MUTATION, { input, idempotencyKey }),
            (r) => idempotencyIssueOfSetJson(r.json) === "concurrent",
            idem.concurrentRetryDelaysMs
          );
          const { response: resp, json } = sent.result;
          const errJson = json as InventorySetQuantitiesJson;
          const topLevelErrors = Array.isArray(errJson?.errors) ? errJson.errors : [];
          const data = errJson?.data?.inventorySetQuantities;
          const issue = idempotencyIssueOfSetJson(json);
          if (issue) {
            // 処理中のまま・中身の違い: はっきりした断りではない（在庫が動いたか分からない）。
            // chunkHadUserErrors を立てないので、下で「結果が分からない」（partial）になり、新しいキーで送り直さない。
            chunkError = idempotencyIssueMessage(issue, sent.concurrentExhausted);
            chunkFailed = true;
            idempotencyIssue = issue;
          } else if (!resp.ok) {
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
              staleRefused = compareWithLive && hasStaleUserError(errs);
            }
          }
        } catch (e) {
          chunkError = e instanceof Error ? e.message : String(e);
          chunkFailed = true;
        }

        if (!chunkFailed) {
          chunkApplied.push(...plan.skipped, ...plan.write.map((q) => q.inventoryItemId));
          chunkWritten.push(...plan.write.map((q) => ({ inventoryItemId: q.inventoryItemId, quantity: q.quantity })));
          break;
        }
        if (!staleRefused || attempt >= 1 || !firstLive) break;

        // STALE: Shopify は 1 件も書いていない。書こうとした商品だけ読み直す。
        const writeIds = plan.write.map((q) => q.inventoryItemId);
        const reread = await readChunkLive(admin, locationGid, writeIds);
        if (!reread.ok) {
          chunkError = `${chunkError}（読み直しもできませんでした: ${reread.error}）`;
          break; // はっきりした失敗のまま（下で戻す）
        }
        const secondLive = new Map(reread.snapshot.map((x) => [x.inventoryItemId, x.quantity]));
        const retryItems = chunk.filter((q) => writeIds.includes(q.inventoryItemId));
        const p = planCompareAndSetChunk(retryItems, secondLive, firstLive);
        for (const id of p.conflicts) concurrentChanged.push(id);
        console.warn(
          `[inventory-set-quantities-server] chunk${chunkIndex}: 書く直前に店の在庫が動きました（STALE）。` +
            ` 動いた ${p.conflicts.length} 件は上書きせず残し、残りを書き直します`
        );
        plan = { write: p.write, skipped: [...plan.skipped, ...p.skipped] };
        chunkFailed = false;
        chunkError = "";
        chunkHadUserErrors = false;
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
            ...(idempotencyIssue ? { idempotencyIssue } : {}),
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
          // 戻すのは、このアプリが書いた商品だけ（もう目標だったので書かなかった・動いたので残した商品は戻さない）
          const toRestore = snapshots[ri].filter((q) => lastWritten.has(q.inventoryItemId));
          if (toRestore.length === 0) continue;
          const rollbackInput: Record<string, unknown> = {
            name: "available",
            reason: "correction",
            quantities: toRestore.map((q) => ({
              inventoryItemId: q.inventoryItemId,
              locationId: locationGid,
              quantity: q.quantity,
              changeFromQuantity: lastWritten.get(q.inventoryItemId) ?? null,
            })),
          };
          try {
            // 送り直すのは 429（Shopify が受け付けていない）だけ。5xx のあとに送り直すと、
            // 1 回目が入っていた場合に 2 回目が STALE で断られ、「戻せなかった」と取り違えるため。
            // 戻す書き込みのキーは前に進む書き込みと別（段 set_rb）。チャンクごとに違う。
            const rollbackKey = keyFor("set_rb", ri, chunks.length, idem.round);
            const rbSent = await retryWhileIdempotencyConcurrent(
              () =>
                graphqlWithRetry(
                  admin,
                  INVENTORY_SET_QUANTITIES_MUTATION,
                  { input: rollbackInput, idempotencyKey: rollbackKey },
                  (status) => status === 429
                ),
              (r) => idempotencyIssueOfSetJson(r.json) === "concurrent",
              idem.concurrentRetryDelaysMs
            );
            const { response: rbResp, json: rbJson } = rbSent.result;
            const rbErrJson = rbJson as InventorySetQuantitiesJson;
            const rbTopErrors = Array.isArray(rbErrJson?.errors) ? rbErrJson.errors : [];
            const rbData = rbErrJson?.data?.inventorySetQuantities;
            const rbErrs = rbData?.userErrors ?? [];
            const rbIssue = idempotencyIssueOfSetJson(rbJson);
            if (rbIssue) {
              // 戻ったか分からない（はっきりした断りにしない → application_uncertain）
              rollbackErrorMsg = idempotencyIssueMessage(rbIssue, rbSent.concurrentExhausted);
              idempotencyIssue = rbIssue;
            } else if (!rbResp.ok) {
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
              for (const q of toRestore) lastWritten.set(q.inventoryItemId, q.quantity);
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
          const stillApplied = appliedPerChunk.slice(0, stillAppliedChunks).flat();
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
            ...(idempotencyIssue ? { idempotencyIssue } : {}),
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

      // チャンク成功: 目標の数になっている GID を記録（compareWithLive で動いたので残した商品は入れない）
      for (const gid of chunkApplied) appliedInventoryItemIds.push(gid);
      for (const q of chunkWritten) lastWritten.set(q.inventoryItemId, q.quantity);
      appliedPerChunk.push(chunkApplied);
    }
    if (concurrentChanged.length > 0) {
      // ほかの商品は目標の数にした。動いた商品は上書きしていない（はっきりしている。成否不明ではない）。
      // 一部だけ反映（partial_failed）にして、自動では書き直さない（管理者がもう一度数えるか Shopify で直す）
      return {
        ok: false,
        error:
          `確定の途中で店の在庫が動いた商品 ${concurrentChanged.length} 件は、売上・入庫を消さないよう上書きしていません` +
          `（${CHANGE_FROM_QUANTITY_STALE}）。その商品はもう一度数えてください`,
        rolledBack: false,
        partiallyApplied: true,
        applicationUncertain: false,
        appliedInventoryItemIds,
        concurrentChangedInventoryItemIds: [...concurrentChanged],
      };
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
