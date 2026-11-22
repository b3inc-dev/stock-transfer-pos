/**
 * POS の配送の受け取り（inventoryShipmentReceive）。入庫（stock-transfer-inbound）と
 * 出庫の「全部拒否で戻す」（stock-transfer-tile の ModalOutbound）で同じものを使う。
 * 設計: docs/IDEMPOTENT_MIGRATION.md 4.4（G・H）・3.3。3 段目。
 *
 * - `@idempotent(key: $idempotencyKey)` を付ける。キーの材料:
 *   - 操作の種類: 入庫 `inbound_receive`・出庫の全部拒否 `outbound_reject_all`
 *   - 操作の ID: 配送の ID + **伝票を読んだときの各明細の受け取り済み・拒否済みの数の指紋**
 *   - 段: `receive_v2`（reason 付き）・`receive_v2b`（reason なしで送り直す）・`receive_capped`（予定を超えた分を外して送り直す）・
 *     `reject`（不足分の拒否）。reason なしで送り直すときは `<段>_b`（`receive_v2` だけは `receive_v2b`）
 *   - チャンク: 250 件ずつ `i/n`
 *   - 回: 呼び出し側の回（`main`、在庫が無いと断られて有効化したあとは `ns1`）+ `.` + **送る明細の指紋**
 * - 前は毎回まず `inventoryShipmentReceiveItems` を試していた（2026-01 に無い mutation で、毎回エラーになってから
 *   `inventoryShipmentReceive` に進んでいた）。その道は消した。
 * - 守りは足すだけ: 送る数は「受け取りたい数 − もう受け取った数」の差分（呼び出し側）、確定のあとの伝票の読み直しが
 *   終わるまでロックを外さない（receiveReloadGate.js）、履歴の appEventId（buildInboundReceiveLogAppEventId）はそのまま。
 *   キーは 24 時間しか効かない。
 *
 * 返事の扱い（3.3）:
 * - IDEMPOTENCY_CONCURRENT_REQUEST: 1 秒・2 秒・4 秒待って同じキーで送り直す（全部で 20 秒まで）。間に合わなければ
 *   ShipmentReceiveIdempotencyError（issue: "concurrent"）
 * - IDEMPOTENCY_KEY_PARAMETER_MISMATCH: 送り直さない。ShipmentReceiveIdempotencyError（issue: "mismatch"）
 *   どちらも「結果が分からない」。呼び出し側の「在庫が無い」「数が多すぎる」の見分けの文に当たらない文にしてある
 *
 * 250 件を超えるとき（チャンクが 2 つ以上）:
 * - 分ける前に明細を shipmentLineItemId の順に並べる。読んだ順が変わっても、チャンクの中身とキーが同じになる。
 * - 2 つ目以降のチャンクで失敗したら（断り・@idempotent の返事・例外のどれでも）、ShipmentReceivePartialError を投げる。
 *   前のチャンクはもう Shopify に入っているので、呼び出し側は「在庫が無い」「数が多すぎる」の代わりの道へ進んではいけない
 *   （段か回が違う新しいキーで 1 つ目のチャンクをもう一度送り、一部入庫だと二重に受け取られる）。
 *   文はその見分けの文に当たらない日本語だけにしてあり、元の失敗は cause に入れる。
 *   呼び出し側は、入った分（receivedItems）を履歴に残し、投げ直して伝票を読み直させる（receiveReloadGate.js）。
 *   docs/STATE_MACHINE.md §7「入庫の受け取りの 250 分割の途中失敗」。
 */
import { buildIdempotencyKey, formatIdempotencyChunk } from "./idempotencyKey.js";

export const SHIPMENT_RECEIVE_LINE_ITEMS_MAX = 250;
export const INBOUND_RECEIVE_KIND = "inbound_receive";
export const OUTBOUND_REJECT_ALL_KIND = "outbound_reject_all";

export const SHIPMENT_RECEIVE_MUTATION = `#graphql
  mutation Receive($id: ID!, $lineItems: [InventoryShipmentReceiveItemInput!]!, $idempotencyKey: String!) {
    inventoryShipmentReceive(id: $id, lineItems: $lineItems) @idempotent(key: $idempotencyKey) {
      inventoryShipment { id status }
      userErrors { field message code }
    }
  }`;

