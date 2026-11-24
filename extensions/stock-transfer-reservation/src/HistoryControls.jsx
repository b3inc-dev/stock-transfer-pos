/* eslint-disable react/prop-types */
import { useState } from "preact/hooks";
export function ReservationHistoryDate({ parts, today, dates, disabled, onSelect }) {
  const [menu, setMenu] = useState(null);
  const all = [...new Set([...(dates || []), today].filter(Boolean))].sort();
  const values = menu === 0 ? [...new Set(all.map(value => value.slice(0, 4)))].reverse() : menu === 1 ? [...new Set(all.filter(value => value.startsWith(parts[0] + "-")).map(value => value.slice(5, 7)))] : all.filter(value => value.startsWith(parts.slice(0, 2).join("-") + "-")).map(value => value.slice(8, 10));
  const select = value => {
    const next = [...parts]; next[menu] = value;
    const matches = all.filter(date => date.startsWith(next.slice(0, menu + 1).join("-")));
    if (menu < 2 && matches.length) { const match = matches[matches.length - 1].split("-"); for (let index = menu + 1; index < 3; index++) next[index] = match[index]; }
    setMenu(null); onSelect(next);
  };
  return <>
    <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="small">
      <s-stack direction="inline" gap="small">{["年", "月", "日"].map((label, index) => <s-button key={label} disabled={disabled || !parts[index]} onClick={() => setMenu(menu === index ? null : index)}>{parts[index] ? Number(parts[index]) : "—"}{label}</s-button>)}</s-stack>
      <s-button variant="primary" disabled={disabled || !today} onClick={() => { setMenu(null); onSelect(today.split("-")); }}>今日</s-button>
    </s-stack>
    {menu !== null ? <s-scroll-box maxBlockSize="160px"><s-stack direction="inline" gap="small">{values.map(value => <s-button key={value} disabled={disabled} variant={parts[menu] === value ? "primary" : "secondary"} onClick={() => select(value)}>{Number(value)}{["年", "月", "日"][menu]}</s-button>)}</s-stack></s-scroll-box> : null}
  </>;
}
export function ReservationPageControls({ page, total, pageSize = 25, disabled, onChange }) {
  if (total <= pageSize && page === 0) return null;
  return <s-stack direction="inline" gap="small" alignItems="center"><s-text type="small">{page * pageSize + 1}〜{Math.min((page + 1) * pageSize, total)} / 全{total}件</s-text><s-button disabled={disabled || page <= 0} onClick={() => onChange(page - 1)}>前へ</s-button><s-button disabled={disabled || (page + 1) * pageSize >= total} onClick={() => onChange(page + 1)}>次へ</s-button></s-stack>;
}
