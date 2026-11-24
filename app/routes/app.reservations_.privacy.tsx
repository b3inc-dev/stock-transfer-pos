import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const entry = await db.stockReservationPrivacyRequest.findFirst({ where: { id: String(form.get("id")), shop: session.shop } });
  if (!entry) return new Response("Not found", { status: 404 });
  const rows = await db.stockReservation.findMany({ where: { shop: session.shop, customerId: entry.customerId },
    select: { id: true, customerId: true, contactPhone: true, locationName: true, lines: true, dueDate: true, status: true, createdAt: true, endedAt: true } });
  // Keep the request available for repeat downloads; successful HTTP delivery cannot prove receipt.
  return Response.json({ reservations: rows }, { headers: { "Cache-Control": "private, no-store", "Content-Disposition": 'attachment; filename="reservation-customer-data.json"' } });
}