const toInt = (v) => Math.max(0, Math.floor(Number(v || 0)));
const clip = (s) => String(s ?? "").trim().replace(/\|/g, "%7C");

/**
 * 伝票を読んだときの指紋。明細ごとに「ID:受け取り済み:拒否済み」を並べる（順番によらない）。
 * Shopify の明細（`acceptedQuantity`・`rejectedQuantity`）と画面の行（`alreadyAcceptedQty`・`alreadyRejectedQty`）の両方を読む。
 */
export function buildShipmentReadFingerprint(lines) {
  return (Array.isArray(lines) ? lines : [])
    .map((l) => {
      const id = clip(l?.shipmentLineItemId || l?.id || l?.lineItemId);
      if (!id) return null;
      const accepted = toInt(l?.alreadyAcceptedQty ?? l?.acceptedQuantity);
      const rejected = toInt(l?.alreadyRejectedQty ?? l?.rejectedQuantity);
      return `${id}:${accepted}:${rejected}`;
    })
    .filter(Boolean)
    .sort()
    .join(",");
}

/** 送る明細の指紋（ID:数:reason） */
export function buildReceiveItemsFingerprint(items) {
  return (Array.isArray(items) ? items : [])
    .map((x) => `${clip(x.shipmentLineItemId)}:${toInt(x.quantity)}:${clip(x.reason || "-")}`)
    .sort()
    .join(",");
}

/** 呼び出し元が操作を渡さなかったときの ID（呼ぶたびに違う。今と同じ動きで守りは増えない） */
export function newAdhocOperationId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return `adhoc-${c.randomUUID()}`;
  return `adhoc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

/** POS の今のストアの domain（無ければ unknown-shop） */
export function currentShopDomain() {
  try {
    // eslint-disable-next-line no-undef
    const s = typeof SHOPIFY !== "undefined" ? SHOPIFY : globalThis.shopify;
    const d = String(s?.session?.currentSession?.shopDomain || "").trim();
    return d || "unknown-shop";
  } catch {
    return "unknown-shop";
  }
}

/**
 * 1 回の受け取りの操作（キーの材料のうち、段・チャンク・回より前）。
 * @param {{ kind: string, shipmentId: string, readLines: Array<object>, shop?: string }} p
 */
export function buildShipmentReceiveOperation({ kind, shipmentId, readLines, shop }) {
  const fp = buildShipmentReadFingerprint(readLines);
  return {
    shop: clip(shop) || currentShopDomain(),
    kind,
    operationId: `${clip(shipmentId)}#${fp || "-"}`,
  };
}

/** キー（UUID v5） */
export function buildShipmentReceiveKey(op, { stage, chunk = "1/1", items, round = "main" }) {
  return buildIdempotencyKey({
    shop: op.shop,
    kind: op.kind,
    operationId: op.operationId,
    stage,
    chunk,
    round: `${clip(round) || "main"}.${buildReceiveItemsFingerprint(items) || "-"}`,
  });
}

export class ShipmentReceiveIdempotencyError extends Error {
  constructor(issue, detail) {
    super(
      issue === "mismatch"
        ? `入庫の結果を確かめられませんでした（IDEMPOTENCY_KEY_PARAMETER_MISMATCH）。Shopify の管理画面で、この配送の受け取った数を確かめてください。${detail ? ` ${detail}` : ""}`
        : `前の確定がまだ処理中です（IDEMPOTENCY_CONCURRENT_REQUEST）。少し待ってから伝票を読み直してください。${detail ? ` ${detail}` : ""}`
    );
    this.name = "ShipmentReceiveIdempotencyError";
    this.idempotencyIssue = issue;
  }
}

/**
 * 250 件ずつのうち、2 つ目以降のチャンクで失敗した（前のチャンクはもう入っている）。
 * message は入庫の画面の見分けの文（「在庫が無い」「数が多すぎる」）に当たらない日本語だけにする。元の失敗は cause。
 */
