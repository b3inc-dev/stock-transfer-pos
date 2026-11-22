// probeShopStillInstalled を本物のセッション保存先と Admin API につなぐ。
import { sessionStorage, unauthenticated } from "../shopify.server";
import { INSTALL_PROBE_QUERY, probeShopStillInstalled } from "./shop-install-probe";
import { resolveServerDistribution } from "./plan-distribution";
import { getInhouseClientId, getPublicClientId } from "./app-toml.server";

// client_id を読むところは app-toml.server.ts（shopify.server.ts も使う）。今までの import 先のために出し直す。
export { getInhouseClientId, getPublicClientId };

/** この店について、サーバーが公開用か自社用か（分からなければ自社用＝消さない） */
export function getServerDistribution(shop: string): "public" | "inhouse" {
  return resolveServerDistribution(process.env, shop, getPublicClientId(), getInhouseClientId());
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
