/* global globalThis */
/** Printing is independent of reservation/inventory writes. A resolved job is sent, not paper-confirmed. */
export const RECEIPT_PRINT_TIMEOUT_MS = 20_000;
const inFlight = new Set();

function printError(code, message) {
  return Object.assign(new Error(message), { code });
}

function withTimeout(operation, phase) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(printError(
      phase === "discovery" ? "PRINTER_DISCOVERY_TIMEOUT" : "PRINT_TIMEOUT_UNKNOWN",
      phase === "discovery"
        ? "プリンタを確認できませんでした。まだ印刷していません。つながりを確かめて、もう一度お試しください。"
        : "印刷できたか分かりませんでした。紙が出たか確認し、出ていない場合だけ再印刷してください。",
    )), RECEIPT_PRINT_TIMEOUT_MS);
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

/** Same-origin path; Shopify fetches the HTML using the extension's session token. No automatic retries/dialog. */
export async function printReceipt(src) {
  const printing = globalThis.shopify?.printing;
  if (typeof printing?.print !== "function" || typeof printing?.getPrinters !== "function") {
    throw printError("PRINT_UNAVAILABLE", "このPOSでは印刷できません。Shopify POSを更新して、もう一度お試しください。");
  }
  if (inFlight.has(src)) throw printError("PRINT_IN_FLIGHT", "同じ控えを印刷中です。終わるまでお待ちください。");
  inFlight.add(src);
  let phase = "discovery";
  try {
    const result = await withTimeout(printing.getPrinters(), phase);
    const printers = Array.isArray(result) ? result : result?.printers;
    const connected = Array.isArray(printers) ? printers.filter(item => item?.connected === true) : [];
    if (!connected.length) {
      throw printError("NO_CONNECTED_PRINTER", "つながっているレシートプリンタがありません。用紙・電源・つながりを確かめてください。");
    }
    phase = "printing";
    await withTimeout(printing.print(src, { printer: connected[0] }), phase);
    return {
      message: `${connected.length > 1 ? "複数のプリンタがつながっているため、最初の1台に送りました。" : "プリンタに送りました。"}紙が出たか確かめてください。`,
    };
  } catch (error) {
    if (["PRINTER_DISCOVERY_TIMEOUT", "PRINT_TIMEOUT_UNKNOWN", "NO_CONNECTED_PRINTER"].includes(error?.code)) throw error;
    const raw = String(error?.message || "");
    if (phase === "discovery") throw printError("PRINTER_DISCOVERY_FAILED", "プリンタを確認できませんでした。まだ印刷していません。つながりを確かめてください。");
    if (/paper|用紙/i.test(raw)) throw printError("PRINT_FAILED", "プリンタの用紙が切れているかもしれません。紙が出たか確認し、用紙を入れてから再印刷してください。");
    if (/disconnect|offline|not connected|切断|未接続/i.test(raw)) throw printError("PRINT_FAILED", "プリンタがつながっていません。紙が出たか確認し、電源とつながりを確かめてください。");
    throw printError("PRINT_FAILED", "印刷を確認できませんでした。紙が出たか確認し、出ていない場合だけ再印刷してください。");
  } finally {
    // A timeout cannot cancel a native job. A later explicit retry is the user's choice after checking paper.
    inFlight.delete(src);
  }
}
