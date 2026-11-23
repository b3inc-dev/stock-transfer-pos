/**
 * POS 出庫の @idempotent（docs/IDEMPOTENT_MIGRATION.md 4.1・4.2・4.3・6.1 の 4。4 段目）。
 * adminGraphql を偽物にし、Shopify と同じく「同じキーの 2 回目は作らずに前の答えを返す」ふりをする。
 * ModalOutbound.jsx は preact に頼るので直接は読み込めない。同じ部品（チェックポイント・送り方）を同じ形で呼ぶ。
 * Run: node --test tests/outbound-create-idempotency.test.mjs
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const cp = await import("../extensions/stock-transfer-tile/src/outboundCreateCheckpoint.js");
const oi = await import("../extensions/stock-transfer-tile/src/outboundIdempotency.js");
const { buildActivateKeyForPos } = await import("../extensions/common/activateIdempotency.js");
const { isUuidV5 } = await import("../extensions/common/idempotencyKey.js");

const SHOP = "bbbincbbb.myshopify.com";
const ORIGIN = "gid://shopify/Location/1";
const DEST = "gid://shopify/Location/2";
const FAST = [0, 0, 0];

/** POS の SHOPIFY.storage と session のふり */
function installPos() {
  const store = new Map();
  globalThis.shopify = {
    session: { currentSession: { shopDomain: SHOP } },
    storage: {
      get: async (k) => (store.has(k) ? structuredClone(store.get(k)) : null),
      set: async (k, v) => void store.set(k, structuredClone(v)),
      delete: async (k) => void store.delete(k),
    },
  };
  return store;
}

const items = (n, qty = 1) =>
  Array.from({ length: n }, (_, i) => ({ inventoryItemId: `gid://shopify/InventoryItem/${String(i + 1).padStart(4, "0")}`, quantity: qty }));
const chunk250 = (lineItems) => {
  const out = [];
  for (let i = 0; i < lineItems.length; i += 250) out.push({ lineItems: lineItems.slice(i, i + 250), lineItemsMeta: [] });
  return out;
};

/**
 * Shopify のふり。
 * - 同じキー・同じ中身の 2 回目は前の答え。同じキー・違う中身は IDEMPOTENCY_KEY_PARAMETER_MISMATCH
 * - reply(call) が値を返せばそれを返す。"drop" は「Shopify では作れたが答えが届かない（時間切れ）」
 * - lookupFails: note の照会を失敗させる
 */
function fakeShopify({ reply = () => null, lookupFails = false } = {}) {
  const remembered = new Map();
  const transfers = [];
  const shipments = [];
  const calls = [];
  async function adminGraphql(query, variables) {
    const op = /mutation\s+(\w+)|query\s+(\w+)/.exec(query);
    const name = op?.[1] || op?.[2];
    const call = { name, variables, key: variables?.idempotencyKey };
    calls.push(call);
    if (name === "OutboundCpTransfers") {
      if (lookupFails) throw new Error("HTTP 503: lookup");
      return { inventoryTransfers: { nodes: [...transfers].reverse() } };
    }
    const r = reply(call, calls.length - 1);
    if (r instanceof Error) throw r;
    const drop = r === "drop";
    if (r && !drop) return r;
    const body = JSON.stringify(variables.input ?? variables);
    if (call.key && remembered.has(call.key)) {
      const prev = remembered.get(call.key);
      if (prev.body !== body) {
        return { [prev.field]: { userErrors: [{ field: null, code: "IDEMPOTENCY_KEY_PARAMETER_MISMATCH", message: "mismatch" }] } };
      }
      return prev.answer;
    }
    let field;
    let answer;
    if (name === "CreateTransferReady" || name === "CreateTransfer" || name === "InventoryTransferCreate") {
      field = { CreateTransferReady: "inventoryTransferCreateAsReadyToShip" }[name] ?? "inventoryTransferCreate";
      const t = {
        id: `gid://shopify/InventoryTransfer/${transfers.length + 1}`,
        status: name === "CreateTransferReady" ? "READY_TO_SHIP" : "DRAFT",
        note: variables.input.note || "",
        origin: { location: { id: variables.input.originLocationId } },
        destination: { location: { id: variables.input.destinationLocationId } },
        shipments: { nodes: [] },
        lineItems: variables.input.lineItems,
      };
      transfers.push(t);
      answer = { [field]: { inventoryTransfer: { id: t.id, status: t.status }, userErrors: [] } };
    } else if (name === "ShipmentCreateDraft") {
      field = "inventoryShipmentCreate";
      const s = { id: `gid://shopify/InventoryShipment/${shipments.length + 1}`, status: "DRAFT", movementId: variables.input.movementId };
      shipments.push(s);
      transfers.find((t) => t.id === s.movementId)?.shipments.nodes.push({ id: s.id, status: s.status });
      answer = { [field]: { inventoryShipment: { id: s.id, status: s.status }, userErrors: [] } };
    } else if (name === "InventoryTransferSetItems") {
      field = "inventoryTransferSetItems";
      const t = transfers.find((x) => x.id === variables.input.id) ?? { id: variables.input.id, status: "DRAFT" };
      t.lineItems = variables.input.lineItems;
      t.setCount = (t.setCount ?? 0) + 1;
      if (!transfers.includes(t)) transfers.push(t);
      answer = { [field]: { inventoryTransfer: { id: t.id, status: t.status }, userErrors: [] } };
    } else {
      throw new Error(`知らない呼び出し: ${name}`);
    }
    if (call.key) remembered.set(call.key, { body, answer, field });
    if (drop) throw new Error("timeout 20000ms");
    return answer;
  }
  return { adminGraphql, calls, transfers, shipments };
}

const userErr = (field, message = "rejected") => ({ [field]: { userErrors: [{ field: ["input"], message }] } });

