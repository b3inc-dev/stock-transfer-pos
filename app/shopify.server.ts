import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";

/** shopify.app.toml の access_scopes と一致させる（SCOPES 未設定時のフォールバック） */
const DEFAULT_SCOPES =
  "read_inventory,read_inventory_transfers,read_locations,read_products,write_inventory,write_inventory_shipments,write_inventory_shipments_received_items,write_inventory_transfers,read_orders,read_users";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.January26,
  scopes: process.env.SCOPES?.trim() ? process.env.SCOPES.split(",").map((s) => s.trim()) : DEFAULT_SCOPES.split(","),
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

// shopifyオブジェクトの構造を確認（デバッグ用）
console.log("[shopify.server] shopify object keys:", Object.keys(shopify));
console.log("[shopify.server] shopify.clients:", typeof shopify.clients, !!shopify.clients);
// POS トークン検証 401 の切り分け: シークレットがランタイムで読めているか（値は出さない）
const secret = process.env.SHOPIFY_API_SECRET;
console.log("[shopify.server] SHOPIFY_API_SECRET at startup:", secret ? `set (length=${secret.length})` : "NOT SET");

export default shopify;
export const apiVersion = ApiVersion.January26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
