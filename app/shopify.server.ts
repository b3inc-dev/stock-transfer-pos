import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { getInhouseClientId, getPublicClientId } from "./utils/app-toml.server";
import { resolveAppScopes } from "./utils/default-scopes";
import { detectServerDistribution } from "./utils/plan-distribution";

/**
 * SCOPES 未設定時は toml の access_scopes と同じものを使う（app/utils/default-scopes.ts）。read_users は制限付きのため含めない。
 * 公開用は read_orders を持たない（DECISIONS D18）。どちらのサーバーかは料金プランと同じ決まりで決める。
 */
const scopes = resolveAppScopes(
  process.env.SCOPES,
  detectServerDistribution(process.env, null, getPublicClientId(), getInhouseClientId()).distribution,
);

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.January26,
  scopes,
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  future: {
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

// デバッグ用ログは開発時のみ（本番でシークレット長さ等を出さない）
if (process.env.NODE_ENV !== "production") {
  console.log("[shopify.server] shopify object keys:", Object.keys(shopify));
  console.log("[shopify.server] shopify.clients:", typeof shopify.clients, !!shopify.clients);
  const secret = process.env.SHOPIFY_API_SECRET;
  console.log("[shopify.server] SHOPIFY_API_SECRET at startup:", secret ? `set (length=${secret.length})` : "NOT SET");
}

export default shopify;
export const apiVersion = ApiVersion.January26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
