// Webhook を 5 秒の中で返す・外した店の Webhook を 500 にしない、の試験（ライブラリも DB も使わない）。
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { test } from "node:test";
import { respondWithinBudget, webhookLogContext, webhookResponseBudgetMs } from "../app/utils/webhook-response-budget.ts";
import { authenticateWebhookSafely, isValidWebhookHmac, toTopicConst } from "../app/utils/webhook-auth-safe.ts";

const quiet = () => {};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const SECRET = "test-secret";
const sign = (b, s = SECRET) => crypto.createHmac("sha256", s).update(b, "utf8").digest("base64");
const req = (body, hmac = sign(body)) =>
  new Request("https://x.test/webhooks/orders/updated", {
    method: "POST",
    headers: { "x-shopify-hmac-sha256": hmac, "x-shopify-topic": "orders/updated", "x-shopify-shop-domain": "a.myshopify.com", "x-shopify-webhook-id": "w1" },
    body,
  });

test("早く終わったら、その応答をそのまま返す（400・503 も）", async () => {
  const r1 = await respondWithinBudget(async () => new Response("x", { status: 503 }), { label: "t", budgetMs: 200, log: quiet });
  assert.equal(r1.status, 503);
  const r2 = await respondWithinBudget(async () => new Response("x", { status: 400 }), { label: "t", budgetMs: 200, log: quiet });
  assert.equal(r2.status, 400);
});

test("時間内に投げたものは、これまでどおり投げる", async () => {
  await assert.rejects(
    respondWithinBudget(async () => { throw new Response(null, { status: 401 }); }, { label: "t", budgetMs: 200, log: quiet }),
    (e) => e instanceof Response && e.status === 401,
  );
});

test("時間を超えたら先に 200 を返し、処理は最後まで続ける", async () => {
  let finished = false;
  const lines = [];
  const started = Date.now();
  const r = await respondWithinBudget(async () => { await wait(150); finished = true; return new Response(null, { status: 500 }); }, {
    label: "slow", budgetMs: 30, log: (l) => lines.push(l), logError: quiet,
  });
  assert.equal(r.status, 200);
  assert.ok(Date.now() - started < 120, "先に返している");
  assert.equal(finished, false);
  await wait(200);
  assert.equal(finished, true);
  assert.ok(lines.some((l) => l.includes("続きの処理が終わった status=500")));
});

test("[webhook-budget] のログに店と Webhook の ID が入る（止まった分を探すため）", async () => {
  const lines = [];
  const errs = [];
  const rq = req("{}");
  const r = await respondWithinBudget(async () => { await wait(50); return new Response(null, { status: 200 }); }, {
    label: "orders/updated", request: rq, budgetMs: 10, log: (l) => lines.push(l), logError: (l) => errs.push(l),
  });
  assert.equal(r.status, 200);
  await wait(100);
  assert.equal(lines.length, 2);
  for (const l of lines) assert.match(l, /shop=a\.myshopify\.com webhookId=w1/);
  assert.match(lines[0], /先に 200 を返す/);
  assert.match(lines[1], /続きの処理が終わった/);

  const r2 = await respondWithinBudget(async () => { await wait(50); throw new Error("x"); }, {
    label: "refunds/create", request: rq, budgetMs: 10, log: quiet, logError: (l) => errs.push(l),
  });
  assert.equal(r2.status, 200);
  await wait(100);
  assert.match(errs[0], /shop=a\.myshopify\.com webhookId=w1: 続きの処理が失敗した/);

  assert.equal(webhookLogContext(undefined), "shop=- webhookId=-");
  assert.equal(webhookLogContext(new Request("https://x.test/", { method: "POST" })), "shop=- webhookId=-");
});

test("時間を超えたあとの失敗はログに出す（投げない）", async () => {
  const errs = [];
  const r = await respondWithinBudget(async () => { await wait(60); throw new Error("db down"); }, {
    label: "slow", budgetMs: 10, log: quiet, logError: (l, e) => errs.push([l, e]),
  });
  assert.equal(r.status, 200);
  await wait(100);
  assert.equal(errs.length, 1);
  assert.match(String(errs[0][1]), /db down/);
});

