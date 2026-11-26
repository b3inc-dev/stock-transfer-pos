import { customerPhoneSaveMessage } from "../../extensions/common/customerPhone.js";
import { customerPhoneWriteAllowed, saveReservationCustomerPhone } from "../utils/reservation-customer-phone.server";
import { buildCustomerSearchQuery, normalizeCustomerSearch } from "../../extensions/common/customerSearch.js";
import { japaneseCustomerName } from "../../extensions/common/customerDisplay.js";
import { normalizeReservationReceiptSettings, renderConfiguredReservationReceipt } from "../services/reservationReceiptLayout";
import db from "../db.server";
import { buildVariantSearchQuery } from "../../extensions/common/variantSearch.js";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate, unauthenticated } from "../shopify.server";
import { planBlockedPosResponse } from "../utils/plan-gate.server";
import { withGraphQLRetry } from "../utils/graphql-with-retry";
import { ReservationCheckoutRejected, createReservation, getReservation, listReservations, hasReservationPosAccessConfiguration, publicReservationDefaultsEnabled, reservationAccountAccess, reservationDueCount, reservationPendingCount, reservationOverdueCount, publicReservation, reservationCommand, reservationQuery, reservationsEnabled } from "../utils/reservations.server";
import { localDate, maskPhone } from "../../extensions/common/reservations.js";

