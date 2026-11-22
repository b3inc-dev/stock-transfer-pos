/**
 * 出庫 Transfer 作成のクライアント側チェックポイント / 再実行安全ヘルパ。
 *
 * 方針（DECISIONS D1 / D3）:
 * - Transfer の正は Shopify。Prisma job は作らない。
 * - POS `SHOPIFY.storage`（+ localStorage fallback）にチャンク進捗を永続化。
 * - Transfer note に attempt マーカーを埋め、timeout 後に照会で成功確認する。
 * - 4 段目（docs/IDEMPOTENT_MIGRATION.md 4.1）: 作成・Shipment の書き込みに @idempotent のキーを付ける。
 *   キーは `attemptId` + 段 + チャンク + 回（`rounds[i]`）。回ははっきり断られたときだけ増やし、送る前に端末に残す。
 *   `v: 1` のまま（`rounds`・`startedAt` が無い前の形も読める。無ければ 0 回・時刻は分からない）。
 *   note の照会はそのまま残す（キーが効くのは 24 時間だけ）。
 */
import {
  buildOutboundCreateKey,
  buildOutboundEditKey,
  bumpCheckpointRound,
  getCheckpointRounds,
  getOutboundRejectedTag,
  outboundRoundGroup,
} from "./outboundIdempotency.js";

/** キーを信じてよい長さ（Shopify が覚えるのは 24 時間。少し手前で切る。pre-stock の PENDING_MAX_MS と同じ考え） */
export const OUTBOUND_KEY_TRUST_MS = 23 * 60 * 60 * 1000;

export const OUTBOUND_CREATE_CHECKPOINT_KEY = "stock_transfer_pos_outbound_create_cp_v1";

