import { useState, useCallback, useEffect, useRef } from "preact/hooks";
import { getProductGroupName, getLocationName, readInventoryCountById, readInventoryCounts, writeInventoryCounts, fetchProductsByGroups, getCurrentQuantitiesBulk, normalizeIdForMatch, getCancelledGroupIdSet } from "./stocktakeApi.js";
import { getStatusBadgeTone } from "../../stocktakeHelpers.js";
import { FixedFooterNavBar } from "../common/FixedFooterNavBar.jsx";

const SHOPIFY = globalThis?.shopify ?? {};
const toast = (m) => SHOPIFY?.toast?.show?.(String(m));

function getGroupItemsByKey(groupItemsMap, groupId) {
  if (!groupId || !groupItemsMap || typeof groupItemsMap !== "object") return [];
  if (Array.isArray(groupItemsMap[groupId])) return groupItemsMap[groupId];
  const n = normalizeIdForMatch(groupId);
  const key = Object.keys(groupItemsMap).find((k) => normalizeIdForMatch(k) === n);
  return key && Array.isArray(groupItemsMap[key]) ? groupItemsMap[key] : [];
}

/** 一覧から渡された count が最小情報のみか（groupItems なし） */
function isMinimalCount(c) {
  return c && typeof c === "object" && c.id && !(c.groupItems && typeof c.groupItems === "object");
}

