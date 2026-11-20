// shop/redact の前に「この店にまだアプリが入っているか」を確かめるための部品。
//
// shop/redact はアンインストールの 48 時間後に届く。そのあいだに入れ直した店に届いたとき、
// 入れ直したあとのデータを消さないよう、消す前にオフラインのセッションで Admin API を 1 回呼ぶ。
// - オフラインのセッションが無い → 入っていない → 消してよい（false）
// - 呼べた → 今も入っている → 消さない（true）
// - 401 / トークンが無効 → 入っていない → 消してよい（false）
//   （403 は権限の問題などでも返るので「入っていない」とは見ない。投げて、もう一度送ってもらう）
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
  if (status === 401) return true;
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

/** toml の文から client_id を読む（`client_id = "..."` の行） */
export function parseClientIdFromToml(toml: string | null | undefined): string | null {
  const m = /^\s*client_id\s*=\s*"([^"]+)"/m.exec(String(toml ?? ""));
  return m ? m[1].trim() : null;
}

/**
 * サーバーが公開用のアプリとして動いているか。shop/redact で消してよいかの判断に使う。
 * 元に戻せない処理なので、迷ったときは自社用（消さない）へ倒す。
 * - 自社用: APP_DISTRIBUTION=inhouse、または店が CUSTOM_APP_STORE_IDS にある
 * - 公開用: 上に当たらず、APP_DISTRIBUTION=public がはっきり入っているか、
 *   SHOPIFY_API_KEY が公開用アプリの client_id（shopify.app.public.toml）と同じ
 * - それ以外（環境変数が無い・つづりが違う・toml が読めない）: 自社用
 * （POS 拡張の APP_MODE は extensions/common/appUrl.js の中の値で、サーバーの環境変数ではないので見ない）
 */
export function resolveServerDistribution(
  env: Record<string, string | undefined>,
  shop: string | null | undefined,
  publicClientId: string | null | undefined,
): "public" | "inhouse" {
  const dist = (env.APP_DISTRIBUTION ?? "").trim().toLowerCase();
  if (dist === "inhouse") return "inhouse";
  const shopNormalized = (shop ?? "").trim().toLowerCase();
  const custom = (env.CUSTOM_APP_STORE_IDS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (shopNormalized && custom.includes(shopNormalized)) return "inhouse";
  if (dist === "public") return "public";
  const apiKey = (env.SHOPIFY_API_KEY ?? "").trim();
  const publicId = (publicClientId ?? "").trim();
  if (apiKey && publicId && apiKey === publicId) return "public";
  return "inhouse";
}