/** ModalOutbound.jsx の in_transit の createChunk・afterRecoveredChunk と同じ形 */
function inTransitHandlers(sh) {
  const send = (args) => oi.sendOutboundIdempotent({ adminGraphql: sh.adminGraphql, concurrentDelaysMs: FAST, ...args });
  const createReady = async (chunk, note, idempotency) => {
    try {
      const p = await send({
        query: "mutation CreateTransferReady($input: X!, $idempotencyKey: String!) { inventoryTransferCreateAsReadyToShip(input: $input) @idempotent(key: $idempotencyKey) { id } }",
        variables: { input: { originLocationId: ORIGIN, destinationLocationId: DEST, lineItems: chunk.lineItems, note } },
        idempotencyKey: idempotency.keyFor(oi.OUTBOUND_STAGE.TRANSFER_READY),
        rejectTag: "transfer",
        payloadField: "inventoryTransferCreateAsReadyToShip",
      });
      return p.inventoryTransfer;
    } catch (e) {
      if (!oi.shouldFallbackToDraftForReady(e)) throw e;
      const p = await send({
        query: "mutation CreateTransfer($input: X!, $idempotencyKey: String!) { inventoryTransferCreate(input: $input) @idempotent(key: $idempotencyKey) { id } }",
        variables: { input: { originLocationId: ORIGIN, destinationLocationId: DEST, lineItems: chunk.lineItems, note } },
        idempotencyKey: idempotency.keyFor(oi.OUTBOUND_STAGE.TRANSFER_DRAFT_FOR_READY),
        rejectTag: "transfer",
        payloadField: "inventoryTransferCreate",
      });
      return p.inventoryTransfer;
    }
  };
  const createShipment = async (movementId, chunk, idempotency) => {
    const p = await send({
      query: "mutation ShipmentCreateDraft($input: X!, $idempotencyKey: String!) { inventoryShipmentCreate(input: $input) @idempotent(key: $idempotencyKey) { id } }",
      variables: { input: { movementId, lineItems: chunk.lineItems } },
      idempotencyKey: idempotency.keyFor(oi.OUTBOUND_STAGE.SHIPMENT),
      rejectTag: "shipment",
      payloadField: "inventoryShipmentCreate",
    });
    return p.inventoryShipment;
  };
  return {
    createChunk: async ({ chunk, note, idempotency }) => {
      const t = await createReady(chunk, note, idempotency);
      const s = await createShipment(t.id, chunk, idempotency);
      return { transfer: t, shipment: s };
    },
    afterRecoveredChunk: async ({ transfer, shipment, chunk, idempotency }) => {
      if (shipment?.id) return { transfer, shipment };
      return { transfer, shipment: await createShipment(transfer.id, chunk, idempotency) };
    },
  };
}

function runCreate(sh, lineItems, extra = {}) {
  const h = inTransitHandlers(sh);
  return cp.runChunkedOutboundCreateWithCheckpoint({
    mode: "in_transit",
    originLocationId: ORIGIN,
    destinationLocationId: DEST,
    chunks: chunk250(lineItems),
    lineItemsForFingerprint: lineItems,
    adminGraphql: async (q, v) => sh.adminGraphql(q, v),
    createChunk: h.createChunk,
    afterRecoveredChunk: h.afterRecoveredChunk,
    ...extra,
  });
}
const keysOf = (sh, name) => sh.calls.filter((c) => c.name === name).map((c) => c.key);

let store;
beforeEach(() => {
  store = installPos();
});

describe("キーの材料（4.1）", () => {
  it("段・チャンク・回が違えば違うキー。どれも UUID v5", () => {
    const base = { shop: SHOP, attemptId: "oa_x", stage: "transfer_ready", chunkIndex0: 0, chunkTotal: 2 };
    const k = oi.buildOutboundCreateKey(base);
    assert.ok(isUuidV5(k));
    assert.equal(oi.buildOutboundCreateKey(base), k);
    for (const change of [{ stage: "shipment" }, { stage: "transfer_draft_for_ready" }, { chunkIndex0: 1 }, { rejections: 1 }, { attemptId: "oa_y" }]) {
      assert.notEqual(oi.buildOutboundCreateKey({ ...base, ...change }), k, JSON.stringify(change));
    }
    assert.notEqual(oi.buildOutboundEditKey({ shop: SHOP, opId: "oa_x", stage: "transfer_ready", chunkIndex0: 0, chunkTotal: 2 }), k);
  });
  it("rounds の無い前の形のチェックポイントは 0 回として読む。増やしても元は変えない", () => {
    const old = { v: 1, attemptId: "oa_x", fingerprint: "fp", created: [] };
    assert.deepEqual(oi.getCheckpointRounds(old, 0), { transfer: 0, shipment: 0 });
    const next = oi.bumpCheckpointRound(oi.bumpCheckpointRound(old, 1, "shipment"), 1, "shipment");
    assert.deepEqual(oi.getCheckpointRounds(next, 1), { transfer: 0, shipment: 2 });
    assert.equal(old.rounds, undefined);
    assert.equal(oi.formatOutboundRound(0), "main");
    assert.equal(oi.formatOutboundRound(2), "rej2");
  });
});

