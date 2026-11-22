// Partner API で店の契約（Shopify App Pricing の activeSubscription）を読む。
//
// - shopify.dev の App Pricing の説明では、店の今の契約を確かめる正しい場所は Partner API の
//   `activeSubscription(appId:, shopId:)`。Admin API の `currentAppInstallation.activeSubscriptions` に
//   App Pricing の契約が出るかは書かれていない（未確認）。
// - 既定はオフ。`PARTNER_API_SUBSCRIPTION_ENABLED=1` と、トークン・Partner ID・アプリ ID が全部そろったときだけ使う。
// - トークンはログにもエラーにも出さない。
// - 同じ内容のファイルを location-stock-indicator・review-qa にも置いている（リポジトリをまたぐ共通パッケージは作らない）。
//   直すときは 3 つとも同じように直す。
//
// このファイルはほかのファイルを import しない（node --test から直接読むため）。

export const PARTNER_API_DEFAULT_VERSION = "2026-10";
export const PARTNER_API_TIMEOUT_MS = 5_000;
/** 契約が見つかったときに覚える時間 */
export const PARTNER_CACHE_FOUND_MS = 60_000;
/** 契約が無かったときに覚える時間（契約した直後にすぐ使えるよう短く） */
export const PARTNER_CACHE_NONE_MS = 15_000;

export type PartnerApiConfig = {
  token: string;
  /** Partner Dashboard の URL にある数字（Dev Dashboard の数字＝organization ID ではない） */
  partnerId: string;
  /** gid://shopify/App/<数字> */
  appGid: string;
  apiVersion: string;
};

export type PartnerApiConfigResult =
  | { enabled: true; config: PartnerApiConfig }
  | { enabled: false; reason: "switch_off" | "missing_config"; missing?: string[] };

type Env = Record<string, string | undefined>;

/** 数字・gid://shopify/<kind>/<数字>・gid://partners/<kind>/<数字> を gid://shopify/<kind>/<数字> にそろえる */
export function toShopifyGid(kind: "App" | "Shop", value: unknown): string | null {
  const s = String(value ?? "").trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return `gid://shopify/${kind}/${s}`;
  const m = s.match(/^gid:\/\/(?:shopify|partners)\/([A-Za-z]+)\/(\d+)(?:\?.*)?$/);
  if (m && m[1] === kind) return `gid://shopify/${kind}/${m[2]}`;
  return null;
}

/** スイッチと設定を読む。足りないものは名前だけ返す（値は返さない） */
export function readPartnerApiConfig(env: Env = process.env): PartnerApiConfigResult {
  if (String(env.PARTNER_API_SUBSCRIPTION_ENABLED ?? "").trim() !== "1") {
    return { enabled: false, reason: "switch_off" };
  }
  const token = String(env.PARTNER_API_TOKEN ?? "").trim();
  const partnerId = String(env.PARTNER_API_ORG_ID ?? "").trim();
  const appGid = toShopifyGid("App", env.PARTNER_API_APP_ID);
  const missing: string[] = [];
  if (!token) missing.push("PARTNER_API_TOKEN");
  if (!/^\d+$/.test(partnerId)) missing.push("PARTNER_API_ORG_ID");
  if (!appGid) missing.push("PARTNER_API_APP_ID");
  if (missing.length > 0) return { enabled: false, reason: "missing_config", missing };
  const apiVersion = String(env.PARTNER_API_VERSION ?? "").trim() || PARTNER_API_DEFAULT_VERSION;
  return { enabled: true, config: { token, partnerId, appGid: appGid as string, apiVersion } };
}

export function partnerApiEndpoint(config: Pick<PartnerApiConfig, "partnerId" | "apiVersion">): string {
  return `https://partners.shopify.com/${encodeURIComponent(config.partnerId)}/api/${encodeURIComponent(config.apiVersion)}/graphql.json`;
}

export type PartnerSubscription = {
  /** 契約の項目の handle（料金プランの設定の handle と同じ） */
  handles: string[];
  /** handles をつないだ名前（Admin API の name と同じ読み方でプランを判定するため） */
  name: string;
  billingPeriod: string | null;
  cancelAtEndOfCycle: boolean;
  trialEndsAt: string | null;
  /** 今の請求期間の終わり。試用中は null */
  currentPeriodEnd: string | null;
  /** Admin API の AppSubscription の ID（あれば） */
  legacySubscriptionId: string | null;
};

export type PartnerLookupFailure =
  | "bad_shop_id"
  | "timeout"
  | "network_error"
  | "throttled"
  | "http_error"
  | "graphql_error"
  | "bad_response";

export type PartnerLookup =
  | { ok: true; subscription: PartnerSubscription | null; cached: boolean }
  | { ok: false; reason: PartnerLookupFailure; status?: number };

export const ACTIVE_SUBSCRIPTION_QUERY = `query AppActiveSubscription($appId: ID!, $shopId: ID!) {
  activeSubscription(appId: $appId, shopId: $shopId) {
    billingPeriod
    cancelAtEndOfCycle
    trialEndsAt
    legacySubscriptionId
    currentBillingCycle { startTime endTime }
    items { handle }
  }
}`;

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  status: number;
  ok?: boolean;
  text: () => Promise<string>;
}>;

function isThrottleErrors(errors: unknown): boolean {
  if (!Array.isArray(errors)) return false;
  return errors.some((e) => {
    const code = String((e as { extensions?: { code?: unknown } })?.extensions?.code ?? "");
    const msg = String((e as { message?: unknown })?.message ?? "");
    return code === "429" || code.toUpperCase() === "THROTTLED" || /too many requests/i.test(msg);
  });
}

