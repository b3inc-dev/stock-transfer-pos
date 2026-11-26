import { useLocation } from "react-router";
import { GuardedLink } from "./admin-ui";

export function ReservationNav({ selected }: { selected: "settings" | "receipt" | "customers" | "history" }) {
  const { search } = useLocation();
  const items = [
    { key: "settings", label: "設定", path: "/app/reservations/settings" },
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
.Admin-body .Reservation-tabs a.is-active:not(.Admin-primary):not(.Admin-secondary) {background:#e5e7eb;font-weight:600;}
.Reservation-history {display:grid;grid-template-columns:minmax(260px,2fr) minmax(0,3fr);gap:24px;align-items:start;}
.Reservation-history > * {min-width:0;}
.Reservation-history > aside > p:first-child {margin:0 0 4px;}
.Reservation-history > aside > p.Admin-note {margin:0 0 16px;}
.Reservation-history-card > .Admin-title {margin:0 0 12px;}
.Reservation-history-card > .Admin-note {margin:0 0 16px;}
.Reservation-history-card > p:not(.Admin-note) {margin:16px 0 8px;}
.Reservation-history-card {margin-bottom:16px;font-size:14px;line-height:1.5;}
.Reservation-history-card input {flex:0 0 auto;margin:0;}
.Reservation-options {max-height:200px;overflow-y:auto;border:1px solid #e1e3e5;border-radius:8px;padding:6px;}
.Reservation-status-options {max-height:180px;}
.Reservation-sort-options {display:flex;flex-direction:column;gap:6px;margin-top:16px;}
.Reservation-option:first-child {margin-top:0;}
.Reservation-option input {width:16px;height:16px;flex-shrink:0;}
.Reservation-option span {font-weight:500;overflow:hidden;text-overflow:ellipsis;}
.Reservation-option:has(input:checked) span {font-weight:600;}
.Reservation-sort-options .Reservation-option {margin-top:0;border-color:#e1e3e5;}
.Reservation-option {display:flex;align-items:center;gap:8px;padding:10px 12px;border:1px solid transparent;border-radius:6px;margin-top:4px;cursor:pointer;min-width:0;overflow-wrap:anywhere;}
.Reservation-option:has(input:checked) {background:#eff6ff;border-color:#2563eb;}
.Admin-body a.Reservation-row:not(.Admin-primary):not(.Admin-secondary) {color:inherit;text-decoration:none;overflow-wrap:anywhere;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px 16px;padding:20px 12px;border-bottom:1px solid #e1e3e5;}
.Reservation-row p {margin:0;}
.Reservation-row-end {text-align:right;}
@media(max-width:767px){.Reservation-history{grid-template-columns:minmax(0,1fr);}.Reservation-tabs{padding-inline:0;}}
`}</style><nav className="Reservation-tabs" aria-label="取置のメニュー">{items.map(item =>
    <GuardedLink key={item.key} to={item.path + suffix} className={selected === item.key ? "is-active" : undefined} aria-current={selected === item.key ? "page" : undefined}>{item.label}</GuardedLink>
  )}</nav></>;
}
