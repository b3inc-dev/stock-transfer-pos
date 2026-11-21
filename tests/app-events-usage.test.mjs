import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { readFileSync } from "node:fs";
import {
  __resetAppEventsTokenForTest,
  __resetUsageRecheckForTest,
  buildIdempotencyKey,
  computeExtraLocationUsage,
  describeUsageReportForMerchant,
  getEventHandle,
  reportExtraLocationUsage,
  PERIOD_END_MARGIN_MS,
  RETRY_AFTER_MS,
} from "../app/utils/app-events-usage.server.ts";

const SHOP = "demo.myshopify.com";
const GID = "gid://shopify/Shop/12345678";
// 期間の終わりは遠い先にする（今の時計で動くテストが、日付が過ぎて period_ended にならないように）
const PERIOD = "2099-12-21T00:00:00Z";
const ENV_ON = { APP_EVENTS_USAGE_ENABLED: "1", APP_EVENTS_CLIENT_ID: "cid", APP_EVENTS_CLIENT_SECRET: "sec" };

/** Prisma の appUsageReport の偽物（(shop, periodEnd) と idempotencyKey の一意を守る） */
function fakeStore() {
  const rows = [];
  let seq = 0;
  let clock = 0;
  const stamp = () => new Date(1_000_000 + ++clock);
  return {
    rows,
    async findUnique({ where }) {
      const k = where.shop_periodEnd;
      const r = rows.find((x) => x.shop === k.shop && x.periodEnd === k.periodEnd);
      return r ? { ...r } : null;
    },
    async create({ data }) {
      if (rows.some((x) => (x.shop === data.shop && x.periodEnd === data.periodEnd) || x.idempotencyKey === data.idempotencyKey)) {
        throw new Error("Unique constraint failed");
      }
      const now = stamp();
      const r = { id: `r${++seq}`, httpStatus: null, lastError: null, attempts: 0, sentAt: null, createdAt: now, ...data, updatedAt: now };
      rows.push(r);
      return { ...r };
    },
    async updateMany({ where, data }) {
      const r = rows.find((x) => x.id === where.id && x.status === where.status && x.updatedAt.getTime() === new Date(where.updatedAt).getTime());
      if (!r) return { count: 0 };
      Object.assign(r, data, { updatedAt: stamp() });
      return { count: 1 };
    },
    async update({ where, data }) {
      const r = rows.find((x) => x.id === where.id);
      Object.assign(r, data, { updatedAt: stamp() });
      return { ...r };
    },
  };
}

function fakeFetch(eventStatuses = [202]) {
  const calls = [];
  let i = 0;
  const fn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    if (url.endsWith("/auth/access_token")) {
      return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ access_token: "tok", token_type: "Bearer" }) };
    }
    const status = eventStatuses[Math.min(i++, eventStatuses.length - 1)];
    if (status === "throw") throw new Error("network down");
    return { status, headers: { get: () => null }, text: async () => JSON.stringify(status === 202 ? { success: true } : { success: false, error: "x" }) };
  };
  fn.calls = calls;
  fn.events = () => calls.filter((c) => c.url.includes("/events"));
  return fn;
}

const input = (over = {}) => ({ shop: SHOP, shopGid: GID, plan: "pro", locationsCount: 13, periodEnd: PERIOD, ...over });

beforeEach(() => {
  __resetUsageRecheckForTest();
  __resetAppEventsTokenForTest();
});

describe("数の計算とキー", () => {
  test("10 か所までは 0、超えた分 × 単価（Lite $4 / Pro $12）", () => {
    assert.deepEqual(computeExtraLocationUsage("lite", 10), { locationsCount: 10, units: 0, unitPriceUsd: 4, amountUsd: 0 });
    assert.deepEqual(computeExtraLocationUsage("lite", 15), { locationsCount: 15, units: 5, unitPriceUsd: 4, amountUsd: 20 });
    assert.deepEqual(computeExtraLocationUsage("pro", 13), { locationsCount: 13, units: 3, unitPriceUsd: 12, amountUsd: 36 });
  });

  test("キーは店と期間で決まり、64 文字以内", () => {
    const k = buildIdempotencyKey(GID, PERIOD);
    assert.equal(k, "pstk-xloc-12345678-20991221T000000Z");
    assert.equal(buildIdempotencyKey(GID, "2099-12-21T00:00:00.000Z"), k);
    assert.ok(k.length <= 64);
    assert.equal(buildIdempotencyKey("bad", PERIOD), null);
    assert.equal(buildIdempotencyKey(GID, "not a date"), null);
  });

  test("handle は env で変えられる", () => {
    assert.equal(getEventHandle("lite", {}), "extra_location_lite");
    assert.equal(getEventHandle("pro", { APP_EVENTS_HANDLE_PRO: "xloc_pro" }), "xloc_pro");
  });
});

