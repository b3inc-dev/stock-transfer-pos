/**
 * 10 か所を超えたロケーションの従量を Shopify App Events API で報告する（公開用だけ）。
 *
 * T の決定（2026-11-21）: 料金は Shopify App Pricing。Billing API の従量（appUsageRecordCreate）はやめ、
 * 10 か所を超えた分（Lite $4 / Pro $12 ×か所）を App Events API の使用量イベントで送る。
 * 上限は Shopify 側に無い（App Pricing は usage cap 非対応）ので、アプリ側の上限（APP_EVENTS_USAGE_MAX_UNITS）で止める。
 *
 * 決まり:
 * - 1 店・1 請求期間（Shopify の currentPeriodEnd）につき 1 回だけ送る。DB（AppUsageReport）の
 *   (shop, periodEnd) の一意と、Shopify の idempotency_key（請求イベントは永久に重複しない）の 2 重で守る。
 * - 外へ送るのは APP_EVENTS_USAGE_ENABLED=1 のときだけ（既定オフ）。オフでも数は DB に「disabled」で残す。
 * - 失敗は黙って捨てない。DB に status=failed・HTTP の番号・理由を残し、時間をおいて同じキーで送り直す（同じキーなので二重請求にならない）。
 * - 上限を超えた分は送らず status=over_limit で残す（T が上限を見直すと次の確認で送る）。
 * - 自社用（Ciara）はここに来ない（呼ぶ側で distribution === "public" を確かめる）。
 *
 * Shopify の仕様（2026-11-21 shopify.dev で確認）:
 * - トークン: POST https://api.shopify.com/auth/access_token（client_credentials。60 分有効）
 * - 送信: POST https://api.shopify.com/app/{version}/events（1 件ずつ。202 は「受け取った」だけで、請求の成否は Dev Dashboard の Logs）
 * - body: shop_id / event_handle（Partner Dashboard のメーターの handle）/ timestamp（今の請求期間の中）/ idempotency_key（64 文字まで）/ attributes.value（0 以外）
 *
 * このファイルは他のアプリのファイルを import しない（node --test でそのまま読めるように）。
 */

export type UsagePlan = "lite" | "pro";

export type UsageReportStatus = "disabled" | "sending" | "sent" | "failed" | "over_limit";

export type UsageReportRow = {
  id: string;
  shop: string;
  periodEnd: string;
  plan: string;
  eventHandle: string;
  locationsCount: number;
  units: number;
  idempotencyKey: string;
  status: string;
  httpStatus: number | null;
  lastError: string | null;
  attempts: number;
  sentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Prisma の appUsageReport の、ここで使う形だけ（テストでは偽物を渡す） */
export type UsageReportStore = {
  findUnique(args: { where: { shop_periodEnd: { shop: string; periodEnd: string } } }): Promise<UsageReportRow | null>;
  create(args: { data: Record<string, unknown> }): Promise<UsageReportRow>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
  update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<UsageReportRow>;
};

type Env = Record<string, string | undefined>;
type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  status: number;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
}>;

/** 10 か所までは基本料に含む */
export const INCLUDED_LOCATIONS = 10;

/** 10 か所を超えた 1 か所あたりの単価（USD/月）。docs/PUBLIC_APP_PLAN_FEATURES_DESIGN.md 2.2 */
export const EXTRA_LOCATION_PRICE_USD: Record<UsagePlan, number> = { lite: 4, pro: 12 };

export const DEFAULT_APP_EVENTS_API_VERSION = "2026-10";
export const DEFAULT_EVENT_HANDLES: Record<UsagePlan, string> = {
  lite: "extra_location_lite",
  pro: "extra_location_pro",
};
/** アプリ側の上限（1 期間に送る「超えた分の か所」）。超えたら送らずに残す */
export const DEFAULT_MAX_UNITS = 50;
/** 失敗のあと、同じ期間をもう一度送るまで待つ時間 */
export const RETRY_AFTER_MS = 10 * 60_000;
/** 送り直す回数の上限（超えたら failed のまま。T が見る） */
export const MAX_ATTEMPTS = 8;
/** sending のまま止まった行（落ちたなど）を取り直すまでの時間 */
export const STALE_SENDING_MS = 5 * 60_000;
/** 同じ店・同じ期間の DB 確認の間隔（POS の API で何度も呼ばれても DB を毎回読まない） */
export const RECHECK_MS = 10 * 60_000;