describe("POS 出庫の作成（チェックポイントと @idempotent）", () => {
  it("普通の確定: Transfer と Shipment を 1 回ずつ作り、チェックポイントを消す", async () => {
    const sh = fakeShopify();
    const r = await runCreate(sh, items(3));
    assert.equal(sh.transfers.length, 1);
    assert.equal(sh.shipments.length, 1);
    assert.equal(r.transfers.length, 1);
    assert.equal(store.has(cp.OUTBOUND_CREATE_CHECKPOINT_KEY), false);
    assert.ok(keysOf(sh, "CreateTransferReady").every(isUuidV5));
  });

  it("時間切れ（作れていたが答えが届かない）・照会でも見えない → 同じ内容で再確定 → 同じキー → Transfer は 1 つ", async () => {
    let first = true;
    const sh = fakeShopify({
      reply: (c) => {
        if (c.name === "CreateTransferReady" && first) {
          first = false;
          return "drop";
        }
        return null;
      },
    });
    // 照会では見えない（Shopify の反映が遅れた）ふり: 1 回目の確定の間だけ隠す
    const realGraphql = sh.adminGraphql;
    let hide = true;
    sh.adminGraphql = async (q, v) => (hide && /OutboundCpTransfers/.test(q) ? { inventoryTransfers: { nodes: [] } } : realGraphql(q, v));
    const sleepless = { toastFn: () => {} };
    await assert.rejects(
      cp.runChunkedOutboundCreateWithCheckpoint({
        mode: "in_transit",
        originLocationId: ORIGIN,
        destinationLocationId: DEST,
        chunks: chunk250(items(3)),
        lineItemsForFingerprint: items(3),
        adminGraphql: (q, v) => sh.adminGraphql(q, v),
        ...inTransitHandlers(sh),
        ...sleepless,
      }),
      /タイムアウトし、成功も未確認/
    );
    assert.equal(sh.transfers.length, 1);
    hide = true; // 2 回目も照会では見えないままにして、キーだけで守れることを見る
    await runCreate(sh, items(3));
    const keys = keysOf(sh, "CreateTransferReady");
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1]);
    assert.equal(sh.transfers.length, 1, "Transfer が 2 つできた");
    assert.equal(sh.shipments.length, 1);
  });

  it("断られた（userErrors）→ 回が増えてチェックポイントに残る → 次の再確定は違うキー", async () => {
    let n = 0;
    const sh = fakeShopify({
      reply: (c) => (c.name === "CreateTransferReady" && n++ === 0 ? userErr("inventoryTransferCreateAsReadyToShip", "Quantity is invalid") : null),
    });
    // 1 回目: READY が断られ、代わりの下書き（B）も断られる
    const sh2 = fakeShopify({ reply: (c) => (c.name !== "OutboundCpTransfers" ? userErr(c.name === "CreateTransfer" ? "inventoryTransferCreate" : "inventoryTransferCreateAsReadyToShip") : null) });
    await assert.rejects(runCreate(sh2, items(2)), /failed/);
    const saved = store.get(cp.OUTBOUND_CREATE_CHECKPOINT_KEY);
    assert.deepEqual(oi.getCheckpointRounds(saved, 0), { transfer: 1, shipment: 0 });
    // 段 A と B は違うキー
    const [a1] = keysOf(sh2, "CreateTransferReady");
    const [b1] = keysOf(sh2, "CreateTransfer");
    assert.notEqual(a1, b1);
    // 2 回目は新しい回 → 新しいキー
    await runCreate(sh, items(2));
    const a2 = keysOf(sh, "CreateTransferReady")[0];
    assert.notEqual(a2, a1);
    assert.equal(oi.buildOutboundCreateKey({ attemptId: saved.attemptId, stage: "transfer_ready", rejections: 1 }), a2);
    assert.equal(store.has(cp.OUTBOUND_CREATE_CHECKPOINT_KEY), false);
  });

  it("明細を変えて再確定 → 指紋が違う → attemptId が違う → 違うキー", async () => {
    const sh = fakeShopify({ reply: (c) => (c.name === "ShipmentCreateDraft" ? new Error("HTTP 502: bad gateway") : null) });
    await assert.rejects(runCreate(sh, items(2)), /502/);
    const before = store.get(cp.OUTBOUND_CREATE_CHECKPOINT_KEY);
    const sh2 = fakeShopify();
    await runCreate(sh2, items(2, 5));
    assert.notEqual(keysOf(sh2, "CreateTransferReady")[0], keysOf(sh, "CreateTransferReady")[0]);
    assert.ok(before.attemptId);
  });

  it("Shipment の時間切れのあとの補完は、作成のときと同じキー（前の Shipment ができていれば 2 つにならない）", async () => {
    let dropped = false;
    const sh = fakeShopify({
      reply: (c) => {
        if (c.name === "ShipmentCreateDraft" && !dropped) {
          dropped = true;
          return "drop";
        }
        return null;
      },
    });
    // 照会では Transfer は見えるが Shipment は見えない（前の残る穴の形）
    const realGraphql = sh.adminGraphql;
    sh.adminGraphql = async (q, v) => {
      const d = await realGraphql(q, v);
      if (/OutboundCpTransfers/.test(q)) {
        return { inventoryTransfers: { nodes: d.inventoryTransfers.nodes.map((t) => ({ ...t, shipments: { nodes: [] } })) } };
      }
      return d;
    };
    await runCreate(sh, items(2), { toastFn: () => {} });
    const keys = keysOf(sh, "ShipmentCreateDraft");
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1]);
    assert.equal(sh.shipments.length, 1, "Shipment が 2 つできた");
    assert.equal(sh.transfers.length, 1);
  });

  it("Shipment が断られた → shipment の回だけ増える。再確定は照会で Transfer を見つけ、Shipment を新しいキーで作る", async () => {
    let n = 0;
    const sh = fakeShopify({ reply: (c) => (c.name === "ShipmentCreateDraft" && n++ === 0 ? userErr("inventoryShipmentCreate") : null) });
    await assert.rejects(runCreate(sh, items(2)), /inventoryShipmentCreate failed/);
    const saved = store.get(cp.OUTBOUND_CREATE_CHECKPOINT_KEY);
    assert.deepEqual(oi.getCheckpointRounds(saved, 0), { transfer: 0, shipment: 1 });
    await runCreate(sh, items(2));
    const keys = keysOf(sh, "ShipmentCreateDraft");
    assert.equal(keys.length, 2);
    assert.notEqual(keys[0], keys[1]);
    assert.equal(sh.transfers.length, 1);
    assert.equal(sh.shipments.length, 1);
  });

  it("251 件: 2 つ目のチャンクが断られても 1 つ目は作り直さない。2 つ目だけ回が増える", async () => {
    let n = 0;
    const sh = fakeShopify({
      reply: (c) =>
        c.name === "CreateTransferReady" && c.variables.input.note.includes("#2/2") && n++ === 0
          ? userErr("inventoryTransferCreateAsReadyToShip")
          : c.name === "CreateTransfer" && c.variables.input.note.includes("#2/2") && n === 1
            ? userErr("inventoryTransferCreate")
            : null,
    });
    await assert.rejects(runCreate(sh, items(251)), /failed/);
    assert.equal(sh.transfers.length, 1);
    const saved = store.get(cp.OUTBOUND_CREATE_CHECKPOINT_KEY);
    assert.deepEqual(oi.getCheckpointRounds(saved, 0), { transfer: 0, shipment: 0 });
    assert.deepEqual(oi.getCheckpointRounds(saved, 1), { transfer: 1, shipment: 0 });
    const r = await runCreate(sh, items(251));
    assert.equal(r.transfers.length, 2);
    assert.equal(sh.transfers.length, 2, "1 つ目が二重になった");
    assert.equal(sh.shipments.length, 2);
  });

  it("@idempotent の返事（処理中のまま・中身の違い）では READY の代わりの道へ進まず、回も増やさない", async () => {
    const sh = fakeShopify({
      reply: (c) =>
        c.name === "CreateTransferReady"
          ? { inventoryTransferCreateAsReadyToShip: { userErrors: [{ field: null, code: "IDEMPOTENCY_CONCURRENT_REQUEST", message: "in progress" }] } }
          : null,
    });
    await assert.rejects(runCreate(sh, items(2)), (e) => oi.isOutboundIdempotencyError(e) && e.idempotencyIssue === "concurrent");
    assert.equal(keysOf(sh, "CreateTransfer").length, 0, "代わりの下書きへ進んだ");
    assert.equal(new Set(keysOf(sh, "CreateTransferReady")).size, 1, "処理中の送り直しは同じキー");
    assert.equal(keysOf(sh, "CreateTransferReady").length, 4, "1・2・4 秒の 3 回送り直す");
    assert.deepEqual(oi.getCheckpointRounds(store.get(cp.OUTBOUND_CREATE_CHECKPOINT_KEY), 0), { transfer: 0, shipment: 0 });
    assert.equal(sh.transfers.length, 0);
  });

  it("23 時間より古い続きで、note の照会ができないときは作らない（キーがもう効かないかもしれない）", async () => {
    const sh = fakeShopify({ reply: (c) => (c.name === "ShipmentCreateDraft" ? new Error("HTTP 502") : null) });
    await assert.rejects(runCreate(sh, items(2)), /502/);
    const saved = store.get(cp.OUTBOUND_CREATE_CHECKPOINT_KEY);
    store.set(cp.OUTBOUND_CREATE_CHECKPOINT_KEY, { ...saved, startedAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString() });
    const sh2 = fakeShopify({ lookupFails: true });
    await assert.rejects(runCreate(sh2, items(2)), /時間がたっている/);
    assert.equal(keysOf(sh2, "CreateTransferReady").length, 0);
    // 前の形（startedAt が無い）は今までどおり進む
    store.set(cp.OUTBOUND_CREATE_CHECKPOINT_KEY, { ...saved, startedAt: undefined });
    await runCreate(sh2, items(2));
    assert.equal(keysOf(sh2, "CreateTransferReady").length, 1);
    assert.equal(cp.isCheckpointOlderThanKeyTrust({ startedAt: new Date(Date.now() - 22 * 3600 * 1000).toISOString() }), false);
  });
});

