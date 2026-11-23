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
  getOutboundMismatchTag,
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
 * 入れ物は「動き + Transfer」ごとに分ける（#114 の見直し P2-1）。1 つだけだと、配送の追加が時間切れ（じつは通っていた）
 * → 別の Transfer の下書きを保存（入れ物が上書きされて成功で消える）→ 戻って同じ配送の追加を押す、で opId が新しくなり、
 * 配送が 2 つになりうるため。作成は note の照会で守れるが、編集には照会が無い。
 *
 * 配送を作る動き（createsShipment: true）で、結果の分からない前の続きを使わずに新しい opId にするとき
 * （23 時間より古い・明細を変えた・中身の違いで止まった）は、一度だけ注意を出して止める（P2-2。配送は送らない）。
 * 同じ Transfer の配送を作るほかの動きの入れ物に、結果が分からずまだ注意していないものがあるときも同じく一度注意する（#115 の見直し P2）。
 * 次の押し直しで新しい opId で送る。前の配送の追加がはっきり断られただけ（1 つ目の配送か明細の書き換えで断られた）のときは出さない。
 *
 * 設計（4.2）では「操作の ID = transferId + 編集を始めたときに読んだ明細の指紋」としていたが、編集を始める所が画面のあちこちにあり、
 * 送る直前に読み直すと、配送の追加のあとの押し直しで前の形が変わって新しいキーになる（配送が 2 つになりうる）。
 * なので作成と同じく「送る前に残す ID」にした。守りの考え（同じ押し直しは同じキー・新しい編集は新しいキー）は同じ。
 */
/** 入れ物の名前の頭（動き + Transfer を後ろに付ける）。#114 の 1 つの入れ物（…_v1）は出していないので読み替えない */
export const OUTBOUND_EDIT_CHECKPOINT_PREFIX = "stock_transfer_pos_outbound_edit_cp_v2";
/** 入れ物の一覧（古いものを片付けるため） */
export const OUTBOUND_EDIT_CHECKPOINT_INDEX_KEY = "stock_transfer_pos_outbound_edit_cp_index_v1";
/** 残った入れ物を片付けるまでの長さと数 */
export const OUTBOUND_EDIT_CHECKPOINT_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
export const OUTBOUND_EDIT_CHECKPOINT_MAX = 30;

/**
 * 配送を作る動き。同じ Transfer でこのうちの別の動きに切り替えたときも、結果の分からない前の続きで一度注意する（#115 の見直し P2）。
 * `edit_in_transit` は新しい配送（ship=new）のときだけ配送を作る（入れ物の `createsShipment` で見分ける）。
 */
export const OUTBOUND_SHIPMENT_CREATING_ACTIONS = Object.freeze([
  "add_shipment_in_transit",
  "add_shipment_ready",
  "add_shipment_draft",
  "edit_in_transit",
]);

/** 動き + Transfer ごとの入れ物の名前 */
export function outboundEditCheckpointKey(action, transferId) {
  return `${OUTBOUND_EDIT_CHECKPOINT_PREFIX}|${String(action || "").trim() || "unknown"}|${String(transferId || "").trim()}`;
}

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
 * 断られた所から「この操作でまだ配送ができていない」と言えるか。
 * 明細の書き換え（配送より前）か、1 つ目の配送で断られたときだけ（同じキーの 2 回目は前の答えを返すので、
 * 断りが返ったなら前の押し直しでもその所は通っていない。2 つ目以降で断られたときは 1 つ目の配送ができている）。
 */
export function isCleanEditRejection(tag) {
  const t = String(tag || "");
  return t.startsWith("set_items@") || /^shipment@1\/\d+$/.test(t);
}

