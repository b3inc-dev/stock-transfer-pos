import { useState, useCallback, useMemo, useEffect, useRef } from "preact/hooks";
import {
  readInventoryCountsFirstPage,
  readInventoryCountsPage,
  getStocktakeListLimit,
  getLocationName,
  getProductGroupName,
  toLocationGid,
  toLocationNumericId,
  fetchLocations,
  getGroupItemsByKey,
  normalizeIdForMatch,
} from "./stocktakeApi.js";
import { getStatusBadgeTone } from "../../stocktakeHelpers.js";
import { FixedFooterNavBar } from "../common/FixedFooterNavBar.jsx";

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

/** 一覧タップ時に渡す最小情報（商品グループ・商品リストは遷移先でAPI取得） */
function toMinimalCount(c) {
  if (!c) return null;
  return {
    id: c.id,
    locationId: c.locationId,
    productGroupIds: Array.isArray(c.productGroupIds) ? c.productGroupIds : c.productGroupId ? [c.productGroupId] : [],
    status: c.status,
    countName: c.countName,
    createdAt: c.createdAt,
  };
}

const readValue = (e) => String(e?.target?.value ?? "").trim();

const STOCKTAKE_LOCATION_MODAL_ID = "stocktake-location-modal";

/** ロケーション選択モーダル（POSでは command="--show" commandFor={id} で開くため常にレンダー） */
function LocationSelectModal({ id, title, locations, selectedId, onSelect }) {
  const [searchQuery, setSearchQuery] = useState("");
  const list = useMemo(() => {
    const base = Array.isArray(locations) ? locations : [];
    const q = String(searchQuery || "").trim().toLowerCase();
    if (!q) return base;
    return base.filter((l) => String(l?.name || "").toLowerCase().includes(q));
  }, [locations, searchQuery]);

  return (
    <s-modal id={id} heading={title || "ロケーションを選択"} style={{ maxBlockSize: "85vh" }}>
      <s-box padding="base">
        <s-stack gap="base">
          <s-text-field
            label="検索"
            placeholder="ロケーション名"
            value={searchQuery}
            onInput={(e) => setSearchQuery(readValue(e))}
            onChange={(e) => setSearchQuery(readValue(e))}
          />
          <s-scroll-view style={{ maxBlockSize: "60vh" }}>
            <s-stack gap="small">
              {list.length === 0 ? (
                <s-text tone="subdued">該当するロケーションがありません</s-text>
              ) : (
                list.map((l) => (
                  <s-button
                    key={l.id}
                    tone={l.id === selectedId ? "success" : undefined}
                    command="--hide"
                    commandFor={id}
                    onClick={() => onSelect?.(l.id, l.name)}
                  >
                    {l.name}
                  </s-button>
                ))
              )}
            </s-stack>
          </s-scroll-view>
        </s-stack>
      </s-box>
    </s-modal>
  );
}

