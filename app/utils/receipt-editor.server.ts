import { authenticate } from "../shopify.server";
import db from "../db.server";
import { checkShopFeatureAccess } from "./shop-plan.server";
import { reservationsEnabled } from "./reservations.server";
import { outboundRequestsEnabled } from "./outbound-requests.server";
import { normalizeReservationReceiptSettings } from "../services/reservationReceiptLayout";
import { normalizeOutboundReceiptSettings } from "../services/outboundRequestReceipt";
import { DEFAULT_OUTBOUND_REQUEST_POLICY } from "../../extensions/common/outboundRequests.js";
import { redirect } from "react-router";
export async function receiptEditorContext(request: Request) {
  const reservationEnabled = reservationsEnabled(), outboundEnabled = outboundRequestsEnabled();
  if (!reservationEnabled && !outboundEnabled) throw new Response("Not found", { status: 404 });
  const { session, admin } = await authenticate.admin(request);
  const check = async (feature: "reservation" | "outboundRequest", enabled: boolean) => enabled && (await checkShopFeatureAccess({ shop: session.shop, feature, getAdmin: () => admin })).access === "allowed";
  const [reservation, outbound] = await Promise.all([check("reservation", reservationEnabled), check("outboundRequest", outboundEnabled)]);
  if (!reservation && !outbound) throw redirect("/app/plan?required=" + (reservationEnabled ? "reservation" : "outboundRequest"));
  return { shop: session.shop, reservation, outbound };
}
export async function loadReceiptEditor(context: { shop: string; reservation: boolean; outbound: boolean }) {
  const [reservation, outbound] = await Promise.all([
    context.reservation ? db.stockReservationSettings.findUnique({ where: { shop: context.shop } }) : null,
    context.outbound ? db.outboundRequestSettings.findUnique({ where: { shop: context.shop } }) : null,
  ]);
  return { reservation: context.reservation ? normalizeReservationReceiptSettings(reservation?.receiptLayout) : null,
    outbound: context.outbound ? normalizeOutboundReceiptSettings(outbound?.receiptLayout, outbound?.policy) : null,
    reservationVersion: reservation?.receiptVersion ?? 0, outboundVersion: outbound?.receiptVersion ?? 0 };
}
export async function saveReceiptEditor(context: { shop: string; reservation: boolean; outbound: boolean }, raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("レシート設定を確認してください");
  const input = raw as Record<string, unknown>;
  if ((!context.reservation && input.reservation != null) || (!context.outbound && input.outbound != null)) throw new Error("このレシートを編集する権限がありません");
  const reservation = context.reservation ? normalizeReservationReceiptSettings(input.reservation, true) : null;
  const outbound = context.outbound ? normalizeOutboundReceiptSettings(input.outbound) : null;
  if (context.reservation && input.reservation == null || context.outbound && input.outbound == null) throw new Error("レシート設定がありません。画面を読み直してください");
  const reservationVersion = input.reservationVersion as number, outboundVersion = input.outboundVersion as number;
  if ((context.reservation && (!Number.isSafeInteger(reservationVersion) || reservationVersion < 0)) || (context.outbound && (!Number.isSafeInteger(outboundVersion) || outboundVersion < 0))) throw new Error("画面を読み直してから保存してください");
  const json = (value: unknown) => JSON.parse(JSON.stringify(value));
  const conflict = () => new Error("別の画面で変更されています。入力内容を控えてから画面を更新してください");
  await db.$transaction(async tx => {
    if (reservation) {
      await tx.stockReservationSettings.upsert({ where: { shop: context.shop }, create: { shop: context.shop }, update: {} });
      const changed = await tx.stockReservationSettings.updateMany({ where: { shop: context.shop, receiptVersion: reservationVersion }, data: { receiptLayout: json(reservation), receiptVersion: { increment: 1 } } });
      if (!changed.count) throw conflict();
    }
    if (outbound) {
      await tx.outboundRequestSettings.upsert({ where: { shop: context.shop }, create: { shop: context.shop, policy: json(DEFAULT_OUTBOUND_REQUEST_POLICY) }, update: {} });
      const changed = await tx.outboundRequestSettings.updateMany({ where: { shop: context.shop, receiptVersion: outboundVersion }, data: { receiptLayout: json(outbound), receiptVersion: { increment: 1 } } });
      if (!changed.count) throw conflict();
    }
  });
  return { reservation, outbound, reservationVersion: reservation ? reservationVersion + 1 : 0, outboundVersion: outbound ? outboundVersion + 1 : 0 };
}
