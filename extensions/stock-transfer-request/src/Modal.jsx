/* global globalThis */
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { PlanGate } from "../../common/PlanGate.jsx";
import { StockyRowShell, ItemLeftCompact, QtyControlCompact_3Buttons } from "../../common/StockProductRowParts.jsx";
import { printReceipt } from "../../common/receiptPrinting.js";
import { FixedFooterNavBar } from "../../common/FixedFooterNavBar.jsx";
import { ListPageControls } from "../../common/ListPageControls.jsx";
import { getListPageSlice } from "../../common/listDisplayPagination.js";
import { OUTBOUND_REQUEST_LABELS, outboundRequestTone, validOutboundDate } from "../../common/outboundRequests.js";
import { currentRequestLocation, outboundRequestApi } from "./api.js";

export default async () => render(<PlanGate feature="outboundRequest" heading="出庫依頼"><OutboundRequestModal /></PlanGate>, document.body);
const editableStatuses = ["working"];
export function OutboundRequestModal() {
  const [history, setHistory] = useState(false);
  const [screen, setScreen] = useState("list"), [storeName, setStoreName] = useState("取得中…"), [showImages, setShowImages] = useState(true), [candidateQty, setCandidateQty] = useState({}), [searching, setSearching] = useState(false), [searchFailed, setSearchFailed] = useState(false);
  const [rows, setRows] = useState([]), [row, setRow] = useState(null), [actual, setActual] = useState([]);
  const [settings, setSettings] = useState(null), [shipping, setShipping] = useState(null), [tracking, setTracking] = useState({});
  const [cameraVisible, setCameraVisible] = useState(false), [scanning, setScanning] = useState(false), scanPending = useRef(0);
  const [preview, setPreview] = useState(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [query, setQuery] = useState(""), [products, setProducts] = useState([]), [page, setPage] = useState(1), [listPage, setListPage] = useState(0), [count, setCount] = useState(0);
  const addRef = useRef(null), initialRefresh = useRef(null), screenRef = useRef("list"), queryRef = useRef(""), searchEpoch = useRef(0), productContext = useRef(null);
  const goScreen = next => { screenRef.current = next; setScreen(next); };
  const changeQuery = value => { queryRef.current = value; searchEpoch.current++; productContext.current = null; setQuery(value); setProducts([]); setSearchFailed(false); setSearching(Boolean(value.trim())); };
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
    if (alive.current) { setStoreName(result.location?.name || "ロケーションを確認してください"); setRows(result.rows); setHistory(nextHistory); setCount(result.count); setListPage(nextPage); setSettings(result.settings); setShipping(result.shipping); }
  };
  initialRefresh.current = () => run(() => refreshList(0));
  useEffect(() => { alive.current = true; void initialRefresh.current(); return () => { alive.current = false; shopify.scanner?.hideCameraScanner?.(); }; }, []);
  const open = async selected => {
    const stored = await shopify.storage.get(keyFor(selected.id));
    claimKey.current = stored?.claimKey || "";
    const result = await outboundRequestApi({ command: "detail", id: selected.id, claimKey: claimKey.current });
    if (!alive.current) return;
    applyRow(result.row); goScreen("detail"); changeQuery(""); setProducts([]); setSettings(result.settings); setShipping(result.shipping); setTracking(stored?.tracking || {}); setPage(1);
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
  const add = (product, amount = 1) => {
    if (!Number.isSafeInteger(amount) || amount < 1) throw new Error("数量を確認してください");
    const found = draft.current.find(line => line.inventoryItemId === product.inventoryItemId);
    const requested = current.current.lines.find(line => line.inventoryItemId === product.inventoryItemId);
    if (!requested && !settings?.policy.allowExtra) throw new Error("依頼にない商品の追加は許可されていません");
    const quantity = (found?.quantity || 0) + amount;
    if (quantity > 999999) throw new Error("数量は999999以下で入力してください");
    if (requested && quantity > requested.quantity && !settings?.policy.allowOver) throw new Error("過剰出庫は許可されていません");
    const next = found ? draft.current.map(line => line.inventoryItemId === product.inventoryItemId ? { ...line, quantity } : line) : [...draft.current, { ...product, quantity, reason: "" }];
    draft.current = next; setActual(next); setPreview(null); persist(next);
  };
  addRef.current = add;
  const editable = row?.claimed && editableStatuses.includes(row.status);
  const inspecting = screen === "inspect" && editable;
  const uiBusy = busy || scanning;
  useEffect(() => {
    if (!inspecting) return;
    let active = true;
    const selectedId = row.id;
    const canScan = () => active && screenRef.current === "inspect" && current.current?.id === selectedId && current.current?.claimed && current.current?.status === "working" && !lock.current;
    const unsubscribe = shopify.scanner?.scannerData?.current?.subscribe?.(event => {
      const code = String(event?.data || "").trim();
      if (!code || !canScan()) return;
      scanPending.current++; setScanning(true);
      scanQueue.current = scanQueue.current.catch(() => {}).then(async () => {
        if (!canScan()) return;
        const matches = draft.current.filter(line => line.barcode === code || line.sku === code);
        if (matches.length === 1) { addRef.current(matches[0]); return; }
        if (matches.length > 1) throw new Error("同じコードの商品が複数あります。商品を検索して選択してください");
        const result = await outboundRequestApi({ command: "products", query: code, scan: true });
        if (!canScan()) return;
        const exact = result.products.filter(line => line.barcode === code || line.sku === code);
        if (exact.length !== 1) throw new Error("商品を特定できません。検索して選択してください");
        addRef.current(exact[0]);
      }).catch(e => { if (alive.current) setError(e.message); }).finally(() => { scanPending.current--; if (alive.current) setScanning(scanPending.current > 0); });
    });
    return () => { active = false; unsubscribe?.(); shopify.scanner?.hideCameraScanner?.(); setCameraVisible(false); };
  }, [inspecting, row?.id, settings]);
  const claim = () => run(async () => {
    const stored = await shopify.storage.get(keyFor(row.id));
    const fresh = await outboundRequestApi({ command: "detail", id: row.id, claimKey: stored?.claimKey || "" });
    if (fresh.row.status !== "requested") { await open(fresh.row); return; }
    claimKey.current = globalThis.crypto.randomUUID();
    await shopify.storage.set(keyFor(row.id), { claimKey: claimKey.current });
    try {
      const result = await outboundRequestApi({ command: "claim", id: row.id, version: fresh.row.version, claimKey: claimKey.current });
      applyRow(result.row); goScreen("inspect"); persist(result.row.actualLines || []);
    } catch (error) {
      // The server may have claimed successfully even when its response was lost. Keep the saved device key.
      const recovered = await outboundRequestApi({ command: "detail", id: row.id, claimKey: claimKey.current });
      if (!recovered.row.claimed) throw error;
      applyRow(recovered.row); goScreen("inspect");
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
    if (next.status === "completed") { goScreen("detail"); shopify.toast.show("出庫が完了しました。受領は移動先の入庫から行ってください。"); }
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
  useEffect(() => {
    if (!inspecting || !query.trim()) { setProducts([]); setSearching(false); return; }
    let active = true;
    const context = { epoch: searchEpoch.current, query, rowId: row.id };
    const isCurrent = () => active && searchEpoch.current === context.epoch && queryRef.current === query && current.current?.id === context.rowId && screenRef.current === "inspect";
    setSearching(true); setProducts([]); setSearchFailed(false);
    const timer = setTimeout(() => outboundRequestApi({ command: "products", query }).then(result => {
      if (isCurrent()) { productContext.current = context; setProducts(result.products); }
    }).catch(e => { if (isCurrent()) { setSearchFailed(true); setError(e.message); } }).finally(() => { if (isCurrent()) setSearching(false); }), 300);
    return () => { active = false; clearTimeout(timer); };
  }, [query, inspecting, row?.id]);
  const pageInfo = getListPageSlice(actual, page, 50);
  const listInfo = { showPagination: count > 25, rangeStart: listPage * 25 + 1, rangeEnd: Math.min(count, (listPage + 1) * 25), total: count, currentPage: listPage + 1, totalPages: Math.max(1, Math.ceil(count / 25)) };
  const goList = () => run(async () => { await writes.current; setRow(null); goScreen("list"); changeQuery(""); setProducts([]); setPreview(null); await refreshList(); });
  const resume = () => run(async () => {
    let next = row;
    if (next.status === "uncertain" || next.execution?.flight) next = (await outboundRequestApi({ command: "reconcile", id: row.id, version: row.version })).row;
    applyRow(next); await advance(next);
  });
  const toggleCamera = () => {
    try {
      const scanner = shopify.scanner;
      if (cameraVisible) scanner?.hideCameraScanner?.();
      else if (typeof scanner?.showCameraScanner === "function") scanner.showCameraScanner();
      else throw new Error("カメラを利用できません。POSのカメラ設定を確認するか、商品検索から追加してください。");
      setCameraVisible(!cameraVisible);
    } catch (e) { setError(e.message || "カメラを開けませんでした。POSのカメラ設定を確認してください。"); }
  };
  const footer = !row ? { leftLabel: "再読み込み", onLeft: () => run(() => refreshList()) } : inspecting
    ? { leftLabel: "戻る", onLeft: () => run(async () => { await writes.current; goScreen("detail"); changeQuery(""); }), middleLabel: "検品を保存", onMiddle: save, rightLabel: "出庫完了", onRight: prepare, rightCommand: "--show", rightCommandFor: "outbound-request-differences" }
    : { leftLabel: "一覧へ", onLeft: goList, middleLabel: row.status !== "cancelled" ? "依頼書を印刷" : undefined, onMiddle: print, rightLabel: row.status === "requested" ? "作業を開始" : editable ? "検品を再開" : ["processing", "retryable", "uncertain"].includes(row.status) ? "出庫結果を確認・再開" : undefined, onRight: row.status === "requested" ? claim : editable ? () => goScreen("inspect") : resume };
  return <s-page heading={inspecting ? "出庫依頼の検品" : row ? "出庫依頼の詳細" : "出庫依頼"}>
    {inspecting ? <s-button slot="secondary-actions" disabled={uiBusy} onClick={toggleCamera}>{cameraVisible ? "カメラを閉じる" : "カメラスキャン"}</s-button> : null}
    <s-stack direction="block" blockSize="100%">
      <s-box padding="base"><s-stack direction="block" gap="base">
        <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base"><s-text>ロケーション: {row?.originName || storeName}</s-text>{row ? <s-button disabled={uiBusy} onClick={() => setShowImages(previous => !previous)}>{showImages ? "画像ON" : "画像OFF"}</s-button> : null}</s-stack>
        {!row ? <>
          <s-stack direction="inline" justifyContent="space-between" gap="small"><s-button variant={history ? "secondary" : "primary"} disabled={uiBusy} onClick={() => run(() => refreshList(0, false))}>出庫待ち</s-button><s-button variant={history ? "primary" : "secondary"} disabled={uiBusy} onClick={() => run(() => refreshList(0, true))}>履歴</s-button></s-stack>
          <ListPageControls modern disabled={uiBusy} pageInfo={listInfo} onPageChange={next => run(() => refreshList(next - 1))} />
        </> : <>
          <s-text type="strong">{row.number}</s-text><s-text>移動先: {row.destinationName} / 希望日: {row.dueDate || "指定なし"}</s-text>
          {inspecting ? <><s-search-field placeholder="商品名 / SKU / JAN" value={query} onInput={event => changeQuery(event.currentTarget.value)} disabled={uiBusy} />
            {searching ? <s-text type="small" color="subdued">検索中です。</s-text> : null}
            {!query.trim() ? <ListPageControls modern disabled={uiBusy} pageInfo={pageInfo} onPageChange={setPage} /> : null}
          </> : <s-badge tone={outboundRequestTone(row.status)}>{OUTBOUND_REQUEST_LABELS[row.status]}</s-badge>}
        </>}
      </s-stack></s-box>
      <s-divider />
      <s-scroll-box blockSize="100%"><s-box padding="base"><s-stack direction="block" gap="base">
        {!row ? <>{rows.map(item => <s-clickable key={item.id} disabled={uiBusy} onClick={() => run(() => open(item))}><StockyRowShell><s-stack direction="block" gap="small">
          <s-stack direction="inline" justifyContent="space-between"><s-text type="strong">{item.number}</s-text><s-text type="small">{item.dueDate || "希望日指定なし"}</s-text></s-stack><s-text>移動先: {item.destinationName}</s-text><s-badge tone={outboundRequestTone(item.status)}>{OUTBOUND_REQUEST_LABELS[item.status]}</s-badge>
        </s-stack></StockyRowShell></s-clickable>)}{!rows.length && !busy ? <s-text>出庫依頼はありません。</s-text> : null}</> : <>
          {row.note ? <s-text>{row.note}</s-text> : null}
          {!row.claimed && row.status === "working" ? <s-text>別の端末で作業中です。引き継ぐ場合は管理画面で作業を中止してください。</s-text> : null}
          {inspecting && query.trim() ? <>{!products.length && !searching && !searchFailed ? <s-text>条件に合う商品はありません。</s-text> : null}{!searching ? products.map(product => {
            const requested = row.lines.find(line => line.inventoryItemId === product.inventoryItemId)?.quantity || 0;
            const currentQty = actual.find(line => line.inventoryItemId === product.inventoryItemId)?.quantity || 0;
            const maximum = requested && !settings?.policy.allowOver ? Math.max(1, requested - currentQty) : 999999;
            const value = Math.min(candidateQty[product.variantId] || 1, maximum);
            const disabled = uiBusy || (!requested && !settings?.policy.allowExtra) || (requested > 0 && !settings?.policy.allowOver && currentQty >= requested);
            return <StockyRowShell key={product.variantId}><s-stack direction="block" gap="small">
              <ItemLeftCompact modern showImages={showImages} imageUrl={product.imageUrl} productTitle={product.productTitle || product.title} variantTitle={product.variantTitle} line3={"SKU: " + product.sku + " / JAN: " + product.barcode} />
              <s-stack direction="inline" justifyContent="space-between" alignItems="center"><s-text type="small" color="subdued">依頼 {requested} / 検品 {currentQty}</s-text>
                <QtyControlCompact_3Buttons modern addMode value={value} min={1} max={maximum} title="数量を指定して追加" modalId={"outbound-add-" + product.variantId.split("/").pop()} disabled={disabled} incrementLabel={product.title + "を追加"} onSetQty={quantity => setCandidateQty(previous => ({ ...previous, [product.variantId]: quantity }))} onInc={() => { const context = productContext.current; if (!context || context.epoch !== searchEpoch.current || context.query !== queryRef.current || current.current?.id !== context.rowId || screenRef.current !== "inspect" || lock.current) return; try { add(product, value); } catch (e) { setError(e.message); } }} />
              </s-stack>
            </s-stack></StockyRowShell>;
          }) : null}</> : pageInfo.displayed.map(line => {
            const requested = row.lines.find(item => item.inventoryItemId === line.inventoryItemId)?.quantity || 0;
            const kind = !requested ? "extra" : line.quantity < requested ? "under" : line.quantity > requested ? "over" : null;
            return <StockyRowShell key={line.inventoryItemId}><s-stack direction="block" gap="small">
              <ItemLeftCompact modern showImages={showImages} imageUrl={line.imageUrl} productTitle={line.productTitle || line.title} variantTitle={line.variantTitle} line3={"SKU: " + line.sku + " / JAN: " + line.barcode} />
              <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base"><s-text type="small" color="subdued">依頼 {requested}{requested ? "" : "・依頼外"}</s-text>
                {inspecting ? <QtyControlCompact_3Buttons modern value={line.quantity} min={0} max={requested && !settings?.policy.allowOver ? requested : 999999} modalId={"outbound-qty-" + line.inventoryItemId.split("/").pop()} disabled={uiBusy} onDec={() => patch(line.inventoryItemId, { quantity: Math.max(0, line.quantity - 1) })} onInc={() => patch(line.inventoryItemId, { quantity: line.quantity + 1 })} onSetQty={quantity => patch(line.inventoryItemId, { quantity })} /> : row.status === "requested" ? <s-text color="subdued">未検品</s-text> : <s-text>{row.status === "completed" ? "出庫 " : "検品 "}{line.quantity}</s-text>}
              </s-stack>
              {inspecting && kind && settings?.policy[kind + "Reason"] !== "none" ? <s-text-field label={"理由" + (settings?.policy[kind + "Reason"] === "required" ? "（必須）" : "（任意）")} value={line.reason || ""} disabled={!inspecting || uiBusy} onInput={event => patch(line.inventoryItemId, { reason: event.currentTarget.value })} /> : !inspecting && line.reason ? <s-text type="small" color="subdued">理由: {line.reason}</s-text> : null}
            </s-stack></StockyRowShell>;
          })}
          {!inspecting ? <s-button disabled={uiBusy} onClick={reload}>読み直す</s-button> : null}
          {inspecting ? <>
            <s-divider /><s-text type="strong">配送情報{shipping?.required ? "（必須）" : "（任意）"}</s-text>
            {shipping?.allowCustomCarrier ? <s-text-field label="配送会社" value={tracking.company || ""} disabled={uiBusy} onInput={event => { const next = { ...tracking, company: event.currentTarget.value }; setTracking(next); setPreview(null); persist(draft.current, next); }} /> : <s-stack direction="block" gap="small"><s-button disabled={uiBusy} command="--show" commandFor="outbound-request-carrier">配送会社: {shipping?.carriers.find(carrier => carrier.company === tracking.company)?.label || "選択"}</s-button><s-modal id="outbound-request-carrier" heading="配送会社を選択"><s-box padding="base"><s-stack direction="block" gap="small">{[{ label: "未選択", company: "" }, ...(shipping?.carriers || [])].map(carrier => <s-button key={carrier.company} disabled={uiBusy} command="--hide" commandFor="outbound-request-carrier" onClick={() => { const next = { ...tracking, company: carrier.company }; setTracking(next); setPreview(null); persist(draft.current, next); }}>{carrier.label}</s-button>)}</s-stack></s-box><s-button slot="secondary-actions" command="--hide" commandFor="outbound-request-carrier">戻る</s-button></s-modal></s-stack>}
            <s-text-field label="配送番号" value={tracking.trackingNumber || ""} disabled={uiBusy} onInput={event => { const next = { ...tracking, trackingNumber: event.currentTarget.value }; setTracking(next); setPreview(null); persist(draft.current, next); }} />
            <s-text-field label="追跡URL（任意）" value={tracking.trackingUrl || ""} disabled={uiBusy} onInput={event => { const next = { ...tracking, trackingUrl: event.currentTarget.value }; setTracking(next); setPreview(null); persist(draft.current, next); }} />
            <s-text-field label="到着予定日（YYYY-MM-DD・任意）" value={tracking.arrivesAt ? new Date(tracking.arrivesAt).toLocaleDateString("en-CA") : ""} disabled={uiBusy} onChange={event => { const value = event.currentTarget.value; if (value && !validOutboundDate(value)) { setError("到着予定日を確認してください"); return; } const date = value ? new Date(value + "T12:00:00") : null; const next = { ...tracking, arrivesAt: date ? date.toISOString() : "" }; setTracking(next); setPreview(null); persist(draft.current, next); }} />
          </> : null}
        </>}
      </s-stack></s-box></s-scroll-box>
      <s-divider />
      <FixedFooterNavBar modern {...footer} leftDisabled={uiBusy} middleDisabled={uiBusy} rightDisabled={uiBusy} summaryLeft={row ? "ロケーション: " + row.originName : "ロケーション: " + storeName} summaryRight={row ? "明細 " + actual.length + " / 合計 " + actual.reduce((sum, line) => sum + line.quantity, 0) : count + "件"} notice={error} statusText={busy || scanning ? scanning ? "スキャンを確認しています。" : "処理中です。少しお待ちください。" : ""} />
      <s-modal id="outbound-request-differences" heading={preview?.differences.length ? "数量の差異を確認" : "出庫内容を確認"} ref={confirmRef}>
        <s-scroll-box maxBlockSize="400px"><s-box padding="base"><s-stack direction="block" gap="base"><s-text>移動先: {row?.destinationName}</s-text>{!preview ? <s-text tone={error ? "critical" : "auto"}>{error || "数量と設定を確認しています。"}</s-text> : null}
          {(preview?.differences || []).map(line => <StockyRowShell key={line.inventoryItemId}><s-text>{line.title}・SKU: {line.sku}</s-text><s-text>依頼 {line.requested} → 出庫 {line.quantity}（差分 {line.delta > 0 ? "+" : ""}{line.delta}）</s-text>{line.reason ? <s-text>理由：{line.reason}</s-text> : null}</StockyRowShell>)}
          <s-text>{preview?.lines.length || 0}商品・出庫合計 {preview?.lines.reduce((sum, line) => sum + line.quantity, 0) || 0}点を出庫します。</s-text>
        </s-stack></s-box></s-scroll-box>
        <s-button slot="secondary-actions" command="--hide" commandFor="outbound-request-differences" disabled={busy}>戻る</s-button>
        <s-button slot="primary-action" variant="primary" disabled={busy || !preview} command="--hide" commandFor="outbound-request-differences" onClick={confirm}>確認して出庫</s-button>
      </s-modal>
    </s-stack>
  </s-page>;
}
