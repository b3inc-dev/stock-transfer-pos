/**
 * キーの計算（docs/IDEMPOTENT_MIGRATION.md 6.1 の 1）。
 * - 同じ材料 → 同じ UUID。材料が 1 つでも違う → 違う UUID
 * - POS（JS の SHA-1）とサーバー（node:crypto）で同じ表（tests/fixtures/idempotency-key-vectors.json）を通す
 * - 形が UUID v5
 * - @idempotent の返事（処理中・中身の違い）の見分け方
 * Run: node --experimental-strip-types --test tests/idempotency-key.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";

register(
  "data:text/javascript," +
    encodeURIComponent(`
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (e) {
    if (specifier.startsWith(".") && !/\\.[cm]?[jt]sx?$/.test(specifier)) {
      return next(specifier + ".ts", context);
    }
    throw e;
  }
}
`)
);

const pos = await import("../extensions/common/idempotencyKey.js");
const server = await import("../app/utils/idempotency-key.server.ts");

const table = JSON.parse(readFileSync(new URL("./fixtures/idempotency-key-vectors.json", import.meta.url), "utf8"));

describe("キーの計算の表（POS とサーバーで同じ答え）", () => {
  it("名前空間は表と同じ（変えない）", () => {
    assert.equal(pos.IDEMPOTENCY_KEY_NAMESPACE, table.namespace);
    assert.equal(server.IDEMPOTENCY_KEY_NAMESPACE, table.namespace);
  });
  for (const v of table.vectors) {
    it(`${v.material}`, () => {
      assert.equal(pos.buildIdempotencyKeyMaterial(v.parts), v.material);
      assert.equal(pos.buildIdempotencyKey(v.parts), v.key, "POS（JS）");
      assert.equal(server.buildIdempotencyKeyServer(v.parts), v.key, "サーバー（node:crypto）");
      assert.ok(pos.isUuidV5(v.key));
      assert.equal(v.key.length, 36);
    });
  }
  it("RFC 4122 の例（DNS 名前空間の www.example.com）と同じ", () => {
    const dns = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
    assert.equal(pos.uuidV5("www.example.com", dns), "2ed6657d-e927-568b-95e1-2665a8aea6a2");
    assert.equal(server.uuidV5Server("www.example.com", dns), "2ed6657d-e927-568b-95e1-2665a8aea6a2");
  });
  it("SHA-1 の長い入力（64 バイトの区切りをまたぐ）でも POS とサーバーが同じ", () => {
    for (const len of [0, 1, 55, 56, 63, 64, 65, 119, 120, 200, 1000]) {
      const name = "あa".repeat(len);
      assert.equal(pos.uuidV5(name), server.uuidV5Server(name), `len=${len}`);
    }
  });
});

describe("材料の決まり", () => {
  const base = {
    shop: "bbbincbbb.myshopify.com",
    kind: "apply_change",
    operationId: "cmabc",
    stage: "set_fwd",
    chunk: "1/1",
    round: "main",
  };
  it("同じ材料なら何度作っても同じ", () => {
    assert.equal(pos.buildIdempotencyKey(base), pos.buildIdempotencyKey({ ...base }));
  });
  it("chunk・round を省くと 1/1・main", () => {
    const { chunk, round, ...rest } = base;
    void chunk;
    void round;
    assert.equal(pos.buildIdempotencyKey(rest), pos.buildIdempotencyKey(base));
  });
  for (const k of Object.keys(base)) {
    it(`${k} が違えば違うキー`, () => {
      const changed = { ...base, [k]: k === "chunk" ? "1/2" : `${base[k]}x` };
      assert.notEqual(pos.buildIdempotencyKey(changed), pos.buildIdempotencyKey(base));
    });
  }
  it("空・無い・「|」の入った材料は作らない（違う材料が同じ文字列になるのを防ぐ）", () => {
    assert.throws(() => pos.buildIdempotencyKey({ ...base, operationId: "" }), TypeError);
    assert.throws(() => pos.buildIdempotencyKey({ ...base, shop: undefined }), TypeError);
    assert.throws(() => pos.buildIdempotencyKey({ ...base, stage: "a|b" }), TypeError);
  });
  it("チャンクは 1 から数える", () => {
    assert.equal(pos.formatIdempotencyChunk(0, 1), "1/1");
    assert.equal(pos.formatIdempotencyChunk(2, 3), "3/3");
    assert.throws(() => pos.formatIdempotencyChunk(3, 3), TypeError);
    assert.throws(() => pos.formatIdempotencyChunk(-1, 3), TypeError);
  });
  it("操作の ID が無い呼び出しは、呼ぶたびに違う ID になる", () => {
    const a = server.resolveIdempotencyContext(undefined);
    const b = server.resolveIdempotencyContext(undefined);
    assert.notEqual(a.operationId, b.operationId);
    assert.equal(a.round, "main");
    const c = server.resolveIdempotencyContext({ shop: "s", operationId: "op1", round: "ns1" });
    assert.deepEqual([c.shop, c.operationId, c.round], ["s", "op1", "ns1"]);
  });
});

describe("@idempotent の返事の見分け方", () => {
  const { classifyIdempotencyErrors } = server;
  it("code で見分ける（inventorySetQuantities の userErrors）", () => {
    assert.equal(
      classifyIdempotencyErrors([{ field: null, message: "x", code: "IDEMPOTENCY_CONCURRENT_REQUEST" }]),
      "concurrent"
    );
    assert.equal(
      classifyIdempotencyErrors([{ field: null, message: "x", code: "IDEMPOTENCY_KEY_PARAMETER_MISMATCH" }]),
      "mismatch"
    );
  });
  it("code の無い UserError（inventoryActivate）は Shopify の文で見分ける", () => {
    assert.equal(
      classifyIdempotencyErrors([{ message: "The same idempotency key cannot be used with different operation parameters." }]),
      "mismatch"
    );
    assert.equal(
      classifyIdempotencyErrors([{ message: "This request is currently in progress, please try again." }]),
      "concurrent"
    );
  });
  it("トップの errors の extensions.code も見る", () => {
    assert.equal(
      classifyIdempotencyErrors([], [{ message: "x", extensions: { code: "IDEMPOTENCY_KEY_PARAMETER_MISMATCH" } }]),
      "mismatch"
    );
  });
  it("両方あれば中身の違いを優先する。ほかの断りは null", () => {
    assert.equal(
      classifyIdempotencyErrors([
        { code: "IDEMPOTENCY_CONCURRENT_REQUEST" },
        { code: "IDEMPOTENCY_KEY_PARAMETER_MISMATCH" },
      ]),
      "mismatch"
    );
    assert.equal(classifyIdempotencyErrors([{ code: "CHANGE_FROM_QUANTITY_STALE", message: "changed" }]), null);
    assert.equal(classifyIdempotencyErrors(undefined, null), null);
  });
});