export function InventoryCountConditions({
  onNext,
  onBack,
  onOpenProductGroupSelection,
  setHeader,
  setFooter,
  locationGid,
  onLocationChange,
  liteMode,
  onToggleLiteMode,
}) {
  const [viewMode, setViewMode] = useState("pending"); // "pending" | "completed"
  const [allLocations, setAllLocations] = useState([]);
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
  const [chunkCount, setChunkCount] = useState(0);
  const [loadedChunkCount, setLoadedChunkCount] = useState(0);
  const firstPageOptsRef = useRef({ productGroups: null, totalChunks: 0, useListMetafield: false });

  const filterByLocation = useCallback((list, locGid) => {
    if (!locGid) return list;
    const sessionNum = toLocationNumericId(locGid);
    const sessionGid = toLocationGid(locGid) || locGid;
    return list.filter((c) => {
      const cid = c.locationId;
      if (cid == null || cid === "") return true;
      if (sessionNum && toLocationNumericId(cid) === sessionNum) return true;
      if (toLocationGid(cid) === sessionGid || cid === locGid || cid === sessionGid) return true;
      return false;
    });
  }, []);

  const listToShow = useMemo(() => {
    const base = Array.isArray(counts) ? counts : [];
    return viewMode === "completed" ? base.filter(isCompleted) : base.filter((c) => !isCompleted(c));
  }, [counts, viewMode]);

  const hasMoreHistory = loadedChunkCount < chunkCount;
  // ✅ さらに読み込み：productGroups/totalChunks/useListMetafield を渡してチャンク1本だけ取得（軽量化）
  const loadMoreHistory = useCallback(async () => {
    if (loadedChunkCount >= chunkCount) return;
    setLoading(true);
    await new Promise((r) => setTimeout(r, 0)); // 押した直後に「読込中...」を描画してから取得開始
    try {
      const opts = firstPageOptsRef.current;
      const listLimit = opts.listLimit ?? (await getStocktakeListLimit());
      const accumulated = [];
      let nextLoaded = loadedChunkCount;
      while (nextLoaded < chunkCount && accumulated.length < listLimit) {
        const chunkIndex = chunkCount - 1 - nextLoaded;
        const pageOpts =
          opts.productGroups != null && opts.totalChunks > 0
            ? { productGroups: opts.productGroups, totalChunks: chunkCount, useListMetafield: opts.useListMetafield }
            : undefined;
        const result = await readInventoryCountsPage(chunkIndex, pageOpts);
        const raw = Array.isArray(result.counts) ? result.counts : [];
        const filtered = locationGid ? filterByLocation(raw, locationGid) : raw;
        accumulated.push(...filtered);
        nextLoaded += 1;
      }
      setCounts((prev) => {
        const next = [...prev, ...accumulated];
        next.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
        return next;
      });
      setLoadedChunkCount(nextLoaded);
    } catch (e) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, [loadedChunkCount, chunkCount, locationGid, filterByLocation]);

  const baseAll = Array.isArray(counts) ? counts : [];
  const pendingCountsAll = baseAll.filter((c) => !isCompleted(c));
  const completedCountsAll = baseAll.filter(isCompleted);

  // ロケーション名と商品グループ名を取得（現在ログイン中のロケーション名も必ず取得してフッターに表示）
  useEffect(() => {
    const loadNames = async () => {
      const locMap = new Map();
      const groupMap = new Map();
      if (locationGid) {
        try {
          const name = await getLocationName(locationGid);
          locMap.set(locationGid, name || "（取得できませんでした）");
        } catch (e) {
          console.warn("[InventoryCountConditions] getLocationName(locationGid) failed:", e);
          locMap.set(locationGid, "（取得できませんでした）");
        }
      }
      for (const count of counts) {
        if (count.locationId && !locMap.has(count.locationId)) {
          try {
            const name = await getLocationName(count.locationId);
            locMap.set(count.locationId, name || "（取得できませんでした）");
          } catch (e) {
            console.warn("[InventoryCountConditions] getLocationName(count.locationId) failed:", e);
            locMap.set(count.locationId, "（取得できませんでした）");
          }
        }
        if (Array.isArray(count.productGroupIds)) {
          for (const groupId of count.productGroupIds) {
            const key = normalizeIdForMatch(groupId);
            if (!groupMap.has(key)) {
              try {
                const name = await getProductGroupName(groupId);
                if (name) groupMap.set(key, name);
              } catch (e) {
                console.warn("[InventoryCountConditions] getProductGroupName failed:", e);
              }
            }
          }
        }
      }
      setLocationNames(locMap);
      setProductGroupNames(groupMap);
    };
    loadNames();
  }, [counts, locationGid]);

  // ✅ 履歴一覧は入庫と同様に軽量表示のみ。未完了グループの在庫数は自動取得しない（入庫の履歴一覧は追加クエリなしで totalQuantity/receivedQuantity を表示するため、棚卸も一覧表示時は在庫クエリを発生させない）。数量は groupItems がある場合のみ表示し、未取得時は「—」表示。

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    setChunkCount(0);
    setLoadedChunkCount(0);
    await new Promise((r) => setTimeout(r, 0)); // 押した直後に「読込中...」を描画してから取得開始
    try {
      let result = await readInventoryCountsFirstPage();
      firstPageOptsRef.current = {
        productGroups: result.productGroups ?? null,
        listLimit: result.listLimit,
        totalChunks: result.chunkCount ?? 0,
        useListMetafield: result.useListMetafield === true,
      };
      let allFetched = Array.isArray(result.counts) ? [...result.counts] : [];
      let loadedChunks = 1;
      const totalChunks = result.chunkCount ?? 0;
      const pageOpts =
        firstPageOptsRef.current.productGroups != null && totalChunks > 0
          ? {
              productGroups: firstPageOptsRef.current.productGroups,
              totalChunks,
              useListMetafield: firstPageOptsRef.current.useListMetafield,
            }
          : undefined;
      if (locationGid) {
        let filtered = filterByLocation(allFetched, locationGid);
        while (filtered.length === 0 && allFetched.length > 0 && loadedChunks < totalChunks) {
          const chunkIndex = totalChunks - 1 - loadedChunks;
          const next = await readInventoryCountsPage(chunkIndex, pageOpts);
          const nextCounts = Array.isArray(next.counts) ? next.counts : [];
          allFetched = [...allFetched, ...nextCounts];
          loadedChunks += 1;
          filtered = filterByLocation(allFetched, locationGid);
        }
        const sorted = [...filtered].sort((a, b) => {
          const t1 = new Date(a.createdAt || 0).getTime();
          const t2 = new Date(b.createdAt || 0).getTime();
          return t2 - t1;
        });
        setCounts(sorted);
      } else {
        const sorted = [...allFetched].sort((a, b) => {
          const t1 = new Date(a.createdAt || 0).getTime();
          const t2 = new Date(b.createdAt || 0).getTime();
          return t2 - t1;
        });
        setCounts(sorted);
      }
      setChunkCount(totalChunks);
      setLoadedChunkCount(loadedChunks);
    } catch (e) {
      setError(String(e?.message ?? e));
      setCounts([]);
    } finally {
      setLoading(false);
    }
  }, [locationGid, filterByLocation]);

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

    const minimalCount = toMinimalCount(c);

    if (productGroupCount === 1) {
      onNext?.({
        countId: c.id,
        count: minimalCount,
        productGroupId: productGroupIds[0],
        productGroupIds: productGroupIds,
        productGroupMode: "single",
      });
      return;
    }

    setPendingCountForModal(minimalCount);
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
                variant={viewMode === "pending" ? "primary" : "secondary"}
                onClick={() => setViewMode("pending")}
              >
                未完了 {pendingCountsAll.length}件
              </s-button>
            </s-box>
            <s-box inlineSize="50%">
              <s-button
                variant={viewMode === "completed" ? "primary" : "secondary"}
                onClick={() => setViewMode("completed")}
              >
                完了済み {completedCountsAll.length}件
              </s-button>
            </s-box>
          </s-stack>

          {/* ✅ さらに読み込みボタン（入庫・出庫と同様：設定数以上あるときにヘッダーに表示） */}
          {hasMoreHistory ? (
            <s-box padding="none" style={{ paddingBlock: "4px", paddingInline: "16px" }}>
              <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
                <s-text tone="subdued" size="small">
                  未読み込み一覧リストがあります。（過去分）
                </s-text>
                <s-button
                  kind="secondary"
                  onClick={() => loadMoreHistory()}
                  onPress={() => loadMoreHistory()}
                >
                  読込
                </s-button>
              </s-stack>
            </s-box>
          ) : null}
        </s-stack>
      </s-box>
    );
    return () => setHeader?.(null);
  }, [setHeader, viewMode, pendingCountsAll.length, completedCountsAll.length, hasMoreHistory, loadMoreHistory]);

  // ロケーション一覧はマウント時に取得（モーダル表示時に使用）
  useEffect(() => {
    fetchLocations().then((list) => setAllLocations(Array.isArray(list) ? list : []));
  }, []);

  // Footer（中央にロケーション変更ボタン、command でモーダルを開く）
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
        leftLabel={liteMode ? "画像OFF" : "画像ON"}
        leftTone={liteMode ? "critical" : "default"}
        onLeft={typeof onToggleLiteMode === "function" ? onToggleLiteMode : undefined}
        rightLabel={loading ? "読込中..." : "再読込"}
        onRight={refresh}
        rightDisabled={loading}
      />
    );
    return () => setFooter?.(null);
  }, [setFooter, locationGid, locationNames, viewMode, listToShow.length, liteMode, onToggleLiteMode, refresh, loading]);

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
              {loading ? "読み込み中..." : "表示できる棚卸IDがありません"}
            </s-text>
          ) : (
            <s-stack gap="base">
              {listToShow.map((c) => {
                // countNameがあればそれを使用、なければidを使用（後方互換性）
                const head = String(c?.countName || c?.id || "").trim() || "棚卸ID";
                const date = formatDate(c?.createdAt);
                const locationName = locationNames.get(c.locationId) || c.locationName || "-";
                // ✅ 管理画面で保存済みの productGroupNames を優先。参照は正規化キーで（GID と数値の混在でずれないようにする）
                const productGroupNamesList = Array.isArray(c.productGroupIds)
                  ? c.productGroupIds.map((id, i) => {
                      const fromCount = Array.isArray(c.productGroupNames) && c.productGroupNames[i];
                      return fromCount || productGroupNames.get(normalizeIdForMatch(id)) || id;
                    }).join(", ")
                  : c.productGroupName || productGroupNames.get(normalizeIdForMatch(c.productGroupId)) || c.productGroupId || "-";
                const productGroupCount = Array.isArray(c.productGroupIds) ? c.productGroupIds.length : 1;

                const rawStatus = String(c?.status || "").trim();
                const statusJa = STATUS_LABEL[rawStatus] || rawStatus || "不明";
                const statusBadgeTone = getStatusBadgeTone(statusJa);

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
                                <s-badge tone={statusBadgeTone}>{statusJa}</s-badge>
                                {/* ✅ SKU数と数量カウント（右寄せ） */}
                                {(() => {
                                  const itemsFromItems = Array.isArray(c.items) && c.items.length > 0 ? c.items : null;
                                  const groupItemsMap = c?.groupItems && typeof c.groupItems === "object" ? c.groupItems : {};
                                  const itemsFromGroup = Array.isArray(c.productGroupIds) && c.productGroupIds.length > 0
                                    ? c.productGroupIds.flatMap((id) => getGroupItemsByKey(groupItemsMap, id))
                                    : [];
                                  const allGroupItems = itemsFromItems || itemsFromGroup;
                                  // ✅ items/groupItemsが空でも、inventoryItemIdsByGroup（管理画面で保存）からSKU数を算出
                                  let skuCount = allGroupItems.length;
                                  if (skuCount === 0 && c?.inventoryItemIdsByGroup && typeof c.inventoryItemIdsByGroup === "object") {
                                    const idsByGroup = c.inventoryItemIdsByGroup;
                                    const groupIds = Array.isArray(c.productGroupIds) ? c.productGroupIds : (c.productGroupId ? [c.productGroupId] : []);
                                    skuCount = groupIds.reduce((sum, gid) => sum + (Array.isArray(idsByGroup[gid]) ? idsByGroup[gid].length : 0), 0);
                                  }
                                  const totalQty = allGroupItems.reduce((s, it) => s + (it.actualQuantity || 0), 0);
                                  let currentQty = allGroupItems.reduce((s, it) => s + (it.currentQuantity || 0), 0);
                                  const completed = c.status === "completed" || c.status === "cancelled";
                                  if (!completed && Array.isArray(c.productGroupIds) && c.productGroupIds.length > 0) {
                                    const countQuantities = incompleteGroupQuantities.get(c.id);
                                    if (countQuantities) {
                                      for (const groupId of c.productGroupIds) {
                                        const groupItems = getGroupItemsByKey(groupItemsMap, groupId);
                                        if (groupItems.length === 0) {
                                          currentQty += countQuantities.get(groupId) || 0;
                                        }
                                      }
                                    }
                                  }
                                  const qtyText = completed || currentQty > 0 ? `${totalQty}/${currentQty}` : `${totalQty}/-`;
                                  return (
                                    <s-text tone="subdued" size="small" style={{ whiteSpace: "nowrap" }}>{skuCount}件 {qtyText}</s-text>
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
                              <s-badge tone={statusBadgeTone}>{statusJa}</s-badge>
                              {/* ✅ SKU数と数量カウント（右寄せ） */}
                              {(() => {
                                const itemsFromItems = Array.isArray(c.items) && c.items.length > 0 ? c.items : null;
                                const groupItemsMap = c?.groupItems && typeof c.groupItems === "object" ? c.groupItems : {};
                                const itemsFromGroup = Array.isArray(c.productGroupIds) && c.productGroupIds.length > 0
                                  ? c.productGroupIds.flatMap((id) => getGroupItemsByKey(groupItemsMap, id))
                                  : [];
                                const allGroupItems = itemsFromItems || itemsFromGroup;
                                let skuCount = allGroupItems.length;
                                if (skuCount === 0 && c?.inventoryItemIdsByGroup && typeof c.inventoryItemIdsByGroup === "object") {
                                  const idsByGroup = c.inventoryItemIdsByGroup;
                                  const groupIds = Array.isArray(c.productGroupIds) ? c.productGroupIds : (c.productGroupId ? [c.productGroupId] : []);
                                  skuCount = groupIds.reduce((sum, gid) => sum + (Array.isArray(idsByGroup[gid]) ? idsByGroup[gid].length : 0), 0);
                                }
                                const totalQty = allGroupItems.reduce((s, it) => s + (it.actualQuantity || 0), 0);
                                let currentQty = allGroupItems.reduce((s, it) => s + (it.currentQuantity || 0), 0);
                                const completed = c.status === "completed" || c.status === "cancelled";
                                if (!completed && Array.isArray(c.productGroupIds) && c.productGroupIds.length > 0) {
                                  const countQuantities = incompleteGroupQuantities.get(c.id);
                                  if (countQuantities) {
                                    for (const groupId of c.productGroupIds) {
                                      const groupItems = getGroupItemsByKey(groupItemsMap, groupId);
                                      if (groupItems.length === 0) {
                                        currentQty += countQuantities.get(groupId) || 0;
                                      }
                                    }
                                  }
                                }
                                const qtyText = completed || currentQty > 0 ? `${totalQty}/${currentQty}` : `${totalQty}/-`;
                                return (
                                  <s-text tone="subdued" size="small" style={{ whiteSpace: "nowrap" }}>{skuCount}件 {qtyText}</s-text>
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
                  {pendingCountForModal?.countName || pendingCountForModal?.id || "-"}
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
      <LocationSelectModal
        id={STOCKTAKE_LOCATION_MODAL_ID}
        title="棚卸ロケーションを選択"
        locations={allLocations}
        selectedId={locationGid}
        onSelect={(id) => onLocationChange?.(id || null)}
      />
    </>
  );
}
