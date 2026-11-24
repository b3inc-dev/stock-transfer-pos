import type { ActionFunctionArgs } from "react-router";
import { authenticateWebhook } from "../utils/webhook-auth-safe.server";
import { unauthenticated } from "../shopify.server";
import { reconcileReservationOrder, reservationsEnabled } from "../utils/reservations.server";
import { RESERVATION_PROPERTY, RESERVATION_ID_PROPERTY } from "../../extensions/common/reservations.js";
export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  let webhook;
  try { webhook = await authenticateWebhook(request); }
  catch (error) { return error instanceof Response ? error : new Response(null, { status: 401 }); }
  if (!reservationsEnabled()) return new Response(null, { status: 200 });
  if (String(webhook.topic).replaceAll("_", "/").toLowerCase() !== "orders/paid") return new Response(null, { status: 400 });
  const payload = webhook.payload as { id?: number; note_attributes?: { name: string; value: string }[] };
  const reservationId = payload.note_attributes?.find(item => item.name === RESERVATION_ID_PROPERTY)?.value || payload.note_attributes?.find(item => item.name === RESERVATION_PROPERTY)?.value;
  if (!reservationId || !payload.id) return new Response(null, { status: 200 });
  try {
    const { admin } = await unauthenticated.admin(webhook.shop);
    // Never acknowledge before durable completion; Shopify retries if API/DB is unavailable.
    await reconcileReservationOrder(admin, webhook.shop, `gid://shopify/Order/${payload.id}`, reservationId);
    return new Response(null, { status: 200 });
  } catch { return new Response(null, { status: 503 }); }
}