describe("送り方（3.3）", () => {
  const q = "mutation M($i: X!, $idempotencyKey: String!) { inventoryTransferSetItems(input: $i) @idempotent(key: $idempotencyKey) { id } }";
  it("中身の違いは送り直さず OutboundIdempotencyError。文は代わりの道・時間切れの見分けに当たらない", async () => {
    let calls = 0;
    const g = async () => {
      calls++;
      return { inventoryTransferSetItems: { userErrors: [{ field: null, code: "IDEMPOTENCY_KEY_PARAMETER_MISMATCH", message: "x" }] } };
    };
    const err = await oi
      .sendOutboundIdempotent({ adminGraphql: g, query: q, variables: {}, idempotencyKey: "k", payloadField: "inventoryTransferSetItems" })
      .catch((e) => e);
    assert.equal(calls, 1);
    assert.equal(err.idempotencyIssue, "mismatch");
    assert.equal(oi.shouldFallbackToDraftForReady(err), false);
    assert.equal(cp.isTimeoutLikeError(err), false);
    assert.equal(oi.getOutboundRejectedTag(err), null);
  });
  it("はっきりした断りには印（回を増やす）、投げられた失敗には付けない", async () => {
    const rej = await oi
      .sendOutboundIdempotent({
        adminGraphql: async () => userErr("inventoryTransferSetItems"),
        query: q,
        variables: {},
        idempotencyKey: "k",
        payloadField: "inventoryTransferSetItems",
        rejectTag: "set_items@1/1",
      })
      .catch((e) => e);
    assert.equal(oi.getOutboundRejectedTag(rej), "set_items@1/1");
    const thrown = await oi
      .sendOutboundIdempotent({
        adminGraphql: async () => {
          throw new Error("timeout 20000ms");
        },
        query: q,
        variables: {},
        idempotencyKey: "k",
        payloadField: "inventoryTransferSetItems",
      })
      .catch((e) => e);
    assert.equal(oi.getOutboundRejectedTag(thrown), null);
    assert.ok(cp.isTimeoutLikeError(thrown));
  });
  it("キーが無ければ送らない（付け忘れを黙って通さない）", async () => {
    let calls = 0;
    await assert.rejects(
      oi.sendOutboundIdempotent({ adminGraphql: async () => calls++, query: q, variables: {}, payloadField: "x" }),
      /idempotencyKey がありません/
    );
    assert.equal(calls, 0);
  });
});

