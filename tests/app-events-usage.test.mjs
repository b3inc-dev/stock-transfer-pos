import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { parseActiveSubscriptionResponse, partnerSubscriptionToAdminShape } from "../app/utils/partner-subscription.server.ts";
import { getPlanFromActiveSubscriptions, subscriptionDecidesPlan } from "../app/utils/billing.ts";
import {
  __resetAppEventsTokenForTest,
  __resetUsageRecheckForTest,
  buildIdempotencyKey,
  computeExtraLocationUsage,
  describeUsageReportForMerchant,
  getEventHandle,
  isInhouseForUsage,
  MISSING_PERIOD_END,
  normalizePeriodEnd,
  pickUsagePeriodEnd,
  reportExtraLocationUsage,
  selectPlanSubscription,
  usagePeriodKey,
  resolveAppEventsCredentials,
  PERIOD_END_MARGIN_MS,
  RETRY_AFTER_MS,
} from "../app/utils/app-events-usage.server.ts";
import { findUnderscorePlanHandles, getMaxLocationsFromSubscriptionName } from "../app/utils/billing.ts";

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
    assert.equal(k, "pstk-xloc-12345678-20991221");
    assert.equal(buildIdempotencyKey(GID, "2099-12-21T00:00:00.000Z"), k);
    // 同じ日なら秒・時刻がずれても同じキー（UTC の日付）
    assert.equal(buildIdempotencyKey(GID, "2099-12-21T00:00:07Z"), k);
    assert.equal(buildIdempotencyKey(GID, "2099-12-21T09:00:00+09:00"), buildIdempotencyKey(GID, "2099-12-21T00:00:00Z"));
    assert.equal(usagePeriodKey("2099-12-21T23:59:59Z"), "2099-12-21");
    assert.equal(usagePeriodKey(null), null);
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
      idempotency_key: "pstk-xloc-12345678-20991221",
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
    const fetchImpl = fakeFetch();
    assert.equal((await reportExtraLocationUsage(input({ periodEnd: null }), { store, env: ENV_ON, fetchImpl })).outcome, "missing_period");
    assert.equal((await reportExtraLocationUsage(input({ shopGid: null }), { store, env: ENV_ON, fetchImpl })).reason, "missing_shop_id");
    assert.equal(fetchImpl.calls.length, 0);
  });

  test("期間が分からないときは送らずに missing_period で数と理由を残す（1 店 1 行・数は新しくする）", async () => {
    const store = fakeStore();
    const fetchImpl = fakeFetch();
    const r = await reportExtraLocationUsage(input({ periodEnd: null }), { store, env: ENV_ON, fetchImpl });
    assert.equal(r.outcome, "missing_period");
    assert.equal(store.rows.length, 1);
    assert.equal(store.rows[0].periodEnd, MISSING_PERIOD_END);
    assert.equal(store.rows[0].status, "missing_period");
    assert.equal(store.rows[0].units, 3);
    assert.equal(store.rows[0].attempts, 0);
    assert.match(store.rows[0].lastError, /請求期間/);
    // 10 分の間は DB を読み直さない
    assert.equal((await reportExtraLocationUsage(input({ periodEnd: null }), { store, env: ENV_ON, fetchImpl })).reason, "recently_checked");
    // 数が変わったら同じ行を新しくする
    const r2 = await reportExtraLocationUsage(input({ periodEnd: "", locationsCount: 15 }), { store, env: ENV_ON, fetchImpl, force: true });
    assert.equal(r2.outcome, "missing_period");
    assert.equal(store.rows.length, 1);
    assert.equal(store.rows[0].units, 5);
    // スイッチがオフでも同じ（期間が分からないことを先に残す）
    __resetUsageRecheckForTest();
    assert.equal((await reportExtraLocationUsage(input({ periodEnd: null }), { store, env: {}, fetchImpl })).outcome, "missing_period");
    assert.equal(fetchImpl.calls.length, 0);
    // 期間が分かれば別の行で送る（missing_period の行はそのまま）
    const r3 = await reportExtraLocationUsage(input(), { store, env: ENV_ON, fetchImpl });
    assert.equal(r3.outcome, "sent");
    assert.equal(store.rows.length, 2);
    assert.equal(fetchImpl.events().length, 1);
    assert.match(describeUsageReportForMerchant({ status: "missing_period" }), /請求期間を読めない/);
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

describe("従量を数える請求期間（Partner API と Admin API）", () => {
  const PARTNER_END = "2099-12-21T00:00:00Z";
  const ADMIN_END = "2099-11-30T00:00:00.000Z";
  const partnerSub = (cycle) =>
    parseActiveSubscriptionResponse(
      200,
      JSON.stringify({
        data: {
          activeSubscription: {
            billingPeriod: "EVERY_30_DAYS",
            cancelAtEndOfCycle: false,
            trialEndsAt: null,
            legacySubscriptionId: null,
            currentBillingCycle: cycle,
            items: [{ handle: "pro-10" }],
          },
        },
      })
    ).subscription;

  test("Partner で契約を読んだときは Partner の期間を使う（Admin に契約が無くても）", () => {
    const sub = partnerSub({ startTime: "2099-11-21T00:00:00Z", endTime: PARTNER_END });
    const shaped = partnerSubscriptionToAdminShape(sub, GID);
    assert.deepEqual(pickUsagePeriodEnd({ planSource: "partner", partnerPeriodEnd: shaped.currentPeriodEnd, adminSubscriptions: [] }), {
      periodEnd: "2099-12-21T00:00:00.000Z",
      periodSource: "partner",
    });
    // Admin にも別の期間があっても Partner を先に使う
    assert.equal(
      pickUsagePeriodEnd({ planSource: "partner", partnerPeriodEnd: PARTNER_END, adminSubscriptions: [{ status: "ACTIVE", currentPeriodEnd: ADMIN_END }] }).periodSource,
      "partner"
    );
  });

  test("Partner の期間が無い（試用中など）ときは Admin の ACTIVE な契約の期間にさがる", () => {
    const sub = partnerSub(null);
    assert.equal(sub.currentPeriodEnd, null);
    assert.deepEqual(
      pickUsagePeriodEnd({
        planSource: "partner",
        partnerPeriodEnd: sub.currentPeriodEnd,
        adminSubscriptions: [
          { status: "CANCELLED", currentPeriodEnd: "2099-01-01T00:00:00Z" },
          { status: "ACTIVE", currentPeriodEnd: ADMIN_END },
        ],
      }),
      { periodEnd: ADMIN_END, periodSource: "admin" }
    );
  });

  test("Admin で決めたときは Admin の期間だけを見る（Partner の値があっても使わない）", () => {
    assert.deepEqual(
      pickUsagePeriodEnd({ planSource: "admin", partnerPeriodEnd: PARTNER_END, adminSubscriptions: [{ status: "active", currentPeriodEnd: ADMIN_END }] }),
      { periodEnd: ADMIN_END, periodSource: "admin" }
    );
  });

  test("どこにも期間が無ければ null（送らない）", () => {
    assert.deepEqual(pickUsagePeriodEnd({ planSource: "partner", partnerPeriodEnd: null, adminSubscriptions: [] }), { periodEnd: null, periodSource: null });
    assert.deepEqual(pickUsagePeriodEnd({ planSource: "admin", adminSubscriptions: [{ status: "ACTIVE", currentPeriodEnd: "not a date" }] }), {
      periodEnd: null,
      periodSource: null,
    });
    assert.equal(normalizePeriodEnd(""), null);
  });

  test("Partner と Admin で同じ期間なら同じ値にそろう（DB の行と送るキーが 1 つになる）", () => {
    const a = pickUsagePeriodEnd({ planSource: "partner", partnerPeriodEnd: "2099-12-21T00:00:00Z" }).periodEnd;
    const b = pickUsagePeriodEnd({ planSource: "admin", adminSubscriptions: [{ status: "ACTIVE", currentPeriodEnd: "2099-12-21T00:00:00.000Z" }] }).periodEnd;
    assert.equal(a, b);
  });

  test("Partner の経路: Admin に契約が無くても Partner の期間で 1 回送る", async () => {
    const store = fakeStore();
    const fetchImpl = fakeFetch([202]);
    const sub = partnerSub({ startTime: "2099-11-21T00:00:00Z", endTime: PARTNER_END });
    const { periodEnd } = pickUsagePeriodEnd({ planSource: "partner", partnerPeriodEnd: sub.currentPeriodEnd, adminSubscriptions: [] });
    const r = await reportExtraLocationUsage(input({ periodEnd }), { store, env: ENV_ON, fetchImpl });
    assert.equal(r.outcome, "sent");
    assert.equal(fetchImpl.events().length, 1);
    assert.equal(fetchImpl.events()[0].body.idempotency_key, buildIdempotencyKey(GID, PARTNER_END));
    assert.equal(store.rows[0].periodEnd, "2099-12-21");
  });

  test("Partner の endTime と Admin の currentPeriodEnd が数秒ずれても、同じ行・同じキーで 1 回だけ送る", async () => {
    const store = fakeStore();
    const fetchImpl = fakeFetch([202]);
    const partnerEnd = "2099-12-21T00:00:00Z";
    const adminEnd = "2099-12-21T00:00:04.000Z";
    const viaPartner = pickUsagePeriodEnd({ planSource: "partner", partnerPeriodEnd: partnerEnd, adminSubscriptions: [] }).periodEnd;
    const viaAdmin = pickUsagePeriodEnd({ planSource: "admin", adminSubscriptions: [{ status: "ACTIVE", currentPeriodEnd: adminEnd }] }).periodEnd;
    assert.notEqual(viaPartner, viaAdmin);
    assert.equal(buildIdempotencyKey(GID, viaPartner), buildIdempotencyKey(GID, viaAdmin));
    assert.equal((await reportExtraLocationUsage(input({ periodEnd: viaPartner }), { store, env: ENV_ON, fetchImpl })).outcome, "sent");
    // Partner が失敗して Admin の期間にさがった（10 分の間隔も過ぎた）
    __resetUsageRecheckForTest();
    const r = await reportExtraLocationUsage(input({ periodEnd: viaAdmin }), { store, env: ENV_ON, fetchImpl });
    assert.equal(r.outcome, "already_sent");
    assert.equal(store.rows.length, 1);
    assert.equal(fetchImpl.events().length, 1);
  });

  test("期間の終わりが UTC の 0 時をまたいでずれても（23:59:58 と 00:00:01）同じ期間として 1 回だけ送る", async () => {
    const store = fakeStore();
    const fetchImpl = fakeFetch([202]);
    const viaAdmin = pickUsagePeriodEnd({ planSource: "admin", adminSubscriptions: [{ status: "ACTIVE", currentPeriodEnd: "2099-12-20T23:59:58Z" }] }).periodEnd;
    const viaPartner = pickUsagePeriodEnd({ planSource: "partner", partnerPeriodEnd: "2099-12-21T00:00:01Z" }).periodEnd;
    assert.notEqual(usagePeriodKey(viaAdmin), usagePeriodKey(viaPartner));
    assert.equal((await reportExtraLocationUsage(input({ periodEnd: viaAdmin }), { store, env: ENV_ON, fetchImpl })).outcome, "sent");
    __resetUsageRecheckForTest();
    const r = await reportExtraLocationUsage(input({ periodEnd: viaPartner }), { store, env: ENV_ON, fetchImpl });
    assert.equal(r.outcome, "already_sent");
    assert.equal(store.rows.length, 1);
    assert.equal(fetchImpl.events().length, 1);
    // 逆向き（先に翌日の日付で送った）も同じ
    const store2 = fakeStore();
    const fetch2 = fakeFetch([202]);
    __resetUsageRecheckForTest();
    assert.equal((await reportExtraLocationUsage(input({ periodEnd: viaPartner }), { store: store2, env: ENV_ON, fetchImpl: fetch2 })).outcome, "sent");
    __resetUsageRecheckForTest();
    assert.equal((await reportExtraLocationUsage(input({ periodEnd: viaAdmin }), { store: store2, env: ENV_ON, fetchImpl: fetch2 })).outcome, "already_sent");
    assert.equal(fetch2.events().length, 1);
  });

  test("前後 1 日の行が送りかけ（failed）なら、その行のキーで送り直す（新しいキーで 2 回目を作らない）", async () => {
    const store = fakeStore();
    const fetchImpl = fakeFetch([503, 202]);
    const before = "2099-12-20T23:59:58Z";
    const after = "2099-12-21T00:00:01Z";
    assert.equal((await reportExtraLocationUsage(input({ periodEnd: before }), { store, env: ENV_ON, fetchImpl, force: true })).outcome, "failed");
    const r = await reportExtraLocationUsage(input({ periodEnd: after }), { store, env: ENV_ON, fetchImpl, force: true });
    assert.equal(r.outcome, "sent");
    assert.equal(store.rows.length, 1);
    const keys = fetchImpl.events().map((e) => e.body.idempotency_key);
    assert.deepEqual(keys, [buildIdempotencyKey(GID, before), buildIdempotencyKey(GID, before)]);
  });

  test("2 日以上離れた行は別の期間（前の期間の行があっても送る）", async () => {
    const store = fakeStore();
    const fetchImpl = fakeFetch([202]);
    assert.equal((await reportExtraLocationUsage(input({ periodEnd: "2099-11-21T00:00:00Z" }), { store, env: ENV_ON, fetchImpl })).outcome, "sent");
    assert.equal((await reportExtraLocationUsage(input({ periodEnd: "2099-12-21T00:00:00Z" }), { store, env: ENV_ON, fetchImpl })).outcome, "sent");
    assert.equal(store.rows.length, 2);
  });

  test("期間の終わり 10 分前の止めは、日付ではなく正確な時刻で見る", async () => {
    const store = fakeStore();
    const fetchImpl = fakeFetch([202]);
    const end = "2099-12-21T12:00:00Z";
    // 同じ日の 11:49:59（10 分より前）なら送る
    let now = Date.parse(end) - PERIOD_END_MARGIN_MS - 1000;
    assert.equal((await reportExtraLocationUsage(input({ periodEnd: end }), { store, env: ENV_ON, fetchImpl, now: () => now })).outcome, "sent");
    // 11:55（日付はまだ同じでも 10 分前を過ぎた）なら送らない
    const store2 = fakeStore();
    now = Date.parse(end) - 5 * 60_000;
    assert.equal((await reportExtraLocationUsage(input({ periodEnd: end }), { store: store2, env: ENV_ON, fetchImpl, now: () => now, force: true })).reason, "period_ended");
    assert.equal(store2.rows.length, 0);
  });

  test("Admin の経路: Admin の期間で 1 回送る", async () => {
    const store = fakeStore();
    const fetchImpl = fakeFetch([202]);
    const { periodEnd } = pickUsagePeriodEnd({ planSource: "admin", adminSubscriptions: [{ status: "ACTIVE", currentPeriodEnd: ADMIN_END }] });
    const r = await reportExtraLocationUsage(input({ periodEnd }), { store, env: ENV_ON, fetchImpl });
    assert.equal(r.outcome, "sent");
    assert.equal(fetchImpl.events()[0].body.idempotency_key, buildIdempotencyKey(GID, ADMIN_END));
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
  test("期間はプランを決めた契約から選ぶ（Partner で決めたら Partner の期間）", () => {
    const src = read("app/utils/shop-plan.server.ts");
    assert.match(src, /partnerPeriodEnd = partner\.subscription\.currentPeriodEnd/);
    assert.match(src, /pickUsagePeriodEnd\(\{\s*planSource,\s*partnerPeriodEnd,\s*planSubscription,?\s*\}\)/);
    // Admin の期間はプランを決めた契約だけ（ACTIVE な契約の先頭ではない）
    assert.match(src, /selectPlanSubscription\(activeSubscriptions, \{\s*preferId: planSource === "partner" \? partnerSubscriptionId : null,\s*matches: \(s\) => subscriptionDecidesPlan\(s, planForPick, activeSubscriptions\),?\s*\}\)/);
    assert.match(src, /partnerSubscriptionId = partner\.subscription\.legacySubscriptionId/);
    assert.match(src, /activeSubscriptions \{\s*id\s*name\s*status\s*currentPeriodEnd\s*createdAt\s*\}/);
    assert.doesNotMatch(src.replace(/^\s*\/\/.*$/gm, ""), /activeWithPeriod/);
  });
});

describe("プランを決めた契約から期間を取る（古い Billing API の契約と App Pricing の契約が同時に ACTIVE）", () => {
  const OLD = { id: "gid://shopify/AppSubscription/1", name: "Lite", status: "ACTIVE", currentPeriodEnd: "2099-12-05T00:00:00Z", createdAt: "2099-01-01T00:00:00Z" };
  const NEW = { id: "gid://shopify/AppSubscription/2", name: "Pro", status: "ACTIVE", currentPeriodEnd: "2099-12-21T00:00:00Z", createdAt: "2099-11-21T00:00:00Z" };
  // shop-plan.server.ts と同じ組み立て
  const periodFor = (subs, { planSource = "admin", partnerPeriodEnd = null, preferId = null, plan } = {}) => {
    const p = plan ?? getPlanFromActiveSubscriptions(subs);
    const planSubscription = selectPlanSubscription(subs, {
      preferId: planSource === "partner" ? preferId : null,
      matches: (s) => subscriptionDecidesPlan(s, p, subs),
    });
    return pickUsagePeriodEnd({ planSource, partnerPeriodEnd, planSubscription });
  };

  test("古い Lite と新しい Pro: Pro の契約の期間（並び順に関係なく）", () => {
    assert.equal(periodFor([OLD, NEW]).periodEnd, "2099-12-21T00:00:00.000Z");
    assert.equal(periodFor([NEW, OLD]).periodEnd, "2099-12-21T00:00:00.000Z");
  });

  test("同じプランの古い契約と新しい契約: 作られた日が新しい方。日が無く期間が違えば null（送らない）", () => {
    const oldPro = { ...OLD, name: "Pro (legacy)" };
    assert.equal(periodFor([oldPro, NEW]).periodEnd, "2099-12-21T00:00:00.000Z");
    assert.deepEqual(periodFor([{ ...oldPro, createdAt: null }, { ...NEW, createdAt: null }]), { periodEnd: null, periodSource: null });
  });

  test("Partner で決めて Partner に期間が無い: legacySubscriptionId と同じ Admin の契約の期間", () => {
    const newerLegacy = { ...OLD, name: "Pro (legacy)", createdAt: "2099-11-30T00:00:00Z" };
    assert.deepEqual(periodFor([newerLegacy, NEW], { planSource: "partner", preferId: "2", plan: "pro" }), {
      periodEnd: "2099-12-21T00:00:00.000Z",
      periodSource: "admin",
    });
  });

  test("名前から読めず Lite に倒した契約も、プランを決めた契約として選べる", () => {
    const unnamed = { ...NEW, name: "Basic" };
    assert.equal(getPlanFromActiveSubscriptions([unnamed]), "lite");
    assert.equal(subscriptionDecidesPlan(unnamed, "lite", [unnamed]), true);
    assert.equal(subscriptionDecidesPlan(unnamed, "lite", [unnamed, OLD]), false);
    assert.equal(periodFor([unnamed]).periodEnd, "2099-12-21T00:00:00.000Z");
  });

  test("selectPlanSubscription: ACTIVE だけ・preferId は gid でも数字でも", () => {
    assert.equal(selectPlanSubscription([{ ...NEW, status: "CANCELLED" }], { matches: () => true }), null);
    assert.equal(selectPlanSubscription([OLD, NEW], { matches: () => true, preferId: "gid://shopify/AppSubscription/1" }), OLD);
  });

  test("planSubscription を渡さない古い呼び方: 期間の違う ACTIVE な契約が 2 件あれば null", () => {
    assert.deepEqual(pickUsagePeriodEnd({ planSource: "admin", adminSubscriptions: [OLD, NEW] }), { periodEnd: null, periodSource: null });
  });
});

describe("App Events API の鍵（公開用アプリ自身の client ID / secret）", () => {
  test("APP_EVENTS_CLIENT_* があればそれを使う", () => {
    assert.deepEqual(
      resolveAppEventsCredentials({ APP_EVENTS_CLIENT_ID: "a", APP_EVENTS_CLIENT_SECRET: "b", SHOPIFY_API_KEY: "k", SHOPIFY_API_SECRET: "s" }),
      { clientId: "a", clientSecret: "b", source: "app_events_env" }
    );
  });
  test("無ければ SHOPIFY_API_KEY / SHOPIFY_API_SECRET を使う", () => {
    assert.deepEqual(resolveAppEventsCredentials({ SHOPIFY_API_KEY: "k", SHOPIFY_API_SECRET: "s" }), {
      clientId: "k",
      clientSecret: "s",
      source: "shopify_api_key",
    });
  });
  test("片方だけはエラー（黙って SHOPIFY_API_KEY と混ぜない）", () => {
    assert.ok("error" in resolveAppEventsCredentials({ APP_EVENTS_CLIENT_ID: "a", SHOPIFY_API_KEY: "k", SHOPIFY_API_SECRET: "s" }));
  });
  test("自社用（APP_DISTRIBUTION=inhouse）は鍵を返さない", () => {
    const r = resolveAppEventsCredentials({ APP_DISTRIBUTION: "inhouse", SHOPIFY_API_KEY: "k", SHOPIFY_API_SECRET: "s", APP_EVENTS_CLIENT_ID: "a", APP_EVENTS_CLIENT_SECRET: "b" });
    assert.match(r.error, /inhouse/);
  });
  test("SHOPIFY_API_KEY の鍵でトークンを取って送る", async () => {
    __resetAppEventsTokenForTest();
    const store = fakeStore();
    const fetchImpl = fakeFetch([202]);
    const env = { APP_EVENTS_USAGE_ENABLED: "1", SHOPIFY_API_KEY: "pub-key", SHOPIFY_API_SECRET: "pub-sec" };
    const r = await reportExtraLocationUsage(input(), { store, env, fetchImpl });
    assert.equal(r.outcome, "sent");
  });
});

describe("プランの handle はハイフン（lite-3 / pro-10）", () => {
  test("ハイフンは読める", () => {
    assert.equal(getMaxLocationsFromSubscriptionName("lite-3"), 3);
    assert.equal(getMaxLocationsFromSubscriptionName("pro-10"), 10);
  });
  test("アンダースコアは受け付けずログを出す", () => {
    const orig = console.error;
    const logs = [];
    console.error = (...a) => logs.push(a.join(" "));
    try {
      assert.equal(getMaxLocationsFromSubscriptionName("pro_10"), null);
      assert.equal(getMaxLocationsFromSubscriptionName("lite_3"), null);
    } finally {
      console.error = orig;
    }
    assert.equal(logs.length, 2);
    assert.match(logs[0], /pro_10.*pro-10/);
    assert.deepEqual(findUnderscorePlanHandles("Lite_3 pro-10"), ["Lite_3"]);
    assert.deepEqual(findUnderscorePlanHandles("Pro - 10ロケーション"), []);
  });
});

describe("自社用（Ciara）は関数の中でも送らない・記録しない（守りの二重化）", () => {
  beforeEach(() => {
    __resetUsageRecheckForTest();
    __resetAppEventsTokenForTest();
  });
  const INPUT = { shop: SHOP, shopGid: GID, plan: "pro", locationsCount: 15, periodEnd: PERIOD };
  const cases = [
    ["APP_DISTRIBUTION=inhouse", { ...ENV_ON, APP_DISTRIBUTION: " InHouse " }, null],
    ["CUSTOM_APP_STORE_IDS にある店", { ...ENV_ON, CUSTOM_APP_STORE_IDS: "other.myshopify.com, DEMO.myshopify.com" }, null],
    ["SHOPIFY_API_KEY が自社用の client_id", { ...ENV_ON, SHOPIFY_API_KEY: "ciara-client-id" }, "ciara-client-id"],
  ];
  for (const [name, env, inhouseClientId] of cases) {
    test(`${name} → DB も Shopify も触らない`, async () => {
      const store = fakeStore();
      const touched = [];
      for (const k of ["findUnique", "create", "updateMany", "update"]) {
        const orig = store[k];
        store[k] = async (...a) => {
          touched.push(k);
          return orig(...a);
        };
      }
      const fetchImpl = fakeFetch();
      const res = await reportExtraLocationUsage(INPUT, { store, env, fetchImpl, inhouseClientId, force: true });
      assert.deepEqual(res, { outcome: "skipped", reason: "inhouse" });
      assert.deepEqual(touched, []);
      assert.equal(store.rows.length, 0);
      assert.equal(fetchImpl.calls.length, 0);
    });
  }
  test("公開用（どれにも当たらない）は今まで通り送る", async () => {
    const store = fakeStore();
    const fetchImpl = fakeFetch();
    const env = { ...ENV_ON, SHOPIFY_API_KEY: "public-client-id", CUSTOM_APP_STORE_IDS: "other.myshopify.com" };
    const res = await reportExtraLocationUsage(INPUT, { store, env, fetchImpl, inhouseClientId: "ciara-client-id" });
    assert.equal(res.outcome, "sent");
    assert.equal(fetchImpl.events().length, 1);
  });
  test("isInhouseForUsage の決まり", () => {
    assert.equal(isInhouseForUsage(SHOP, {}), false);
    assert.equal(isInhouseForUsage(SHOP, { APP_DISTRIBUTION: "public" }), false);
    assert.equal(isInhouseForUsage(SHOP, { SHOPIFY_API_KEY: "" }, ""), false);
    assert.equal(isInhouseForUsage("", { CUSTOM_APP_STORE_IDS: "" }), false);
    assert.equal(isInhouseForUsage(SHOP, { SHOPIFY_API_KEY: "x" }, "x"), true);
  });
});
