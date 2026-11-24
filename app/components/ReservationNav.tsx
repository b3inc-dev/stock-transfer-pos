import { useLocation } from "react-router";
import { GuardedLink } from "./admin-ui";

export function ReservationNav({ selected }: { selected: "settings" | "customers" | "history" }) {
  const { search } = useLocation();
  const items = [
    { key: "settings", label: "設定", path: "/app/reservations/settings" },
    { key: "customers", label: "顧客データ", path: "/app/reservations/customer-data" },
    { key: "history", label: "履歴", path: "/app/reservations" },
  ];
  // Keep embedded-app context, but do not carry history pagination into other sections.
  const params = new URLSearchParams(search);
  params.delete("page"); params.delete("ended"); params.delete("eventsPage");
  const suffix = params.size ? `?${params}` : "";
  return <nav className="Admin-nav" aria-label="取置のメニュー">{items.map(item =>
    <GuardedLink key={item.key} to={item.path + suffix} className={selected === item.key ? "is-active" : undefined} aria-current={selected === item.key ? "page" : undefined}>{item.label}</GuardedLink>
  )}</nav>;
}
