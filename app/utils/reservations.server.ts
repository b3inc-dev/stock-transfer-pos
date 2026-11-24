import { createHash, randomUUID } from "node:crypto";
import { Prisma, type StockReservation } from "@prisma/client";
import db from "../db.server";
import { addDays, assertOrderMatches, localDate, maskPhone, needsFollowUp, normalizeReservationLines, TERMINAL_RESERVATIONS, validDate } from "../../extensions/common/reservations.js";

export class ReservationCheckoutRejected extends Error { readonly checkoutRejected = true; }
export type ReservationAdmin = { graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response> };
export type ReservationLine = { variantId: string; inventoryItemId: string; title: string; quantity: number };
type Operation = { key: string; startedAt: string; input: Record<string, unknown>; success: string; rejected: string; actor: string };
export function reservationsEnabled() { return process.env.RESERVATIONS_ENABLED === "1"; }
export async function reservationPrivacyAvailable(shop: string) {
  if (reservationsEnabled()) return true;
  try {
    return await db.stockReservationPrivacyRequest.count({ where: { shop } }) > 0 || await db.stockReservation.count({ where: { shop, anonymizedAt: null } }) > 0;
  } catch { return false; } // Direct privacy URL remains available even if the navigation count fails.
}
export function reservationAccountAccess(shop: string, subject: string): { locations: string[]; contact: boolean } | null {
  try {
    const entry = JSON.parse(process.env.RESERVATION_POS_ACCESS || "{}")[shop]?.[subject];
    if (!Array.isArray(entry?.locations) || entry.locations.some((id: unknown) => typeof id !== "string" || !/^gid:\/\/shopify\/Location\/\d+$/.test(id))) return null;
    return { locations: entry.locations, contact: entry.contact === true };
  } catch { return null; }
}
export async function reservationQuery(admin: ReservationAdmin, query: string, variables: Record<string, unknown> = {}) {
  const response = await admin.graphql(query, { variables });
  // Do not propagate API response bodies into logs: customer query responses contain PII.
  if (!response.ok) throw new Error(`Shopifyとの通信に失敗しました（HTTP ${response.status}）。もう一度確認してください`);
  const body = await response.json();
  if (body.errors?.length || !body.data) throw new Error("Shopifyの権限または通信状態を確認してください");
  return body.data;
}
export async function getReservation(shop: string, locationId: string, id: string) {
  const row = await db.stockReservation.findFirst({ where: { shop, locationId, id }, include: { events: { orderBy: { createdAt: "desc" }, take: 30 } } });
  if (!row) throw new Error("この店舗の取置が見つかりません");
  return row;
}
export async function publicReservation(row: StockReservation, admin: ReservationAdmin, reveal = false, customers?: Map<string, { displayName: string; phone?: string }>) {
  let name = row.guestName || (row.anonymizedAt ? "匿名化済み" : "ゲスト");
  let phone = row.contactPhone || "";
  if (row.customerId) {
    const data = customers ? { customer: customers.get(row.customerId) } : await reservationQuery(admin, `#graphql
      query ReservationCustomer($id: ID!) { customer(id: $id) { displayName phone } }`, { id: row.customerId });
    name = data.customer?.displayName || "顧客情報を取得できません";
    phone = phone || data.customer?.phone || "";
  }
  // Explicit whitelist: never expose the persisted mutation input or checkout key in list results.
  return { id: row.id, locationId: row.locationId, locationName: row.locationName, timezone: row.timezone,
    status: row.status, version: row.version, customerId: row.customerId, name,
    phone: reveal ? phone : maskPhone(phone), contactVisible: reveal, lines: row.lines,
    dueDate: row.dueDate, nextFollowDate: row.nextFollowDate, needsFollowUp: needsFollowUp(row),
    lastError: row.lastError, createdAt: row.createdAt, createdBy: row.createdBy, endedAt: row.endedAt,
    endedBy: row.endedBy, anonymizedAt: row.anonymizedAt, events: "events" in row ? row.events : [], orderId: row.orderId };
}
export async function reservationDueCount(shop: string, locationId: string) {
  const rows = await db.stockReservation.findMany({ where: { shop, locationId, status: { notIn: TERMINAL_RESERVATIONS } }, select: { status: true, dueDate: true, nextFollowDate: true, timezone: true } });
  return rows.filter(row => needsFollowUp(row)).length;
}
export async function listReservations(shop: string, locationId: string, admin: ReservationAdmin, mode: string, query: string, page: number, dueDate = "") {
  const rows = await db.stockReservation.findMany({ where: { shop, locationId,
    status: mode === "ended" ? { in: TERMINAL_RESERVATIONS } : { notIn: TERMINAL_RESERVATIONS } },
    select: { id: true, customerId: true, guestName: true, status: true, dueDate: true, nextFollowDate: true, timezone: true },
    orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }] });
  const text = query.trim().toLocaleLowerCase();
  let customerIds = new Set<string>();
  if (text && !text.startsWith("r-")) {
    const data = await reservationQuery(admin, `#graphql
      query ReservationCustomerSearch($query: String!) { customers(first: 100, query: $query) { nodes { id } pageInfo { hasNextPage } } }`, { query: text });
    if (data.customers.pageInfo.hasNextPage) throw new Error("お名前をもう少し詳しく入力してください");
    customerIds = new Set(data.customers.nodes.map((customer: { id: string }) => customer.id));
  }
  if (dueDate && !validDate(dueDate)) throw new Error("受取期限の日付を確認してください");
  const filtered = rows.filter(row => (!dueDate || row.dueDate === dueDate) && (mode !== "due" || needsFollowUp(row)) && (!text || row.id.toLowerCase().includes(text) || row.guestName?.toLocaleLowerCase().includes(text) || (row.customerId && customerIds.has(row.customerId))))
    .sort((a, b) => Number(needsFollowUp(b)) - Number(needsFollowUp(a)) || (a.nextFollowDate || a.dueDate).localeCompare(b.nextFollowDate || b.dueDate));
  const requestedPage = Number.isSafeInteger(page) && page >= 0 ? page : 0;
  const currentPage = Math.min(requestedPage, Math.max(0, Math.ceil(filtered.length / 25) - 1));
  const pageRows = filtered.slice(currentPage * 25, (currentPage + 1) * 25);
  const full = await db.stockReservation.findMany({ where: { shop, locationId, id: { in: pageRows.map(row => row.id) } } });
  const ids = [...new Set(full.map(row => row.customerId).filter((id): id is string => Boolean(id)))];
  const customers = new Map<string, { displayName: string; phone?: string }>();
  if (ids.length) {
    const data = await reservationQuery(admin, `#graphql
      query ReservationCustomers($ids: [ID!]!) { nodes(ids: $ids) { ... on Customer { id displayName phone } } }`, { ids });
    for (const customer of data.nodes) if (customer) customers.set(customer.id, customer);
  }
  const mapped = await Promise.all(pageRows.map(meta => publicReservation(full.find(row => row.id === meta.id)!, admin, false, customers)));
  let today: string | null = null;
  try { const timezone = JSON.parse(process.env.RESERVATION_LOCATION_TIMEZONES || "{}")[shop]?.[locationId]; if (timezone) today = localDate(Date.now(), timezone); } catch { /* Without a configured zone, don't guess the store's date. */ }
  return { page: currentPage, today, availableDates: [...new Set(rows.map(row => row.dueDate))].sort(), rows: mapped, hasNextPage: filtered.length > (currentPage + 1) * 25, count: rows.filter(row => needsFollowUp(row)).length, total: filtered.length, allTotal: rows.length };
}
export async function reservationLocation(admin: ReservationAdmin, id: string) {
  const data = await reservationQuery(admin, `#graphql
    query ReservationLocation($id: ID!) { location(id: $id) { id name isActive } }`, { id });
  if (!data.location?.isActive) throw new Error("有効なPOS店舗を選択してください");
  return data.location as { id: string; name: string };
}
async function loadLines(admin: ReservationAdmin, locationId: string, requested: { variantId: string; quantity: number }[]) {
  const data = await reservationQuery(admin, `#graphql
    query ReservationVariants($ids: [ID!]!, $location: ID!) { nodes(ids: $ids) { ... on ProductVariant {
      id displayName sku barcode inventoryItem { id tracked inventoryLevel(locationId: $location) { quantities(names: ["available", "reserved"]) { name quantity } } }
    } } }`, { ids: requested.map(line => line.variantId), location: locationId });
  return requested.map(line => {
    const variant = data.nodes.find((v: { id?: string } | null) => v?.id === line.variantId);
    if (!variant?.inventoryItem?.tracked || !variant.inventoryItem.inventoryLevel) throw new Error("この店舗で在庫追跡している商品だけを取置できます");
    return { ...line, title: String(variant.displayName), sku: String(variant.sku || ""), barcode: String(variant.barcode || ""), inventoryItemId: String(variant.inventoryItem.id),
      quantities: Object.fromEntries(variant.inventoryItem.inventoryLevel.quantities.map((q: { name: string; quantity: number }) => [q.name, q.quantity])) as Record<string, number> };
  });
}
async function moveInput(admin: ReservationAdmin, row: StockReservation, reserve: boolean) {
  const lines = await loadLines(admin, row.locationId, row.lines as ReservationLine[]);
  const from = reserve ? "available" : "reserved";
  const to = reserve ? "reserved" : "available";
  const uri = `pos-stock://reservations/${row.id}`;
  return { reason: "correction", referenceDocumentUri: uri, changes: lines.map(line => {
    if (!Number.isInteger(line.quantities[from]) || line.quantities[from] < line.quantity) throw new Error(reserve ? "販売可能在庫が不足しています。数量を確認してください" : "確保在庫が不足しています。管理者が実在庫を確認してください");
    return { inventoryItemId: line.inventoryItemId, quantity: line.quantity,
      from: { locationId: row.locationId, name: from, changeFromQuantity: line.quantities[from], ...(from === "reserved" ? { ledgerDocumentUri: uri } : {}) },
      to: { locationId: row.locationId, name: to, changeFromQuantity: line.quantities[to], ...(to === "reserved" ? { ledgerDocumentUri: uri } : {}) } };
  }) };
}
export const RESERVATION_MOVE = `#graphql
mutation ReservationMove($input: InventoryMoveQuantitiesInput!, $key: String!) {
  inventoryMoveQuantities(input: $input) @idempotent(key: $key) {
    inventoryAdjustmentGroup { id }
    userErrors { field code message }
  }
}`;
async function beginMove(row: StockReservation, admin: ReservationAdmin, actor: string, pending: string, success: string, rejected: string) {
  const input = await moveInput(admin, row, pending === "reserving");
  const op: Operation = { key: randomUUID(), startedAt: new Date().toISOString(), input, success, rejected, actor };
  const result = await db.stockReservation.updateMany({ where: { id: row.id, shop: row.shop, status: row.status, version: row.version },
    data: { status: pending, operation: op as unknown as Prisma.InputJsonValue, lastError: null, version: { increment: 1 } } });
  if (result.count !== 1) throw new Error("ほかの端末が更新しました。一覧を更新してください");
  return resumeReservationMove(await getReservation(row.shop, row.locationId, row.id), admin);
}
export async function resumeReservationMove(row: StockReservation, admin: ReservationAdmin) {
  const op = row.operation as unknown as Operation | null;
  if (!op) return row;
  if (Date.now() - Date.parse(op.startedAt) >= 23 * 60 * 60 * 1000) throw new Error("確認中の操作から23時間を超えました。再送せず管理者がShopifyの在庫調整履歴を照合してください");
  let response;
  try {
    response = await admin.graphql(RESERVATION_MOVE, { variables: { input: op.input, key: op.key } });
    if (!response.ok) throw new Error("transport");
    const body = await response.json();
    if (body.errors?.length || !body.data?.inventoryMoveQuantities) throw new Error("unknown");
    const result = body.data.inventoryMoveQuantities;
    if (result.userErrors?.length) {
      // A definite business rejection is safe to leave; don't re-use a rejected key with new quantities.
      await db.stockReservation.updateMany({ where: { id: row.id, shop: row.shop, version: row.version },
        data: { status: op.rejected, operation: Prisma.DbNull, lastError: "在庫を変更できませんでした。他の販売・取置との競合または在庫不足です。更新して確認してください", version: { increment: 1 } } });
      return getReservation(row.shop, row.locationId, row.id);
    }
    if (!result.inventoryAdjustmentGroup?.id) throw new Error("unknown");
  } catch {
    await db.stockReservation.updateMany({ where: { id: row.id, shop: row.shop, version: row.version },
      data: { lastError: "在庫の反映を確認中です。同じ取置番号の「反映を確認」で再開してください" } });
    return getReservation(row.shop, row.locationId, row.id);
  }
  // Transactional status + audit. A DB failure leaves the same operation available for idempotent replay.
  await db.$transaction(async tx => {
    const changed = await tx.stockReservation.updateMany({ where: { id: row.id, shop: row.shop, version: row.version },
      data: { status: op.success, operation: Prisma.DbNull, lastError: null, version: { increment: 1 },
        ...(TERMINAL_RESERVATIONS.includes(op.success) ? { endedAt: new Date(), endedBy: op.actor } : {}) } });
    if (changed.count) await tx.stockReservationEvent.create({ data: { id: op.key, reservationId: row.id, kind: op.success, actor: op.actor } });
  });
  return getReservation(row.shop, row.locationId, row.id);
}
export async function createReservation(args: { shop: string; locationId: string; actor: string; admin: ReservationAdmin; input: Record<string, unknown> }) {
  const { shop, locationId, actor, admin, input } = args;
  const id = String(input.id || "");
  if (!/^R-[a-f0-9-]{36}$/.test(id)) throw new Error("登録番号が無効です。画面を開き直してください");
  const requested = normalizeReservationLines(input.lines);
  const requestHash = createHash("sha256").update(JSON.stringify({ lines: requested, customerId: input.customerId || null, name: String(input.name || "").trim(), phone: String(input.phone || "").trim(), timezone: input.timezone })).digest("hex");
  const existing = await db.stockReservation.findUnique({ where: { id } });
  if (existing) {
    if (existing.shop !== shop || existing.locationId !== locationId) throw new Error("登録番号が重複しています");
    // Never replace PII or quantities on a replay, especially after a response was lost.
    if (existing.requestHash !== requestHash) throw new Error("登録内容が変わっています。元の取置を確認してください");
    return existing.operation ? resumeReservationMove(existing, admin) : existing;
  }
  let timezone = "";
  try { timezone = String(JSON.parse(process.env.RESERVATION_LOCATION_TIMEZONES || "{}")[shop]?.[locationId] || ""); } catch { /* fail closed below */ }
  if (!timezone) throw new Error("店舗のタイムゾーンが未設定です。管理者に確認してください");
  const today = localDate(Date.now(), timezone); // Throws on invalid IANA zone; never assume server timezone.
  const location = await reservationLocation(admin, locationId);
  const lines = await loadLines(admin, locationId, requested);
  let customerId: string | null = null;
  let guestName: string | null = null;
  let contactPhone: string | null = String(input.phone || "").trim() || null;
  if (contactPhone && (!/^[+\d\s()ー-]{6,40}$/.test(contactPhone) || contactPhone.replace(/\D/g, "").length < 6)) throw new Error("連絡用電話番号を確認してください");
  if (input.customerId) {
    customerId = String(input.customerId);
    if (!/^gid:\/\/shopify\/Customer\/\d+$/.test(customerId)) throw new Error("POSで顧客を選択してください");
    const data = await reservationQuery(admin, `#graphql
      query ReservationCustomerContact($id: ID!) { customer(id: $id) { id phone } }`, { id: customerId });
    if (!data.customer || (!data.customer.phone && !contactPhone)) throw new Error("取置用の連絡先を入力してください");
    if (data.customer.phone) contactPhone = null;
  } else {
    guestName = String(input.name || "").trim();
    if (!guestName || guestName.length > 100 || !contactPhone) throw new Error("ゲストのお名前と連絡用電話番号を入力してください");
  }
  const settings = await db.stockReservationSettings.findUnique({ where: { shop } });
  const data = { id, requestHash, shop, locationId, locationName: location.name, timezone, status: "reserving", customerId, guestName, contactPhone,
    lines: lines.map(line => ({ variantId: line.variantId, inventoryItemId: line.inventoryItemId, title: line.title, sku: line.sku, barcode: line.barcode, quantity: line.quantity })), dueDate: addDays(today, settings?.days ?? 7), createdBy: actor };
  // Materialize exact input before inserting, so there's never a row eligible for two different reserve operations.
  const provisional = { ...data, version: 1 } as unknown as StockReservation;
  const operation: Operation = { key: randomUUID(), startedAt: new Date().toISOString(), input: await moveInput(admin, provisional, true), success: "held", rejected: "failed", actor };
  try {
    const row = await db.stockReservation.create({ data: { ...data, operation: operation as unknown as Prisma.InputJsonValue } });
    return resumeReservationMove(row, admin);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return createReservation(args);
    }
    throw error;
  }
}
export async function reservationCommand(row: StockReservation, admin: ReservationAdmin, actor: string, input: Record<string, unknown>) {
  const command = String(input.command);
  if (command === "resume") return resumeReservationMove(row, admin);
  // A lost claim response leaves the client holding its old held/version snapshot.
  // Recognize the already committed same-cart claim before checking that stale version.
  if (command === "checkout" && row.status === "checkout" && row.checkoutKey === String(input.checkoutKey || "") && row.checkoutDevice === String(input.deviceId || "")) {
    return getReservation(row.shop, row.locationId, row.id);
  }
  if (Number(input.version) !== row.version) throw (command === "checkout" ? new ReservationCheckoutRejected("ほかの端末が更新しました。明細を開き直してください") : new Error("ほかの端末が更新しました。明細を開き直してください"));
  if (command === "cancel") {
    if (row.status !== "held") throw new Error("会計中または確認中の取置は解除できません。注文を確認してください");
    return beginMove(row, admin, actor, "cancelling", "cancelled", "held");
  }
  if (command === "checkout") {
    if (row.status !== "held" && row.status !== "checkout") throw new ReservationCheckoutRejected("この取置は会計へ進めません");
    const checkoutKey = String(input.checkoutKey || "");
    if (!/^[a-f0-9-]{36}$/.test(checkoutKey)) throw new ReservationCheckoutRejected("会計の確認番号がありません。同じカートから再開してください");
    if (row.status === "checkout" && row.checkoutKey !== checkoutKey) throw new ReservationCheckoutRejected("別の会計が進行中です");
    if (row.status === "held") {
      const result = await db.stockReservation.updateMany({ where: { id: row.id, shop: row.shop, version: row.version, status: "held" },
        data: { status: "checkout", checkoutKey, checkoutBy: actor, checkoutDevice: String(input.deviceId || ""), version: { increment: 1 } } });
      if (!result.count) throw new ReservationCheckoutRejected("ほかの端末で会計を開始しました");
    }
    return getReservation(row.shop, row.locationId, row.id);
  }
  if (command === "complete") {
    if (row.status !== "checkout") throw new Error("会計中の取置だけを照合できます");
    const orderId = String(input.orderId || "");
    if (!/^gid:\/\/shopify\/Order\/\d+$/.test(orderId)) throw new Error("POSの注文番号から注文を選択してください");
    const data = await reservationQuery(admin, `#graphql
      query ReservationOrder($id: ID!) { order(id: $id) {
        id cancelledAt displayFinancialStatus displayFulfillmentStatus sourceName retailLocation { id } customer { id }
        fulfillments { location { id } fulfillmentLineItems(first: 250) { nodes { quantity lineItem { variant { id } } } pageInfo { hasNextPage } } }
        customAttributes { key value } refunds { id }
        lineItems(first: 250) { nodes { variant { id } quantity currentQuantity } pageInfo { hasNextPage } }
      } }`, { id: orderId });
    assertOrderMatches({ ...row, lines: row.lines as ReservationLine[] }, data.order);
    // Persist order claim with CAS before moving reserved stock; two orders cannot finish the same hold.
    const claimed = await db.stockReservation.updateMany({ where: { id: row.id, shop: row.shop, version: row.version, status: "checkout" }, data: { orderId, version: { increment: 1 } } });
    if (!claimed.count) throw new Error("ほかの端末が更新しました");
    return beginMove(await getReservation(row.shop, row.locationId, row.id), admin, actor, "completing", "sold", "checkout");
  }
  if (command === "unreachable" || command === "planned") {
    if (row.status !== "held") throw new Error("取置中の案件だけに対応を記録できます");
    const nextFollowDate = command === "planned" ? String(input.followDate || "") : null;
    if (nextFollowDate && (!validDate(nextFollowDate) || nextFollowDate <= localDate(Date.now(), row.timezone))) throw new Error("次回確認日は明日以降を指定してください");
    if (command === "planned" && !nextFollowDate) throw new Error("次回確認日を指定してください");
    await db.$transaction(async tx => {
      const updated = await tx.stockReservation.updateMany({ where: { id: row.id, shop: row.shop, version: row.version }, data: { nextFollowDate, version: { increment: 1 } } });
      if (!updated.count) throw new Error("ほかの端末が更新しました");
      await tx.stockReservationEvent.create({ data: { id: randomUUID(), reservationId: row.id, actor, kind: command, followDate: nextFollowDate } });
    });
    return getReservation(row.shop, row.locationId, row.id);
  }
  throw new Error("操作を確認してください");
}
export async function reconcileReservationOrder(admin: ReservationAdmin, shop: string, orderId: string, reservationId: string) {
  const row = await db.stockReservation.findFirst({ where: { shop, id: reservationId } });
  if (!row || row.status === "sold") return;
  if (row.status === "completing" && row.orderId === orderId) {
    const updated = await resumeReservationMove(row, admin);
    if (updated.status !== "sold") throw new Error("取置の販売反映を確認中です");
    return;
  }
  if (row.status !== "checkout") return;
  const updated = await reservationCommand(row, admin, row.checkoutBy || "Shopify注文照合", { command: "complete", version: row.version, orderId });
  if (updated.status !== "sold") throw new Error("取置の販売反映を確認中です");
}
