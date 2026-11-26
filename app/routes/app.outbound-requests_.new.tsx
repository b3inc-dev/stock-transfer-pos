import { randomUUID } from "node:crypto";
import { useEffect, useRef, useState } from "react";
import { Form, data, redirect, useActionData, useFetcher, useLoaderData, useNavigation } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { outboundAdmin } from "../utils/outbound-request-admin.server";
import { getRequest, requestLocations, requestProducts, saveRequest, type RequestLine } from "../utils/outbound-requests.server";
import { AdminBlock, BackAction, DeleteIconButton, EditTable, EditRow, EditCell, SaveBar, StatusBanner, markFormDirty } from "../components/admin-ui";
import { OutboundRequestNav } from "../components/outbound-request-ui";
import { REQUEST_LIST_PATH, requestChildUrl, requestReturnTo } from "../utils/outbound-request-view";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session, admin } = await outboundAdmin(request), url = new URL(request.url), id = url.searchParams.get("id");
  const row = id ? await getRequest(session.shop, id) : null;
  if (row && !["draft", "requested", "working"].includes(row.status)) throw new Response("出庫処理中・出庫済みの依頼は編集できません", { status: 409 });
  return { id: id || randomUUID(), row, locations: await requestLocations(admin), returnTo: requestReturnTo(url.searchParams.get("returnTo")) };
}
export async function action({ request }: ActionFunctionArgs) {
  const { session, admin, actor } = await outboundAdmin(request), form = await request.formData();
  try {
    if (form.get("command") === "search") {
      const query = String(form.get("query") || "").trim();
      return data({ ok: true, error: "", query, products: query ? await requestProducts(admin, query) : [] });
    }
    const version = Number(form.get("version")), id = String(form.get("id"));
    const existing = version ? await getRequest(session.shop, id) : null;
    // Saving a new draft never publishes it. Editing a published request keeps its state.
    const row = await saveRequest(session.shop, actor, admin, { id, version, originId: String(form.get("originId")), destinationId: String(form.get("destinationId")), dueDate: String(form.get("dueDate") || ""), note: String(form.get("note") || ""), publish: Boolean(existing && existing.status !== "draft"), lines: JSON.parse(String(form.get("lines") || "[]")) });
    const returnTo = requestReturnTo(new URL(request.url).searchParams.get("returnTo"));
    return redirect(requestChildUrl(REQUEST_LIST_PATH + "/" + row.id, returnTo, { saved: "1" }));
  } catch (error) {
    return data({ ok: false, error: error instanceof Error ? error.message : "登録できませんでした", query: String(form.get("query") || ""), products: [] as RequestLine[] }, { status: 400 });
  }
}
export default function RequestEditor() {
  const loaded = useLoaderData<typeof loader>();
  return <RequestEditorForm key={loaded.id + ":" + (loaded.row?.version || 0)} loaded={loaded} />;
}
function RequestEditorForm({ loaded }: { loaded: ReturnType<typeof useLoaderData<typeof loader>> }) {
  const { id, row, locations, returnTo } = loaded;
  const [lines, setLines] = useState<RequestLine[]>(row?.lines || []), [query, setQuery] = useState("");
  const result = useActionData<typeof action>(), search = useFetcher<typeof action>(), busy = useNavigation().state !== "idle";
  const working = row?.status === "working", initialLines = useRef(lines), formRef = useRef<HTMLFormElement>(null);
  useEffect(() => { if (lines !== initialLines.current) markFormDirty(formRef.current); }, [lines]);
  const searchBusy = search.state !== "idle";
  const searchProducts = () => {
    const form = new FormData(); form.set("command", "search"); form.set("query", query);
    void search.submit(form, { method: "post" });
  };
  const candidates = search.data?.query === query.trim() ? search.data.products : undefined;
  const searchError = search.data?.query === query.trim() ? search.data.error : "";
  return <s-page heading={row ? "出庫依頼を編集" : "出庫依頼を追加"}><BackAction to={row ? requestChildUrl(REQUEST_LIST_PATH + "/" + id, returnTo) : returnTo} label={row ? "依頼の詳細へ戻る" : "出庫依頼へ戻る"} /><div className="Admin-body">
    <OutboundRequestNav selected="create" returnTo={returnTo} />
    {result?.error || searchError ? <StatusBanner tone="critical" heading="入力を確認してください">{result?.error || searchError}</StatusBanner> : null}
    <Form id="outbound-request-editor" method="post" ref={formRef}>
      <input type="hidden" name="id" value={id} /><input type="hidden" name="version" value={row?.version || 0} /><input type="hidden" name="lines" value={JSON.stringify(lines)} />
      <fieldset className="Outreq-form-fieldset" disabled={busy}>
        <div className="Outreq-split">
          <aside>
            <h2 className="Outreq-heading">{row ? "依頼を編集" : "新規出庫依頼"}</h2>
            <p className="Admin-note Outreq-intro">{working ? "作業中は商品と数量を追加できます。店舗のPOSで内容の再確認が必要になります。" : row?.status === "requested" ? "保存すると店舗への依頼内容を更新します。" : "保存すると下書きになります。詳細で内容を確認してから店舗へ依頼します。"}</p>
            <AdminBlock wide title="依頼内容"><div className="Outreq-fields">
              <label>出庫元ロケーション<select className="Admin-input" name="originId" defaultValue={row?.originId || ""} disabled={working || busy} required><option value="">選択</option>{locations.map(location => <option key={location.id} value={location.id}>{location.name}</option>)}</select></label>
              <label>移動先ロケーション<select className="Admin-input" name="destinationId" defaultValue={row?.destinationId || ""} disabled={working || busy} required><option value="">選択</option>{locations.map(location => <option key={location.id} value={location.id}>{location.name}</option>)}</select></label>
              {working ? <><input type="hidden" name="originId" value={row.originId} /><input type="hidden" name="destinationId" value={row.destinationId} /></> : null}
              <label>希望出庫日<input type="date" className="Admin-input" name="dueDate" defaultValue={row?.dueDate || ""} /></label>
              <label>備考<textarea className="Admin-input" name="note" defaultValue={row?.note || ""} maxLength={2000} rows={3} /></label>
            </div></AdminBlock>
            <AdminBlock wide title="商品を追加" description="商品名・SKU・JANで検索し、明細へ追加します。">
              <div data-not-form-value className="Outreq-fields">
                <label>商品検索<input className="Admin-input" type="search" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); if (!busy && !searchBusy) searchProducts(); } }} /></label>
                <div><button type="button" className="Admin-secondary" onClick={searchProducts} disabled={busy || searchBusy || !query.trim()}>{searchBusy ? "検索中…" : "検索"}</button></div>
                {!searchBusy && candidates?.length === 0 ? <p className="Admin-note">条件に合う商品はありません。</p> : null}
                <div className="Outreq-candidates" aria-busy={searchBusy}>{!searchBusy ? candidates?.map(product => {
                  const added = lines.some(line => line.variantId === product.variantId);
                  return <div className="Outreq-candidate" key={product.variantId}><div><p>{product.title}</p><p className="Admin-note">SKU: {product.sku || "—"}<br />JAN: {product.barcode || "—"}</p></div><button type="button" className="Admin-secondary" disabled={busy || added} onClick={() => setLines(previous => previous.some(line => line.variantId === product.variantId) ? previous : [...previous, { ...product, quantity: 1 }])}>{added ? "追加済み" : "追加"}</button></div>;
                }) : null}</div>
              </div>
            </AdminBlock>
          </aside>
          <main>
            <AdminBlock wide title="依頼明細" description="数量を入力し、保存してください。">
              <p className="Admin-note">{lines.length}種類・合計{lines.reduce((sum, line) => sum + (Number.isFinite(line.quantity) ? line.quantity : 0), 0).toLocaleString("ja-JP")}点</p>
              {lines.length ? <EditTable columns={[{ label: "商品・SKU・JAN", width: "1fr" }, { label: "依頼数量", width: "100px" }, { label: "操作", width: "44px" }]}>{lines.map(line => <EditRow key={line.variantId}>
                <EditCell label="商品"><strong>{line.title}</strong><p className="Admin-note">SKU: {line.sku || "—"}<br />JAN: {line.barcode || "—"}</p></EditCell>
                <EditCell label="依頼数量"><input className="Admin-input Outreq-number" aria-label={line.title + "の依頼数量"} type="number" inputMode="numeric" min={working ? row.lines.find(item => item.variantId === line.variantId)?.quantity || 1 : 1} max={999999} step={1} required disabled={busy} value={Number.isNaN(line.quantity) ? "" : line.quantity} onChange={event => setLines(previous => previous.map(item => item.variantId === line.variantId ? { ...item, quantity: event.target.value === "" ? NaN : Number(event.target.value) } : item))} /></EditCell>
                <EditCell label="操作"><DeleteIconButton label="商品を削除" disabled={busy || Boolean(working && row.lines.some(item => item.variantId === line.variantId))} onClick={() => setLines(previous => previous.filter(item => item.variantId !== line.variantId))} /></EditCell>
              </EditRow>)}</EditTable> : <p className="Admin-note">「商品を追加」から追加すると、ここに明細が表示されます。</p>}
              {working ? <p className="Admin-note">作業中の既存商品の削除・数量の減少・出庫元と移動先の変更はできません。</p> : null}
              <p className="Admin-note">保存や依頼の発行では在庫は変わりません。出庫元のPOSで検品して出庫します。</p>
            </AdminBlock>
          </main>
        </div>
      </fieldset>
      <SaveBar failed={Boolean(result?.error) && !busy} onDiscard={() => { setLines(row?.lines || []); setQuery(""); }} />
    </Form>
  </div></s-page>;
}
