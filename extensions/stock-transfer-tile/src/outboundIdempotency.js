/**
 * POS 出庫の在庫の書き込み（Shopify の @idempotent）のキーと送り方。4 段目。
 * 設計: docs/IDEMPOTENT_MIGRATION.md 4.1（作成）・4.2（編集・配送の追加）・4.3（有効化）・3.3（返事の扱い）。
 *
 * キーの材料（extensions/common/idempotencyKey.js と同じ並べ方）:
 * - 作成（A・B・C・D）: 操作の種類 `outbound_create`、操作の ID はチェックポイントの `attemptId`、
 *   段 `transfer_ready`・`transfer_draft_for_ready`・`transfer_draft`・`shipment`、チャンク `i/n`、
 *   回はチェックポイントの `rounds[i].transfer`・`rounds[i].shipment`（0 は `main`、断られるたびに `rej1`・`rej2`…）
 * - 編集・配送の追加（E と、そこからの D）: 操作の種類 `outbound_edit`、操作の ID は編集のチェックポイントの `opId`
 *   （outboundCreateCheckpoint.js の runOutboundEditWithCheckpoint）、段 `set_items`・`shipment`、チャンク `i/n`、回は同じ形
 *
 * 回を増やすのは「はっきり断られた（userErrors）」ときだけ。時間切れ・通信の失敗・5xx・処理中の送り直しでは増やさない（同じキー）。
 * 書いたあとに取り消したものを同じ中身でもう一度作るときは、チェックポイントが成功で消えているので操作の ID が変わる（新しいキー）。
 */
import { buildIdempotencyKey, formatIdempotencyChunk } from "../../common/idempotencyKey.js";
import { classifyReceiveIdempotencyIssue, currentShopDomain } from "../../common/shipmentReceive.js";

export const OUTBOUND_CREATE_KIND = "outbound_create";
export const OUTBOUND_EDIT_KIND = "outbound_edit";

/** 段の名前（違う mutation・違う中身には違う段を使う。同じキーで違う中身を送ると IDEMPOTENCY_KEY_PARAMETER_MISMATCH） */
export const OUTBOUND_STAGE = Object.freeze({
  TRANSFER_READY: "transfer_ready",
  TRANSFER_DRAFT_FOR_READY: "transfer_draft_for_ready",
  TRANSFER_DRAFT: "transfer_draft",
  SHIPMENT: "shipment",
  SET_ITEMS: "set_items",
});

/** 段から、チェックポイントの回の欄（transfer か shipment） */
export function outboundRoundGroup(stage) {
  return stage === OUTBOUND_STAGE.SHIPMENT ? "shipment" : "transfer";
}

const clip = (s) => String(s ?? "").trim().replace(/\|/g, "%7C");
const toCount = (v) => Math.max(0, Math.floor(Number(v) || 0));

/** 回の書き方（0 は main、断られた回数が n なら rejN） */
export function formatOutboundRound(rejections) {
  const n = toCount(rejections);
  return n > 0 ? `rej${n}` : "main";
}

/**
 * チェックポイントの回（rounds が無い前の形でも 0 として読む）。
 * @returns {{ transfer: number, shipment: number }}
 */
export function getCheckpointRounds(cp, chunkIndex0) {
  const row = cp && typeof cp === "object" && cp.rounds && typeof cp.rounds === "object" ? cp.rounds[String(chunkIndex0)] : null;
  return { transfer: toCount(row?.transfer), shipment: toCount(row?.shipment) };
}

/** 回を 1 つ増やした新しいチェックポイント（元は変えない） */
export function bumpCheckpointRound(cp, chunkIndex0, group) {
  const g = group === "shipment" ? "shipment" : "transfer";
  const cur = getCheckpointRounds(cp, chunkIndex0);
  const rounds = { ...(cp?.rounds && typeof cp.rounds === "object" ? cp.rounds : {}) };
  rounds[String(chunkIndex0)] = { ...cur, [g]: cur[g] + 1 };
  return { ...(cp || {}), rounds };
}

/** 作成（A・B・C・D）のキー */
export function buildOutboundCreateKey({ shop, attemptId, stage, chunkIndex0 = 0, chunkTotal = 1, rejections = 0 }) {
  return buildIdempotencyKey({
    shop: clip(shop) || currentShopDomain(),
    kind: OUTBOUND_CREATE_KIND,
    operationId: clip(attemptId),
    stage,
    chunk: formatIdempotencyChunk(chunkIndex0, chunkTotal),
    round: formatOutboundRound(rejections),
  });
}

/** 編集・配送の追加（E と D）のキー */
export function buildOutboundEditKey({ shop, opId, stage, chunkIndex0 = 0, chunkTotal = 1, rejections = 0 }) {
  return buildIdempotencyKey({
    shop: clip(shop) || currentShopDomain(),
    kind: OUTBOUND_EDIT_KIND,
    operationId: clip(opId),
    stage,
    chunk: formatIdempotencyChunk(chunkIndex0, chunkTotal),
    round: formatOutboundRound(rejections),
  });
}

/**
 * @idempotent の返事で「結果が分からない」もの（3.3）。
 * message は「出庫の作成がタイムアウト」や READY の代わりの道の見分け（mutation の名前・Field・undefined・timeout）に当たらない日本語だけにする。
 */
export class OutboundIdempotencyError extends Error {
  constructor(issue, label) {
    super(
      issue === "mismatch"
        ? `出庫の結果を確かめられませんでした（IDEMPOTENCY_KEY_PARAMETER_MISMATCH）。Shopify の管理画面で、在庫移動と配送ができていないかを確かめてください。${label ? `（${label}）` : ""}`
        : `前の確定がまだ処理中です（IDEMPOTENCY_CONCURRENT_REQUEST）。少し待ってから、もう一度確定してください（同じ内容なら二重にはなりません）。${label ? `（${label}）` : ""}`
    );
    this.name = "OutboundIdempotencyError";
    this.idempotencyIssue = issue;
  }
}

