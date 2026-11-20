import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { handleComplianceWebhook as rawHandle, normalizeWebhookTopic } from "../app/utils/compliance-webhook.ts";
import {
  isNotInstalledError,
  probeShopStillInstalled,
  resolveServerDistribution,
} from "../app/utils/shop-install-probe.ts";

// 既定は「公開用・入れ直していない」。テストごとに上書きする。
const notInstalled = async () => false;
function handleComplianceWebhook(args) {
  return rawHandle({ distribution: "public", isShopStillInstalled: notInstalled, ...args });
}

const TABLES = [
  "session",
  "inventoryChangeLog",
  "inventoryChangeEvent",
  "inventoryCountDocument",
  "orderPendingLocation",
  "refundPendingLocation",
];

function fakeDb() {
  const calls = [];
  const db = { calls };
  for (const table of TABLES) {
    db[table] = {
      deleteMany: async (args) => {
        calls.push({ table, where: args.where });
        return { count: 1 };
      },
    };
  }
  return db;
}

const quiet = () => {};

describe("normalizeWebhookTopic", () => {
  test("accepts both library and header forms", () => {
    assert.equal(normalizeWebhookTopic("SHOP_REDACT"), "SHOP_REDACT");
    assert.equal(normalizeWebhookTopic("shop/redact"), "SHOP_REDACT");
    assert.equal(normalizeWebhookTopic("customers/redact"), "CUSTOMERS_REDACT");
    assert.equal(normalizeWebhookTopic("customers/data_request"), "CUSTOMERS_DATA_REQUEST");
    assert.equal(normalizeWebhookTopic(null), "");
  });
});

describe("shop/redact", () => {
  for (const topic of ["SHOP_REDACT", "shop/redact"]) {
    test(`${topic} deletes every shop table, including events and count documents`, async () => {
      const db = fakeDb();
      const res = await handleComplianceWebhook({
        topic,
        shop: "a.myshopify.com",
        payload: { shop_domain: "a.myshopify.com" },
        db,
        log: quiet,
      });
      assert.equal(res.status, 200);
      assert.equal(res.handled, "SHOP_REDACT");
      assert.deepEqual(
        db.calls.map((c) => c.table).sort(),
        [...TABLES].sort(),
      );
      for (const call of db.calls) {
        assert.deepEqual(call.where, { shop: "a.myshopify.com" });
      }
    });
  }

  test("uses the authenticated shop when payload has no shop_domain", async () => {
    const db = fakeDb();
    await handleComplianceWebhook({ topic: "SHOP_REDACT", shop: "b.myshopify.com", payload: {}, db, log: quiet });
    assert.ok(db.calls.length > 0);
    assert.ok(db.calls.every((c) => c.where.shop === "b.myshopify.com"));
  });

  test("deletes nothing when no shop is known", async () => {
    const db = fakeDb();
    const res = await handleComplianceWebhook({ topic: "SHOP_REDACT", shop: "", payload: {}, db, log: quiet });
    assert.equal(res.status, 200);
    assert.deepEqual(db.calls, []);
  });

  test("a DB failure is thrown so the route can answer 500 and Shopify retries", async () => {
    const db = fakeDb();
    db.inventoryCountDocument.deleteMany = async () => {
      throw new Error("db down");
    };
    await assert.rejects(
      handleComplianceWebhook({ topic: "SHOP_REDACT", shop: "a.myshopify.com", payload: {}, db, log: quiet }),
      /db down/,
    );
  });
});

describe("customers/redact", () => {
  for (const topic of ["CUSTOMERS_REDACT", "customers/redact"]) {
    test(`${topic} deletes pending sale/refund rows for the redacted orders only`, async () => {
      const db = fakeDb();
      const res = await handleComplianceWebhook({
        topic,
        shop: "a.myshopify.com",
        payload: { shop_domain: "a.myshopify.com", orders_to_redact: [111, "222"] },
        db,
        log: quiet,
      });
      assert.equal(res.status, 200);
      assert.equal(res.handled, "CUSTOMERS_REDACT");
      assert.deepEqual(db.calls, [
        { table: "orderPendingLocation", where: { shop: "a.myshopify.com", orderId: { in: ["111", "222"] } } },
        { table: "refundPendingLocation", where: { shop: "a.myshopify.com", orderId: { in: ["111", "222"] } } },
      ]);
    });
  }

  test("does nothing when there are no orders to redact", async () => {
    const db = fakeDb();
    await handleComplianceWebhook({ topic: "CUSTOMERS_REDACT", shop: "a.myshopify.com", payload: {}, db, log: quiet });
    assert.deepEqual(db.calls, []);
  });
});

describe("customers/data_request and unknown topics", () => {
  for (const topic of ["CUSTOMERS_DATA_REQUEST", "customers/data_request"]) {
    test(`${topic} answers 200 without touching the DB`, async () => {
      const db = fakeDb();
      const res = await handleComplianceWebhook({ topic, shop: "a.myshopify.com", payload: {}, db, log: quiet });
      assert.equal(res.status, 200);
      assert.equal(res.handled, "CUSTOMERS_DATA_REQUEST");
      assert.deepEqual(db.calls, []);
    });
  }

  test("unknown topic answers 200 with handled=null", async () => {
    const db = fakeDb();
    const res = await handleComplianceWebhook({ topic: "APP_UNINSTALLED", shop: "a.myshopify.com", db, log: quiet });
    assert.equal(res.status, 200);
    assert.equal(res.handled, null);
    assert.deepEqual(db.calls, []);
  });
});