describe("1 店・1 期間に 1 回", () => {
  test("送る body は shopify.dev の形（shop_id / event_handle / timestamp / idempotency_key / attributes.value）", async () => {
    const store = fakeStore();
    const fetchImpl = fakeFetch();
    const r = await reportExtraLocationUsage(input(), { store, env: ENV_ON, fetchImpl, now: () => Date.parse("2026-11-25T03:04:05.678Z") });
    assert.equal(r.outcome, "sent");
    const [ev] = fetchImpl.events();
    assert.equal(ev.url, "https://api.shopify.com/app/2026-10/events");
    assert.equal(ev.headers.Authorization, "Bearer tok");
    assert.deepEqual(ev.body, {
      shop_id: GID,
      event_handle: "extra_location_pro",
      timestamp: "2026-11-25T03:04:05Z",
      idempotency_key: "pstk-xloc-12345678-20991221T000000Z",
      attributes: { value: 3 },
    });
    assert.equal(store.rows[0].status, "sent");
  });

  test("何度呼んでも、同時に呼んでも、送るのは 1 回", async () => {
    const store = fakeStore();
    const fetchImpl = fakeFetch();
    const deps = { store, env: ENV_ON, fetchImpl, force: true };
    const results = await Promise.all([1, 2, 3, 4].map(() => reportExtraLocationUsage(input(), deps)));
    assert.equal(results.filter((r) => r.outcome === "sent").length, 1);
    const again = await reportExtraLocationUsage(input({ locationsCount: 20 }), deps);
    assert.equal(again.outcome, "already_sent");
    assert.equal(fetchImpl.events().length, 1);
    assert.equal(store.rows.length, 1);
  });

  test("次の期間はもう一度送る（キーが変わる）", async () => {
    const store = fakeStore();
    const fetchImpl = fakeFetch();
    await reportExtraLocationUsage(input(), { store, env: ENV_ON, fetchImpl });
    await reportExtraLocationUsage(input({ periodEnd: "2027-01-20T00:00:00Z" }), { store, env: ENV_ON, fetchImpl });
    const keys = fetchImpl.events().map((e) => e.body.idempotency_key);
    assert.equal(new Set(keys).size, 2);
  });

  test("10 か所以下は何もしない（DB にも書かない）", async () => {
    const store = fakeStore();
    const fetchImpl = fakeFetch();
    const r = await reportExtraLocationUsage(input({ locationsCount: 10 }), { store, env: ENV_ON, fetchImpl });
    assert.deepEqual(r, { outcome: "skipped", reason: "no_extra_locations" });
    assert.equal(store.rows.length, 0);
    assert.equal(fetchImpl.calls.length, 0);
  });
});

