/**
 * POS 拡張 → アプリ API 共通認証（JWT Bearer または authenticate.pos）。
 * api.pos-stocktake-complete と同じパターン。
 */
import { jwtVerify } from "jose";
import { authenticate, sessionStorage } from "../shopify.server";
import type { SessionStorageWithFindByShop } from "../types";
import { withGraphQLRetry } from "./graphql-with-retry";
import { refreshOfflineSessionIfNeeded } from "./refresh-offline-session";

const API_VERSION = "2026-01";

export const POS_API_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

export function posJsonResponse(body: object, status: number, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...POS_API_CORS_HEADERS, ...headers },
  });
}

function shopFromDest(dest: string): string {
  try {
    const u = new URL(dest);
    return u.hostname;
  } catch {
    return dest;
  }
}

function secretToKey(secret: string): Uint8Array {
  const key = new Uint8Array(secret.length);
  for (let i = 0; i < secret.length; i++) key[i] = secret.charCodeAt(i);
  return key;
}

async function decodePOSToken(token: string): Promise<{ dest?: string } | null> {
  const apiSecretKey = process.env.SHOPIFY_API_SECRET || "";
  if (!apiSecretKey) return null;
  try {
    const key = secretToKey(apiSecretKey);
    const { payload } = await jwtVerify(token, key, {
      algorithms: ["HS256"],
      clockTolerance: 10,
    });
    return payload as { dest?: string };
  } catch (e: unknown) {
    console.warn("[pos-session-auth] decodeSessionToken error:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

export type PosAuthResult = {
  shop: string;
  accessToken: string;
  admin: {
    graphql: (query: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response>;
  };
};

export async function authenticatePosRequest(request: Request): Promise<PosAuthResult | Response> {
  const authHeader = request.headers.get("Authorization") || "";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";

  let shop = "";
  let accessToken = "";

  if (bearerToken) {
    const payload = await decodePOSToken(bearerToken);
    if (payload?.dest) {
      shop = shopFromDest(payload.dest);
      const storage = sessionStorage as SessionStorageWithFindByShop;
      if (typeof storage.findSessionsByShop === "function") {
        const sessions = await storage.findSessionsByShop(shop);
        const offline = sessions?.find((s) => s.id?.startsWith("offline_") || !s.isOnline) ?? sessions?.[0];
        if (offline?.id) {
          await refreshOfflineSessionIfNeeded(
            offline.id,
            offline.shop,
            offline.expires ?? null,
            offline.refreshToken ?? null
          );
          const session = await sessionStorage.loadSession(offline.id);
          accessToken = session?.accessToken || "";
          shop = session?.shop || shop;
        }
      }
    }
  }

  if (!shop || !accessToken) {
    try {
      const posAuth = await authenticate.pos(request);
      shop = posAuth.session.shop;
      accessToken = posAuth.session.accessToken || "";
    } catch (e: unknown) {
      console.warn("[pos-session-auth] authenticate.pos failed:", e instanceof Error ? e.message : String(e));
      return posJsonResponse({ ok: false, error: "Unauthorized" }, 401);
    }
  }

  if (!shop || !accessToken) {
    return posJsonResponse({ ok: false, error: "Unauthorized" }, 401);
  }

  let admin = {
    graphql: async (query: string, opts?: { variables?: Record<string, unknown> }) => {
      const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          query: query.replace(/^#graphql\s*/m, "").trim(),
          variables: opts?.variables || {},
        }),
      });
      return res;
    },
  };
  admin = withGraphQLRetry(admin);
  return { shop, accessToken, admin };
}
