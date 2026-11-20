// probeShopStillInstalled を本物のセッション保存先と Admin API につなぐ。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sessionStorage, unauthenticated } from "../shopify.server";
import {
  INSTALL_PROBE_QUERY,
  parseClientIdFromToml,
  probeShopStillInstalled,
  resolveServerDistribution,
} from "./shop-install-probe";

let cachedPublicClientId: string | null | undefined;

/** 公開用アプリの client_id（shopify.app.public.toml）。読めないときは null（＝自社用と見る） */
export function getPublicClientId(): string | null {
  if (cachedPublicClientId !== undefined) return cachedPublicClientId;
  try {
    const toml = readFileSync(resolve(process.cwd(), "shopify.app.public.toml"), "utf8");
    cachedPublicClientId = parseClientIdFromToml(toml);
  } catch (err) {
    console.warn("[compliance] could not read shopify.app.public.toml; treating server as in-house", err);
    cachedPublicClientId = null;
  }
  return cachedPublicClientId;
}

/** この店について、サーバーが公開用か自社用か */
export function getServerDistribution(shop: string): "public" | "inhouse" {
  return resolveServerDistribution(process.env, shop, getPublicClientId());
}

export async function isShopStillInstalled(shop: string): Promise<boolean> {
  return probeShopStillInstalled({
    shop,
    findOfflineSession: async (s) => {
      const sessions = (await sessionStorage.findSessionsByShop(s)) ?? [];
      return sessions.find((session) => !session.isOnline) ?? null;
    },
    runProbeQuery: async (s) => {
      const { admin } = await unauthenticated.admin(s);
      const resp = await admin.graphql(INSTALL_PROBE_QUERY);
      const body = (await resp.json()) as { data?: { shop?: { id?: string } }; errors?: unknown };
      if (!body?.data?.shop?.id) {
        throw new Error(`install probe returned no shop: ${JSON.stringify(body?.errors ?? null)}`);
      }
      return body;
    },
  });
}
