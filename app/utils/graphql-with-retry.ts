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
 * fn は同じ query・同じ variables を送り直す。@idempotent のキーも variables に入っているので、
 * 送り直しは同じキーになる（Shopify は 1 回目が通っていれば 2 回目を動かさない）。
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
 * @idempotent の付いた mutation で、Shopify が IDEMPOTENCY_CONCURRENT_REQUEST
 * （同じキーの前の送信がまだ処理中）を返したときに、待ってから **同じ中身・同じキーで** 送り直す。
 * docs/IDEMPOTENT_MIGRATION.md 3.3。
 *
 * - キーは呼び出し側が variables に入れる。send は毎回同じ variables で送ること（キーを作り直さない）。
 * - 429/503 の送り直し（executeWithRetry / withGraphQLRetry）も同じ variables をそのまま送るので、同じキーになる。
 * - 待ち切っても処理中のままなら concurrentExhausted: true を返す。呼び出し側は「結果が分からない」として扱い、
 *   新しいキーで送り直さない（送り直すと二重になりうる）。
 */
export async function retryWhileIdempotencyConcurrent<T>(
  send: () => Promise<T>,
  isConcurrent: (result: T) => boolean,
  delaysMs: readonly number[] = [1000, 2000, 4000]
): Promise<{ result: T; concurrentExhausted: boolean; concurrentRetries: number }> {
  let result = await send();
  let retries = 0;
  while (isConcurrent(result)) {
    if (retries >= delaysMs.length) {
      return { result, concurrentExhausted: true, concurrentRetries: retries };
    }
    const waitMs = delaysMs[retries];
    retries++;
    console.warn(
      `[graphql-with-retry] IDEMPOTENCY_CONCURRENT_REQUEST (retry ${retries}/${delaysMs.length}), same key in ${waitMs}ms`
    );
    await delay(waitMs);
    result = await send();
  }
  return { result, concurrentExhausted: false, concurrentRetries: retries };
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