describe("編集・配送の追加（4.2・編集のチェックポイント）", () => {
  const T = "gid://shopify/InventoryTransfer/77";
  const setItems = (sh, lineItems) =>
    cp.runOutboundEditWithCheckpoint({ action: "draft_save", transferId: T, lineItems }, ({ keyFor, tagFor }) =>
      oi.sendOutboundIdempotent({
        adminGraphql: sh.adminGraphql,
        query: "mutation InventoryTransferSetItems($input: X!, $idempotencyKey: String!) { inventoryTransferSetItems(input: $input) @idempotent(key: $idempotencyKey) { id } }",
        variables: { input: { id: T, lineItems } },
        idempotencyKey: keyFor(oi.OUTBOUND_STAGE.SET_ITEMS),
        rejectTag: tagFor(oi.OUTBOUND_STAGE.SET_ITEMS),
        payloadField: "inventoryTransferSetItems",
        concurrentDelaysMs: FAST,
      })
    );
  const A = items(2);
  const B = items(2, 3);
  const EK = cp.outboundEditCheckpointKey("draft_save", T);

  it("時間切れのあとの押し直しは同じキー。成功したら消えて、A → B → A の 3 回目は 1 回目と違うキー", async () => {
    let first = true;
    const sh = fakeShopify({
      reply: (c) => {
        if (first) {
          first = false;
          return "drop";
        }
        return null;
      },
    });
    await assert.rejects(setItems(sh, A), /timeout/);
    assert.ok(store.has(EK), "送る前に残していない");
    await setItems(sh, A);
    assert.equal(store.has(EK), false);
    await setItems(sh, B);
    await setItems(sh, A);
    const k = keysOf(sh, "InventoryTransferSetItems");
    assert.equal(k.length, 4);
    assert.equal(k[0], k[1]);
    assert.equal(new Set(k).size, 3);
    const t = sh.transfers.find((x) => x.id === T);
    assert.deepEqual(t.lineItems, A, "3 回目が前の答えだけ返して書かれなかった");
    assert.equal(t.setCount, 3);
  });

  it("断られたら回が増えて次は違うキー。違う Transfer・違う動きは違う opId", async () => {
    let n = 0;
    const sh = fakeShopify({ reply: () => (n++ === 0 ? userErr("inventoryTransferSetItems") : null) });
    await assert.rejects(setItems(sh, A), /failed/);
    assert.equal(store.get(EK).rounds["set_items@1/1"], 1);
    await setItems(sh, A);
    const k = keysOf(sh, "InventoryTransferSetItems");
    assert.notEqual(k[0], k[1]);
    assert.notEqual(
      cp.buildOutboundEditFingerprint({ action: "draft_save", transferId: T, lineItems: A }),
      cp.buildOutboundEditFingerprint({ action: "edit_ready", transferId: T, lineItems: A })
    );
    assert.equal(
      cp.buildOutboundEditFingerprint({ action: "x", transferId: T, lineItems: [...A].reverse() }),
      cp.buildOutboundEditFingerprint({ action: "x", transferId: T, lineItems: A })
    );
  });

  it("23 時間より古い編集のチェックポイントは使わない（新しい opId）", async () => {
    const sh = fakeShopify({ reply: () => new Error("HTTP 502") });
    await assert.rejects(setItems(sh, A), /502/);
    const saved = store.get(EK);
    store.set(EK, { ...saved, startedAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString() });
    const sh2 = fakeShopify();
    await setItems(sh2, A);
    assert.notEqual(keysOf(sh2, "InventoryTransferSetItems")[0], keysOf(sh, "InventoryTransferSetItems")[0]);
  });

  it("配送の追加（251 件・2 つ）: 2 つ目が断られて押し直しても、1 つ目の配送は 2 つにならない", async () => {
    let n = 0;
    const lines = items(251);
    const sh = fakeShopify({ reply: (c) => (c.variables.input.lineItems.length === 1 && n++ === 0 ? userErr("inventoryShipmentCreate") : null) });
    sh.transfers.push({ id: T, status: "READY_TO_SHIP", shipments: { nodes: [] } });
    const add = () =>
      cp.runOutboundEditWithCheckpoint({ action: "add_shipment_ready", transferId: T, lineItems: lines }, async ({ keyFor, tagFor }) => {
        const out = [];
        const chunks = chunk250(oi.sortOutboundLinesForChunking(lines, [], 250).lineItems);
        for (let i = 0; i < chunks.length; i++) {
          const p = await oi.sendOutboundIdempotent({
            adminGraphql: sh.adminGraphql,
            query: "mutation ShipmentCreateDraft($input: X!, $idempotencyKey: String!) { inventoryShipmentCreate(input: $input) @idempotent(key: $idempotencyKey) { id } }",
            variables: { input: { movementId: T, lineItems: chunks[i].lineItems } },
            idempotencyKey: keyFor(oi.OUTBOUND_STAGE.SHIPMENT, i, chunks.length),
            rejectTag: tagFor(oi.OUTBOUND_STAGE.SHIPMENT, i, chunks.length),
            payloadField: "inventoryShipmentCreate",
          });
          out.push(p.inventoryShipment);
        }
        return out;
      });
    await assert.rejects(add(), /failed/);
    const r = await add();
    assert.equal(r.length, 2);
    assert.equal(sh.shipments.length, 2, "1 つ目の配送が二重になった");
  });
});

