/**
 * 棚卸確定後の status（completed / in_progress）判定。
 * POS InventoryCountList の resolvedAllIds / cancelledGroupIds / groupIdsForCheck と揃える。
 * applyPendingCompleteFromBackup（サーバー）の正本。
 *
 * ※ app.inventory-count を import しない（テスト容易性・ルート循環回避）。
 *   normalize / getGroupItemsByKey は同ルートの実装と同型。
 */

export type StocktakeCompleteStatus = "completed" | "in_progress";

export type ResolveStocktakeCompleteStatusInput = {
  productGroupIds?: string[] | null;
  productGroupId?: string | null;
  cancelledGroupIds?: string[] | null;
  groupItemsMap: Record<string, unknown[]>;
  /** 今回マージした completedGroups の groupId（productGroupIds 欠落時の補完用） */
  completedGroupIds?: string[] | null;
};

export type ResolveStocktakeCompleteStatusResult = {
  status: StocktakeCompleteStatus;
  allDone: boolean;
  /** 完了判定に使ったグループ ID 一覧（欠落時は補完後） */
  groupIdsForCheck: string[];
};

function normalizeIdForMatch(id: string | number | undefined | null): string {
  const s = String(id ?? "").trim();
  const lastSegment = s.split("/").pop() || s;
  return lastSegment;
}

function getGroupItemsByKey(
  groupItemsMap: Record<string, unknown[]> | undefined,
  groupId: string
): unknown[] {
  if (!groupId || !groupItemsMap || typeof groupItemsMap !== "object") return [];
  if (Array.isArray(groupItemsMap[groupId])) return groupItemsMap[groupId];
  const n = normalizeIdForMatch(groupId);
  const key = Object.keys(groupItemsMap).find((k) => normalizeIdForMatch(k) === n);
  return key && Array.isArray(groupItemsMap[key]) ? groupItemsMap[key] : [];
}

/**
 * groupItems マージ後にドキュメント status を決める。
 * - cancelledGroupIds は完了扱い
 * - productGroupIds が空のときは completedGroups + 非空 groupItems キーで補完
 *   （単一グループ棚卸で list/minimal 由来の count に ID が無いケース）
 */
export function resolveStocktakeCompleteStatus(
  input: ResolveStocktakeCompleteStatusInput
): ResolveStocktakeCompleteStatusResult {
  const groupItemsMap = input.groupItemsMap && typeof input.groupItemsMap === "object" ? input.groupItemsMap : {};
  const cancelledSet = new Set(
    (Array.isArray(input.cancelledGroupIds) ? input.cancelledGroupIds : []).map((id) =>
      normalizeIdForMatch(String(id))
    )
  );

  let groupIdsForCheck: string[] =
    Array.isArray(input.productGroupIds) && input.productGroupIds.length > 0
      ? [...input.productGroupIds]
      : input.productGroupId
        ? [String(input.productGroupId)]
        : [];

  if (groupIdsForCheck.length === 0) {
    const fromCompleted = Array.isArray(input.completedGroupIds) ? input.completedGroupIds : [];
    const fromItems = Object.keys(groupItemsMap).filter(
      (k) => Array.isArray(groupItemsMap[k]) && (groupItemsMap[k] as unknown[]).length > 0
    );
    const seen = new Set<string>();
    groupIdsForCheck = [];
    for (const id of [...fromCompleted, ...fromItems]) {
      const raw = String(id ?? "").trim();
      if (!raw) continue;
      const n = normalizeIdForMatch(raw);
      if (!n || seen.has(n)) continue;
      seen.add(n);
      groupIdsForCheck.push(raw);
    }
  }

  const allDone =
    groupIdsForCheck.length > 0 &&
    groupIdsForCheck.every((id) => {
      if (cancelledSet.has(normalizeIdForMatch(String(id)))) return true;
      return getGroupItemsByKey(groupItemsMap, String(id)).length > 0;
    });

  return {
    status: allDone ? "completed" : "in_progress",
    allDone,
    groupIdsForCheck,
  };
}
