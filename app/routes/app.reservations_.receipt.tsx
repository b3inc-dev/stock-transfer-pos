import { useEffect, useMemo, useRef, useState } from "react";
import { Form, data, useActionData, useLoaderData, useNavigation } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { adminPlanRedirect } from "../utils/plan-gate.server";
import { reservationsEnabled } from "../utils/reservations.server";
import { normalizeReservationReceipt, renderReservationReceipt } from "../../extensions/common/reservationReceipt.js";
import { AdminBlock, BackAction, SaveBar, StatusBanner } from "../components/admin-ui";
import { ReservationNav } from "../components/ReservationNav";

export async function loader({ request }: LoaderFunctionArgs) {
  if (!reservationsEnabled()) throw new Response("Not found", { status: 404 });
  const { session } = await authenticate.admin(request);
  const saved = await db.stockReservationSettings.findUnique({ where: { shop: session.shop } });
  return data({ layout: normalizeReservationReceipt(saved?.receiptLayout), version: saved?.receiptVersion ?? 0 }, { headers: { "Cache-Control": "private, no-store" } });
}
export async function action({ request }: ActionFunctionArgs) {
  if (!reservationsEnabled()) throw new Response("Not found", { status: 404 });
  const { session, admin } = await authenticate.admin(request);
  const blocked = await adminPlanRedirect(request, admin, session.shop, "reservation");
  if (blocked) return blocked;
  try {
    const form = await request.formData();
    const raw = String(form.get("layout") || "");
    if (raw.length > 12000) throw new Error("設定の入力文字数を確認してください");
    const layout = normalizeReservationReceipt(JSON.parse(raw), true);
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
const sample = { id: "R-SAMPLE-001", locationName: "サンプル店舗", timezone: "Asia/Tokyo", createdAt: "2026-11-25T01:00:00Z", dueDate: "2026-12-02", createdBy: "サンプル担当", lines: [{ title: "サンプル商品 / ブルー / M", quantity: 2, sku: "SAMPLE-001", barcode: "1234567890123" }] };
export default function ReservationReceipt() {
  const initial = useLoaderData<typeof loader>();
  return <ReceiptEditor initial={initial} />;
}
function ReceiptEditor({ initial }: { initial: { layout: ReturnType<typeof normalizeReservationReceipt>; version: number } }) {
  const [layout, setLayout] = useState(initial.layout);
  const [version, setVersion] = useState(initial.version);
  const baseline = useRef(initial.layout);
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  useEffect(() => { if (result?.ok && "layout" in result) { baseline.current = result.layout; setVersion(result.version); } }, [result]);
  const html = useMemo(() => renderReservationReceipt(sample, layout), [layout]);
  const text = (name: keyof typeof layout, label: string, maxLength = 200) => <label className="Admin-control">{label}<input className="Admin-input" name={name} value={String(layout[name])} maxLength={maxLength} disabled={busy} onChange={event => setLayout(previous => ({ ...previous, [name]: event.target.value }))} /></label>;
  const check = (name: keyof typeof layout, label: string) => <label className="Admin-control"><input type="checkbox" name={name} checked={Boolean(layout[name])} disabled={busy} onChange={event => setLayout(previous => ({ ...previous, [name]: event.target.checked }))} /> {label}</label>;
  const select = (name: keyof typeof layout, label: string, options: [string, string][]) => <label className="Admin-control">{label}<select className="Admin-select" name={name} value={String(layout[name])} disabled={busy} onChange={event => { const value = event.target.value; setLayout(previous => ({ ...previous, [name]: ["paperWidth", "fontSize"].includes(name) ? Number(value) : value })); }}>{options.map(([value, title]) => <option key={value} value={value}>{title}</option>)}</select></label>;
  return <s-page heading="取置レシート"><BackAction to="/app/reservations" label="取置へ戻る" /><div className="Admin-body"><ReservationNav selected="receipt" />
    {result?.error ? <StatusBanner tone="critical" heading="レシート設定を保存できませんでした">{result.error}</StatusBanner> : null}
    <Form method="post"><SaveBar status={result?.ok ? result.saved : undefined} failed={!busy && result?.ok === false} onDiscard={() => setLayout(baseline.current)} />
      <input type="hidden" name="layout" value={JSON.stringify(layout)} /><input type="hidden" name="version" data-not-form-value value={version} />
      <AdminBlock title="発行する控え" description="1つ以上選んでください。両方選ぶと、用途を明記した2ページを1回の印刷で送ります。実際の紙送り・カットはプリンターで確認してください。">
        {check("customerCopy", "お客様お渡し用")}{check("storeCopy", "店舗保管用")}
      </AdminBlock>
      <AdminBlock title="テンプレート" description="取置控えの名前とロゴを設定します。">
        {text("templateName", "テンプレート名")}{text("logoUrl", "ロゴ画像URL（HTTPS）", 2048)}
      </AdminBlock>
      <AdminBlock title="店舗・発行者" description="店舗の情報を設定します。顧客の氏名・電話番号と金額は印字しません。">
        {text("companyName", "会社名・店舗名")}{text("postalCode", "郵便番号")}{text("address", "住所1")}{text("address2", "住所2")}{text("phone", "店舗の電話番号")}
      </AdminBlock>
      <AdminBlock title="表示項目" description="取置番号・受取期限・商品と数量は必ず印字します。SKU/JANは設定追加後に登録した商品の記録が対象です。">
        {check("showIssueDate", "受付日")}{check("showLocationName", "店舗名")}{check("showStaff", "担当番号")}{check("showSku", "SKU")}{check("showBarcode", "JAN")}
      </AdminBlock>
      <AdminBlock title="用紙・文字" description="用紙幅と文字の大きさ・間隔を設定します。">
        {select("paperWidth", "用紙幅", [["58", "58mm"], ["80", "80mm"]])}{select("fontSize", "文字サイズ", [["12", "小"], ["14", "標準"], ["16", "大"]])}
        {select("bodySpacing", "本文の間隔", [["compact", "狭い"], ["normal", "標準"], ["relaxed", "広い"]])}
      </AdminBlock>
      <AdminBlock title="配置" description="POS Receiptと同様に、見出し・ロゴ・店舗情報の位置を編集できます。">
        {select("headerAlignment", "見出しの揃え", [["left", "左"], ["center", "中央"], ["right", "右"]])}{select("logoPosition", "ロゴの位置", [["top", "見出しの上"], ["inline", "見出しの横"]])}
        {select("companyInfoPosition", "店舗情報の位置", [["top", "上"], ["bottom", "下"]])}
      </AdminBlock>
      <AdminBlock title="文言" description="見出しと末尾のメッセージを設定します。">
        {text("receiptTitle", "レシートタイトル")}
        <label className="Admin-control">末尾のメッセージ<textarea className="Admin-input" name="footerNote" maxLength={1000} value={layout.footerNote} disabled={busy} onChange={event => setLayout(previous => ({ ...previous, footerNote: event.target.value }))} /></label>
      </AdminBlock>
    </Form>
    <AdminBlock wide title="印刷プレビュー" description="サンプルデータを使用しています。保存前の編集内容を、実際の印刷と同じ処理で表示します。">
      <iframe title="取置レシートのプレビュー" sandbox="" srcDoc={html} style={{ width: "100%", maxWidth: layout.paperWidth === 58 ? 410 : 602, height: 800, border: "1px solid #e1e3e5", background: "white" }} />
    </AdminBlock>
  </div></s-page>;
}
