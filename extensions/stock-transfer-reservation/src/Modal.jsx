/* global globalThis */
import "../../common/remoteDomSiblingFix.js";
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { locationId, reservationApi, printReservation } from "./api.js";
import { handoffReservationCart, RESERVATION_LABELS } from "../../common/reservations.js";

const DRAFT_KEY = "pos_stock_reservation_draft_v1";
const newId = () => `R-${crypto.randomUUID()}`;
export default async () => render(<Modal />, document.body);
function Modal() {
  const [screen, setScreen] = useState("list");
  const [rows, setRows] = useState([]);
  const [mode, setMode] = useState("due");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [hasNext, setHasNext] = useState(false);
  const [detail, setDetail] = useState(null);
  const [draft, setDraft] = useState({ id: newId(), lines: [], name: "", phone: "", faceToFace: true, print: false });
  const [products, setProducts] = useState([]);
  const [search, setSearch] = useState("");
  const [followDate, setFollowDate] = useState("");
  const [orderSearch, setOrderSearch] = useState("");
  const [orders, setOrders] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(null);
  const [ready, setReady] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const lock = useRef(false);
  const draftReady = useRef(false);
  const draftLocation = useRef(locationId());
  const storageKey = `${DRAFT_KEY}:${draftLocation.current}`;
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
    shopify.storage.get(storageKey).then(saved => { if (saved) { setDraft(saved); if (saved.submitted) setSubmitted(saved); } draftReady.current = true; setReady(true); }).catch(() => { setError("前回の下書きを読み込めません。画面を閉じて開き直してください"); });
  }, [storageKey]);
  useEffect(() => { if (draftReady.current) shopify.storage.set(storageKey, draft).catch(() => setError("下書きを保存できません。通信と端末の状態を確認してください")); }, [draft, storageKey]);
  const refresh = useCallback(async () => {
    const result = await reservationApi({ command: "list", mode, query, page });
    setRows(result.rows); setHasNext(result.hasNextPage);
  }, [mode, query, page]);
  useEffect(() => {
    if (screen !== "list") return;
    run(refresh);
    const timer = setInterval(() => run(refresh), 60000);
    const focus = () => run(refresh);
    globalThis.addEventListener?.("focus", focus);
    globalThis.document?.addEventListener?.("visibilitychange", focus);
    return () => { clearInterval(timer); globalThis.removeEventListener?.("focus", focus); globalThis.document?.removeEventListener?.("visibilitychange", focus); };
  }, [screen, refresh, run]);
  const patch = value => { if (!submitted) setDraft(previous => ({ ...previous, ...value })); };
  const open = row => run(async () => { const result = await reservationApi({ command: "detail", id: row.id }); setDetail(result.row); setConfirm(false); setScreen("detail"); });
  const searchProducts = useCallback(value => run(async () => { const data = await reservationApi({ command: "products", query: value }); setProducts(data.products); }), [run]);
  useEffect(() => {
    if (screen !== "create") return;
    const signal = shopify.scanner?.scannerData?.current;
    const unsubscribe = signal?.subscribe?.(value => {
      const barcode = value?.data;
      if (barcode) { setSearch(barcode); searchProducts(`barcode:${String(barcode).replace(/["\\]/g, "")}`); }
    });
    return () => unsubscribe?.();
  }, [screen, searchProducts]);
  const add = product => {
    if (submitted) return;
    if (draft.lines.some(line => line.variantId === product.id)) return;
    patch({ lines: [...draft.lines, { variantId: product.id, title: product.displayName, quantity: 1 }] });
    setProducts([]);
  };
  const save = () => run(async () => {
    if (!ready) throw new Error("前回の下書きを確認しています");
    const customer = shopify.cart.current.value.customer;
    const payload = submitted || { ...draft, submitted: true, locationId: draftLocation.current, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, customerId: customer?.id ? `gid://shopify/Customer/${customer.id}` : null };
    // Persist the exact submitted draft before sending. Retrying always reuses its registration number.
    await shopify.storage.set(storageKey, payload);
    setSubmitted(payload);
    const data = await reservationApi({ command: "create", ...payload });
    setDetail(data.row); setScreen("detail");
    if (data.row.status === "held") {
      setSubmitted(null);
      setDraft({ id: newId(), lines: [], name: "", phone: "", faceToFace: true, print: false });
      await shopify.storage.delete(storageKey);
      shopify.toast.show("取置を登録しました。商品を取置棚へ移してください");
      if (draft.faceToFace && draft.print) {
        try { await printReservation(data.row); } catch { setError("取置は登録済みです。印刷できませんでした。詳細から再印刷してください"); }
      }
    }
  });
  const command = (name, extra = {}) => run(async () => {
    const result = await reservationApi({ command: name, id: detail.id, version: detail.version, ...extra });
    setDetail(result.row); setConfirm(false);
    if (name === "resume" && result.row.status === "held" && draft.id === result.row.id) {
      setSubmitted(null);
      setDraft({ id: newId(), lines: [], name: "", phone: "", faceToFace: true, print: false });
      await shopify.storage.delete(storageKey);
    }
  });
  const checkout = () => run(async () => {
    await handoffReservationCart(detail, shopify, reservationApi, setDetail);
    shopify.toast.show("取置商品を会計へ引き継ぎました");
    await shopify.action.dismissModal();
  });
  const notice = error || detail?.lastError;
  const back = () => { setScreen("list"); setDetail(null); setError(""); };
  return <s-page heading={screen === "create" ? "取置を登録" : "取置"}>
    <s-scroll-box><s-box padding="base"><s-stack gap="base" direction="block">
      {screen !== "list" ? <s-button variant="secondary" onClick={back} disabled={busy}>戻る</s-button> : null}
      {notice ? <s-banner tone="critical" heading="操作を確認してください">{notice}</s-banner> : null}
      {screen === "list" ? <>
        <s-button variant="primary" onClick={() => setScreen("create")} disabled={busy || !ready}>取置を登録</s-button>
        <s-text>表示</s-text><s-choice-list values={[mode]} onChange={e => { setMode(e.currentTarget.values[0]); setPage(0); }}><s-choice value="due">要対応</s-choice><s-choice value="active">取置中すべて</s-choice><s-choice value="ended">終了</s-choice></s-choice-list>
        <s-text-field label="取置番号・名前で検索" value={query} onInput={e => { setQuery(e.currentTarget.value); setPage(0); }} />
        <s-button onClick={() => run(refresh)} disabled={busy}>{busy ? "読み込み中…" : "更新"}</s-button>
        {!rows.length && !busy ? <s-text>取置はありません。</s-text> : null}
        {rows.map(row => <s-clickable key={row.id} onClick={() => open(row)} disabled={busy}><s-box padding="base"><s-stack gap="small" direction="block">
          <s-text type="strong">{row.id} ›</s-text><s-text>{row.name}・{row.phone}</s-text><s-text>期限 {row.dueDate}</s-text><s-badge tone={row.needsFollowUp ? "warning" : "info"}>{row.needsFollowUp ? "要対応" : RESERVATION_LABELS[row.status]}</s-badge>
        </s-stack></s-box></s-clickable>)}
        <s-stack direction="inline" gap="base"><s-button disabled={busy || !page} onClick={() => setPage(page - 1)}>前へ</s-button><s-button disabled={busy || !hasNext} onClick={() => setPage(page + 1)}>次へ</s-button></s-stack>
      </> : null}
      {screen === "create" ? <>
        <s-text>店舗と顧客は現在のPOSを使用します。既存顧客は先にPOSで選択してください。</s-text>
        <s-text-field disabled={Boolean(submitted)} label="ゲストのお名前" value={draft.name} onInput={e => patch({ name: e.currentTarget.value })} />
        <s-text-field disabled={Boolean(submitted)} label="取置用の電話番号" value={draft.phone} onInput={e => patch({ phone: e.currentTarget.value })} />
        <s-text-field label="商品名・バーコードで検索" value={search} onInput={e => setSearch(e.currentTarget.value)} />
        <s-button disabled={busy} onClick={() => searchProducts(search)}>商品を探す</s-button>
        {products.map(product => <s-button key={product.id} onClick={() => add(product)}>{product.displayName}</s-button>)}
        {draft.lines.map((line, index) => <s-stack key={line.variantId} gap="small" direction="block"><s-text>{line.title}</s-text><s-number-field disabled={Boolean(submitted)} label="数量" min={1} max={9999} value={String(line.quantity)} onInput={e => patch({ lines: draft.lines.map((item, i) => i === index ? { ...item, quantity: Number(e.currentTarget.value) } : item) })} /><s-button variant="secondary" onClick={() => patch({ lines: draft.lines.filter((_, i) => i !== index) })}>商品を外す</s-button></s-stack>)}
        <s-switch disabled={Boolean(submitted)} label="対面で受付" checked={draft.faceToFace} onChange={e => patch({ faceToFace: e.currentTarget.checked, print: false })} />
        {draft.faceToFace ? <s-switch disabled={Boolean(submitted)} label="取置レシートを発行" checked={draft.print} onChange={e => patch({ print: e.currentTarget.checked })} /> : null}
        <s-text>保存すると販売可能在庫から取置分を確保します。</s-text>
        <s-button variant="primary" disabled={busy || !ready || !draft.lines.length} onClick={save}>{busy ? "登録中…" : "確保して登録"}</s-button>
        <s-text>登録番号 {draft.id}</s-text>
        {submitted ? <s-text>送信済みの内容を保持しています。再度登録を押すと同じ番号で結果を確認します。</s-text> : null}
      </> : null}
      {screen === "detail" && detail ? <>
        <s-text type="strong">{detail.id}</s-text><s-badge tone={detail.needsFollowUp ? "warning" : "info"}>{RESERVATION_LABELS[detail.status]}</s-badge>
        <s-text>{detail.name}</s-text><s-text>{detail.phone}</s-text>{!detail.contactVisible ? <s-text>連絡先の確認には権限が必要です。</s-text> : null}
        <s-text>{detail.locationName}・受取期限 {detail.dueDate}</s-text>
        {detail.lines.map(line => <s-text key={line.variantId}>{line.title} × {line.quantity}</s-text>)}
        {detail.nextFollowDate ? <s-text>次回確認 {detail.nextFollowDate}</s-text> : null}
        {detail.events.map(event => <s-text key={event.id}>{new Date(event.createdAt).toLocaleString("ja-JP")}・{event.kind === "unreachable" ? "不通" : event.kind === "planned" ? "来店予定" : RESERVATION_LABELS[event.kind] || event.kind}・担当 {event.actor}{event.followDate ? `・次回 ${event.followDate}` : ""}</s-text>)}
        {["reserving", "cancelling", "completing"].includes(detail.status) ? <s-button disabled={busy} onClick={() => command("resume")}>{busy ? "確認中…" : "反映を確認"}</s-button> : null}
        {detail.status === "held" ? <>
          <s-button disabled={busy} onClick={() => command("unreachable")}>不通を記録</s-button>
          <s-text-field label="次回確認日（YYYY-MM-DD）" value={followDate} onInput={e => setFollowDate(e.currentTarget.value)} />
          <s-button disabled={busy} onClick={() => command("planned", { followDate })}>来店予定を記録</s-button>
          <s-button variant="primary" disabled={busy} onClick={checkout}>{busy ? "処理中…" : "会計へ"}</s-button>
          {confirm ? <><s-text>上の商品と数量の取置を解除し、販売可能在庫に戻しますか？</s-text><s-button tone="critical" disabled={busy} onClick={() => command("cancel")}>解除を確定</s-button><s-button onClick={() => setConfirm(false)}>やめる</s-button></> : <s-button disabled={busy} onClick={() => setConfirm(true)}>取置をキャンセル</s-button>}
        </> : null}
        {detail.status === "checkout" ? <>
          <s-button variant="primary" disabled={busy} onClick={checkout}>{busy ? "処理中…" : "同じカートで会計を再開"}</s-button>
          <s-text-field label="決済後の注文番号" value={orderSearch} onInput={e => setOrderSearch(e.currentTarget.value)} />
          <s-button disabled={busy} onClick={() => run(async () => { const result = await reservationApi({ command: "orders", query: orderSearch }); setOrders(result.orders); })}>注文を探す</s-button>
          {orders.map(order => <s-button key={order.id} disabled={busy} onClick={() => command("complete", { orderId: order.id })}>{order.name}を照合</s-button>)}
        </> : null}
        {["held", "checkout", "sold", "cancelled"].includes(detail.status) ? <s-button disabled={busy} onClick={() => run(async () => { await printReservation(detail); shopify.toast.show("印刷を送信しました"); })}>{busy ? "処理中…" : "取置レシートを印刷"}</s-button> : null}
        {detail.status === "failed" ? <s-button disabled={busy} onClick={() => { setSubmitted(null); setDraft(previous => ({ ...previous, submitted: false, id: newId() })); setScreen("create"); setDetail(null); }}>内容を直して登録</s-button> : null}
        {detail.endedAt ? <s-text>終了 {new Date(detail.endedAt).toLocaleString("ja-JP")}・担当 {detail.endedBy}</s-text> : null}
      </> : null}
    </s-stack></s-box></s-scroll-box>
  </s-page>;
}
