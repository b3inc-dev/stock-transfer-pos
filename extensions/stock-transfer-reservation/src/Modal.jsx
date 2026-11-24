/* global globalThis */
import "../../common/remoteDomSiblingFix.js";
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { locationId, reservationApi, printReservation } from "./api.js";
import { appendProductToDraft, createReservationDraftWriter, loadProductReservationDraft } from "./productEntry.js";
import { handoffReservationCart, RESERVATION_LABELS, validDate } from "../../common/reservations.js";

const DRAFT_KEY = "pos_stock_reservation_draft_v1";
const newId = () => `R-${crypto.randomUUID()}`;
export default async () => render(<ReservationModal />, document.body);
/** @param {{ fromProduct?: boolean, initialProduct?: { id: number, variantId: number } | null }} props */
// Preact component props are documented above and checked by the local SDK build.
// eslint-disable-next-line react/prop-types
export function ReservationModal({ fromProduct = false, initialProduct = null }) {
  const [screen, setScreen] = useState("create");
  const [rows, setRows] = useState([]);
  const [mode, setMode] = useState("due");
  const [query, setQuery] = useState("");
  const [queryInput, setQueryInput] = useState("");
  const [page, setPage] = useState(0);
  const [hasNext, setHasNext] = useState(false);
  const [detail, setDetail] = useState(null);
  const [draft, setDraft] = useState({ id: newId(), lines: [], name: "", phone: "", faceToFace: true, print: false });
  const [products, setProducts] = useState([]);
  const [pendingProduct, setPendingProduct] = useState(null);
  const [search, setSearch] = useState("");
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
  const [allTotal, setAllTotal] = useState(0);
  const [dueDate, setDueDate] = useState("");
  const [dateParts, setDateParts] = useState(["", "", ""]);
  const [storeToday, setStoreToday] = useState("");
  const [slow, setSlow] = useState(false);
  const storeName = detail?.locationName || rows[0]?.locationName || "現在のPOS店舗";
  useEffect(() => { if (!busy) { setSlow(false); return; } const timer = setTimeout(() => setSlow(true), 10000); return () => clearTimeout(timer); }, [busy]);
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
    finally { lock.current = false; setBusy(false); }
  }, []);
  useEffect(() => {
    let alive = true;
    const restore = async () => {
      if (fromProduct) {
        lock.current = true; setBusy(true);
      }
      try {
        const result = fromProduct
          ? await loadProductReservationDraft({ storage: shopify.storage, storageKey, product: initialProduct, productSearch: shopify.productSearch, createDraft: () => ({ id: newId(), lines: [], name: "", phone: "", faceToFace: true, print: false }) })
          : { draft: await shopify.storage.get(storageKey), kind: "ready" };
        if (!alive) return;
        if (result.draft) {
          latestDraft.current = result.draft;
          setDraft(result.draft);
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
  }, [storageKey, fromProduct, initialProduct]);
  useEffect(() => { if (draftReady.current) writer.save(latestDraft.current).catch(e => setError(e.message)); }, [draft, submitted, writer]);
  const refresh = useCallback(async () => {
    const result = await reservationApi({ command: "list", mode, query, page, dueDate });
    setStoreToday(result.today || ""); if (result.today) setDateParts(previous => previous.some(Boolean) ? previous : result.today.split("-"));
    setRows(result.rows); setHasNext(result.hasNextPage); setTotal(result.total); setAllTotal(result.allTotal ?? result.total); setUpdatedAt(new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date()));
  }, [mode, query, page, dueDate]);
  useEffect(() => {
    if (screen !== "list") return;
    run(refresh);
    const timer = setInterval(() => run(refresh), 60000);
    const focus = () => run(refresh);
    globalThis.addEventListener?.("focus", focus);
    globalThis.document?.addEventListener?.("visibilitychange", focus);
    return () => { clearInterval(timer); globalThis.removeEventListener?.("focus", focus); globalThis.document?.removeEventListener?.("visibilitychange", focus); };
  }, [screen, refresh, run]);
  const patch = value => {
    if (submitted || lock.current || !ready) return;
    const next = { ...latestDraft.current, ...value };
    latestDraft.current = next; setDraft(next);
  };
  const open = row => run(async () => { const result = await reservationApi({ command: "detail", id: row.id }); setDetail(result.row); setConfirm(false); setScreen("detail"); });
  const searchProducts = useCallback(value => run(async () => { const data = await reservationApi({ command: "products", query: value }); setProducts(data.products); }), [run]);
  useEffect(() => {
    if (screen !== "products") return;
    const signal = shopify.scanner?.scannerData?.current;
    const unsubscribe = signal?.subscribe?.(value => {
      const barcode = value?.data;
      if (barcode) { setSearch(barcode); searchProducts(`barcode:${String(barcode).replace(/["\\]/g, "")}`); }
    });
    return () => unsubscribe?.();
  }, [screen, searchProducts]);
  const add = product => {
    if (submitted || lock.current || !ready) return;
    if (draft.lines.some(line => line.variantId === product.id)) return;
    patch({ lines: [...draft.lines, { variantId: product.id, title: product.displayName, quantity: 1 }] });
    setProducts([]);
  };
  const save = () => run(async () => {
    if (!ready) throw new Error("前回の下書きを確認しています");
    const customer = shopify.cart.current.value.customer;
    const payload = submitted || { ...latestDraft.current, submitted: true, locationId: draftLocation.current, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, customerId: customer?.id ? `gid://shopify/Customer/${customer.id}` : null };
    // Persist the exact submitted draft before sending. Retrying always reuses its registration number.
    const previousSubmitted = submitted;
    latestDraft.current = payload; setSubmitted(payload);
    try { await writer.save(payload); }
    catch (e) { latestDraft.current = previousSubmitted || draft; setSubmitted(previousSubmitted); throw e; }
    const data = await reservationApi({ command: "create", ...payload });
    setDetail(data.row); setScreen("detail");
    if (data.row.status === "held") {
      const empty = { id: newId(), lines: [], name: "", phone: "", faceToFace: true, print: false };
      latestDraft.current = empty; setSubmitted(null); setDraft(empty);
      await writer.save(empty);
      shopify.toast.show("取置を登録しました。商品を取置棚へ移してください");
      if (draft.faceToFace && draft.print) {
        try { await printReservation(data.row); } catch { setError("取置は登録済みです。印刷できませんでした。詳細から再印刷してください"); }
      }
    }
  });
  const command = (name, extra = {}) => run(async () => {
    const result = await reservationApi({ command: name, id: detail.id, version: detail.version, ...extra });
    setDetail(result.row); setConfirm(false);
    if (name === "cancel") setScreen("detail");
    if (name === "resume" && result.row.status === "held" && draft.id === result.row.id) {
      const empty = { id: newId(), lines: [], name: "", phone: "", faceToFace: true, print: false };
      latestDraft.current = empty; setSubmitted(null); setDraft(empty);
      await writer.save(empty);
    }
  });
  const checkout = () => run(async () => {
    setAddingToCart(true);
    try {
      await handoffReservationCart(detail, shopify, reservationApi, setDetail);
      shopify.toast.show("取置商品をカートへ追加しました。カートでお会計してください");
      await shopify.action.dismissModal();
    } finally { setAddingToCart(false); }
  });
  const notice = error || detail?.lastError;
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
    if (screen === "review") { setScreen("products"); setError(""); return; }
    if (screen === "cancel" || screen === "actions") { setScreen("detail"); setConfirm(false); setError(""); return; }
    if (screen === "list") { setScreen("create"); setError(""); return; }
    if (screen === "create" || (screen === "detail" && detail?.endedAt)) { run(async () => { if (ready) await writer.save(latestDraft.current); await shopify.action.dismissModal(); }); return; }
    back();
  };
  const next = () => {
    if (submitted) { setError(""); setScreen("review"); return; }
    if (!shopify.cart.current.value.customer?.id && (!draft.name.trim() || !draft.phone.trim())) { setError("お名前と電話番号を入力してください"); return; }
    setError(""); setScreen("products");
  };
  const applyDate = (parts = dateParts) => {
    const value = parts.map((part, index) => index ? String(part).padStart(2, "0") : part).join("-");
    if (!validDate(value)) { setError("受取期限の日付を確認してください"); return; }
    setDueDate(value); setPage(0); setError("");
  };
  const titles = { create: "取置の受付", products: "取置する商品", review: "取置を登録", list: "取置履歴", detail: "取置の詳細", actions: "連絡・印刷", cancel: "取置を解除", "product-choice": "商品を追加" };
  let primary = null;
  if (screen === "create") primary = <s-button variant="primary" disabled={busy || !ready} onClick={next}>次へ</s-button>;
  if (screen === "products") primary = <s-button variant="primary" disabled={busy || !ready || !draft.lines.length} onClick={() => { setError(""); setScreen("review"); }}>次へ</s-button>;
  if (screen === "review") primary = <s-button variant="primary" disabled={busy || !ready || !draft.lines.length} onClick={save}>{busy ? "登録中…" : submitted ? "登録結果を確認" : "確保して登録"}</s-button>;
  if (screen === "list") primary = <s-button variant="primary" disabled={busy || !ready} onClick={() => setScreen("create")}>取置を登録</s-button>;
  if (screen === "product-choice") primary = <s-button variant="primary" disabled={busy || !ready} onClick={confirmProduct}>この商品を追加</s-button>;
  if (canAddToCart) primary = <s-button variant="primary" disabled={busy} loading={addingToCart} onClick={checkout}>{addingToCart ? "追加中…" : "カートへ追加"}</s-button>;
  if (screen === "cancel") primary = <s-button variant="primary" tone="critical" disabled={busy} onClick={() => command("cancel")}>{busy ? "解除中…" : "取置を解除"}</s-button>;
  if (screen === "detail" && ["reserving", "cancelling", "completing"].includes(detail?.status)) primary = <s-button variant="primary" disabled={busy} onClick={() => command("resume")}>反映を確認</s-button>;

  return <s-page heading={titles[screen] || "取置"}>
    <s-stack gap="none" blockSize="100%" inlineSize="100%" minBlockSize="0">
      <s-box padding="base"><s-stack gap="small" direction="block">
        {busy ? <s-banner tone="info" heading="読み込み中です。少しお待ちください。" /> : null}
        {screen === "list" ? <>
          <s-text-field label="取置番号・名前で検索" value={queryInput} onInput={e => setQueryInput(e.currentTarget.value)} />
          <s-button disabled={busy} onClick={() => { setQuery(queryInput); setPage(0); }}>検索</s-button>
          <s-text>受取期限で絞り込み</s-text>
          <s-stack direction="inline" gap="small">{["年", "月", "日"].map((label, index) => <s-number-field key={label} label={label} min={index ? 1 : 2000} max={index === 0 ? 2100 : index === 1 ? 12 : 31} value={dateParts[index]} disabled={busy} onInput={e => { const value = e.currentTarget.value; setDateParts(previous => previous.map((part, i) => i === index ? value : part)); }} />)}</s-stack>
          <s-stack direction="inline" gap="small"><s-button disabled={busy} onClick={() => applyDate()}>日付で絞る</s-button><s-button disabled={busy || !storeToday} onClick={() => { const parts = storeToday.split("-"); setDateParts(parts); applyDate(parts); }}>今日</s-button>{dueDate ? <s-button disabled={busy} onClick={() => { setDueDate(""); setPage(0); }}>日付を解除</s-button> : null}</s-stack>
          <s-stack direction="inline" gap="small">{[["due", "要対応"], ["active", "取置中"], ["ended", "終了"]].map(([value, label]) => <s-box key={value} inlineSize="33%"><s-button variant={mode === value ? "primary" : "secondary"} disabled={busy} onClick={() => { setMode(value); setPage(0); }}>{label}</s-button></s-box>)}</s-stack>
          <s-text>{storeName}・{updatedAt ? `${updatedAt} に更新` : "まだ更新していません"}</s-text>
          <s-stack direction="inline" justifyContent="space-between"><s-button disabled={busy || !page} onClick={() => setPage(page - 1)}>前へ</s-button><s-text>{total}件</s-text><s-button disabled={busy || !hasNext} onClick={() => setPage(page + 1)}>次へ</s-button></s-stack>
        </> : <s-text>店舗: {storeName}</s-text>}
      </s-stack></s-box><s-divider />
      <s-scroll-box padding="none" blockSize="auto" maxBlockSize="100%" minBlockSize="0"><s-box padding="base"><s-stack gap="base" direction="block">
      {screen === "list" ? <>
        {!rows.length && !busy ? <><s-text>条件に合う取置はありません。対象の全体は{allTotal}件です。</s-text><s-button onClick={() => { setMode("active"); setQuery(""); setQueryInput(""); setDueDate(""); setPage(0); }}>すべて表示する</s-button></> : null}
        {rows.map(row => <s-box key={row.id}><s-clickable onClick={() => open(row)} disabled={busy}><s-box padding="base"><s-stack gap="small" direction="block">
          <s-stack direction="inline" justifyContent="space-between"><s-text type="strong">{row.id} ›</s-text><s-text>{row.dueDate}</s-text></s-stack>
          <s-text>{row.name}・{row.phone}</s-text><s-text>店舗: {row.locationName}</s-text>
          <s-stack direction="inline" justifyContent="space-between"><s-badge tone={row.needsFollowUp ? "warning" : "info"}>{row.needsFollowUp ? "要対応" : RESERVATION_LABELS[row.status]}</s-badge><s-text>{row.lines.length}件・合計{row.lines.reduce((sum, line) => sum + line.quantity, 0)}点</s-text></s-stack>
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
        <s-text>店舗と顧客は現在のPOSを使用します。既存顧客は先にPOSで選択してください。</s-text>
        <s-text-field disabled={busy || !ready || Boolean(submitted)} label="ゲストのお名前" value={draft.name} onInput={e => patch({ name: e.currentTarget.value })} />
        <s-text-field disabled={busy || !ready || Boolean(submitted)} label="取置用の電話番号" value={draft.phone} onInput={e => patch({ phone: e.currentTarget.value })} />
      </> : null}
      {screen === "products" ? <>
        <s-text-field label="商品名・バーコードで検索" value={search} onInput={e => setSearch(e.currentTarget.value)} />
        <s-button disabled={busy} onClick={() => searchProducts(search)}>商品を探す</s-button>
        {products.map(product => <s-button key={product.id} disabled={busy || !ready || Boolean(submitted)} onClick={() => add(product)}>{product.displayName}</s-button>)}
        {draft.lines.map((line, index) => <s-stack key={line.variantId} gap="small" direction="block"><s-text>{line.title}</s-text><s-number-field disabled={busy || !ready || Boolean(submitted)} label="数量" min={1} max={9999} value={String(line.quantity)} onInput={e => patch({ lines: draft.lines.map((item, i) => i === index ? { ...item, quantity: Number(e.currentTarget.value) } : item) })} /><s-button variant="secondary" disabled={busy || !ready || Boolean(submitted)} onClick={() => patch({ lines: draft.lines.filter((_, i) => i !== index) })}>商品を外す</s-button></s-stack>)}
      </> : null}
      {screen === "create" ? <>
        <s-switch disabled={busy || !ready || Boolean(submitted)} label="対面で受付" checked={draft.faceToFace} onChange={e => patch({ faceToFace: e.currentTarget.checked, print: false })} />
        {draft.faceToFace ? <s-switch disabled={busy || !ready || Boolean(submitted)} label="取置レシートを発行" checked={draft.print} onChange={e => patch({ print: e.currentTarget.checked })} /> : null}
        <s-text>保存すると販売可能在庫から取置分を確保します。</s-text>

        {submitted ? <s-text>送信済みの内容を保持しています。再度登録を押すと同じ番号で結果を確認します。</s-text> : null}
      </> : null}
      {screen === "review" ? <>
        <s-text type="strong">取置を登録しますか？</s-text><s-text>表示した商品を確保して取置を登録します。</s-text>
        <s-text>{shopify.cart.current.value.customer?.id ? "POSで選択したお客様" : draft.name}</s-text><s-text>{draft.phone}</s-text>
        {draft.lines.map(line => <s-text key={line.variantId}>{line.title} × {line.quantity}</s-text>)}
        <s-text>{draft.faceToFace && draft.print ? "取置レシートを発行します" : "取置レシートは発行しません"}</s-text>
        {submitted ? <s-text>送信した内容を保持しています。同じ取置番号で結果を確認します。</s-text> : null}
      </> : null}
      {screen === "cancel" && detail ? <><s-text>表示した商品の取置を解除し、販売可能在庫に戻します。</s-text>{detail.lines.map(line => <s-text key={line.variantId}>{line.title} × {line.quantity}</s-text>)}</> : null}
      {(screen === "detail" || screen === "actions") && detail ? <>
        <s-text type="strong">{detail.id}</s-text><s-badge tone={detail.needsFollowUp ? "warning" : "info"}>{RESERVATION_LABELS[detail.status]}</s-badge>
        <s-text>{detail.name}</s-text><s-text>{detail.phone}</s-text>{!detail.contactVisible ? <s-text>連絡先の確認には権限が必要です。</s-text> : null}
        <s-text>{detail.locationName}・受取期限 {detail.dueDate}</s-text>
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
        {screen === "actions" && ["held", "checkout", "sold", "cancelled"].includes(detail.status) ? <s-button disabled={busy} onClick={() => run(async () => { await printReservation(detail); shopify.toast.show("印刷を送信しました"); })}>{busy ? "処理中…" : "取置レシートを印刷"}</s-button> : null}
        {detail.status === "failed" ? <s-button disabled={busy} onClick={() => { setSubmitted(null); setDraft(previous => ({ ...previous, submitted: false, id: newId() })); setScreen("create"); setDetail(null); }}>内容を直して登録</s-button> : null}
        {detail.endedAt ? <s-text>終了 {new Date(detail.endedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}・担当 {detail.endedBy}</s-text> : null}
      </> : null}
    </s-stack></s-box></s-scroll-box>
    <s-divider />
    <s-box padding="base"><s-stack gap="base" direction="block">
      <s-stack direction="inline" justifyContent="space-between"><s-text>店舗: {storeName}</s-text>{screen === "list" ? <s-text>{total}件</s-text> : <s-text>{draft.lines.length}件</s-text>}</s-stack>
      {notice ? <s-banner tone="critical" heading="操作を確認してください">{notice}</s-banner> : null}
      {canAddToCart ? <s-text>追加後はPOSのカートでお会計してください。</s-text> : null}
      <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
        <s-button variant="secondary" onClick={goBack} disabled={busy}>{screen === "cancel" || screen === "review" ? "やめる" : screen === "detail" && detail?.endedAt ? "閉じる" : "戻る"}</s-button>
        {screen === "create" ? <s-button disabled={busy} onClick={() => { setScreen("list"); setDetail(null); setError(""); }}>履歴一覧</s-button> : screen === "detail" ? <s-button disabled={busy} onClick={() => setScreen("actions")}>連絡・印刷</s-button> : screen === "list" && (error || slow) ? <s-button disabled={busy} onClick={() => run(refresh)}>再読み込み</s-button> : <s-box />}
        {primary || <s-box />}
      </s-stack>
    </s-stack></s-box>
    </s-stack>
  </s-page>;
}
