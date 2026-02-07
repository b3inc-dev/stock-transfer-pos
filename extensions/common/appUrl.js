// アプリのベース URL 設定
// 
// 【使い方】
// - 公開アプリ用: このファイルの APP_MODE を "public" のままにしておく
// - 自社用カスタムアプリ: APP_MODE を "inhouse" に変更してビルド
//
// 【各環境の URL】
// - 開発環境（localhost）: http://localhost:3000
// - 公開アプリ（本番）: https://pos-stock-public.onrender.com
// - 自社用（本番）: https://stock-transfer-pos.onrender.com

// ============================================
// ここを変更して切り替え
// ============================================
const APP_MODE = "public"; // "public" または "inhouse"

// ============================================
// 以下は通常変更不要
// ============================================

// 開発環境用（トンネル利用時はここをトンネルURLに変更）
const DEV_APP_URL = "http://localhost:3000";

// 本番環境用（APP_MODE に応じて自動選択）
const PROD_APP_URL_PUBLIC = "https://pos-stock-public.onrender.com";
const PROD_APP_URL_INHOUSE = "https://stock-transfer-pos.onrender.com";

// 現在のモードに応じた本番 URL
const PROD_APP_URL = APP_MODE === "inhouse" 
  ? PROD_APP_URL_INHOUSE 
  : PROD_APP_URL_PUBLIC;

/**
 * アプリのベース URL を取得する
 * @param {boolean} useDev - true の場合は開発環境 URL を返す（デフォルト: false）
 * @returns {string} アプリのベース URL
 */
export function getAppUrl(useDev = false) {
  return useDev ? DEV_APP_URL : PROD_APP_URL;
}

/**
 * 開発環境 URL（トンネル利用時は手動で変更）
 */
export const DEV_URL = DEV_APP_URL;

/**
 * 本番環境 URL（APP_MODE に応じて自動選択）
 */
export const PROD_URL = PROD_APP_URL;

// デフォルトエクスポート（後方互換性のため）
export default {
  getAppUrl,
  DEV_URL,
  PROD_URL,
  APP_MODE, // 現在のモード（デバッグ用）
};
