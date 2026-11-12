/**
 * 管理画面用の常時表示ナビゲーション（POS Receipt と同様）。
 * s-app-nav が表示されない環境でもメニューを提供する。
 */
import { Link, useLocation } from "react-router";
import type { ShopPlan } from "../routes/app";

type AppNavBarProps = {
  shopPlan: ShopPlan;
};

export function AppNavBar({ shopPlan }: AppNavBarProps) {
  const location = useLocation();
  const search = location.search || "";
  const { features, distribution } = shopPlan;

  const items: { path: string; label: string }[] = [
    { path: "/app", label: "ホーム" },
    { path: "/app/settings", label: "設定" },
  ];
  if (features.inventoryInfo) {
    items.push({ path: "/app/inventory-info", label: "在庫情報" });
  }
  items.push({ path: "/app/history", label: "入出庫" });
  if (features.purchase) {
    items.push({ path: "/app/purchase", label: "仕入" });
  }
  if (features.order) {
    items.push({ path: "/app/order", label: "発注" });
  }
  if (features.loss) {
    items.push({ path: "/app/loss", label: "ロス" });
  }
  if (features.stocktake) {
    items.push({ path: "/app/inventory-count", label: "棚卸" });
  }
  if (features.adjustment) {
    items.push({ path: "/app/adjustment", label: "調整" });
  }
  if (distribution === "public") {
    items.push({ path: "/app/plan", label: "料金プラン" });
  }

  return (
    <nav className="admin-nav" data-app-nav="pos-stock">
      {items.map(({ path, label }) => {
        const to = path + search;
        const isActive = location.pathname === path;
        return (
          <Link
            key={path}
            to={to}
            className={isActive ? "admin-nav-link is-active" : "admin-nav-link"}
            aria-current={isActive ? "page" : undefined}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