export function isUsageReportingEnabled(env: Env = process.env): boolean {
  return String(env.APP_EVENTS_USAGE_ENABLED ?? "").trim() === "1";
}

export function getEventHandle(plan: UsagePlan, env: Env = process.env): string {
  const key = plan === "pro" ? "APP_EVENTS_HANDLE_PRO" : "APP_EVENTS_HANDLE_LITE";
  return String(env[key] ?? "").trim() || DEFAULT_EVENT_HANDLES[plan];
}

export function getMaxUnits(env: Env = process.env): number {
  const n = Number(String(env.APP_EVENTS_USAGE_MAX_UNITS ?? "").trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_UNITS;
}

/** 店に見せる・送る数（純粋な計算） */
export function computeExtraLocationUsage(plan: UsagePlan, locationsCount: number) {
  const count = Math.max(0, Math.floor(Number(locationsCount) || 0));
  const units = Math.max(0, count - INCLUDED_LOCATIONS);
  const unitPriceUsd = EXTRA_LOCATION_PRICE_USD[plan];
  return { locationsCount: count, units, unitPriceUsd, amountUsd: units * unitPriceUsd };
}

/** gid://shopify/Shop/123 → "123" */
export function numericShopId(shopGid: string): string | null {
  const m = String(shopGid ?? "").match(/(\d+)\s*$/);
  return m ? m[1] : null;
}

/**
 * 1 店・1 期間で変わらないキー（64 文字まで）。
 * 例: pstk-xloc-12345678-20261221T000000Z
 */
export function buildIdempotencyKey(shopGid: string, periodEnd: string): string | null {
  const id = numericShopId(shopGid);
  const t = Date.parse(periodEnd);
  if (!id || !Number.isFinite(t)) return null;
  const stamp = new Date(t).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const key = `pstk-xloc-${id}-${stamp}`;
  return key.length <= 64 ? key : null;
}

/** 失敗をもう一度送ってよいか（同じキーなので二重請求にはならない） */
export function isRetryableHttpStatus(status: number | null): boolean {
  if (status == null) return true; // 通信の失敗
  return status === 401 || status === 409 || status === 429 || status >= 500;
}

// ---- トークン（client_credentials。60 分有効なので 50 分で取り直す） ----
let tokenCache: { token: string; expiresAt: number } | null = null;

export function __resetAppEventsTokenForTest() {
  tokenCache = null;
}

async function getAccessToken(env: Env, fetchImpl: FetchLike, now: number): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > now) return tokenCache.token;
  const clientId = String(env.APP_EVENTS_CLIENT_ID ?? "").trim();
  const clientSecret = String(env.APP_EVENTS_CLIENT_SECRET ?? "").trim();
  if (!clientId || !clientSecret) throw new UsageSendError("APP_EVENTS_CLIENT_ID / APP_EVENTS_CLIENT_SECRET が未設定", null);
  const res = await fetchImpl("https://api.shopify.com/auth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "pos-stock-app" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, grant_type: "client_credentials" }),
  });
  const text = await res.text().catch(() => "");
  if (res.status !== 200) throw new UsageSendError(`token ${res.status}: ${text.slice(0, 200)}`, res.status);
  let token = "";
  try {
    token = String((JSON.parse(text) as { access_token?: string }).access_token ?? "");
  } catch {
    token = "";
  }
  if (!token) throw new UsageSendError("token response has no access_token", res.status);
  tokenCache = { token, expiresAt: now + 50 * 60_000 };
  return token;
}

class UsageSendError extends Error {
  httpStatus: number | null;
  constructor(message: string, httpStatus: number | null) {
    super(message);
    this.httpStatus = httpStatus;
  }
}

