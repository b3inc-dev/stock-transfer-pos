import { authenticate } from "../shopify.server";
import { adminPlanRedirect } from "./plan-gate.server";
import { outboundRequestsEnabled } from "./outbound-requests.server";
export async function outboundAdmin(request: Request) {
  if (!outboundRequestsEnabled()) throw new Response("Not found", { status: 404 });
  const context = await authenticate.admin(request);
  const blocked = await adminPlanRedirect(request, context.admin, context.session.shop, "outboundRequest");
  if (blocked) throw blocked;
  return { ...context, actor: String(context.session.onlineAccessInfo?.associated_user?.id || "管理画面") };
}
