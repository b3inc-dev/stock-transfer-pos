/**
 * 付け忘れの見張り（docs/IDEMPOTENT_MIGRATION.md 6.1 の 2）。
 * Admin API 2026-04 から、下の 17 の mutation は @idempotent(key: …) が無いと実行時にエラーになる
 * （スキーマ上は必須に見えないので、型チェックでは気づけない）。
 * app/・extensions/ の .ts・.tsx・.js・.jsx を読み、GraphQL の文の中でこれらを呼ぶ所に
 * @idempotent(key: が付いているかを見る。docs/ と一番上の stock-transfer-loss/（配備されない写し）は見ない。
 *
 * まだ付けていない所は PENDING に「ファイル → mutation → あと何か所」で持つ（段ごとに減らし、最後は空にする。4 段目で空になった）。
 * - PENDING に無い所で 1 か所でも付いていなければ失敗（新しく付け忘れた）
 * - PENDING の数より多ければ失敗（付け忘れが増えた）
 * - PENDING の数より少なければ失敗（付けたなら PENDING を減らす）
 * - 5 段目（#109）で消える所は PENDING_UNTIL_STAGE_5 に持ち、「全部残る」か「全部消える」の両方を通す
 *   （#109 と 2・3 段目の PR のどちらが先に main に入っても、見張りを直さずに通るように）
 * Run: node --test tests/idempotent-directive-guard.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** https://shopify.dev/changelog/making-idempotency-mandatory-for-inventory-adjustments-and-refund-mutations */
export const IDEMPOTENT_REQUIRED_MUTATIONS = [
  "refundCreate",
  "inventoryShipmentReceive",
  "inventoryAdjustQuantities",
  "inventoryMoveQuantities",
  "inventorySetQuantities",
  "inventorySetOnHandQuantities",
  "inventoryShipmentCreateInTransit",
  "inventoryShipmentCreate",
  "inventoryTransferCreate",
  "inventoryTransferCreateAsReadyToShip",
  "inventoryTransferDuplicate",
  "inventoryTransferSetItems",
  "inventorySetScheduledChanges",
  "inventoryActivate",
  "inventoryShipmentAddItems",
  "locationActivate",
  "locationDeactivate",
];

/**
 * まだ付けていない所（ファイル → mutation → か所の数）。入れる順は docs/IDEMPOTENT_MIGRATION.md 5 章。
 * 1〜4 段目（サーバー・管理画面・POS 入庫・POS 出庫）で、使っている所は全部付け終えた。
 * 残りは 5 段目（#109）で消える所だけ（下の PENDING_UNTIL_STAGE_5）。
 */
const PENDING = {};

/**
 * 5 段目（#109・呼び出し元が無いコード N）で消える所。#109 が先に入っても後に入っても見張りが通るように、
 * ここは「この数か 0（ファイルごと消えた・その mutation が無くなった）」を許す。増えたら失敗する。
 * #109 が main に入ったら、この表は空にする（そのあとは 0 だけが通る）。
 */
const PENDING_UNTIL_STAGE_5 = {
  "app/utils/inventory-set-quantities-server.ts": { inventoryAdjustQuantities: 1 },
  "extensions/stock-transfer-adjustment/src/screens/loss/adjustmentApi.js": { inventoryActivate: 1, inventorySetQuantities: 1 },
  "extensions/stock-transfer-loss/src/screens/loss/lossApi.js": { inventoryAdjustQuantities: 1, inventorySetQuantities: 1 },
  "extensions/stock-transfer-order/src/screens/order/orderApi.js": { inventoryAdjustQuantities: 1, inventorySetQuantities: 1 },
  "extensions/stock-transfer-purchase/src/screens/purchase/purchaseApi.js": { inventoryAdjustQuantities: 1 },
  "extensions/stock-transfer-stocktake/src/screens/stocktake/stocktakeApi.js": { inventoryActivate: 1, inventorySetQuantities: 1 },
  "extensions/stock-transfer-tile/src/ModalOutbound.jsx": { inventoryTransferDuplicate: 1 },
};

/**
 * 付いていない所の数（ファイル → mutation → 数）が、PENDING と PENDING_UNTIL_STAGE_5 で許す数と合うか。
 * 合わない所の説明の一覧を返す（空なら合う）。
 */