describe("編集のチェックポイントの直し（#114 の見直し P2・P3）", () => {
  const T1 = "gid://shopify/InventoryTransfer/101";
  const T2 = "gid://shopify/InventoryTransfer/102";
  const L = items(3);
  /** 配送の追加（add_shipment_ready と同じ形。250 件ずつ） */
  const addShip = (sh, transferId, lines, extra = {}) =>
    cp.runOutboundEditWithCheckpoint(
      { action: "add_shipment_ready", transferId, lineItems: lines, createsShipment: true, ...extra },
      async ({ keyFor, tagFor }) => {
        const out = [];
        const chunks = chunk250(oi.sortOutboundLinesForChunking(lines, [], 250).lineItems);
        for (let i = 0; i < chunks.length; i++) {
          const p = await oi.sendOutboundIdempotent({
            adminGraphql: sh.adminGraphql,
            query: "mutation ShipmentCreateDraft($input: X!, $idempotencyKey: String!) { inventoryShipmentCreate(input: $input) @idempotent(key: $idempotencyKey) { id } }",
            variables: { input: { movementId: transferId, lineItems: chunks[i].lineItems } },
            idempotencyKey: keyFor(oi.OUTBOUND_STAGE.SHIPMENT, i, chunks.length),
            rejectTag: tagFor(oi.OUTBOUND_STAGE.SHIPMENT, i, chunks.length),
            payloadField: "inventoryShipmentCreate",
            concurrentDelaysMs: FAST,
          });
          out.push(p.inventoryShipment);
        }
        return out;
      }
    );
  const setItems = (sh, transferId, lines, action = "draft_save") =>
    cp.runOutboundEditWithCheckpoint({ action, transferId, lineItems: lines }, ({ keyFor, tagFor }) =>
      oi.sendOutboundIdempotent({
        adminGraphql: sh.adminGraphql,
        query: "mutation InventoryTransferSetItems($input: X!, $idempotencyKey: String!) { inventoryTransferSetItems(input: $input) @idempotent(key: $idempotencyKey) { id } }",
        variables: { input: { id: transferId, lineItems: lines } },
        idempotencyKey: keyFor(oi.OUTBOUND_STAGE.SET_ITEMS),
        rejectTag: tagFor(oi.OUTBOUND_STAGE.SET_ITEMS),
        payloadField: "inventoryTransferSetItems",
        concurrentDelaysMs: FAST,
      })
    );
  const dropFirst = (name) => {
    let done = false;
    return (c) => {
      if (!done && c.name === name) {
        done = true;
        return "drop";
      }
      return null;
    };
  };
  const ageSlot = (key, hours) => {
    const saved = store.get(key);
    store.set(key, { ...saved, startedAt: new Date(Date.now() - hours * 3600 * 1000).toISOString() });
  };

  it("P2-1: 配送の追加が時間切れ → 別の Transfer の下書き保存 → 戻って押し直しても、配送は 1 つ（入れ物が動き + Transfer ごと）", async () => {
    const sh = fakeShopify({ reply: dropFirst("ShipmentCreateDraft") });
    sh.transfers.push({ id: T1, status: "READY_TO_SHIP", shipments: { nodes: [] } });
    await assert.rejects(addShip(sh, T1, L), /timeout/);
    await setItems(sh, T2, items(1));
    // 同じ Transfer の別の動き（下書き保存）も、配送の追加の入れ物を消さない
    await setItems(sh, T1, items(1), "edit_draft_save");
    assert.ok(store.has(cp.outboundEditCheckpointKey("add_shipment_ready", T1)), "配送の追加の入れ物が消えた");
    const r = await addShip(sh, T1, L);
    assert.equal(r.length, 1);
    const k = keysOf(sh, "ShipmentCreateDraft");
    assert.equal(k[0], k[1], "押し直しが新しいキーになった");
    assert.equal(sh.shipments.length, 1, "配送が 2 つになった");
    assert.equal(store.has(cp.outboundEditCheckpointKey("add_shipment_ready", T1)), false, "成功で消えていない");
  });

  it("P2-2: 23 時間より古い配送の追加の続きは、一度だけ注意して止める（送らない）。次の押し直しで新しいキー", async () => {
    const sh = fakeShopify({ reply: dropFirst("ShipmentCreateDraft") });
    await assert.rejects(addShip(sh, T1, L), /timeout/);
    ageSlot(cp.outboundEditCheckpointKey("add_shipment_ready", T1), 24);
    const before = sh.calls.length;
    await assert.rejects(addShip(sh, T1, L), (e) => {
      assert.ok(cp.isOutboundEditStaleWarning(e));
      assert.equal(e.staleReason, "stale");
      assert.match(e.message, /23 時間/);
      assert.equal(oi.shouldFallbackToDraftForReady(e), false);
      assert.equal(cp.isTimeoutLikeError(e), false);
      return true;
    });
    assert.equal(sh.calls.length, before, "注意のときに送った");
    await addShip(sh, T1, L);
    const k = keysOf(sh, "ShipmentCreateDraft");
    assert.equal(k.length, 2);
    assert.notEqual(k[0], k[1]);
  });

  it("P2-2: 結果の分からない配送の追加のあとに明細を変えたときも一度注意。はっきり断られただけなら注意しない", async () => {
    const sh = fakeShopify({ reply: dropFirst("ShipmentCreateDraft") });
    await assert.rejects(addShip(sh, T1, L), /timeout/);
    await assert.rejects(addShip(sh, T1, items(4)), (e) => cp.isOutboundEditStaleWarning(e) && e.staleReason === "changed");
    await addShip(sh, T1, items(4));
    assert.equal(keysOf(sh, "ShipmentCreateDraft").length, 2);

    let n = 0;
    const sh2 = fakeShopify({ reply: (c) => (c.name === "ShipmentCreateDraft" && n++ === 0 ? userErr("inventoryShipmentCreate") : null) });
    await assert.rejects(addShip(sh2, T2, L), /failed/);
    assert.equal(store.get(cp.outboundEditCheckpointKey("add_shipment_ready", T2)).outcome, "rejected_clean");
    await addShip(sh2, T2, items(4));
    assert.equal(sh2.shipments.length, 1);
  });

  it("P2-2: 251 件で 2 つ目が断られたあとに明細を変えたら注意する（1 つ目の配送はできている）", async () => {
    let n = 0;
    const lines = items(251);
    const sh = fakeShopify({ reply: (c) => (c.name === "ShipmentCreateDraft" && c.variables.input.lineItems.length === 1 && n++ === 0 ? userErr("inventoryShipmentCreate") : null) });
    await assert.rejects(addShip(sh, T1, lines), /failed/);
    assert.equal(store.get(cp.outboundEditCheckpointKey("add_shipment_ready", T1)).outcome, "unknown");
    await assert.rejects(addShip(sh, T1, items(252)), (e) => cp.isOutboundEditStaleWarning(e));
  });

  it("配送を作らない動き（明細の書き換えだけ）は、古い続きでも注意しない（前と同じ）", async () => {
    const sh = fakeShopify({ reply: dropFirst("InventoryTransferSetItems") });
    await assert.rejects(setItems(sh, T1, L), /timeout/);
    ageSlot(cp.outboundEditCheckpointKey("draft_save", T1), 24);
    await setItems(sh, T1, L);
    const k = keysOf(sh, "InventoryTransferSetItems");
    assert.notEqual(k[0], k[1]);
  });

  it("P3-3: 明細の書き換えの中身の違い（並びが変わった押し直し）は、回を増やして次は通る", async () => {
    const sh = fakeShopify({ reply: dropFirst("InventoryTransferSetItems") });
    await assert.rejects(setItems(sh, T1, L), /timeout/);
    const rev = [...L].reverse();
    await assert.rejects(setItems(sh, T1, rev), (e) => {
      assert.equal(e.idempotencyIssue, "mismatch");
      assert.match(e.message, /明細の並び/);
      assert.equal(oi.shouldFallbackToDraftForReady(e), false);
      return true;
    });
    assert.equal(store.get(cp.outboundEditCheckpointKey("draft_save", T1)).rounds["set_items@1/1"], 1);
    await setItems(sh, T1, rev);
    const k = keysOf(sh, "InventoryTransferSetItems");
    assert.equal(k[0], k[1]);
    assert.notEqual(k[1], k[2]);
    assert.deepEqual(sh.transfers.find((t) => t.id === T1).lineItems, rev);
  });

  it("P3-3: 配送の作成の中身の違いは、その続きを使わない（次は注意を重ねずに新しいキー）", async () => {
    const sh = fakeShopify({ reply: dropFirst("ShipmentCreateDraft") });
    await assert.rejects(addShip(sh, T1, L), /timeout/);
    const rev = [...L].reverse();
    await assert.rejects(addShip(sh, T1, rev), (e) => oi.isOutboundIdempotencyError(e) && e.idempotencyIssue === "mismatch");
    const saved = store.get(cp.outboundEditCheckpointKey("add_shipment_ready", T1));
    assert.equal(saved.noReuse, true);
    await addShip(sh, T1, rev);
    const k = keysOf(sh, "ShipmentCreateDraft");
    assert.equal(k.length, 3);
    assert.equal(k[0], k[1]);
    assert.notEqual(k[1], k[2]);
  });

  it("作成のチェックポイントは中身の違いの印を見ない（前と同じ: 回は増えない）", async () => {
    const e = await oi
      .sendOutboundIdempotent({
        adminGraphql: async () => ({ x: { userErrors: [{ code: "IDEMPOTENCY_KEY_PARAMETER_MISMATCH", message: "m" }] } }),
        query: "mutation M { x }",
        idempotencyKey: "k",
        payloadField: "x",
        rejectTag: "transfer",
      })
      .catch((x) => x);
    assert.equal(oi.getOutboundRejectedTag(e), null);
    assert.equal(oi.getOutboundMismatchTag(e), "transfer");
  });

  it("P3-4: 今ある Shipment がもう下書きでなければ発送済みにし直さない。読めないときは前と同じく送る", async () => {
    const S = "gid://shopify/InventoryShipment/9";
    const marks = [];
    const markInTransit = async (id) => (marks.push(id), { id, status: "IN_TRANSIT" });
    const g = (status) => async () => ({ inventoryShipment: { id: S, status } });
    assert.deepEqual(await cp.markShipmentInTransitUnlessAlready({ adminGraphql: g("IN_TRANSIT"), shipmentId: S, markInTransit }), { id: S, status: "IN_TRANSIT" });
    assert.equal(marks.length, 0);
    await cp.markShipmentInTransitUnlessAlready({ adminGraphql: g("DRAFT"), shipmentId: S, markInTransit });
    assert.equal(marks.length, 1);
    await cp.markShipmentInTransitUnlessAlready({
      adminGraphql: async () => {
        throw new Error("HTTP 503");
      },
      shipmentId: S,
      markInTransit,
    });
    assert.equal(marks.length, 2);
  });

  it("#115 P2: 配送の追加（在庫移動中）が時間切れ → 同じ Transfer で下書き保存の配送の追加 → 一度注意して送らない。次は送る。元のボタンに戻った押し直しは同じキー", async () => {
    const sh = fakeShopify({ reply: dropFirst("ShipmentCreateDraft") });
    sh.transfers.push({ id: T1, status: "READY_TO_SHIP", shipments: { nodes: [] } });
    await assert.rejects(addShip(sh, T1, L, { action: "add_shipment_in_transit" }), /timeout/);
    assert.equal(sh.shipments.length, 1, "じつは配送ができている");
    const before = sh.calls.length;
    await assert.rejects(addShip(sh, T1, L, { action: "add_shipment_draft" }), (e) => {
      assert.ok(cp.isOutboundEditStaleWarning(e));
      assert.equal(e.staleReason, "other_action");
      assert.match(e.message, /別のボタン/);
      assert.match(e.message, /管理画面/);
      assert.equal(oi.shouldFallbackToDraftForReady(e), false);
      assert.equal(cp.isTimeoutLikeError(e), false);
      return true;
    });
    assert.equal(sh.calls.length, before, "注意のときに送った");
    const sib = store.get(cp.outboundEditCheckpointKey("add_shipment_in_transit", T1));
    assert.ok(sib?.warnedAt, "前の入れ物に注意の印が付いていない");
    assert.equal(sib.outcome, "unknown", "前の入れ物の結果を変えた");
    // 注意は一度だけ: 次の押し直しは送る（人が管理画面で確かめたあと）
    await addShip(sh, T1, L, { action: "add_shipment_draft" });
    assert.equal(sh.shipments.length, 2);
    // 元のボタンに戻った押し直しは前と同じキー（Shopify は前の答えを返し、配送を増やさない）。注意も重ねない
    await addShip(sh, T1, L, { action: "add_shipment_in_transit" });
    const k = keysOf(sh, "ShipmentCreateDraft");
    assert.equal(k.length, 3);
    assert.equal(k[0], k[2], "元のボタンの押し直しが新しいキーになった");
    assert.notEqual(k[0], k[1]);
    assert.equal(sh.shipments.length, 2, "元のボタンの押し直しで配送が増えた");
  });

  it("#115 P2: edit_in_transit の新しい配送の結果が分からないまま配送準備完了に切り替えても一度注意。今ある Shipment を選んだ形は注意しない", async () => {
    const sh = fakeShopify();
    const fail502 = async () => {
      throw new Error("HTTP 502");
    };
    await assert.rejects(
      cp.runOutboundEditWithCheckpoint(
        { action: "edit_in_transit", transferId: T1, lineItems: L, extra: "ship=new", createsShipment: true },
        fail502
      ),
      /502/
    );
    await assert.rejects(addShip(sh, T1, L), (e) => cp.isOutboundEditStaleWarning(e) && e.staleReason === "other_action");
    await addShip(sh, T1, L);
    assert.equal(sh.shipments.length, 1);

    // 今ある Shipment を選んだ edit_in_transit（配送を作らない）の続きは、ほかの配送を作る動きを止めない
    await assert.rejects(
      cp.runOutboundEditWithCheckpoint(
        { action: "edit_in_transit", transferId: T2, lineItems: L, extra: "ship=gid://shopify/InventoryShipment/5" },
        fail502
      ),
      /502/
    );
    assert.equal(store.get(cp.outboundEditCheckpointKey("edit_in_transit", T2)).createsShipment, false);
    await addShip(sh, T2, L);
    // 同じ入れ物で新しい配送に切り替えても、前の続きは配送を作っていないので注意しない
    await assert.rejects(
      cp.runOutboundEditWithCheckpoint(
        { action: "edit_in_transit", transferId: T2, lineItems: L, extra: "ship=gid://shopify/InventoryShipment/5" },
        fail502
      ),
      /502/
    );
    await assert.rejects(
      cp.runOutboundEditWithCheckpoint(
        { action: "edit_in_transit", transferId: T2, lineItems: L, extra: "ship=new", createsShipment: true },
        fail502
      ),
      (e) => !cp.isOutboundEditStaleWarning(e)
    );
  });

  it("#115 P2: ほかの動きの続きでも、別の Transfer・はっきり断られただけ・注意ずみ・明細の書き換えだけの動きなら注意しない", async () => {
    // 別の Transfer の配送の追加が時間切れでも、T1 は止めない
    const sh = fakeShopify({ reply: dropFirst("ShipmentCreateDraft") });
    await assert.rejects(addShip(sh, T2, L, { action: "add_shipment_in_transit" }), /timeout/);
    await addShip(sh, T1, L, { action: "add_shipment_draft" });

    // 1 つ目の配送ではっきり断られた続き（配送はまだ無い）は注意しない
    let n = 0;
    const sh2 = fakeShopify({ reply: (c) => (c.name === "ShipmentCreateDraft" && n++ === 0 ? userErr("inventoryShipmentCreate") : null) });
    const T3 = "gid://shopify/InventoryTransfer/103";
    await assert.rejects(addShip(sh2, T3, L, { action: "add_shipment_in_transit" }), /failed/);
    await addShip(sh2, T3, L, { action: "add_shipment_ready" });
    assert.equal(sh2.shipments.length, 1);

    // 明細の書き換えだけの動き（下書き保存）は、配送の追加の続きがあっても止めない（配送を作らない）
    const sh3 = fakeShopify({ reply: dropFirst("ShipmentCreateDraft") });
    const T4 = "gid://shopify/InventoryTransfer/104";
    sh3.transfers.push({ id: T4, status: "DRAFT", shipments: { nodes: [] } });
    await assert.rejects(addShip(sh3, T4, L, { action: "add_shipment_in_transit" }), /timeout/);
    await setItems(sh3, T4, items(1), "edit_draft_save");
    assert.equal(store.get(cp.outboundEditCheckpointKey("add_shipment_in_transit", T4)).warnedAt, undefined);

    // 2 つの動きの続きが残っていても、注意は 1 回ずつ（同じ入れ物で重ねない）
    await assert.rejects(addShip(sh3, T4, L, { action: "add_shipment_ready" }), (e) => e.staleReason === "other_action");
    await addShip(sh3, T4, L, { action: "add_shipment_ready" });
    await addShip(sh3, T4, L, { action: "add_shipment_draft" });
  });

  it("残った入れ物は一覧で片付ける（7 日より古いもの・30 を超えた古いもの）", async () => {
    const t0 = Date.now();
    const sh = fakeShopify({ reply: () => new Error("HTTP 502") });
    await assert.rejects(setItems(sh, "gid://shopify/InventoryTransfer/old", L), /502/);
    const oldKey = cp.outboundEditCheckpointKey("draft_save", "gid://shopify/InventoryTransfer/old");
    const idx = store.get(cp.OUTBOUND_EDIT_CHECKPOINT_INDEX_KEY);
    store.set(cp.OUTBOUND_EDIT_CHECKPOINT_INDEX_KEY, idx.map((x) => ({ ...x, at: t0 - 8 * 24 * 3600 * 1000 })));
    for (let i = 0; i < 32; i++) {
      await assert.rejects(
        cp.runOutboundEditWithCheckpoint(
          { action: "draft_save", transferId: `gid://shopify/InventoryTransfer/x${i}`, lineItems: L, now: () => t0 + i },
          async () => {
            throw new Error("HTTP 502");
          }
        ),
        /502/
      );
    }
    assert.equal(store.has(oldKey), false, "7 日より古い入れ物が残った");
    const list = store.get(cp.OUTBOUND_EDIT_CHECKPOINT_INDEX_KEY);
    assert.equal(list.length, cp.OUTBOUND_EDIT_CHECKPOINT_MAX);
    assert.equal(store.has(cp.outboundEditCheckpointKey("draft_save", "gid://shopify/InventoryTransfer/x0")), false);
    assert.ok(store.has(cp.outboundEditCheckpointKey("draft_save", "gid://shopify/InventoryTransfer/x31")));
  });
});

