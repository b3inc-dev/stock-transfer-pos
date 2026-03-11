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
    <nav
      data-app-nav="pos-stock"
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: "4px 16px",
        alignItems: "center",
        padding: "12px 20px",
        marginBottom: "16px",
        background: "#f6f6f7",
        borderBottom: "1px solid #e1e3e5",
        fontSize: "14px",
        position: "relative",
        zIndex: 100,
        minHeight: "44px",
        boxSizing: "border-box",
      }}
    >
      {items.map(({ path, label }) => {
        const to = path + search;
        const isActive = location.pathname === path;
        return (
          <Link
            key={path}
            to={to}
            style={{
              color: isActive ? "#2c6ecb" : "#202223",
              fontWeight: isActive ? 600 : 400,
              textDecoration: "none",
            }}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
