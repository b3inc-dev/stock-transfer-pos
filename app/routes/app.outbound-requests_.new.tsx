import { randomUUID } from "node:crypto";
import { useEffect, useRef, useState } from "react";
import { Form, data, redirect, useActionData, useFetcher, useLoaderData, useNavigation } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { outboundAdmin } from "../utils/outbound-request-admin.server";
import { getRequest, requestLocations, requestProducts, saveRequest, type RequestLine } from "../utils/outbound-requests.server";
import { AdminBlock, BackAction, DeleteIconButton, EditTable, EditRow, EditCell, SaveBar, StatusBanner, markFormDirty } from "../components/admin-ui";
export async function loader({ request }: LoaderFunctionArgs) {
  const { session, admin } = await outboundAdmin(request), id = new URL(request.url).searchParams.get("id");
  const row = id ? await getRequest(session.shop, id) : null;
  if (row && !["draft", "requested", "working"].includes(row.status)) throw new Response("出庫処理中・出庫済みの依頼は編集できません", { status: 409 });
  return { id: id || randomUUID(), row, locations: await requestLocations(admin) };
}
export async function action({ request }: ActionFunctionArgs) {
  const { session, admin, actor } = await outboundAdmin(request);
  const form = await request.formData();
  try {
    if (form.get("command") === "search") return data({ ok: true, error: "", products: await requestProducts(admin, String(form.get("query") || "")) });
    const row = await saveRequest(session.shop, actor, admin, { id: String(form.get("id")), version: Number(form.get("version")), originId: String(form.get("originId")), destinationId: String(form.get("destinationId")), dueDate: String(form.get("dueDate") || ""), note: String(form.get("note") || ""), publish: form.get("publish") === "1", lines: JSON.parse(String(form.get("lines") || "[]")) });
    return redirect(`/app/outbound-requests/${row.id}`);
  } catch (error) { return data({ ok: false, error: error instanceof Error ? error.message : "登録できませんでした", products: [] as RequestLine[] }, { status: 400 }); }
}
export default function RequestEditor() {
  const loaded = useLoaderData<typeof loader>();
  const [{ id, row, locations }] = useState(loaded);
  const [lines, setLines] = useState<RequestLine[]>(row?.lines || []);
  const result = useActionData<typeof action>(), search = useFetcher<typeof action>(), busy = useNavigation().state !== "idle";
  const [query, setQuery] = useState("");
  const working = row?.status === "working";
  const initialLines = useRef(lines);
  useEffect(() => { if (lines !== initialLines.current) markFormDirty(document.getElementById("outbound-request-editor")); }, [lines]);
  return <s-page heading={row ? "出庫依頼を編集" : "出庫依頼を追加"}><BackAction to={row ? `/app/outbound-requests/${id}` : "/app/outbound-requests"} label="出庫依頼へ戻る" /><div className="Admin-body">
    {result?.error || search.data?.error ? <StatusBanner tone="critical" heading="入力を確認してください">{result?.error || search.data?.error}</StatusBanner> : null}
    <search.Form method="post"><input type="hidden" name="command" value="search" /><AdminBlock title="商品を検索" description="商品名・SKU・JANで検索し、依頼へ追加します。">
      <label>商品<input name="query" value={query} onChange={event => setQuery(event.target.value)} /></label><button type="submit" className="Admin-secondary" disabled={search.state !== "idle"}>検索</button>
      {search.data?.products?.map(product => <div key={product.variantId}><span>{product.title}・{product.sku}</span><button type="button" className="Admin-secondary" onClick={() => { setLines(previous => previous.some(line => line.variantId === product.variantId) ? previous.map(line => line.variantId === product.variantId ? { ...line, quantity: line.quantity + 1 } : line) : [...previous, { ...product, quantity: 1 }]); }}>追加</button></div>)}
    </AdminBlock></search.Form>
    <Form id="outbound-request-editor" method="post"><input type="hidden" name="id" value={id} /><input type="hidden" name="version" value={row?.version || 0} /><input type="hidden" name="lines" value={JSON.stringify(lines)} />
      <AdminBlock title="移動先" description={working ? "作業中は商品の追加・数量追加が可能です。POSで再確認が必要になります。" : "出庫元と移動先を指定します。"}>
        <label>出庫元<select name="originId" defaultValue={row?.originId || ""} disabled={working || busy} required><option value="">選択</option>{locations.map(location => <option key={location.id} value={location.id}>{location.name}</option>)}</select></label>
        <label>移動先<select name="destinationId" defaultValue={row?.destinationId || ""} disabled={working || busy} required><option value="">選択</option>{locations.map(location => <option key={location.id} value={location.id}>{location.name}</option>)}</select></label>
        {working ? <><input type="hidden" name="originId" value={row.originId} /><input type="hidden" name="destinationId" value={row.destinationId} /></> : null}
        <label>希望出庫日<input type="date" className="Admin-input" name="dueDate" defaultValue={row?.dueDate || ""} /></label><label>備考<textarea name="note" defaultValue={row?.note || ""} maxLength={2000} /></label>
      </AdminBlock>
      <AdminBlock wide title="依頼明細" description="作業開始後も追加できます。出庫処理中・出庫完了後は変更できません。">
        <EditTable columns={[{ label: "商品・SKU", width: "1fr" }, { label: "依頼数量", width: "120px" }, { label: "操作", width: "60px" }]}>{lines.map(line => <EditRow key={line.variantId}><EditCell label="商品">{line.title}<p className="Admin-note">{line.sku}</p></EditCell><EditCell label="依頼数量"><input aria-label={`${line.title}の依頼数量`} type="number" min={working ? row.lines.find(item => item.variantId === line.variantId)?.quantity || 1 : 1} max={999999} value={line.quantity} onChange={event => setLines(previous => previous.map(item => item.variantId === line.variantId ? { ...item, quantity: Number(event.target.value) } : item))} /></EditCell><EditCell label="操作"><DeleteIconButton label="商品を削除" disabled={busy || Boolean(working && row.lines.some(item => item.variantId === line.variantId))} onClick={() => { setLines(previous => previous.filter(item => item.variantId !== line.variantId)); }} /></EditCell></EditRow>)}</EditTable>
        <label><input type="checkbox" name="publish" value="1" defaultChecked={row?.status !== "draft"} disabled={working} />店舗へ依頼する</label>{working ? <input type="hidden" name="publish" value="1" /> : null}
      </AdminBlock>
      <SaveBar failed={Boolean(result?.error)} onDiscard={() => setLines(row?.lines || [])} />
    </Form>
  </div></s-page>;
}
