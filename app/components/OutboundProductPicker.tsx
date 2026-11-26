import { useEffect, useId, useRef, useState } from "react";
import { useFetcher } from "react-router";
import type { RequestLine } from "../utils/outbound-requests.server";
import type { ProductCsvRow } from "../utils/product-add-csv";
import { ProductAddMethodTabs, ProductCandidateList, ProductCandidateRow, downloadProductCsvTemplate, type ProductAddMethod } from "./product-add-parts";

type CatalogResult = { requestKey: string; error?: string; products?: RequestLine[]; collections?: { id: string; title: string }[]; csvRows?: (ProductCsvRow & { product?: RequestLine })[]; pageInfo?: { hasNextPage: boolean; endCursor: string | null } };
const matches = (product: RequestLine, query: string) => [product.title, product.sku, product.barcode].join(" ").toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
export function OutboundProductPicker({ lines, onAdd, disabled = false, onError }: { lines: RequestLine[]; onAdd: (products: RequestLine[]) => void; disabled?: boolean; onError: (message: string) => void }) {
  const fetcher = useFetcher<CatalogResult>(), id = "collection-products-" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [method, setMethod] = useState<ProductAddMethod>("search"), [query, setQuery] = useState(""), [activeKey, setActiveKey] = useState(""), [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Map<string, RequestLine>>(new Map()), selection = useRef(selected);
  const [onlySelected, setOnlySelected] = useState(false), [within, setWithin] = useState(""), [collectionTitle, setCollectionTitle] = useState(""), [modalOpen, setModalOpen] = useState(false), [readingFile, setReadingFile] = useState(false);
  const epoch = useRef(0), active = useRef(""), fileInput = useRef<HTMLInputElement>(null), cursorHistory = useRef<string[]>([""]), fileEpoch = useRef(0);
  const busy = disabled || fetcher.state !== "idle" || readingFile;
  const result = activeKey && fetcher.data?.requestKey === activeKey ? fetcher.data : undefined;
  const processedCsv = useRef("");
  useEffect(() => {
    if (method !== "csv" || !result?.csvRows || result.requestKey !== active.current || processedCsv.current === result.requestKey) return;
    processedCsv.current = result.requestKey;
    const next = new Map(result.csvRows.flatMap(row => row.product && !lines.some(line => line.variantId === row.product!.variantId || line.inventoryItemId === row.product!.inventoryItemId) ? [[row.product.variantId, row.product] as const] : []));
    selection.current = next; setSelected(next);
  }, [method, result, lines]);
  useEffect(() => () => { fileEpoch.current++; epoch.current++; }, []);
  const renderEpoch = epoch.current;
  const updateSelection = (next: Map<string, RequestLine>) => { selection.current = next; setSelected(next); };
  const invalidate = () => { epoch.current++; active.current = ""; setActiveKey(""); setPage(0); cursorHistory.current = [""]; };
  const clear = () => { invalidate(); fileEpoch.current++; updateSelection(new Map()); setWithin(""); setOnlySelected(false); onError(""); };
  const request = (command: string, values: Record<string, string>) => {
    const requestKey = String(++epoch.current); active.current = requestKey; setActiveKey(requestKey); onError("");
    const form = new FormData(); form.set("command", command); form.set("requestKey", requestKey); for (const [key, value] of Object.entries(values)) form.set(key, value);
    void fetcher.submit(form, { method: "post" });
  };
  const search = (after = "") => request(method === "collection" ? "collections" : "search", { query, after });
  const allCandidates = result?.products || result?.csvRows?.flatMap(row => row.product ? [row.product] : []) || [];
  const candidates = (onlySelected ? [...selected.values()] : allCandidates).filter(product => matches(product, within));
  const shown = method === "collection" && modalOpen ? candidates.slice(page * 50, (page + 1) * 50) : candidates;
  const added = (product: RequestLine) => lines.some(line => line.variantId === product.variantId || line.inventoryItemId === product.inventoryItemId);
  const validContext = () => epoch.current === renderEpoch && !disabled && !readingFile && fetcher.state === "idle";
  const toggle = (product: RequestLine) => { if (!validContext() || added(product)) return; const next = new Map(selection.current); if (next.has(product.variantId)) next.delete(product.variantId); else next.set(product.variantId, { ...product, quantity: product.quantity > 0 ? product.quantity : 1 }); updateSelection(next); };
  const addSelected = () => {
    if (!validContext()) return;
    const products = [...selection.current.values()].filter(product => !added(product));
    if (!products.length) return;
    if (products.some(product => !Number.isSafeInteger(product.quantity) || product.quantity < 1 || product.quantity > 999999)) { onError("数量は1〜999999の整数で入力してください"); return; }
    try { onAdd(products); updateSelection(new Map()); onError(""); } catch (error) { onError(error instanceof Error ? error.message : "商品を追加できませんでした"); }
  };
  const selectionUi = <>
    <div className="Outreq-actions"><span className="Admin-note">選択中: {selected.size}件 / 表示: {candidates.length}件</span><button type="button" className="Admin-secondary" disabled={busy} onClick={() => { setOnlySelected(previous => !previous); setPage(0); }}>{onlySelected ? "一覧表示に戻る" : "選択済み"}</button><button type="button" className="Admin-secondary" disabled={busy || !allCandidates.length} onClick={() => { if (!validContext()) return; const next = new Map(selection.current); allCandidates.filter(product => matches(product, within) && !added(product)).forEach(product => next.set(product.variantId, next.get(product.variantId) || { ...product, quantity: product.quantity || 1 })); updateSelection(next); }}>全選択</button><button type="button" className="Admin-secondary" disabled={busy || !selected.size} onClick={() => updateSelection(new Map())}>全解除</button></div>
    <ProductCandidateList>{shown.map(product => <ProductCandidateRow key={product.variantId} title={product.title} sku={product.sku} selected={selected.has(product.variantId)} quantity={selected.get(product.variantId)?.quantity || product.quantity || 1} disabled={busy} added={added(product)} onToggle={() => toggle(product)}>
      <input className="Admin-input" aria-label={product.title + "の追加数量"} type="number" inputMode="numeric" min={1} max={999999} step={1} onKeyDown={event => { if (event.key === "Enter") event.preventDefault(); }} style={{ width: 76, textAlign: "right" }} disabled={busy || added(product) || !selected.has(product.variantId)} value={Number.isNaN(selected.get(product.variantId)?.quantity) ? "" : selected.get(product.variantId)?.quantity ?? (product.quantity || 1)} onChange={event => { if (!validContext()) return; const next = new Map(selection.current), current = next.get(product.variantId); if (current) { next.set(product.variantId, { ...current, quantity: event.target.value === "" ? NaN : Number(event.target.value) }); updateSelection(next); } }} />
    </ProductCandidateRow>)}{!shown.length ? <p className="Admin-note">{result?.error ? "候補を取得できませんでした。条件を確認して再検索してください。" : result ? "条件に合う商品はありません。" : "検索またはアップロードしてください。"}</p> : null}</ProductCandidateList>
    <button type="button" className="Admin-secondary" disabled={busy || !selected.size} onClick={addSelected}>商品を追加</button>
  </>;
  const serverPager = result?.pageInfo ? <div className="Outreq-actions"><button type="button" className="Admin-secondary" disabled={busy || !page} onClick={() => { const next = page - 1; setPage(next); search(cursorHistory.current[next]); }}>前へ</button><span>{page + 1}ページ</span><button type="button" className="Admin-secondary" disabled={busy || !result.pageInfo.hasNextPage} onClick={() => { const next = page + 1; cursorHistory.current[next] = result.pageInfo!.endCursor!; setPage(next); search(cursorHistory.current[next]); }}>次へ</button></div> : null;
  return <div data-not-form-value className="Outreq-fields">
    <ProductAddMethodTabs value={method} disabled={disabled || readingFile} onChange={next => { clear(); setMethod(next); setQuery(""); setModalOpen(false); }} />
    {result?.error ? <p role="alert" style={{ color: "#b42318" }}>{result.error}</p> : null}
    {method !== "csv" ? <>
      <label>{method === "collection" ? "コレクション検索" : "商品検索"}<input className="Admin-input" type="search" value={query} disabled={disabled} placeholder={method === "collection" ? "コレクション名で検索" : "商品名・SKU・JANで検索"} onChange={event => { invalidate(); setQuery(event.target.value); setWithin(""); setOnlySelected(false); }} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); if (!busy && query.trim()) { setPage(0); cursorHistory.current = [""]; search(); } } }} /></label>
      <div><button type="button" className="Admin-secondary" disabled={busy || !query.trim()} onClick={() => { setPage(0); cursorHistory.current = [""]; search(); }}>{busy ? "検索中…" : "検索"}</button></div>
    </> : <>
      <p className="Admin-note">テンプレートをダウンロードしてCSVを作成し、アップロードしてください。チェックした商品だけ「商品を追加」で追加します。</p>
      <input ref={fileInput} type="file" accept=".csv,text/csv" hidden style={{ display: "none" }} disabled={busy} onChange={async event => {
        const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
        clear(); const generation = ++fileEpoch.current; setReadingFile(true);
        try { if (file.size > 1024 * 1024) throw new Error("CSVは1MB以下でアップロードしてください"); const csv = await file.text(); if (generation === fileEpoch.current) request("csv", { csv }); }
        catch (error) { if (generation === fileEpoch.current) onError(error instanceof Error ? error.message : "CSVを読み込めませんでした"); }
        finally { if (generation === fileEpoch.current) setReadingFile(false); }
      }} />
      <div className="Outreq-actions"><button type="button" className="Admin-secondary" disabled={busy} onClick={() => fileInput.current?.click()}>CSVアップロード</button><button type="button" className="Admin-secondary" disabled={disabled} onClick={() => downloadProductCsvTemplate("outbound_request_template.csv")}>テンプレートダウンロード</button></div>
      {result?.csvRows?.some(row => row.error) ? <div role="status"><p>追加できない行があります。内容を確認してください。</p>{result.csvRows.filter(row => row.error).map(row => <p key={row.rowNumber} className="Admin-note">{row.rowNumber}行目・{row.sku || "SKUなし"}: {row.error}</p>)}</div> : null}
    </>}
    {method === "collection" ? <>
      <ProductCandidateList>{result?.collections?.map(collection => <div key={collection.id} className="Outreq-candidate"><span>{collection.title}</span><s-button variant="secondary" disabled={busy} command="--show" commandFor={id} onClick={() => { clear(); setCollectionTitle(collection.title); setModalOpen(true); request("collectionProducts", { collectionId: collection.id }); }}>商品を選ぶ</s-button></div>)}{result?.collections?.length === 0 ? <p className="Admin-note">条件に合うコレクションはありません。</p> : null}</ProductCandidateList>{!modalOpen ? serverPager : null}
      <s-modal id={id} heading={"商品選択: " + collectionTitle} onAfterHide={() => { clear(); setModalOpen(false); }}><div className="Outreq-fields" style={{ padding: 16 }}>
        <label>商品を絞り込む<input className="Admin-input" type="search" placeholder="SKU・商品名・JANの一部で絞り込み" onKeyDown={event => { if (event.key === "Enter") event.preventDefault(); }} value={within} disabled={busy} onChange={event => { setWithin(event.target.value); setPage(0); }} /></label>
        {busy ? <p role="status">商品リストを取得中…</p> : null}{result?.error ? <p role="alert">{result.error}</p> : null}{selectionUi}
        <div className="Outreq-actions"><button type="button" className="Admin-secondary" disabled={busy || page <= 0} onClick={() => setPage(previous => previous - 1)}>前へ</button><span>{page + 1} / {Math.max(1, Math.ceil(candidates.length / 50))}ページ</span><button type="button" className="Admin-secondary" disabled={busy || (page + 1) * 50 >= candidates.length} onClick={() => setPage(previous => previous + 1)}>次へ</button></div>
      </div><s-button slot="secondary-actions" command="--hide" commandFor={id}>閉じる</s-button></s-modal>
    </> : <>{busy ? <p role="status">{readingFile ? "CSVを読み込み中…" : "候補を取得中…"}</p> : null}{selectionUi}{method === "search" ? serverPager : null}</>}
  </div>;
}
