/**
 * アプリを外した店の Webhook が 500 にならないようにする部品。
 *
 * @shopify/shopify-app-react-router 1.1 系は、期限付きのトークン（future.expiringOfflineAccessTokens）を使うと、
 * Webhook を受けたときに切れたトークンをリフレッシュしようとする。アプリを外した店ではリフレッシュが断られ、
 * authenticate.webhook が 500 の Response を投げる（ライブラリ 4.0.3 で直った不具合）。
 * 500 だと Shopify が送り直しを続け、Dev Dashboard に「Webhook の失敗」が出る。
 *
 * authenticate.webhook が 500 を投げたときだけ HMAC を自分で確かめ、正しければ
 * 「セッションの無い Webhook」として返す（4.0.3 と同じ動き）。HMAC が合わなければ 401。
 * ほかの Response（401・400・405）と、ふつうの例外はそのまま投げる。
 */
import crypto from "node:crypto";

export type SafeWebhookContext = {
  apiVersion?: string;
  shop: string;
  topic: string;
  webhookId?: string;
  payload: any;
  subTopic?: string;
  session: undefined;
  admin: undefined;
  sessionRefreshFailed: true;
};

function header(request: Request, names: string[]): string | null {
  for (const n of names) {
    const v = request.headers.get(n);
    if (v) return v;
  }
  return null;
}

/** "app/uninstalled" → "APP_UNINSTALLED"（ライブラリが返す topic の形にそろえる） */
export function toTopicConst(raw: string | null | undefined): string {
  return String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/[/.]/g, "_");
}

export function isValidWebhookHmac(rawBody: string, hmacHeader: string | null, secret: string): boolean {
  if (!hmacHeader || !secret) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest();
  const given = Buffer.from(hmacHeader, "base64");
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(given, expected);
}

export async function authenticateWebhookSafely<T>(
  request: Request,
  deps: {
    authenticateWebhook: (request: Request) => Promise<T>;
    apiSecret: string;
    log?: (line: string) => void;
  },
): Promise<T | SafeWebhookContext> {
  const log = deps.log ?? ((line: string) => console.warn(line));
  // authenticate.webhook は本文を読むので、先に写しを取っておく
  const copy = request.clone();
  try {
    return await deps.authenticateWebhook(request);
  } catch (thrown) {
    if (!(thrown instanceof Response) || thrown.status !== 500) throw thrown;

    const rawBody = await copy.text();
    const hmac = header(copy, ["x-shopify-hmac-sha256", "shopify-hmac-sha256"]);
    if (!isValidWebhookHmac(rawBody, hmac, deps.apiSecret)) {
      throw new Response(undefined, { status: 401, statusText: "Unauthorized" });
    }
    const shop = header(copy, ["x-shopify-shop-domain", "shopify-shop-domain"]) || "";
    const topic = toTopicConst(header(copy, ["x-shopify-topic", "shopify-topic"]));
    let payload: any = {};
    try {
      payload = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      payload = {};
    }
    log(`[webhook] ${topic} for ${shop}: セッションの更新に失敗したので、セッション無しで受ける（アプリを外した店など）`);
    return {
      apiVersion: header(copy, ["x-shopify-api-version", "shopify-api-version"]) || undefined,
      shop,
      topic,
      webhookId: header(copy, ["x-shopify-webhook-id", "shopify-webhook-id"]) || undefined,
      payload,
      subTopic: header(copy, ["x-shopify-sub-topic", "shopify-sub-topic"]) || undefined,
      session: undefined,
      admin: undefined,
      sessionRefreshFailed: true,
    };
  }
}