const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Cache-Control": "private, no-store" };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
async function context(request: Request, locationId: string, metadataOnly = false) {
  if (!reservationsEnabled()) throw new Response("Not found", { status: 404, headers });
  const { sessionToken } = await authenticate.pos(request);
  const shop = new URL(sessionToken.dest).hostname;
  const actor = String(sessionToken.sub || "");
  if (!/^\d+$/.test(actor) || !shop.endsWith(".myshopify.com")) throw new Response("Unauthorized", { status: 401, headers });
  const { admin } = await unauthenticated.admin(shop);
  const blocked = await planBlockedPosResponse({ shop, feature: "reservation", getAdmin: () => withGraphQLRetry(admin), headers });
  if (blocked) throw blocked;
  if (!/^gid:\/\/shopify\/Location\/\d+$/.test(locationId)) throw new Response(JSON.stringify({ ok: false, error: "POS店舗を取得できません" }), { status: 400, headers });
  let access = reservationAccountAccess(shop, actor, true);
  const automatic = publicReservationDefaultsEnabled() && !hasReservationPosAccessConfiguration(shop, actor);
  let publicSetup: { location: { id: string; name: string; isActive: boolean }; shop: { ianaTimezone: string }; currentAppInstallation: { accessScopes: { handle: string }[] } } | null = null;
  if (automatic || (publicReservationDefaultsEnabled() && access?.locations.includes(locationId))) {
    publicSetup = await reservationQuery(withGraphQLRetry(admin), `#graphql
      query ReservationPosSetup($id: ID!) { location(id: $id) { id name isActive } shop { ianaTimezone } currentAppInstallation { accessScopes { handle } } }`, { id: locationId });
    if (publicSetup?.location?.id !== locationId || !publicSetup.location.isActive) throw new Response(JSON.stringify({ ok: false, error: "このストアの有効なPOS店舗を選択してください" }), { status: 403, headers });
    if (automatic) access = { locations: [locationId], contact: true };
  }
  if (!access && !metadataOnly) throw new Response(JSON.stringify({ ok: false, error: "このPOSアカウントには取置の利用権限がありません。管理者に確認してください" }), { status: 403, headers: { ...headers, "Content-Type": "application/json" } });
  const scopes = publicSetup?.currentAppInstallation?.accessScopes?.map(scope => scope.handle) || [];
  const missingScopes = publicSetup ? ["read_customers", "read_orders"].filter(scope => !scopes.includes(scope) && !scopes.includes(scope.replace("read_", "write_"))) : [];
  return { shop, actor, admin, access: access || { locations: [], contact: false }, reveal: access?.contact === true, publicSetup, missingScopes };
}
export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  try {
    const url = new URL(request.url);
    const { shop, access, admin } = await context(request, url.searchParams.get("locationId") || "");
    const id = url.searchParams.get("receipt");
    const locationId = url.searchParams.get("locationId");
    if (locationId && !access.locations.includes(locationId)) return json({ error: "この店舗の取置を利用する権限がありません" }, 403);
    if (!id || !locationId) return json({ error: "Method not allowed" }, 405);
    const row = await getReservation(shop, locationId, id);
    if (!["held", "checkout", "sold", "cancelled"].includes(row.status)) return json({ error: "登録を確認してから印刷してください" }, 409);
    const settings = await db.stockReservationSettings.findUnique({ where: { shop }, select: { receiptLayout: true } });
    const requestedCopy = url.searchParams.get("copy");
    if (requestedCopy && !["customer", "store"].includes(requestedCopy)) return json({ ok: false, error: "控えの種類を選んでください" }, 400);
    const options = normalizeReservationReceiptSettings(settings?.receiptLayout);
    const copy = requestedCopy === "store" ? "store" : requestedCopy === "customer" ? "customer" : options.customerCopy ? "customer" : "store";
    let locationAddress;
    if (copy === "customer" && row.intakeMethod !== "inquiry" && options.customerCopy) {
      const result = await reservationQuery(withGraphQLRetry(admin), `#graphql
        query ReservationReceiptLocation($id: ID!) { location(id: $id) { id address { zip province city address1 address2 phone countryCode formatted } } }`, { id: row.locationId });
      if (result?.location?.id !== row.locationId) throw new Error("取置店舗の住所を取得できません");
      locationAddress = result.location.address;
    }
    return new Response(renderConfiguredReservationReceipt({ ...row, locationAddress }, settings?.receiptLayout, copy), { headers: { ...headers, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:", "X-Content-Type-Options": "nosniff" } });
  } catch (error) {
    if (error instanceof Response) return error;
    return json({ ok: false, error: "取置控えを取得できません。店舗と登録内容を確認してください" }, 400);
  }
}
export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const body = await request.json();
    const metadataOnly = body.command === "sessionDisplay";
    const locationId = String(body.locationId || "");
    const { shop, actor: authenticatedActor, admin, access, reveal, publicSetup, missingScopes } = await context(request, locationId, metadataOnly);
    if (!/^gid:\/\/shopify\/Location\/\d+$/.test(locationId)) return json({ error: "POS店舗を取得できません" }, 400);
    if (metadataOnly) {
      const info = publicSetup || await reservationQuery(withGraphQLRetry(admin), `#graphql query ReservationSessionDisplay($id: ID!) { location(id: $id) { id name isActive } shop { ianaTimezone } }`, { id: locationId });
      if (!info.location?.isActive) return json({ ok: false, error: "有効な店舗を選択してください" }, 400);
      const permitted = access.locations.includes(locationId);
      let timezone = "";
      try { timezone = JSON.parse(process.env.RESERVATION_LOCATION_TIMEZONES || "{}")[shop]?.[locationId] || ""; } catch { /* no configured store zone */ }
      let today: string | null = null;
      try { today = localDate(Date.now(), timezone || info.shop.ianaTimezone); } catch { /* don't invent a date */ }
      let customer: { name: string; phone: string; hasPhone: boolean } | null = null;
      let notice = permitted ? "" : "管理者による、このPOS利用者と店舗の取置利用設定が必要です。";
      if (permitted && missingScopes.length) notice = "ストア管理者が管理画面の「取置 → 設定」で顧客・注文の読み取りを許可してください。";
      const customerId = String(body.customerId || "");
      if (permitted && !missingScopes.includes("read_customers") && /^gid:\/\/shopify\/Customer\/\d+$/.test(customerId)) {
        try {
          const data = await reservationQuery(withGraphQLRetry(admin), `#graphql query ReservationSelectedCustomer($id: ID!) { customer(id: $id) { firstName lastName displayName phone } }`, { id: customerId });
          if (data.customer) customer = { name: japaneseCustomerName(data.customer), phone: data.customer.phone ? (reveal ? data.customer.phone : maskPhone(data.customer.phone)) : "", hasPhone: Boolean(data.customer.phone) };
        } catch { notice = "選択済み顧客の情報を取得できません。顧客データの利用権限を確認してください。"; }
      }
      let canSaveCustomerPhone = false;
      if (permitted && reveal && customer?.hasPhone === false) {
        try { canSaveCustomerPhone = await customerPhoneWriteAllowed(admin); } catch { /* Contact-only intake still works without write access. */ }
      }
      return json({ ok: true, canSaveCustomerPhone, locationName: info.location.name, today, customer, accessReady: permitted && !missingScopes.length, notice });
    }
    if (!access.locations.includes(locationId)) return json({ ok: false, error: "この店舗の取置を利用する権限がありません" }, 403);
    const pinned = /^\d+$/.test(String(body.staffMemberId || "")) ? String(body.staffMemberId) : "未取得";
    const actor = `${authenticatedActor} / POS担当 ${pinned}`;
    const command = String(body.command || "list");
    if (["create", "checkout", "checkoutAccess"].includes(command) && missingScopes.length) return json({ ok: false, error: "ストア管理者が管理画面の「取置 → 設定」で顧客・注文の読み取りを許可してください。承認後にもう一度お試しください" }, 403);
    if (["orders", "complete"].includes(command) && missingScopes.includes("read_orders")) return json({ ok: false, error: "ストア管理者が管理画面の「取置 → 設定」で注文の読み取りを許可してください" }, 403);
    if (command === "checkoutAccess") return json({ ok: true });
    if (command === "overdueCount") return json({ ok: true, count: await reservationOverdueCount(shop, locationId) });
    if (command === "pendingCount") return json({ ok: true, count: await reservationPendingCount(shop, locationId) });
    if (command === "count") return json({ ok: true, count: await reservationDueCount(shop, locationId) });
    if (command === "list") {
      return json({ ok: true, ...await listReservations(shop, locationId, withGraphQLRetry(admin), String(body.mode || "due"), String(body.query || "").slice(0, 100), Math.max(0, Math.floor(Number(body.page) || 0)), String(body.dueDate || "")) });
    }
    if (command === "customers") {
      if (missingScopes.includes("read_customers")) return json({ ok: false, error: "ストア管理者が管理画面の「取置 → 設定」で顧客の読み取りを許可してください" }, 403);
      const text = normalizeCustomerSearch(body.query);
      if (!text) return json({ ok: true, customers: [], pageInfo: { hasNextPage: false, endCursor: null } });
      const query = buildCustomerSearchQuery(text);
      const after = typeof body.after === "string" ? body.after.slice(0, 1000) : null;
      const data = await reservationQuery(withGraphQLRetry(admin), `#graphql
        query ReservationCustomerPicker($query: String!, $after: String) { customers(first: 20, query: $query, after: $after) { nodes { id firstName lastName displayName phone } pageInfo { hasNextPage endCursor } } }`, { query, after });
      if (data.customers.pageInfo.hasNextPage && (!data.customers.pageInfo.endCursor || data.customers.pageInfo.endCursor === after)) throw new Error("次のお客様一覧を取得できません。再読み込みしてください");
      return json({ ok: true, customers: data.customers.nodes.map((customer: { id: string; firstName: string; lastName: string; displayName: string; phone: string | null }) => ({ id: customer.id, name: japaneseCustomerName(customer), phone: reveal ? customer.phone || "" : maskPhone(customer.phone || "") })), pageInfo: data.customers.pageInfo });
    }
    if (command === "receiptOptions") {
      const saved = await db.stockReservationSettings.findUnique({ where: { shop }, select: { receiptLayout: true } });
      const options = normalizeReservationReceiptSettings(saved?.receiptLayout);
      return json({ ok: true, customerCopy: options.customerCopy, storeCopy: options.storeCopy });
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
    if (command === "saveCustomerPhone") {
      if (!reveal) return json({ ok: false, error: "顧客の電話番号を登録する権限がありません" }, 403);
      const row = await getReservation(shop, locationId, String(body.id || ""));
      if (!await customerPhoneWriteAllowed(admin)) return json({ ok: false, error: "ストア管理者が「取置 → 設定」で顧客情報への登録を許可してください" }, 403);
      const updated = await saveReservationCustomerPhone(row, admin, actor);
      return json({ ok: true, row: await publicReservation(updated, admin, reveal), customerPhoneWarning: customerPhoneSaveMessage(updated.customerPhoneSaveState) });
    }
    if (command === "create") {
      if (body.saveCustomerPhone === true && !reveal) return json({ ok: false, error: "顧客の電話番号を登録する権限がありません" }, 403);
      try {
        let row = await createReservation({ shop, locationId, actor, admin, input: body, storeTimezone: publicSetup?.shop?.ianaTimezone });
        let customerPhoneWarning = "";
        if (row.status === "held" && row.customerPhoneSaveState && row.customerPhoneSaveState !== "saved") {
          try {
            if (reveal && await customerPhoneWriteAllowed(admin)) row = await saveReservationCustomerPhone(row, admin, actor);
            else customerPhoneWarning = "取置は登録済みです。顧客への電話番号登録には、管理画面の「取置 → 設定」で顧客情報への登録を許可してください。";
          } catch { customerPhoneWarning = "取置は登録済みです。顧客情報への電話番号登録を確認できません。詳細画面から登録結果を確認してください。"; }
        }
        return json({ ok: true, row: await publicReservation(row, admin, reveal), customerPhoneWarning: customerPhoneWarning || customerPhoneSaveMessage(row.customerPhoneSaveState) });
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