export class ShipmentReceivePartialError extends Error {
  /**
   * @param {{ completedChunks: number, totalChunks: number, receivedItems: Array<{shipmentLineItemId: string, quantity: number, reason?: string}>, cause?: unknown }} p
   */
  constructor({ completedChunks, totalChunks, receivedItems, cause }) {
    super(
      `入庫の一部だけが入りました（${totalChunks} 回に分けて送るうち ${completedChunks} 回目まで）。` +
        "残りは入っていません。二重にならないよう伝票を読み直してから、受け取った数を確かめて、もう一度確定してください。"
    );
    this.name = "ShipmentReceivePartialError";
    this.completedChunks = completedChunks;
    this.totalChunks = totalChunks;
    this.receivedItems = Array.isArray(receivedItems) ? receivedItems : [];
    this.cause = cause;
    this.causeMessage = String(cause?.message ?? cause ?? "");
    if (cause instanceof ShipmentReceiveIdempotencyError) this.idempotencyIssue = cause.idempotencyIssue;
  }
}

/** 拡張ごとに別に束ねられても見分けられるよう、名前でも見る */
export function isShipmentReceivePartialError(e) {
  return e instanceof ShipmentReceivePartialError || e?.name === "ShipmentReceivePartialError";
}

/** userErrors（と、投げられた文）に @idempotent の返事があるか。中身の違いを先に見る */
export function classifyReceiveIdempotencyIssue(userErrors, thrownMessage) {
  const texts = [
    ...(Array.isArray(userErrors) ? userErrors : []).map((e) => `${e?.code ?? ""} ${e?.message ?? ""}`),
    String(thrownMessage ?? ""),
  ].join("\n");
  if (/IDEMPOTENCY_KEY_PARAMETER_MISMATCH|same idempotency key (cannot be|was) used with different/i.test(texts)) return "mismatch";
  if (/IDEMPOTENCY_CONCURRENT_REQUEST|request is currently in progress|another request with the same idempotency key/i.test(texts)) {
    return "concurrent";
  }
  return null;
}

