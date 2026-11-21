// probeShopStillInstalled を本物のセッション保存先と Admin API につなぐ。
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sessionStorage, unauthenticated } from "../shopify.server";
import {
  INSTALL_PROBE_QUERY,
  parseClientIdFromToml,
  probeShopStillInstalled,
} from "./shop-install-probe";
import { resolveServerDistribution } from "./plan-distribution";

const clientIdCache = new Map<string, string | null>();

/**
 * toml の client_id を読む。起動する場所（process.cwd()）が違っても読めるように、
 * cwd と、このファイル（ビルド後は build/server/）から上へたどったところを順に探す。
 */
function readClientIdFromToml(fileName: string): string | null {
  if (clientIdCache.has(fileName)) return clientIdCache.get(fileName) ?? null;
  const dirs = [process.cwd()];
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 5; i += 1) {
      dirs.push(dir);
      dir = dirname(dir);
    }
  } catch {
    // import.meta.url が使えないときは cwd だけ
  }
  let id: string | null = null;
  for (const dir of dirs) {
    try {
      id = parseClientIdFromToml(readFileSync(resolve(dir, fileName), "utf8"));
      if (id) break;
    } catch {
      // 次の場所を見る
    }
  }
  if (!id) console.warn(`[distribution] could not read client_id from ${fileName}`);
  clientIdCache.set(fileName, id);
  return id;
}

/** 公開用アプリの client_id（shopify.app.public.toml）。読めないときは null */
export function getPublicClientId(): string | null {
  return readClientIdFromToml("shopify.app.public.toml");
}

/** 自社用アプリ（Ciara）の client_id（shopify.app.toml）。SHOPIFY_API_KEY がこれと同じなら、いつも自社用。 */
export function getInhouseClientId(): string | null {
  return readClientIdFromToml("shopify.app.toml");
}

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
