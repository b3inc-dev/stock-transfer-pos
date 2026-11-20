import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { handleComplianceWebhook, normalizeWebhookTopic } from "../app/utils/compliance-webhook.ts";

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
