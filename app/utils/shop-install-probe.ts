// shop/redact の前に「この店にまだアプリが入っているか」を確かめるための部品。
//
// shop/redact はアンインストールの 48 時間後に届く。そのあいだに入れ直した店に届いたとき、
// 入れ直したあとのデータを消さないよう、消す前にオフラインのセッションで Admin API を 1 回呼ぶ。
// - オフラインのセッションが無い → 入っていない → 消してよい（false）
// - 呼べた → 今も入っている → 消さない（true）
// - 401 / 403 / トークンが無効 → 入っていない → 消してよい（false）
// - それ以外の失敗（通信・5xx など）→ 分からないので投げる（ルートが 500 を返し、Shopify がもう一度送る）

export const INSTALL_PROBE_QUERY = `#graphql
  query ComplianceInstallProbe {
    shop { id }
  }
`;

type ErrorLike = {
  message?: unknown;
  status?: unknown;
  statusCode?: unknown;
  response?: { code?: unknown; status?: unknown; body?: unknown };
};

function statusOf(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  if (typeof Response !== "undefined" && err instanceof Response) return err.status;
  const e = err as ErrorLike;
  for (const c of [e.response?.code, e.response?.status, e.status, e.statusCode]) {
    const n = Number(c);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return null;
}

/** 失敗が「アプリが入っていない／トークンが無効」を表すか */
export function isNotInstalledError(err: unknown): boolean {
  const status = statusOf(err);
  if (status === 401 || status === 403) return true;
  const e = (err ?? {}) as ErrorLike;
  const text = [e.message, e.response?.body ? JSON.stringify(e.response.body) : ""]
    .filter(Boolean)
    .map(String)
    .join(" ");
  return /invalid_grant|invalid_token|invalid_subject_token|Invalid API key or access token|SessionNotFound|Could not find a session/i.test(
    text,
  );
}

/** true = 今も入っている（消さない） */
export async function probeShopStillInstalled(deps: {
  shop: string;
  findOfflineSession: (shop: string) => Promise<unknown>;
  runProbeQuery: (shop: string) => Promise<unknown>;
}): Promise<boolean> {
  const session = await deps.findOfflineSession(deps.shop);
  if (!session) return false;
  try {
    await deps.runProbeQuery(deps.shop);
    return true;
  } catch (err) {
    if (isNotInstalledError(err)) return false;
    throw err;
  }
}

/**
 * サーバーがどちらのアプリとして動いているか。app.tsx の getShopPlan と同じ決め方。
 * APP_DISTRIBUTION=inhouse（または APP_MODE=inhouse）か、店が CUSTOM_APP_STORE_IDS にあれば自社用。
 */
export function resolveServerDistribution(
  env: Record<string, string | undefined>,
  shop?: string | null,
): "public" | "inhouse" {
  const dist = (env.APP_DISTRIBUTION ?? "").trim().toLowerCase();
  const mode = (env.APP_MODE ?? "").trim().toLowerCase();
  if (dist === "inhouse" || mode === "inhouse") return "inhouse";
  const shopNormalized = (shop ?? "").trim().toLowerCase();
  const custom = (env.CUSTOM_APP_STORE_IDS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (shopNormalized && custom.includes(shopNormalized)) return "inhouse";
  return "public";
}