export function comparePending(actual, pending, untilStage5) {
  const problems = [];
  const files = new Set([...Object.keys(actual), ...Object.keys(pending), ...Object.keys(untilStage5)]);
  for (const f of files) {
    const names = new Set([
      ...Object.keys(actual[f] ?? {}),
      ...Object.keys(pending[f] ?? {}),
      ...Object.keys(untilStage5[f] ?? {}),
    ]);
    for (const n of names) {
      const got = actual[f]?.[n] ?? 0;
      const must = pending[f]?.[n] ?? 0;
      const may = untilStage5[f]?.[n] ?? 0;
      // 4 段目までの残り（must）はそのまま。5 段目で消える分（may）は「全部残る」か「全部消える」
      if (got !== must && got !== must + may) {
        problems.push(`${f} の ${n}: 付いていない所が ${got} か所（許すのは ${must}${may ? ` か ${must + may}` : ""}）`);
      }
    }
  }
  return problems;
}

/** 1 段目で付け終えたファイル（ここは 0 か所でなければならない。PENDING の数とは別に見る） */
const DONE_IN_STAGE_1 = ["app/utils/ensure-inventory-activated-server.ts"];

/**
 * 2 段目（管理画面 K・L・M）で付け終えたファイル（呼び出しがあり、どれも付いている）。
 * 画面のファイル（app.inventory-count.tsx・app.order.tsx・app.purchase.tsx）には、もう在庫の書き込みの文が無い
 * （下の部品から呼ぶ）。画面に戻した・足したときは PENDING に無いので「付け忘れ」として止まる。
 */
const DONE_IN_STAGE_2 = {
  "app/utils/admin-inventory-count-set.server.ts": ["inventorySetQuantities"],
  "app/utils/admin-order-transfer.server.ts": ["inventoryTransferCreateAsReadyToShip", "inventoryTransferCreate"],
  "app/utils/admin-purchase-adjust.server.ts": ["inventoryAdjustQuantities"],
};
const ADMIN_SCREENS = ["app/routes/app.inventory-count.tsx", "app/routes/app.order.tsx", "app/routes/app.purchase.tsx"];

/** 3 段目（POS 入庫 G・H・F）で付け終えたファイル（呼び出しがあり、どれも付いている） */
const DONE_IN_STAGE_3 = {
  "extensions/common/shipmentReceive.js": ["inventoryShipmentReceive"],
  "extensions/stock-transfer-inbound/src/inboundApi.js": ["inventoryActivate"],
};

/**
 * 4 段目（POS 出庫 A〜F）で付け終えたファイル。ModalOutbound.jsx の inventoryTransferDuplicate だけは 5 段目（#109）で消すので見ない。
 * - A: inventoryTransferCreateAsReadyToShip（1 か所）
 * - B・C: inventoryTransferCreate（READY の代わりの下書き・下書き保存の 2 か所）
 * - D: inventoryShipmentCreate（1 か所。作成・補完・配送の追加・編集のどれもここを通る）
 * - E: inventoryTransferSetItems（1 か所。編集の 5 か所の呼び出しはここを通る）
 * - F: inventoryActivate（1 か所）
 */
const DONE_IN_STAGE_4 = {
  "extensions/stock-transfer-tile/src/ModalOutbound.jsx": {
    inventoryTransferCreateAsReadyToShip: 1,
    inventoryTransferCreate: 2,
    inventoryShipmentCreate: 1,
    inventoryTransferSetItems: 1,
    inventoryActivate: 1,
  },
};
const STAGE_5_ONLY = { "extensions/stock-transfer-tile/src/ModalOutbound.jsx": ["inventoryTransferDuplicate"] };

function listSourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...listSourceFiles(p));
    else if (/\.(ts|tsx|js|jsx)$/.test(name) && !/\.test\.[cm]?[jt]sx?$/.test(name)) out.push(p);
  }
  return out;
}

