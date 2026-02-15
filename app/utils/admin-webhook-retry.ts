/**
 * admin_webhook 未検出時の待機・再検索：inventory_levels/update の create 遅延を吸収し、
 * api/log-inventory-change・orders/updated・refunds/create で二重登録を防ぐ。
 * 同種の Webhook 抱き合わせでは 15〜30 秒待機が一般的なため、最大 30 秒（2.5秒×12回）まで待機。
 */
export const ADMIN_WEBHOOK_RETRY_WAIT_MS = 2500;
export const ADMIN_WEBHOOK_RETRY_TIMES = 12;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * finder を実行し、null の場合に ADMIN_WEBHOOK_RETRY_WAIT_MS 待機して再実行を最大 ADMIN_WEBHOOK_RETRY_TIMES 回繰り返す。
 * 見つかった時点で返すため、早く届けば短い待機で返る。
 */
export async function findWithAdminWebhookRetry<T extends { id: number }>(
  finder: () => Promise<T | null>,
  logPrefix: string
): Promise<T | null> {
  let result = await finder();
  for (let r = 0; !result && r < ADMIN_WEBHOOK_RETRY_TIMES; r++) {
    console.log(
      `${logPrefix} admin_webhook not found, waiting ${ADMIN_WEBHOOK_RETRY_WAIT_MS}ms and retrying (${r + 1}/${ADMIN_WEBHOOK_RETRY_TIMES})...`
    );
    await sleep(ADMIN_WEBHOOK_RETRY_WAIT_MS);
    result = await finder();
  }
  return result;
}