export function InventoryCountProductGroupSelection({
  count,
  onNext,
  onBack,
  setHeader,
  setFooter,
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [fullCount, setFullCount] = useState(null); // ✅ 一覧タップ後に readInventoryCountById で取得したフルデータ
  const [countLoading, setCountLoading] = useState(false);
  const [countError, setCountError] = useState("");
  const [productGroups, setProductGroups] = useState([]);
  const [productGroupNames, setProductGroupNames] = useState(new Map());
  const [productGroupQuantities, setProductGroupQuantities] = useState(new Map()); // ✅ 各商品グループの数量情報（読込ボタンで取得。初回は自動読込しない）
  const [loadingQuantities, setLoadingQuantities] = useState(false); // ✅ 在庫数読込中の表示用（ヘッダーで「読込中...」表示）
  const loadingQuantitiesRef = useRef(false); // ✅ 二重発火防止（onClick/onPress両方で呼ばれる場合）
  /** バックグラウンド自動読込を開始した countId（二重実行防止） */
  const quantitiesAutoLoadStartedRef = useRef(new Set());

  const effectiveCount = fullCount ?? (count?.groupItems ? count : null);

  // ✅ 一覧タップ後：最小情報のときだけ棚卸1件をAPI取得
  useEffect(() => {
    if (!count?.id) {
      setFullCount(null);
      setCountLoading(false);
      setCountError("");
      return;
    }
    if (!isMinimalCount(count)) {
      setFullCount(count);
      return;
    }
    let mounted = true;
    setCountLoading(true);
    setCountError("");
    readInventoryCountById(count.id)
      .then(async (fetched) => {
        if (!mounted) return;
        if (!fetched) {
          setFullCount(null);
          setCountError("棚卸の取得に失敗しました");
          return;
        }
        if (fetched.status === "draft") {
          try {
            const allCounts = await readInventoryCounts();
            const countIdStr = String(count?.id ?? "");
            const updated = (Array.isArray(allCounts) ? allCounts : []).map((c) =>
              String(c?.id ?? "") === countIdStr ? { ...c, status: "in_progress" } : c
            );
            await writeInventoryCounts(updated);
            fetched = { ...fetched, status: "in_progress" };
          } catch (e) {
            console.error("Failed to update count status:", e);
          }
        }
        setFullCount(fetched);
      })
      .catch((e) => {
        if (mounted) {
          setCountError(String(e?.message ?? e));
          setFullCount(null);
        }
      })
      .finally(() => {
        if (mounted) setCountLoading(false);
      });
    return () => { mounted = false; };
  }, [count?.id]);

  // 商品グループ名を取得（Map のキーは正規化キーで統一し、GID と数値の混在でずれないようにする）
  useEffect(() => {
    const c = effectiveCount ?? count;
    const loadNames = async () => {
      const groupMap = new Map();
      const productGroupIds = Array.isArray(c?.productGroupIds) ? c.productGroupIds : [];
      for (const groupId of productGroupIds) {
        const name = await getProductGroupName(groupId);
        if (name) groupMap.set(normalizeIdForMatch(groupId), name);
      }
      setProductGroupNames(groupMap);
    };
    if (c?.productGroupIds?.length) {
      loadNames();
    }
  }, [effectiveCount, count]);

  // 商品グループ情報を準備（管理画面で保存済みの productGroupNames を優先。参照は正規化キーで）
  useEffect(() => {
    const c = effectiveCount ?? count;
    if (!c) return;
    const productGroupIds = Array.isArray(c.productGroupIds) ? c.productGroupIds : [];
    const namesFromCount = Array.isArray(c.productGroupNames) ? c.productGroupNames : [];
    setProductGroups(productGroupIds.map((id, i) => ({
      id,
      name: namesFromCount[i] || productGroupNames.get(normalizeIdForMatch(id)) || id,
    })));
  }, [effectiveCount, count, productGroupNames]);

  // ✅ 各商品グループの数量情報を取得（入庫のシップメント選択画面と同じ方式）
  const loadProductGroupQuantities = useCallback(async () => {
    const c = effectiveCount;
    if (!c || !c.locationId) return;
    const productGroupIds = Array.isArray(c.productGroupIds) ? c.productGroupIds : [];
    if (productGroupIds.length === 0) return;

    const groupItemsMap = c?.groupItems && typeof c.groupItems === "object" ? c.groupItems : {};
    const countItemsLegacy = Array.isArray(c?.items) ? c.items : [];

    // ✅ グループを順次処理し、取得できたグループから順次UIに反映。在庫数は一括取得で高速化
    const toProducts = (raw) => (Array.isArray(raw) ? raw : (raw?.products ?? []));

    try {
      for (const groupId of productGroupIds) {
        try {
          let groupItems = getGroupItemsByKey(groupItemsMap, groupId);
          const isGroupCompleted = groupItems.length > 0;

          let totalQty = 0;
          let actualQty = 0;
          let skuCount = 0;

          if (isGroupCompleted) {
            skuCount = groupItems.length;
            totalQty = groupItems.reduce((sum, item) => sum + Number(item?.currentQuantity || 0), 0);
            actualQty = groupItems.reduce((sum, item) => sum + Number(item?.actualQuantity || 0), 0);
          } else {
            if (groupItems.length === 0) {
              const raw = await fetchProductsByGroups([groupId], c.locationId, {
                filterByInventoryLevel: false,
                includeImages: false,
                inventoryItemIdsByGroup: c?.inventoryItemIdsByGroup || null,
              });
              const products = toProducts(raw);
              const productInventoryItemIds = new Set(
                products.map((p) => String(p.inventoryItemId || "").trim()).filter(Boolean)
              );
              groupItems = countItemsLegacy.filter((item) => {
                const itemId = String(item?.inventoryItemId || "").trim();
                return productInventoryItemIds.has(itemId);
              });
              if (groupItems.length === 0) skuCount = products.length;
            }

            if (groupItems.length === 0) {
              const raw = await fetchProductsByGroups([groupId], c.locationId, {
                filterByInventoryLevel: false,
                includeImages: false,
                inventoryItemIdsByGroup: c?.inventoryItemIdsByGroup || null,
              });
              const products = toProducts(raw);
              skuCount = products.length;
              const ids = products.map((p) => p.inventoryItemId).filter(Boolean);
              if (ids.length > 0) {
                const qtyMap = await getCurrentQuantitiesBulk(ids, c.locationId);
                totalQty = products.reduce(
                  (sum, p) => sum + (p.inventoryItemId ? (qtyMap.get(p.inventoryItemId) ?? 0) : 0),
                  0
                );
              }
              actualQty = 0;
            } else {
              skuCount = groupItems.length;
              totalQty = groupItems.reduce((sum, item) => sum + Number(item?.currentQuantity || 0), 0);
              actualQty = groupItems.reduce((sum, item) => sum + Number(item?.actualQuantity || 0), 0);
            }
          }

          if (skuCount === 0 && c?.inventoryItemIdsByGroup?.[groupId]) {
            const ids = c.inventoryItemIdsByGroup[groupId];
            skuCount = Array.isArray(ids) ? ids.length : 0;
          }

          let status = "未処理";
          if (isGroupCompleted) {
            status = "処理済み";
          } else if (groupItems.length === 0 && countItemsLegacy.length > 0) {
            status = "処理中";
          }

          const entry = { total: totalQty, actual: actualQty, status, skuCount };
          setProductGroupQuantities((prev) => new Map(prev).set(groupId, entry));
        } catch (e) {
          console.error(`Failed to get quantity for product group ${groupId}:`, e);
          setProductGroupQuantities((prev) => new Map(prev).set(groupId, { total: 0, actual: 0, status: "未処理", skuCount: 0 }));
        }
      }
    } catch (e) {
      console.error("Failed to load product group quantities:", e);
    }
  }, [effectiveCount]);

  // ✅ 商品グループ一覧表示後に、各行の「N件 N/N」をバックグラウンドで自動取得（loadProductGroupQuantities 定義の後に配置し未初期化参照を防ぐ）
  useEffect(() => {
    const c = effectiveCount;
    if (!c?.productGroupIds?.length) return;
    const countId = c.id;
    if (!countId || quantitiesAutoLoadStartedRef.current.has(countId)) return;
    quantitiesAutoLoadStartedRef.current.add(countId);
    loadProductGroupQuantities();
  }, [effectiveCount, loadProductGroupQuantities]);

  // ✅ 初回は在庫数を自動読込しない。ヘッダー「在庫数読込」またはフッター「再読込」で取得（STOCKTAKE_39GROUPS_UX_IMPROVEMENTS.md）

  // ✅ グループ選択時：商品リストへ遷移（count は fullCount で渡す）
  const onSelectProductGroup = useCallback(
    (productGroupId) => {
      const c = effectiveCount;
      if (!c) return;

      const groupItemsMap = c?.groupItems && typeof c.groupItems === "object" ? c.groupItems : {};
      const groupItemsForGroup = getGroupItemsByKey(groupItemsMap, productGroupId);
      const hasGroupItems = groupItemsForGroup.length > 0;
      const isGroupCompleted = hasGroupItems || c?.status === "completed";

      onNext?.({
        countId: c.id,
        count: c,
        productGroupId: productGroupId,
        productGroupIds: [productGroupId],
        productGroupMode: "single",
        readOnly: isGroupCompleted,
      });
    },
    [effectiveCount, onNext]
  );

  // ✅ ヘッダー／フッターどちらから呼ばれても確実に実行。二重発火防止と読込中表示（ヘッダーで「読込中...」）
  const handleLoadQuantities = useCallback(async () => {
    if (loadingQuantitiesRef.current) return;
    loadingQuantitiesRef.current = true;
    setLoadingQuantities(true);
    await new Promise((r) => setTimeout(r, 0)); // ✅ 押した直後に「読込中...」を描画してから取得開始
    try {
      await loadProductGroupQuantities();
    } finally {
      setLoadingQuantities(false);
      loadingQuantitiesRef.current = false;
    }
  }, [loadProductGroupQuantities]);

  // Header（在庫数読込ボタン：左側・明細4行の上下中央。POSヘッダーではonClickが確実なためインラインで呼び出し。読込中は「読込中...」）
  useEffect(() => {
    const c = effectiveCount ?? count;
    if (countLoading) {
      setHeader?.(<s-box padding="base"><s-text tone="subdued">読み込み中...</s-text></s-box>);
      return () => setHeader?.(null);
    }
    if (countError) {
      setHeader?.(<s-box padding="base"><s-text tone="critical">{countError}</s-text></s-box>);
      return () => setHeader?.(null);
    }
    setHeader?.(
      <s-box padding="base">
        <s-stack direction="inline" alignItems="center" justifyContent="space-between" gap="base" style={{ width: "100%" }}>
          <s-stack gap="none" style={{ flex: "1 1 auto", minWidth: 0 }}>
            <s-text emphasis="bold">商品グループを選択</s-text>
            {c ? (
              <s-stack gap="none">
                <s-text tone="subdued" size="small">
                  {String(c?.countName || c?.id || "").trim() || "棚卸ID"}
                </s-text>
                <s-text tone="subdued" size="small">
                  ロケーション: {c.locationName || c.locationId || "-"}
                </s-text>
                <s-text tone="subdued" size="small">
                  商品グループ数: {productGroups.length}
                </s-text>
              </s-stack>
            ) : null}
          </s-stack>
          {c?.locationId ? (
            <s-box style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>
              <s-button
                kind="secondary"
                disabled={loadingQuantities}
                onClick={() => handleLoadQuantities()}
                onPress={() => handleLoadQuantities()}
              >
                {loadingQuantities ? "読込中..." : "在庫数読込"}
              </s-button>
            </s-box>
          ) : null}
        </s-stack>
      </s-box>
    );
    return () => setHeader?.(null);
  }, [setHeader, count, effectiveCount, productGroups.length, loadingQuantities, handleLoadQuantities, countLoading, countError]);

  // Footer
  useEffect(() => {
    const c = effectiveCount ?? count;
    const countName = String(c?.countName || c?.id || "").trim() || "-";
    setFooter?.(
      <FixedFooterNavBar
        summaryLeft={countName}
        summaryRight={`${productGroups.length}件`}
        leftLabel="戻る"
        onLeft={onBack}
        rightLabel={loadingQuantities ? "読込中..." : "再読込"}
        onRight={handleLoadQuantities}
        rightTone="default"
      />
    );
    return () => setFooter?.(null);
  }, [setFooter, count?.countName, count?.id, productGroups.length, onBack, handleLoadQuantities, loadingQuantities]);

  if (countLoading) {
    return (
      <s-box padding="base">
        <s-text tone="subdued">読み込み中...</s-text>
      </s-box>
    );
  }

  if (countError || (count?.id && !effectiveCount)) {
    return (
      <s-box padding="base">
        <s-text tone="critical">{countError || "棚卸の取得に失敗しました"}</s-text>
      </s-box>
    );
  }

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

  const c = effectiveCount ?? count;
  const groupItemsMap = c?.groupItems && typeof c.groupItems === "object" ? c.groupItems : {};
  const cancelledSet = getCancelledGroupIdSet(c);

  return (
    <s-box padding="base">
      <s-stack gap="none">
        {productGroups.map((group, index) => {
          const groupId = String(group?.id || "").trim();
          const groupName = group?.name || groupId;

          // ✅ ステータスは count から即時表示（在庫数読込ボタン不要）。完了・キャンセル・未処理を groupItems / cancelledGroupIds で判定
          const groupItemsForStatus = getGroupItemsByKey(groupItemsMap, groupId);
          const isGroupCompleted = groupItemsForStatus.length > 0;
          const isGroupCancelled = cancelledSet.has(normalizeIdForMatch(groupId));
          let statusJa = "未処理";
          if (isGroupCancelled) statusJa = "キャンセル";
          else if (isGroupCompleted) statusJa = "処理済み";

          // ✅ 数量（件数・在庫数）は読込ボタンで取得した productGroupQuantities を使用
          const qtyInfo = productGroupQuantities.get(groupId) || { total: 0, actual: 0, status: "未処理", skuCount: 0 };
          const skuCount = qtyInfo.skuCount ?? 0;
          const qtyText = qtyInfo.total > 0 ? `${qtyInfo.actual}/${qtyInfo.total}` : (qtyInfo.actual > 0 ? `${qtyInfo.actual}/-` : "-/-");
          const displayText = `${skuCount}件 ${qtyText}`;
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
