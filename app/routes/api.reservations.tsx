import db from "../db.server";
import { buildVariantSearchQuery } from "../../extensions/common/variantSearch.js";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate, unauthenticated } from "../shopify.server";
import { planBlockedPosResponse } from "../utils/plan-gate.server";
import { withGraphQLRetry } from "../utils/graphql-with-retry";
import { ReservationCheckoutRejected, createReservation, getReservation, listReservations, reservationAccountAccess, reservationDueCount, publicReservation, reservationCommand, reservationQuery, reservationsEnabled } from "../utils/reservations.server";
import { receiptHtml } from "../../extensions/common/reservations.js";

const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Cache-Control": "private, no-store" };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
async function context(request: Request) {
  if (!reservationsEnabled()) throw new Response("Not found", { status: 404, headers });
  const { sessionToken } = await authenticate.pos(request);
  const shop = new URL(sessionToken.dest).hostname;
  const actor = String(sessionToken.sub || "");
  if (!actor || !shop.endsWith(".myshopify.com")) throw new Response("Unauthorized", { status: 401, headers });
  const { admin } = await unauthenticated.admin(shop);
  const blocked = await planBlockedPosResponse({ shop, feature: "reservation", getAdmin: () => withGraphQLRetry(admin), headers });
  if (blocked) throw blocked;
  const access = reservationAccountAccess(shop, actor);
  if (!access) throw new Response(JSON.stringify({ ok: false, error: "このPOSアカウントには取置の利用権限がありません。管理者に確認してください" }), { status: 403, headers: { ...headers, "Content-Type": "application/json" } });
  return { shop, actor, admin, access, reveal: access.contact };
}
export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  try {
    const { shop, access } = await context(request);
    const url = new URL(request.url);
    const id = url.searchParams.get("receipt");
    const locationId = url.searchParams.get("locationId");
    if (locationId && !access.locations.includes(locationId)) return json({ error: "この店舗の取置を利用する権限がありません" }, 403);
    if (!id || !locationId) return json({ error: "Method not allowed" }, 405);
    const row = await getReservation(shop, locationId, id);
    if (!["held", "checkout", "sold", "cancelled"].includes(row.status)) return json({ error: "登録を確認してから印刷してください" }, 409);
    const settings = await db.stockReservationSettings.findUnique({ where: { shop }, select: { receiptLayout: true } });
    return new Response(receiptHtml({ ...row, lines: row.lines }, settings?.receiptLayout), { headers: { ...headers, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src https:", "X-Content-Type-Options": "nosniff" } });
  } catch (error) {
    if (error instanceof Response) return error;
    return json({ ok: false, error: "取置控えを取得できません。店舗と登録内容を確認してください" }, 400);
  }
}
export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const { shop, actor: authenticatedActor, admin, access, reveal } = await context(request);
    const body = await request.json();
    const locationId = String(body.locationId || "");
    if (!/^gid:\/\/shopify\/Location\/\d+$/.test(locationId)) return json({ error: "POS店舗を取得できません" }, 400);
    if (!access.locations.includes(locationId)) return json({ ok: false, error: "この店舗の取置を利用する権限がありません" }, 403);
    const pinned = /^\d+$/.test(String(body.staffMemberId || "")) ? String(body.staffMemberId) : "未取得";
    const actor = `${authenticatedActor} / POS担当 ${pinned}`;
    const command = String(body.command || "list");
    if (command === "count") return json({ ok: true, count: await reservationDueCount(shop, locationId) });
    if (command === "list") {
      return json({ ok: true, ...await listReservations(shop, locationId, withGraphQLRetry(admin), String(body.mode || "due"), String(body.query || "").slice(0, 100), Math.max(0, Math.floor(Number(body.page) || 0)), String(body.dueDate || "")) });
    }
    if (command === "productSettings") {
      const data = await reservationQuery(withGraphQLRetry(admin), `#graphql query ReservationProductSettings { currentAppInstallation { metafield(namespace: "stock_transfer_pos", key: "settings_v1") { value } } }`);
      let settings: { searchList?: { initialLimit?: number }; productList?: { initialLimit?: number } } = {};
      try { settings = JSON.parse(data.currentAppInstallation?.metafield?.value || "{}"); } catch { /* use existing defaults */ }
      return json({ ok: true, searchLimit: Math.max(10, Math.min(50, Number(settings?.searchList?.initialLimit) || 50)), productLimit: Math.max(1, Math.min(250, Number(settings?.productList?.initialLimit) || 250)) });
    }
    if (command === "products") {
      const raw = String(body.query || "").trim().slice(0, 100);
      const ids = Array.isArray(body.ids) ? [...new Set<string>(body.ids.map((id: unknown) => String(id)))].filter(id => /^gid:\/\/shopify\/ProductVariant\/\d+$/.test(id)).slice(0, 250) : [];
      if (!raw && !ids.length) return json({ ok: true, products: [], pageInfo: { hasNextPage: false, endCursor: null } });
      const first = Math.max(10, Math.min(50, Math.floor(Number(body.first) || 50)));
      const after = typeof body.after === "string" ? body.after.slice(0, 1000) : null;
      const query = body.scan ? `barcode:"${raw.replace(/["\\]/g, "")}" OR sku:"${raw.replace(/["\\]/g, "")}"` : buildVariantSearchQuery(raw);
      const fields = `id displayName title sku barcode image @include(if: $images) { url } product { title featuredImage @include(if: $images) { url } } inventoryItem { tracked inventoryLevel(locationId: $location) { quantities(names: ["available"]) { quantity } } }`;
      const data = ids.length
        ? await reservationQuery(withGraphQLRetry(admin), `#graphql query ReservationProductDetails($ids: [ID!]!, $location: ID!, $images: Boolean!) { nodes(ids: $ids) { ... on ProductVariant { ${fields} } } }`, { ids, location: locationId, images: body.images !== false })
        : await reservationQuery(withGraphQLRetry(admin), `#graphql query ReservationSearch($query: String!, $first: Int!, $after: String, $location: ID!, $images: Boolean!) { productVariants(first: $first, after: $after, query: $query) { nodes { ${fields} } pageInfo { hasNextPage endCursor } } }`, { query, first, after, location: locationId, images: body.images !== false });
      const connection = ids.length ? { nodes: data.nodes.filter(Boolean), pageInfo: { hasNextPage: false, endCursor: null } } : data.productVariants;
      return json({ ok: true, products: connection.nodes.map((node: { id: string; displayName: string; title: string; sku: string; barcode: string; image?: { url: string }; product: { title: string; featuredImage?: { url: string } }; inventoryItem?: { tracked: boolean; inventoryLevel?: { quantities: { quantity: number }[] } } }) => ({
        id: node.id, displayName: node.displayName, productTitle: node.product.title, variantTitle: node.title, sku: node.sku, barcode: node.barcode,
        imageUrl: node.image?.url || node.product.featuredImage?.url || "", available: node.inventoryItem?.inventoryLevel?.quantities[0]?.quantity ?? null,
        eligible: Boolean(node.inventoryItem?.tracked && node.inventoryItem?.inventoryLevel),
      })), pageInfo: connection.pageInfo });
    }
    if (command === "orders") {
      // Staff search by human order name; the completion path re-reads and fully validates the selected order.
      const search = String(body.query || "").trim();
      if (!/^#?[\w-]{1,50}$/.test(search)) throw new Error("POSの注文番号を入力してください");
      const data = await reservationQuery(withGraphQLRetry(admin), `#graphql
        query ReservationOrderSearch($query: String!) { orders(first: 10, query: $query) { nodes { id name } } }`, { query: `name:${search}` });
      return json({ ok: true, orders: data.orders.nodes });
    }
    if (command === "create") {
      try {
        const row = await createReservation({ shop, locationId, actor, admin, input: body });
        return json({ ok: true, row: await publicReservation(row, admin, reveal) });
      } catch (error) {
        let resetAllowed = false;
        try { await getReservation(shop, locationId, String(body.id || "")); }
        catch (lookup) { if (lookup instanceof Error && lookup.message === "この店舗の取置が見つかりません") resetAllowed = true; }
        const message = error instanceof Error && /[\u3040-\u30ff\u4e00-\u9fff]/.test(error.message) ? error.message : "登録結果を確認できません。同じ番号で確認してください";
        return json({ ok: false, error: message, resetAllowed }, 409);
      }
    }
    const row = await getReservation(shop, locationId, String(body.id || ""));
    if (command === "detail") return json({ ok: true, row: { ...await publicReservation(row, admin, reveal), checkoutKey: row.checkoutKey, checkoutDevice: row.checkoutDevice } });
    const updated = await reservationCommand(row, admin, actor, body);
    return json({ ok: true, row: { ...await publicReservation(updated, admin, reveal), checkoutKey: updated.checkoutKey, checkoutDevice: updated.checkoutDevice } });
  } catch (error) {
    if (error instanceof Response) return error;
    // Only our localized business errors are exposed; no DB or GraphQL body/PII in logs or responses.
    const message = error instanceof Error && /[\u3040-\u30ff\u4e00-\u9fff]/.test(error.message) ? error.message : "取置を処理できませんでした。通信状態と入力を確認してください";
    return json({ ok: false, error: message, checkoutRejected: error instanceof ReservationCheckoutRejected }, 409);
  }
}
