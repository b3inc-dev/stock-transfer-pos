import { useLocation } from "react-router";
import { GuardedLink } from "./admin-ui";

export function ReservationNav({ selected }: { selected: "settings" | "receipt" | "customers" | "history" }) {
  const { search } = useLocation();
  const items = [
    { key: "settings", label: "設定", path: "/app/reservations/settings" },
    { key: "receipt", label: "レシート編集", path: "/app/reservations/receipt" },
    { key: "customers", label: "顧客データ", path: "/app/reservations/customer-data" },
    { key: "history", label: "履歴", path: "/app/reservations" },
  ];
  // Keep embedded-app context, but do not carry history pagination into other sections.
  const params = new URLSearchParams(search);
  params.delete("page"); params.delete("ended"); params.delete("eventsPage"); params.delete("historyPage"); params.delete("locations"); params.delete("statuses"); params.delete("sort");
  const suffix = params.size ? `?${params}` : "";
  return <><style>{`
.Reservation-tabs {display:flex;gap:8px;padding:0 16px 8px;border-bottom:1px solid #e1e3e5;margin-bottom:24px;overflow-x:auto;}
.Admin-body .Reservation-tabs a:not(.Admin-primary):not(.Admin-secondary) {flex:0 0 auto;border-radius:8px;padding:6px 12px;color:inherit;text-decoration:none;font-size:14px;font-weight:500;}
.Reservation-tabs a.is-active {background:#e5e7eb;font-weight:600;}
.Reservation-history {display:grid;grid-template-columns:minmax(260px,2fr) minmax(0,3fr);gap:24px;align-items:start;}
.Reservation-history > * {min-width:0;}
.Reservation-history-card {margin-bottom:16px;font-size:14px;line-height:1.5;}
.Reservation-history-card input {flex:0 0 auto;margin:0;}
.Reservation-options {display:grid;gap:4px;margin:12px 0;}
.Reservation-option {display:flex;align-items:center;gap:10px;padding:12px;border:1px solid #e1e3e5;border-radius:8px;cursor:pointer;min-width:0;overflow-wrap:anywhere;}
.Reservation-option:has(input:checked) {background:#eff6ff;border-color:#2563eb;}
.Admin-body a.Reservation-row:not(.Admin-primary):not(.Admin-secondary) {color:inherit;text-decoration:none;overflow-wrap:anywhere;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px 16px;padding:20px 12px;border-bottom:1px solid #e1e3e5;}
.Reservation-row p {margin:0;}
.Reservation-row-end {text-align:right;}
@media(max-width:700px){.Reservation-history{grid-template-columns:minmax(0,1fr);}.Reservation-tabs{padding-inline:0;}}
`}</style><nav className="Reservation-tabs" aria-label="取置のメニュー">{items.map(item =>
    <GuardedLink key={item.key} to={item.path + suffix} className={selected === item.key ? "is-active" : undefined} aria-current={selected === item.key ? "page" : undefined}>{item.label}</GuardedLink>
  )}</nav></>;
}
