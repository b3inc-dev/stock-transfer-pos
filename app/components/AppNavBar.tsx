/**
 * 管理画面用の常時表示ナビゲーション（POS Receipt と同様）。
 * s-app-nav が表示されない環境でもメニューを提供する。
 * 見た目は共通の部品（admin-ui.tsx の AppNavBarView）。選択中は灰色の角丸、スマホは1行の横スライド（UI ルール v1.1 3章）。
 * 共通の CSS（AdminStyle）は、レイアウトで1回だけ描かれるこのメニューと一緒に描く（13章）。
 */
import { useLocation } from "react-router";
import { AdminStyle, AppNavBarView } from "./admin-ui";
import type { ShopPlan } from "../utils/shop-plan.server";

type AppNavBarProps = {
  shopPlan: ShopPlan;
  showReservations?: boolean;
  showReservationPrivacy?: boolean;
};

export function AppNavBar({ shopPlan, showReservations, showReservationPrivacy }: AppNavBarProps) {
  const location = useLocation();
  const search = location.search || "";
  const { features, distribution } = shopPlan;

  const items: { path: string; label: string; match?: string[] }[] = [{ path: "/app", label: "ホーム" }];
  if (features.settings) {
    items.push({ path: "/app/settings", label: "設定" });
  }
  if (features.inventoryInfo) {
    items.push({ path: "/app/inventory-info", label: "在庫情報" });
  }
  if (features.history) {
    items.push({ path: "/app/history", label: "入出庫" });
  }
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
  if ((showReservations && features.reservation) || showReservationPrivacy) items.push({ path: showReservations && features.reservation ? "/app/reservations" : "/app/reservations/customer-data", label: "取置", match: ["/app/reservations", "/app/reservation-privacy"] });
  if (distribution === "public") {
    items.push({ path: "/app/plan", label: "料金プラン" });
  }

  return (
    <>
      <AdminStyle />
      <AppNavBarView items={items} pathname={location.pathname} search={search} />
    </>
  );
}
