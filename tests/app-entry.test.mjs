import assert from "node:assert/strict";
import { test } from "node:test";
import { appEntryRedirectPath } from "../app/utils/app-entry.ts";

test("sends Shopify admin launches to /app with the same query", () => {
  assert.equal(
    appEntryRedirectPath(new URL("https://x.test/?shop=a.myshopify.com&host=abc")),
    "/app?shop=a.myshopify.com&host=abc",
  );
  assert.equal(appEntryRedirectPath(new URL("https://x.test/?host=abc")), "/app?host=abc");
  assert.equal(appEntryRedirectPath(new URL("https://x.test/?embedded=1")), "/app?embedded=1");
});

test("returns null when the shop is unknown (no shop-domain form)", () => {
  assert.equal(appEntryRedirectPath(new URL("https://x.test/")), null);
  assert.equal(appEntryRedirectPath(new URL("https://x.test/?shop=")), null);
  assert.equal(appEntryRedirectPath(new URL("https://x.test/?utm_source=x")), null);
});
