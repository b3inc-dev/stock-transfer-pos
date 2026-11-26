/**
 * 付け忘れの見張り（docs/IDEMPOTENT_MIGRATION.md 6.1 の 2）。
 * Admin API 2026-04 から、下の 17 の mutation は @idempotent(key: …) が無いと実行時にエラーになる
 * （スキーマ上は必須に見えないので、型チェックでは気づけない）。
 * app/・extensions/ の .ts・.tsx・.js・.jsx を読み、GraphQL の文の中でこれらを呼ぶ所に
 * @idempotent(key: が付いているかを見る。docs/ と一番上の stock-transfer-loss/（配備されない写し）は見ない。
 *
 * まだ付けていない所は PENDING に「あと何か所」で持つ（2 段目以降の PR で減らし、最後は空にする）。
 * - PENDING に無いファイルで 1 か所でも付いていなければ失敗（新しく付け忘れた）
 * - PENDING の数より多ければ失敗（付け忘れが増えた）
 * - PENDING の数より少なければ失敗（付けたなら PENDING を減らす）
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
 * まだ付けていない所（ファイル → か所の数）。入れる順は docs/IDEMPOTENT_MIGRATION.md 5 章。
 * 2 段目（管理画面 K・L・M）、3 段目（POS 入庫 G・H・F）、4 段目（POS 出庫 A〜F）、5 段目（使っていないコード N）で減らす。
 */
const PENDING = {
  // 2 段目（管理画面 K・L・M）
  "app/routes/app.inventory-count.tsx": 1,
  "app/routes/app.order.tsx": 2,
  "app/routes/app.purchase.tsx": 2,
  // 5 段目（N）: 呼び出し元が無い adjustInventoryQuantitiesServer
  "app/utils/inventory-set-quantities-server.ts": 1,
  // 5 段目（N）: 拡張の adjustInventoryAtLocation／adjustInventoryToActual（呼び出し元が無い）
  "extensions/stock-transfer-adjustment/src/screens/loss/adjustmentApi.js": 2,
  "extensions/stock-transfer-loss/src/screens/loss/lossApi.js": 2,
  "extensions/stock-transfer-order/src/screens/order/orderApi.js": 2,
  "extensions/stock-transfer-purchase/src/screens/purchase/purchaseApi.js": 1,
  "extensions/stock-transfer-stocktake/src/screens/stocktake/stocktakeApi.js": 2,
  // 3 段目（POS 入庫 G・F）
  "extensions/stock-transfer-inbound/src/inboundApi.js": 3,
  // 3 段目（H）・4 段目（A〜F）・5 段目（inventoryTransferDuplicate）
  "extensions/stock-transfer-tile/src/ModalOutbound.jsx": 9,
};

/** 1 段目で付け終えたファイル（ここは 0 か所でなければならない。PENDING の数とは別に見る） */
const DONE_IN_STAGE_1 = ["app/utils/ensure-inventory-activated-server.ts"];

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

  it("まだ付けていない所は PENDING の数と同じ（増えても減っても PENDING を直す）", () => {
    const actual = Object.fromEntries(Object.entries(unkeyedBy).map(([f, calls]) => [f, calls.length]));
    assert.deepEqual(
      actual,
      PENDING,
      "付いていない所: " +
        JSON.stringify(
          Object.fromEntries(Object.entries(unkeyedBy).map(([f, c]) => [f, c.map((x) => `${x.name}@${x.line}`)])),
          null,
          1
        )
    );
  });
});