function defaultAssertNoUserErrors(payload, label) {
  const errs = payload?.userErrors ?? [];
  if (!Array.isArray(errs) || errs.length === 0) return;
  const msg = errs.map((e) => e?.message).filter(Boolean).join(" / ");
  throw new Error(`${label} failed: ${msg || JSON.stringify(errs)}`);
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 1 チャンクを送る（処理中なら待って同じキーで送り直す）。
 * 投げる: はっきりした断り（userErrors）は今までと同じ形の Error、@idempotent の返事は ShipmentReceiveIdempotencyError。
 */
async function sendOne({ adminGraphql, assertNoUserErrors, shipmentId, lineItems, key, delaysMs, budgetMs, startedAt }) {
  for (let attempt = 0; ; attempt++) {
    let payload;
    try {
      const d = await adminGraphql(SHIPMENT_RECEIVE_MUTATION, { id: shipmentId, lineItems, idempotencyKey: key });
      payload = d?.inventoryShipmentReceive;
    } catch (e) {
      const issue = classifyReceiveIdempotencyIssue(null, e?.message ?? e);
      if (issue === "mismatch") throw new ShipmentReceiveIdempotencyError("mismatch");
      if (issue !== "concurrent") throw e;
      payload = { userErrors: [{ code: "IDEMPOTENCY_CONCURRENT_REQUEST", message: String(e?.message ?? e) }] };
    }
    const issue = classifyReceiveIdempotencyIssue(payload?.userErrors, "");
    if (issue === "mismatch") throw new ShipmentReceiveIdempotencyError("mismatch");
    if (issue === "concurrent") {
      const waitMs = delaysMs[attempt];
      if (waitMs == null || Date.now() - startedAt + waitMs > budgetMs) throw new ShipmentReceiveIdempotencyError("concurrent");
      await delay(waitMs);
      continue;
    }
    assertNoUserErrors(payload, "inventoryShipmentReceive");
    return payload?.inventoryShipment ?? null;
  }
}

function noReasonStage(stage) {
  return stage === "receive_v2" ? "receive_v2b" : `${stage}_b`;
}

/**
 * 配送の受け取り（@idempotent 付き）。
 * @param {object} p
 * @param {Function} p.adminGraphql (query, variables) => data。userErrors は data に入って返り、トップの errors は投げる
 * @param {Function} [p.assertNoUserErrors]
 * @param {string} p.shipmentId
 * @param {Array<{shipmentLineItemId?: string, id?: string, lineItemId?: string, quantity: number, reason?: string}>} p.items
 * @param {{ shop: string, kind: string, operationId: string }} [p.op] buildShipmentReceiveOperation の結果。無ければ呼ぶたびに新しい ID
 * @param {string} [p.stage] 既定 `receive_v2`
 * @param {string} [p.round] 既定 `main`。在庫が無いと断られて有効化したあとは `ns1`
 */
export async function receiveShipmentIdempotent({
  adminGraphql,
  assertNoUserErrors = defaultAssertNoUserErrors,
  shipmentId,
  items,
  op,
  stage = "receive_v2",
  round = "main",
  concurrentDelaysMs = [1000, 2000, 4000],
  budgetMs = 20000,
}) {
  const clean = (items || [])
    .map((x) => ({
      shipmentLineItemId: x.shipmentLineItemId || x.id || x.lineItemId || null,
      quantity: Number(x.quantity || 0),
      // 新しめのスキーマでは reason が必須になる場合があるため保険（ACCEPTED / REJECTED）
      reason: String(x.reason || "ACCEPTED").trim().toUpperCase(),
    }))
    .filter((x) => x.shipmentLineItemId && x.quantity > 0)
    // チャンクに分ける前に並べる（読んだ順が変わっても、チャンクの中身とキーが同じになる）
    .sort((a, b) => compareText(a.shipmentLineItemId, b.shipmentLineItemId) || compareText(a.reason, b.reason) || a.quantity - b.quantity);
  if (clean.length === 0) return null;

  const operation = op ?? { shop: currentShopDomain(), kind: INBOUND_RECEIVE_KIND, operationId: newAdhocOperationId() };
  const total = Math.ceil(clean.length / SHIPMENT_RECEIVE_LINE_ITEMS_MAX);
  const startedAt = Date.now();
  let last = null;
  /** もう入ったチャンクの明細（2 つ目以降で失敗したとき、呼び出し側が履歴に残す） */
  const received = [];
  for (let ci = 0; ci < total; ci++) {
    const slice = clean.slice(ci * SHIPMENT_RECEIVE_LINE_ITEMS_MAX, (ci + 1) * SHIPMENT_RECEIVE_LINE_ITEMS_MAX);
    const chunk = formatIdempotencyChunk(ci, total);
    const common = { adminGraphql, assertNoUserErrors, shipmentId, delaysMs: concurrentDelaysMs, budgetMs, startedAt };
    try {
      try {
        last = await sendOne({
          ...common,
          lineItems: slice,
          key: buildShipmentReceiveKey(operation, { stage, chunk, items: slice, round }),
        });
      } catch (e) {
        // reason が未対応の API の版なら、reason 無しで送り直す（中身が違うので段を分ける）
        const msg = String(e?.message ?? e);
        if (!(e instanceof ShipmentReceiveIdempotencyError) && /reason/i.test(msg) && /(not defined by type|Unknown field|invalid)/i.test(msg)) {
          const noReason = slice.map(({ shipmentLineItemId, quantity }) => ({ shipmentLineItemId, quantity }));
          last = await sendOne({
            ...common,
            lineItems: noReason,
            key: buildShipmentReceiveKey(operation, { stage: noReasonStage(stage), chunk, items: noReason, round }),
          });
        } else {
          throw e;
        }
      }
    } catch (e) {
      // 1 つ目のチャンクの失敗は今までどおり（まだ何も入っていないので、呼び出し側の代わりの道へ進んでよい）
      if (ci === 0) throw e;
      // 2 つ目以降: 前のチャンクはもう入っている。代わりの道へ進ませない別のエラーにする
      throw new ShipmentReceivePartialError({ completedChunks: ci, totalChunks: total, receivedItems: received.slice(), cause: e });
    }
    for (const x of slice) received.push({ ...x });
  }
  return last;
}

function compareText(a, b) {
  const x = String(a ?? "");
  const y = String(b ?? "");
  return x < y ? -1 : x > y ? 1 : 0;
}
