/**
 * 料金プランと機能の対応（公開用アプリだけで効く。自社用 inhouse は常に全機能）。
 *
 * サーバー（管理画面・POS 用 API）と POS 拡張の両方がこの 1 か所を使う。
 * 同じ決まりを別々に書かないこと（設計: docs/PUBLIC_APP_PLAN_FEATURES_DESIGN.md、docs/DECISIONS.md D14）。
 *
 * - 契約なし（plan = null）: どの機能も使えない。ホームと料金プランだけ開ける
 * - Lite: 設定・入出庫（管理画面の履歴と POS の出庫・入庫）
 * - Pro: すべて
 * - 契約の状態を読めなかった: 止める（plan_check_failed）。「契約が要る」とは言わず、もう一度試してもらう
 */

/** @typedef {"settings"|"history"|"transfer"|"inventoryInfo"|"purchase"|"loss"|"order"|"stocktake"|"adjustment"|"reservation"|"outboundRequest"} PlanFeature */
/** @typedef {"allowed"|"plan_required"|"plan_check_failed"} PlanAccess */

/** Lite でも使える機能 */
export const LITE_FEATURES = Object.freeze(["settings", "history", "transfer"]);

/** Pro だけで使える機能 */
export const PRO_ONLY_FEATURES = Object.freeze([
  "inventoryInfo",
  "purchase",
  "loss",
  "order",
  "stocktake",
  "adjustment",
  "reservation",
  "outboundRequest",
]);

export const ALL_FEATURES = Object.freeze([...LITE_FEATURES, ...PRO_ONLY_FEATURES]);

/** 画面に出す機能の名前 */
export const FEATURE_LABELS = Object.freeze({
  settings: "設定",
  history: "入出庫",
  transfer: "出庫・入庫",
  inventoryInfo: "在庫情報",
  purchase: "仕入",
  loss: "ロス",
  order: "発注",
  stocktake: "棚卸",
  adjustment: "調整",
  reservation: "取置",
  outboundRequest: "出庫依頼",
});

function normalizePlan(plan) {
  return plan === "pro" || plan === "lite" ? plan : null;
}

/**
 * プランで使えるかどうか。
 * @param {{ distribution?: string, plan?: string|null, planCheckFailed?: boolean }} state
 * @param {PlanFeature} feature
 * @returns {PlanAccess}
 */
export function decideFeatureAccess(state, feature) {
  if (String(state?.distribution || "").toLowerCase() === "inhouse") return "allowed";
  const plan = normalizePlan(state?.plan);
  if (!plan) return state?.planCheckFailed === true ? "plan_check_failed" : "plan_required";
  if (plan === "pro") return "allowed";
  // 知らない機能名は Pro 扱い（広く開けない）
  return LITE_FEATURES.includes(feature) ? "allowed" : "plan_required";
}

/**
 * 機能ごとの使える／使えないの一覧（管理画面のメニューの出し分け用）。
 * @returns {Record<PlanFeature, boolean>}
 */
export function featuresForPlanState(state) {
  const out = {};
  for (const f of ALL_FEATURES) out[f] = decideFeatureAccess(state, f) === "allowed";
  return out;
}

/**
 * 在庫の変動（apply-change / log-inventory-change の activity）がどの機能か。
 * 知らない activity は Pro 扱い（広く開けない）。
 * @returns {PlanFeature}
 */
export function featureForActivity(activity) {
  switch (String(activity || "").trim()) {
    case "outbound_transfer":
    case "inbound_transfer":
      return "transfer";
    case "loss_entry":
      return "loss";
    case "purchase_entry":
    case "purchase_cancel":
      return "purchase";
    case "adjustment":
      return "adjustment";
    case "inventory_count":
      return "stocktake";
    default:
      return "stocktake";
  }
}

