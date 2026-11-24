/** New customer-phone writes only. Existing reservation contact values stay unchanged. */
export function normalizeCustomerPhone(value) {
  let phone = String(value || "").normalize("NFKC").trim().replace(/[\s()ー-]/g, "");
  if (/^0\d{9,10}$/.test(phone)) phone = `+81${phone.slice(1)}`;
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw new Error("電話番号は国内の番号か、国番号付きの番号で入力してください");
  return phone;
}
export function customerPhoneSaveMessage(state) {
  return ({ pending: "電話番号は取置の連絡先に保存済みです。顧客情報への登録はまだ完了していません。", saving: "顧客情報への電話番号登録を確認中です。登録結果を確認してください。", saved: "電話番号を顧客情報にも登録しました。", failed: "取置は登録済みです。電話番号を顧客情報へ登録できませんでした。番号や重複を確認してください。", unknown: "取置は登録済みです。顧客情報への電話番号登録結果が不明です。登録結果を確認してください。", conflict: "顧客情報に別の電話番号が登録されています。上書きしていません。取置の連絡先は入力した番号です。" })[state] || "";
}
/** @type {Record<string, string>} */
export const CUSTOMER_PHONE_EVENT_LABELS = { customer_phone_saved: "顧客へ電話番号を登録", customer_phone_failed: "顧客への電話番号登録に失敗", customer_phone_unknown: "顧客への電話番号登録結果を確認中", customer_phone_conflict: "顧客の電話番号の変更を確認" };
