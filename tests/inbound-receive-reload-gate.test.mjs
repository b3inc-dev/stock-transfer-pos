/**
 * 監査 P1-3: 入庫の一部受領で、エラーのあと伝票の読み直しが終わる前にロックが外れ、
 * 古い「受領済み」の数のまま同じ差分をもう一度送れてしまう問題。
 *
 * 本番と同じ runReceiveWithReload（extensions/stock-transfer-inbound/src/receiveReloadGate.js）を使い、
 * 作り物の Shopify（受領は成功したのに返事が時間切れ）と、画面の伝票（受領済みの数）を動かす。
 * 差分は画面と同じ「目標 − 受領済み」（InboundListScreen.jsx の plannedItems）。
 * Run: node --test tests/inbound-receive-reload-gate.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createReceiveGate,
  markReloaded,
  receiveBlockedReason,
  runReceiveWithReload,
} from "../extensions/stock-transfer-inbound/src/receiveReloadGate.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 予定 10。Shopify 側の受領済み accepted と、画面が持っている受領済み shown。 */
function scenario({ timeoutOnReceive = true } = {}) {
  const shopify = { planned: 10, accepted: 0, receiveCalls: [] };
  const screen = { shown: 0, target: 4, toasts: [] };
  const gate = createReceiveGate();
  let nextReload = null;

  const submit = async () => {
    const delta = Math.max(0, screen.target - screen.shown);
    if (delta === 0) {
      screen.toasts.push("一部入庫として送る差分がありません");
      return { ok: false, reload: false };
    }
    shopify.receiveCalls.push(delta);
    shopify.accepted += delta; // Shopify では成功
    if (timeoutOnReceive) throw new Error("timeout 20s"); // 返事が届かない
    return { ok: true, reload: true };
  };
  const reload = () => {
    const d = nextReload ?? deferred();
    nextReload = null;
    return d.promise.then((r) => {
      if (r?.ok) screen.shown = shopify.accepted; // 伝票を読み直すと受領済みの数が新しくなる
      return r;
    });
  };
  const press = () =>
    runReceiveWithReload(gate, {
      submit,
      reload,
      onSubmitError: (e) => screen.toasts.push(`入庫確定エラー: ${e.message}`),
      onReloadFailed: () => screen.toasts.push("reload_failed"),
      onBlocked: (why) => screen.toasts.push(`blocked:${why}`),
    });
  return {
    shopify,
    screen,
    gate,
    press,
    willReload() {
      nextReload = deferred();
      return nextReload;
    },
  };
}

describe("partial receive: the lock stays until the shipment is reloaded", () => {
  it("timeout after Shopify accepted 4 → immediate second press is blocked → after reload nothing is resent", async () => {
    const s = scenario();
    const reload = s.willReload();
    const first = s.press();
    await new Promise((r) => setImmediate(r));
    assert.equal(s.gate.locked, true, "読み直しの間はロックしたまま");

    const second = await s.press(); // スタッフがすぐ押し直す
    assert.equal(second, false);
    assert.deepEqual(s.shopify.receiveCalls, [4], "同じ差分をもう一度送らない");

    reload.resolve({ ok: true });
    assert.equal(await first, false);
    assert.equal(s.gate.locked, false);
    assert.equal(s.screen.shown, 4);

    // 読み直したあとに押しても、差分は 0
    s.willReload();
    assert.equal(await s.press(), false);
    assert.deepEqual(s.shopify.receiveCalls, [4]);
    assert.equal(s.shopify.accepted, 4, "合わせて 4（8 にならない）");
  });

  it("reload also fails → confirm stays blocked with a message until a reload succeeds", async () => {
    const s = scenario();
    const reload = s.willReload();
    const first = s.press();
    reload.resolve({ ok: false, error: new Error("network") });
    assert.equal(await first, false);
    assert.equal(s.gate.locked, false);
    assert.equal(s.gate.reloadRequired, true);
    assert.ok(s.screen.toasts.includes("reload_failed"), "読み直してから再操作するよう表示する");

    assert.equal(await s.press(), false);
    assert.equal(receiveBlockedReason(s.gate), "reload_required");
    assert.ok(s.screen.toasts.includes("blocked:reload_required"));
    assert.deepEqual(s.shopify.receiveCalls, [4], "古い数のまま送らない");

    // 「再読込」などで伝票を読み直せた（ローダーが markReloaded を呼ぶ）
    s.screen.shown = s.shopify.accepted;
    markReloaded(s.gate);
    s.willReload();
    assert.equal(await s.press(), false);
    assert.deepEqual(s.shopify.receiveCalls, [4]);
    assert.equal(s.shopify.accepted, 4);
  });

  it("reload throwing is treated as a failed reload, not as fresh data", async () => {
    const s = scenario();
    const reload = s.willReload();
    const first = s.press();
    reload.reject(new Error("boom"));
    assert.equal(await first, false);
    assert.equal(s.gate.reloadRequired, true);
    assert.equal(s.gate.locked, false);
  });

  it("successful partial receive also waits for the reload before unlocking", async () => {
    const s = scenario({ timeoutOnReceive: false });
    const reload = s.willReload();
    const first = s.press();
    await new Promise((r) => setImmediate(r));
    assert.equal(s.gate.locked, true);
    assert.equal(await s.press(), false);
    reload.resolve({ ok: true });
    assert.equal(await first, true);
    assert.equal(s.gate.locked, false);
    assert.deepEqual(s.shopify.receiveCalls, [4]);
  });

  it("nothing to send → no reload, lock released at once", async () => {
    const s = scenario();
    s.screen.target = 0;
    let reloaded = false;
    const ok = await runReceiveWithReload(s.gate, {
      submit: async () => ({ ok: false, reload: false }),
      reload: async () => {
        reloaded = true;
        return { ok: true };
      },
    });
    assert.equal(ok, false);
    assert.equal(reloaded, false);
    assert.equal(s.gate.locked, false);
  });

  it("InboundListScreen confirms through the gate and no longer fires-and-forgets the reload on error", () => {
    const src = readFileSync(
      new URL("../extensions/stock-transfer-inbound/src/screens/InboundListScreen.jsx", import.meta.url),
      "utf8"
    );
    assert.ok(src.includes("runReceiveWithReload(receiveGateRef.current"));
    assert.equal(src.includes("receiveLockRef"), false);
    assert.equal(src.includes("loadShipmentById(shipment.id).catch(() => {})"), false);
    assert.ok(src.includes("!receiveReloadRequired"), "確定ボタンは読み直し待ちの間押せない");
    // ローダーは読み直しの成否を返し、成功したら読み直し待ちを外す
    assert.ok((src.match(/markReloaded\(receiveGateRef\.current\)/g) || []).length >= 2);
    assert.ok(src.includes("return { ok: false, error: e };"));
  });
});