test("WEBHOOK_RESPONSE_BUDGET_MS: 既定 4000・0 は前の動き・おかしな値は既定", async () => {
  assert.equal(webhookResponseBudgetMs({}), 4000);
  assert.equal(webhookResponseBudgetMs({ WEBHOOK_RESPONSE_BUDGET_MS: "0" }), 0);
  assert.equal(webhookResponseBudgetMs({ WEBHOOK_RESPONSE_BUDGET_MS: "2500" }), 2500);
  assert.equal(webhookResponseBudgetMs({ WEBHOOK_RESPONSE_BUDGET_MS: "abc" }), 4000);
  assert.equal(webhookResponseBudgetMs({ WEBHOOK_RESPONSE_BUDGET_MS: "off" }), 0, "off は 0 と同じ");
  assert.equal(webhookResponseBudgetMs({ WEBHOOK_RESPONSE_BUDGET_MS: " OFF " }), 0, "大文字・空白つきの off も 0");
  assert.equal(webhookResponseBudgetMs({ WEBHOOK_RESPONSE_BUDGET_MS: "-1" }), 4000, "負の数は既定（戻すときは 0 と書く）");
  const r = await respondWithinBudget(async () => { await wait(40); return new Response(null, { status: 503 }); }, { label: "t", budgetMs: 0, log: quiet });
  assert.equal(r.status, 503, "0 なら終わるまで待つ");
});

test("ライブラリが 500 を投げ、HMAC が正しければ、セッション無しで受ける", async () => {
  const body = JSON.stringify({ id: 1 });
  const r = await authenticateWebhookSafely(req(body), {
    authenticateWebhook: async (rq) => { await rq.text(); throw new Response(null, { status: 500 }); },
    apiSecret: SECRET, log: quiet,
  });
  assert.equal(r.sessionRefreshFailed, true);
  assert.equal(r.session, undefined);
  assert.equal(r.shop, "a.myshopify.com");
  assert.equal(r.topic, "ORDERS_UPDATED");
  assert.deepEqual(r.payload, { id: 1 });
});

test("500 のあと HMAC が違えば 401・ほかの Response と例外はそのまま", async () => {
  const body = "{}";
  await assert.rejects(
    authenticateWebhookSafely(req(body, sign(body, "x")), { authenticateWebhook: async () => { throw new Response(null, { status: 500 }); }, apiSecret: SECRET, log: quiet }),
    (e) => e instanceof Response && e.status === 401,
  );
  await assert.rejects(
    authenticateWebhookSafely(req(body), { authenticateWebhook: async () => { throw new Response(null, { status: 401 }); }, apiSecret: SECRET, log: quiet }),
    (e) => e instanceof Response && e.status === 401,
  );
  const ok = { shop: "a", session: { id: 1 } };
  assert.equal(await authenticateWebhookSafely(req(body), { authenticateWebhook: async () => ok, apiSecret: SECRET, log: quiet }), ok);
  assert.equal(isValidWebhookHmac(body, sign(body), ""), false);
  assert.equal(toTopicConst("refunds/create"), "REFUNDS_CREATE");
});

test("Webhook の受け口 6 つが、新しい部品を通っている（付け忘れの見張り）", () => {
  for (const f of ["webhooks.app.uninstalled", "webhooks.app.scopes_update", "webhooks.compliance", "webhooks.orders.updated", "webhooks.refunds.create", "webhooks.inventory_levels.update"]) {
    const src = fs.readFileSync(new URL(`../app/routes/${f}.tsx`, import.meta.url), "utf8");
    assert.match(src, /authenticateWebhook\(request\)/, f);
    assert.doesNotMatch(src, /await authenticate\.webhook\(/, f);
  }
  for (const f of ["webhooks.orders.updated", "webhooks.refunds.create", "webhooks.inventory_levels.update"]) {
    const src = fs.readFileSync(new URL(`../app/routes/${f}.tsx`, import.meta.url), "utf8");
    assert.match(src, /respondWithinBudget\(/, f);
    assert.match(src, /request: args\.request/, `${f}: ログに店と Webhook の ID を入れるため request を渡す`);
  }
});
