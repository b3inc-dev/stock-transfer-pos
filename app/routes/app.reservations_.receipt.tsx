import { AppProvider as PolarisAppProvider } from "@shopify/polaris";
import ja from "@shopify/polaris/locales/ja.json";
import { useEffect, useRef, useState } from "react";
import { Form, data, useActionData, useLoaderData, useNavigation } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { adminPlanRedirect } from "../utils/plan-gate.server";
import { reservationsEnabled } from "../utils/reservations.server";
import { normalizeReservationReceiptSettings, reservationSampleData, type ReservationReceiptSettings } from "../services/reservationReceiptLayout";
import { ReceiptLayoutEditor } from "../components/ReceiptLayoutEditor";
import { PRINTER_PROFILE_OPTIONS, type ReceiptPrinterProfile } from "../services/receiptPrinterProfile";
import { AdminBlock, BackAction, SaveBar, StatusBanner, SectionTabs } from "../components/admin-ui";
import { ReservationNav } from "../components/ReservationNav";

export async function loader({ request }: LoaderFunctionArgs) {
  if (!reservationsEnabled()) throw new Response("Not found", { status: 404 });
  const { session } = await authenticate.admin(request);
  const saved = await db.stockReservationSettings.findUnique({ where: { shop: session.shop } });
  return data({ layout: normalizeReservationReceiptSettings(saved?.receiptLayout), version: saved?.receiptVersion ?? 0 }, { headers: { "Cache-Control": "private, no-store" } });
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
export default function ReservationReceipt() {
  const initial = useLoaderData<typeof loader>();
  return <PolarisAppProvider i18n={ja}><ReceiptEditor initial={initial} /></PolarisAppProvider>;
}
function ReceiptEditor({ initial }: { initial: { layout: ReservationReceiptSettings; version: number } }) {
  const [layout, setLayout] = useState(initial.layout);
  const [editorInitial, setEditorInitial] = useState(initial.layout);
  const [copy, setCopy] = useState<"customer" | "store">("customer");
  const [version, setVersion] = useState(initial.version);
  const baseline = useRef(initial.layout);
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  useEffect(() => { if (result?.ok && "layout" in result) { baseline.current = result.layout; setVersion(result.version); } }, [result]);
  const discard = () => { setLayout(baseline.current); setEditorInitial(baseline.current); };
  return <s-page heading="取置レシート"><BackAction to="/app/reservations" label="取置へ戻る" /><div className="Admin-body"><ReservationNav selected="receipt" />
    {result?.error ? <StatusBanner tone="critical" heading="レシート設定を保存できませんでした">{result.error}</StatusBanner> : null}
    <Form method="post"><SaveBar status={result?.ok ? result.saved : undefined} failed={!busy && result?.ok === false} onDiscard={discard} />
      <input type="hidden" name="layout" value={JSON.stringify(layout)} /><input type="hidden" name="version" data-not-form-value value={version} />
      <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <AdminBlock title="発行する控え" description="お客様控えは登録後に印刷します。店舗控えは登録後の詳細画面から印刷できます。1つ以上選んでください。">
          <label className="Admin-control"><input type="checkbox" checked={layout.customerCopy} onChange={event => setLayout(previous => ({ ...previous, customerCopy: event.target.checked }))} /> お客様お渡し用</label>
          <label className="Admin-control"><input type="checkbox" checked={layout.storeCopy} onChange={event => setLayout(previous => ({ ...previous, storeCopy: event.target.checked }))} /> 店舗保管用</label>
          <label className="Admin-control">プリンター補正<select className="Admin-select" value={layout.printerProfile} onChange={event => setLayout(previous => ({ ...previous, printerProfile: event.target.value as ReceiptPrinterProfile }))}>{PRINTER_PROFILE_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          <p>58mm・80mmの用紙別に見た目を保存できます。実際の紙送り・カット・補正は利用するプリンターで確認してください。顧客の氏名・電話番号と金額は印字しません。</p>
        </AdminBlock>
        <SectionTabs label="編集する控え" items={[{ key: "customer", label: "お客様お渡し用" }, { key: "store", label: "店舗保管用" }]} selected={copy} onSelect={value => setCopy(value as "customer" | "store")} />
        <p>左側でブロック・見た目・Liquidコードを編集し、右側で印刷と同じ処理のプレビューを確認できます。取置番号・受取期限・控えの用途・商品と数量は、編集できない必須欄として下部にも印字します。</p>
        {(["customer", "store"] as const).map(key => <div key={key} hidden={copy !== key}>
          <ReceiptLayoutEditor kind="reservation" initial={editorInitial[key]} active={copy === key} printerProfile={layout.printerProfile} sampleData={reservationSampleData(key)} onLayoutChange={value => setLayout(previous => ({ ...previous, [key]: value }))} />
        </div>)}
      </fieldset>
    </Form>
  </div></s-page>;
}
