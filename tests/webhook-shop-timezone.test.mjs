import assert from "node:assert/strict";
import test from "node:test";
import { readWebhookShopTimezone } from "../app/utils/readWebhookShopTimezone.js";

test("a transient connection failure is retried only for the timezone query", async () => {
  let calls = 0;
  const timezone = await readWebhookShopTimezone({ request: async ({ data }) => {
    assert.equal(data, "query GetShopTimezone { shop { ianaTimezone } }");
    if (++calls === 1) throw new TypeError("fetch failed");
    return Response.json({ data: { shop: { ianaTimezone: "Asia/Tokyo" } } });
  } });
  assert.equal(calls, 2);
  assert.equal(timezone, "Asia/Tokyo");
});

test("persistent transport failures stop after the second read", async () => {
  let calls = 0;
  await assert.rejects(readWebhookShopTimezone({ request: async () => {
    calls++;
    throw new TypeError("fetch failed");
  } }), /fetch failed/);
  assert.equal(calls, 2);
});

test("GraphQL errors do not cause an additional read", async () => {
  let calls = 0;
  await assert.rejects(readWebhookShopTimezone({ request: async () => {
    calls++;
    return Response.json({ errors: [{ message: "denied" }] });
  } }), /Shop timezone unavailable/);
  assert.equal(calls, 1);
});