describe("shop/redact guards", () => {
  test("skips the delete when the shop has installed the app again", async () => {
    const db = fakeDb();
    const seen = [];
    const res = await handleComplianceWebhook({
      topic: "SHOP_REDACT",
      shop: "a.myshopify.com",
      payload: {},
      db,
      isShopStillInstalled: async (s) => {
        seen.push(s);
        return true;
      },
      log: quiet,
    });
    assert.deepEqual(seen, ["a.myshopify.com"]);
    assert.equal(res.status, 200);
    assert.equal(res.skipped, "reinstalled");
    assert.deepEqual(db.calls, []);
  });

  test("throws (route answers 500) when the install check cannot decide", async () => {
    const db = fakeDb();
    await assert.rejects(
      handleComplianceWebhook({
        topic: "SHOP_REDACT",
        shop: "a.myshopify.com",
        db,
        isShopStillInstalled: async () => {
          throw new Error("network down");
        },
        log: quiet,
      }),
      /network down/,
    );
    assert.deepEqual(db.calls, []);
  });

  test("in-house (Ciara) app logs and skips without calling the install check", async () => {
    const db = fakeDb();
    let probed = false;
    const res = await handleComplianceWebhook({
      topic: "shop/redact",
      shop: "a.myshopify.com",
      db,
      distribution: "inhouse",
      isShopStillInstalled: async () => {
        probed = true;
        return false;
      },
      log: quiet,
    });
    assert.equal(res.status, 200);
    assert.equal(res.skipped, "inhouse");
    assert.equal(probed, false);
    assert.deepEqual(db.calls, []);
  });
});

describe("resolveServerDistribution", () => {
  test("APP_DISTRIBUTION=inhouse or APP_MODE=inhouse is in-house", () => {
    assert.equal(resolveServerDistribution({ APP_DISTRIBUTION: "inhouse" }, "a.myshopify.com"), "inhouse");
    assert.equal(resolveServerDistribution({ APP_DISTRIBUTION: " InHouse " }, "a.myshopify.com"), "inhouse");
    assert.equal(resolveServerDistribution({ APP_MODE: "inhouse" }, "a.myshopify.com"), "inhouse");
  });
  test("a shop in CUSTOM_APP_STORE_IDS is in-house", () => {
    assert.equal(
      resolveServerDistribution({ CUSTOM_APP_STORE_IDS: "x.myshopify.com, A.myshopify.com" }, "a.myshopify.com"),
      "inhouse",
    );
  });
  test("otherwise public (same as getShopPlan)", () => {
    assert.equal(resolveServerDistribution({}, "a.myshopify.com"), "public");
    assert.equal(resolveServerDistribution({ APP_DISTRIBUTION: "public", APP_MODE: "public" }, "a.myshopify.com"), "public");
    assert.equal(resolveServerDistribution({ CUSTOM_APP_STORE_IDS: "x.myshopify.com" }, "a.myshopify.com"), "public");
  });
});

describe("probeShopStillInstalled", () => {
  test("false when there is no offline session (no API call)", async () => {
    let queried = false;
    const res = await probeShopStillInstalled({
      shop: "a.myshopify.com",
      findOfflineSession: async () => null,
      runProbeQuery: async () => {
        queried = true;
      },
    });
    assert.equal(res, false);
    assert.equal(queried, false);
  });

  test("true when the Admin API call works", async () => {
    const res = await probeShopStillInstalled({
      shop: "a.myshopify.com",
      findOfflineSession: async () => ({ id: "offline_a.myshopify.com" }),
      runProbeQuery: async () => ({ data: { shop: { id: "gid://shopify/Shop/1" } } }),
    });
    assert.equal(res, true);
  });

  for (const err of [
    Object.assign(new Error("Unauthorized"), { response: { code: 401 } }),
    Object.assign(new Error("Forbidden"), { response: { code: 403 } }),
    new Response(null, { status: 401 }),
    new Error("[API] Invalid API key or access token (unrecognized login or wrong password)"),
    new Error("invalid_grant"),
  ]) {
    test(`false when the token is rejected (${err instanceof Response ? "Response 401" : err.message})`, async () => {
      const res = await probeShopStillInstalled({
        shop: "a.myshopify.com",
        findOfflineSession: async () => ({ id: "offline" }),
        runProbeQuery: async () => {
          throw err;
        },
      });
      assert.equal(res, false);
    });
  }

  test("rethrows other failures (5xx / network)", async () => {
    const err = Object.assign(new Error("Bad gateway"), { response: { code: 502 } });
    assert.equal(isNotInstalledError(err), false);
    await assert.rejects(
      probeShopStillInstalled({
        shop: "a.myshopify.com",
        findOfflineSession: async () => ({ id: "offline" }),
        runProbeQuery: async () => {
          throw err;
        },
      }),
      /Bad gateway/,
    );
  });
});
