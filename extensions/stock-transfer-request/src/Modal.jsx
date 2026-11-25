/* global globalThis */
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { PlanGate } from "../../common/PlanGate.jsx";
import { StockyRowShell, ItemLeftCompact, QtyControlCompact_3Buttons } from "../../common/StockProductRowParts.jsx";
import { printReceipt } from "../../common/receiptPrinting.js";
import { getListPageSlice } from "../../common/listDisplayPagination.js";
import { OUTBOUND_REQUEST_LABELS, outboundRequestTone, validOutboundDate } from "../../common/outboundRequests.js";
import { currentRequestLocation, outboundRequestApi } from "./api.js";

export default async () => render(<PlanGate feature="outboundRequest" heading="出庫依頼"><OutboundRequestModal /></PlanGate>, document.body);
const editableStatuses = ["working"];
export function OutboundRequestModal() {
  const [history, setHistory] = useState(false);
  const [rows, setRows] = useState([]), [row, setRow] = useState(null), [actual, setActual] = useState([]);
  const [settings, setSettings] = useState(null), [shipping, setShipping] = useState(null), [tracking, setTracking] = useState({});
  const [scanning, setScanning] = useState(false), scanPending = useRef(0);
  const [preview, setPreview] = useState(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [query, setQuery] = useState(""), [products, setProducts] = useState([]), [page, setPage] = useState(1), [listPage, setListPage] = useState(0), [count, setCount] = useState(0);
  const addRef = useRef(null), initialRefresh = useRef(null);
  const lock = useRef(false), alive = useRef(true), confirmRef = useRef(null), current = useRef(null), claimKey = useRef(""), draft = useRef([]), writes = useRef(Promise.resolve()), scanQueue = useRef(Promise.resolve());
  current.current = row; draft.current = actual;
  const keyFor = id => `outbound-request:${currentRequestLocation()}:${id}`;
  const applyRow = (next, preserve = false) => {
    current.current = next; setRow(next); setPreview(null);
    const local = preserve ? draft.current : next.actualLines || [];
    const merged = next.lines.map(line => ({ ...line, quantity: 0, reason: "", ...(local.find(item => item.inventoryItemId === line.inventoryItemId) || {}) }));
    merged.push(...local.filter(line => !merged.some(item => item.inventoryItemId === line.inventoryItemId)));
    draft.current = merged; setActual(merged);
  };
  const run = async fn => {
    if (lock.current || scanPending.current || !alive.current) return;
    lock.current = true; setBusy(true); setError("");
    try { await fn(); } catch (e) { if (alive.current) setError(e.message || "操作できませんでした。依頼を読み直してください"); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  };
  const refreshList = async (nextPage = listPage, nextHistory = history) => {
    const result = await outboundRequestApi({ command: "list", page: nextPage, history: nextHistory });
    if (alive.current) { setRows(result.rows); setHistory(nextHistory); setCount(result.count); setListPage(nextPage); setSettings(result.settings); setShipping(result.shipping); }
  };
  initialRefresh.current = () => run(() => refreshList(0));
  useEffect(() => { alive.current = true; void initialRefresh.current(); return () => { alive.current = false; shopify.scanner?.hideCameraScanner?.(); }; }, []);
  const open = async selected => {
    const stored = await shopify.storage.get(keyFor(selected.id));
    claimKey.current = stored?.claimKey || "";
    const result = await outboundRequestApi({ command: "detail", id: selected.id, claimKey: claimKey.current });
    if (!alive.current) return;
    applyRow(result.row); setSettings(result.settings); setShipping(result.shipping); setTracking(stored?.tracking || {}); setPage(1);
    if (result.row.claimed && stored?.actual) {
      const local = stored.actual;
      const merged = result.row.lines.map(line => ({ ...line, quantity: 0, reason: "", ...(local.find(item => item.inventoryItemId === line.inventoryItemId) || {}) }));
      merged.push(...local.filter(line => !merged.some(item => item.inventoryItemId === line.inventoryItemId)));
      draft.current = merged; setActual(merged);
    }
  };
  const persist = (lines, nextTracking = tracking) => {
    const selected = current.current;
    const snapshot = { claimKey: claimKey.current, actual: lines, tracking: nextTracking };
    writes.current = writes.current.catch(() => {}).then(() => shopify.storage.set(keyFor(selected.id), snapshot));
    writes.current.catch(() => { if (alive.current) setError("端末へ保存できませんでした。「検品を保存」で保存してください。"); });
  };
  const patch = (id, changes) => {
    if (lock.current) return;
    const next = draft.current.map(line => line.inventoryItemId === id ? { ...line, ...changes } : line);
    draft.current = next; setActual(next); setPreview(null); persist(next);
  };
  const add = product => {
    const found = draft.current.find(line => line.inventoryItemId === product.inventoryItemId);
    const requested = current.current.lines.find(line => line.inventoryItemId === product.inventoryItemId);
    if (!requested && !settings?.policy.allowExtra) throw new Error("依頼にない商品の追加は許可されていません");
    const quantity = (found?.quantity || 0) + 1;
    if (requested && quantity > requested.quantity && !settings?.policy.allowOver) throw new Error("過剰出庫は許可されていません");
    const next = found ? draft.current.map(line => line.inventoryItemId === product.inventoryItemId ? { ...line, quantity } : line) : [...draft.current, { ...product, quantity, reason: "" }];
    draft.current = next; setActual(next); setPreview(null); persist(next);
  };
  addRef.current = add;
  useEffect(() => {
    if (!row?.claimed || row.status !== "working") return;
    let active = true;
    const unsubscribe = shopify.scanner?.scannerData?.current?.subscribe?.(event => {
      const code = String(event?.data || "").trim();
      if (!code || lock.current) return;
      scanPending.current++; setScanning(true);
      scanQueue.current = scanQueue.current.catch(() => {}).then(async () => {
        if (!active || lock.current) return;
        const matches = draft.current.filter(line => line.barcode === code || line.sku === code);
        if (matches.length === 1) { addRef.current(matches[0]); return; }
        if (matches.length > 1) throw new Error("同じコードの商品が複数あります。商品を検索して選択してください");
        const result = await outboundRequestApi({ command: "products", query: code, scan: true });
        if (!active || lock.current) return;
        const exact = result.products.filter(line => line.barcode === code || line.sku === code);
        if (exact.length !== 1) throw new Error("商品を特定できません。検索して選択してください");
        addRef.current(exact[0]);
      }).catch(e => { if (alive.current) setError(e.message); }).finally(() => { scanPending.current--; if (alive.current) setScanning(scanPending.current > 0); });
    });
    return () => { active = false; unsubscribe?.(); };
  }, [row?.id, row?.status, row?.claimed, settings]);
  const claim = () => run(async () => {
    const stored = await shopify.storage.get(keyFor(row.id));
    const fresh = await outboundRequestApi({ command: "detail", id: row.id, claimKey: stored?.claimKey || "" });
    if (fresh.row.status !== "requested") { await open(fresh.row); return; }
    claimKey.current = globalThis.crypto.randomUUID();
    await shopify.storage.set(keyFor(row.id), { claimKey: claimKey.current });
    try {
      const result = await outboundRequestApi({ command: "claim", id: row.id, version: fresh.row.version, claimKey: claimKey.current });
      applyRow(result.row); persist(result.row.actualLines || []);
    } catch (error) {
      // The server may have claimed successfully even when its response was lost. Keep the saved device key.
      const recovered = await outboundRequestApi({ command: "detail", id: row.id, claimKey: claimKey.current });
      if (!recovered.row.claimed) throw error;
      applyRow(recovered.row);
    }
  });
  const save = () => run(async () => {
    const result = await outboundRequestApi({ command: "save", id: row.id, originId: row.originId, version: row.version, claimKey: claimKey.current, actual: draft.current });
    applyRow(result.row); shopify.toast.show("検品を保存しました");
  });
  const reload = () => run(async () => {
    const result = await outboundRequestApi({ command: "detail", id: row.id, claimKey: claimKey.current });
    applyRow(result.row, true); setSettings(result.settings); setShipping(result.shipping);
  });
  const prepare = () => run(async () => {
    setPreview(null);
    await writes.current.catch(() => {});
    const result = await outboundRequestApi({ command: "preview", id: row.id, originId: row.originId, version: row.version, claimKey: claimKey.current, actual: draft.current, tracking });
    setPreview(result.preview);
  });
  const advance = async first => {
    let next = first;
    while (alive.current && ["processing", "retryable"].includes(next.status) && !next.execution?.flight) {
      const result = await outboundRequestApi({ command: "advance", id: next.id, version: next.version, originId: next.originId });
      next = result.row; if (alive.current) applyRow(next);
      if (next.status === "retryable") break;
    }
    if (next.error) throw new Error(next.error);
    if (next.status === "completed") shopify.toast.show("出庫が完了しました。受領は移動先の入庫から行ってください。");
  };
  const confirm = () => run(async () => {
    if (!preview) throw new Error("数量と差異をもう一度確認してください");
    confirmRef.current?.hideOverlay?.();
    const result = await outboundRequestApi({ command: "begin", id: row.id, originId: row.originId, version: row.version, claimKey: claimKey.current, actual: draft.current, tracking, token: preview.token });
    applyRow(result.row); await advance(result.row);
  });
  const print = () => run(async () => {
    const result = await printReceipt(`/api/outbound-requests?receipt=${encodeURIComponent(row.id)}&locationId=${encodeURIComponent(currentRequestLocation())}`);
    shopify.toast.show(result.message);
  });
  const editable = row?.claimed && editableStatuses.includes(row.status);
  const pageInfo = getListPageSlice(actual, page, 50);
  return <s-page heading="出庫依頼"><s-stack direction="block" blockSize="100%">
    <s-scroll-box blockSize="100%"><s-box padding="base"><s-stack direction="block" gap="base">
      {error ? <s-text tone="critical">{error}</s-text> : null}{busy || scanning ? <s-text>{scanning ? "スキャンを確認しています。" : "処理中です。少しお待ちください。"}</s-text> : null}
      {!row ? <><s-stack direction="inline"><s-button disabled={busy || !history} onClick={() => run(() => refreshList(0, false))}>出庫待ち</s-button><s-button disabled={busy || history} onClick={() => run(() => refreshList(0, true))}>履歴</s-button></s-stack>{rows.map(item => <s-clickable key={item.id} onClick={() => run(() => open(item))}><s-box padding="base"><s-text>{item.number}</s-text><s-text>{item.destinationName}・{item.dueDate || "期日指定なし"}・{OUTBOUND_REQUEST_LABELS[item.status]}</s-text></s-box></s-clickable>)}{!rows.length && !busy ? <s-text>出庫依頼はありません。</s-text> : null}<s-stack direction="inline"><s-button disabled={busy || !listPage} onClick={() => run(() => refreshList(listPage - 1))}>前へ</s-button><s-text>{count}件</s-text><s-button disabled={busy || (listPage + 1) * 25 >= count} onClick={() => run(() => refreshList(listPage + 1))}>次へ</s-button></s-stack></> : <>
        <s-text>{row.number}・版{row.version}</s-text><s-text>{row.originName} → {row.destinationName}</s-text><s-badge tone={outboundRequestTone(row.status)}>{OUTBOUND_REQUEST_LABELS[row.status]}</s-badge><s-text>{row.note}</s-text>
        {!row.claimed && row.status === "working" ? <s-text>別の端末で作業中です。引き継ぐ場合は管理画面で作業を中止してください。</s-text> : null}
        {editable ? <><s-search-field placeholder="商品・SKU・JAN" value={query} onInput={event => setQuery(event.target.value)} /><s-button disabled={busy} onClick={() => run(async () => setProducts((await outboundRequestApi({ command: "products", query })).products))}>検索</s-button>
          <s-button disabled={busy} onClick={() => shopify.scanner?.showCameraScanner?.()}>カメラスキャン</s-button>
          {products.map(product => <s-button key={product.variantId} disabled={busy} onClick={() => { try { add(product); } catch (e) { setError(e.message); } }}>{product.title}・{product.sku}を追加</s-button>)}
        </> : null}
        {pageInfo.displayed.map(line => {
          const requested = row.lines.find(item => item.inventoryItemId === line.inventoryItemId)?.quantity || 0;
          const kind = !requested ? "extra" : line.quantity < requested ? "under" : line.quantity > requested ? "over" : null;
          return <StockyRowShell key={line.inventoryItemId}><s-stack direction="block" gap="small"><ItemLeftCompact modern productTitle={line.title} line3={`SKU: ${line.sku} / 依頼 ${requested}${requested ? "" : "・依頼外"}`} /><QtyControlCompact_3Buttons modern value={line.quantity} min={0} max={requested && !settings?.policy.allowOver ? requested : 999999} modalId={`outbound-qty-${line.inventoryItemId.split("/").pop()}`} disabled={!editable || busy} onDec={() => patch(line.inventoryItemId, { quantity: Math.max(0, line.quantity - 1) })} onInc={() => patch(line.inventoryItemId, { quantity: line.quantity + 1 })} onSetQty={quantity => patch(line.inventoryItemId, { quantity })} />{kind && settings?.policy[`${kind}Reason`] !== "none" ? <s-text-field label={`理由${settings?.policy[`${kind}Reason`] === "required" ? "（必須）" : "（任意）"}`} value={line.reason || ""} disabled={!editable || busy} onInput={event => patch(line.inventoryItemId, { reason: event.target.value })} /> : null}</s-stack></StockyRowShell>;
        })}
        {pageInfo.showPagination ? <s-stack direction="inline"><s-button disabled={busy || pageInfo.currentPage <= 1} onClick={() => setPage(page - 1)}>前へ</s-button><s-text>{pageInfo.rangeStart}–{pageInfo.rangeEnd} / {pageInfo.total}</s-text><s-button disabled={busy || pageInfo.currentPage >= pageInfo.totalPages} onClick={() => setPage(page + 1)}>次へ</s-button></s-stack> : null}
        {editable ? <><s-text>配送情報{shipping?.required ? "（必須）" : "（任意）"}</s-text>{shipping?.allowCustomCarrier ? <s-text-field label="配送会社" value={tracking.company || ""} disabled={busy} onInput={event => { const next = { ...tracking, company: event.target.value }; setTracking(next); setPreview(null); persist(draft.current, next); }} /> : <s-stack direction="block" gap="small"><s-button disabled={busy} command="--show" commandFor="outbound-request-carrier">配送会社：{shipping.carriers.find(carrier => carrier.company === tracking.company)?.label || "選択"}</s-button><s-modal id="outbound-request-carrier" heading="配送会社を選択"><s-box padding="base"><s-stack direction="block" gap="small">{[{ label: "未選択", company: "" }, ...shipping.carriers].map(carrier => <s-button key={carrier.company} disabled={busy} command="--hide" commandFor="outbound-request-carrier" onClick={() => { const next = { ...tracking, company: carrier.company }; setTracking(next); setPreview(null); persist(draft.current, next); }}>{carrier.label}</s-button>)}</s-stack></s-box><s-button slot="secondary-actions" command="--hide" commandFor="outbound-request-carrier">戻る</s-button></s-modal></s-stack>}<s-text-field label="配送番号" value={tracking.trackingNumber || ""} disabled={busy} onInput={event => { const next = { ...tracking, trackingNumber: event.target.value }; setTracking(next); setPreview(null); persist(draft.current, next); }} /><s-text-field label="追跡URL（任意）" value={tracking.trackingUrl || ""} disabled={busy} onInput={event => { const next = { ...tracking, trackingUrl: event.target.value }; setTracking(next); setPreview(null); persist(draft.current, next); }} /><s-text-field label="到着予定日（YYYY-MM-DD・任意）" value={tracking.arrivesAt ? new Date(tracking.arrivesAt).toLocaleDateString("en-CA") : ""} disabled={busy} onChange={event => { const value = event.target.value; if (value && !validOutboundDate(value)) { setError("到着予定日を確認してください"); return; } const date = value ? new Date(`${value}T12:00:00`) : null; if (date && !Number.isFinite(date.getTime())) { setError("到着予定日を確認してください"); return; } const next = { ...tracking, arrivesAt: date ? date.toISOString() : "" }; setTracking(next); setPreview(null); persist(draft.current, next); }} /></> : null}
      </>}
    </s-stack></s-box></s-scroll-box><s-divider /><s-box padding="base"><s-stack direction="inline" justifyContent="space-between">
      {row ? <s-button disabled={busy} onClick={() => run(async () => { await writes.current; setRow(null); setProducts([]); setPreview(null); await refreshList(); })}>一覧へ</s-button> : <s-button disabled={busy} onClick={() => run(() => refreshList())}>再読み込み</s-button>}
      {row ? <s-button disabled={busy} onClick={reload}>読み直す</s-button> : null}
      {row ? <s-button disabled={busy || row.status === "cancelled"} onClick={print}>依頼書を印刷</s-button> : null}
      {row?.status === "requested" ? <s-button variant="primary" disabled={busy} onClick={claim}>作業を開始</s-button> : null}
      {editable ? <><s-button disabled={busy} onClick={save}>検品を保存</s-button><s-button variant="primary" disabled={busy || scanning} command="--show" commandFor="outbound-request-differences" onClick={prepare}>出庫完了</s-button></> : null}
      {row && ["processing", "retryable", "uncertain"].includes(row.status) ? <s-button variant="primary" disabled={busy} onClick={() => run(async () => {
        let next = row;
        if (next.status === "uncertain" || next.execution?.flight) next = (await outboundRequestApi({ command: "reconcile", id: row.id, version: row.version })).row;
        applyRow(next); await advance(next);
      })}>出庫結果を確認・再開</s-button> : null}
    </s-stack></s-box>
    <s-modal id="outbound-request-differences" heading={preview?.differences.length ? "数量の差異を確認" : "出庫内容を確認"} ref={confirmRef}>
      <s-scroll-box maxBlockSize="400px"><s-box padding="base"><s-stack direction="block" gap="base"><s-text>移動先：{row?.destinationName}</s-text>{!preview ? <s-text tone={error ? "critical" : "auto"}>{error || "数量と設定を確認しています。"}</s-text> : null}
        {(preview?.differences || []).map(line => <StockyRowShell key={line.inventoryItemId}><s-text>{line.title}・SKU: {line.sku}</s-text><s-text>依頼 {line.requested} → 出庫 {line.quantity}（差分 {line.delta > 0 ? "+" : ""}{line.delta}）</s-text>{line.reason ? <s-text>理由：{line.reason}</s-text> : null}</StockyRowShell>)}
        <s-text>{preview?.lines.length || 0}商品・出庫合計 {preview?.lines.reduce((sum, line) => sum + line.quantity, 0) || 0}点を出庫します。</s-text>
      </s-stack></s-box></s-scroll-box>
      <s-button slot="secondary-actions" command="--hide" commandFor="outbound-request-differences" disabled={busy}>戻る</s-button>
      <s-button slot="primary-action" variant="primary" disabled={busy || !preview} command="--hide" commandFor="outbound-request-differences" onClick={confirm}>確認して出庫</s-button>
    </s-modal>
  </s-stack></s-page>;
}
