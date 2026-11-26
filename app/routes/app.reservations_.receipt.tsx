import { data, redirect } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { adminPlanRedirect } from "../utils/plan-gate.server";
import { reservationsEnabled } from "../utils/reservations.server";
import { normalizeReservationReceiptSettings } from "../services/reservationReceiptLayout";

export async function loader({ request }: LoaderFunctionArgs) {
  if (!reservationsEnabled()) throw new Response("Not found", { status: 404 });
  await authenticate.admin(request);
  const params = new URLSearchParams();
  const old = new URL(request.url).searchParams;
  for (const key of ["shop", "host", "embedded"]) if (old.has(key)) params.set(key, old.get(key)!);
  params.set("tab", "customer");
  return redirect("/app/receipts?" + params);
}
export async function action({ request }: ActionFunctionArgs) {
  if (!reservationsEnabled()) throw new Response("Not found", { status: 404 });
  const { session, admin } = await authenticate.admin(request);
  const blocked = await adminPlanRedirect(request, admin, session.shop, "reservation");
  if (blocked) return blocked;
  try {
    const form = await request.formData();
    const raw = String(form.get("layout") || "");
    if (raw.length > 650000) throw new Error("設定の入力文字数を確認してください");
    const layout = normalizeReservationReceiptSettings(JSON.parse(raw), true);
    const version = Number(form.get("version"));
    if (!Number.isSafeInteger(version) || version < 0) throw new Error("画面を更新してから保存してください");
    const changed = await db.$transaction(async tx => {
      await tx.stockReservationSettings.upsert({ where: { shop: session.shop }, create: { shop: session.shop }, update: {} });
      return tx.stockReservationSettings.updateMany({ where: { shop: session.shop, receiptVersion: version }, data: { receiptLayout: layout, receiptVersion: { increment: 1 } } });
    });
    if (!changed.count) return data({ ok: false as const, saved: 0, error: "別の画面で変更されています。入力内容を控えてから画面を更新してください" }, { status: 409 });
    return data({ ok: true as const, saved: Date.now(), error: "", version: version + 1, layout });
  } catch (error) {
    const message = error instanceof Error && /[\u3040-\u30ff\u4e00-\u9fff]/.test(error.message) ? error.message : "レシート設定を保存できませんでした。入力を確認してもう一度お試しください";
    return data({ ok: false as const, saved: 0, error: message }, { status: 400 });
  }
}
export default function ReservationReceipt() { return null; }