describe("スイッチ・上限・失敗", () => {
  test("既定オフ: 送らずに数を disabled で残す。オンにすると同じ行を送る", async () => {
    const store = fakeStore();
    const fetchImpl = fakeFetch();
    const off = await reportExtraLocationUsage(input(), { store, env: {}, fetchImpl, force: true });
    assert.equal(off.outcome, "disabled");
    assert.equal(store.rows[0].units, 3);
    assert.equal(fetchImpl.calls.length, 0);
    const on = await reportExtraLocationUsage(input(), { store, env: ENV_ON, fetchImpl, force: true });
    assert.equal(on.outcome, "sent");
    assert.equal(store.rows.length, 1);
  });

  test("アプリ側の上限を超えたら送らず over_limit で残す", async () => {
    const store = fakeStore();
    const fetchImpl = fakeFetch();
    const r = await reportExtraLocationUsage(input({ locationsCount: 30 }), {
      store,
      env: { ...ENV_ON, APP_EVENTS_USAGE_MAX_UNITS: "15" },
      fetchImpl,
    });
    assert.equal(r.outcome, "over_limit");
    assert.match(store.rows[0].lastError, /上限/);
    assert.equal(fetchImpl.events().length, 0);
  });

  test("失敗は failed で残し、時間をおいて同じキー・同じ数で送り直す", async () => {
    const store = fakeStore();
    const fetchImpl = fakeFetch([503, 202]);
    let now = Date.parse("2026-11-25T00:00:00Z");
    const deps = { store, env: ENV_ON, fetchImpl, now: () => now, force: false };
    const first = await reportExtraLocationUsage(input(), deps);
    assert.equal(first.outcome, "failed");
    assert.equal(store.rows[0].httpStatus, 503);
    assert.equal(store.rows[0].attempts, 1);

    // 店がロケーションを増やしても、一度送ろうとした数は変えない
    now += RETRY_AFTER_MS + 1;
    const second = await reportExtraLocationUsage(input({ locationsCount: 18 }), deps);
    assert.equal(second.outcome, "sent");
    const evs = fetchImpl.events();
    assert.equal(evs.length, 2);
    assert.equal(evs[0].body.idempotency_key, evs[1].body.idempotency_key);
    assert.equal(evs[1].body.attributes.value, 3);
    assert.equal(store.rows[0].attempts, 2);
  });

  test("通信の失敗も failed で残す（投げない）", async () => {
    const store = fakeStore();
    const r = await reportExtraLocationUsage(input(), { store, env: ENV_ON, fetchImpl: fakeFetch(["throw"]) });
    assert.equal(r.outcome, "failed");
    assert.equal(store.rows[0].httpStatus, null);
    assert.match(store.rows[0].lastError, /network down/);
  });

  test("400 / 403 は自動で送り直さない（T が見る）", async () => {
    const store = fakeStore();
    let now = 0;
    const fetchImpl = fakeFetch([403]);
    await reportExtraLocationUsage(input(), { store, env: ENV_ON, fetchImpl, now: () => now });
    now += RETRY_AFTER_MS * 10;
    const r = await reportExtraLocationUsage(input(), { store, env: ENV_ON, fetchImpl, now: () => now });
    assert.deepEqual(r, { outcome: "skipped", reason: "not_retryable" });
    assert.equal(fetchImpl.events().length, 1);
  });

  test("鍵が無いときは failed で理由を残す", async () => {
    const store = fakeStore();
    const r = await reportExtraLocationUsage(input(), { store, env: { APP_EVENTS_USAGE_ENABLED: "1" }, fetchImpl: fakeFetch() });
    assert.equal(r.outcome, "failed");
    assert.match(store.rows[0].lastError, /APP_EVENTS_CLIENT_ID/);
  });

  test("期間や店の ID が分からないときは送らない", async () => {
    const store = fakeStore();
    assert.equal((await reportExtraLocationUsage(input({ periodEnd: null }), { store, env: ENV_ON })).reason, "missing_period");
    assert.equal((await reportExtraLocationUsage(input({ shopGid: null }), { store, env: ENV_ON })).reason, "missing_shop_id");
  });

  test("請求期間が終わった（終わりそう）なら、古い期間のキーで送らない（次の期間と 2 重にしない）", async () => {
    const store = fakeStore();
    const fetchImpl = fakeFetch([503, 202]);
    let now = Date.parse(PERIOD) - PERIOD_END_MARGIN_MS - 60_000;
    const deps = { store, env: ENV_ON, fetchImpl, now: () => now, force: true };
    assert.equal((await reportExtraLocationUsage(input(), deps)).outcome, "failed");
    // 送り直しの前に期間が終わった
    now = Date.parse(PERIOD) + 1;
    const r = await reportExtraLocationUsage(input(), deps);
    assert.equal(r.reason, "period_ended");
    now = Date.parse(PERIOD) - PERIOD_END_MARGIN_MS + 1;
    assert.equal((await reportExtraLocationUsage(input(), deps)).reason, "period_ended");
    assert.equal(fetchImpl.events().length, 1);
    assert.equal(store.rows[0].status, "failed");
  });

  test("店に見せる文", () => {
    assert.match(describeUsageReportForMerchant({ status: "sent" }), /報告済み/);
    assert.match(describeUsageReportForMerchant(null), /まだ/);
  });
});

describe("つなぎ方（ソースの確認）", () => {
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
  test("Billing API の従量（appUsageRecordCreate）と appSubscriptionCreate は残っていない", () => {
    for (const p of ["app/utils/billing.ts", "app/utils/shop-plan.server.ts"]) {
      const src = read(p).replace(/^\s*\/\/.*$/gm, "");
      assert.doesNotMatch(src, /mutation\s+AppUsageRecordCreate|appUsageRecordCreate\(|appSubscriptionCreate\(/, p);
    }
  });
  test("報告は公開用だけ・3 か所プランの不一致では送らない・待たない", () => {
    const src = read("app/utils/shop-plan.server.ts");
    assert.match(src, /distribution === "public" && !forceInhouse && \(plan === "lite" \|\| plan === "pro"\) && !locationPlanMismatch/);
    assert.match(src, /void import\("\.\.\/db\.server"\)/);
  });
});