/** App Events API に 1 件送る。202 なら受け取られた（請求の成否は Dev Dashboard の Logs） */
export async function sendUsageEvent(
  args: { shopGid: string; eventHandle: string; idempotencyKey: string; units: number },
  deps: { env?: Env; fetchImpl?: FetchLike; now?: number } = {}
): Promise<{ httpStatus: number; replay: boolean }> {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const now = deps.now ?? Date.now();
  const token = await getAccessToken(env, fetchImpl, now);
  const version = String(env.APP_EVENTS_API_VERSION ?? "").trim() || DEFAULT_APP_EVENTS_API_VERSION;
  const res = await fetchImpl(`https://api.shopify.com/app/${encodeURIComponent(version)}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "User-Agent": "pos-stock-app" },
    body: JSON.stringify({
      shop_id: args.shopGid,
      event_handle: args.eventHandle,
      timestamp: new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z"),
      idempotency_key: args.idempotencyKey,
      attributes: { value: args.units },
    }),
  });
  const text = await res.text().catch(() => "");
  if (res.status === 401) tokenCache = null;
  if (res.status !== 202 && res.status !== 200) {
    throw new UsageSendError(`events ${res.status}: ${text.slice(0, 300)}`, res.status);
  }
  let success = true;
  try {
    const body = JSON.parse(text) as { success?: boolean; error?: string };
    if (body && body.success === false) success = false;
    if (!success) throw new UsageSendError(`events ${res.status}: ${String(body.error ?? "success=false")}`, res.status);
  } catch (e) {
    if (e instanceof UsageSendError) throw e;
  }
  const replay = String(res.headers?.get("Idempotent-Replay") ?? "").toLowerCase() === "true";
  return { httpStatus: res.status, replay };
}

export type ReportUsageInput = {
  shop: string;
  shopGid: string | null;
  plan: UsagePlan;
  locationsCount: number;
  /** Shopify の activeSubscriptions[].currentPeriodEnd */
  periodEnd: string | null;
};

export type ReportUsageResult =
  | { outcome: "skipped"; reason: "no_extra_locations" | "missing_period" | "missing_shop_id" | "recently_checked" | "in_progress" | "lost_race" | "max_attempts" | "not_retryable" | "waiting_retry" }
  | { outcome: "already_sent"; row: UsageReportRow }
  | { outcome: "disabled" | "over_limit" | "sent" | "failed"; row: UsageReportRow };

const recentChecks = new Map<string, number>();
export function __resetUsageRecheckForTest() {
  recentChecks.clear();
}

/**
 * 10 か所を超えていれば、この期間の分を 1 回だけ報告する。何度呼んでも安全（同じ期間は 1 件だけ）。
 * 呼ぶ側は await しなくてよい（失敗は DB と console に残る。投げない）。
 */
export async function reportExtraLocationUsage(
  input: ReportUsageInput,
  deps: { store: UsageReportStore; env?: Env; fetchImpl?: FetchLike; now?: () => number; force?: boolean }
): Promise<ReportUsageResult> {
  const env = deps.env ?? process.env;
  const nowFn = deps.now ?? Date.now;
  const usage = computeExtraLocationUsage(input.plan, input.locationsCount);
  if (usage.units <= 0) return { outcome: "skipped", reason: "no_extra_locations" };
  if (!input.periodEnd || !Number.isFinite(Date.parse(input.periodEnd))) {
    console.warn(`[app-events-usage] no currentPeriodEnd; cannot report. shop=${input.shop}`);
    return { outcome: "skipped", reason: "missing_period" };
  }
  const idempotencyKey = input.shopGid ? buildIdempotencyKey(input.shopGid, input.periodEnd) : null;
  if (!input.shopGid || !idempotencyKey) {
    console.warn(`[app-events-usage] no shop id; cannot report. shop=${input.shop}`);
    return { outcome: "skipped", reason: "missing_shop_id" };
  }

  const memoKey = `${input.shop}|${input.periodEnd}`;
  const now = nowFn();
  if (!deps.force) {
    const last = recentChecks.get(memoKey);
    if (last != null && now - last < RECHECK_MS) return { outcome: "skipped", reason: "recently_checked" };
  }
  recentChecks.set(memoKey, now);

  const store = deps.store;
  const where = { shop_periodEnd: { shop: input.shop, periodEnd: input.periodEnd } };
  const enabled = isUsageReportingEnabled(env);
  const maxUnits = getMaxUnits(env);
  const eventHandle = getEventHandle(input.plan, env);

  let row = await store.findUnique({ where });
  if (row?.status === "sent") return { outcome: "already_sent", row };

  // 一度でも送ろうとした行は、数を変えない（Shopify 側に届いているかもしれない値と DB を揃える）
  const frozen = row != null && row.attempts > 0;
  const units = frozen ? row!.units : usage.units;
  const fields = frozen
    ? {}
    : { plan: input.plan, eventHandle, locationsCount: usage.locationsCount, units: usage.units };

  // 送らない状態（スイッチオフ・上限超え）は数と理由だけ残す
  const holdStatus: UsageReportStatus | null = !enabled ? "disabled" : !frozen && units > maxUnits ? "over_limit" : null;
  if (holdStatus) {
    const lastError =
      holdStatus === "disabled"
        ? "APP_EVENTS_USAGE_ENABLED がオフのため送っていない"
        : `アプリ側の上限を超えた（${units} > APP_EVENTS_USAGE_MAX_UNITS=${maxUnits}）ため送っていない`;
    if (holdStatus === "over_limit") {
      console.error(`[app-events-usage] over app-side limit; not sent. shop=${input.shop} units=${units} max=${maxUnits}`);
    }
    if (!row) {
      try {
        row = await store.create({
          data: { shop: input.shop, periodEnd: input.periodEnd, idempotencyKey, status: holdStatus, lastError, attempts: 0, ...fields },
        });
      } catch {
        row = await store.findUnique({ where });
        if (!row) return { outcome: "skipped", reason: "lost_race" };
      }
    } else if (row.status !== "sending") {
      row = await store.update({ where: { id: row.id }, data: { status: holdStatus, lastError, ...fields } });
    }
    return { outcome: holdStatus, row };
  }

  // ---- 送る権利を取る（同時に 2 つ送らない） ----
  if (!row) {
    try {
      row = await store.create({
        data: { shop: input.shop, periodEnd: input.periodEnd, idempotencyKey, status: "sending", attempts: 1, ...fields },
      });
    } catch {
      return { outcome: "skipped", reason: "lost_race" };
    }
  } else {
    const age = now - new Date(row.updatedAt).getTime();
    if (row.status === "sending" && age < STALE_SENDING_MS) return { outcome: "skipped", reason: "in_progress" };
    if (row.status === "failed") {
      if (row.attempts >= MAX_ATTEMPTS) return { outcome: "skipped", reason: "max_attempts" };
      if (row.httpStatus != null && !isRetryableHttpStatus(row.httpStatus) && !deps.force) {
        return { outcome: "skipped", reason: "not_retryable" };
      }
      if (age < RETRY_AFTER_MS && !deps.force) return { outcome: "skipped", reason: "waiting_retry" };
    }
    const claimed = await store.updateMany({
      where: { id: row.id, status: row.status, updatedAt: row.updatedAt },
      data: { status: "sending", attempts: row.attempts + 1, ...fields },
    });
    if (claimed.count !== 1) return { outcome: "skipped", reason: "lost_race" };
  }

  const key = row.idempotencyKey || idempotencyKey;
  const handle = frozen ? row.eventHandle : eventHandle;
  try {
    const sent = await sendUsageEvent(
      { shopGid: input.shopGid, eventHandle: handle, idempotencyKey: key, units },
      { env, fetchImpl: deps.fetchImpl, now: nowFn() }
    );
    row = await store.update({
      where: { id: row.id },
      data: { status: "sent", httpStatus: sent.httpStatus, lastError: sent.replay ? "Idempotent-Replay（前に届いていた）" : null, sentAt: new Date(nowFn()) },
    });
    console.info(`[app-events-usage] sent shop=${input.shop} units=${units} handle=${handle} key=${key}`);
    return { outcome: "sent", row };
  } catch (e) {
    const httpStatus = e instanceof UsageSendError ? e.httpStatus : null;
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    console.error(`[app-events-usage] send failed shop=${input.shop} status=${httpStatus ?? "network"} ${message}`);
    row = await store.update({ where: { id: row.id }, data: { status: "failed", httpStatus, lastError: message } });
    return { outcome: "failed", row };
  }
}

/** 店に見せる「報告の状態」（料金プラン画面） */
export function describeUsageReportForMerchant(row: Pick<UsageReportRow, "status"> | null): string {
  switch (row?.status) {
    case "sent":
      return "今の請求期間の分は Shopify に報告済みです。請求は Shopify の請求書に載ります。";
    case "failed":
      return "Shopify への報告がまだ済んでいません。アプリが時間をおいて自動でやり直します。";
    case "over_limit":
      return "超えた数がアプリの上限を超えているため、まだ報告していません。サポートが確認します。";
    case "sending":
      return "Shopify に報告しています。";
    default:
      return "今の請求期間の分は、まだ Shopify に報告していません。";
  }
}
