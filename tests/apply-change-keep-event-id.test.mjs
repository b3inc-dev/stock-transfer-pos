/**
 * ロス・仕入れ・調整: 応答が無いまま終わっても、同じ操作は同じ appEventId で送り直す。
 * 新しい ID になると、前の送信がサーバーに届いていた場合に在庫がもう一度動く。
 * Run: node --test tests/apply-change-keep-event-id.test.mjs
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyInventoryChangeToApi, isFinalApplyRejection } from "../extensions/common/applyInventoryChange.js";
import {
  beginConfirmOperation,
  canDiscardPendingOperation,
  clearLocationDraft,
  operationToKeepAfterError,
  pendingLinesChanged,
  planDraftRestore,
  rememberOperationBeforeSend,
  resolveConfirmLines,
  settleOperationAfterError,
  shouldReuseOperationAfterError,
} from "../extensions/common/confirmOperationRetry.js";

const LOCATION = "gid://shopify/Location/1";
const KEY = "stock_transfer_pos_loss_draft_v1";

function memoryStorage() {
  return {
    data: {},
    async get(k) { return this.data[k] ?? null; },
    async set(k, v) { this.data[k] = JSON.parse(JSON.stringify(v)); },
    async delete(k) { delete this.data[k]; },
  };
}

/**
 * apply-change の代わり。appEventId ごとに 1 回だけ在庫を動かし、同じ ID は completed を返す（main と同じ）。
 * `lose` が返す値が true の送信は、サーバーでは処理したのに POS へ応答が届かない（TypeError: Load failed）。
 */
function fakeServer({ lose = () => false, reject = () => null } = {}) {
  const server = { stock: 10, events: new Map(), sent: [] };
  globalThis.shopify = { session: { getSessionToken: async () => "tok" } };
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const n = server.sent.length + 1;
    server.sent.push(body.appEventId);
    const rejected = reject(n, body);
    if (rejected) {
      return { ok: false, status: rejected.status, statusText: "", json: async () => rejected.body };
    }
    if (!server.events.has(body.appEventId)) {
      for (const e of body.entries) server.stock += Number(e.delta || 0);
      server.events.set(body.appEventId, "completed");
    }
    if (lose(n, body)) throw new TypeError("Load failed");
    return {
      ok: true,
      status: 200,
      statusText: "",
      json: async () => ({ ok: true, appEventId: body.appEventId, status: "completed" }),
    };
  };
  return server;
}

/** LossProductList の handleConfirm と同じ順で、ID を決めて・残して・送る。 */
function openScreen(storage, lines) {
  let minted = 0;
  const screen = {
    pendingRef: { current: null },
    lines: lines.map((l) => ({ ...l })),
    toasts: [],
    get minted() { return minted; },
    async reopen() {
      const plan = planDraftRestore(await storage.get(KEY), LOCATION);
      this.pendingRef.current = plan.operation;
      if (plan.restore) this.lines = plan.lines.map((l) => ({ ...l }));
    },
    async confirm() {
      const { operation, reused } = beginConfirmOperation(this.pendingRef.current, () => {
        minted += 1;
        return { entryId: `loss_${minted}`, appEventId: `evt_loss_entry_loss_${minted}` };
      });
      if (reused && pendingLinesChanged(operation, this.lines)) {
        this.lines = operation.lines.map((l) => ({ ...l }));
        this.toasts.push("restored");
        return "restored";
      }
      const sourceLines = resolveConfirmLines(operation, this.lines);
      try {
        this.pendingRef.current = { ...operation, locationId: LOCATION, lines: sourceLines };
        await rememberOperationBeforeSend(storage, KEY, this.pendingRef.current);
        await applyInventoryChangeToApi({
          appEventId: operation.appEventId,
          activity: "loss_entry",
          locationId: LOCATION,
          sourceId: operation.entryId,
          entries: sourceLines.map((l) => ({ inventoryItemId: l.inventoryItemId, delta: -Math.abs(Number(l.qty)) })),
          retryDelayMs: 0,
        });
        await clearLocationDraft(storage, KEY, LOCATION);
        this.pendingRef.current = null;
        return "ok";
      } catch (e) {
        const kept = operationToKeepAfterError(operation, e, this.pendingRef.current, sourceLines);
        if (kept) kept.locationId = LOCATION;
        this.pendingRef.current = kept;
        await settleOperationAfterError(storage, KEY, kept, LOCATION);
        this.toasts.push(e.message);
        return "error";
      }
    },
  };
  return screen;
}

