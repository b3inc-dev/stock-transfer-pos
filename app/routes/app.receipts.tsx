import { AppProvider as PolarisAppProvider } from "@shopify/polaris";
import ja from "@shopify/polaris/locales/ja.json";
import { useEffect, useRef, useState } from "react";
import { Form, data, useActionData, useLoaderData, useNavigation } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { receiptEditorContext, loadReceiptEditor, saveReceiptEditor } from "../utils/receipt-editor.server";
import { ReceiptLayoutEditor } from "../components/ReceiptLayoutEditor";
import { PRINTER_PROFILE_OPTIONS, type ReceiptPrinterProfile } from "../services/receiptPrinterProfile";
import { reservationSampleData } from "../services/reservationReceiptLayout";
import { sampleTemplateData } from "../services/receiptLayoutData";
import { AdminBlock, SaveBar, StatusBanner, SectionTabs } from "../components/admin-ui";
export async function loader({ request }: LoaderFunctionArgs) {
  const context = await receiptEditorContext(request), settings = await loadReceiptEditor(context);
  const tabs = [...(settings.reservation ? [{ key: "customer", label: "取置・お客様控え" }, { key: "store", label: "取置・店舗控え" }] : []), ...(settings.outbound ? [{ key: "outbound_request", label: "出庫依頼書" }] : [])];
  const requested = new URL(request.url).searchParams.get("tab");
  return data({ settings, tabs, selected: tabs.some(tab => tab.key === requested) ? requested! : tabs[0].key }, { headers: { "Cache-Control": "private, no-store" } });
}
export async function action({ request }: ActionFunctionArgs) {
  const context = await receiptEditorContext(request);
  try {
    const form = await request.formData(), raw = String(form.get("settings") || "");
    if (raw.length > 1000000) throw new Error("設定の入力文字数を確認してください");
    const settings = await saveReceiptEditor(context, JSON.parse(raw));
    return data({ ok: true as const, error: "", saved: Date.now(), settings });
  } catch (error) { return data({ ok: false as const, error: error instanceof Error && /[\u3040-\u30ff\u4e00-\u9fff]/.test(error.message) ? error.message : "保存できませんでした。入力を確認してください", saved: 0 }, { status: 409 }); }
}
export default function Receipts() {
  const loaded = useLoaderData<typeof loader>();
  return <PolarisAppProvider i18n={ja}><ReceiptEditor initial={loaded} /></PolarisAppProvider>;
}
export function ReceiptEditor({ initial }: { initial: ReturnType<typeof useLoaderData<typeof loader>> }) {
  const [settings, setSettings] = useState(initial.settings), [editorInitial, setEditorInitial] = useState(initial.settings), [tab, setTab] = useState(initial.selected);
  const baseline = useRef(initial.settings), result = useActionData<typeof action>(), busy = useNavigation().state !== "idle";
  useEffect(() => { if (result?.ok) { baseline.current = result.settings; setSettings(result.settings); } }, [result]);
  const discard = () => { const restored = structuredClone(baseline.current); setSettings(restored); setEditorInitial(restored); };
  return <s-page heading="レシート編集"><div className="Admin-body">
    {result?.error ? <StatusBanner tone="critical" heading="レシート設定を保存できませんでした">{result.error}</StatusBanner> : null}
    <Form method="post"><input type="hidden" name="settings" value={JSON.stringify(settings)} />
      <SaveBar status={result?.ok ? result.saved : undefined} failed={!busy && result?.ok === false} onDiscard={discard} />
      <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <SectionTabs label="編集するレシート" items={initial.tabs} selected={tab} onSelect={setTab} disabled={busy} />
        <p className="Admin-note">左側でブロック・書式・Liquidコードを編集し、右側で印刷と同じ処理のプレビューを確認できます。タブを切り替えても未保存の編集は残ります。</p>
        {settings.reservation && (tab === "customer" || tab === "store") ? <AdminBlock title="取置の発行設定" description="お客様控えは店頭での登録後、店舗控えは詳細画面から印刷します。">
          <label className="Admin-control"><input type="checkbox" checked={settings.reservation.customerCopy} onChange={event => setSettings(previous => ({ ...previous, reservation: { ...previous.reservation!, customerCopy: event.target.checked } }))} />お客様控えを発行</label>
          <label className="Admin-control"><input type="checkbox" checked={settings.reservation.storeCopy} onChange={event => setSettings(previous => ({ ...previous, reservation: { ...previous.reservation!, storeCopy: event.target.checked } }))} />店舗控えを発行</label>
          <label className="Admin-control">プリンター補正<select className="Admin-select" value={settings.reservation.printerProfile} onChange={event => setSettings(previous => ({ ...previous, reservation: { ...previous.reservation!, printerProfile: event.target.value as ReceiptPrinterProfile } }))}>{PRINTER_PROFILE_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        </AdminBlock> : null}
        {settings.outbound && tab === "outbound_request" ? <AdminBlock title="出庫依頼書の印刷設定" description="保存済みの依頼内容を、POSの詳細画面から印刷します。">
          <label className="Admin-control">プリンター補正<select className="Admin-select" value={settings.outbound.printerProfile} onChange={event => setSettings(previous => ({ ...previous, outbound: { ...previous.outbound!, printerProfile: event.target.value as ReceiptPrinterProfile } }))}>{PRINTER_PROFILE_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        </AdminBlock> : null}
        <p className="Admin-note">用紙別に58mm・80mmの書式を保存できます。必須の商品・数量と伝票情報は印字されます。紙送りや機器補正は実際のプリンターで確認してください。</p>
        {settings.reservation && editorInitial.reservation ? (["customer", "store"] as const).map(copy => <div key={copy} hidden={tab !== copy}>
          <ReceiptLayoutEditor kind="reservation" initial={editorInitial.reservation![copy]} active={tab === copy} printerProfile={settings.reservation!.printerProfile} sampleData={reservationSampleData(copy)} onLayoutChange={layout => setSettings(previous => ({ ...previous, reservation: { ...previous.reservation!, [copy]: layout } }))} />
        </div>) : null}
        {settings.outbound && editorInitial.outbound ? <div hidden={tab !== "outbound_request"}>
          <ReceiptLayoutEditor kind="outbound_request" initial={editorInitial.outbound.layout} active={tab === "outbound_request"} printerProfile={settings.outbound.printerProfile} sampleData={sampleTemplateData("outbound_request")} onLayoutChange={layout => setSettings(previous => ({ ...previous, outbound: { ...previous.outbound!, layout } }))} />
        </div> : null}
      </fieldset>
    </Form>
  </div></s-page>;
}