/** 配送の追加のやり直しの前に一度出す注意（P2-2）。message は B へ進む見分け・時間切れの見分けに当たらない日本語だけ */
export class OutboundEditStaleWarning extends Error {
  constructor(reason) {
    super(
      reason === "existing_shipment"
        ? "前回の確定で新しく作ろうとした配送の結果が分かっていません。Shopify の管理画面で、この在庫移動に前回の配送ができていないかを確かめてください。できていなければ、もう一度確定すると選んだ配送で送ります。"
        : reason === "other_action"
        ? "この在庫移動で、前に別のボタンで行った配送の追加の結果が分かっていません。Shopify の管理画面で、この在庫移動に前回の配送ができていないかを確かめてください。できていなければ、もう一度確定すると新しく送ります。"
        : reason === "stale"
        ? "前回の配送の追加から 23 時間より時間がたっていて、前回の結果を確かめられません。Shopify の管理画面で、この在庫移動に前回の配送ができていないかを確かめてください。できていなければ、もう一度確定すると新しく送ります。"
        : reason === "mismatch"
          ? "前回の配送の追加の結果を確かめられませんでした。Shopify の管理画面で、この在庫移動に前回の配送ができていないかを確かめてください。できていなければ、もう一度確定すると新しく送ります。"
          : "前回の配送の追加の結果が分からないまま、明細が変わりました。Shopify の管理画面で、この在庫移動に前回の配送ができていないかを確かめてください。できていなければ、もう一度確定すると今の明細で新しく送ります。"
    );
    this.name = "OutboundEditStaleWarning";
    this.staleReason = reason;
  }
}

export function isOutboundEditStaleWarning(e) {
  return e instanceof OutboundEditStaleWarning || e?.name === "OutboundEditStaleWarning";
}

function readEditCheckpoint(raw) {
  return raw && typeof raw === "object" && Number(raw.v) === 1 && raw.opId && raw.fingerprint ? raw : null;
}

/** その入れ物が配送を作る動きのものか（`createsShipment` が無い形は、配送の追加 3 つだけを配送を作るとみる） */
function editCheckpointCreatesShipment(cp, action) {
  if (typeof cp?.createsShipment === "boolean") return cp.createsShipment;
  return String(action || cp?.action || "").startsWith("add_shipment_");
}

/**
 * 同じ Transfer の、配送を作るほかの動きの入れ物で、結果が分からずまだ注意していないものを探す（#115 の見直し P2）。
 * 読めないものは飛ばす（止めない）。
 */
async function findUnwarnedSiblingShipmentCheckpoint({ action, transferId }) {
  const own = String(action || "").trim();
  for (const other of OUTBOUND_SHIPMENT_CREATING_ACTIONS) {
    if (other === own) continue;
    const key = outboundEditCheckpointKey(other, transferId);
    let cp = null;
    try {
      cp = readEditCheckpoint(await storageGet(key));
    } catch (_) {
      cp = null;
    }
    if (!cp) continue;
    if (!editCheckpointCreatesShipment(cp, other)) continue;
    if (cp.outcome !== "unknown" || cp.warnedAt) continue;
    return { key, cp };
  }
  return null;
}

/** 入れ物の一覧に足して、古いもの・多すぎるものを片付ける（失敗しても止めない） */
async function touchEditCheckpointIndex(storageKey, nowMs, { remove = false } = {}) {
  try {
    const raw = await storageGet(OUTBOUND_EDIT_CHECKPOINT_INDEX_KEY);
    let list = Array.isArray(raw) ? raw.filter((x) => x && typeof x.key === "string") : [];
    list = list.filter((x) => x.key !== storageKey);
    if (!remove) list.push({ key: storageKey, at: nowMs });
    const keep = [];
    const drop = [];
    for (const x of list) {
      const at = Number(x.at);
      if (x.key !== storageKey && (!Number.isFinite(at) || nowMs - at > OUTBOUND_EDIT_CHECKPOINT_KEEP_MS)) drop.push(x);
      else keep.push(x);
    }
    keep.sort((a, b) => Number(a.at) - Number(b.at));
    while (keep.length > OUTBOUND_EDIT_CHECKPOINT_MAX) {
      const i = keep.findIndex((x) => x.key !== storageKey);
      if (i < 0) break;
      drop.push(keep.splice(i, 1)[0]);
    }
    for (const x of drop) {
      try {
        await storageDelete(x.key);
      } catch (_) {}
    }
    await storageSet(OUTBOUND_EDIT_CHECKPOINT_INDEX_KEY, keep);
  } catch (_) {}
}