const LINES = [{ id: "a", variantId: "gid://shopify/ProductVariant/1", inventoryItemId: "gid://shopify/InventoryItem/1", qty: 2 }];

describe("loss confirm keeps the event id until the server answers", () => {
  let storage;
  beforeEach(() => {
    storage = memoryStorage();
  });

  it("3 回応答が無いあと押し直しても、在庫は 1 回しか動かない", async () => {
    const server = fakeServer({ lose: (n) => n <= 3 });
    const screen = openScreen(storage, LINES);

    assert.equal(await screen.confirm(), "error");
    assert.equal(server.sent.length, 3);
    assert.equal(server.stock, 8);
    assert.match(screen.toasts[0], /応答を受け取れませんでした/);

    assert.equal(await screen.confirm(), "ok");
    assert.deepEqual(new Set(server.sent), new Set(["evt_loss_entry_loss_1"]));
    assert.equal(screen.minted, 1);
    assert.equal(server.stock, 8);
    assert.equal(screen.pendingRef.current, null);
    assert.equal(planDraftRestore(await storage.get(KEY), LOCATION).operation, null);
  });

  it("応答が無いまま画面を閉じても、開き直して押すと残っている ID で送る", async () => {
    const server = fakeServer({ lose: (n) => n <= 3 });
    const first = openScreen(storage, LINES);
    await first.confirm();
    assert.equal(server.stock, 8);

    // 画面を閉じた: メモリの ID は消える。端末の保存だけが残る。
    const second = openScreen(storage, []);
    await second.reopen();
    assert.equal(second.pendingRef.current.appEventId, "evt_loss_entry_loss_1");
    assert.equal(await second.confirm(), "ok");
    assert.equal(second.minted, 0);
    assert.equal(server.stock, 8);
    assert.deepEqual(new Set(server.sent), new Set(["evt_loss_entry_loss_1"]));
  });

  it("送信中に画面を閉じても（応答もエラーも受け取らない）、送る前に ID が残っている", async () => {
    fakeServer();
    const realFetch = globalThis.fetch;
    let release;
    globalThis.fetch = (url, init) => new Promise((resolve) => { release = () => resolve(realFetch(url, init)); });
    const screen = openScreen(storage, LINES);
    const inFlight = screen.confirm();
    await new Promise((r) => setTimeout(r, 0));
    const saved = planDraftRestore(await storage.get(KEY), LOCATION);
    assert.equal(saved.operation.appEventId, "evt_loss_entry_loss_1");
    assert.equal(saved.operation.lines[0].qty, 2);
    release();
    await inFlight;
  });

  it("Load failed（文に fetch も Network も無い）でも同じ ID で送り直す", async () => {
    const server = fakeServer({ lose: (n) => n === 1 });
    const result = await applyInventoryChangeToApi({
      appEventId: "evt_1",
      activity: "purchase_entry",
      locationId: LOCATION,
      entries: [{ inventoryItemId: "1", delta: 3 }],
      retryDelayMs: 0,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(server.sent, ["evt_1", "evt_1"]);
    assert.equal(server.stock, 13);
  });

  it("時間切れ（AbortError）も応答なしとして同じ ID で送り直す", async () => {
    const server = fakeServer();
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (url, init) => {
      calls += 1;
      if (calls === 1) {
        return new Promise((_resolve, rejectFetch) => {
          init.signal.addEventListener("abort", () => {
            rejectFetch(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
          });
        });
      }
      return realFetch(url, init);
    };
    const result = await applyInventoryChangeToApi({
      appEventId: "evt_timeout",
      activity: "adjustment",
      locationId: LOCATION,
      entries: [{ inventoryItemId: "1", delta: -1 }],
      retryDelayMs: 0,
      requestTimeoutMs: 20,
    });
    assert.equal(result.ok, true);
    assert.equal(calls, 2);
    assert.deepEqual(server.sent, ["evt_timeout"]);
  });

  it("サーバーがはっきり断った（400）ときだけ ID を手放し、次は新しい ID になる", async () => {
    const server = fakeServer({
      reject: (n) => (n === 1 ? { status: 400, body: { ok: false, error: "No valid entries" } } : null),
    });
    const screen = openScreen(storage, LINES);
    assert.equal(await screen.confirm(), "error");
    assert.equal(server.sent.length, 1);
    assert.equal(screen.pendingRef.current, null);
    assert.equal(planDraftRestore(await storage.get(KEY), LOCATION).operation, null);

    assert.equal(await screen.confirm(), "ok");
    assert.equal(screen.minted, 2);
    assert.equal(server.stock, 8);
  });

  it("5xx が続いて終わったときは ID を残す", async () => {
    const server = fakeServer({
      reject: (n) => (n <= 3 ? { status: 503, body: { ok: false, error: "unavailable" } } : null),
    });
    const screen = openScreen(storage, LINES);
    assert.equal(await screen.confirm(), "error");
    assert.equal(screen.pendingRef.current.appEventId, "evt_loss_entry_loss_1");
    assert.equal(await screen.confirm(), "ok");
    assert.equal(screen.minted, 1);
    assert.equal(server.stock, 8);
  });

  it("結果待ちのまま明細を変えて押したら、送らずに前回の明細へ戻す", async () => {
    const server = fakeServer({ lose: (n) => n <= 3 });
    const screen = openScreen(storage, LINES);
    await screen.confirm();
    screen.lines = [{ ...LINES[0], qty: 5 }];
    assert.equal(await screen.confirm(), "restored");
    assert.equal(server.sent.length, 3);
    assert.equal(screen.lines[0].qty, 2);
    assert.equal(await screen.confirm(), "ok");
    assert.equal(server.stock, 8);
    assert.equal(screen.minted, 1);
  });
});

/**
 * 一部だけ反映（partial_failed）の apply-change の代わり。サーバー（main）と同じく、
 * 最初の送信で在庫を動かして partial_failed を残し、同じ ID の送り直しには在庫を動かさず 400 を返し続ける。
 * 新しい ID なら、もう一度在庫を動かす（サーバーは別の確定と見るため）。
 */
function partialServer({ partialOn = (n) => n === 1 } = {}) {
  const server = { stock: 10, events: new Map(), sent: [] };
  globalThis.shopify = { session: { getSessionToken: async () => "tok" } };
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const n = server.sent.length + 1;
    server.sent.push(body.appEventId);
    if (!server.events.has(body.appEventId)) {
      for (const e of body.entries) server.stock += Number(e.delta || 0);
      server.events.set(body.appEventId, partialOn(n) ? "partial_failed" : "completed");
    }
    if (server.events.get(body.appEventId) === "partial_failed") {
      return {
        ok: false,
        status: 400,
        statusText: "",
        json: async () => ({
          ok: false,
          error: "fetch failed | application_uncertain",
          errorCode: "partial_failed",
          status: "partial_failed",
          partiallyApplied: true,
        }),
      };
    }
    return { ok: true, status: 200, statusText: "", json: async () => ({ ok: true, status: "completed" }) };
  };
  return server;
}

describe("一部だけ反映（partial_failed）では ID を手放さない", () => {
  let storage;
  beforeEach(() => {
    storage = memoryStorage();
  });

  it("押し直しても同じ ID で送り、反映済みの分はもう一度減らない", async () => {
    const server = partialServer();
    const screen = openScreen(storage, LINES);
    assert.equal(await screen.confirm(), "error");
    assert.equal(server.stock, 8);
    assert.equal(server.sent.length, 1, "同じ ID の 400 は答えが変わらないので、その場では送り直さない");
    assert.match(screen.toasts[0], /一部だけ/);
    assert.match(screen.toasts[0], /在庫は動きません/);
    assert.equal(screen.pendingRef.current.appEventId, "evt_loss_entry_loss_1");
    assert.equal(screen.pendingRef.current.partial, true);

    assert.equal(await screen.confirm(), "error");
    assert.equal(screen.minted, 1);
    assert.deepEqual(new Set(server.sent), new Set(["evt_loss_entry_loss_1"]));
    assert.equal(server.stock, 8);
  });

  it("画面を開き直しても同じ ID と「一部だけ反映」の印が戻る", async () => {
    const server = partialServer();
    await openScreen(storage, LINES).confirm();
    const second = openScreen(storage, []);
    await second.reopen();
    assert.equal(second.pendingRef.current.appEventId, "evt_loss_entry_loss_1");
    assert.equal(second.pendingRef.current.partial, true);
    assert.equal(await second.confirm(), "error");
    assert.equal(second.minted, 0);
    assert.equal(server.stock, 8);
  });

  it("一部だけ反映のあとに応答なしが来ても、印は消えない", async () => {
    const server = partialServer();
    const screen = openScreen(storage, LINES);
    await screen.confirm();
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new TypeError("Load failed");
    };
    assert.equal(await screen.confirm(), "error");
    globalThis.fetch = realFetch;
    assert.equal(screen.pendingRef.current.appEventId, "evt_loss_entry_loss_1");
    assert.equal(screen.pendingRef.current.partial, true);
    assert.equal(server.stock, 8);
  });

  it("リセットで取りやめられるのは「一部だけ反映」と分かった操作だけ", async () => {
    partialServer();
    const screen = openScreen(storage, LINES);
    await screen.confirm();
    assert.equal(canDiscardPendingOperation(screen.pendingRef.current), true);

    // 応答なしで結果が分からない操作は、リセットで ID を捨てられない（押し直しで二重になるため）。
    fakeServer({ lose: () => true });
    const other = openScreen(memoryStorage(), LINES);
    await other.confirm();
    assert.equal(canDiscardPendingOperation(other.pendingRef.current), false);
    assert.equal(canDiscardPendingOperation(null), true);
  });
});

describe("helpers", () => {
  it("pendingLinesChanged は並び順や表示用の項目では変わらない", () => {
    const op = {
      lines: [
        { variantId: "v1", inventoryItemId: "i1", qty: 1, productTitle: "A" },
        { variantId: "v2", inventoryItemId: "i2", qty: 2 },
      ],
    };
    assert.equal(pendingLinesChanged(op, [
      { variantId: "v2", inventoryItemId: "i2", qty: 2, available: 7 },
      { variantId: "v1", inventoryItemId: "i1", qty: 1 },
    ]), false);
    assert.equal(pendingLinesChanged(op, [{ variantId: "v1", inventoryItemId: "i1", qty: 1 }]), true);
    assert.equal(pendingLinesChanged(op, [
      { variantId: "v1", inventoryItemId: "i1", qty: 3 },
      { variantId: "v2", inventoryItemId: "i2", qty: 2 },
    ]), true);
    assert.equal(pendingLinesChanged({ lines: [] }, [{ variantId: "v9", qty: 1 }]), false);
  });

  it("結果が分からない失敗では ID を残し、はっきり断られたときだけ手放す", () => {
    assert.equal(shouldReuseOperationAfterError(new TypeError("Load failed")), true);
    assert.equal(shouldReuseOperationAfterError(new Error("local save failed")), true);
    assert.equal(shouldReuseOperationAfterError(Object.assign(new Error("x"), { code: "APPLY_PENDING" })), true);
    assert.equal(shouldReuseOperationAfterError(Object.assign(new Error("x"), { finalRejection: true })), false);
    assert.equal(
      shouldReuseOperationAfterError(Object.assign(new Error("x"), { finalRejection: true, inventoryApplied: true })),
      true
    );
  });

  it("isFinalApplyRejection は 4xx の断りだけを最終とみなす", () => {
    assert.equal(isFinalApplyRejection(400, "fatal", false), true);
    assert.equal(isFinalApplyRejection(403, "fatal", false), true);
    assert.equal(isFinalApplyRejection(400, "partial_failed", false), false);
    assert.equal(isFinalApplyRejection(400, "fatal", true), false);
    assert.equal(isFinalApplyRejection(401, "auth", false), false);
    assert.equal(isFinalApplyRejection(409, "fatal", false), false);
    assert.equal(isFinalApplyRejection(429, "retryable", false), false);
    assert.equal(isFinalApplyRejection(500, "retryable", false), false);
    assert.equal(isFinalApplyRejection(200, "fatal", false), false);
  });

  it("ロス・仕入れ・調整の画面は送る前に ID を残し、結果待ちの明細を確かめる", () => {
    for (const file of [
      "extensions/stock-transfer-loss/src/screens/loss/LossProductList.jsx",
      "extensions/stock-transfer-purchase/src/screens/purchase/PurchaseProductList.jsx",
      "extensions/stock-transfer-adjustment/src/screens/loss/AdjustmentProductList.jsx",
    ]) {
      const src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      const remember = src.indexOf("await rememberOperationBeforeSend(");
      const send = src.indexOf("await applyInventoryChangeToApi(", remember);
      assert.ok(remember > 0 && send > remember, `${file}: remember before send`);
      assert.match(src, /reused && pendingLinesChanged\(operation, lines\)/);
      assert.match(src, /settleOperationAfterError\(/);
      assert.match(src, /!canDiscardPendingOperation\(pendingOpRef\.current\)/);
      assert.doesNotMatch(src, /if \(kept\) await saveAppliedOperation/);
    }
  });

  it("送り直しの判断にエラーの文を使わない", () => {
    const src = readFileSync(new URL("../extensions/common/applyInventoryChange.js", import.meta.url), "utf8");
    assert.doesNotMatch(src, /message\.includes\("fetch"\)/);
    assert.doesNotMatch(src, /message\.includes\("Network"\)/);
  });
});
