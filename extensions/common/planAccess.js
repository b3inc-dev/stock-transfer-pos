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
 * - 3 か所のプランでロケーションが 4 か所以上: POS のタイルを開くときに止める（location_limit。2026-11-22 T の決定・D17）。
 *   書き込みの途中（apply-change・履歴の記録・棚卸の完了）では止めない。止めるのは「新しい操作を始める前」だけ
 */

/** @typedef {"settings"|"history"|"transfer"|"inventoryInfo"|"purchase"|"loss"|"order"|"stocktake"|"adjustment"} PlanFeature */
/** @typedef {"allowed"|"plan_required"|"plan_check_failed"|"location_limit"} PlanAccess */

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
 * 新しい操作を始めてよいか（POS のタイルを開くとき＝/api/pos-plan だけが使う）。
 * プランの機能（decideFeatureAccess）に加えて、3 か所のプランでロケーションが多すぎないか（locationPlanMismatch）を見る。
 * ロケーション数の判定そのものは app/utils/shop-plan.server.ts の getShopPlan（管理画面と同じ 1 か所）が出す。ここでは結果を読むだけ。
 * 自社用は常に allowed。
 * @param {{ distribution?: string, plan?: string|null, planCheckFailed?: boolean, locationPlanMismatch?: boolean }} state
 * @param {PlanFeature} feature
 * @returns {PlanAccess}
 */
export function decideOperationStartAccess(state, feature) {
  if (String(state?.distribution || "").toLowerCase() === "inhouse") return "allowed";
  const access = decideFeatureAccess(state, feature);
  // 未契約・読めなかったときは、そちらの案内を先に出す（ロケーション数は契約があるときだけ意味がある）
  if (access === "plan_required" && !normalizePlan(state?.plan)) return access;
  if (access === "plan_check_failed") return access;
  if (state?.locationPlanMismatch === true && normalizePlan(state?.plan)) return "location_limit";
  return access;
}

/**
 * ロケーション数で止めたとき、どのプランにすればよいか。
 * 今の機能が Lite で使えるなら今の種類（Lite/Pro）の 10 ロケーションのプラン、Pro だけの機能なら Pro の 10 ロケーションのプラン。
 * 10 ロケーションのプランは 11 か所目から 1 か所ごとに従量（D15）なので、上限で止まらない。
 * @param {string|null|undefined} plan
 * @param {PlanFeature} feature
 * @returns {{ plan: "lite"|"pro", name: string }}
 */
export function requiredPlanForLocations(plan, feature) {
  const p = normalizePlan(plan) === "pro" || !LITE_FEATURES.includes(feature) ? "pro" : "lite";
  return { plan: p, name: p === "pro" ? "Pro - 10ロケーション" : "Lite - 10ロケーション" };
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
const ADMIN_OPEN_PATHS = ["/app", "/app/plan", "/app/keepalive"];

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
 * @param {{ locationsCount?: number, maxLocations?: number }} [locations] - location_limit のときの数（無くても文は出す）
 * @returns {{ heading: string, body: string } | null}
 */
export function buildPlanBlockMessage(access, feature, plan, locations = {}) {
  if (access === "allowed") return null;
  const label = FEATURE_LABELS[feature] || "この機能";
  if (access === "location_limit") {
    const max = Number(locations?.maxLocations) > 0 ? Number(locations.maxLocations) : 3;
    const count = Number(locations?.locationsCount) > 0 ? Number(locations.locationsCount) : null;
    const need = requiredPlanForLocations(plan, feature);
    return {
      heading: "プランを上げてください",
      body:
        `今のプランは ${max} ロケーションまでです。ストアのロケーションは ${count != null ? `${count} か所` : `${max} か所より多い`}あるため、` +
        `${label}は使えません。${PLAN_PAGE_GUIDE}で「${need.name}」に変更してください。`,
    };
  }
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
  location_limit: "location_limit",
});

/**
 * 止めたときの HTTP ステータス。契約なし・ロケーション数が多すぎるは送り直しても変わらないので 402、読めなかったは 503（送り直してよい）。
 * location_limit も 402 にする: 古い版の POS 拡張は 402 を「契約が要る」として、サーバーの heading / message をそのまま出す。
 */
export function httpStatusForPlanAccess(access) {
  if (access === "plan_required" || access === "location_limit") return 402;
  if (access === "plan_check_failed") return 503;
  return 200;
}
