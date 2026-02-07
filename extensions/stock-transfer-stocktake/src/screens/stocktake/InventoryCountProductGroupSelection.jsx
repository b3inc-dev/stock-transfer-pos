import { useState, useCallback, useEffect } from "preact/hooks";
import { getProductGroupName, getLocationName, readInventoryCounts, writeInventoryCounts, fetchProductsByGroups, getCurrentQuantity } from "./stocktakeApi.js";
import { getStatusBadgeTone } from "../../stocktakeHelpers.js";
import { FixedFooterNavBar } from "../common/FixedFooterNavBar.jsx";

const SHOPIFY = globalThis?.shopify ?? {};
const toast = (m) => SHOPIFY?.toast?.show?.(String(m));

export function InventoryCountProductGroupSelection({
  count,
  onNext,
  onBack,
  setHeader,
  setFooter,
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [productGroups, setProductGroups] = useState([]);
  const [productGroupNames, setProductGroupNames] = useState(new Map());
  const [productGroupQuantities, setProductGroupQuantities] = useState(new Map()); // ✅ 各商品グループの数量情報

  // 商品グループ名を取得
  useEffect(() => {
    const loadNames = async () => {
      const groupMap = new Map();
      const productGroupIds = Array.isArray(count?.productGroupIds) ? count.productGroupIds : [];
      for (const groupId of productGroupIds) {
        const name = await getProductGroupName(groupId);
        if (name) groupMap.set(groupId, name);
      }
      setProductGroupNames(groupMap);
    };
    if (count?.productGroupIds) {
      loadNames();
    }
  }, [count]);

  // 商品グループ情報を準備（管理画面で保存済みの productGroupNames を優先）
  useEffect(() => {
    if (!count) return;
    const productGroupIds = Array.isArray(count.productGroupIds) ? count.productGroupIds : [];
    const namesFromCount = Array.isArray(count.productGroupNames) ? count.productGroupNames : [];
    setProductGroups(productGroupIds.map((id, i) => ({
      id,
      name: namesFromCount[i] || productGroupNames.get(id) || id,
    })));
  }, [count, productGroupNames]);

  // ✅ 各商品グループの数量情報を取得（入庫のシップメント選択画面と同じ方式）
  const loadProductGroupQuantities = useCallback(async () => {
    if (!count || !count.locationId) return;
    const productGroupIds = Array.isArray(count.productGroupIds) ? count.productGroupIds : [];
    if (productGroupIds.length === 0) return;

    const qtyMap = new Map();
    const groupItemsMap = count?.groupItems && typeof count.groupItems === "object" ? count.groupItems : {};
    const countItemsLegacy = Array.isArray(count?.items) ? count.items : [];

    try {
      await Promise.all(
        productGroupIds.map(async (groupId) => {
          try {
            let groupItems = Array.isArray(groupItemsMap[groupId]) ? groupItemsMap[groupId] : [];
            const isGroupCompleted = groupItems.length > 0;
            
            // ✅ 未処理グループでも在庫数を表示するため、商品リストを取得して在庫数を計算
            let totalQty = 0;
            let actualQty = 0;
            
            let skuCount = 0;
            if (isGroupCompleted) {
              // ✅ 完了済みグループ：groupItemsから数量を計算
              skuCount = groupItems.length;
              totalQty = groupItems.reduce((sum, item) => sum + Number(item?.currentQuantity || 0), 0);
              actualQty = groupItems.reduce((sum, item) => sum + Number(item?.actualQuantity || 0), 0);
            } else {
              // ✅ 未処理グループ：商品リストを取得して在庫数を計算
              if (groupItems.length === 0) {
                // ✅ 後方互換性：groupItemsがない場合、itemsフィールドから該当グループの商品をフィルタリング
                // ✅ SKU/CSVグループ用に inventoryItemIdsByGroup を渡す
                const products = await fetchProductsByGroups([groupId], count.locationId, {
                  filterByInventoryLevel: false,
                  includeImages: false,
                  inventoryItemIdsByGroup: count?.inventoryItemIdsByGroup || null,
                });
                const productInventoryItemIds = new Set(
                  products.map((p) => String(p.inventoryItemId || "").trim()).filter(Boolean)
                );
                groupItems = countItemsLegacy.filter((item) => {
                  const itemId = String(item?.inventoryItemId || "").trim();
                  return productInventoryItemIds.has(itemId);
                });
                if (groupItems.length === 0) skuCount = products.length;
              }
              
              // ✅ 未処理グループでも商品リストから在庫数を取得
              if (groupItems.length === 0) {
                // ✅ groupItemsが空の場合、商品グループの商品リストを取得して在庫数を計算
                // ✅ SKU/CSVグループ用に inventoryItemIdsByGroup を渡す
                const products = await fetchProductsByGroups([groupId], count.locationId, {
                  filterByInventoryLevel: false,
                  includeImages: false,
                  inventoryItemIdsByGroup: count?.inventoryItemIdsByGroup || null,
                });
                
                // ✅ 各商品の在庫数を取得して合計を計算
                const inventoryQuantities = await Promise.all(
                  products.map(async (p) => {
                    const qty = await getCurrentQuantity(p.inventoryItemId, count.locationId);
                    return qty !== null ? qty : 0;
                  })
                );
                skuCount = products.length;
                totalQty = inventoryQuantities.reduce((sum, qty) => sum + qty, 0);
                actualQty = 0; // 未処理なので実数は0
              } else {
                // ✅ groupItemsがある場合（後方互換性）、そこから数量を計算
                skuCount = groupItems.length;
                totalQty = groupItems.reduce((sum, item) => sum + Number(item?.currentQuantity || 0), 0);
                actualQty = groupItems.reduce((sum, item) => sum + Number(item?.actualQuantity || 0), 0);
              }
            }

            // ✅ inventoryItemIdsByGroup から SKU 数を取得（items/groupItems が空の場合のフォールバック）
            if (skuCount === 0 && count?.inventoryItemIdsByGroup?.[groupId]) {
              const ids = count.inventoryItemIdsByGroup[groupId];
              skuCount = Array.isArray(ids) ? ids.length : 0;
            }

            // 状態を判定
            // ✅ 完了判定：groupItemsが存在し、かつ配列の長さが0より大きい場合に「処理済み」と判定
            let status = "未処理";
            if (isGroupCompleted) {
              status = "処理済み";
            } else if (groupItems.length === 0 && countItemsLegacy.length > 0) {
              // ✅ 後方互換性：groupItemsがないが、itemsフィールドにデータがある場合は「処理中」と表示
              status = "処理中";
            }

            qtyMap.set(groupId, { total: totalQty, actual: actualQty, status, skuCount });
          } catch (e) {
            console.error(`Failed to get quantity for product group ${groupId}:`, e);
            qtyMap.set(groupId, { total: 0, actual: 0, status: "未処理", skuCount: 0 });
          }
        })
      );
    } catch (e) {
      console.error("Failed to load product group quantities:", e);
    }

    setProductGroupQuantities(qtyMap);
  }, [count]);

  useEffect(() => {
    loadProductGroupQuantities();
  }, [loadProductGroupQuantities]);

  const onSelectProductGroup = useCallback(
    async (productGroupId) => {
      if (!count) return;

      const groupItemsMap = count?.groupItems && typeof count.groupItems === "object" ? count.groupItems : {};
      // ✅ グループが完了しているか判定：groupItems[productGroupId]が存在し、かつ配列の長さが0より大きい場合に完了と判定
      const groupItemsForGroup = productGroupId && groupItemsMap[productGroupId] && Array.isArray(groupItemsMap[productGroupId]) ? groupItemsMap[productGroupId] : [];
      const hasGroupItems = groupItemsForGroup.length > 0;
      // ✅ 完了判定：groupItemsが存在する場合、または全体が完了している場合に完了と判定
      const isGroupCompleted = hasGroupItems || count?.status === "completed";

      if (!isGroupCompleted && count.status === "draft") {
        try {
          const allCounts = await readInventoryCounts();
          const updated = allCounts.map((c) =>
            c.id === count.id ? { ...c, status: "in_progress" } : c
          );
          await writeInventoryCounts(updated);
          count.status = "in_progress";
        } catch (e) {
          console.error("Failed to update count status:", e);
        }
      }

      onNext?.({
        countId: count.id,
        count: count,
        productGroupId: productGroupId,
        productGroupIds: [productGroupId],
        productGroupMode: "single",
        readOnly: isGroupCompleted,
      });
    },
    [count, onNext]
  );

  // Header
  useEffect(() => {
    setHeader?.(
      <s-box padding="base">
        <s-stack gap="base">
          <s-text emphasis="bold">商品グループを選択</s-text>
          {count ? (
            <s-stack gap="none">
              <s-text tone="subdued" size="small">
                {String(count?.countName || count?.id || "").trim() || "棚卸ID"}
              </s-text>
              <s-text tone="subdued" size="small">
                ロケーション: {count.locationName || count.locationId || "-"}
              </s-text>
              <s-text tone="subdued" size="small">
                商品グループ数: {productGroups.length}
              </s-text>
            </s-stack>
          ) : null}
        </s-stack>
      </s-box>
    );
    return () => setHeader?.(null);
  }, [setHeader, count, productGroups.length]);

  // Footer
  useEffect(() => {
    const countName = String(count?.countName || count?.id || "").trim() || "-";
    setFooter?.(
      <FixedFooterNavBar
        summaryLeft={countName}
        summaryRight={`${productGroups.length}件`}
        leftLabel="戻る"
        onLeft={onBack}
        rightLabel="再読込"
        onRight={async () => {
          // 再読込処理（数量情報を更新）
          await loadProductGroupQuantities();
        }}
        rightTone="default"
      />
    );
    return () => setFooter?.(null);
  }, [setFooter, count?.countName, count?.id, productGroups.length, onBack, loadProductGroupQuantities]);

  if (loading) {
    return (
      <s-box padding="base">
        <s-text tone="subdued">読み込み中...</s-text>
      </s-box>
    );
  }

  if (error) {
    return (
      <s-box padding="base">
        <s-text tone="critical">エラー: {error}</s-text>
      </s-box>
    );
  }

  if (!count || productGroups.length === 0) {
    return (
      <s-box padding="base">
        <s-text tone="subdued">商品グループが見つかりません</s-text>
      </s-box>
    );
  }

  return (
    <s-box padding="base">
      <s-stack gap="none">
        {productGroups.map((group, index) => {
          const groupId = String(group?.id || "").trim();
          const groupName = group?.name || groupId;
          
          // ✅ 数量情報を取得（入庫のシップメント選択画面と同じ方式）
          const qtyInfo = productGroupQuantities.get(groupId) || { total: 0, actual: 0, status: "未処理", skuCount: 0 };
          const skuCount = qtyInfo.skuCount ?? 0;
          // ✅ 未処理グループでも在庫数を表示（totalが0の場合は「-」を表示）
          const qtyText = qtyInfo.total > 0 ? `${qtyInfo.actual}/${qtyInfo.total}` : (qtyInfo.actual > 0 ? `${qtyInfo.actual}/-` : "-/-");
          const displayText = `${skuCount}件 ${qtyText}`;
          const statusJa = qtyInfo.status || "未処理";
          const statusBadgeTone = getStatusBadgeTone(statusJa);

          return (
            <s-box key={groupId} padding="none">
              <s-clickable onClick={() => onSelectProductGroup(groupId)}>
                <s-box
                  paddingInline="none"
                  paddingBlockStart="small-100"
                  paddingBlockEnd="small-200"
                >
                  <s-stack gap="base">
                    <s-stack direction="inline" justifyContent="space-between" alignItems="flex-end" gap="small">
                      <s-box style={{ flex: "1 1 auto", minWidth: 0 }}>
                        <s-stack gap="none">
                          <s-text emphasis="bold" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {groupName}
                          </s-text>
                          <s-stack direction="inline" gap="small" alignItems="center">
                            <s-badge tone={statusBadgeTone}>{statusJa}</s-badge>
                          </s-stack>
                        </s-stack>
                      </s-box>
                      <s-box style={{ flex: "0 0 auto" }}>
                        <s-text tone="subdued" size="small" style={{ whiteSpace: "nowrap" }}>
                          {displayText}
                        </s-text>
                      </s-box>
                    </s-stack>
                  </s-stack>
                </s-box>
              </s-clickable>
              <s-divider />
            </s-box>
          );
        })}
      </s-stack>
    </s-box>
  );
}
