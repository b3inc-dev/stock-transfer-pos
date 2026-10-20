/**
 * 棚卸確定まわりの純粋ヘルパー（下書き削除の対象グループ、応答不明後の完了確認）。
 */
import { normalizeStocktakeId } from "./stocktakeLineIdentity.js";

function uniqueNormalized(ids) {
  const seen = new Set();
  const out = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    const raw = String(id ?? "").trim();
    const n = normalizeStocktakeId(raw);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(raw);
  }
  return out;
}

/**
 * 今回の確定で完了させたグループ ID。
 * 単一モードは表示中グループのみ。まとめて表示は対象グループのうち payload に明細があるもの。
 * （payload.completedGroups には既に完了済みの他グループも含まれるため、そのまま使わない）
 */
export function confirmedGroupIdsForConfirm({ isMultipleMode, currentGroupId, targetProductGroupIds, payload }) {
  if (!isMultipleMode) return uniqueNormalized(currentGroupId ? [currentGroupId] : targetProductGroupIds);
  const inPayload = new Set(
    (Array.isArray(payload?.completedGroups) ? payload.completedGroups : [])
      .filter((g) => Array.isArray(g?.items) && g.items.length > 0)
      .map((g) => normalizeStocktakeId(g.groupId))
  );
  return uniqueNormalized(targetProductGroupIds).filter((id) => inPayload.has(normalizeStocktakeId(id)));
}

/**
 * 確定成功後に削除する下書き。
 * 複数グループの棚卸は per-group キーなので確定したグループ分だけ。単一グループの棚卸は従来どおり count 単位キー。
 * @returns {{ mode: "perGroup", groupIds: string[] } | { mode: "single", groupId: string }}
 */
export function planDraftClear({ countProductGroupIds, confirmedGroupIds }) {
  const all = Array.isArray(countProductGroupIds) ? countProductGroupIds : [];
  if (all.length > 1) {
    const confirmedRaw = uniqueNormalized(confirmedGroupIds);
    const confirmed = new Set(confirmedRaw.map(normalizeStocktakeId));
    // キーは保存時の ID 表記に依存するため、確定 ID と棚卸側 ID の両方の表記を削除対象にする
    const fromCount = all.map((id) => String(id ?? "").trim()).filter((id) => confirmed.has(normalizeStocktakeId(id)));
    return { mode: "perGroup", groupIds: [...new Set([...confirmedRaw, ...fromCount])] };
  }
  return { mode: "single", groupId: String(all[0] ?? "") || "_single" };
}

function groupItemsFor(count, groupId) {
  const map = count?.groupItems && typeof count.groupItems === "object" ? count.groupItems : {};
  if (Array.isArray(map[groupId])) return map[groupId];
  const n = normalizeStocktakeId(groupId);
  const key = Object.keys(map).find((k) => normalizeStocktakeId(k) === n);
  return key && Array.isArray(map[key]) ? map[key] : [];
}

/** サーバ正本の棚卸で、指定グループがすべて確定済み（groupItems あり）か */
export function areGroupsCompletedInCount(count, groupIds) {
  const ids = uniqueNormalized(groupIds);
  if (!count || ids.length === 0) return false;
  return ids.every((id) => groupItemsFor(count, id).length > 0);
}

/** 応答不明後に完了状態を読み直す間隔（サーバは切断後も処理を続けるため数回待つ） */
export const COMPLETE_VERIFY_DELAYS_MS = [3000, 7000, 12000];
