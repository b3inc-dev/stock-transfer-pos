/**
 * apply-change outer catch の分岐（#16 failed-clear → 再 setQuantities 防止）。
 * ルート本体とテストで同じ判定を共有する。
 */

export type InventoryAppliedFlag = "full" | "partial" | null;

export type OuterCatchDecision =
  | { action: "preserve"; ensureStatus: "completed" | "partial_failed" }
  | { action: "cas_mark_failed" }
  | { action: "return_inflight" };

/**
 * Shopify 適用後（in-memory flag / DB terminal / line applied）なら failed に戻さない。
 * status 読取失敗かつ適用痕跡なしは failed 化せず in-flight のまま返す（completed 退行を避ける）。
 */
export function decideOuterCatchAction(opts: {
  inventoryApplied: InventoryAppliedFlag;
  existingStatus: string | null;
  appliedLineCount?: number;
  statusLookupFailed?: boolean;
}): OuterCatchDecision {
  const { inventoryApplied, existingStatus } = opts;
  const appliedLineCount = opts.appliedLineCount ?? 0;
  const shopifyAlreadyApplied =
    inventoryApplied === "full" ||
    inventoryApplied === "partial" ||
    existingStatus === "completed" ||
    existingStatus === "partial_failed" ||
    appliedLineCount > 0;

  if (!shopifyAlreadyApplied) {
    // status 不明時に failed 化すると completed を誤って退行させ得る → 202 で据え置き
    if (opts.statusLookupFailed) {
      return { action: "return_inflight" };
    }
    return { action: "cas_mark_failed" };
  }

  const ensureStatus =
    inventoryApplied === "partial" || existingStatus === "partial_failed"
      ? "partial_failed"
      : "completed";
  return { action: "preserve", ensureStatus };
}

/** userErrors 以外の setQuantities 失敗は成否不明（partial）として扱う */
export function isDefiniteUnaappliedRejection(opts?: { hadUserErrors?: boolean }): boolean {
  return opts?.hadUserErrors === true;
}

export type StaleApplyingDecision =
  | { action: "keep_inflight" }
  | { action: "heal"; status: "completed" | "partial_failed" }
  | { action: "mark_failed_for_retry" };

/**
 * sticky pending/applying の TTL 判定。
 * - TTL 未満: 処理中のまま
 * - TTL 超過 + line applied: terminal へ heal（再 set しない）
 * - TTL 超過 + 未適用痕跡なし: failed 化して同一 appEventId のクリア再試行を許可
 *   （#22 early terminal write により set 成功後の未書込窓は短い前提）
 */
export function decideStaleApplyingAction(opts: {
  ageMs: number;
  staleAfterMs: number;
  appliedLineCount: number;
  totalLineCount: number;
}): StaleApplyingDecision {
  if (opts.ageMs < opts.staleAfterMs) {
    return { action: "keep_inflight" };
  }
  if (opts.appliedLineCount > 0) {
    const allApplied =
      opts.totalLineCount > 0 && opts.appliedLineCount >= opts.totalLineCount;
    return { action: "heal", status: allApplied ? "completed" : "partial_failed" };
  }
  return { action: "mark_failed_for_retry" };
}

/** クライアント全体予算(150s)より長く、ワーカー死亡後の再確定で解除できるようにする */
export const APPLYING_STALE_MS = 180_000;