const ATTEMPT_MARKER_RE = /\[pos-cp:([A-Za-z0-9_-]+)#(\d+)\/(\d+)\]/;

export function isTimeoutLikeError(err) {
  const msg = String(err?.message ?? err ?? "");
  if (/timeout\s+\d+ms/i.test(msg)) return true;
  if (/\btimeout\b/i.test(msg) && !/userErrors/i.test(msg)) return true;
  if (/aborted/i.test(msg) && /timeout/i.test(msg)) return true;
  if (err?.name === "AbortError") return true;
  return false;
}

export function buildOutboundAttemptId() {
  const rand = Math.random().toString(36).slice(2, 10);
  return `oa_${Date.now().toString(36)}_${rand}`;
}

/** 作成意図の指紋。同一再確定なら一致するよう正規化する。 */
export function buildOutboundCreateFingerprint({
  mode,
  originLocationId,
  destinationLocationId,
  lineItems,
  trackingNumber = "",
  company = "",
}) {
  const modeKey = String(mode || "").trim() || "unknown";
  const origin = String(originLocationId || "").trim();
  const dest = String(destinationLocationId || "").trim();
  const lines = (Array.isArray(lineItems) ? lineItems : [])
    .map((x) => ({
      id: String(x?.inventoryItemId || "").trim(),
      qty: Math.max(0, Number(x?.quantity || 0)),
    }))
    .filter((x) => x.id && x.qty > 0)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((x) => `${x.id}:${x.qty}`)
    .join(",");
  const track = String(trackingNumber || "").trim();
  const comp = String(company || "").trim();
  return `v1|${modeKey}|${origin}|${dest}|${lines}|${track}|${comp}`;
}

export function buildAttemptNoteMarker(attemptId, chunkIndex1Based, chunkTotal) {
  const id = String(attemptId || "").trim();
  const i = Math.max(1, Number(chunkIndex1Based) || 1);
  const n = Math.max(1, Number(chunkTotal) || 1);
  return `[pos-cp:${id}#${i}/${n}]`;
}

export function parseAttemptNoteMarker(note) {
  const m = String(note || "").match(ATTEMPT_MARKER_RE);
  if (!m) return null;
  return {
    attemptId: m[1],
    chunkIndex: Number(m[2]),
    chunkTotal: Number(m[3]),
  };
}

export function mergeNoteWithAttemptMarker(baseNote, attemptId, chunkIndex1Based, chunkTotal) {
  const marker = buildAttemptNoteMarker(attemptId, chunkIndex1Based, chunkTotal);
  const base = String(baseNote || "").trim();
  if (!base) return marker;
  if (ATTEMPT_MARKER_RE.test(base)) {
    return base.replace(ATTEMPT_MARKER_RE, marker);
  }
  return `${base} ${marker}`;
}

export async function storageGet(key) {
  const SHOPIFY = globalThis?.shopify;
  try {
    if (SHOPIFY?.storage?.get) {
      const v = await SHOPIFY.storage.get(key);
      if (v != null && v !== "") return v;
    }
  } catch (_) {}
  try {
    const raw = globalThis?.localStorage?.getItem?.(key);
    if (raw == null || raw === "") return null;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  } catch (_) {}
  return null;
}

export async function storageSet(key, value) {
  const SHOPIFY = globalThis?.shopify;
  try {
    if (SHOPIFY?.storage?.set) await SHOPIFY.storage.set(key, value);
  } catch (_) {}
  try {
    globalThis?.localStorage?.setItem?.(key, JSON.stringify(value));
  } catch (_) {}
}

export async function storageDelete(key) {
  const SHOPIFY = globalThis?.shopify;
  try {
    if (SHOPIFY?.storage?.delete) await SHOPIFY.storage.delete(key);
  } catch (_) {}
  try {
    globalThis?.localStorage?.removeItem?.(key);
  } catch (_) {}
}

export async function loadOutboundCreateCheckpoint(storageKey = OUTBOUND_CREATE_CHECKPOINT_KEY) {
  const raw = await storageGet(storageKey);
  if (!raw || typeof raw !== "object") return null;
  if (Number(raw.v) !== 1) return null;
  if (!raw.attemptId || !raw.fingerprint) return null;
  return raw;
}

export async function saveOutboundCreateCheckpoint(cp, storageKey = OUTBOUND_CREATE_CHECKPOINT_KEY) {
  const payload = {
    ...cp,
    v: 1,
    updatedAt: new Date().toISOString(),
  };
  await storageSet(storageKey, payload);
  return payload;
}

export async function clearOutboundCreateCheckpoint(storageKey = OUTBOUND_CREATE_CHECKPOINT_KEY) {
  await storageDelete(storageKey);
}

/**
 * timeout 後の成功確認: origin の直近 Transfer から attempt マーカー一致を探す。
 * adminGraphql は ModalOutbound と同じシグネチャを渡す。
 */
export async function findTransferByAttemptMarker({
  adminGraphql,
  originLocationId,
  destinationLocationId,
  attemptId,
  chunkIndex1Based,
  first = 50,
}) {
  const originId = String(originLocationId || "").trim();
  const destId = String(destinationLocationId || "").trim();
  const aid = String(attemptId || "").trim();
  const wantChunk = Math.max(1, Number(chunkIndex1Based) || 1);
  if (!originId || !aid) return null;

  const marker = buildAttemptNoteMarker(aid, wantChunk, wantChunk); // #i/i でも #i/n でも parse で照合
  const query = `#graphql
    query OutboundCpTransfers($first: Int!) {
      inventoryTransfers(first: $first, sortKey: CREATED_AT, reverse: true) {
        nodes {
          id
          name
          status
          note
          origin { location { id } }
          destination { location { id } }
          shipments(first: 20) {
            nodes { id status }
          }
        }
      }
    }`;

  const data = await adminGraphql(query, { first: Math.max(1, Math.min(100, Number(first) || 50)) }, { timeoutMs: 20000 });
  const nodes = data?.inventoryTransfers?.nodes ?? [];
  for (const t of nodes) {
    const oId = String(t?.origin?.location?.id || "").trim();
    const dId = String(t?.destination?.location?.id || "").trim();
    if (oId && oId !== originId) continue;
    if (destId && dId && dId !== destId) continue;
    const parsed = parseAttemptNoteMarker(t?.note);
    if (!parsed) continue;
    if (parsed.attemptId !== aid) continue;
    if (parsed.chunkIndex !== wantChunk) continue;
    const ships = Array.isArray(t?.shipments?.nodes) ? t.shipments.nodes : [];
    return {
      id: String(t.id),
      name: String(t.name || ""),
      status: String(t.status || ""),
      note: String(t.note || ""),
      shipments: ships
        .map((s) => ({ id: String(s?.id || "").trim(), status: String(s?.status || "") }))
        .filter((s) => s.id),
      markerMatched: marker,
    };
  }
  return null;
}

/**
 * timeout 直後: 短時間ポーリングして Shopify 側成功を確認する。
 */
export async function confirmTransferAfterTimeout({
  adminGraphql,
  originLocationId,
  destinationLocationId,
  attemptId,
  chunkIndex1Based,
  attempts = 3,
  delayMs = 1500,
  sleepFn = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  let lastErr = null;
  for (let i = 0; i < Math.max(1, attempts); i++) {
    if (i > 0) await sleepFn(delayMs);
    try {
      const found = await findTransferByAttemptMarker({
        adminGraphql,
        originLocationId,
        destinationLocationId,
        attemptId,
        chunkIndex1Based,
      });
      if (found) return found;
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr) throw lastErr;
  return null;
}

/**
 * 複数チャンク Transfer 作成をチェックポイント付きで実行。
 *
 * createChunk({ chunkIndex0, note, chunk }) → { transfer, shipment? }
 */
export async function runChunkedOutboundCreateWithCheckpoint({
  mode,
  originLocationId,
  destinationLocationId,
  chunks,
  lineItemsForFingerprint,
  trackingNumber = "",
  company = "",
  splitLabel = "POS出庫",
  adminGraphql,
  createChunk,
  /** timeout 回復で Transfer のみ見つかったときに Shipment 等を補完する（任意） */
  afterRecoveredChunk,
  toastFn,
  storageKey = OUTBOUND_CREATE_CHECKPOINT_KEY,
}) {
  const n = Array.isArray(chunks) ? chunks.length : 0;
  if (n === 0) throw new Error("chunks is empty");

  const fingerprint = buildOutboundCreateFingerprint({
    mode,
    originLocationId,
    destinationLocationId,
    lineItems: lineItemsForFingerprint,
    trackingNumber,
    company,
  });

  let cp = await loadOutboundCreateCheckpoint(storageKey);
  let attemptId;
  let startIndex = 0;
  const transfers = [];
  const shipments = [];

  /**
   * createChunk・afterRecoveredChunk に渡す @idempotent の材料。keyFor(段) はその時点のチェックポイントの回で作る。
   * 時間切れのあとの補完（afterRecoveredChunk）の Shipment も、作成のときと同じキーになる（前の Shipment ができていれば Shopify が同じものを返す）。
   */
  const idempotencyFor = (i) => ({
    attemptId,
    chunkIndex0: i,
    chunkTotal: n,
    keyFor: (stage) =>
      buildOutboundCreateKey({
        attemptId,
        stage,
        chunkIndex0: i,
        chunkTotal: n,
        rejections: getCheckpointRounds(cp, i)[outboundRoundGroup(stage)],
      }),
  });
  /** はっきり断られたら、そのチャンクの回を 1 つ増やして端末に残してから投げ直す（次は新しいキー。同じキーだと同じ断りが返るため） */
  const guarded = async (i, fn) => {
    try {
      return await fn();
    } catch (e) {
      const tag = getOutboundRejectedTag(e);
      if (tag) {
        try {
          cp = await saveOutboundCreateCheckpoint(bumpCheckpointRound(cp, i, tag), storageKey);
        } catch (_) {}
      }
      throw e;
    }
  };

  if (
    cp &&
    cp.fingerprint === fingerprint &&
    cp.status === "in_progress" &&
    String(cp.mode) === String(mode) &&
    Array.isArray(cp.created)
  ) {
    attemptId = String(cp.attemptId);
    startIndex = Math.max(0, Math.min(n, Number(cp.nextChunkIndex) || 0));
    for (const row of cp.created) {
      if (row?.transferId) transfers[Number(row.chunkIndex)] = { id: row.transferId };
      if (row?.shipmentId) shipments[Number(row.chunkIndex)] = { id: row.shipmentId };
    }
    if (typeof toastFn === "function") {
      toastFn(`前回の出庫作成を再開します（${startIndex}/${n} 完了済み）`);
    }

    // timeout で pending のまま残ったチャンクを先に成功確認
    const pending = cp.pendingChunkIndex;
    if (pending != null && Number(pending) === startIndex && startIndex < n) {
      try {
        const confirmed = await confirmTransferAfterTimeout({
          adminGraphql,
          originLocationId,
          destinationLocationId,
          attemptId,
          chunkIndex1Based: startIndex + 1,
        });
        if (confirmed?.id) {
          let transfer = confirmed;
          let ship = confirmed.shipments?.[0] || null;
          if (typeof afterRecoveredChunk === "function") {
            const completed = await guarded(startIndex, () =>
              afterRecoveredChunk({
                transfer,
                shipment: ship,
                chunk: chunks[startIndex],
                note: mergeNoteWithAttemptMarker(
                  n > 1
                    ? `${String(splitLabel || "POS出庫").trim() || "POS出庫"} 分割 ${startIndex + 1}/${n}（API上限250明細/Transfer）`
                    : undefined,
                  attemptId,
                  startIndex + 1,
                  n
                ),
                chunkIndex0: startIndex,
                attemptId,
                idempotency: idempotencyFor(startIndex),
              })
            );
            if (completed?.transfer) transfer = completed.transfer;
            if (completed?.shipment) ship = completed.shipment;
          }
          transfers[startIndex] = transfer;
          if (ship) shipments[startIndex] = ship;
          const created = Array.isArray(cp.created) ? [...cp.created] : [];
          created.push({
            chunkIndex: startIndex,
            transferId: transfer.id,
            shipmentId: ship?.id || null,
          });
          cp = await saveOutboundCreateCheckpoint(
            {
              ...cp,
              created,
              nextChunkIndex: startIndex + 1,
              pendingChunkIndex: null,
            },
            storageKey
          );
          startIndex += 1;
          if (typeof toastFn === "function") {
            toastFn(`タイムアウト後の成功を確認しました（分割 ${startIndex}/${n}）`);
          }
        }
      } catch (_) {
        // 確認失敗時は通常の create に進む（二重リスクは note 照会で軽減）
      }
    }
  } else {
    attemptId = buildOutboundAttemptId();
    startIndex = 0;
    cp = await saveOutboundCreateCheckpoint(
      {
        attemptId,
        fingerprint,
        mode: String(mode),
        originLocationId: String(originLocationId || "").trim(),
        destinationLocationId: String(destinationLocationId || "").trim(),
        chunkTotal: n,
        nextChunkIndex: 0,
        pendingChunkIndex: null,
        created: [],
        rounds: {},
        startedAt: new Date().toISOString(),
        status: "in_progress",
      },
      storageKey
    );
  }

  const label = String(splitLabel || "POS出庫").trim() || "POS出庫";

  for (let i = startIndex; i < n; i++) {
    // 既に再開データがあるチャンクはスキップ（Shipment 欠落時のみ補完）
    if (transfers[i]?.id) {
      if (!shipments[i]?.id && typeof afterRecoveredChunk === "function") {
        try {
          const completed = await guarded(i, () =>
            afterRecoveredChunk({
              transfer: transfers[i],
              shipment: shipments[i] || null,
              chunk: chunks[i],
              note: mergeNoteWithAttemptMarker(
                n > 1
                  ? `${String(splitLabel || "POS出庫").trim() || "POS出庫"} 分割 ${i + 1}/${n}（API上限250明細/Transfer）`
                  : undefined,
                attemptId,
                i + 1,
                n
              ),
              chunkIndex0: i,
              attemptId,
              idempotency: idempotencyFor(i),
            })
          );
          if (completed?.shipment?.id) shipments[i] = completed.shipment;
        } catch (_) {}
      }
      continue;
    }

    const baseNote =
      n > 1
        ? `${label} 分割 ${i + 1}/${n}（API上限250明細/Transfer）`
        : n === 1
          ? undefined
          : `${label}`;
    const note = mergeNoteWithAttemptMarker(baseNote, attemptId, i + 1, n);

    cp = await saveOutboundCreateCheckpoint(
      {
        ...cp,
        pendingChunkIndex: i,
      },
      storageKey
    );

    // 作成前にもう一度照会（二重発行防止）
    let transfer = null;
    let shipment = null;
    let lookupFailed = null;
    let existing = null;
    try {
      existing = await findTransferByAttemptMarker({
        adminGraphql,
        originLocationId,
        destinationLocationId,
        attemptId,
        chunkIndex1Based: i + 1,
      });
    } catch (e) {
      lookupFailed = e;
    }
    if (existing?.id) {
      transfer = existing;
      shipment = existing.shipments?.[0] || null;
      if (typeof afterRecoveredChunk === "function") {
        try {
          const completed = await guarded(i, () =>
            afterRecoveredChunk({
              transfer,
              shipment,
              chunk: chunks[i],
              note,
              chunkIndex0: i,
              attemptId,
              idempotency: idempotencyFor(i),
            })
          );
          if (completed?.transfer) transfer = completed.transfer;
          if (completed?.shipment) shipment = completed.shipment;
        } catch (_) {
          // 前と同じ: 補完の失敗はここでは止めない（Transfer は見つかっているので作り直さない）
        }
      }
    } else if (lookupFailed && isCheckpointOlderThanKeyTrust(cp)) {
      // 23 時間より古い続き: キーがもう効かないかもしれないので、note の照会ができないまま作らない（3.2）
      const err = new Error(
        `前回の出庫作成から時間がたっているため、Shopify で作成済みかを確かめられないまま作り直すことはしません（分割 ${i + 1}/${n}）。通信が戻ってから、もう一度確定してください。`
      );
      err.cause = lookupFailed;
      err.outboundCheckpoint = { attemptId, chunkIndex: i, chunkTotal: n };
      throw err;
    }

    if (!transfer) {
      try {
        const created = await guarded(i, () =>
          createChunk({
            chunkIndex0: i,
            chunkIndex1Based: i + 1,
            chunkTotal: n,
            chunk: chunks[i],
            note,
            attemptId,
            idempotency: idempotencyFor(i),
          })
        );
        transfer = created?.transfer ?? null;
        shipment = created?.shipment ?? null;
      } catch (e) {
        if (isTimeoutLikeError(e)) {
          if (typeof toastFn === "function") {
            toastFn("応答待ちがタイムアウトしました。成功確認中…");
          }
          const recovered = await confirmTransferAfterTimeout({
            adminGraphql,
            originLocationId,
            destinationLocationId,
            attemptId,
            chunkIndex1Based: i + 1,
          });
          if (recovered?.id) {
            transfer = recovered;
            shipment = recovered.shipments?.[0] || shipment;
            if (typeof afterRecoveredChunk === "function") {
              const completed = await guarded(i, () =>
                afterRecoveredChunk({
                  transfer,
                  shipment,
                  chunk: chunks[i],
                  note,
                  chunkIndex0: i,
                  attemptId,
                  idempotency: idempotencyFor(i),
                })
              );
              if (completed?.transfer) transfer = completed.transfer;
              if (completed?.shipment) shipment = completed.shipment;
            }
            if (typeof toastFn === "function") {
              toastFn(`タイムアウト後に作成成功を確認しました（分割 ${i + 1}/${n}）`);
            }
          } else {
            const err = new Error(
              `出庫作成がタイムアウトし、成功も未確認です（分割 ${i + 1}/${n}）。同じ内容で再確定すると途中から再開します。Shopify管理画面で重複がないか確認してください。`
            );
            err.cause = e;
            err.outboundCheckpoint = { attemptId, chunkIndex: i, chunkTotal: n };
            throw err;
          }
        } else {
          throw e;
        }
      }
    }

    if (!transfer?.id) {
      throw new Error(`Transfer 作成結果が空です（分割 ${i + 1}/${n}）`);
    }

    transfers[i] = transfer;
    if (shipment?.id) shipments[i] = shipment;

    const created = Array.isArray(cp.created) ? [...cp.created] : [];
    created.push({
      chunkIndex: i,
      transferId: String(transfer.id),
      shipmentId: shipment?.id ? String(shipment.id) : null,
    });
    cp = await saveOutboundCreateCheckpoint(
      {
        ...cp,
        created,
        nextChunkIndex: i + 1,
        pendingChunkIndex: null,
      },
      storageKey
    );
  }

  await clearOutboundCreateCheckpoint(storageKey);

  const transferList = [];
  const shipmentList = [];
  for (let i = 0; i < n; i++) {
    if (transfers[i]) transferList.push(transfers[i]);
    if (shipments[i]) shipmentList.push(shipments[i]);
  }

  return {
    transfers: transferList,
    shipments: shipmentList,
    attemptId,
    resumedFrom: startIndex,
  };
}

/**
 * チェックポイントが、キーを信じてよい長さ（23 時間）より古いか。
 * `startedAt` が無い前の形は分からないので false（今までと同じ動き）。
 */
export function isCheckpointOlderThanKeyTrust(cp, now = Date.now()) {
  const t = Date.parse(String(cp?.startedAt || ""));
  if (!Number.isFinite(t)) return false;
  return now - t > OUTBOUND_KEY_TRUST_MS;
}

/* =========================
 * 編集・配送の追加（docs/IDEMPOTENT_MIGRATION.md 4.2。4 段目）
 *
 * 今ある Transfer の明細を変える（inventoryTransferSetItems）・今ある Transfer に配送を足す（inventoryShipmentCreate）には、
 * 作成のような attemptId が無かった。作成と同じ形の小さなチェックポイントを足す:
 * - 送る前に「何を（action）・どの Transfer に・どの明細で」の指紋と操作の ID（opId）を端末に残す
 * - 同じ指紋の押し直し（時間切れ・通信の失敗のあと）は同じ opId → 同じキー → Shopify は 2 回目を動かさない
 *   （配送の追加の時間切れのあとに押し直しても、配送が 2 つにならない。24 時間の中だけ）
 * - 成功したら消す → 次の編集は新しい opId（A → B → A と直しても、3 回目が 1 回目の答えだけ返して書かれない、にならない）
 * - はっきり断られたら、その段・チャンクの回を 1 つ増やして残す
 * - 違う指紋・23 時間より古いものは新しい opId
 *
 * 設計（4.2）では「操作の ID = transferId + 編集を始めたときに読んだ明細の指紋」としていたが、編集を始める所が画面のあちこちにあり、
 * 送る直前に読み直すと、配送の追加のあとの押し直しで前の形が変わって新しいキーになる（配送が 2 つになりうる）。
 * なので作成と同じく「送る前に残す ID」にした。守りの考え（同じ押し直しは同じキー・新しい編集は新しいキー）は同じ。
 */
export const OUTBOUND_EDIT_CHECKPOINT_KEY = "stock_transfer_pos_outbound_edit_cp_v1";

export function buildOutboundEditOpId() {
  const rand = Math.random().toString(36).slice(2, 10);
  return `oe_${Date.now().toString(36)}_${rand}`;
}

/** 編集の指紋（明細は順番によらない） */
export function buildOutboundEditFingerprint({ action, transferId, lineItems, extra = "" }) {
  const lines = (Array.isArray(lineItems) ? lineItems : [])
    .map((x) => ({ id: String(x?.inventoryItemId || "").trim(), qty: Math.max(0, Number(x?.quantity || 0)) }))
    .filter((x) => x.id && x.qty > 0)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((x) => `${x.id}:${x.qty}`)
    .join(",");
  return `v1|${String(action || "").trim() || "unknown"}|${String(transferId || "").trim()}|${lines}|${String(extra || "").trim()}`;
}

function editRoundSlot(stage, chunkIndex0, chunkTotal) {
  return `${stage}@${Math.floor(Number(chunkIndex0) || 0) + 1}/${Math.max(1, Math.floor(Number(chunkTotal) || 1))}`;
}

/**
 * 編集・配送の追加をチェックポイント付きで行う。
 * body({ opId, keyFor(stage, chunkIndex0?, chunkTotal?), tagFor(stage, chunkIndex0?, chunkTotal?) }) の中で、
 * sendOutboundIdempotent の idempotencyKey に keyFor(…)、rejectTag に tagFor(…) を渡す。
 */
export async function runOutboundEditWithCheckpoint(
  { action, transferId, lineItems, extra = "", storageKey = OUTBOUND_EDIT_CHECKPOINT_KEY, now = () => Date.now() },
  body
) {
  const fingerprint = buildOutboundEditFingerprint({ action, transferId, lineItems, extra });
  let cp = null;
  try {
    const raw = await storageGet(storageKey);
    if (raw && typeof raw === "object" && Number(raw.v) === 1 && raw.opId && raw.fingerprint) cp = raw;
  } catch (_) {}
  const startedMs = Date.parse(String(cp?.startedAt || ""));
  const reusable =
    cp && cp.fingerprint === fingerprint && Number.isFinite(startedMs) && now() - startedMs <= OUTBOUND_KEY_TRUST_MS;
  if (!reusable) {
    cp = {
      v: 1,
      opId: buildOutboundEditOpId(),
      fingerprint,
      action: String(action || ""),
      transferId: String(transferId || ""),
      rounds: {},
      startedAt: new Date(now()).toISOString(),
    };
  }
  // 送る前に残す（応答なしのあとも同じ opId を使うため）
  await storageSet(storageKey, { ...cp, updatedAt: new Date(now()).toISOString() });

  const tagFor = (stage, chunkIndex0 = 0, chunkTotal = 1) => editRoundSlot(stage, chunkIndex0, chunkTotal);
  const keyFor = (stage, chunkIndex0 = 0, chunkTotal = 1) =>
    buildOutboundEditKey({
      opId: cp.opId,
      stage,
      chunkIndex0,
      chunkTotal,
      rejections: Math.max(0, Math.floor(Number(cp.rounds?.[tagFor(stage, chunkIndex0, chunkTotal)]) || 0)),
    });

  let result;
  try {
    result = await body({ opId: cp.opId, keyFor, tagFor });
  } catch (e) {
    const tag = getOutboundRejectedTag(e);
    if (tag) {
      const rounds = { ...(cp.rounds || {}) };
      rounds[tag] = Math.max(0, Math.floor(Number(rounds[tag]) || 0)) + 1;
      cp = { ...cp, rounds };
      try {
        await storageSet(storageKey, { ...cp, updatedAt: new Date(now()).toISOString() });
      } catch (_) {}
    }
    throw e;
  }
  try {
    await storageDelete(storageKey);
  } catch (_) {}
  return result;
}

