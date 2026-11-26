import { getAppUrl } from "../../common/appUrl.js";
export function currentRequestLocation() {
  const id = String(shopify.session.currentSession.locationId || "");
  if (/^gid:\/\/shopify\/Location\/\d+$/.test(id)) return id;
  if (/^\d+$/.test(id)) return `gid://shopify/Location/${id}`;
  throw new Error("POS店舗を取得できません");
}
export async function outboundRequestApi(input = {}) {
  const locationId = currentRequestLocation();
  if (input.originId && input.originId !== locationId) throw new Error("POS店舗が変わっています。元の店舗で開いてください");
  const token = await shopify.session.getSessionToken();
  if (!token) throw new Error("POSの利用権限を確認してください");
  const timeout = ["preview", "begin", "save"].includes(input.command) ? 90000 : 25000;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(`${getAppUrl()}/api/outbound-requests`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ ...input, locationId }), signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.error || (response.status === 404 ? "出庫依頼はまだ利用できません。管理者に確認してください" : "出庫依頼を取得できません。管理者に確認してください"));
    return data;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("応答を確認できません。同じ依頼を読み直して結果を確認してください。新しく出庫し直さないでください。");
    if (error.name === "TypeError") throw new Error("通信できません。同じ依頼を読み直して結果を確認してください。");
    throw error;
  } finally { clearTimeout(timer); }
}
