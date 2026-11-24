import { getAppUrl } from "../../common/appUrl.js";
export function locationId() {
  const value = shopify.session.currentSession.locationId;
  if (!value) throw new Error("POS店舗を取得できません");
  return `gid://shopify/Location/${value}`;
}
export async function reservationApi(input = {}) {
  const currentLocation = locationId();
  if (input.locationId && input.locationId !== currentLocation) throw new Error("POS店舗が変わっています。元の店舗で下書きを開いてください");
  const token = await shopify.session.getSessionToken();
  if (!token) throw new Error("アプリを利用する権限を確認してください");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(`${getAppUrl()}/api/reservations`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, locationId: currentLocation, staffMemberId: shopify.session.staffMember?.value?.id }), signal: controller.signal,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) { const error = new Error(result.error || (response.status === 404 ? "取置はまだ利用できません。管理者に確認してください" : "通信できませんでした。同じ取置番号から再開してください")); error.resetAllowed = result.resetAllowed === true; error.checkoutRejected = result.checkoutRejected === true; throw error; }
    return result;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("応答を確認できません。同じ取置番号で確認してください");
    throw error;
  } finally { clearTimeout(timer); }
}
export async function printReservation(row) {
  const printers = await shopify.printing.getPrinters();
  const printer = printers.find(item => item.connected);
  await shopify.printing.print(`${getAppUrl()}/api/reservations?receipt=${encodeURIComponent(row.id)}&locationId=${encodeURIComponent(locationId())}`, printer ? { printer } : undefined);
}
