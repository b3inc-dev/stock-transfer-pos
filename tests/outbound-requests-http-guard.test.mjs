import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { runInNewContext } from "node:vm";

const routeText = readFileSync(new URL("../app/routes/api.outbound-requests.tsx", import.meta.url), "utf8");
const serviceText = readFileSync(new URL("../app/utils/outbound-requests.server.ts", import.meta.url), "utf8");
const flagExpression = serviceText.match(/^export const outboundRequestsEnabled = (.*);$/m)?.[1];
assert.ok(flagExpression, "read the actual feature predicate from the candidate");
const moduleText = ts.transpileModule(routeText, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");

function routeFixture(flag) {
  const calls = { flag: 0, auth: 0, database: 0, otherBackend: 0 };
  const env = flag === undefined ? {} : { OUTBOUND_REQUESTS_ENABLED: flag };
  const actualFlag = runInNewContext(flagExpression, { process: { env } });
  const unavailable = () => { calls.otherBackend++; throw new Error("synthetic forbidden backend access"); };
  const context = {
    Response, URL,
    outboundRequestsEnabled: () => { calls.flag++; return actualFlag(); },
    authenticate: { pos: async () => { calls.auth++; throw new Error("synthetic forbidden auth access"); } },
    unauthenticated: { admin: unavailable },
    db: new Proxy({}, { get() { calls.database++; throw new Error("synthetic forbidden database access"); } }),
    outboundPublicMessage: () => "synthetic unexpected backend access",
    planBlockedPosResponse: unavailable, withGraphQLRetry: unavailable,
    renderOutboundRequestReceipt: unavailable, advanceRequest: unavailable,
    beginRequest: unavailable, canonicalLines: unavailable, changeRequest: unavailable,
    getRequest: unavailable, getRequestPolicy: unavailable, previewRequest: unavailable,
    reconcileRequest: unavailable, requestError: unavailable, requestProducts: unavailable,
    requestQuery: unavailable, shippingSettings: unavailable,
  };
  const route = runInNewContext(moduleText + "\n({loader, action})", context);
  return { route, calls };
}
function assertPublicHeaders(response) {
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(response.headers.get("access-control-allow-methods"), "POST, GET, OPTIONS");
  assert.equal(response.headers.get("access-control-allow-headers"), "Authorization, Content-Type");
}
function assertNoProtectedCalls(calls) {
  assert.deepEqual({ auth: calls.auth, database: calls.database, otherBackend: calls.otherBackend }, { auth: 0, database: 0, otherBackend: 0 });
}

test("preflight on both route handlers is stateless with feature disabled or enabled", async () => {
  for (const flag of [undefined, "0", "1"]) for (const handler of ["loader", "action"]) {
    const { route, calls } = routeFixture(flag);
    const response = await route[handler]({ request: new Request("https://synthetic.invalid/api/outbound-requests", { method: "OPTIONS" }) });
    assert.equal(response.status, 204);
    assert.equal(await response.text(), "");
    assertPublicHeaders(response);
    assertNoProtectedCalls(calls);
    assert.equal(calls.flag, 0, "preflight does not evaluate shop or feature settings");
  }
});

test("unsupported action methods never enter feature/auth/database or command execution", async () => {
  for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE"]) {
    const { route, calls } = routeFixture("1");
    const response = await route.action({ request: new Request("https://synthetic.invalid/api/outbound-requests", { method }) });
    assert.equal(response.status, 405, method);
    assert.deepEqual(await response.json(), { ok: false, error: "Method not allowed" });
    assertPublicHeaders(response);
    assertNoProtectedCalls(calls);
    assert.equal(calls.flag, 0);
  }
});

test("disabled receipt GET responds no-store 404 without reading the request or print settings", async () => {
  for (const flag of [undefined, "", "0", "false", "true", "01", " 1", "1 "]) {
    const { route, calls } = routeFixture(flag);
    const response = await route.loader({ request: new Request("https://synthetic.invalid/api/outbound-requests?receipt=synthetic-request&locationId=gid://shopify/Location/1") });
    assert.equal(response.status, 404, String(flag));
    assert.equal(await response.text(), "Not found");
    assertPublicHeaders(response);
    assertNoProtectedCalls(calls);
    assert.equal(calls.flag, 1);
  }
});

test("every disabled POS command returns no-store 404 before protected reads or writes", async () => {
  for (const command of ["list", "count", "products", "detail", "claim", "release", "save", "preview", "begin", "advance", "reconcile"]) {
    const { route, calls } = routeFixture(undefined);
    const response = await route.action({ request: new Request("https://synthetic.invalid/api/outbound-requests", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command, id: "synthetic-request", locationId: "gid://shopify/Location/1", version: 1 }),
    }) });
    assert.equal(response.status, 404, command);
    assert.equal(await response.text(), "Not found");
    assertPublicHeaders(response);
    assertNoProtectedCalls(calls);
    assert.equal(calls.flag, 1);
  }
});