/** Partner API の activeSubscription の答えを読む（テストのため外に出している） */
export function parseActiveSubscriptionResponse(status: number, text: string): PartnerLookup {
  if (status === 429) return { ok: false, reason: "throttled", status };
  let json: { data?: { activeSubscription?: unknown }; errors?: unknown } | null = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (json && isThrottleErrors(json.errors)) return { ok: false, reason: "throttled", status };
  if (status < 200 || status >= 300) return { ok: false, reason: "http_error", status };
  if (!json || typeof json !== "object") return { ok: false, reason: "bad_response", status };
  if (Array.isArray(json.errors) && json.errors.length > 0) return { ok: false, reason: "graphql_error", status };
  if (!json.data || !("activeSubscription" in json.data)) return { ok: false, reason: "bad_response", status };
  const raw = json.data.activeSubscription as
    | {
        billingPeriod?: unknown;
        cancelAtEndOfCycle?: unknown;
        trialEndsAt?: unknown;
        legacySubscriptionId?: unknown;
        currentBillingCycle?: { endTime?: unknown } | null;
        items?: Array<{ handle?: unknown }> | null;
      }
    | null;
  if (raw === null) return { ok: true, subscription: null, cached: false };
  if (typeof raw !== "object") return { ok: false, reason: "bad_response", status };
  const handles = (Array.isArray(raw.items) ? raw.items : [])
    .map((i) => String(i?.handle ?? "").trim())
    .filter(Boolean);
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    ok: true,
    cached: false,
    subscription: {
      handles,
      name: handles.join(" "),
      billingPeriod: str(raw.billingPeriod),
      cancelAtEndOfCycle: raw.cancelAtEndOfCycle === true,
      trialEndsAt: str(raw.trialEndsAt),
      currentPeriodEnd: str(raw.currentBillingCycle?.endTime),
      legacySubscriptionId: str(raw.legacySubscriptionId),
    },
  };
}

/** Partner API に 1 回聞く（覚えない）。投げない */
export async function fetchPartnerActiveSubscription(args: {
  config: PartnerApiConfig;
  shopGid: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<PartnerLookup> {
  const shopGid = toShopifyGid("Shop", args.shopGid);
  if (!shopGid) return { ok: false, reason: "bad_shop_id" };
  const fetchImpl = args.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? PARTNER_API_TIMEOUT_MS);
  try {
    const resp = await fetchImpl(partnerApiEndpoint(args.config), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Shopify-Access-Token": args.config.token,
      },
      body: JSON.stringify({
        query: ACTIVE_SUBSCRIPTION_QUERY,
        variables: { appId: args.config.appGid, shopId: shopGid },
      }),
      signal: controller.signal,
    });
    const text = await resp.text().catch(() => "");
    return parseActiveSubscriptionResponse(resp.status, text);
  } catch (e) {
    const aborted = controller.signal.aborted || (e instanceof Error && e.name === "AbortError");
    return { ok: false, reason: aborted ? "timeout" : "network_error" };
  } finally {
    clearTimeout(timer);
  }
}

const cache = new Map<string, { result: PartnerLookup & { ok: true }; at: number }>();
const inflight = new Map<string, Promise<PartnerLookup>>();

/**
 * 店ごとに少しのあいだ覚えて Partner API に聞く（4 回/秒の上限があるため）。
 * 失敗は覚えない（次の呼び出しでもう一度聞く）。ログは理由と店のドメインだけ（トークンは出さない）。
 */
export async function getPartnerActiveSubscription(args: {
  config: PartnerApiConfig;
  shopGid: string;
  shop?: string | null;
  fetchImpl?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
}): Promise<PartnerLookup> {
  const now = args.now ?? Date.now;
  const shopGid = toShopifyGid("Shop", args.shopGid);
  if (!shopGid) return { ok: false, reason: "bad_shop_id" };
  const key = `${args.config.appGid}|${shopGid}`;
  const hit = cache.get(key);
  if (hit) {
    const ttl = hit.result.subscription ? PARTNER_CACHE_FOUND_MS : PARTNER_CACHE_NONE_MS;
    if (now() - hit.at < ttl) return { ...hit.result, cached: true };
    cache.delete(key);
  }
  const running = inflight.get(key);
  if (running) return running;
  const p = (async () => {
    const result = await fetchPartnerActiveSubscription({
      config: args.config,
      shopGid,
      fetchImpl: args.fetchImpl,
      timeoutMs: args.timeoutMs,
    });
    if (result.ok) {
      cache.set(key, { result, at: now() });
    } else {
      console.warn(
        `[partner-subscription] lookup failed: reason=${result.reason}${result.status ? ` status=${result.status}` : ""} shop=${args.shop ?? shopGid}`
      );
    }
    return result;
  })();
  inflight.set(key, p);
  try {
    return await p;
  } finally {
    inflight.delete(key);
  }
}

/** Admin API の activeSubscriptions と同じ形にする（プランの判定を 1 つの決まりで行うため） */
export function partnerSubscriptionToAdminShape(sub: PartnerSubscription, shopGid: string) {
  return {
    id: sub.legacySubscriptionId ?? `partner:${shopGid}`,
    name: sub.name,
    status: "ACTIVE",
    currentPeriodEnd: sub.currentPeriodEnd,
  };
}

/** テスト用 */
export function __clearPartnerSubscriptionCacheForTest() {
  cache.clear();
  inflight.clear();
}
