/**
 * Shopify Admin GraphQL の 429 (Rate Limit) / 503 時にリトライする共通ラッパー。
 * loader / action / API / Webhook で admin.graphql / admin.request をラップして使用する。
 */

/** リトライ対象の HTTP ステータス（429 = レート制限、503 = 一時過負荷） */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 503;
}

/** 待機（ミリ秒） */
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** デフォルト: 最大リトライ回数（初回含め計4回） */
const DEFAULT_MAX_RETRIES = 3;
/** デフォルト: 初回待機 1秒、以降 2秒・4秒 の指数バックオフ */
const DEFAULT_INITIAL_DELAY_MS = 1000;

export type AdminGraphql = (
  query: string,
  opts?: { variables?: Record<string, unknown> }
) => Promise<Response>;

export type AdminRequest = (opts: { data: string; variables?: Record<string, unknown> }) => Promise<Response>;

export type AdminWithRetry = {
  graphql: AdminGraphql;
  request?: AdminRequest;
  [key: string]: unknown;
};

/**
 * Response を返す関数を実行し、429/503 のときだけ指数バックオフでリトライする。
 */
export async function executeWithRetry(
  fn: () => Promise<Response>,
  options?: { maxRetries?: number; initialDelayMs?: number }
): Promise<Response> {
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const initialDelayMs = options?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  let lastResponse: Response | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fn();
    lastResponse = response;

    if (!isRetryableStatus(response.status) || attempt === maxRetries) {
      return response;
    }

    const waitMs = initialDelayMs * Math.pow(2, attempt);
    console.warn(
      `[graphql-with-retry] HTTP ${response.status} (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${waitMs}ms`
    );
    await delay(waitMs);
  }

  return lastResponse!;
}

/**
 * .request のみの admin に .graphql を補う（withGraphQLRetry は .graphql を必要とするため）
 */
function ensureGraphql(
  admin: { graphql?: AdminGraphql; request?: AdminRequest }
): admin is { graphql: AdminGraphql; request?: AdminRequest } {
  if (typeof admin.graphql === "function") return true;
  if (typeof admin.request === "function") {
    (admin as { graphql: AdminGraphql }).graphql = (query, opts) =>
      admin.request!({ data: query, variables: opts?.variables });
    return true;
  }
  return false;
}

/**
 * admin オブジェクトをラップし、.graphql と .request に 429/503 リトライを付与する。
 * .request のみのオブジェクトにも対応（内部で .graphql を補う）。
 * 使用例: const { admin } = await authenticate.admin(request);
 *         const adminApi = withGraphQLRetry(admin);
 *         const resp = await adminApi.graphql(query, { variables });
 */
export function withGraphQLRetry<T extends { graphql?: AdminGraphql; request?: AdminRequest }>(
  admin: T,
  options?: { maxRetries?: number; initialDelayMs?: number }
): T {
  if (!ensureGraphql(admin)) {
    return admin;
  }
  const opts = options ?? {};

  const wrappedGraphql: AdminGraphql = (query, graphqlOpts) =>
    executeWithRetry(() => admin.graphql!(query, graphqlOpts), opts);

  const wrappedRequest: AdminRequest | undefined = admin.request
    ? (requestOpts) => executeWithRetry(() => admin.request!(requestOpts), opts)
    : undefined;

  return {
    ...admin,
    graphql: wrappedGraphql,
    ...(wrappedRequest !== undefined && { request: wrappedRequest }),
  } as T;
}