/**
 * 編集・配送の追加をチェックポイント付きで行う。
 * body({ opId, keyFor(stage, chunkIndex0?, chunkTotal?), tagFor(stage, chunkIndex0?, chunkTotal?) }) の中で、
 * sendOutboundIdempotent の idempotencyKey に keyFor(…)、rejectTag に tagFor(…) を渡す。
 * createsShipment: 配送を作る動き（配送の追加・明細の書き換えと新しい配送）。結果の分からない前の続きを捨てるときに一度注意を出す。
 */
export async function runOutboundEditWithCheckpoint(
  { action, transferId, lineItems, extra = "", createsShipment = false, storageKey, now = () => Date.now() },
  body
) {
  const key = storageKey || outboundEditCheckpointKey(action, transferId);
  const fingerprint = buildOutboundEditFingerprint({ action, transferId, lineItems, extra });
  let prev = null;
  try {
    prev = readEditCheckpoint(await storageGet(key));
  } catch (_) {}
  const nowMs = now();
  const startedMs = Date.parse(String(prev?.startedAt || ""));
  const fresh = Number.isFinite(startedMs) && nowMs - startedMs <= OUTBOUND_KEY_TRUST_MS;
  const reusable = !!(prev && prev.fingerprint === fingerprint && fresh && !prev.noReuse);

  // P2-2: 配送を作る動きで、結果の分からない前の続きを捨てるときは一度だけ注意して止める
  // 前の続きが配送を作らない形（edit_in_transit で今ある Shipment を選んだとき）なら、前の配送は無いので出さない。
  // 今が配送を作らない形でも、前の続きが配送を作る形なら上書きの前に一度出す（#115 の 2 回目の見直し P3:
  // edit_in_transit の ship=new が時間切れ → 今ある Shipment を選んで押し直す、で注意なしに続きが消えないように）
  if (
    prev &&
    !reusable &&
    editCheckpointCreatesShipment(prev, action) &&
    prev.outcome !== "rejected_clean" &&
    !prev.warnedAt
  ) {
    const reason = prev.noReuse ? "mismatch" : !fresh ? "stale" : !createsShipment ? "existing_shipment" : "changed";
    try {
      await storageSet(key, { ...prev, warnedAt: new Date(nowMs).toISOString(), updatedAt: new Date(nowMs).toISOString() });
    } catch (_) {}
    throw new OutboundEditStaleWarning(reason);
  }

  // #115 の見直し P2: 同じ Transfer で別の配送を作るボタン（配送の追加の在庫移動中・配送準備完了・下書き保存、
  // edit_in_transit の新しい配送）に切り替えたとき、そちらの結果が分からないままなら一度だけ注意して止める。
  // 入れ物は動きごとなので、ここで見ないと新しい opId で送られて配送が 2 つになりうる。
  // 注意した入れ物には warnedAt を付ける（次の押し直しは止めない）。その入れ物は消さないので、元のボタンに戻った押し直しは同じキーのまま。
  if (createsShipment && String(transferId || "").trim()) {
    const sibling = await findUnwarnedSiblingShipmentCheckpoint({ action, transferId });
    if (sibling) {
      try {
        await storageSet(sibling.key, {
          ...sibling.cp,
          warnedAt: new Date(nowMs).toISOString(),
          updatedAt: new Date(nowMs).toISOString(),
        });
      } catch (_) {}
      throw new OutboundEditStaleWarning("other_action");
    }
  }

  let cp = reusable
    ? prev
    : {
        v: 1,
        opId: buildOutboundEditOpId(),
        fingerprint,
        action: String(action || ""),
        transferId: String(transferId || ""),
        rounds: {},
        startedAt: new Date(nowMs).toISOString(),
      };
  // 送る前に残す（createsShipment は、同じ Transfer のほかの動きが注意するかを見分けるため）（応答なしのあとも同じ opId を使うため）。outcome は送っている間は「分からない」
  cp = { ...cp, outcome: "unknown", createsShipment: !!createsShipment };
  await storageSet(key, { ...cp, updatedAt: new Date(nowMs).toISOString() });
  await touchEditCheckpointIndex(key, nowMs);

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
    const mismatchTag = getOutboundMismatchTag(e);
    let thrown = e;
    if (tag) {
      const rounds = { ...(cp.rounds || {}) };
      rounds[tag] = Math.max(0, Math.floor(Number(rounds[tag]) || 0)) + 1;
      cp = { ...cp, rounds, outcome: isCleanEditRejection(tag) ? "rejected_clean" : "unknown" };
    } else if (mismatchTag && mismatchTag.startsWith("set_items@")) {
      // P3-3: 明細の書き換えの中身の違い（250 件以下で明細の並びが変わったときなど）。書き換えは何度送っても同じ形になるので、
      // 回を増やして次の押し直しは新しいキーにする（同じキーのままだと 23 時間ずっと止まる）
      const rounds = { ...(cp.rounds || {}) };
      rounds[mismatchTag] = Math.max(0, Math.floor(Number(rounds[mismatchTag]) || 0)) + 1;
      cp = { ...cp, rounds };
      thrown = new Error(
        "明細の並びが前回の確定と違うため、前回の明細の書き換えの結果を確かめられませんでした。もう一度確定すると、今の明細で新しく送ります（明細の書き換えは何度送っても同じ形になります）。"
      );
      thrown.name = "OutboundIdempotencyError";
      thrown.idempotencyIssue = "mismatch";
      thrown.cause = e;
    } else if (mismatchTag) {
      // P3-3: 配送の作成の中身の違い。前の配送ができているかもしれないので、同じ続きは使わない。
      // 文で「管理画面で確かめて」と出しているので、次の押し直しで注意は重ねずに新しい opId で送る
      cp = { ...cp, noReuse: true, warnedAt: new Date(now()).toISOString() };
    }
    if (tag || mismatchTag) {
      try {
        await storageSet(key, { ...cp, updatedAt: new Date(now()).toISOString() });
      } catch (_) {}
    }
    throw thrown;
  }
  try {
    await storageDelete(key);
  } catch (_) {}
  await touchEditCheckpointIndex(key, now(), { remove: true });
  return result;
}

/**
 * 今ある Shipment を発送済みにする（P3-4）。前の押し直しでもう IN_TRANSIT などになっていれば送らない
 * （inventoryShipmentMarkInTransit は @idempotent に対応していないので、2 回目は断られて止まる）。
 * 状態を読めなかったときは前と同じく送る。
 */
export async function markShipmentInTransitUnlessAlready({ adminGraphql, shipmentId, markInTransit }) {
  const sid = String(shipmentId || "").trim();
  if (!sid) throw new Error("Shipment ID が空です");
  let current = null;
  try {
    const data = await adminGraphql(
      `#graphql
      query OutboundShipmentStatus($id: ID!) {
        inventoryShipment(id: $id) { id status }
      }`,
      { id: sid },
      { timeoutMs: 20000 }
    );
    current = data?.inventoryShipment ?? null;
  } catch (_) {
    current = null;
  }
  const status = String(current?.status || "").toUpperCase();
  if (current?.id && status && status !== "DRAFT") return { id: String(current.id), status };
  return await markInTransit(sid);
}
