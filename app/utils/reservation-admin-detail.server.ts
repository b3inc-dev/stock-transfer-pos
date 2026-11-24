import type { Prisma } from "@prisma/client";
import { maskPhone, RESERVATION_LABELS } from "../../extensions/common/reservations.js";
import { reservationAccountAccess, reservationQuery, type ReservationAdmin } from "./reservations.server";

export const reservationDetailSelect = {
  id: true, status: true, locationId: true, locationName: true, timezone: true,
  customerId: true, guestName: true, contactPhone: true, anonymizedAt: true,
  lines: true, dueDate: true, nextFollowDate: true, createdAt: true, createdBy: true,
  checkoutBy: true, endedAt: true, endedBy: true, orderId: true, lastError: true,
} as const satisfies Prisma.StockReservationSelect;
export const reservationEventSelect = { id: true, kind: true, actor: true, followDate: true, createdAt: true } as const;
type DetailRecord = Prisma.StockReservationGetPayload<{ select: typeof reservationDetailSelect }> & {
  events: { id: string; kind: string; actor: string; followDate: string | null; createdAt: Date }[];
};
const EVENT_LABELS: Record<string, string> = { held: "取置登録", sold: "販売完了", cancelled: "キャンセル", unreachable: "不通", planned: "来店予定" };
export function reservationStatusTone(status: string): "success" | "info" | "neutral" | "warning" | "critical" {
  if (status === "held" || status === "sold") return "success";
  if (status === "cancelled") return "neutral";
  if (status === "failed") return "critical";
  return status === "checkout" ? "info" : "warning";
}
function dateTime(value: Date | null) {
  if (!value) return "—";
  const parts = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(value));
  const part = (type: string) => parts.find(item => item.type === type)?.value || "";
  return `${part("year")}/${part("month")}/${part("day")} ${part("hour")}:${part("minute")}`;
}
function actorLabel(value: string | null) {
  if (!value) return "—";
  if (value === "Shopify注文照合") return "注文の自動照合";
  const pos = value.match(/^(\d+) \/ POS担当 (\d+|未取得)$/);
  if (pos) return pos[2] === "未取得" ? `ログイン担当番号 ${pos[1]}` : `POS担当番号 ${pos[2]}`;
  if (/^\d+$/.test(value)) return `ログイン担当番号 ${value}`;
  return "担当者名を取得できません";
}
export function reservationFilterQuery(url: URL) {
  const result = new URLSearchParams();
  for (const value of new Set(url.searchParams.getAll("locations"))) if (/^gid:\/\/shopify\/Location\/\d+$/.test(value)) result.append("locations", value);
  for (const value of new Set(url.searchParams.getAll("statuses"))) if (Object.hasOwn(RESERVATION_LABELS, value)) result.append("statuses", value);
  if (url.searchParams.get("sort") === "asc") result.set("sort", "asc");
  return result.size ? `&${result}` : "";
}
export function reservationListState(url: URL) {
  const page = Number(url.searchParams.get("page"));
  const history = Number(url.searchParams.get("historyPage"));
  return {
    ended: url.searchParams.get("ended") === "1",
    page: Number.isSafeInteger(page) && page >= 0 && page <= 1000000 ? page : 0,
    historyPage: Number.isSafeInteger(history) && history >= 0 && history <= 1000000 ? history : 0,
  };
}
export async function reservationAdminDetail(args: { row: DetailRecord; shop: string; subject: string; admin: ReservationAdmin }) {
  const { row, shop, subject, admin } = args;
  const access = subject ? reservationAccountAccess(shop, subject) : null;
  const reveal = Boolean(access?.contact && access.locations.includes(row.locationId));
  let name = row.guestName || "ゲスト";
  let phone = row.contactPhone || "";
  const warnings: string[] = [];
  if (row.anonymizedAt) { name = "匿名化済み"; phone = ""; }
  else if (row.customerId) {
    try {
      const data = await reservationQuery(admin, `#graphql
        query ReservationAdminCustomer($id: ID!) { customer(id: $id) { displayName phone } }`, { id: row.customerId });
      name = data.customer?.displayName || "顧客情報を取得できません";
      phone = phone || data.customer?.phone || "";
      if (!data.customer) warnings.push("顧客が削除されているか、顧客情報を読み取れません。取置の商品と履歴は確認できます。");
    } catch {
      name = "顧客情報を取得できません";
      warnings.push("顧客情報を取得できません。顧客の読み取り権限と通信状態を確認してください。");
    }
  }
  let order: { href: string; label: string } | null = null;
  const orderNumber = row.orderId?.match(/^gid:\/\/shopify\/Order\/(\d+)$/)?.[1];
  if (orderNumber && row.status === "sold" && /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop)) {
    order = { href: `https://admin.shopify.com/store/${shop.replace(/\.myshopify\.com$/i, "")}/orders/${orderNumber}`, label: "注文を見る" };
    try {
      const data = await reservationQuery(admin, `#graphql
        query ReservationAdminOrder($id: ID!) { order(id: $id) { name } }`, { id: row.orderId });
      if (data.order?.name) order.label = `注文 ${String(data.order.name)}を見る`;
      else warnings.push("注文名を取得できません。注文画面で確認してください。");
    } catch { warnings.push("注文名を取得できません。注文の読み取り権限と通信状態を確認してください。"); }
  }
  const lines: { title: string; quantity: number }[] = [];
  const rawLines = Array.isArray(row.lines) ? row.lines : [];
  for (const item of rawLines) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    if (typeof item.title === "string" && typeof item.quantity === "number" && Number.isSafeInteger(item.quantity) && item.quantity > 0) lines.push({ title: item.title, quantity: item.quantity });
  }
  if (!lines.length || lines.length !== rawLines.length) warnings.push("商品明細の一部を読み取れません。POSの取置内容を確認してください。");
  // Explicit view model: raw contacts, persisted mutation input and checkout keys never reach unauthorized browsers.
  return {
    id: row.id, locationName: row.locationName,
    statusLabel: RESERVATION_LABELS[row.status as keyof typeof RESERVATION_LABELS] || "要確認", statusTone: reservationStatusTone(row.status),
    dueDate: row.dueDate, nextFollowDate: row.nextFollowDate || "—", createdAt: dateTime(row.createdAt), createdBy: actorLabel(row.createdBy),
    checkoutBy: actorLabel(row.checkoutBy), endedAt: dateTime(row.endedAt), endedBy: actorLabel(row.endedBy),
    name, phone: row.anonymizedAt ? "削除済み" : reveal ? phone || "—" : maskPhone(phone), contactVisible: reveal && !row.anonymizedAt,
    anonymized: Boolean(row.anonymizedAt), lines, totalQuantity: lines.reduce((sum, line) => sum + line.quantity, 0), order,
    events: row.events.slice(0, 25).map(event => ({ id: event.id, label: EVENT_LABELS[event.kind] || "対応記録", actor: actorLabel(event.actor), at: dateTime(event.createdAt), followDate: event.followDate || "—" })),
    hasNextHistory: row.events.length > 25,
    notice: row.lastError ? { heading: "在庫の反映を確認してください", message: row.lastError, tone: "warning" as const }
      : warnings.length ? { heading: "一部の情報を取得できませんでした", message: warnings.join(" "), tone: "warning" as const } : null,
  };
}
