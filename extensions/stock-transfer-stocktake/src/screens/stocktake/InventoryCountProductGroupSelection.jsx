import { useState, useCallback, useEffect, useRef, useMemo } from "preact/hooks";
import {
  getProductGroupName,
  readInventoryCountById,
  readInventoryCounts,
  writeInventoryCounts,
  getInventoryCountsVersion,
  fetchProductsByGroups,
  getCurrentQuantitiesBulk,
  normalizeIdForMatch,
  getCancelledGroupIdSet,
  readProductGroups,
  readProductGroupNames,
} from "./stocktakeApi.js";
import { getStatusBadgeTone } from "../../stocktakeHelpers.js";
import { FixedFooterNavBar } from "../common/FixedFooterNavBar.jsx";

/** ユーザー起動の一括数量読込の並列数（STOCKTAKE_39GROUPS / UX Canon） */
const QTY_LOAD_CONCURRENCY = 4;

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

async function mapPool(items, concurrency, worker) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return;
  const limit = Math.max(1, Math.min(concurrency, list.length));
  let nextIndex = 0;
  const runners = Array.from({ length: limit }, async () => {
    while (nextIndex < list.length) {
      const i = nextIndex++;
      await worker(list[i], i);
    }
  });
  await Promise.all(runners);
}

export function InventoryCountProductGroupSelection({
  count,
  onNext,
  onBack,
  setHeader,
  setFooter,
}) {
  const [fullCount, setFullCount] = useState(null);
  const [countLoading, setCountLoading] = useState(false);
  const [countError, setCountError] = useState("");
  const [productGroups, setProductGroups] = useState([]);
  const [productGroupNames, setProductGroupNames] = useState(new Map());
  const [productGroupQuantities, setProductGroupQuantities] = useState(new Map());
  const [loadingQuantities, setLoadingQuantities] = useState(false);
  const [qtyLoadProgress, setQtyLoadProgress] = useState({ done: 0, total: 0 });
  const loadingQuantitiesRef = useRef(false);
  /** 1 回だけ読んだ商品グループスナップショット（二重 readProductGroups / 二重 fetch 防止） */
  const cachedProductGroupsRef = useRef(null);
  const namesLoadStartedRef = useRef(false);

  const effectiveCount = fullCount ?? (count?.groupItems ? count : null);

  const resolvedProductGroupIds = useMemo(() => {
    const c = effectiveCount ?? count;
    if (!c) return [];
    return Array.isArray(c.productGroupIds) && c.productGroupIds.length > 0
      ? c.productGroupIds
      : (c.productGroupId ? [c.productGroupId] : []);
  }, [effectiveCount, count]);

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
            // InventoryCountList と同様に楽観ロック（他端末の completed 上書きレース緩和）
            const version = await getInventoryCountsVersion();
            await writeInventoryCounts(updated, version);
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

  // 名前解決: 軽量 metafield（product_group_names）→ 必要時のみフル groups 1 回
  useEffect(() => {
    let mounted = true;
    namesLoadStartedRef.current = false;
    const loadNames = async () => {
      if (resolvedProductGroupIds.length === 0) return;
      if (namesLoadStartedRef.current) return;
      namesLoadStartedRef.current = true;
      const groupMap = new Map();
      const namesFromCount = Array.isArray((effectiveCount ?? count)?.productGroupNames)
        ? (effectiveCount ?? count).productGroupNames
        : [];
      for (let i = 0; i < resolvedProductGroupIds.length; i++) {
        const groupId = resolvedProductGroupIds[i];
        const fromCount = namesFromCount[i];
        if (fromCount) groupMap.set(normalizeIdForMatch(groupId), fromCount);
      }
      try {
        const lightNames = await readProductGroupNames();
        if (lightNames && typeof lightNames === "object") {
          for (const groupId of resolvedProductGroupIds) {
            const n = normalizeIdForMatch(groupId);
            if (groupMap.has(n)) continue;
            const name = lightNames[groupId] ?? lightNames[n]
              ?? Object.entries(lightNames).find(([id]) => normalizeIdForMatch(id) === n)?.[1];
            if (name) groupMap.set(n, name);
          }
        }
      } catch (e) {
        console.error("[ProductGroupSelection] readProductGroupNames failed:", e);
      }
      const missing = resolvedProductGroupIds.filter((id) => !groupMap.has(normalizeIdForMatch(id)));
      if (missing.length > 0) {
        try {
          if (!cachedProductGroupsRef.current) {
            cachedProductGroupsRef.current = await readProductGroups();
          }
          const groups = Array.isArray(cachedProductGroupsRef.current) ? cachedProductGroupsRef.current : [];
          for (const groupId of missing) {
            const n = normalizeIdForMatch(groupId);
            const g = groups.find((x) => normalizeIdForMatch(x?.id) === n);
            if (g?.name) groupMap.set(n, g.name);
            else {
              const name = await getProductGroupName(groupId);
              if (name) groupMap.set(n, name);
            }
          }
        } catch (e) {
          console.error("[ProductGroupSelection] readProductGroups for names failed:", e);
        }
      }
      if (mounted) setProductGroupNames(groupMap);
    };
    loadNames();
    return () => { mounted = false; };
  }, [effectiveCount, count, resolvedProductGroupIds]);

  useEffect(() => {
    const c = effectiveCount ?? count;
    if (!c || resolvedProductGroupIds.length === 0) return;
    const namesFromCount = Array.isArray(c.productGroupNames) ? c.productGroupNames : [];
    setProductGroups(resolvedProductGroupIds.map((id, i) => ({
      id,
      name: namesFromCount[i] || productGroupNames.get(normalizeIdForMatch(id)) || id,
    })));
  }, [effectiveCount, count, productGroupNames, resolvedProductGroupIds]);

  const ensureCachedProductGroups = useCallback(async () => {
    if (Array.isArray(cachedProductGroupsRef.current) && cachedProductGroupsRef.current.length > 0) {
      return cachedProductGroupsRef.current;
    }
    try {
      cachedProductGroupsRef.current = await readProductGroups();
    } catch (e) {
      console.error("[ProductGroupSelection] readProductGroups failed:", e);
      cachedProductGroupsRef.current = [];
    }
    return cachedProductGroupsRef.current || [];
  }, []);

  // ユーザー起動のみ。マウント自動実行はしない（STOCKTAKE_UX_CANON / 39GROUPS §1.2）
  const loadProductGroupQuantities = useCallback(async () => {
    const c = effectiveCount;
    if (!c || !c.locationId || resolvedProductGroupIds.length === 0) return;

    const groupItemsMap = c?.groupItems && typeof c.groupItems === "object" ? c.groupItems : {};
    const countItemsLegacy = Array.isArray(c?.items) ? c.items : [];
    const toProducts = (raw) => (Array.isArray(raw) ? raw : (raw?.products ?? []));
    const cachedProductGroups = await ensureCachedProductGroups();
    const total = resolvedProductGroupIds.length;
    setQtyLoadProgress({ done: 0, total });
    let done = 0;

    const processOne = async (groupId) => {
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
          // 同一グループの二重 fetch を避け、1 回だけ取得
          const raw = await fetchProductsByGroups([groupId], c.locationId, {
            filterByInventoryLevel: false,
            includeImages: false,
            inventoryItemIdsByGroup: c?.inventoryItemIdsByGroup || null,
            ...(cachedProductGroups.length > 0 ? { cachedProductGroups } : {}),
          });
          const products = toProducts(raw);
          const productInventoryItemIds = new Set(
            products.map((p) => String(p.inventoryItemId || "").trim()).filter(Boolean)
          );
          groupItems = countItemsLegacy.filter((item) => {
            const itemId = String(item?.inventoryItemId || "").trim();
            return productInventoryItemIds.has(itemId);
          });

          if (groupItems.length === 0) {
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
      } finally {
        done += 1;
        setQtyLoadProgress({ done, total });
      }
    };

    try {
      await mapPool(resolvedProductGroupIds, QTY_LOAD_CONCURRENCY, processOne);
    } catch (e) {
      console.error("Failed to load product group quantities:", e);
    }
  }, [effectiveCount, resolvedProductGroupIds, ensureCachedProductGroups]);

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

  const handleLoadQuantities = useCallback(async () => {
    if (loadingQuantitiesRef.current) return;
    loadingQuantitiesRef.current = true;
    setLoadingQuantities(true);
    await new Promise((r) => setTimeout(r, 0));
    try {
      await loadProductGroupQuantities();
    } finally {
      setLoadingQuantities(false);
      loadingQuantitiesRef.current = false;
    }
  }, [loadProductGroupQuantities]);

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
    const progressLabel =
      loadingQuantities && qtyLoadProgress.total > 0
        ? `読込中... ${qtyLoadProgress.done}/${qtyLoadProgress.total}`
        : loadingQuantities
          ? "読込中..."
          : "在庫数読込";
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
                {progressLabel}
              </s-button>
            </s-box>
          ) : null}
        </s-stack>
      </s-box>
    );
    return () => setHeader?.(null);
  }, [setHeader, count, effectiveCount, productGroups.length, loadingQuantities, handleLoadQuantities, countLoading, countError, qtyLoadProgress]);

  useEffect(() => {
    const c = effectiveCount ?? count;
    const countName = String(c?.countName || c?.id || "").trim() || "-";
    const rightLabel =
      loadingQuantities && qtyLoadProgress.total > 0
        ? `読込中 ${qtyLoadProgress.done}/${qtyLoadProgress.total}`
        : loadingQuantities
          ? "読込中..."
          : "再読込";
    setFooter?.(
      <FixedFooterNavBar
        summaryLeft={countName}
        summaryRight={`${productGroups.length}件`}
        leftLabel="戻る"
        onLeft={onBack}
        rightLabel={rightLabel}
        onRight={handleLoadQuantities}
        rightTone="default"
      />
    );
    return () => setFooter?.(null);
  }, [setFooter, count?.countName, count?.id, productGroups.length, onBack, handleLoadQuantities, loadingQuantities, qtyLoadProgress]);

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
        {productGroups.map((group) => {
          const groupId = String(group?.id || "").trim();
          const groupName = group?.name || groupId;

          const groupItemsForStatus = getGroupItemsByKey(groupItemsMap, groupId);
          const isGroupCompleted = groupItemsForStatus.length > 0 || c?.status === "completed";
          const isGroupCancelled = cancelledSet.has(normalizeIdForMatch(groupId));
          let statusJa = "未処理";
          if (isGroupCancelled) statusJa = "キャンセル";
          else if (isGroupCompleted) statusJa = "処理済み";

          const qtyInfo = productGroupQuantities.get(groupId);
          const hasQty = qtyInfo != null;
          const skuCount = qtyInfo?.skuCount ?? 0;
          const qtyText = !hasQty
            ? "未読込"
            : qtyInfo.total > 0
              ? `${qtyInfo.actual}/${qtyInfo.total}`
              : (qtyInfo.actual > 0 ? `${qtyInfo.actual}/-` : "-/-");
          const displayText = hasQty ? `${skuCount}件 ${qtyText}` : qtyText;
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