export function isOutboundIdempotencyError(e) {
  return e instanceof OutboundIdempotencyError || e?.name === "OutboundIdempotencyError";
}

/** はっきり断られた（userErrors）ときに付ける印。チェックポイントはこれを見て回を増やす */
export function getOutboundRejectedTag(e) {
  const t = e?.outboundRejectedTag;
  return typeof t === "string" && t ? t : null;
}

function defaultAssertNoUserErrors(payload, label) {
  const errs = payload?.userErrors ?? [];
  if (!Array.isArray(errs) || errs.length === 0) return;
  const msg = errs.map((e) => e?.message).filter(Boolean).join(" / ");
  throw new Error(`${label} failed: ${msg || JSON.stringify(errs)}`);
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @idempotent 付きの mutation を 1 回送る（処理中なら待って同じキーで送り直す）。
 * - IDEMPOTENCY_CONCURRENT_REQUEST: 1・2・4 秒待って同じキー（全部で budgetMs まで）。間に合わなければ OutboundIdempotencyError("concurrent")
 * - IDEMPOTENCY_KEY_PARAMETER_MISMATCH: 送り直さない。OutboundIdempotencyError("mismatch")
 * - ほかの userErrors: 今までと同じ assertNoUserErrors の Error に `outboundRejectedTag = rejectTag` を付けて投げる（回を増やす印）
 * - 投げられた失敗（時間切れ・HTTP・トップの errors）: そのまま投げる（結果が分からないので回は増やさない）
 * @returns {Promise<object>} data[payloadField]
 */
export async function sendOutboundIdempotent({
  adminGraphql,
  query,
  variables,
  idempotencyKey,
  payloadField,
  label = payloadField,
  lineItemsMeta,
  assertNoUserErrors = defaultAssertNoUserErrors,
  rejectTag = "transfer",
  concurrentDelaysMs = [1000, 2000, 4000],
  budgetMs = 20000,
  sleep = delay,
}) {
  if (!idempotencyKey) throw new TypeError(`${label}: idempotencyKey がありません`);
  const startedAt = Date.now();
  for (let attempt = 0; ; attempt++) {
    let payload;
    try {
      const data = await adminGraphql(query, { ...(variables || {}), idempotencyKey });
      payload = data?.[payloadField];
    } catch (e) {
      const issue = classifyReceiveIdempotencyIssue(null, e?.message ?? e);
      if (issue === "mismatch") throw new OutboundIdempotencyError("mismatch", label);
      if (issue !== "concurrent") throw e;
      payload = { userErrors: [{ code: "IDEMPOTENCY_CONCURRENT_REQUEST", message: String(e?.message ?? e) }] };
    }
    const issue = classifyReceiveIdempotencyIssue(payload?.userErrors, "");
    if (issue === "mismatch") throw new OutboundIdempotencyError("mismatch", label);
    if (issue === "concurrent") {
      const waitMs = concurrentDelaysMs[attempt];
      if (waitMs == null || Date.now() - startedAt + waitMs > budgetMs) throw new OutboundIdempotencyError("concurrent", label);
      await sleep(waitMs);
      continue;
    }
    try {
      assertNoUserErrors(payload, label, lineItemsMeta);
    } catch (err) {
      if (err && typeof err === "object") err.outboundRejectedTag = rejectTag;
      throw err;
    }
    return payload;
  }
}

/**
 * READY で作れなかったときに、下書きで作って READY にする代わりの道（B）へ進んでよいか。
 * 前と同じ見分け（mutation の名前・Field・undefined が文にある）に、「@idempotent の返事のときは進まない」を足した。
 * 処理中・中身の違いのときに代わりの道へ進むと、前の READY が通っていたら二重の在庫移動になる。
 */
export function shouldFallbackToDraftForReady(e) {
  if (isOutboundIdempotencyError(e)) return false;
  const msg = String(e?.message ?? e);
  return msg.includes("inventoryTransferCreateAsReadyToShip") || msg.includes("Field") || msg.includes("undefined");
}

/**
 * 250 件を超えて分けるときの並べ方。読んだ順が変わっても、チャンクの中身（とキー）が同じになるよう inventoryItemId の順に並べる。
 * 明細の補足（lineItemsMeta）は inventoryItemId で付け直す（前は並びがずれることがあった）。
 * 250 件以下は並べ替えない（今と同じ）。
 */
export function sortOutboundLinesForChunking(lineItems, lineItemsMeta, max = 250) {
  const li = Array.isArray(lineItems) ? lineItems : [];
  const meta = Array.isArray(lineItemsMeta) ? lineItemsMeta : [];
  if (li.length <= max) return { lineItems: li, lineItemsMeta: meta };
  const metaById = new Map();
  for (const m of meta) {
    const id = String(m?.inventoryItemId || "").trim();
    if (id && !metaById.has(id)) metaById.set(id, m);
  }
  const sorted = li
    .map((x, idx) => ({ x, idx }))
    .sort((a, b) => {
      const ia = String(a.x?.inventoryItemId || "");
      const ib = String(b.x?.inventoryItemId || "");
      if (ia !== ib) return ia < ib ? -1 : 1;
      return a.idx - b.idx;
    })
    .map((r) => r.x);
  return {
    lineItems: sorted,
    lineItemsMeta: sorted.map((x) => metaById.get(String(x?.inventoryItemId || "").trim()) || { inventoryItemId: x?.inventoryItemId }),
  };
}
