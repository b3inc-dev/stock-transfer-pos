import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";

let vite, loadPage, changeCriteria;
let transfers = [];
const location = (id) => ({ location: { id: `gid://shopify/Location/${id}`, name: `店${id}` } });
const transfer = (id, from, to, status = "DRAFT") => ({
  id: String(id), name: String(id), origin: from && location(from), destination: to && location(to),
  status, shipments: { nodes: [] }, dateCreated: new Date(2025, 0, id).toISOString(),
});
let variables;
const admin = {
  async graphql(document, options) {
    let data = {};
    if (document.includes("query HistoryLocations")) {
      const last = options.variables.after === "more";
      data.locations = { nodes: [location(last ? 2 : 1).location], pageInfo: { hasNextPage: !last, endCursor: last ? null : "more" } };
    }
    if (document.includes("query AllTransfers")) {
      assert.match(document, /query:\s*\$query/);
      assert.match(document, /reverse:\s*\$reverse/);
      variables = options.variables;
      const { first, last, before, after, reverse, query } = variables;
      const selected = (field) => [...(query || "").matchAll(new RegExp(field + ":([a-z0-9_]+)", "g"))].map(m => m[1]);
      const match = (choices, value) => choices.length === 0 || choices.includes(value);
      const hits = transfers.filter(t =>
        match(selected("origin_id"), t.origin?.location.id.split("/").pop()) &&
        match(selected("destination_id"), t.destination?.location.id.split("/").pop()) &&
        match(selected("status"), t.status.toLowerCase())
      );
      if (reverse) hits.reverse();
      const start = first ? Number(after || 0) : Math.max(0, Number(before) - last);
      const end = first ? Math.min(start + first, hits.length) : Number(before);
      const nodes = hits.slice(start, end);
      data.inventoryTransfers = { nodes, pageInfo: {
        hasNextPage: end < hits.length, hasPreviousPage: start > 0,
        startCursor: nodes.length ? String(start) : null, endCursor: nodes.length ? String(end) : null,
      } };
    }
    return Response.json({ data });
  },
};

before(async () => {
  // Exercise the real route loader, replacing only its Shopify authentication boundary.
  vite = await createServer({
    configFile: false, appType: "custom", server: { middlewareMode: true, hmr: false },
    plugins: [{
      name: "test-shopify-admin",
      enforce: "pre",
      resolveId: id => id === "../shopify.server" ? "\0test-admin" : null,
      load: id => id === "\0test-admin" ? "export const authenticate = {admin: async () => ({admin: globalThis.historyTestAdmin})}" : null,
    }],
  });
  globalThis.historyTestAdmin = admin;
  const { loader } = await vite.ssrLoadModule("/app/routes/app.history.tsx");
  const filters = await vite.ssrLoadModule("/app/utils/transfer-history-filters.ts");
  loadPage = async (query) => (await loader({ request: new Request("https://test.invalid/app/history?" + query) })).data;
  changeCriteria = filters.changeHistoryCriteria;
});
after(async () => { delete globalThis.historyTestAdmin; await vite?.close(); });

test("origin, destination, combined and multi-location searches use the two actual endpoints", async () => {
  transfers = [transfer(1, 1, 2), transfer(2, 1, 3, "TRANSFERRED"), transfer(3, 4, 2), transfer(4, null, 2)];
  for (const [params, expected] of [
    ["destination=2", ["4", "3", "1"]],
    ["origin=1", ["2", "1"]],
    ["origin=1&destination=2", ["1"]],
    ["origin=1&origin=4&destination=2&destination=3&status=DRAFT&status=TRANSFERRED", ["3", "2", "1"]],
  ]) {
    assert.deepEqual((await loadPage(params)).histories.map(h => h.id), expected);
  }
  assert.equal(variables.query, "(origin_id:1 OR origin_id:4) AND (destination_id:2 OR destination_id:3) AND (status:draft OR status:transferred)");
  assert.deepEqual((await loadPage("origin=5")).histories, []);
});

test("filters and sorting apply before the 100-row cursor, in both directions across three pages", async () => {
  transfers = Array.from({ length: 203 }, (_, i) => transfer(i + 1, 1, 2, i === 0 ? "TRANSFERRED" : "DRAFT"));
  const rare = await loadPage("origin=1&destination=2&status=TRANSFERRED");
  assert.deepEqual(rare.histories.map(h => h.id), ["1"]);
  assert.equal(rare.pageInfo.hasNextPage, false);
  assert.equal(rare.pagination.startOffset, 0);
  assert.equal(rare.locations.length, 2);
  const base = "destination=2&sort=asc";
  const first = await loadPage(base);
  assert.equal(first.histories[0].id, "1");
  const second = await loadPage(base + "&direction=next&cursor=" + first.pageInfo.endCursor + "&page=2&boundary=100");
  const third = await loadPage(base + "&direction=next&cursor=" + second.pageInfo.endCursor + "&page=3&boundary=200");
  assert.equal(third.pagination.startOffset + third.histories.length, 203);
  assert.deepEqual(third.histories.map(h => h.id), ["201", "202", "203"]);
  const back = await loadPage(base + "&direction=prev&cursor=" + third.pageInfo.startCursor + "&page=2&boundary=200");
  assert.deepEqual(back.histories, second.histories);
  assert.deepEqual(back.pagination, { page: 2, startOffset: 100 });
  const reset = changeCriteria(new URLSearchParams(base + "&cursor=100&page=2&boundary=100&direction=next&total=203&host=test"), "destination", ["4"]);
  assert.equal(reset.toString(), "sort=asc&host=test&destination=4");
  assert.equal((await loadPage(reset)).pagination.startOffset, 0);
});

test("empty selection clears the condition; unsupported search values do not broaden a search", async () => {
  const cleared = changeCriteria(new URLSearchParams("origin=1&status=DRAFT"), "origin", []);
  assert.equal(cleared.toString(), "status=DRAFT");
  for (const params of ["origin=1+OR+origin_id:2", "status=unknown"]) {
    await assert.rejects(loadPage(params), error => error instanceof Response && error.status === 400);
  }
  await loadPage("");
  assert.equal(variables.query, null);
});
