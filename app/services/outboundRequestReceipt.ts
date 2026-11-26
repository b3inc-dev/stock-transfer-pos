import { normalizeOutboundRequestPolicy, renderOutboundRequestReceipt } from "../../extensions/common/outboundRequests.js";
import { applyPrinterProfile, printerGeometry } from "./receiptPrinterProfile";
import type { RequestRow } from "../utils/outbound-requests.server";

/** Reuse the printer geometry used by reservation receipts, derived from POS Receipt. */
export function renderConfiguredOutboundRequestReceipt(row: RequestRow, input: unknown) {
  const policy = normalizeOutboundRequestPolicy(input);
  const paper = policy.paperWidth as 58 | 80;
  const html = applyPrinterProfile(renderOutboundRequestReceipt(row, paper), policy.printerProfile, paper);
  const viewport = printerGeometry(policy.printerProfile, paper).viewportPx;
  return viewport ? html.replace(/<meta\s+name=["']viewport["'][^>]*>/i, '<meta name="viewport" content="width=' + viewport + ', initial-scale=1">') : html;
}