describe("並べ方と有効化のキー", () => {
  it("250 件を超えるときだけ inventoryItemId の順に並べ、補足は ID で付け直す", () => {
    const li = items(251).reverse();
    const meta = li.map((x) => ({ inventoryItemId: x.inventoryItemId, label: `L${x.inventoryItemId.slice(-4)}` }));
    const r = oi.sortOutboundLinesForChunking(li, meta, 250);
    assert.equal(r.lineItems[0].inventoryItemId, "gid://shopify/InventoryItem/0001");
    assert.equal(r.lineItemsMeta[0].label, "L0001");
    const small = items(3).reverse();
    assert.equal(oi.sortOutboundLinesForChunking(small, [], 250).lineItems, small);
  });
  it("有効化: 初めの数を渡すときは段に入る（渡さない入庫は前と同じ -:-）", () => {
    const base = { shop: SHOP, operationId: "adhoc-1", locationId: DEST, inventoryItemId: "gid://shopify/InventoryItem/1" };
    assert.equal(buildActivateKeyForPos(base), buildActivateKeyForPos({ ...base, available: null, onHand: null }));
    assert.notEqual(buildActivateKeyForPos({ ...base, available: 5, onHand: 5 }), buildActivateKeyForPos(base));
    assert.notEqual(buildActivateKeyForPos({ ...base, available: 5, onHand: 5 }), buildActivateKeyForPos({ ...base, available: 6, onHand: 6 }));
  });
});

