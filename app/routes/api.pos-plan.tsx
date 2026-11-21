// app/routes/api.pos-plan.tsx
// POS の各タイルが開いたときに「この機能を今のプランで使えるか」を聞く API。
// 決まりは extensions/common/planAccess.js、判定は app/utils/shop-plan.server.ts（管理画面と同じもの）。
// 自社用（inhouse）は GraphQL を呼ばずに allowed を返す。
// POST { feature } → 200 { ok: true, access: "allowed", plan }
//                  → 402 { ok: false, errorCode: "plan_required", heading, message }
//                  → 503 { ok: false, errorCode: "plan_check_failed", heading, message }（もう一度試してよい）
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { jwtVerify } from "jose";
import { authenticate, unauthenticated } from "../shopify.server";
import { withGraphQLRetry } from "../utils/graphql-with-retry";
import { planBlockedPosResponse } from "../utils/plan-gate.server";
import type { PlanFeature } from "../utils/shop-plan.server";
import { checkShopFeatureAccess } from "../utils/shop-plan.server";
import { ALL_FEATURES } from "../../extensions/common/planAccess.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

function json(body: object, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function shopFromDest(dest: string): string {
  try {
    const u = new URL(dest.startsWith("http") ? dest : `https://${dest}`);
    return u.hostname;
  } catch {
    return dest;
  }
}

async function decodePOSToken(token: string): Promise<{ dest?: string } | null> {
  const apiSecretKey = process.env.SHOPIFY_API_SECRET || "";
  if (!apiSecretKey) return null;
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(apiSecretKey), {
      algorithms: ["HS256"],
      clockTolerance: 10,
    });
    return payload as { dest?: string };
  } catch {
    return null;
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  return new Response(null, { status: 405, headers: CORS_HEADERS });
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return json({ ok: false, error: "Missing session token", errorCode: "auth_failed" }, 401);
  }
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  let sessionToken: { dest?: string } | null = await decodePOSToken(token);
  if (!sessionToken?.dest) {
    try {
      const auth = await authenticate.pos(request);
      sessionToken = auth.sessionToken as { dest?: string } | null;
    } catch {
      return json({ ok: false, error: "Invalid session token", errorCode: "auth_failed" }, 401);
    }
  }
  const dest = sessionToken?.dest;
  if (!dest) return json({ ok: false, error: "No shop in session token", errorCode: "auth_failed" }, 401);
  const shop = shopFromDest(dest);

  const body = (await request.json().catch(() => ({}))) as { feature?: unknown };
  const feature = String(body?.feature ?? "").trim() as PlanFeature;
  if (!(ALL_FEATURES as readonly string[]).includes(feature)) {
    return json({ ok: false, error: "Unknown feature", errorCode: "invalid_feature" }, 400);
  }

  const getAdmin = async () => {
    const { admin } = await unauthenticated.admin(shop);
    return withGraphQLRetry(admin);
  };
  const blocked = await planBlockedPosResponse({ shop, feature, getAdmin, headers: CORS_HEADERS });
  if (blocked) return blocked;
  // 通った（自社用、または契約で使える）。キャッシュ済みなので 2 回目は GraphQL を呼ばない
  const { shopPlan } = await checkShopFeatureAccess({ shop, feature, getAdmin });
  return json({ ok: true, access: "allowed", feature, plan: shopPlan.plan, distribution: shopPlan.distribution }, 200);
}
