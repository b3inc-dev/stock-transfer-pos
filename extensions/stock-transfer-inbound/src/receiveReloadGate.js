/**
 * 入庫の確定（受領）のロックと、確定のあとの伝票の読み直しを一つにまとめる。
 *
 * 受領は「目標 − 受領済み」の差分（delta）だけを送る（docs/BUSINESS_RULES.md §5）。
 * 受領済みの数は画面の伝票から取るので、伝票が古いままもう一度押すと同じ差分をまた送ってしまう。
 * 例: 予定 10 のうち 4 を受領 → Shopify では成功したのに時間切れでエラー → すぐ押し直す
 *     → 画面はまだ「受領済み 0」→ また 4 を送る（合わせて 8）。
 *
 * 決まり:
 * 1. 確定のあと読み直しが要るとき（エラーのあと・一部入庫のあと）は、読み直しが終わるまでロックを外さない。
 * 2. 読み直しに失敗したら reloadRequired にする。伝票を読み直せるまで確定させない（画面で案内する）。
 * 3. 伝票をきちんと読み直せたら（どの経路でも）markReloaded で reloadRequired を外す。
 */

export function createReceiveGate() {
  return { locked: false, reloadRequired: false };
}

/** 確定を始めてよいか。始められないときは理由を返す。 */
export function receiveBlockedReason(gate) {
  if (gate?.locked) return "locked";
  if (gate?.reloadRequired) return "reload_required";
  return null;
}

export function markReloaded(gate) {
  if (gate) gate.reloadRequired = false;
}

export const RECEIVE_RELOAD_REQUIRED_MESSAGE =
  "伝票を読み直せませんでした。受領が二重にならないよう、「再読込」を押すか伝票を開き直して、受領済みの数を確かめてから、もう一度操作してください。";

/**
 * @param {{ locked: boolean, reloadRequired: boolean }} gate 画面が useRef で持つ
 * @param {object} opts
 * @param {() => Promise<{ ok: boolean, reload?: boolean }>} opts.submit 確定の本体。例外は「読み直しが要る失敗」とみなす
 * @param {() => Promise<{ ok: boolean, error?: unknown }>} opts.reload 伝票の読み直し（全ページ・受領済みの数まで）
 * @param {(blocked: boolean) => void} [opts.setReloadRequired] 画面の表示用
 * @param {(busy: boolean) => void} [opts.setSubmitting]
 * @param {(error?: unknown) => void} [opts.onSubmitError]
 * @param {(error?: unknown) => void} [opts.onReloadFailed]
 * @param {(reason: string) => void} [opts.onBlocked]
 * @returns {Promise<boolean>} 確定が成功したら true
 */
export async function runReceiveWithReload(gate, opts) {
  const blocked = receiveBlockedReason(gate);
  if (blocked) {
    opts.onBlocked?.(blocked);
    return false;
  }
  gate.locked = true;
  opts.setSubmitting?.(true);
  let result;
  try {
    try {
      result = await opts.submit();
    } catch (error) {
      opts.onSubmitError?.(error);
      result = { ok: false, reload: true };
    }
    if (result?.reload) {
      let reloaded;
      try {
        reloaded = await opts.reload();
      } catch (error) {
        reloaded = { ok: false, error };
      }
      if (reloaded?.ok === true) {
        markReloaded(gate);
        opts.setReloadRequired?.(false);
      } else {
        gate.reloadRequired = true;
        opts.setReloadRequired?.(true);
        opts.onReloadFailed?.(reloaded?.error);
      }
    }
  } finally {
    gate.locked = false;
    opts.setSubmitting?.(false);
  }
  return result?.ok === true;
}
