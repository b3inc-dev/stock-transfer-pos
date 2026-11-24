/* eslint-disable react/prop-types */
import { useEffect, useRef, useState } from "preact/hooks";
import { reservationApi } from "./api.js";
import { japanesePhoneDisplay } from "../../common/customerDisplay.js";

/** Separate POS screen: fixed search, scrollable results, fixed selection actions. */
export function ReservationCustomerScreen({ locationId, storeName, busy, selectionError, onSelect, onBack }) {
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [pageInfo, setPageInfo] = useState({ hasNextPage: false, endCursor: null });
  const [cursors, setCursors] = useState([null]);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const revision = useRef(0);
  const selectionRef = useRef(null);
  const change = value => {
    if (selectionRef.current || value === query) return;
    revision.current++; setQuery(value); setRows([]); setLoaded(false); setSelected(null); setError(""); setPage(0); setCursors([null]);
  };
  useEffect(() => {
    const request = ++revision.current;
    let alive = true;
    selectionRef.current = null; setSelected(null); setLoaded(false); setRows([]); setError("");
    if (!query.trim()) { setLoading(false); return; }
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const result = await reservationApi({ command: "customers", query: query.trim(), after: cursors[page], locationId });
        if (!alive || request !== revision.current) return;
        setRows(result.customers); setPageInfo(result.pageInfo); setLoaded(true);
      } catch (error) { if (alive && request === revision.current) setError(error.message); }
      finally { if (alive && request === revision.current) setLoading(false); }
    }, 300);
    return () => { clearTimeout(timer); alive = false; };
  }, [query, locationId, cursors, page, refresh]);
  const invalidate = () => { revision.current++; selectionRef.current = null; setSelected(null); setLoaded(false); setRows([]); setLoading(Boolean(query.trim())); setError(""); };
  const previousPage = () => { if (busy || loading || !loaded || page === 0) return; invalidate(); setPage(previous => previous - 1); };
  const next = () => {
    if (busy || loading || !loaded || !pageInfo.hasNextPage || !pageInfo.endCursor) return;
    invalidate(); setCursors(previous => [...previous.slice(0, page + 1), pageInfo.endCursor]); setPage(previous => previous + 1);
  };
  const retry = () => { invalidate(); setRefresh(previous => previous + 1); };
  const pick = customer => { if (busy || loading || !loaded) return; selectionRef.current = customer; setSelected(customer); };
  const searchAgain = () => { selectionRef.current = null; setSelected(null); };
  const locked = busy || loading;
  return <s-stack gap="none" blockSize="100%" inlineSize="100%" minBlockSize="0">
    <s-box padding="base"><s-stack gap="base">
      <s-text>ロケーション: {storeName}</s-text>
      {selected ? <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
        <s-text>検索: {query}</s-text><s-button disabled={busy} onClick={searchAgain}>検索し直す</s-button>
      </s-stack> : <s-search-field placeholder="氏名・電話番号で検索" value={query} disabled={busy} onInput={event => change(event.currentTarget.value)} onChange={event => change(event.currentTarget.value)} />}
      <s-text type="small" color="subdued">{loading ? "検索中…" : !query.trim() ? "氏名または電話番号を入力してください。" : loaded ? `${page + 1}ページ目・${rows.length}件` : "検索結果を取得できていません。"}</s-text>
      {loaded ? <s-stack direction="inline" justifyContent="space-between" alignItems="center">
        <s-button disabled={locked || page === 0} onClick={previousPage}>前へ</s-button>
        <s-text>{page + 1}ページ</s-text>
        <s-button disabled={locked || !pageInfo.hasNextPage || !pageInfo.endCursor} onClick={next}>次へ</s-button>
      </s-stack> : null}
    </s-stack></s-box><s-divider />
    <s-scroll-box padding="none" blockSize="auto" maxBlockSize="100%" minBlockSize="0"><s-box padding="base"><s-stack gap="none">
      {loaded && !rows.length ? <s-text color="subdued">一致するお客様はいません。氏名の一部や電話番号でもお試しください。</s-text> : null}
      {rows.map(customer => <s-box key={customer.id}>
        <s-clickable disabled={locked} onClick={() => pick(customer)}><s-box padding="base"><s-stack gap="small-400">
          <s-stack direction="inline" justifyContent="space-between" alignItems="center"><s-text type="strong">{customer.name}</s-text>{selected?.id === customer.id ? <s-badge tone="info">選択中</s-badge> : <s-text>›</s-text>}</s-stack>
          <s-text color="subdued">{japanesePhoneDisplay(customer.phone) || "電話番号未登録"}</s-text>
        </s-stack></s-box></s-clickable><s-divider />
      </s-box>)}
    </s-stack></s-box></s-scroll-box><s-divider />
    <s-box padding="base"><s-stack gap="base">
      {error || selectionError ? <s-text tone="critical">{error || selectionError}</s-text> : null}
      <s-text type="small" color="subdued">{selected ? `${selected.name}を選択しています。` : "一覧のお客様を選び、下のボタンで確定してください。"}</s-text>
      <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
        <s-button disabled={busy} onClick={onBack}>戻る</s-button>
        <s-button disabled={locked || !query.trim()} onClick={retry}>再読み込み</s-button>
        <s-button variant="primary" loading={busy} disabled={locked || !loaded || !selected} onClick={() => onSelect(selected)}>{busy ? "選択中…" : "このお客様を選択"}</s-button>
      </s-stack>
    </s-stack></s-box>
  </s-stack>;
}
