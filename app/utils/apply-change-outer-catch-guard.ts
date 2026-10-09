/**
 * apply-change outer catch の分岐（#16 failed-clear → 再 setQuantities 防止）。
 * ルート本体とテストで同じ判定を共有する。
 */

export type InventoryAppliedFlag = "full" | "partial" | null;

export type OuterCatchDecision =
  | { action: "preserve"; ensureStatus: "completed" | "partial_failed" }
  | { action: "cas_mark_failed" };

/**
 * Shopify 適用後（in-memory flag または DB terminal）なら failed に戻さない。
 * applying/pending でも inventoryApplied があれば preserve（heal）。
 */
export function decideOuterCatchAction(opts: {
  inventoryApplied: InventoryAppliedFlag;
  existingStatus: string | null;
}): OuterCatchDecision {
  const { inventoryApplied, existingStatus } = opts;
  const shopifyAlreadyApplied =
    inventoryApplied === "full" ||
    inventoryApplied === "partial" ||
    existingStatus === "completed" ||
    existingStatus === "partial_failed";

  if (!shopifyAlreadyApplied) {
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