describe("ModalOutbound.jsx の配線（読むだけ）", () => {
  const src = readFileSync(new URL("../extensions/stock-transfer-tile/src/ModalOutbound.jsx", import.meta.url), "utf8");
  it("明細の書き換え・配送の追加の呼び出しは、どれも編集のチェックポイントの中（キーなしで送ると止まる）", () => {
    const setItemsCalls = src.match(/(?<!function )inventoryTransferSetItemsSafe\(\{/g) ?? [];
    assert.equal(setItemsCalls.length, 5);
    const idem = src.match(/inventoryTransferSetItemsSafe\(\{\s*id: \w+,\s*lineItems,\s*idem: \{ key: keyFor\(OUTBOUND_STAGE\.SET_ITEMS\)/g) ?? [];
    assert.equal(idem.length, 5);
    assert.equal((src.match(/runOutboundEditWithCheckpoint\(/g) ?? []).length, 8);
  });
  it("READY の代わりの道は shouldFallbackToDraftForReady で見分ける（@idempotent の返事では進まない）", () => {
    assert.match(src, /if \(shouldFallbackToDraftForReady\(e\)\)/);
  });
  it("配送を作る動きは createsShipment（注意のため）。今ある Shipment は状態を見てから発送済みにする", () => {
    assert.equal((src.match(/createsShipment: true \}/g) ?? []).length, 3);
    assert.match(src, /createsShipment: !useSelectedShipment/);
    assert.match(src, /markShipmentInTransitUnlessAlready\(\{\s*adminGraphql,\s*shipmentId: selectedShipmentIdForConfirm/);
    assert.doesNotMatch(src, /inventoryShipmentMarkInTransit\(selectedShipmentIdForConfirm\)/);
    assert.equal((src.match(/isOutboundEditStaleWarning\(e\)/g) ?? []).length, 3);
  });
  it("時間切れのあとの補完で、もう下書きでない Shipment は発送済みにし直さない", () => {
    assert.match(src, /if \(draftStatus && draftStatus !== "DRAFT"\) return draft;/);
  });
});
