import { reservationReceiptNotice } from "../../common/reservationReceipt.js";
import { japanesePhoneDisplay } from "../../common/customerDisplay.js";
import { ReservationCustomerScreen } from "./CustomerPicker.jsx";
import { ReservationPageControls } from "./HistoryControls.jsx";
import { ReservationProductRow } from "./ProductRow.jsx";
import { addReservationProduct, exactScanProduct, createReservationScanQueue } from "./productList.js";
import { getListPageSlice } from "../../common/listDisplayPagination.js";
/* global globalThis */
import "../../common/remoteDomSiblingFix.js";
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { locationId, reservationApi, printReservation } from "./api.js";
import { appendProductToDraft, createReservationDraftWriter, loadProductReservationDraft, restoreReservationInputDraft } from "./productEntry.js";
import { handoffReservationCart, RESERVATION_LABELS, reservationStatusTone, reservationDisplayNumber, reservationIntakeLabel, RESERVATION_PROPERTY, RESERVATION_ID_PROPERTY, CHECKOUT_PROPERTY } from "../../common/reservations.js";

const DRAFT_KEY = "pos_stock_reservation_draft_v1";
const newId = () => `R-${crypto.randomUUID()}`;
export default async () => render(<ReservationModal />, document.body);
/** @param {{ fromProduct?: boolean, initialProduct?: { id: number, variantId: number } | null }} props */
// Preact component props are documented above and checked by the local SDK build.
// eslint-disable-next-line react/prop-types
export function ReservationModal({ fromProduct = false, initialProduct = null }) {
  const confirmRegistrationRef = useRef(null);
  const [receiptOptions, setReceiptOptions] = useState(null);
  const [screen, setScreenState] = useState("create");
  const [rows, setRows] = useState([]);
  const [mode, setMode] = useState("due");
  const [query, setQuery] = useState("");
  const [queryInput, setQueryInput] = useState("");
  const [page, setPage] = useState(0);

  const [detail, setDetail] = useState(null);
  const [draft, setDraft] = useState({ id: newId(), lines: [], name: "", phone: "", faceToFace: true, print: false, memberPhone: "", memberPhoneCustomerId: "" });
  const [products, setProducts] = useState([]);
  const [pendingProduct, setPendingProduct] = useState(null);
  const [search, setSearch] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchLoaded, setSearchLoaded] = useState(false);
  const [scanBusy, setScanBusy] = useState(false);
  const [images, setImages] = useState(true);
  const [cameraVisible, setCameraVisible] = useState(false);
  const [productPage, setProductPage] = useState(1);
  const [candidateLimit, setCandidateLimit] = useState(20);
  const [limits, setLimits] = useState({ searchLimit: 50, productLimit: 250 });
  const [productPageInfo, setProductPageInfo] = useState({ hasNextPage: false, endCursor: null });
  const searchRevision = useRef(0);
  const listRevision = useRef(0);
  const pendingListRefresh = useRef(null);
  const screenRef = useRef("create");
  const scanQueueRef = useRef(null);
  const setScreen = useCallback(next => {
    searchRevision.current += 1; listRevision.current += 1; pendingListRefresh.current = null;
    scanQueueRef.current?.stop();
    if (screenRef.current === "products" && next !== "products") { shopify.scanner?.hideCameraScanner?.(); setCameraVisible(false); setScanBusy(false); }
    screenRef.current = next;
    setScreenState(next);
  }, []);
  const [followDate, setFollowDate] = useState("");
  const [orderSearch, setOrderSearch] = useState("");
  const [orders, setOrders] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [addingToCart, setAddingToCart] = useState(false);
  const [submitted, setSubmitted] = useState(null);
  const [ready, setReady] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [updatedAt, setUpdatedAt] = useState("");
  const [total, setTotal] = useState(0);
  const [listLoaded, setListLoaded] = useState(false);
  const [allTotal, setAllTotal] = useState(0);
  const [slow, setSlow] = useState(false);
  const [storeLabel, setStoreLabel] = useState("");
  const [customerId, setCustomerId] = useState(() => shopify.cart.current.value.customer?.id || null);
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const customerIdRef = useRef(customerId);
  const sessionRevision = useRef(0);
  const [sessionNotice, setSessionNotice] = useState("");
  const [sessionLoading, setSessionLoading] = useState(true);
  const storeName = detail?.locationName || storeLabel || rows[0]?.locationName || "店舗名を読み込み中…";
  useEffect(() => {
    const current = shopify.cart.current;
    const update = cart => { const next = cart.customer?.id || null; if (customerIdRef.current !== next) { customerIdRef.current = next; sessionRevision.current += 1; setSelectedCustomer(null); setCustomerId(next); } };
    update(current.value);
    return current.subscribe?.(update);
  }, []);
  useEffect(() => {
    let alive = true;
    const refreshSession = async () => {
      if (customerIdRef.current !== customerId) return;
      const request = ++sessionRevision.current;
      setSessionLoading(true);
      try {
        const result = await reservationApi({ command: "sessionDisplay", locationId: draftLocation.current, customerId: customerId ? `gid://shopify/Customer/${customerId}` : null });
        if (!alive || request !== sessionRevision.current || customerIdRef.current !== customerId) return;
        setStoreLabel(result.locationName); setSelectedCustomer(result.customer); setSessionNotice(result.notice || "");
      } catch (error) { if (alive && request === sessionRevision.current && customerIdRef.current === customerId) { setSessionNotice(error.message); setStoreLabel(previous => previous || "店舗名を取得できません"); } }
      finally { if (alive && request === sessionRevision.current && customerIdRef.current === customerId) setSessionLoading(false); }
    };
    void refreshSession(); globalThis.addEventListener?.("focus", refreshSession);
    return () => { alive = false; globalThis.removeEventListener?.("focus", refreshSession); };
  }, [customerId]);
  useEffect(() => {
    const value = queryInput.trim();
    const timer = setTimeout(() => { setQuery(value.length >= 2 ? value : ""); setPage(0); }, 300);
    return () => clearTimeout(timer);
  }, [queryInput]);
  useEffect(() => { if (!busy && !searching && !scanBusy) { setSlow(false); return; } const timer = setTimeout(() => setSlow(true), 10000); return () => clearTimeout(timer); }, [busy, searching, scanBusy]);
  const lock = useRef(false);
  const draftReady = useRef(false);
  const draftLocation = useRef(locationId());
  const storageKey = `${DRAFT_KEY}:${draftLocation.current}`;
  const writer = useMemo(() => createReservationDraftWriter(shopify.storage, storageKey), [storageKey]);
  const latestDraft = useRef(draft);
  latestDraft.current = submitted || draft;
  const run = useCallback(async fn => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try { await fn(); } catch (e) {
      if (e && typeof e === "object" && "resetAllowed" in e && e.resetAllowed === true) { setSubmitted(null); setDraft(previous => ({ ...previous, submitted: false })); }
      setError((e instanceof Error ? e.message : "") || "操作できませんでした。もう一度確認してください");
    }
    finally { lock.current = false; setBusy(false); const pending = pendingListRefresh.current; pendingListRefresh.current = null; if (pending && screenRef.current === "list") void pending(); }
  }, []);
  useEffect(() => {
    let alive = true;
    const restore = async () => {
      if (fromProduct) {
        lock.current = true; setBusy(true);
      }
      try {
        const result = fromProduct
          ? await loadProductReservationDraft({ storage: shopify.storage, storageKey, product: initialProduct, productSearch: shopify.productSearch, createDraft: () => ({ id: newId(), lines: [], name: "", phone: "", faceToFace: true, print: false, memberPhone: "", memberPhoneCustomerId: "" }) })
          : { draft: await shopify.storage.get(storageKey), kind: "ready" };
        if (!alive) return;
        if (result.draft) {
          latestDraft.current = result.draft;
          setDraft(restoreReservationInputDraft(result.draft));
          if (result.draft.submitted) setSubmitted(result.draft);
        }
        if (result.kind === "confirm") { setPendingProduct(result.line); setScreen("product-choice"); }
        if (result.kind === "submitted") setError("前回の取置の登録結果を確認してください。今回の商品は追加していません。");
        draftReady.current = true; setReady(true);
      } catch (e) {
        if (alive) setError(e instanceof Error && /[\u3040-\u30ff\u4e00-\u9fff]/.test(e.message) ? e.message : "商品または前回の下書きを読み込めません。画面を閉じて開き直してください");
      } finally {
        if (fromProduct && alive) { lock.current = false; setBusy(false); }
      }
    };
    restore();
    return () => { alive = false; };
  }, [storageKey, fromProduct, initialProduct, setScreen]);
  useEffect(() => { if (draftReady.current) writer.save(latestDraft.current).catch(e => setError(e.message)); }, [draft, submitted, writer]);
  const refresh = useCallback(async () => {
    const revision = ++listRevision.current;
    setListLoaded(false);
    let result;
    try { result = await reservationApi({ command: "list", mode, query, page }); }
    catch (error) { if (revision !== listRevision.current || screenRef.current !== "list") return; throw error; }
    if (revision !== listRevision.current || screenRef.current !== "list") return;
    setListLoaded(true); setRows(result.rows); if (Number.isInteger(result.page) && result.page !== page) setPage(result.page); setTotal(result.total); setAllTotal(result.allTotal ?? result.total); setUpdatedAt(new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date()));
  }, [mode, query, page]);
  useEffect(() => {
    if (screen !== "list") return;
    const load = () => { if (lock.current) pendingListRefresh.current = () => run(refresh); else void run(refresh); };
    load();
    const timer = setInterval(load, 60000);
    const focus = load;
    globalThis.addEventListener?.("focus", focus);
    globalThis.document?.addEventListener?.("visibilitychange", focus);
    return () => { listRevision.current += 1; clearInterval(timer); globalThis.removeEventListener?.("focus", focus); globalThis.document?.removeEventListener?.("visibilitychange", focus); };
  }, [screen, refresh, run]);
  const patch = value => {
    if (submitted || lock.current || !ready) return;
    const next = { ...latestDraft.current, ...value };
    latestDraft.current = next; setDraft(next);
  };
  const customerChange = customer => {
    let changed = false;
    return run(async () => {
      if (!ready || submitted || !["create", "customers"].includes(screenRef.current)) throw new Error("受付画面でお客様を確認してください");
      if (locationId() !== draftLocation.current) throw new Error("POS店舗が変わっています。元の店舗で開いてください");
      const cart = shopify.cart.current.value;
      if (cart.editable === false || cart.properties?.[RESERVATION_PROPERTY] || cart.properties?.[RESERVATION_ID_PROPERTY] || cart.properties?.[CHECKOUT_PROPERTY]) throw new Error("取置の会計中です。カートのお会計を先に完了してください");
      if (customer) {
        const id = Number(customer.id.split("/").pop());
        if (!Number.isSafeInteger(id) || id <= 0) throw new Error("お客様を選び直してください");
        await shopify.cart.setCustomer({ id });
      } else await shopify.cart.removeCustomer();
      changed = true; if (customer) setScreen("create");
    }).then(() => changed);
  };
  useEffect(() => {
    if (screen !== "create" && screen !== "detail" && screen !== "actions") return;
    let alive = true;
    setReceiptOptions(null);
    reservationApi({ command: "receiptOptions" }).then(result => { if (alive) setReceiptOptions(result); }).catch(error => { if (alive) setError(error.message); });
    return () => { alive = false; };
  }, [screen]);
  const open = row => run(async () => { const result = await reservationApi({ command: "detail", id: row.id }); setDetail(result.row); setConfirm(false); setScreen("detail"); });
  useEffect(() => {
    if (screen !== "products") return;
    let alive = true;
    reservationApi({ command: "productSettings" }).then(data => { if (alive) setLimits({ searchLimit: data.searchLimit, productLimit: data.productLimit }); }).catch(() => { if (alive) setError("表示件数の設定を取得できません。標準件数で表示します。"); });
    return () => { alive = false; };
  }, [screen]);
  useEffect(() => {
    if (screen !== "products" || submitted || !ready || !latestDraft.current.lines.length) return;
    let alive = true;
    reservationApi({ command: "products", ids: latestDraft.current.lines.map(line => line.variantId), images }).then(data => {
      if (!alive || lock.current || screenRef.current !== "products") return;
      const found = data.products;
      const next = { ...latestDraft.current, lines: latestDraft.current.lines.map(line => { const product = found.find(product => product.id === line.variantId); return product ? { ...line, title: product.displayName, productTitle: product.productTitle, variantTitle: product.variantTitle, sku: product.sku, barcode: product.barcode, imageUrl: product.imageUrl, available: product.available, eligible: product.eligible } : line; }) };
      latestDraft.current = next; setDraft(next);
    }).catch(() => { if (alive) setError("商品の在庫・画像を取得できません。数量は保持しています。"); });
    return () => { alive = false; };
  }, [screen, images, submitted, ready]);
  const searchProducts = useCallback(async (value, after = null) => {
    const revision = ++searchRevision.current;
    setSearching(true); setError("");
    if (!after) { setSearchLoaded(false); setProducts([]); setProductPageInfo({ hasNextPage: false, endCursor: null }); }
    try {
      const data = await reservationApi({ command: "products", query: value, after, first: limits.searchLimit, images });
      if (revision !== searchRevision.current) return;
      setSearchLoaded(true);
      setProducts(previous => after ? [...new Map([...previous, ...data.products].map(product => [product.id, product])).values()] : data.products);
      setProductPageInfo(data.pageInfo);
      if (!after) setProductPage(1);
    } catch (error) { if (revision === searchRevision.current) { setError(error.message); if (!after) setProducts([]); } }
    finally { if (revision === searchRevision.current) setSearching(false); }
  }, [images, limits.searchLimit]);
  useEffect(() => {
    searchRevision.current += 1;
    setSearchLoaded(false);
    if (screen !== "products" || !search.trim()) { setProducts([]); setProductPageInfo({ hasNextPage: false, endCursor: null }); setSearching(false); return; }
    setSearching(true);
    const timer = setTimeout(() => { void searchProducts(search); }, 300);
    return () => { clearTimeout(timer); searchRevision.current += 1; };
  }, [screen, search, searchProducts]);
  const addProduct = useCallback(product => {
    if (submitted || lock.current || !draftReady.current || screenRef.current !== "products") return false;
    const next = addReservationProduct(latestDraft.current, product);
    latestDraft.current = next; setDraft(next); return true;
  }, [submitted]);
  const add = (product, quantity = 1) => {
    if (submitted || lock.current || !ready) return;
    try { const next = addReservationProduct(latestDraft.current, product, quantity); latestDraft.current = next; setDraft(next); setError(""); }
    catch (error) { setError(error.message); }
  };
  const setQuantity = (id, quantity) => {
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 9999) { setError("数量は1〜9999の整数で入力してください"); return; }
    patch({ lines: latestDraft.current.lines.map(line => line.variantId === id ? { ...line, quantity } : line) });
  };
  useEffect(() => {
    if (screen !== "products" || submitted || !ready) return;
    const scanner = createReservationScanQueue({
      resolve: async code => { setScanBusy(true); const result = await reservationApi({ command: "products", query: code, scan: true, images, first: 50 }); return exactScanProduct(code, result.products, result.pageInfo); },
      commit: product => { const added = addProduct(product); setScanBusy(false); if (added) shopify.toast.show("商品を追加しました（+1）"); },
      onError: error => { setScanBusy(false); setError(error.message); },
    });
    scanQueueRef.current = scanner;
    const unsubscribe = shopify.scanner?.scannerData?.current?.subscribe?.(value => scanner.enqueue(value?.data));
    return () => { scanner.stop(); if (scanQueueRef.current === scanner) scanQueueRef.current = null; unsubscribe?.(); shopify.scanner?.hideCameraScanner?.(); setCameraVisible(false); setScanBusy(false); };
  }, [screen, submitted, ready, images, addProduct]);
  const toggleCamera = () => {
    try { if (cameraVisible) shopify.scanner.hideCameraScanner(); else shopify.scanner.showCameraScanner(); setCameraVisible(!cameraVisible); }
    catch { setError("カメラを開けません。POSのカメラ権限を確認してください"); }
  };
  const changeSearch = value => { searchRevision.current += 1; setProducts([]); setProductPageInfo({ hasNextPage: false, endCursor: null }); setSearch(value); setCandidateLimit(20); };
  const displayedCandidates = products.slice(0, candidateLimit);
  const selectedLines = getListPageSlice(draft.lines, productPage, Math.min(50, limits.productLimit));

  const save = () => run(async () => {
    if (!ready) throw new Error("前回の下書きを確認しています");
    const customer = shopify.cart.current.value.customer;
    if (!submitted && String(customer?.id || "") !== String(customerId || "")) throw new Error("POSのお客様が変わりました。受付画面から確認してください");
    const payload = submitted || { ...latestDraft.current, guestDraftPhone: draft.phone, submitted: true, locationId: draftLocation.current, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, customerId: customer?.id ? `gid://shopify/Customer/${customer.id}` : null, phone: customer?.id ? (latestDraft.current.memberPhoneCustomerId === String(customer.id) ? latestDraft.current.memberPhone || "" : "") : latestDraft.current.phone };
    // Persist the exact submitted draft before sending. Retrying always reuses its registration number.
    const previousSubmitted = submitted;
    latestDraft.current = payload; setSubmitted(payload);
    try { await writer.save(payload); }
    catch (e) { latestDraft.current = previousSubmitted || draft; setSubmitted(previousSubmitted); throw e; }
    const data = await reservationApi({ command: "create", ...payload });
    setDetail(data.row);
    if (data.row.status === "held") {
      const empty = { id: newId(), lines: [], name: "", phone: "", faceToFace: true, print: false, memberPhone: "", memberPhoneCustomerId: "" };
      latestDraft.current = empty; setSubmitted(null); setDraft(empty);
      try { await writer.save(empty); } catch { setError("取置は登録済みです。下書きの消去を確認できませんでした。同じ番号で結果を確認してください"); }
      shopify.toast.show("取置を登録しました。商品を取置棚へ移してください");
      try {
        const options = await reservationApi({ command: "receiptOptions" });
        if (options.customerCopy && data.row.intakeMethod !== "inquiry") await printReservation(data.row, "customer");
      } catch { setError("取置は登録済みです。お客様控えを印刷できませんでした。詳細の「連絡・印刷」から再印刷してください"); }
    }
    setScreen("detail");
  });
  const command = (name, extra = {}) => run(async () => {
    const result = await reservationApi({ command: name, id: detail.id, version: detail.version, ...extra });
    setDetail(result.row); setConfirm(false);
    if (name === "cancel") setScreen("detail");
    if (name === "resume" && result.row.status === "held" && draft.id === result.row.id) {
      const empty = { id: newId(), lines: [], name: "", phone: "", faceToFace: true, print: false, memberPhone: "", memberPhoneCustomerId: "" };
      latestDraft.current = empty; setSubmitted(null); setDraft(empty);
      await writer.save(empty);
    }
  });
  const checkout = () => run(async () => {
    setAddingToCart(true);
    try {
      await reservationApi({ command: "checkoutAccess" });
      await handoffReservationCart(detail, shopify, reservationApi, setDetail);
      shopify.toast.show("取置商品をカートへ追加しました。カートでお会計してください");
      await shopify.action.dismissModal();
    } finally { setAddingToCart(false); }
  });
  const notice = error || sessionNotice || detail?.lastError;
  const canAddToCart = screen === "detail" && ["held", "checkout"].includes(detail?.status) && !confirm;
  const back = () => {
    if (fromProduct) {
      run(async () => {
        if (ready) await writer.save(latestDraft.current);
        await shopify.action.dismissModal();
      });
      return;
    }
    setScreen("list"); setDetail(null); setError("");
  };
  const confirmProduct = () => run(async () => {
    if (!pendingProduct) return;
    setDraft(appendProductToDraft(draft, pendingProduct));
    setPendingProduct(null); setScreen("create");
  });
  const goBack = () => {
    if (screen === "products") { setScreen("create"); setError(""); return; }
    if (screen === "cancel" || screen === "actions") { setScreen("detail"); setConfirm(false); setError(""); return; }
    if (screen === "list") { setScreen("create"); setError(""); return; }
    if (screen === "create" || (screen === "detail" && detail?.endedAt)) { run(async () => { if (ready) await writer.save(latestDraft.current); await shopify.action.dismissModal(); }); return; }
    back();
  };
  const next = () => {
    if (submitted) { void save(); return; }
    if (!shopify.cart.current.value.customer?.id && (!draft.name.trim() || !draft.phone.trim())) { setError("お名前と電話番号を入力してください"); return; }
    setError(""); setScreen("products");
  };
  const titles = { create: "取置の受付", products: "取置する商品", list: "取置履歴", detail: "取置の詳細", actions: "連絡・印刷", cancel: "取置を解除", "product-choice": "商品を追加" };
  let primary = null;
  if (screen === "create") primary = <s-button variant="primary" disabled={busy || !ready} loading={busy} onClick={next}>{busy ? "処理中…" : submitted ? "登録結果を確認" : "次へ"}</s-button>;
  if (screen === "products") primary = <s-button variant="primary" disabled={busy || scanBusy || !ready || !draft.lines.length} command="--show" commandFor="reservation-register-confirm" loading={busy} onClick={() => setError("")}>{busy ? "処理中..." : "確定"}</s-button>;

  if (screen === "list") primary = <s-button variant="primary" disabled={busy || !ready} onClick={() => setScreen("create")}>取置を登録</s-button>;
  if (screen === "product-choice") primary = <s-button variant="primary" disabled={busy || !ready} onClick={confirmProduct}>この商品を追加</s-button>;
  if (canAddToCart) primary = <s-button variant="primary" disabled={busy} loading={addingToCart} onClick={checkout}>{addingToCart ? "追加中…" : "カートへ追加"}</s-button>;
  if (screen === "cancel") primary = <s-button variant="primary" tone="critical" disabled={busy} onClick={() => command("cancel")}>{busy ? "解除中…" : "取置を解除"}</s-button>;
  if (screen === "detail" && ["reserving", "cancelling", "completing"].includes(detail?.status)) primary = <s-button variant="primary" disabled={busy} onClick={() => command("resume")}>反映を確認</s-button>;

  if (screen === "customers") return <s-page heading="お客様を選択"><ReservationCustomerScreen locationId={draftLocation.current} storeName={storeName} busy={busy || !ready || Boolean(submitted)} selectionError={error} onSelect={customerChange} onBack={() => { setError(""); setScreen("create"); }} /></s-page>;

  return <s-page heading={titles[screen] || "取置"}>
    {screen === "products" ? <s-button slot="secondary-actions" disabled={busy || scanBusy || Boolean(submitted)} onClick={toggleCamera}>{cameraVisible ? "カメラを閉じる" : "カメラスキャン"}</s-button> : null}
    <s-stack gap="none" blockSize="100%" inlineSize="100%" minBlockSize="0">
      <s-box padding="base"><s-stack gap="small" direction="block">
        {busy || searching || scanBusy ? <s-text type="small">読み込み中です。少しお待ちください。</s-text> : null}
        {screen === "list" ? <>
          <s-text-field label="取置番号・名前で検索" value={queryInput} onInput={e => setQueryInput(e.currentTarget.value)} />
          {queryInput.trim().length === 1 ? <s-text type="small">あと1文字入力すると検索します。</s-text> : null}
          <s-text type="small">登録日時が古い順に表示します。</s-text>
          <s-stack direction="inline" gap="none" inlineSize="100%">{[["due", "要対応"], ["active", "取置中"], ["ended", "終了"]].map(([value, label]) => <s-box key={value} inlineSize="33.33%"><s-button variant={mode === value ? "primary" : "secondary"} disabled={busy} onClick={() => { setMode(value); setPage(0); }}>{label}</s-button></s-box>)}</s-stack>
          <s-text>{storeName}・{updatedAt ? `${updatedAt} に更新` : "まだ更新していません"}</s-text>

        </> : <>
          <s-stack direction="inline" justifyContent="space-between"><s-text>店舗: {storeName}</s-text>{screen === "products" ? <s-button disabled={busy || scanBusy} onClick={() => setImages(!images)}>{images ? "画像ON" : "画像OFF"}</s-button> : null}</s-stack>
          {screen === "products" ? <>
            <s-box inlineSize="100%" paddingBlockStart="small-200"><s-search-field placeholder="商品名 / SKU / バーコード" value={search} onInput={event => changeSearch(event.currentTarget.value)} onChange={event => changeSearch(event.currentTarget.value)} /></s-box>
            <s-text>{search.trim() ? `検索結果: ${products.length}件` : `追加済み: ${draft.lines.length}件`}</s-text>
          </> : null}
        </>}
      </s-stack></s-box><s-divider />
      <s-scroll-box padding="none" blockSize="auto" maxBlockSize="100%" minBlockSize="0"><s-box padding="base"><s-stack gap={screen === "products" ? "none" : "base"} direction="block">
      {screen === "list" ? <>
        {listLoaded ? <ReservationPageControls page={page} total={total} disabled={busy} onChange={setPage} /> : <s-text>一覧を取得できていません。</s-text>}
        {listLoaded && !rows.length && !busy ? <><s-text>条件に合う取置はありません。対象の全体は{allTotal}件です。</s-text><s-button onClick={() => { setMode("active"); setQuery(""); setQueryInput(""); setPage(0); }}>すべて表示する</s-button></> : null}
        {(listLoaded ? rows : []).map(row => <s-box key={row.id}><s-clickable onClick={() => open(row)} disabled={busy}><s-box padding="base"><s-stack gap="small" direction="block">
          <s-stack direction="inline" justifyContent="space-between"><s-text type="strong">{reservationDisplayNumber(row)} ›</s-text><s-text>登録 {new Date(row.createdAt).toLocaleDateString("ja-JP", { timeZone: row.timezone || "Asia/Tokyo" })}</s-text></s-stack>
          <s-text>受取期限: {row.dueDate}</s-text><s-text>{row.name}・{japanesePhoneDisplay(row.phone)}</s-text><s-text>店舗: {row.locationName}</s-text>
          <s-stack direction="inline" justifyContent="space-between"><s-badge tone={row.needsFollowUp ? "warning" : reservationStatusTone(row.status)}>{row.needsFollowUp ? "要対応" : RESERVATION_LABELS[row.status]}</s-badge><s-text>{row.lines.length}件・合計{row.lines.reduce((sum, line) => sum + line.quantity, 0)}点</s-text></s-stack>
        </s-stack></s-box></s-clickable><s-divider /></s-box>)}
      </> : null}
      {screen === "product-choice" ? <>
        <s-text type="strong">入力中の取置があります</s-text>
        {draft.name ? <s-text>お名前 {draft.name}</s-text> : null}
        {draft.lines.map(line => <s-text key={line.variantId}>{line.title} × {line.quantity}</s-text>)}
        <s-text>追加する商品: {pendingProduct?.title} × 1</s-text>
        <s-text>入力済みのお名前や商品を残したまま追加します。</s-text>
        <s-button disabled={busy} onClick={() => { setPendingProduct(null); setScreen("create"); }}>入力中の取置を続ける</s-button>
      </> : null}
      {screen === "create" ? <>
        {customerId ? <>
          <s-text type="small" color="subdued">お客様</s-text><s-text type="strong">{selectedCustomer?.name || "POSでお客様を選択済みです"}</s-text>
          {selectedCustomer?.phone ? <s-text>{japanesePhoneDisplay(selectedCustomer.phone)}</s-text> : null}
          {!selectedCustomer ? <s-text type="small">{sessionLoading ? "お客様の情報を確認しています。" : "お客様の情報を取得できませんでした。表示された理由を確認してください。"}</s-text> : null}
          {selectedCustomer?.hasPhone === false ? <s-text-field disabled={busy || !ready || Boolean(submitted)} label="連絡用の電話番号（未登録）" value={draft.memberPhoneCustomerId === String(customerId) ? draft.memberPhone || "" : ""} onInput={e => patch({ memberPhone: e.currentTarget.value, memberPhoneCustomerId: String(customerId) })} /> : null}
          <s-stack direction="inline" justifyContent="space-between"><s-button disabled={busy || !ready || Boolean(submitted)} onClick={() => { setError(""); setScreen("customers"); }}>お客様を変更</s-button><s-button tone="critical" disabled={busy || !ready || Boolean(submitted)} onClick={() => customerChange(null)}>カートから解除</s-button></s-stack><s-text type="small" color="subdued">お客様の登録情報は削除されません。</s-text>
        </> : <>
          <s-text type="strong">お客様</s-text><s-button disabled={busy || !ready || Boolean(submitted)} onClick={() => { setError(""); setScreen("customers"); }}>お客様を選択</s-button><s-text type="small" color="subdued">既存のお客様を選ぶか、ゲストのお名前と電話番号を入力してください。</s-text>
          <s-text-field disabled={busy || !ready || Boolean(submitted)} label="ゲストのお名前" value={draft.name} onInput={e => patch({ name: e.currentTarget.value })} />
          <s-text-field disabled={busy || !ready || Boolean(submitted)} label="取置用の電話番号" value={draft.phone} onInput={e => patch({ phone: e.currentTarget.value })} />
        </>}
      </> : null}
      {screen === "products" ? <>
        {search.trim() && searchLoaded && !searching && !products.length ? <s-text>一致する商品はありません。</s-text> : null}
        {!search.trim() && !draft.lines.length ? <s-text>商品名・SKU・バーコードで検索するか、スキャンして追加してください。</s-text> : null}
        {search.trim() ? <><s-stack gap="small-400">{displayedCandidates.map(product => <ReservationProductRow key={product.id} product={product} images={images} candidate disabled={busy || scanBusy || !ready || Boolean(submitted)} quantity={draft.lines.find(line => line.variantId === product.id)?.quantity || 0} onAdd={quantity => add(product, quantity)} />)}</s-stack>
          {products.length > candidateLimit ? <s-box padding="small"><s-button disabled={busy} onClick={() => setCandidateLimit(previous => previous + 20)}>さらに表示（残り {products.length - candidateLimit}件）</s-button></s-box> : null}
          {productPageInfo.hasNextPage ? <s-box padding="small"><s-button disabled={searching} onClick={() => searchProducts(search, productPageInfo.endCursor)}>{searching ? "読込中..." : "さらに読み込む"}</s-button></s-box> : null}
          {products.length ? <s-divider /> : null}
        </> : null}
        {draft.lines.length ? <s-stack gap="none"><s-text type="strong">取置リスト</s-text>
          <s-box blockSize="8px" />
          {selectedLines.showPagination ? <><s-stack direction="inline" gap="base" justifyContent="space-between"><s-button disabled={busy || selectedLines.currentPage <= 1} onClick={() => setProductPage(selectedLines.currentPage - 1)}>前へ</s-button><s-text>{selectedLines.rangeStart}〜{selectedLines.rangeEnd} / {selectedLines.total}件</s-text><s-button disabled={busy || selectedLines.currentPage >= selectedLines.totalPages} onClick={() => setProductPage(selectedLines.currentPage + 1)}>次へ</s-button></s-stack><s-box blockSize="8px" /></> : null}
          {selectedLines.displayed.map(product => <ReservationProductRow key={product.variantId} product={product} images={images} disabled={busy || scanBusy || !ready || Boolean(submitted)} quantity={product.quantity} onSet={quantity => setQuantity(product.variantId, quantity)} onRemove={() => patch({ lines: latestDraft.current.lines.filter(line => line.variantId !== product.variantId) })} />)}
        </s-stack> : <s-text color="subdued">まだ追加されていません</s-text>}
      </> : null}
      {screen === "create" ? <>
        <s-divider /><s-text type="small" color="subdued">受付方法</s-text><s-switch disabled={busy || !ready || Boolean(submitted)} label={draft.faceToFace ? "店頭で受付" : "お問い合わせでの受付"} checked={draft.faceToFace} onChange={e => patch({ faceToFace: e.currentTarget.checked, print: false })} />
        {reservationReceiptNotice(receiptOptions, draft.faceToFace) ? <s-text type="small" color="subdued">{reservationReceiptNotice(receiptOptions, draft.faceToFace)}</s-text> : null}
        <s-text>保存すると販売可能在庫から取置分を確保します。</s-text>

        {submitted ? <s-text>送信済みの内容を保持しています。再度登録を押すと同じ番号で結果を確認します。</s-text> : null}
      </> : null}
      {screen === "cancel" && detail ? <><s-text>表示した商品の取置を解除し、販売可能在庫に戻します。</s-text>{detail.lines.map(line => <s-text key={line.variantId}>{line.title} × {line.quantity}</s-text>)}</> : null}
      {(screen === "detail" || screen === "actions") && detail ? <>
        <s-text type="strong">{reservationDisplayNumber(detail)}</s-text><s-badge tone={detail.needsFollowUp ? "warning" : reservationStatusTone(detail.status)}>{RESERVATION_LABELS[detail.status]}</s-badge>
        <s-text>{detail.name}</s-text><s-text>{japanesePhoneDisplay(detail.phone)}</s-text>{!detail.contactVisible ? <s-text>連絡先の確認には権限が必要です。</s-text> : null}
        <s-text>{reservationIntakeLabel(detail)}</s-text><s-text>{detail.locationName}・受取期限 {detail.dueDate}</s-text>
        {detail.lines.map(line => <s-text key={line.variantId}>{line.title} × {line.quantity}</s-text>)}
        {detail.nextFollowDate ? <s-text>次回確認 {detail.nextFollowDate}</s-text> : null}
        {detail.events.map(event => <s-text key={event.id}>{new Date(event.createdAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}・{event.kind === "unreachable" ? "不通" : event.kind === "planned" ? "来店予定" : RESERVATION_LABELS[event.kind] || "対応記録"}・担当 {event.actor}{event.followDate ? `・次回 ${event.followDate}` : ""}</s-text>)}

        {screen === "actions" && detail.status === "held" ? <>
          <s-button disabled={busy} onClick={() => command("unreachable")}>不通を記録</s-button>
          <s-text-field label="次回確認日（YYYY-MM-DD）" value={followDate} onInput={e => setFollowDate(e.currentTarget.value)} />
          <s-button disabled={busy} onClick={() => command("planned", { followDate })}>来店予定を記録</s-button>
          <s-button disabled={busy} onClick={() => { setConfirm(true); setScreen("cancel"); }}>取置を解除</s-button>
        </> : null}
        {screen === "actions" && detail.status === "checkout" ? <>
          <s-text-field label="決済後の注文番号" value={orderSearch} onInput={e => setOrderSearch(e.currentTarget.value)} />
          <s-button disabled={busy} onClick={() => run(async () => { const result = await reservationApi({ command: "orders", query: orderSearch }); setOrders(result.orders); })}>注文を探す</s-button>
          {orders.map(order => <s-button key={order.id} disabled={busy} onClick={() => command("complete", { orderId: order.id })}>{order.name}を照合</s-button>)}
        </> : null}
        {screen === "detail" ? <s-button disabled={busy} onClick={() => setScreen("actions")}>連絡・印刷</s-button> : null}
        {screen === "actions" && ["held", "checkout", "sold", "cancelled"].includes(detail.status) ? <>
          {receiptOptions?.customerCopy && detail.intakeMethod !== "inquiry" ? <s-button disabled={busy} onClick={() => run(async () => { await printReservation(detail, "customer"); shopify.toast.show("お客様控えの印刷を送信しました"); })}>お客様控えを印刷</s-button> : null}
          {receiptOptions?.storeCopy ? <s-button disabled={busy} onClick={() => run(async () => { await printReservation(detail, "store"); shopify.toast.show("店舗控えの印刷を送信しました"); })}>店舗控えを印刷</s-button> : null}
        </> : null}
        {detail.status === "failed" ? <s-button disabled={busy} onClick={() => { setSubmitted(null); setDraft(previous => ({ ...previous, submitted: false, id: newId() })); setScreen("create"); setDetail(null); }}>内容を直して登録</s-button> : null}
        {detail.endedAt ? <s-text>終了 {new Date(detail.endedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}・担当 {detail.endedBy}</s-text> : null}
      </> : null}
    </s-stack></s-box></s-scroll-box>
    <s-divider />
    <s-box padding="base"><s-stack gap="base" direction="block">
      {screen !== "products" ? <s-stack direction="inline" justifyContent="space-between"><s-text>店舗: {storeName}</s-text>{screen === "list" ? <s-text>{listLoaded ? `${total}件` : "未取得"}</s-text> : <s-text>{detail && ["detail", "actions", "cancel"].includes(screen) ? detail.lines.length : draft.lines.length}件</s-text>}</s-stack> : null}
      {notice ? <s-text tone="critical">{notice}</s-text> : null}
      {canAddToCart ? <s-text>追加後はPOSのカートでお会計してください。</s-text> : null}
      <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
        <s-button variant="secondary" onClick={goBack} disabled={busy}>{screen === "cancel" ? "やめる" : screen === "detail" && detail?.endedAt ? "閉じる" : "戻る"}</s-button>
        {screen === "create" ? <s-button disabled={busy} onClick={() => { setScreen("list"); setDetail(null); setError(""); }}>履歴一覧</s-button> : screen === "detail" && receiptOptions?.storeCopy && ["held", "checkout", "sold", "cancelled"].includes(detail?.status) ? <s-button disabled={busy} onClick={() => run(async () => { await printReservation(detail, "store"); shopify.toast.show("店舗控えの印刷を送信しました"); })}>店舗控えを印刷</s-button> : screen === "products" ? null : screen === "list" && (error || slow) ? <s-button disabled={busy} onClick={() => run(refresh)}>再読み込み</s-button> : <s-box />}
        {screen === "products" ? <s-text>明細 {draft.lines.length} / 合計 {draft.lines.reduce((sum, line) => sum + line.quantity, 0)}</s-text> : null}
        {primary || <s-box />}
      </s-stack>
    </s-stack></s-box>
    </s-stack>
    <s-modal id="reservation-register-confirm" heading="取置を確定しますか？" ref={confirmRegistrationRef}>
      <s-box padding="base"><s-stack gap="base">
        <s-text type="small" color="subdued">表示した商品の在庫を確保して、取置を登録します。</s-text>
        <s-text type="strong">{customerId ? selectedCustomer?.name || "POSで選択したお客様" : draft.name}</s-text>
        <s-text>{japanesePhoneDisplay(customerId ? selectedCustomer?.phone || (draft.memberPhoneCustomerId === String(customerId) ? draft.memberPhone : "") : draft.phone)}</s-text>
        <s-text>明細 {draft.lines.length} / 合計 {draft.lines.reduce((sum, line) => sum + line.quantity, 0)}</s-text>
        {draft.lines.map(line => <s-text key={line.variantId}>{line.title} × {line.quantity}</s-text>)}
        <s-divider /><s-button command="--hide" commandFor="reservation-register-confirm" disabled={busy}>戻る</s-button>
      </s-stack></s-box>
      <s-button slot="primary-action" variant="primary" loading={busy} disabled={busy || scanBusy || !ready || !draft.lines.length} onClick={() => { confirmRegistrationRef.current?.hideOverlay?.(); void save(); }}>{busy ? "登録中…" : "確定する"}</s-button>
    </s-modal>
  </s-page>;
}
