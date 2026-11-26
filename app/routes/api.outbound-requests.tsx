import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticate, unauthenticated } from "../shopify.server";
import { planBlockedPosResponse } from "../utils/plan-gate.server";
import { withGraphQLRetry } from "../utils/graphql-with-retry";
import { renderConfiguredOutboundRequestReceipt } from "../services/outboundRequestReceipt";
import { advanceRequest, beginRequest, canonicalLines, changeRequest, getRequest, getRequestPolicy, outboundRequestsEnabled, outboundPublicMessage, previewRequest, reconcileRequest, requestError, requestProducts, requestQuery, shippingSettings, type RequestLine, type RequestRow } from "../utils/outbound-requests.server";

const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Cache-Control": "private, no-store" };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
async function context(request: Request, locationId: string, recovery?: { command: string; id: string }) {
  if (!outboundRequestsEnabled()) throw new Response("Not found", { status: 404, headers });
  const { sessionToken } = await authenticate.pos(request);
  const shop = new URL(sessionToken.dest).hostname, actor = String(sessionToken.sub || "");
  if (!/^\d+$/.test(actor) || !shop.endsWith(".myshopify.com")) throw new Response("Unauthorized", { status: 401, headers });
  if (!/^gid:\/\/shopify\/Location\/\d+$/.test(locationId)) throw requestError("POS店舗を確認してください");
  const { admin } = await unauthenticated.admin(shop);
  // Already-applied stock must remain inspectable/loggable. Never fail open for a new inventory write.
  const recovering = recovery ? await getRequest(shop, recovery.id, locationId) : null;
  const followUpOnly = Boolean(recovering?.operationId && (recovery?.command !== "advance" || recovering.execution?.stage === "log"));
  if (followUpOnly && recovering) {
    // Authorization and origin were fixed before the stock operation. Logging/inspection must not depend on another Shopify read.
    return { admin, shop, actor, location: { id: recovering.originId, name: recovering.originName }, shipping: { required: false, allowCustomCarrier: false, carriers: [], visibleLocationIds: [] } };
  }
  const blocked = await planBlockedPosResponse({ shop, feature: "outboundRequest", getAdmin: () => withGraphQLRetry(admin), headers });
  if (blocked) throw blocked;
  const result = await requestQuery<{ location: { id: string; isActive: boolean; name: string } | null }>(withGraphQLRetry(admin), "query RequestPosLocation($id:ID!){location(id:$id){id isActive name}}", { id: locationId });
  if (!result.location?.isActive) throw requestError("有効なPOS店舗を選択してください", 403);
  const shipping = await shippingSettings(admin);
  if (shipping.visibleLocationIds.length && !shipping.visibleLocationIds.includes(locationId)) throw requestError("この店舗は利用対象外です", 403);
  return { admin, shop, actor, location: result.location, shipping };
}
function failure(error: unknown) {
  if (error instanceof Response) return error;
  return json({ ok: false, error: outboundPublicMessage(error) }, error instanceof Error && "status" in error ? Number(error.status) : error instanceof Error && "code" in error && error.code === "OUTBOUND_VALIDATION" ? 400 : 500);
}
export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  try {
    const url = new URL(request.url), locationId = url.searchParams.get("locationId") || "";
    const { shop } = await context(request, locationId);
    const row = await getRequest(shop, url.searchParams.get("receipt") || "", locationId);
    if (["draft", "cancelled"].includes(row.status)) throw requestError("印刷できる依頼を選択してください", 409);
    return new Response(renderConfiguredOutboundRequestReceipt(row, (await getRequestPolicy(shop)).policy), { headers: { ...headers, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'", "X-Content-Type-Options": "nosniff" } });
  } catch (error) { return failure(error); }
}
export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  try {
    const body = await request.json();
    const command = String(body.command || "list"), locationId = String(body.locationId || "");
    const { admin, shop, actor, location, shipping } = await context(request, locationId, ["advance", "reconcile", "detail"].includes(command) ? { command, id: String(body.id || "") } : undefined);
    const posRow = (row: RequestRow) => ({ ...row, claimKey: undefined, claimed: row.owner === actor && Boolean(body.claimKey) && row.claimKey === body.claimKey });
    const send = (row: RequestRow) => json({ ok: true, row: posRow(row) });
    if (command === "list" || command === "count") {
      const where = { shop, originId: locationId, status: body.history === true && command === "list" ? { not: "draft" } : { in: ["requested", "working", "processing", "uncertain", "retryable"] } };
      const page = Math.max(0, Math.floor(Number(body.page) || 0));
      return json({ ok: true, location, count: await db.outboundRequest.count({ where }), rows: command === "count" ? [] : await db.outboundRequest.findMany({ where, select: { id: true, number: true, status: true, originId: true, originName: true, destinationName: true, dueDate: true, version: true }, orderBy: { createdAt: "desc" }, take: 25, skip: page * 25 }), page, settings: await getRequestPolicy(shop), shipping });
    }
    if (command === "products") return json({ ok: true, products: await requestProducts(admin, String(body.query || ""), body.scan === true) });
    const row = await getRequest(shop, String(body.id || ""), locationId);
    if (command === "detail") return json({ ok: true, row: posRow(row), settings: await getRequestPolicy(shop), shipping });
    if (Number(body.version) !== row.version) throw requestError("依頼が更新されました。読み直して検品内容を確認してください", 409);
    if (command === "claim") {
      if (row.status !== "requested") throw requestError("別の端末で作業中、または出庫済みです。依頼を読み直してください", 409);
      if (!/^[0-9a-f-]{36}$/i.test(String(body.claimKey || ""))) throw requestError("作業端末を確認してください");
      return send(await changeRequest(row, actor, "作業を開始", { status: "working", owner: actor, claimKey: body.claimKey }));
    }
    if (command === "release") {
      if (row.status !== "working" || row.owner !== actor || body.claimKey !== row.claimKey) throw requestError("作業を中止できません。依頼を読み直してください", 409);
      return send(await changeRequest(row, actor, "作業を中止", { status: "requested", owner: null, claimKey: null }));
    }
    if (["save", "preview", "begin"].includes(command)) {
      if (row.status !== "working" || row.owner !== actor || body.claimKey !== row.claimKey) throw requestError("この端末の作業ではありません。依頼を読み直してください", 409);
      const actual = body.actual as RequestLine[];
      if (command === "save") {
        // Incomplete work may be saved before difference reasons are entered, but identities/counts remain checked.
        if (!Array.isArray(actual) || actual.length > 3000 || actual.some(line => !/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(line.variantId) || !Number.isSafeInteger(line.quantity) || line.quantity < 0 || line.quantity > 999999 || typeof line.reason !== "string" || line.reason.length > 500) || new Set(actual.map(line => line.variantId)).size !== actual.length) throw requestError("検品数量・商品・理由を確認してください");
        const canonical = await canonicalLines(admin, actual);
        const policy = (await getRequestPolicy(shop)).policy;
        for (const line of canonical) {
          const original = row.lines.find(item => item.inventoryItemId === line.inventoryItemId);
          if ((!original && line.quantity > 0 && !policy.allowExtra) || (original && line.quantity > original.quantity && !policy.allowOver)) throw requestError("設定で許可されていない商品・数量があります");
        }
        return send(await changeRequest(row, actor, "検品を保存", { actualLines: canonical }));
      }
      if (command === "preview") return json({ ok: true, preview: await previewRequest(row, admin, actual, body.tracking) });
      return send(await beginRequest(row, actor, admin, actual, body.tracking, String(body.token || "")));
    }
    if (command === "advance") return send(await advanceRequest(row, actor, admin));
    if (command === "reconcile") return send(await reconcileRequest(row, actor, admin));
    throw requestError("操作を確認してください");
  } catch (error) { return failure(error); }
}
