import { useState, useCallback, useMemo, useEffect, useRef } from "preact/hooks";
import {
  readInventoryCounts,
  writeInventoryCounts,
  getLocationName,
  getProductGroupName,
  fetchProductsByGroups,
  getCurrentQuantity,
} from "./stocktakeApi.js";
import { FixedFooterNavBar } from "../loss/FixedFooterNavBar.jsx";

const SHOPIFY = globalThis?.shopify ?? {};
const toast = (m) => SHOPIFY?.toast?.show?.(String(m));

const STATUS_LABEL = {
  draft: "下書き",
  in_progress: "処理中",
  completed: "完了",
  cancelled: "キャンセル",
};

const formatDate = (iso) => {
  const s = String(iso || "").trim();
  if (!s) return "-";
  return s.slice(0, 10);
};

const isCompleted = (c) => {
  return c?.status === "completed" || c?.status === "cancelled";
};

export function InventoryCountConditions({
  onNext,
  onBack,
  onOpenProductGroupSelection,
  setHeader,
  setFooter,
  locationGid,
}) {
  const [viewMode, setViewMode] = useState("pending"); // "pending" | "completed"
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [counts, setCounts] = useState([]);
  const [locationNames, setLocationNames] = useState(new Map());
  const [productGroupNames, setProductGroupNames] = useState(new Map());
  const [pendingCountForModal, setPendingCountForModal] = useState(null);
  const PRODUCT_GROUP_MODE_SELECTION_MODAL_ID = "product-group-mode-selection-modal";
  const productGroupModeSelectionModalRef = useRef(null);
  // ✅ 未完了グループの在庫数を保存するstate（countId -> groupId -> currentQty）
  const [incompleteGroupQuantities, setIncompleteGroupQuantities] = useState(new Map());

  const listToShow = useMemo(() => {
    const base = Array.isArray(counts) ? counts : [];
    return viewMode === "completed" ? base.filter(isCompleted) : base.filter((c) => !isCompleted(c));
  }, [counts, viewMode]);

  const baseAll = Array.isArray(counts) ? counts : [];
  const pendingCountsAll = baseAll.filter((c) => !isCompleted(c));
  const completedCountsAll = baseAll.filter(isCompleted);

  // ロケーション名と商品グループ名を取得
  useEffect(() => {
    const loadNames = async () => {
      const locMap = new Map();
      const groupMap = new Map();
      for (const count of counts) {
        if (count.locationId && !locMap.has(count.locationId)) {
          const name = await getLocationName(count.locationId);
          if (name) locMap.set(count.locationId, name);
        }
        if (Array.isArray(count.productGroupIds)) {
          for (const groupId of count.productGroupIds) {
            if (!groupMap.has(groupId)) {
              const name = await getProductGroupName(groupId);
              if (name) groupMap.set(groupId, name);
            }
          }
        }
      }
      setLocationNames(locMap);
      setProductGroupNames(groupMap);
    };
    if (counts.length > 0) {
      loadNames();
    }
  }, [counts]);

  // ✅ 未完了グループの在庫数を取得（InventoryCountProductGroupSelectionと同じ処理）
  useEffect(() => {
    const loadIncompleteGroupQuantities = async () => {
      const quantitiesMap = new Map();
      
      for (const count of counts) {
        if (count.status === "completed") continue; // 完了済みはスキップ
        
        const allGroupIds = Array.isArray(count.productGroupIds) && count.productGroupIds.length > 0
          ? count.productGroupIds
          : count.productGroupId ? [count.productGroupId] : [];
        const groupItemsMap = count?.groupItems && typeof count.groupItems === "object" ? count.groupItems : {};
        
        for (const groupId of allGroupIds) {
          const groupItems = groupId && groupItemsMap[groupId] && Array.isArray(groupItemsMap[groupId]) ? groupItemsMap[groupId] : [];
          if (groupItems.length === 0) {
            // ✅ 未完了グループの商品リストを取得して在庫数を計算
            try {
              const products = await fetchProductsByGroups([groupId], count.locationId, {
                filterByInventoryLevel: false,
                includeImages: false,
              });
              
              // ✅ 各商品の在庫数を取得して合計を計算
              const inventoryQuantities = await Promise.all(
                products.map(async (p) => {
                  const qty = await getCurrentQuantity(p.inventoryItemId, count.locationId);
                  return qty !== null ? qty : 0;
                })
              );
              const totalQty = inventoryQuantities.reduce((sum, qty) => sum + qty, 0);
              
              if (!quantitiesMap.has(count.id)) {
                quantitiesMap.set(count.id, new Map());
              }
              quantitiesMap.get(count.id).set(groupId, totalQty);
            } catch (e) {
              console.error(`Failed to get quantity for incomplete group ${groupId} in count ${count.id}:`, e);
            }
          }
        }
      }
      
      setIncompleteGroupQuantities(quantitiesMap);
    };
    
    if (counts.length > 0) {
      loadIncompleteGroupQuantities();
    }
  }, [counts]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const allCounts = await readInventoryCounts();
      // ロケーションでフィルタリング（locationGidが指定されている場合）
      const filtered = locationGid
        ? allCounts.filter((c) => c.locationId === locationGid)
        : allCounts;
      // ✅ 降順にソート（作成日時の新しい順）
      const sorted = filtered.sort((a, b) => {
        const t1 = new Date(a.createdAt || 0).getTime();
        const t2 = new Date(b.createdAt || 0).getTime();
        return t2 - t1; // 降順
      });
      setCounts(sorted);
    } catch (e) {
      setError(String(e?.message || e));
      setCounts([]);
    } finally {
      setLoading(false);
    }
  }, [locationGid]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const onTapCount = async (c) => {
    const productGroupIds = Array.isArray(c?.productGroupIds) ? c.productGroupIds : [];
    const productGroupCount = productGroupIds.length;

    if (productGroupCount === 0) {
      toast("商品グループが見つかりません");
      return;
    }

    // ステータスをin_progressに更新（draftの場合のみ）
    if (c.status === "draft") {
      try {
        const allCounts = await readInventoryCounts();
        const updated = allCounts.map((count) =>
          count.id === c.id ? { ...count, status: "in_progress" } : count
        );
        await writeInventoryCounts(updated);
        c.status = "in_progress";
      } catch (e) {
        console.error("Failed to update count status:", e);
      }
    }

    if (productGroupCount === 1) {
      // 商品グループが1つの場合：直接商品リストへ
      onNext?.({
        countId: c.id,
        count: c,
        productGroupId: productGroupIds[0],
        productGroupIds: productGroupIds,
        productGroupMode: "single",
      });
      return;
    }

    // 商品グループが複数の場合：選択モーダルを表示
    setPendingCountForModal(c);
  };

  const handleSelectSingleProductGroup = useCallback(async () => {
    const c = pendingCountForModal;
    if (!c) {
      setPendingCountForModal(null);
      return;
    }

    const productGroupIds = Array.isArray(c?.productGroupIds) ? c.productGroupIds : [];
    if (productGroupIds.length === 0) {
      toast("商品グループが見つかりません");
      setPendingCountForModal(null);
      return;
    }

    // ステータスをin_progressに更新（draftの場合のみ）
    if (c.status === "draft") {
      try {
        const allCounts = await readInventoryCounts();
        const updated = allCounts.map((count) =>
          count.id === c.id ? { ...count, status: "in_progress" } : count
        );
        await writeInventoryCounts(updated);
        c.status = "in_progress";
      } catch (e) {
        console.error("Failed to update count status:", e);
      }
    }

    setPendingCountForModal(null);
    onOpenProductGroupSelection?.(c);
  }, [pendingCountForModal, onOpenProductGroupSelection]);

  const handleShowAllProductGroups = useCallback(async () => {
    const c = pendingCountForModal;
    if (!c) return;

    const productGroupIds = Array.isArray(c?.productGroupIds) ? c.productGroupIds : [];
    if (productGroupIds.length === 0) {
      toast("商品グループが見つかりません");
      return;
    }

    // ステータスをin_progressに更新（draftの場合のみ）
    if (c.status === "draft") {
      try {
        const allCounts = await readInventoryCounts();
        const updated = allCounts.map((count) =>
          count.id === c.id ? { ...count, status: "in_progress" } : count
        );
        await writeInventoryCounts(updated);
        c.status = "in_progress";
      } catch (e) {
        console.error("Failed to update count status:", e);
      }
    }

    setPendingCountForModal(null);
    onNext?.({
      countId: c.id,
      count: c,
      productGroupIds: productGroupIds,
      productGroupMode: "multiple",
    });
  }, [pendingCountForModal, onNext]);

  // Header（入庫・出庫と同様の形式、ただしmetafieldは全件取得のため読込ボタンは常に非表示）
  useEffect(() => {
    setHeader?.(
      <s-box padding="base">
        <s-stack gap="base">
          <s-stack direction="inline" gap="none" inlineSize="100%">
            <s-box inlineSize="50%">
              <s-button
                kind={viewMode === "pending" ? "primary" : "secondary"}
                onClick={() => setViewMode("pending")}
              >
                未完了 {pendingCountsAll.length}件
              </s-button>
            </s-box>
            <s-box inlineSize="50%">
              <s-button
                kind={viewMode === "completed" ? "primary" : "secondary"}
                onClick={() => setViewMode("completed")}
              >
                完了済み {completedCountsAll.length}件
              </s-button>
            </s-box>
          </s-stack>

          {/* ✅ さらに読み込みボタン（入庫・出庫と同様の形式、ただしmetafieldは全件取得のため常に非表示） */}
          {/* 注意: 棚卸はmetafieldから全件取得しているため、実際には追加読み込みは不要 */}
          {/* pageInfoは常にfalseのため、読込ボタンは表示されない */}
          {false && (
            <s-box padding="none" style={{ paddingBlock: "4px", paddingInline: "16px" }}>
              <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
                <s-text tone="subdued" size="small">
                  未読み込み一覧リストがあります。（過去分）
                </s-text>
                <s-button
                  kind="secondary"
                  onClick={() => {}}
                  onPress={() => {}}
                  disabled={true}
                >
                  読込
                </s-button>
              </s-stack>
            </s-box>
          )}
        </s-stack>
      </s-box>
    );
    return () => setHeader?.(null);
  }, [setHeader, viewMode, pendingCountsAll.length, completedCountsAll.length]);

  // Footer
  useEffect(() => {
    const locationName = locationGid ? locationNames.get(locationGid) || "現在店舗" : "全ロケーション";
    const summaryRight =
      viewMode === "completed"
        ? `完了済み ${listToShow.length}件`
        : `未完了 ${listToShow.length}件`;

    setFooter?.(
      <FixedFooterNavBar
        summaryLeft={`ロケーション: ${locationName}`}
        summaryRight={summaryRight}
        leftLabel="戻る"
        onLeft={onBack}
        rightLabel={loading ? "取得中..." : "再取得"}
        onRight={refresh}
        rightDisabled={loading}
      />
    );
    return () => setFooter?.(null);
  }, [setFooter, locationGid, locationNames, viewMode, listToShow.length, onBack, refresh, loading]);

  return (
    <>
      <s-box padding="base">
        <s-stack gap="base">
          {error ? (
            <s-box padding="none">
              <s-text tone="critical">棚卸ID一覧の取得に失敗しました: {error}</s-text>
            </s-box>
          ) : null}

          {listToShow.length === 0 ? (
            <s-text tone="subdued" size="small">
              {loading ? "取得中..." : "表示できる棚卸IDがありません"}
            </s-text>
          ) : (
            <s-stack gap="base">
              {listToShow.map((c) => {
                // countNameがあればそれを使用、なければidを使用（後方互換性）
                const head = String(c?.countName || c?.id || "").trim() || "棚卸ID";
                const date = formatDate(c?.createdAt);
                const locationName = locationNames.get(c.locationId) || c.locationName || "-";
                const productGroupNamesList = Array.isArray(c.productGroupIds)
                  ? c.productGroupIds.map((id) => productGroupNames.get(id) || id).join(", ")
                  : productGroupNames.get(c.productGroupId) || c.productGroupName || "-";
                const productGroupCount = Array.isArray(c.productGroupIds) ? c.productGroupIds.length : 1;

                const rawStatus = String(c?.status || "").trim();
                const statusJa = STATUS_LABEL[rawStatus] || rawStatus || "不明";

                return (
                  <s-box key={c.id}>
                    {productGroupCount > 1 ? (
                      <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between" style={{ width: "100%" }}>
                        <s-clickable onClick={() => onTapCount(c)} style={{ flex: "1 1 0", minWidth: 0 }}>
                          <s-box padding="small" style={{ width: "100%" }}>
                            <s-stack gap="tight" style={{ width: "100%" }}>
                              <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="small" style={{ width: "100%" }}>
                                <s-text emphasis="bold" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                  {head}
                                </s-text>
                                <s-text tone="subdued" size="small" style={{ whiteSpace: "nowrap" }}>
                                  {date}
                                </s-text>
                              </s-stack>
                              <s-text tone="subdued" size="small" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                ロケーション: {locationName}
                              </s-text>
                              <s-text tone="subdued" size="small" style={{ whiteSpace: "nowrap" }}>
                                商品グループ数: {productGroupCount}
                              </s-text>
                              <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="small" style={{ width: "100%" }}>
                                <s-text tone="subdued" size="small" style={{ whiteSpace: "nowrap" }}>
                                  状態: {statusJa}
                                </s-text>
                                {/* ✅ 数量カウント（日付の下に表示、入庫と同じ実装） */}
                                {(() => {
                                  // ✅ 管理画面の履歴では正しく表示されているため、itemsフィールドを優先（groupItemsはフォールバック）
                                  const itemsFromItems = Array.isArray(c.items) && c.items.length > 0 ? c.items : null;
                                  const groupItemsMap = c?.groupItems && typeof c.groupItems === "object" ? c.groupItems : {};
                                  const itemsFromGroup = Array.isArray(c.productGroupIds) && c.productGroupIds.length > 0
                                    ? c.productGroupIds.flatMap((id) => Array.isArray(groupItemsMap[id]) ? groupItemsMap[id] : [])
                                    : [];
                                  const allGroupItems = itemsFromItems || itemsFromGroup;
                                  const totalQty = allGroupItems.reduce((s, it) => s + (it.actualQuantity || 0), 0);
                                  let currentQty = allGroupItems.reduce((s, it) => s + (it.currentQuantity || 0), 0);
                                  
                                  // ✅ 未完了グループの在庫数を取得（useEffectで取得した在庫数を使用）
                                  const isCompleted = c.status === "completed";
                                  if (!isCompleted && Array.isArray(c.productGroupIds) && c.productGroupIds.length > 0) {
                                    // ✅ 未完了グループの在庫数をincompleteGroupQuantitiesから取得
                                    const countQuantities = incompleteGroupQuantities.get(c.id);
                                    if (countQuantities) {
                                      for (const groupId of c.productGroupIds) {
                                        const groupItems = groupId && groupItemsMap[groupId] && Array.isArray(groupItemsMap[groupId]) ? groupItemsMap[groupId] : [];
                                        if (groupItems.length === 0) {
                                          const groupQty = countQuantities.get(groupId) || 0;
                                          currentQty += groupQty;
                                        }
                                      }
                                    }
                                  }
                                  
                                  // ✅ 進行中のものも在庫数（分母）が取得できる場合は表示する
                                  // ✅ 在庫数が取得できる場合（currentQty > 0）は表示する
                                  return (
                                    <s-text tone="subdued" size="small" style={{ whiteSpace: "nowrap" }}>
                                      {isCompleted || currentQty > 0 ? `${totalQty}/${currentQty}` : `${totalQty}/-`}
                                    </s-text>
                                  );
                                })()}
                              </s-stack>
                            </s-stack>
                          </s-box>
                        </s-clickable>
                        <s-box style={{ flex: "0 0 auto", flexShrink: 0 }}>
                          <s-button
                            kind="secondary"
                            size="small"
                            command="--show"
                            commandFor={PRODUCT_GROUP_MODE_SELECTION_MODAL_ID}
                            onClick={() => {
                              setPendingCountForModal(c);
                            }}
                          >
                            リスト
                          </s-button>
                        </s-box>
                      </s-stack>
                    ) : (
                      <s-clickable onClick={() => onTapCount(c)}>
                        <s-box padding="small">
                          <s-stack gap="tight">
                            <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="small">
                              <s-text emphasis="bold" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                {head}
                              </s-text>
                              <s-text tone="subdued" size="small" style={{ whiteSpace: "nowrap" }}>
                                {date}
                              </s-text>
                            </s-stack>
                            <s-text tone="subdued" size="small" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                              ロケーション: {locationName}
                            </s-text>
                            <s-text tone="subdued" size="small" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                              商品グループ: {productGroupNamesList}
                            </s-text>
                            <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="small">
                              <s-text tone="subdued" size="small" style={{ whiteSpace: "nowrap" }}>
                                状態: {statusJa}
                              </s-text>
                              {/* ✅ 数量カウント（日付の下に表示、入庫と同じ実装） */}
                              {(() => {
                                // ✅ 管理画面の履歴では正しく表示されているため、itemsフィールドを優先（groupItemsはフォールバック）
                                const itemsFromItems = Array.isArray(c.items) && c.items.length > 0 ? c.items : null;
                                const groupItemsMap = c?.groupItems && typeof c.groupItems === "object" ? c.groupItems : {};
                                const itemsFromGroup = Array.isArray(c.productGroupIds) && c.productGroupIds.length > 0
                                  ? c.productGroupIds.flatMap((id) => Array.isArray(groupItemsMap[id]) ? groupItemsMap[id] : [])
                                  : [];
                                const allGroupItems = itemsFromItems || itemsFromGroup;
                                const totalQty = allGroupItems.reduce((s, it) => s + (it.actualQuantity || 0), 0);
                                let currentQty = allGroupItems.reduce((s, it) => s + (it.currentQuantity || 0), 0);
                                
                                // ✅ 未完了グループの在庫数を取得（useEffectで取得した在庫数を使用）
                                const isCompleted = c.status === "completed";
                                if (!isCompleted && Array.isArray(c.productGroupIds) && c.productGroupIds.length > 0) {
                                  // ✅ 未完了グループの在庫数をincompleteGroupQuantitiesから取得
                                  const countQuantities = incompleteGroupQuantities.get(c.id);
                                  if (countQuantities) {
                                    for (const groupId of c.productGroupIds) {
                                      const groupItems = groupId && groupItemsMap[groupId] && Array.isArray(groupItemsMap[groupId]) ? groupItemsMap[groupId] : [];
                                      if (groupItems.length === 0) {
                                        const groupQty = countQuantities.get(groupId) || 0;
                                        currentQty += groupQty;
                                      }
                                    }
                                  }
                                }
                                
                                // ✅ 進行中のものも在庫数（分母）が取得できる場合は表示する
                                // ✅ 在庫数が取得できる場合（currentQty > 0）は表示する
                                return (
                                  <s-text tone="subdued" size="small" style={{ whiteSpace: "nowrap" }}>
                                    {isCompleted || currentQty > 0 ? `${totalQty}/${currentQty}` : `${totalQty}/-`}
                                  </s-text>
                                );
                              })()}
                            </s-stack>
                          </s-stack>
                        </s-box>
                      </s-clickable>
                    )}
                    <s-divider />
                  </s-box>
                );
              })}
            </s-stack>
          )}
        </s-stack>
      </s-box>

      {/* 商品グループ選択モーダル */}
      <s-modal id={PRODUCT_GROUP_MODE_SELECTION_MODAL_ID} heading="処理方法を選択" ref={productGroupModeSelectionModalRef}>
        {pendingCountForModal ? (
          <s-box padding="base" paddingBlockEnd="none">
            <s-stack gap="base">
              <s-stack gap="none">
                <s-text tone="subdued" size="small">
                  棚卸ID: {pendingCountForModal?.countName || pendingCountForModal?.id || "棚卸ID"}
                </s-text>
                <s-text tone="subdued" size="small">
                  ロケーション: {locationNames.get(pendingCountForModal.locationId) || pendingCountForModal.locationName || "-"}
                </s-text>
                <s-text tone="subdued" size="small">
                  商品グループ数: {Array.isArray(pendingCountForModal?.productGroupIds) ? pendingCountForModal.productGroupIds.length : 0}
                </s-text>
              </s-stack>
              <s-divider />
              <s-stack gap="none">
                <s-box padding="none" style={{ border: "1px solid var(--s-color-border)", borderRadius: 4 }}>
                  <s-text tone="subdued" size="small">商品グループごとに選択：1つの商品グループを選択して処理します</s-text>
                </s-box>
                <s-box padding="none" style={{ border: "1px solid var(--s-color-border)", borderRadius: 4 }}>
                  <s-text tone="subdued" size="small">まとめて表示：全商品グループを1画面で表示して処理します</s-text>
                </s-box>
              </s-stack>
              <s-divider />
              <s-box>
                <s-button
                  command="--hide"
                  commandFor={PRODUCT_GROUP_MODE_SELECTION_MODAL_ID}
                  onClick={() => {
                    setPendingCountForModal(null);
                  }}
                >
                  戻る
                </s-button>
              </s-box>
            </s-stack>
          </s-box>
        ) : null}

        <s-button
          slot="secondary-actions"
          onClick={handleSelectSingleProductGroup}
        >
          商品グループごとに選択
        </s-button>
        <s-button
          slot="primary-action"
          tone="success"
          onClick={handleShowAllProductGroups}
        >
          まとめて表示
        </s-button>
      </s-modal>
    </>
  );
}
