/* eslint-disable react/prop-types */
import { useEffect, useRef, useState } from "preact/hooks";
import { reservationApi } from "./api.js";
import { japanesePhoneDisplay } from "../../common/customerDisplay.js";
export const CUSTOMER_PICKER_ID = "reservation-customer-picker";
export function ReservationCustomerPicker({ locationId, busy, modalRef, onSelect }) {
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");
  const revision = useRef(0);
  const change = value => { revision.current++; setQuery(value); setRows([]); setLoaded(false); setError(""); };
  useEffect(() => {
    const request = ++revision.current;
    let alive = true;
    if (query.trim().length < 2) { setLoading(false); return; }
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const result = await reservationApi({ command: "customers", query: query.trim(), locationId });
        if (!alive || request !== revision.current) return;
        setRows(result.customers); setMore(result.hasNextPage); setLoaded(true);
      } catch (error) { if (alive && request === revision.current) setError(error.message); }
      finally { if (alive && request === revision.current) setLoading(false); }
    }, 300);
    return () => { clearTimeout(timer); alive = false; };
  }, [query, locationId]);
  const choose = async customer => { if (busy) return; if (await onSelect(customer)) change(""); };
  return <s-modal id={CUSTOMER_PICKER_ID} heading="お客様を選択" ref={modalRef}>
    <s-box padding="base"><s-stack gap="base">
      <s-text-field label="氏名・電話番号で検索" value={query} onInput={event => change(event.currentTarget.value)} disabled={busy} />
      {query.trim().length < 2 ? <s-text type="small" color="subdued">2文字以上で検索してください。</s-text> : null}
      {loading ? <s-text type="small" color="subdued">検索中…</s-text> : null}
      {error ? <s-text tone="critical">{error}</s-text> : null}
      {loaded && !rows.length ? <s-text color="subdued">一致するお客様はいません。</s-text> : null}
      <s-scroll-box maxBlockSize="320px">{rows.map(customer => <s-box key={customer.id}><s-clickable disabled={busy} onClick={() => choose(customer)}><s-box padding="base"><s-stack gap="small-400"><s-text type="strong">{customer.name}</s-text><s-text color="subdued">{japanesePhoneDisplay(customer.phone) || "電話番号未登録"}</s-text></s-stack></s-box></s-clickable><s-divider /></s-box>)}</s-scroll-box>
      {loaded && more ? <s-text type="small" color="subdued">候補が多いため、氏名・電話番号をもう少し詳しく入力してください。</s-text> : null}
      <s-divider /><s-button command="--hide" commandFor={CUSTOMER_PICKER_ID} onClick={() => change("")}>戻る</s-button>
    </s-stack></s-box>
  </s-modal>;
}