/** 開きかっこの位置から、対になる閉じかっこの位置（無ければ -1） */
function matchParen(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * GraphQL の文の中で 17 の mutation を呼んでいる所を探す。
 * 「名前(…)」のあとに「@」か「{」が続く所だけを GraphQL の呼び出しとみなす（JS の関数の呼び出しは「;」「)」などが続く）。
 * 引数なしの「名前 {」も見る。
 */
export function findIdempotentCalls(text) {
  const found = [];
  const re = new RegExp(`\\b(${IDEMPOTENT_REQUIRED_MUTATIONS.join("|")})\\b(?=\\s*[({@])`, "g");
  let m;
  while ((m = re.exec(text))) {
    const name = m[1];
    let i = m.index + name.length;
    while (/\s/.test(text[i] ?? "")) i++;
    let afterArgs = i;
    if (text[i] === "(") {
      const close = matchParen(text, i);
      if (close < 0) continue;
      afterArgs = close + 1;
    }
    const rest = text.slice(afterArgs, afterArgs + 200);
    const head = rest.trimStart();
    if (!(head.startsWith("@") || head.startsWith("{"))) continue; // JS の呼び出し・文の中の名前だけ
    // mutation の名前（`mutation inventoryActivate(`）と JS の関数の宣言（`function inventoryActivate(…) {`）は除く
    const before = text.slice(Math.max(0, m.index - 20), m.index);
    if (/(mutation|function)\s+$/.test(before)) continue;
    const brace = rest.indexOf("{");
    const between = brace >= 0 ? rest.slice(0, brace) : rest;
    const line = text.slice(0, m.index).split("\n").length;
    found.push({ name, line, keyed: /@idempotent\s*\(\s*key\s*:/.test(between) });
  }
  return found;
}

function scanRepo() {
  const files = [...listSourceFiles(join(ROOT, "app")), ...listSourceFiles(join(ROOT, "extensions"))];
  const result = {};
  for (const f of files) {
    const rel = relative(ROOT, f).split(sep).join("/");
    const calls = findIdempotentCalls(readFileSync(f, "utf8"));
    if (calls.length) result[rel] = calls;
  }
  return result;
}

describe("findIdempotentCalls（見張りの読み方）", () => {
  it("引数のあとに @idempotent があれば付いている", () => {
    const calls = findIdempotentCalls(
      "mutation M($input: X!, $k: String!) { inventorySetQuantities(input: $input) @idempotent(key: $k) { userErrors { message } } }"
    );
    assert.deepEqual(calls.map((c) => [c.name, c.keyed]), [["inventorySetQuantities", true]]);
  });
  it("無ければ付いていない", () => {
    const calls = findIdempotentCalls("mutation M { inventoryActivate(inventoryItemId: $a, locationId: $b) { inventoryLevel { id } } }");
    assert.deepEqual(calls.map((c) => [c.name, c.keyed]), [["inventoryActivate", false]]);
  });
  it("JS の関数の呼び出し・mutation の名前・似た名前は数えない", () => {
    const calls = findIdempotentCalls(
      [
        "await inventoryTransferCreateDraftSafe(a, b);",
        "const x = inventoryActivate(a);",
        "mutation inventoryActivate($a: ID!) { foo }",
        "async function inventoryTransferCreateAsReadyToShip({ a, b }) {",
        "inventoryShipmentCreateInTransit(input: $i) @idempotent(key: $k) { id }",
      ].join("\n")
    );
    assert.deepEqual(calls.map((c) => [c.name, c.keyed]), [["inventoryShipmentCreateInTransit", true]]);
  });
});

describe("comparePending（5 段目の分は #109 の前でも後でも通る）", () => {
  const pending = { "a.js": { x: 2 } };
  const until5 = { "a.js": { y: 1 }, "b.js": { z: 2 } };
  it("#109 の前（5 段目の分が全部残る）も、後（全部消える）も通る", () => {
    assert.deepEqual(comparePending({ "a.js": { x: 2, y: 1 }, "b.js": { z: 2 } }, pending, until5), []);
    assert.deepEqual(comparePending({ "a.js": { x: 2 } }, pending, until5), []);
  });
  it("4 段目までの残りが減った・増えた、5 段目の分が半端・増えた、知らない所が出た、は失敗", () => {
    assert.equal(comparePending({ "a.js": { x: 1 } }, pending, until5).length, 1);
    assert.equal(comparePending({ "a.js": { x: 3 } }, pending, until5).length, 1);
    assert.equal(comparePending({ "a.js": { x: 2 }, "b.js": { z: 1 } }, pending, until5).length, 1);
    assert.equal(comparePending({ "a.js": { x: 2 }, "b.js": { z: 3 } }, pending, until5).length, 1);
    assert.equal(comparePending({ "a.js": { x: 2 }, "c.js": { w: 1 } }, pending, until5).length, 1);
  });
});

describe("@idempotent の付け忘れ（app/・extensions/）", () => {
  const scanned = scanRepo();
  const unkeyedBy = Object.fromEntries(
    Object.entries(scanned)
      .map(([f, calls]) => [f, calls.filter((c) => !c.keyed)])
      .filter(([, calls]) => calls.length > 0)
  );

  it("サーバーの apply-change の書き込み（I・J）はすべて付いている", () => {
    const setCalls = scanned["app/utils/inventory-set-quantities-server.ts"] ?? [];
    const sets = setCalls.filter((c) => c.name === "inventorySetQuantities");
    assert.ok(sets.length >= 1, "inventorySetQuantities が見つかりません");
    assert.ok(sets.every((c) => c.keyed), `付いていない inventorySetQuantities: ${JSON.stringify(sets)}`);
    for (const f of DONE_IN_STAGE_1) {
      const calls = scanned[f] ?? [];
      assert.ok(calls.length >= 1, `${f} に呼び出しが見つかりません`);
      assert.deepEqual(calls.filter((c) => !c.keyed), [], `${f} に付いていない所があります`);
    }
  });

  it("管理画面の書き込み（K・L・M・2 段目）はすべて付いている", () => {
    for (const [f, names] of Object.entries(DONE_IN_STAGE_2)) {
      const calls = scanned[f] ?? [];
      assert.deepEqual(
        [...new Set(calls.map((c) => c.name))].sort(),
        [...names].sort(),
        `${f} の在庫の書き込みが思っていたものと違います`
      );
      assert.deepEqual(calls.filter((c) => !c.keyed), [], `${f} に付いていない所があります`);
    }
    for (const f of ADMIN_SCREENS) {
      assert.equal(PENDING[f], undefined, `${f} は 2 段目で付け終えたので PENDING に入れない`);
      assert.deepEqual((scanned[f] ?? []).filter((c) => !c.keyed), [], `${f} に付いていない所があります`);
    }
  });

  it("POS 入庫の受け取りと有効化（G・H・F・3 段目）はすべて付いている。受け取りは共通の部品 1 か所だけ", () => {
    for (const [f, names] of Object.entries(DONE_IN_STAGE_3)) {
      const calls = scanned[f] ?? [];
      assert.deepEqual([...new Set(calls.map((c) => c.name))].sort(), [...names].sort(), `${f} の在庫の書き込みが思っていたものと違います`);
      assert.deepEqual(calls.filter((c) => !c.keyed), [], `${f} に付いていない所があります`);
    }
    const receiveFiles = Object.entries(scanned)
      .filter(([, calls]) => calls.some((c) => c.name === "inventoryShipmentReceive"))
      .map(([f]) => f);
    assert.deepEqual(receiveFiles, ["extensions/common/shipmentReceive.js"]);
  });

  it("POS 出庫の作成・下書き・Shipment・明細・有効化（A〜F・4 段目）はすべて付いている。か所の数も変わっていない", () => {
    for (const [f, want] of Object.entries(DONE_IN_STAGE_4)) {
      const skip = new Set(STAGE_5_ONLY[f] ?? []);
      const calls = (scanned[f] ?? []).filter((c) => !skip.has(c.name));
      const counts = calls.reduce((m, c) => ({ ...m, [c.name]: (m[c.name] ?? 0) + 1 }), {});
      assert.deepEqual(counts, want, `${f} の在庫の書き込みのか所が思っていたものと違います`);
      assert.deepEqual(calls.filter((c) => !c.keyed), [], `${f} に付いていない所があります`);
    }
  });

  it("まだ付けていない所は PENDING の数と同じ（増えても減っても PENDING を直す。5 段目の分は #109 の前でも後でも通る）", () => {
    const actual = Object.fromEntries(
      Object.entries(unkeyedBy).map(([f, calls]) => [
        f,
        calls.reduce((m, c) => ({ ...m, [c.name]: (m[c.name] ?? 0) + 1 }), {}),
      ])
    );
    assert.deepEqual(
      comparePending(actual, PENDING, PENDING_UNTIL_STAGE_5),
      [],
      "付いていない所: " +
        JSON.stringify(
          Object.fromEntries(Object.entries(unkeyedBy).map(([f, c]) => [f, c.map((x) => `${x.name}@${x.line}`)])),
          null,
          1
        )
    );
  });
});
