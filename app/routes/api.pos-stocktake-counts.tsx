// app/routes/api.pos-stocktake-counts.tsx
// POS 棚卸の読み取り（db モード）。legacy / dual では storageMode だけ返し、POS は従来のメタフィールド読み書きを使う。

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { jwtVerify } from "jose";
import { authenticate, sessionStorage } from "../shopify.server";
import type { SessionStorageWithFindByShop } from "../types";
import { withGraphQLRetry } from "../utils/graphql-with-retry";
import { refreshOfflineSessionIfNeeded } from "../utils/refresh-offline-session";
import {
  getEffectiveStorageMode,
  listDbCountsMinimal,
  getDbCount,
  startDbCount,
  markMirrorDirty,
  scheduleMirrorSync,
  ensureMirrorFresh,
} from "../utils/stocktake-count-store.server";

const API_VERSION = "2026-01";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

function jsonResponse(body: object, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function secretToKey(secret: string): Uint8Array {
  const key = new Uint8Array(secret.length);
  for (let i = 0; i < secret.length; i++) key[i] = secret.charCodeAt(i);
  return key;
}

async function shopFromRequest(request: Request): Promise<string | null> {
  const authHeader = request.headers.get("authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  let dest: string | undefined;
  const secret = process.env.SHOPIFY_API_SECRET || "";
  if (secret) {
    try {
      const { payload } = await jwtVerify(token, secretToKey(secret), { algorithms: ["HS256"], clockTolerance: 10 });
      dest = (payload as { dest?: string }).dest;
    } catch {
      dest = undefined;
    }
  }
  if (!dest) {
    try {
      const auth = await authenticate.pos(request);
      dest = (auth.sessionToken as { dest?: string } | null)?.dest;
    } catch {
      return null;
    }
  }
  if (!dest) return null;
  try {
    return new URL(dest).hostname;
  } catch {
    return dest;
  }
}

async function adminForShop(shop: string) {
  const storage = sessionStorage as SessionStorageWithFindByShop;
  let sessions = await storage.findSessionsByShop(shop);
  let session = sessions?.find((s) => s.isOnline === false) ?? sessions?.[0];
  if (session) {
    const expires =
      session.expires != null
        ? new Date(typeof session.expires === "number" ? session.expires : (session.expires as Date).getTime())
        : null;
    await refreshOfflineSessionIfNeeded(session.id, session.shop, expires, session.refreshToken ?? null);
    sessions = await storage.findSessionsByShop(shop);
    session = sessions?.find((s) => s.isOnline === false) ?? sessions?.[0];
  }
  if (!session?.accessToken) return null;
  const shopDomain = session.shop;
  const accessToken = session.accessToken;
  return withGraphQLRetry({
    graphql: async (query: string, opts?: { variables?: Record<string, unknown> }) =>
      fetch(`https://${shopDomain}/admin/api/${API_VERSION}/graphql.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
        body: JSON.stringify({ query: query.replace(/^#graphql\s*/m, "").trim(), variables: opts?.variables ?? {} }),
      }),
  });
}

async function ownerIdFor(admin: { graphql: (q: string) => Promise<Response> }): Promise<string> {
  try {
    const resp = await admin.graphql(`#graphql query GetAppInstallation { currentAppInstallation { id } }`);
    const json = (await resp.json().catch(() => ({}))) as { data?: { currentAppInstallation?: { id?: string } } };
    return json?.data?.currentAppInstallation?.id ?? "";
  } catch {
    return "";
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  return new Response(null, { status: 405, headers: CORS_HEADERS });
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
  const shop = await shopFromRequest(request);
  if (!shop) return jsonResponse({ ok: false, error: "Invalid session token" }, 401);

  let body: { op?: unknown; countId?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonResponse({ ok: false, error: "Request body must be JSON" }, 400);
  }
  const op = String(body?.op ?? "mode");
  const countId = typeof body?.countId === "string" ? body.countId.trim() : "";

  const storageMode = await getEffectiveStorageMode(shop);
  if (storageMode !== "db" || op === "mode") {
    return jsonResponse({ ok: true, storageMode }, 200);
  }

  try {
    if (op === "list") {
      const counts = await listDbCountsMinimal(shop);
      void (async () => {
        const admin = await adminForShop(shop);
        const ownerId = admin ? await ownerIdFor(admin) : "";
        if (admin && ownerId) await ensureMirrorFresh(shop, admin, ownerId, "pos-list");
      })().catch((e) => console.warn("[api.pos-stocktake-counts] mirror check failed:", e));
      return jsonResponse({ ok: true, storageMode, counts }, 200);
    }
    if (op === "get") {
      if (!countId) return jsonResponse({ ok: false, error: "countId は必須です" }, 400);
      const rec = await getDbCount(shop, countId);
      return jsonResponse({ ok: true, storageMode, count: rec?.count ?? null }, 200);
    }
    if (op === "start") {
      if (!countId) return jsonResponse({ ok: false, error: "countId は必須です" }, 400);
      const before = await getDbCount(shop, countId);
      const count = await startDbCount(shop, countId);
      if (before?.count?.status === "draft" && count?.status === "in_progress") {
        await markMirrorDirty(shop);
        const admin = await adminForShop(shop);
        const ownerId = admin ? await ownerIdFor(admin) : "";
        if (admin && ownerId) scheduleMirrorSync(shop, admin, ownerId, "pos-start");
      }
      return jsonResponse({ ok: true, storageMode, count }, 200);
    }
    return jsonResponse({ ok: false, error: `unknown op: ${op}` }, 400);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[api.pos-stocktake-counts] failed:", msg);
    return jsonResponse({ ok: false, storageMode, error: msg }, 500);
  }
}
