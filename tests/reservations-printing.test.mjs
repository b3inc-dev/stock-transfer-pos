/* global globalThis, setImmediate */
import assert from "node:assert/strict";
import { test } from "node:test";
import { printReceipt, RECEIPT_PRINT_TIMEOUT_MS } from "../extensions/common/receiptPrinting.js";
import { printReservation } from "../extensions/stock-transfer-reservation/src/api.js";

const src = "/api/reservations?receipt=fixture&locationId=1&copy=customer";
const initialized = new WeakSet();
function setup(t, printing) {
  if (!initialized.has(t)) {
    const previous = globalThis.shopify;
    t.after(() => { globalThis.shopify = previous; });
    initialized.add(t);
  }
  globalThis.shopify = { session: { currentSession: { locationId: 1 } }, printing };
}
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};

test("unavailable printing gives an actionable error", async t => {
  setup(t, undefined);
  await assert.rejects(printReceipt(src), { code: "PRINT_UNAVAILABLE" });
  setup(t, { print() {} });
  await assert.rejects(printReceipt(src), { code: "PRINT_UNAVAILABLE" });
});

test("empty/disconnected/malformed printer lists never send or open a dialog", async t => {
  for (const printers of [[], [{ connected: false }], [{ connected: "true" }], null, {}]) {
    setup(t, { getPrinters: async () => printers, print() { assert.fail("must not print"); } });
    await assert.rejects(printReceipt(src), { code: "NO_CONNECTED_PRINTER" });
  }
});

test("reservation sends a relative path only to a connected printer", async t => {
  const connected = { id: "mPOP", connected: true };
  let calls = 0;
  setup(t, {
    getPrinters: async () => ({ printers: [{ id: "offline", connected: false }, connected] }),
    async print(path, options) {
      calls++;
      assert.ok(path.startsWith("/api/reservations?"));
      const url = new URL(path, "https://fixture.example");
      assert.equal(url.searchParams.get("receipt"), "R / ?");
      assert.equal(url.searchParams.get("locationId"), "gid://shopify/Location/1");
      assert.equal(url.searchParams.get("copy"), "store");
      assert.deepEqual(options, { printer: connected });
    },
  });
  const result = await printReservation({ id: "R / ?" }, "store");
  assert.equal(calls, 1);
  assert.match(result.message, /紙が出たか/);
});

test("multiple connected printers send once and explain the selection", async t => {
  setup(t, { getPrinters: async () => [{ id: "first", connected: true }, { id: "second", connected: true }], async print(_, { printer }) { assert.equal(printer.id, "first"); } });
  assert.match((await printReceipt(src)).message, /最初の1台/);
});

test("duplicate requests are blocked while discovering and while sending", async t => {
  const discovery = deferred(), sent = deferred();
  let sends = 0;
  setup(t, { getPrinters: () => discovery.promise, print() { sends++; return sent.promise; } });
  const first = printReceipt(src);
  await assert.rejects(printReceipt(src), { code: "PRINT_IN_FLIGHT" });
  discovery.resolve([{ connected: true }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sends, 1);
  await assert.rejects(printReceipt(src), { code: "PRINT_IN_FLIGHT" });
  sent.resolve();
  await first;
  await printReceipt(src);
  assert.equal(sends, 2, "explicit subsequent reprint is allowed");
});

test("late discovery after timeout never prints and a manual retry is possible", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const discovery = deferred();
  let discoveries = 0, sends = 0;
  setup(t, { getPrinters: () => ++discoveries === 1 ? discovery.promise : Promise.resolve([{ connected: true }]), async print() { sends++; } });
  const pending = assert.rejects(printReceipt(src), { code: "PRINTER_DISCOVERY_TIMEOUT" });
  t.mock.timers.tick(RECEIPT_PRINT_TIMEOUT_MS);
  await pending;
  await printReceipt(src);
  discovery.resolve([{ connected: true }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sends, 1);
});

test("native print timeout is uncertain and never automatically resends on late success", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sent = deferred(), started = deferred();
  let sends = 0;
  setup(t, { getPrinters: async () => [{ connected: true }], print() { sends++; started.resolve(); return sent.promise; } });
  const pending = assert.rejects(printReceipt(src), error => error.code === "PRINT_TIMEOUT_UNKNOWN" && /紙が出たか確認/.test(error.message));
  await started.promise;
  t.mock.timers.tick(RECEIPT_PRINT_TIMEOUT_MS);
  await pending;
  sent.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sends, 1);
});

test("printer discovery rejection never sends and releases its lock", async t => {
  let attempts = 0;
  setup(t, { async getPrinters() { if (++attempts === 1) throw new Error("offline"); return [{ connected: true }]; }, async print() {} });
  await assert.rejects(printReceipt(src), { code: "PRINTER_DISCOVERY_FAILED" });
  await printReceipt(src);
});

test("paper and connection errors guide manual recovery without retrying", async t => {
  for (const [raw, expected] of [["out of paper", /用紙/], ["Printer disconnected", /つながっていません/], ["unknown backend error", /紙が出たか確認/]]) {
    let sends = 0;
    setup(t, { getPrinters: async () => [{ connected: true }], async print() { sends++; throw new Error(raw); } });
    await assert.rejects(printReceipt(src), error => error.code === "PRINT_FAILED" && expected.test(error.message));
    assert.equal(sends, 1);
  }
});