/**
 * apply-change で、契約の状態を読めなかったとき（plan_check_failed。未契約ではない）でも通す activity か。
 * 入出庫（outbound_transfer / inbound_transfer）の apply-change は、POS が Shopify で出庫のキャンセル・入庫の拒否・受領を
 * 済ませたあとに、出庫元の在庫を戻す・過不足を合わせるために呼ぶ（ModalOutbound.jsx の outbound_cancel_restore など、
 * adjustInventoryViaApplyChange.js）。ここで止めると「Shopify では済んだのに在庫は戻らない」で終わるので通す
 * （log-inventory-change・pos-stocktake-complete と同じ）。未契約（plan_required）は今まで通り止める。
 * ロス・仕入・調整・棚卸は apply-change そのものが在庫を動かす最初の操作なので、読めなければ今まで通り止める。
 * @param {string} activity
 * @returns {boolean}
 */
export function applyChangeFailsOpenOnPlanCheckError(activity) {
  return featureForActivity(activity) === "transfer";
}

/** 管理画面の URL がどの機能か。null は誰でも開ける（ホーム・料金プラン・接続維持）。 */
const ADMIN_PATH_FEATURES = [
  ["/app/receipts", "settings"],
  ["/app/outbound-requests", "outboundRequest"],
  ["/app/reservations", "reservation"],
  ["/app/settings", "settings"],
  ["/app/history", "history"],
  ["/app/export-change-history-csv", "inventoryInfo"], // 在庫情報の在庫変動履歴 CSV
  ["/app/inventory-info", "inventoryInfo"],
  ["/app/purchase", "purchase"],
  ["/app/loss", "loss"],
  ["/app/order", "order"],
  ["/app/inventory-count", "stocktake"],
  ["/app/adjustment", "adjustment"],
];
const ADMIN_OPEN_PATHS = ["/app/reservations/customer-data", "/app/reservation-privacy", "/app/reservations/privacy", "/app", "/app/plan", "/app/keepalive"];

/**
 * @param {string} pathname
 * @returns {PlanFeature|null}
 */
export function featureForAdminPath(pathname) {
  const p = String(pathname || "").replace(/\.data$/, "").replace(/\/+$/, "") || "/";
  if (ADMIN_OPEN_PATHS.includes(p)) return null;
  for (const [prefix, feature] of ADMIN_PATH_FEATURES) {
    if (p === prefix || p.startsWith(`${prefix}/`)) return feature;
  }
  // /app の下の知らない画面は Pro 扱い。/app の外（auth・webhooks・api）はここでは見ない
  if (p.startsWith("/app/")) return "stocktake";
  return null;
}

/** POS で案内する場所（POS から管理画面は開けないので、たどり方を書く） */
export const PLAN_PAGE_GUIDE = "Shopify 管理画面の「アプリ」→「POS Stock」→「料金プラン」";

/**
 * 止めたときの見出しと本文（UI_RULES 5章: 見出しは何が起きたか、本文はどうすればいいか）。
 * @param {PlanAccess} access
 * @param {PlanFeature} feature
 * @param {string|null|undefined} plan
 * @returns {{ heading: string, body: string } | null}
 */
export function buildPlanBlockMessage(access, feature, plan) {
  if (access === "allowed") return null;
  const label = FEATURE_LABELS[feature] || "この機能";
  if (access === "plan_check_failed") {
    return {
      heading: "契約の状態を確認できませんでした",
      body: "Shopify から料金プランの情報を読めませんでした。通信の状態を確かめて、もう一度お試しください。",
    };
  }
  if (normalizePlan(plan) === "lite") {
    return {
      heading: `${label}は Pro プランで使えます`,
      body: `今のプランは Lite です。${PLAN_PAGE_GUIDE}で Pro に変更してください。`,
    };
  }
  return {
    heading: "料金プランの契約が必要です",
    body: `${label}を使うには、${PLAN_PAGE_GUIDE}でプランを選んでください。無料体験があります。`,
  };
}

/** サーバーが止めたときに返す errorCode（POS 側はこれを見て送り直さない／送り直す） */
export const PLAN_ERROR_CODES = Object.freeze({
  plan_required: "plan_required",
  plan_check_failed: "plan_check_failed",
});

/** 止めたときの HTTP ステータス。契約なしは送り直しても変わらないので 402、読めなかったは 503（送り直してよい） */
export function httpStatusForPlanAccess(access) {
  if (access === "plan_required") return 402;
  if (access === "plan_check_failed") return 503;
  return 200;
}
