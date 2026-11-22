/**
 * Webhook に決まった時間の中で 200 を返す部品。
 *
 * Shopify は Webhook の応答を 5 秒まで待ち、それを過ぎると「失敗」として送り直す
 * （Dev Dashboard の「Webhook の失敗」）。サーバーは処理を最後まで続けて 200 を返すので、
 * Render のログには 200 しか残らない。
 *
 * orders/updated・refunds/create は、inventory_levels/update の行を待つために
 * 1 商品ごとに最大 30 秒（2.5 秒 × 12 回、admin-webhook-retry.ts）待つことがある。
 * そのあいだに Shopify が送り直すと、同じ注文の処理が 2 本同時に走る。
 *
 * ここでは、処理が budgetMs（既定 4 秒）を超えたら先に 200 を返し、処理はそのまま続ける。
 * - budgetMs より早く終わったときは、これまでと同じ応答（400・401・500・503 も）をそのまま返す。
 * - 先に 200 を返したあとの失敗はログに出す（今も、5 秒を過ぎたあとの 500 は Shopify に届いていない）。
 * - 環境変数 WEBHOOK_RESPONSE_BUDGET_MS=0 で前の動き（終わるまで待つ）に戻せる。
 */

export const DEFAULT_WEBHOOK_RESPONSE_BUDGET_MS = 4000;

export function webhookResponseBudgetMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.WEBHOOK_RESPONSE_BUDGET_MS;
  if (raw == null || String(raw).trim() === "") return DEFAULT_WEBHOOK_RESPONSE_BUDGET_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_WEBHOOK_RESPONSE_BUDGET_MS;
  return Math.floor(n);
}

export async function respondWithinBudget(
  work: () => Promise<Response>,
  opts: { label: string; budgetMs?: number; log?: (line: string) => void; logError?: (line: string, err: unknown) => void },
): Promise<Response> {
  const budgetMs = opts.budgetMs ?? webhookResponseBudgetMs();
  const log = opts.log ?? ((line: string) => console.log(line));
  const logError = opts.logError ?? ((line: string, err: unknown) => console.error(line, err));
  const startedAt = Date.now();
  const running = work();
  if (budgetMs <= 0) return running;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = Symbol("late");
  const timeout = new Promise<typeof late>((resolve) => {
    timer = setTimeout(() => resolve(late), budgetMs);
  });
  try {
    const first = await Promise.race([running, timeout]);
    if (first !== late) return first as Response;
  } catch (err) {
    // budgetMs より前に投げた（ライブラリの 401 の Response など）→ これまでどおり
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }

  log(`[webhook-budget] ${opts.label}: ${budgetMs}ms を超えたので先に 200 を返す（処理は続ける）`);
  running.then(
    (res) => log(`[webhook-budget] ${opts.label}: 続きの処理が終わった status=${res.status} ms=${Date.now() - startedAt}`),
    (err) => logError(`[webhook-budget] ${opts.label}: 続きの処理が失敗した ms=${Date.now() - startedAt}`, err),
  );
  return new Response("OK", { status: 200 });
}
