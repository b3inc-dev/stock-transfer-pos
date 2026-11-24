import { randomUUID } from "node:crypto";
import type { StockReservation } from "@prisma/client";
import db from "../db.server";
import { normalizeCustomerPhone } from "../../extensions/common/customerPhone.js";
import { getReservation, reservationQuery, type ReservationAdmin } from "./reservations.server";
import { withGraphQLRetry } from "./graphql-with-retry";

export async function customerPhoneWriteAllowed(admin: ReservationAdmin) {
  const data = await reservationQuery(withGraphQLRetry(admin), `#graphql
    query ReservationCustomerPhoneScopes { currentAppInstallation { accessScopes { handle } } }`);
  return data.currentAppInstallation?.accessScopes?.some((scope: { handle: string }) => scope.handle === "write_customers") === true;
}
async function settle(row: StockReservation, state: string, actor: string) {
  await db.$transaction(async tx => {
    const result = await tx.stockReservation.updateMany({ where: { id: row.id, shop: row.shop, locationId: row.locationId, customerPhoneSaveState: row.customerPhoneSaveState, anonymizedAt: null }, data: { customerPhoneSaveState: state } });
    if (result.count && row.customerPhoneSaveState !== state) await tx.stockReservationEvent.create({ data: { id: randomUUID(), reservationId: row.id, actor, kind: `customer_phone_${state}` } });
  });
  return getReservation(row.shop, row.locationId, row.id);
}
/** Never replay an ambiguous write: saving/unknown states are verification-only. */
export async function saveReservationCustomerPhone(row: StockReservation, admin: ReservationAdmin, actor: string) {
  if (!row.customerPhoneSaveState || row.customerPhoneSaveState === "saved") return row;
  if (!row.customerId || !row.contactPhone || row.anonymizedAt || !["held", "checkout"].includes(row.status)) throw new Error("この取置から顧客の電話番号を登録できません");
  const desired = normalizeCustomerPhone(row.contactPhone);
  const readPhone = async () => {
    const data = await reservationQuery(withGraphQLRetry(admin), `#graphql
      query ReservationCustomerPhoneCheck($id: ID!) { customer(id: $id) { id phone } }`, { id: row.customerId });
    if (data.customer?.id !== row.customerId) throw new Error("お客様の登録情報を確認できません");
    if (!data.customer.phone) return "empty";
    try { return normalizeCustomerPhone(data.customer.phone) === desired ? "same" : "different"; } catch { return "different"; }
  };
  const existing = await readPhone();
  if (existing === "same") return settle(row, "saved", actor);
  if (existing === "different") return settle(row, "conflict", actor);
  if (!["pending", "failed"].includes(row.customerPhoneSaveState)) return row;
  const claimed = await db.stockReservation.updateMany({ where: { id: row.id, shop: row.shop, locationId: row.locationId, customerPhoneSaveState: row.customerPhoneSaveState, anonymizedAt: null, status: { in: ["held", "checkout"] } }, data: { customerPhoneSaveState: "saving" } });
  if (!claimed.count) return getReservation(row.shop, row.locationId, row.id);
  const saving = { ...row, customerPhoneSaveState: "saving" };
  try {
    // Recheck after the DB claim. Shopify 2026-01 has no atomic "phone is empty" condition;
    // a simultaneous change outside this app between this read and the write cannot be locked.
    const latest = await readPhone();
    if (latest === "same") return settle(saving, "saved", actor);
    if (latest === "different") return settle(saving, "conflict", actor);
    // Raw Admin client: no transport/503 automatic retries for this non-idempotent mutation.
    const response = await admin.graphql(`mutation ReservationCustomerPhoneSave($input: CustomerInput!) { customerUpdate(input: $input) { customer { id phone } userErrors { field message } } }`, { variables: { input: { id: row.customerId, phone: desired } } });
    const body = await response.json();
    if (response.ok && !body.errors?.length && body.data?.customerUpdate?.userErrors?.length) return settle(saving, "failed", actor);
    const result = body.data?.customerUpdate?.customer;
    if (response.ok && !body.errors?.length && result?.id === row.customerId && normalizeCustomerPhone(result.phone) === desired) return settle(saving, "saved", actor);
  } catch { /* Never expose GraphQL bodies, phone numbers or raw transport errors. */ }
  try { if (await readPhone() === "same") return settle(saving, "saved", actor); } catch { /* Result remains unknown. */ }
  return settle(saving, "unknown", actor);
}
