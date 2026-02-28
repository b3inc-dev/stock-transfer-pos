import { memo } from "preact/compat";
import { useState, useMemo, useEffect, useCallback, useRef } from "preact/hooks";
import {
  fetchProductsByGroups,
  getCurrentQuantity,
  getCurrentQuantitiesBulk,
  adjustInventoryToActual,
  searchVariants,
  readInventoryCounts,
  readInventoryCountsRaw,
  readInventoryCountById,
  writeInventoryCounts,
  getLocationName,
  getProductGroupName,
  readProductGroups,
  resolveVariantByCode,
  normalizeIdForMatch,
} from "./stocktakeApi.js";
import { fetchSettings } from "./stocktakeApi.js";
import { FixedFooterNavBar } from "../common/FixedFooterNavBar.jsx";
import { getStatusBadgeTone } from "../../stocktakeHelpers.js";
import { logInventoryChangeToApi } from "../../../../common/logInventoryChange.js";

const SHOPIFY = globalThis?.shopify ?? {};
const toast = (m) => SHOPIFY?.toast?.show?.(String(m));

/** 棚卸確定時の在庫変動を共通関数で記録（履歴で種別が正しく表示されるようにする） */

async function logInventoryCountToApi({ locationId, locationName, items, sourceId }) {
  console.log(`[InventoryCountList] logInventoryCountToApi called: items.length=${items?.length || 0}, locationId=${locationId}, sourceId=${sourceId}`);
  if (!items?.length) {
    console.warn(`[InventoryCountList] No items provided, skipping logInventoryCountToApi`);
    return;
  }
  const deltas = items
    .filter((l) => l?.inventoryItemId)
    .map((l) => {
      const actual = Number(l.actualQuantity ?? 0);
      const current = Number(l.currentQuantity ?? 0);
      return {
        inventoryItemId: l.inventoryItemId,
        variantId: l.variantId ?? null,
        sku: l.sku ?? "",
        delta: actual - current,
        quantityAfter: actual,
      };
    })
    .filter((d) => d.delta !== 0);
  console.log(`[InventoryCountList] deltas.length=${deltas.length}, will call logInventoryChangeToApi=${deltas.length > 0}`);
  if (deltas.length === 0) {
    console.warn(`[InventoryCountList] deltas.length is 0, skipping logInventoryChangeToApi call`);
    return;
  }
  console.log(`[InventoryCountList] Calling logInventoryChangeToApi: activity=inventory_count, locationId=${locationId}, deltas.length=${deltas.length}, sourceId=${sourceId}`);
  await logInventoryChangeToApi({
    activity: "inventory_count",
    locationId,
    locationName: locationName || locationId,
    deltas,
    sourceId: sourceId || null,
  });
  console.log(`[InventoryCountList] logInventoryChangeToApi call completed`);
}

const SCAN_QUEUE_KEY = "stock_transfer_pos_inventory_count_scan_queue_v1";
const INVENTORY_COUNT_DRAFT_PREFIX = "stock_transfer_pos_inventory_count_draft_v1";
const INVENTORY_COUNT_DRAFT_LEGACY_KEY = "stock_transfer_pos_inventory_count_draft_v1"; // 単一グループ用（ロス・出庫と同様の単一キー）
const CONFIRM_INVENTORY_COUNT_MODAL_ID = "confirm-inventory-count-modal";

// groupItems のキー照合（GID と数値 ID の混在で取れない不具合対策。管理画面と POS で明細数が一致するようにする）
function getGroupItemsByKey(groupItemsMap, groupId) {
  if (!groupId || !groupItemsMap || typeof groupItemsMap !== "object") return [];
  if (Array.isArray(groupItemsMap[groupId])) return groupItemsMap[groupId];
  const n = normalizeIdForMatch(groupId);
  const key = Object.keys(groupItemsMap).find((k) => normalizeIdForMatch(k) === n);
  return key && Array.isArray(groupItemsMap[key]) ? groupItemsMap[key] : [];
}

/** 管理画面でキャンセルしたグループIDの Set（正規化済み）。完了判定で「キャンセル済み＝完了」とする */
function cancelledGroupIdSet(c) {
  const arr = Array.isArray(c?.cancelledGroupIds) ? c.cancelledGroupIds : [];
  return new Set(arr.map((id) => normalizeIdForMatch(id)));
}

/**
 * ストレージから読んだ count とローカルで組み立てた count をマージする。
 * 親の count が一覧由来で groupItems が無い場合に、ストレージの他グループを上書きで消さないため。
 * 戻り値: マージ済みの count（groupItems = ストレージをベースに locallyBuilt で上書き、status/completedAt は再計算）。
 */
function mergeCountWithStorage(fromStorage, locallyBuilt) {
  if (!fromStorage || !locallyBuilt) return locallyBuilt || fromStorage;
  const mergedGroupItems = {
    ...(fromStorage?.groupItems && typeof fromStorage.groupItems === "object" ? fromStorage.groupItems : {}),
    ...(locallyBuilt?.groupItems && typeof locallyBuilt.groupItems === "object" ? locallyBuilt.groupItems : {}),
  };
  const allIds =
    Array.isArray(locallyBuilt.productGroupIds) && locallyBuilt.productGroupIds.length > 0
      ? locallyBuilt.productGroupIds
      : locallyBuilt.productGroupId
        ? [locallyBuilt.productGroupId]
        : [];
  const cancelledSet = cancelledGroupIdSet(locallyBuilt);
  const allDone =
    allIds.length > 0 &&
    allIds.every((id) => {
      if (cancelledSet.has(normalizeIdForMatch(id))) return true;
      const items = getGroupItemsByKey(mergedGroupItems, id);
      return Array.isArray(items) && items.length > 0;
    });
  const status =
    locallyBuilt.status === "cancelled" ? (allDone ? "completed" : "cancelled") : allDone ? "completed" : "in_progress";
  const completedAt = allDone ? new Date().toISOString() : undefined;
  const out = {
    ...fromStorage,
    ...locallyBuilt,
    groupItems: mergedGroupItems,
    status,
    completedAt,
  };
  // 空白で上書きしない：locallyBuilt が countName/locationId を空白にしている場合は fromStorage の値を維持
  if (fromStorage?.countName != null && String(fromStorage.countName).trim() !== "" && (!out.countName || String(out.countName).trim() === "")) {
    out.countName = fromStorage.countName;
  }
  if (fromStorage?.locationId != null && String(fromStorage.locationId).trim() !== "" && (!out.locationId || String(out.locationId).trim() === "")) {
    out.locationId = fromStorage.locationId;
  }
  if (fromStorage?.locationName != null && String(fromStorage.locationName).trim() !== "" && (!out.locationName || String(out.locationName).trim() === "")) {
    out.locationName = fromStorage.locationName;
  }
  const fromPgIds = Array.isArray(fromStorage?.productGroupIds) && fromStorage.productGroupIds.length > 0;
  const outPgIds = Array.isArray(out.productGroupIds) && out.productGroupIds.length > 0;
  if (fromPgIds && !outPgIds) {
    out.productGroupIds = fromStorage.productGroupIds;
  }
  return out;
}

/**
 * 確定時の「更新後 count」をローカル状態のみから組み立てる（readInventoryCountsRaw をブロックせずに完了表示するため）。
 * 戻り値は write 用の full counts 配列には使わず、当該 count の更新後オブジェクトとして onAfterConfirm と merge に使用する。
 * 整合性: ...count で id, locationId, productGroupIds, cancelledGroupIds 等を維持。バックグラウンドで read → merge(id 一致で差し替え) → write するため他棚卸は上書きされない。
 */
function buildUpdatedCountFromLocalState(count, lines, opts) {
  const { isMultipleMode, targetProductGroupIds, productGroupId } = opts || {};
  const parentGroupItems = count?.groupItems && typeof count.groupItems === "object" ? count.groupItems : {};
  const groupItems = { ...parentGroupItems };
  const currentGroupId = productGroupId || (Array.isArray(targetProductGroupIds) && targetProductGroupIds[0]) || null;
  const allIds =
    Array.isArray(count.productGroupIds) && count.productGroupIds.length > 0
      ? count.productGroupIds
      : count.productGroupId
        ? [count.productGroupId]
        : [];

  if (isMultipleMode && Array.isArray(targetProductGroupIds) && targetProductGroupIds.length > 0) {
    const editableLines = lines.filter((l) => !l.isReadOnly);
    // ✅ 行に productGroupId が無い場合（まとめて読込で全グループが平たんに返る場合）、inventoryItemIdsByGroup で所属グループを判定して最後のグループが完了になるよう割り当てる
    const idsByGroup = count?.inventoryItemIdsByGroup && typeof count.inventoryItemIdsByGroup === "object" ? count.inventoryItemIdsByGroup : null;
    const invIdToGroupId = new Map();
    if (idsByGroup && allIds.length > 0) {
      for (const gid of allIds) {
        const ids = getGroupItemsByKey(idsByGroup, gid);
        const idList = Array.isArray(ids) ? ids : (idsByGroup[gid] || []);
        const arr = Array.isArray(idList) ? idList : [];
        for (const id of arr) {
          const n = normalizeIdForMatch(String(id ?? "").trim());
          if (n && !invIdToGroupId.has(n)) invIdToGroupId.set(n, gid);
        }
      }
    }
    const linesByGroup = new Map();
    for (const l of editableLines) {
      const invIdNorm = normalizeIdForMatch(String(l?.inventoryItemId ?? "").trim());
      const gid = l.productGroupId || (invIdNorm && invIdToGroupId.get(invIdNorm)) || targetProductGroupIds[0];
      if (!gid) continue;
      if (!linesByGroup.has(gid)) linesByGroup.set(gid, []);
      linesByGroup.get(gid).push(l);
    }
    for (const [groupId, groupLines] of linesByGroup.entries()) {
      const entry = groupLines.map((l) => ({
        inventoryItemId: l.inventoryItemId,
        variantId: l.variantId,
        sku: l.sku ?? "",
        barcode: l.barcode ?? "",
        title: [l.productTitle, l.variantTitle].filter(Boolean).join(" / ") || l.sku || "-",
        imageUrl: l.imageUrl ?? "",
        currentQuantity: Number(l.currentQuantity ?? 0),
        actualQuantity: Number(l.actualQuantity ?? 0),
        delta: Number(l.actualQuantity ?? 0) - Number(l.currentQuantity ?? 0),
        isExtra: Boolean(l.isExtra),
      }));
      groupItems[groupId] = entry;
    }
  } else if (currentGroupId) {
    const linesSnapshot = lines.map((l) => ({
      inventoryItemId: l.inventoryItemId,
      variantId: l.variantId,
      sku: l.sku ?? "",
      barcode: l.barcode ?? "",
      productTitle: l.productTitle ?? "",
      variantTitle: l.variantTitle ?? "",
      imageUrl: l.imageUrl ?? "",
      currentQuantity: Number(l.currentQuantity ?? 0),
      actualQuantity: Number(l.actualQuantity ?? 0),
      isExtra: Boolean(l.isExtra),
    }));
    const entry = linesSnapshot.map((l) => ({
      inventoryItemId: l.inventoryItemId,
      variantId: l.variantId,
      sku: l.sku,
      barcode: l.barcode ?? "",
      title: [l.productTitle, l.variantTitle].filter(Boolean).join(" / ") || l.sku || "-",
      imageUrl: l.imageUrl ?? "",
      currentQuantity: l.currentQuantity,
      actualQuantity: l.actualQuantity,
      isExtra: l.isExtra,
      delta: l.actualQuantity - l.currentQuantity,
    }));
    groupItems[currentGroupId] = entry;
  }

  const cancelledSet = cancelledGroupIdSet(count);
  const allDone =
    allIds.length > 0 &&
    allIds.every((id) => {
      if (cancelledSet.has(normalizeIdForMatch(id))) return true;
      const items = getGroupItemsByKey(groupItems, id);
      return Array.isArray(items) && items.length > 0;
    });
  const newStatus =
    count.status === "cancelled" ? (allDone ? "completed" : "cancelled") : allDone ? "completed" : "in_progress";

  let itemsForCount;
  if (isMultipleMode && Array.isArray(targetProductGroupIds) && targetProductGroupIds.length > 0) {
    const allItems = lines.filter((l) => {
      const gid = l.productGroupId || targetProductGroupIds[0];
      return gid && targetProductGroupIds.includes(gid);
    });
    itemsForCount = allItems.map((l) => ({
      inventoryItemId: l.inventoryItemId,
      variantId: l.variantId,
      sku: l.sku ?? "",
      barcode: l.barcode ?? "",
      title: [l.productTitle, l.variantTitle].filter(Boolean).join(" / ") || l.sku || "-",
      currentQuantity: Number(l.currentQuantity ?? 0),
      actualQuantity: Number(l.actualQuantity ?? 0),
      delta: Number(l.actualQuantity ?? 0) - Number(l.currentQuantity ?? 0),
      isExtra: Boolean(l.isExtra),
    }));
  } else {
    const entry = getGroupItemsByKey(groupItems, currentGroupId);
    itemsForCount =
      entry.length > 0
        ? entry
        : lines.map((l) => ({
            inventoryItemId: l.inventoryItemId,
            variantId: l.variantId,
            sku: l.sku ?? "",
            barcode: l.barcode ?? "",
            title: [l.productTitle, l.variantTitle].filter(Boolean).join(" / ") || l.sku || "-",
            currentQuantity: Number(l.currentQuantity ?? 0),
            actualQuantity: Number(l.actualQuantity ?? 0),
            delta: Number(l.actualQuantity ?? 0) - Number(l.currentQuantity ?? 0),
            isExtra: Boolean(l.isExtra),
          }));
  }

  return {
    ...count,
    groupItems,
    status: newStatus,
    completedAt: allDone ? new Date().toISOString() : undefined,
    items: itemsForCount,
  };
}

// 複数商品グループ時のみ使用：商品グループごとに別キーで下書きを管理（入庫の inboundDraftKey と同様）
function inventoryCountDraftKey({ countId, locationId, productGroupId }) {
  const c = String(countId || "").trim();
  const l = String(locationId || "").trim();
  const g = String(productGroupId || "").trim() || "_default";
  return `${INVENTORY_COUNT_DRAFT_PREFIX}:${c}:${l}:${g}`;
}

async function clearAllInventoryCountDraftsForCount({ countId, locationId, productGroupIds }) {
  const ids = Array.isArray(productGroupIds) ? productGroupIds : [];
  const c = String(countId || "").trim();
  const l = String(locationId || "").trim();
  try {
    if (!SHOPIFY?.storage?.delete) return;
    const keys =
      c && l && ids.length > 1
        ? ids.map((gid) => inventoryCountDraftKey({ countId: c, locationId: l, productGroupId: gid }))
        : [];
    for (const key of keys) {
      await SHOPIFY.storage.delete(key);
    }
    // ✅ 単一グループの棚卸のみ LEGACY_KEY を使用するため、複数グループ確定時に LEGACY_KEY を削除すると
    // 別の棚卸（単一グループ）の下書きが消える不具合になる。確定対象が単一グループのときだけ削除する。
    if (ids.length <= 1) {
      await SHOPIFY.storage.delete(INVENTORY_COUNT_DRAFT_LEGACY_KEY);
    }
  } catch (e) {
    console.error("Failed to clear inventory count drafts:", e);
  }
}

// スキャンキュー管理
function normalizeScanQueueObj_(raw) {
  if (Array.isArray(raw)) {
    const items = raw
      .map((x) => {
        if (typeof x === "string") return x.trim();
        return String(x?.v || "").trim();
      })
      .filter(Boolean);
    const lastV = items[items.length - 1] || "";
    return { items, lastV, lastT: Date.now(), updatedAt: Date.now() };
  }
  if (raw && typeof raw === "object") {
    const items = Array.isArray(raw.items)
      ? raw.items.map((s) => String(s || "").trim()).filter(Boolean)
      : [];
    return {
      items,
      lastV: String(raw.lastV || items[items.length - 1] || ""),
      lastT: Number(raw.lastT || 0),
      updatedAt: Number(raw.updatedAt || 0),
    };
  }
  return { items: [], lastV: "", lastT: 0, updatedAt: 0 };
}

async function pushScanToQueue_(value) {
  const storage = SHOPIFY?.storage;
  if (!storage?.get || !storage?.set) return;
  const v = String(value || "").trim();
  if (!v) return;
  try {
    const now = Date.now();
    const cur = normalizeScanQueueObj_(await storage.get(SCAN_QUEUE_KEY));
    if (cur.lastV === v && Math.abs(now - Number(cur.lastT || 0)) < 350) return;
    const nextItems = [...cur.items, v];
    const MAX_ITEMS = 5000;
    const trimmed = nextItems.length > MAX_ITEMS ? nextItems.slice(nextItems.length - MAX_ITEMS) : nextItems;
    await storage.set(SCAN_QUEUE_KEY, {
      items: trimmed,
      lastV: v,
      lastT: now,
      updatedAt: now,
    });
  } catch (e) {
    console.error("pushScanToQueue_ failed", e);
  }
}

// ✅ 予定外リスト判定用：inventoryItemId を正規化（GID・数値どちらでも同一とみなす）
function normalizeInventoryItemIdForExtra(id) {
  const s = String(id ?? "").trim();
  if (!s) return "";
  const m = s.match(/InventoryItem\/(\d+)$/) || s.match(/^(\d+)$/);
  return m ? m[1] : s;
}

// Debounceフック
function useDebounce(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function isMinimalCount(c) {
  return c && typeof c === "object" && c.id && !(c.groupItems && typeof c.groupItems === "object");
}

export function InventoryCountList({
  countId,
  count,
  productGroupId,
  productGroupIds,
  productGroupMode,
  readOnly: readOnlyProp = false,
  onBack,
  onAfterConfirm,
  setHeader,
  setFooter,
  locationGid,
  liteMode: liteModeProp,
  onToggleLiteMode,
}) {
  const [lines, setLines] = useState([]);
  const [loading, setLoading] = useState(false);
  const [fullCount, setFullCount] = useState(null);
  const [countLoading, setCountLoading] = useState(false);
  const [countError, setCountError] = useState("");
  const effectiveCount = fullCount ?? (isMinimalCount(count) ? null : count);
  const [hasMoreProducts, setHasMoreProducts] = useState(false); // ✅ さらに読み込む用
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false); // ✅ 在庫更新用の別状態（出庫リストと同じ方式）
  const [submitting, setSubmitting] = useState(false);
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState([]);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [searchPageInfo, setSearchPageInfo] = useState({ hasNextPage: false, endCursor: null });
  const [loadingMoreSearch, setLoadingMoreSearch] = useState(false);
  const [locationName, setLocationName] = useState("");
  const [productGroupName, setProductGroupName] = useState("");
  const [productGroupNames, setProductGroupNames] = useState(new Map());
  const scanQueueRef = useRef([]);
  const scanProcessingRef = useRef(false);
  const draftLoadedRef = useRef(false);
  const lastDraftCountIdRef = useRef(null); // ✅ 前回下書きを読み込んだcount.idを記録
  const lastDraftLocationIdRef = useRef(null); // ✅ 前回下書きを読み込んだlocationIdを記録
  const lastDraftProductGroupIdRef = useRef(null); // ✅ 単一グループモード用：前回読み込んだproductGroupIdを記録
  const isLoadingProductsRef = useRef(false); // ✅ loadProducts実行中フラグ（自動保存をスキップするため）
  const hideConfirmModalRef = useRef(null);
  const initialInventoryItemIdsRef = useRef(new Set()); // ✅ 初期表示の商品IDを保持（予定外リスト判定用）
  const linesRef = useRef([]); // ✅ 入庫の rowsRef/extrasRef と同様：検索追加時の既存チェック用
  const readOnlyRef = useRef(false);
  const toastReadOnlyOnceRef = useRef(false);
  const [addQtyById, setAddQtyById] = useState({}); // ✅ 入庫と同様：候補ごとの追加済み数量表示用
  // ✅ まとめて表示：グループごと読込ボタンでどのグループを読み込み中か（読込中は「読込中...」表示）
  const [loadingGroupId, setLoadingGroupId] = useState(null);
  const loadingGroupIdRef = useRef(null); // ✅ 二重発火防止（onClick/onPress両方で呼ばれる場合）
  const loadingMoreRef = useRef(false); // ✅ さらに読み込むの二重発火防止（入庫・出庫と同様）
  const hasMoreProductsRef = useRef(false); // ✅ タップ時に最新の hasMoreProducts を参照（スタレ閉じ込め防止）
  const collectionPageInfoRef = useRef(null); // ✅ コレクション経路の「さらに読み込む」用（前回の pageInfo を after で渡す）
  const backgroundInventoryLoadIdRef = useRef(0); // ✅ リスト表示後の在庫バックグラウンド読込で、同一ロードかどうか判定（画面遷移・再読込時は更新しない）
  const loadCompletedRef = useRef(false); // ✅ 初回ロード完了まで「商品がありません」を出さない（コレクション→CSV の順で0件になる瞬間のチラつき防止）

  const denyEdit = useCallback(() => {
    if (!toastReadOnlyOnceRef.current) {
      toast("この棚卸は処理済みのため編集できません");
      toastReadOnlyOnceRef.current = true;
    }
  }, []);

  // ✅ メニュー画面のprefsから初期値を読み込む（親から渡されていない場合のフォールバック）
  const loadInitialLiteMode = () => {
    try {
      const raw = localStorage.getItem("stock_transfer_pos_ui_prefs_v1");
      const p = raw ? JSON.parse(raw) : null;
      return p && typeof p === "object" && p.liteMode === true;
    } catch {
      return false;
    }
  };
  const [liteModeLocal, setLiteModeLocal] = useState(loadInitialLiteMode);
  // ✅ 親から渡されたliteModeを優先（コンディション画面のON/OFFが商品リストに引き継がれる・ロスと同様）
  const liteMode = liteModeProp !== undefined && liteModeProp !== null ? !!liteModeProp : liteModeLocal;
  const showImages = !liteMode; // ✅ 軽量モードがOFFの時だけ画像表示

  const handleToggleLiteMode = useCallback(() => {
    if (typeof onToggleLiteMode === "function") {
      onToggleLiteMode();
    } else {
      setLiteModeLocal((prev) => !prev);
    }
  }, [onToggleLiteMode]);

  // ✅ アプリ表示件数設定（履歴/商品/検索）
  const [settings, setSettings] = useState(null);
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const s = await fetchSettings();
        if (mounted) setSettings(s);
      } catch (e) {
        console.error("[InventoryCountList] fetchSettings error:", e);
        if (mounted)
          setSettings({
            version: 1,
            carriers: [],
            outbound: { historyInitialLimit: 100 },
            productList: { initialLimit: 250 },
            searchList: { initialLimit: 50 },
          });
      }
    })();
    return () => { mounted = false; };
  }, []);

  // ✅ さらに読み込む：タップ時に最新の hasMoreProducts を参照するため ref を同期（入庫・出庫と同様）
  useEffect(() => {
    hasMoreProductsRef.current = hasMoreProducts;
  }, [hasMoreProducts]);
  
  // ✅ 一覧タップ後：最小情報のときだけ棚卸1件をAPI取得（商品グループタップ→商品リスト読み込み）
  useEffect(() => {
    if (!count?.id) {
      setFullCount(null);
      setCountLoading(false);
      setCountError("");
      return;
    }
    if (!isMinimalCount(count)) {
      setFullCount(null);
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

  // ✅ prefsの変更を監視（親から渡されていない場合のローカル同期）
  useEffect(() => {
    if (liteModeProp !== undefined && liteModeProp !== null) return;
    const checkPrefs = () => {
      try {
        const raw = localStorage.getItem("stock_transfer_pos_ui_prefs_v1");
        const p = raw ? JSON.parse(raw) : null;
        const newLiteMode = p && typeof p === "object" && p.liteMode === true;
        setLiteModeLocal((prev) => (prev !== newLiteMode ? newLiteMode : prev));
      } catch {}
    };
    const interval = setInterval(checkPrefs, 500);
    return () => clearInterval(interval);
  }, [liteModeProp]);

  const isMultipleMode = productGroupMode === "multiple" && Array.isArray(productGroupIds) && productGroupIds.length > 1;
  // productGroupIdsを優先し、なければproductGroupIdを使用、それもなければcountオブジェクトから取得
  const targetProductGroupIds = useMemo(() => {
    if (Array.isArray(productGroupIds) && productGroupIds.length > 0) {
      return productGroupIds;
    }
    if (productGroupId) {
      return [productGroupId];
    }
    if (Array.isArray(count?.productGroupIds) && count.productGroupIds.length > 0) {
      return count.productGroupIds;
    }
    return [];
  }, [productGroupIds, productGroupId, count?.productGroupIds]);

  // ✅ readOnly判定：readOnlyPropがtrue、またはcount.statusが"completed"、または選択したグループが完了している
  // ✅ グループごとに表示する場合：選択したグループが完了している場合もreadOnlyにする
  // ✅ targetProductGroupIdsの定義後に移動（初期化前アクセスエラーを防ぐ）
  // ✅ 注意：後方互換性の処理はloadProducts内で行われるため、ここでは簡易的な判定のみ
  // ✅ 実際のisReadOnlyはloadProducts関数内で計算され、useStateで管理される
  const [isReadOnlyState, setIsReadOnlyState] = useState(false);
  
  useEffect(() => {
    readOnlyRef.current = !!isReadOnlyState;
    if (!isReadOnlyState) toastReadOnlyOnceRef.current = false;
  }, [isReadOnlyState]);
  
  // ✅ 初期値の計算（簡易判定）
  const currentGroupIdInitial = productGroupId || (targetProductGroupIds && targetProductGroupIds.length > 0 ? targetProductGroupIds[0] : null);
  const groupItemsMapForReadOnlyInitial = count?.groupItems && typeof count.groupItems === "object" ? count.groupItems : {};
  let groupItemsForCurrentGroupReadOnlyInitial = getGroupItemsByKey(groupItemsMapForReadOnlyInitial, currentGroupIdInitial);
  // ✅ 後方互換性：groupItemsがない場合、itemsフィールドから該当グループの商品をフィルタリング（簡易判定）
  const countItemsLegacyForReadOnlyInitial = Array.isArray(count?.items) ? count.items : [];
  if (groupItemsForCurrentGroupReadOnlyInitial.length === 0 && countItemsLegacyForReadOnlyInitial.length > 0 && currentGroupIdInitial) {
    // 単一グループの場合、itemsフィールドにデータがあれば完了と判定（簡易判定）
    const isSingleGroup = targetProductGroupIds.length === 1;
    if (isSingleGroup) {
      groupItemsForCurrentGroupReadOnlyInitial = countItemsLegacyForReadOnlyInitial;
    }
  }
  const cancelledSetInitial = cancelledGroupIdSet(count);
  const isCurrentGroupCancelledInitial = currentGroupIdInitial && cancelledSetInitial.has(normalizeIdForMatch(currentGroupIdInitial));
  const isCurrentGroupCompletedInitial = groupItemsForCurrentGroupReadOnlyInitial.length > 0 || isCurrentGroupCancelledInitial;
  const isReadOnlyInitial = readOnlyProp || count?.status === "completed" || count?.status === "cancelled" || isCurrentGroupCompletedInitial;
  
  // ✅ 初期値を設定
  useEffect(() => {
    setIsReadOnlyState(isReadOnlyInitial);
  }, [isReadOnlyInitial]);
  
  // ✅ 実際のisReadOnlyはloadProducts関数内で更新される
  const isReadOnly = isReadOnlyState;

  // ロケーション名と商品グループ名を取得（管理画面で保存済みの名前を先に表示し、ID→名前の切り替えを防ぐ）
  useEffect(() => {
    // ✅ 管理画面で保存済みの名前を即座にセット
    if (productGroupId && count?.productGroupName) {
      setProductGroupName(count.productGroupName);
    }
    // ✅ 商品グループ名 Map のキーは正規化キーで統一（GID と数値の混在でずれないようにする）
    if (isMultipleMode && Array.isArray(count?.productGroupNames) && Array.isArray(count?.productGroupIds)) {
      const initialMap = new Map();
      count.productGroupIds.forEach((id, i) => {
        const n = count.productGroupNames[i];
        if (n) initialMap.set(normalizeIdForMatch(id), n);
      });
      if (initialMap.size > 0) setProductGroupNames(initialMap);
    }
    const loadNames = async () => {
      if (count?.locationId) {
        const name = await getLocationName(count.locationId);
        setLocationName(name || count.locationName || "");
      }
      if (productGroupId && !count?.productGroupName) {
        const name = await getProductGroupName(productGroupId);
        setProductGroupName(name || "");
      }
      if (isMultipleMode && targetProductGroupIds.length > 0) {
        const groupMap = new Map();
        for (const id of targetProductGroupIds) {
          const normalizedId = normalizeIdForMatch(id);
          const fromCount = Array.isArray(count?.productGroupNames) && count?.productGroupIds
            ? count.productGroupNames[count.productGroupIds.findIndex((pid) => normalizeIdForMatch(pid) === normalizedId)]
            : null;
          const name = fromCount || (await getProductGroupName(id));
          if (name) groupMap.set(normalizedId, name);
        }
        setProductGroupNames(groupMap);
      }
    };
    loadNames();
  }, [count, productGroupId, isMultipleMode, targetProductGroupIds]);

  // 商品リストを読み込む（effectiveCount: 一覧タップ後はAPI取得したフルデータ）
  const loadProducts = useCallback(async () => {
    const c = effectiveCount ?? count;
    isLoadingProductsRef.current = true; // ✅ loadProducts開始時に即座にフラグを立てる（自動保存をスキップするため）
    if (!c || !c.locationId) {
      isLoadingProductsRef.current = false; // ✅ 早期リターン時はフラグを下ろす
      console.log("[InventoryCountList] loadProducts skipped: missing count or locationId", { count: c, locationId: c?.locationId });
      return;
    }
    if (targetProductGroupIds.length === 0) {
      isLoadingProductsRef.current = false; // ✅ 早期リターン時はフラグを下ろす
      console.log("[InventoryCountList] loadProducts skipped: targetProductGroupIds is empty", { 
        productGroupIds, 
        productGroupId, 
        countProductGroupIds: c?.productGroupIds,
        targetProductGroupIds 
      });
      return;
    }
    setHasMoreProducts(false); // ✅ 初回読み込み時はリセット（メイン経路で上書き）
    loadCompletedRef.current = false; // ✅ このロードが終わるまで「商品がありません」を出さない

    // ✅ count.id / locationId / productGroupId（単一モード）が変わった場合は、draftLoadedRefをリセット
    const currentCountId = String(c.id || "").trim();
    const currentLocationId = String(c.locationId || "").trim();
    const currentGroupId = productGroupId || (targetProductGroupIds?.[0] || null);
    if (
      lastDraftCountIdRef.current !== currentCountId ||
      lastDraftLocationIdRef.current !== currentLocationId ||
      (!isMultipleMode && lastDraftProductGroupIdRef.current !== currentGroupId)
    ) {
      draftLoadedRef.current = false;
      lastDraftCountIdRef.current = currentCountId;
      lastDraftLocationIdRef.current = currentLocationId;
      if (!isMultipleMode) lastDraftProductGroupIdRef.current = currentGroupId;
    }
    const groupItemsMap = c?.groupItems && typeof c.groupItems === "object" ? c.groupItems : {};
    // ✅ 完了判定：groupItemsMap[currentGroupId]が存在し、かつ配列の長さが0より大きい場合に完了と判定
    // ✅ キー照合は getGroupItemsByKey で正規化（GID と数値の混在で取れない不具合対策）
    let groupItemsForCurrentGroup = getGroupItemsByKey(groupItemsMap, currentGroupId);
    const countItemsLegacy = Array.isArray(c?.items) ? c.items : [];
    // ✅ 後方互換性：groupItemsがない場合、itemsフィールドから該当グループの商品をフィルタリング
    if (groupItemsForCurrentGroup.length === 0 && countItemsLegacy.length > 0 && currentGroupId) {
      try {
        const productFirst = Math.max(1, Math.min(250, Number(settings?.productList?.initialLimit ?? 250)));
        const productsRaw = await fetchProductsByGroups([currentGroupId], c.locationId, {
          productFirst,
          filterByInventoryLevel: false,
          includeImages: false,
          inventoryItemIdsByGroup: c?.inventoryItemIdsByGroup || null, // ✅ 生成時の商品リストを使用
        });
        const products = Array.isArray(productsRaw) ? productsRaw : (productsRaw?.products ?? []);
        const productInventoryItemIds = new Set(
          products.map((p) => String(p.inventoryItemId || "").trim()).filter(Boolean)
        );
        groupItemsForCurrentGroup = countItemsLegacy.filter((item) => {
          const itemId = String(item?.inventoryItemId || "").trim();
          return productInventoryItemIds.has(itemId);
        });
      } catch (e) {
        console.error(`Failed to filter legacy items for group ${currentGroupId}:`, e);
      }
    }
    const storedItemsFromGroup = groupItemsForCurrentGroup.length > 0 ? groupItemsForCurrentGroup : null;
    
    // ✅ 複数商品グループがある場合はgroupItemsを優先、1つの商品グループのみの場合はitemsフィールドを後方互換性として使用
    // ✅ ただし、単一グループモードでgroupItemsにデータがある場合は、必ずgroupItemsを優先（選択したグループのデータのみを表示）
    const isMultipleGroups = targetProductGroupIds.length > 1 || (Array.isArray(c?.productGroupIds) && c.productGroupIds.length > 1);
    // ✅ 複数商品グループを持つ棚卸IDかどうか（下書きキーは「表示中のグループ数」ではなく「棚卸IDが持つグループ数」で判定）
    const countHasMultipleGroups = Array.isArray(c?.productGroupIds) && c.productGroupIds.length > 1;
    // ✅ グループごとに表示する場合：選択したグループのデータのみを表示（storedItemsFromGroupを優先）
    // ✅ 単一グループモードでgroupItemsにデータがない場合のみ、itemsフィールドを後方互換性として使用
    const storedItemsFromItems = !isMultipleGroups && !storedItemsFromGroup && Array.isArray(c?.items) && c.items.length > 0 ? c.items : null;
    // ✅ グループごとに表示する場合：選択したグループのデータのみを表示（storedItemsFromGroupを優先）
    const storedItems = storedItemsFromGroup || storedItemsFromItems;

    // ✅ readOnly判定：readOnlyPropがtrue、または選択したグループが完了/キャンセル、または棚卸全体が完了/キャンセル（管理画面と連動）
    // ✅ 完了判定：groupItemsMap[currentGroupId]が存在し、かつ配列の長さが0より大きい場合に完了と判定。キャンセル済みグループは cancelledGroupIds で判定
    const isGroupCompleted = storedItemsFromGroup !== null && groupItemsForCurrentGroup.length > 0;
    const cancelledSetForReadOnly = cancelledGroupIdSet(c);
    const isGroupCancelled = currentGroupId && cancelledSetForReadOnly.has(normalizeIdForMatch(currentGroupId));
    const isReadOnlyCalculated = readOnlyProp || isGroupCompleted || isGroupCancelled || c?.status === "completed" || c?.status === "cancelled";
    
    // ✅ まとめて表示モードの場合は、最初の処理ブロックをスキップしてまとめて表示モードの処理に進む
    // ✅ まとめて表示モードの場合は、isReadOnlyStateをまとめて表示モードの処理内で設定する
    if (!isMultipleMode) {
      // ✅ 単一グループモードの場合は、従来通りisReadOnlyCalculatedを使用
      setIsReadOnlyState(isReadOnlyCalculated);
    }
    const isReadOnly = isMultipleMode ? false : isReadOnlyCalculated; // ✅ まとめて表示モードの場合は一時的にfalse（後で適切に設定される）

    if (isReadOnly && storedItems && !isMultipleMode) {
      setLoading(true);
      try {
        // ✅ 完了済みの商品リスト：在庫は棚卸時の在庫数（currentQuantity）、実数は確定した在庫数（actualQuantity）を表示
        // ✅ 画像URLを取得するため、商品情報を取得
        const productFirst = Math.max(1, Math.min(250, Number(settings?.productList?.initialLimit ?? 250)));
        const productsRaw = await fetchProductsByGroups([currentGroupId], c.locationId, {
          productFirst,
          filterByInventoryLevel: false,
          includeImages: showImages && !liteMode,
          inventoryItemIdsByGroup: c?.inventoryItemIdsByGroup || null, // ✅ 生成時の商品リストを使用
        });
        const products = Array.isArray(productsRaw) ? productsRaw : (productsRaw?.products ?? []);
        const productMap = new Map();
        products.forEach((p) => {
          if (p.inventoryItemId) {
            productMap.set(String(p.inventoryItemId).trim(), p);
          }
        });
        
        // ✅ 予定外商品の画像URLを取得するため、Promise.allで並列処理
        const linesFromGroup = await Promise.all(
          storedItems.map(async (it, i) => {
            const t = (it?.title || it?.sku || "-").split(" / ");
            const productTitle = t[0] || "";
            const variantTitle = t[1] || "";
            // ✅ 在庫は棚卸時に表示していた在庫数（currentQuantity）、実数はカウントして確定した在庫数（actualQuantity）
            const storedCurrentQty = Number(it?.currentQuantity ?? 0);
            const storedActualQty = Number(it?.actualQuantity ?? 0);
            const inventoryItemIdStr = String(it?.inventoryItemId || "").trim();
            const product = productMap.get(inventoryItemIdStr);
            let imageUrl = product?.imageUrl ?? "";
            
            // ✅ 予定外商品で画像URLが取得できていない場合、groupItemsに保存されている画像URLを使用
            const isExtra = Boolean(it?.isExtra);
            if (isExtra && !imageUrl && it?.imageUrl) {
              imageUrl = String(it.imageUrl);
            }
            
            // ✅ 予定外商品で画像URLがまだ取得できていない場合、resolveVariantByCodeで取得を試みる
            if (isExtra && !imageUrl && showImages && !liteMode) {
              const code = it?.barcode || it?.sku || "";
              if (code) {
                try {
                  const resolved = await resolveVariantByCode(code, { includeImages: true });
                  if (resolved?.imageUrl) {
                    imageUrl = resolved.imageUrl;
                  }
                } catch (e) {
                  console.error(`Failed to resolve variant image for extra item ${code}:`, e);
                }
              }
            }
            
            return {
              id: String(it?.id ?? `ro-${Date.now()}-${i}`),
              variantId: it?.variantId ?? null,
              inventoryItemId: it?.inventoryItemId ?? null,
              productTitle,
              variantTitle,
              sku: String(it?.sku ?? ""),
              barcode: String(it?.barcode ?? ""),
              imageUrl, // ✅ 画像URLを取得（予定外商品の場合は追加で取得を試みる）
              // ✅ 在庫は棚卸時に表示していた在庫数（currentQuantity）、実数はカウントして確定した在庫数（actualQuantity）
              currentQuantity: storedCurrentQty,
              actualQuantity: storedActualQty,
              isReadOnly: true, // ✅ 完了済みは読み取り専用
              isExtra, // ✅ 予定外商品フラグを保持（予定外リスト分離表示用）
              productGroupId: currentGroupId, // ✅ どのグループに属するか記録
            };
          })
        );
        setLines(linesFromGroup);
        // ✅ 予定外商品を除外して初期表示の商品IDを記録（予定外リスト判定用）
        initialInventoryItemIdsRef.current = new Set(
          linesFromGroup.filter((l) => !l.isExtra).map((l) => normalizeInventoryItemIdForExtra(l.inventoryItemId)).filter(Boolean)
        );
      } catch (e) {
        console.error(`Failed to load product images for completed group ${currentGroupId}:`, e);
        // ✅ エラーが発生した場合でも、画像なしで商品リストを表示
        const linesFromGroup = storedItems.map((it, i) => {
          const t = (it?.title || it?.sku || "-").split(" / ");
          const productTitle = t[0] || "";
          const variantTitle = t[1] || "";
          const storedCurrentQty = Number(it?.currentQuantity ?? 0);
          const storedActualQty = Number(it?.actualQuantity ?? 0);
          return {
            id: String(it?.id ?? `ro-${Date.now()}-${i}`),
            variantId: it?.variantId ?? null,
            inventoryItemId: it?.inventoryItemId ?? null,
            productTitle,
            variantTitle,
            sku: String(it?.sku ?? ""),
            barcode: String(it?.barcode ?? ""),
            imageUrl: "",
            currentQuantity: storedCurrentQty,
            actualQuantity: storedActualQty,
            isReadOnly: true,
            isExtra: Boolean(it?.isExtra), // ✅ 予定外商品フラグを保持（予定外リスト分離表示用）
            productGroupId: currentGroupId,
          };
        });
        setLines(linesFromGroup);
        // ✅ 予定外商品を除外して初期表示の商品IDを記録（予定外リスト判定用）
        initialInventoryItemIdsRef.current = new Set(
          linesFromGroup.filter((l) => !l.isExtra).map((l) => normalizeInventoryItemIdForExtra(l.inventoryItemId)).filter(Boolean)
        );
      } finally {
        setLoading(false);
      }
      return;
    }

    console.log("[InventoryCountList] loadProducts starting", { 
      locationId: c.locationId, 
      targetProductGroupIds,
      isMultipleMode
    });
    // ✅ isLoadingProductsRef.currentは既にloadProducts関数の最初でtrueに設定済み
    setLoading(true);
    try {
      // ✅ まとめて表示モードの場合：各商品グループごとに完了済み/未完了を区別して処理
      if (isMultipleMode) {
        // ✅ 完了/キャンセル済みの棚卸は下書きを復元しない（管理画面で確定・キャンセルされた場合はAPIの groupItems を表示する）
        const isCountCompletedOrCancelled = c?.status === "completed" || c?.status === "cancelled";
        let draftLines = [];
        if (!isCountCompletedOrCancelled) {
          try {
            if (SHOPIFY?.storage?.get && targetProductGroupIds.length > 0) {
            const currentCountId = String(c.id || "").trim();
            const currentLocationId = String(c.locationId || "").trim();
            const allGroupDrafts = await Promise.all(
              targetProductGroupIds.map(async (groupId) => {
                const key = inventoryCountDraftKey({
                  countId: currentCountId,
                  locationId: currentLocationId,
                  productGroupId: groupId,
                });
                const got = await SHOPIFY.storage.get(key);
                const raw = (got && typeof got === "object" ? (got[key] ?? got) : null) || null;
                if (!raw) return [];
                const savedCountId = String(raw.countId || "").trim();
                const savedLocationId = String(raw.locationId || "").trim();
                const norm = (v) => (String(v || "").split("/").pop() || "").trim() || String(v || "").trim();
                const countMatch = savedCountId === currentCountId || norm(savedCountId) === norm(currentCountId);
                const locMatch = savedLocationId === currentLocationId || norm(savedLocationId) === norm(currentLocationId);
                if (!countMatch || !locMatch) return [];
                const lines = Array.isArray(raw.lines) ? raw.lines : [];
                return lines.map((l, i) => ({
                  id: String(l?.id ?? `${Date.now()}-${i}-${groupId}`),
                  variantId: l?.variantId ?? null,
                  inventoryItemId: l?.inventoryItemId ?? null,
                  productTitle: String(l?.productTitle || ""),
                  variantTitle: String(l?.variantTitle || ""),
                  sku: String(l?.sku || ""),
                  barcode: String(l?.barcode || ""),
                  imageUrl: String(l?.imageUrl || ""),
                  currentQuantity: Number.isFinite(Number(l?.currentQuantity)) ? Number(l.currentQuantity) : 0,
                  actualQuantity: Number.isFinite(Number(l?.actualQuantity)) ? Number(l.actualQuantity) : 0,
                  isReadOnly: Boolean(l?.isReadOnly),
                  isExtra: Boolean(l?.isExtra),
                  productGroupId: groupId,
                })).filter((l) => l.variantId || l.inventoryItemId);
              })
            );
            draftLines = allGroupDrafts.flat();
            if (draftLines.length > 0) {
              lastDraftCountIdRef.current = currentCountId;
              lastDraftLocationIdRef.current = currentLocationId;
              toast("下書きを復元しました");
            }
          }
          } catch (e) {
            console.error("Failed to load draft:", e);
          }
        }
        
        // ✅ まとめて表示：完了/キャンセル済みグループはAPIの groupItems を優先し、未完了グループのみ下書きを使う（キャンセル・完了が正しく反映されるようにする）
        const draftLinesByGroup = new Map();
        if (draftLines.length > 0) {
          for (const line of draftLines) {
            const gid = line?.productGroupId;
            if (!gid) continue;
            const norm = normalizeIdForMatch(gid);
            if (!draftLinesByGroup.has(norm)) draftLinesByGroup.set(norm, []);
            draftLinesByGroup.get(norm).push(line);
          }
          lastDraftCountIdRef.current = String(c.id || "").trim();
          lastDraftLocationIdRef.current = String(c.locationId || "").trim();
          toast("下書きを復元しました");
        }
        
        const allLines = [];
        const groupItemsMap = c?.groupItems && typeof c.groupItems === "object" ? c.groupItems : {};
        const cancelledSet = cancelledGroupIdSet(c);
        // ✅ 後方互換性：groupItemsがない場合、itemsフィールドから該当グループの商品をフィルタリング
        const countItemsLegacy = Array.isArray(c?.items) ? c.items : [];
        // ✅ まとめて表示で全グループが同じスナップショットを参照するよう、先に1回だけ取得して渡す（初回の readProductGroups 失敗・遅延で一部グループが0件になるのを防ぐ）
        let cachedProductGroups = [];
        try {
          cachedProductGroups = await readProductGroups();
        } catch (e) {
          console.error("[InventoryCountList] readProductGroups failed (will retry per group):", e);
        }
        const fetchOptsBase = {
          inventoryItemIdsByGroup: c?.inventoryItemIdsByGroup || null,
          ...(cachedProductGroups.length > 0 ? { cachedProductGroups } : {}),
        };
        
        // 各商品グループごとに処理
        for (const groupId of targetProductGroupIds) {
          const groupName = productGroupNames.get(normalizeIdForMatch(groupId)) || groupId;
          // ✅ 完了判定：groupItemsMap[groupId]が存在し、かつ配列の長さが0より大きい場合に完了と判定
          // ✅ 確実に判定するため、groupIdとgroupItemsMapの両方をチェック
          // ✅ 後方互換性：groupItemsがない場合、itemsフィールドから該当グループの商品をフィルタリング（InventoryCountProductGroupSelectionと同じロジック）
          let groupItemsForGroup = getGroupItemsByKey(groupItemsMap, groupId);
          if (groupItemsForGroup.length === 0 && countItemsLegacy.length > 0) {
            // ✅ 後方互換性：groupItemsがない場合、itemsフィールドから該当グループの商品をフィルタリング
            // 商品グループの商品リストを取得してフィルタリング（inventoryItemIdsByGroupも渡してまとめて表示で全グループ取得できるようにする）
            try {
              const productFirst = Math.max(1, Math.min(250, Number(settings?.productList?.initialLimit ?? 250)));
              const productsRaw = await fetchProductsByGroups([groupId], c.locationId, {
                productFirst,
                limit: 2000,
                filterByInventoryLevel: false,
                includeImages: false,
                ...fetchOptsBase,
              });
              const products = Array.isArray(productsRaw) ? productsRaw : (productsRaw?.products ?? []);
              const productInventoryItemIds = new Set(
                products.map((p) => String(p.inventoryItemId || "").trim()).filter(Boolean)
              );
              groupItemsForGroup = countItemsLegacy.filter((item) => {
                const itemId = String(item?.inventoryItemId || "").trim();
                return productInventoryItemIds.has(itemId);
              });
            } catch (e) {
              console.error(`Failed to filter legacy items for group ${groupId}:`, e);
            }
          }
          const completedItems = groupItemsForGroup.length > 0 ? groupItemsForGroup : null;
          const isGroupCancelled = cancelledSet.has(normalizeIdForMatch(groupId));
          
          if (completedItems || isGroupCancelled) {
            // ✅ 完了済みまたはキャンセル済みのグループ：APIの groupItems から読み込んで読み取り専用で表示（下書きで上書きしない）
            // ✅ 画像URLを取得するため、商品情報を取得。初回読み込み数より多いグループでも全件取得するため limit: 2000
            try {
              const productFirst = Math.max(1, Math.min(250, Number(settings?.productList?.initialLimit ?? 250)));
              const productsRaw = await fetchProductsByGroups([groupId], c.locationId, {
                productFirst,
                limit: 2000,
                filterByInventoryLevel: false,
                includeImages: showImages && !liteMode,
                ...fetchOptsBase,
              });
              const products = Array.isArray(productsRaw) ? productsRaw : (productsRaw?.products ?? []);
              const productMap = new Map();
              products.forEach((p) => {
                if (p.inventoryItemId) {
                  productMap.set(String(p.inventoryItemId).trim(), p);
                }
              });
              
              // ✅ 予定外商品の画像URLを取得するため、Promise.allで並列処理
              // ✅ キャンセル済みで商品0件のとき completedItems が null なので .map で落ちないよう配列に正規化
              const completedLines = await Promise.all(
                (completedItems || []).map(async (it, i) => {
                  const t = (it?.title || it?.sku || "-").split(" / ");
                  const productTitle = t[0] || "";
                  const variantTitle = t[1] || "";
                  const inventoryItemIdStr = String(it?.inventoryItemId || "").trim();
                  const product = productMap.get(inventoryItemIdStr);
                  let imageUrl = product?.imageUrl ?? "";
                  
                  // ✅ 予定外商品で画像URLが取得できていない場合、groupItemsに保存されている画像URLを使用
                  const isExtra = Boolean(it?.isExtra);
                  if (isExtra && !imageUrl && it?.imageUrl) {
                    imageUrl = String(it.imageUrl);
                  }
                  
                  // ✅ 予定外商品で画像URLがまだ取得できていない場合、resolveVariantByCodeで取得を試みる
                  if (isExtra && !imageUrl && showImages && !liteMode) {
                    const code = it?.barcode || it?.sku || "";
                    if (code) {
                      try {
                        const resolved = await resolveVariantByCode(code, { includeImages: true });
                        if (resolved?.imageUrl) {
                          imageUrl = resolved.imageUrl;
                        }
                      } catch (e) {
                        console.error(`Failed to resolve variant image for extra item ${code}:`, e);
                      }
                    }
                  }
                  
                  return {
                    id: String(it?.id ?? `ro-${groupId}-${Date.now()}-${i}`),
                    variantId: it?.variantId ?? null,
                    inventoryItemId: it?.inventoryItemId ?? null,
                    productTitle,
                    variantTitle,
                    sku: String(it?.sku ?? ""),
                    barcode: String(it?.barcode ?? ""),
                    imageUrl, // ✅ 画像URLを取得（予定外商品の場合は追加で取得を試みる）
                    currentQuantity: Number(it?.currentQuantity ?? 0),
                    actualQuantity: Number(it?.actualQuantity ?? 0),
                    isReadOnly: true, // ✅ 完了済みは読み取り専用
                    isExtra, // ✅ 予定外商品フラグを保持（予定外リスト分離表示用）
                    productGroupId: groupId, // ✅ どのグループに属するか記録
                  };
                })
              );
              allLines.push(...completedLines);
            } catch (e) {
              console.error(`Failed to load product images for completed group ${groupId}:`, e);
              // ✅ エラーが発生した場合でも、画像なしで商品リストを表示
              const completedLines = completedItems.map((it, i) => {
                const t = (it?.title || it?.sku || "-").split(" / ");
                const productTitle = t[0] || "";
                const variantTitle = t[1] || "";
                return {
                  id: String(it?.id ?? `ro-${groupId}-${Date.now()}-${i}`),
                  variantId: it?.variantId ?? null,
                  inventoryItemId: it?.inventoryItemId ?? null,
                  productTitle,
                  variantTitle,
                  sku: String(it?.sku ?? ""),
                  barcode: String(it?.barcode ?? ""),
                  imageUrl: "",
                  currentQuantity: Number(it?.currentQuantity ?? 0),
                  actualQuantity: Number(it?.actualQuantity ?? 0),
                  isReadOnly: true,
                  isExtra: Boolean(it?.isExtra), // ✅ 予定外商品フラグを保持（予定外リスト分離表示用）
                  productGroupId: groupId,
                };
              });
              allLines.push(...completedLines);
            }
          } else {
            // ✅ 未完了のグループ：下書きがあればそのグループ分だけ復元。なければ「読込」ボタンで読み込む
            const draftForGroup = draftLinesByGroup.get(normalizeIdForMatch(groupId)) || [];
            if (draftForGroup.length > 0) {
              allLines.push(...draftForGroup);
            }
          }
        }
        
        // ✅ まとめて表示モードの場合、isReadOnlyStateを適切に設定
        // ✅ 未完了グループ（isReadOnly: falseの商品）がある場合は編集可能、全て完了/キャンセルの場合は読み取り専用（管理画面と連動）
        const hasIncompleteGroups = allLines.some((l) => !l.isReadOnly);
        const isAllCompleted = count?.status === "completed" || count?.status === "cancelled" || !hasIncompleteGroups;
        setIsReadOnlyState(isAllCompleted);
        
        isLoadingProductsRef.current = false; // ✅ 商品読み込み完了前にフラグを下ろす（自動保存を有効化）
        setLines(allLines);
        // ✅ 予定外商品を除外して初期表示の商品IDを記録（予定外リスト判定用）
        initialInventoryItemIdsRef.current = new Set(
          allLines.filter((l) => !l.isReadOnly && !l.isExtra).map((l) => normalizeInventoryItemIdForExtra(l.inventoryItemId)).filter(Boolean)
        );
        setLoading(false);
        return;
      }

      // ✅ 単一商品グループモード：棚卸IDが複数グループを持つ場合は per-group キー、それ以外はロス・出庫と同様の単一キー
      // ✅ 商品グループリストから「1つだけ選択して表示」している場合も countHasMultipleGroups が true なので per-group キーで正しくそのグループのみ復元される
      // ✅ 完了/キャンセル済みの棚卸は下書きを復元しない。現在表示中のグループが完了/キャンセル済みの場合も下書きを使わずAPIの groupItems を表示する
      const currentGroupIdSingle = productGroupId || (targetProductGroupIds && targetProductGroupIds[0]) || null;
      const groupItemsMapSingle = c?.groupItems && typeof c.groupItems === "object" ? c.groupItems : {};
      const groupItemsForCurrentSingle = currentGroupIdSingle ? getGroupItemsByKey(groupItemsMapSingle, currentGroupIdSingle) : [];
      const isCurrentGroupCompletedSingle = groupItemsForCurrentSingle.length > 0;
      const isCurrentGroupCancelledSingle = currentGroupIdSingle && cancelledGroupIdSet(c).has(normalizeIdForMatch(currentGroupIdSingle));
      const isCurrentGroupCompletedOrCancelledSingle = isCurrentGroupCompletedSingle || isCurrentGroupCancelledSingle;
      const isCountCompletedOrCancelledSingle = c?.status === "completed" || c?.status === "cancelled";
      let draftLines = [];
      if (!draftLoadedRef.current && !isCountCompletedOrCancelledSingle && !isCurrentGroupCompletedOrCancelledSingle) {
        try {
          if (SHOPIFY?.storage?.get) {
            const currentCountId = String(c.id || "").trim();
            const currentLocationId = String(c.locationId || "").trim();
            const currentGroupId = productGroupId || (targetProductGroupIds?.[0] || null);
            let raw = null;
            if (countHasMultipleGroups && currentGroupId) {
              const key = inventoryCountDraftKey({
                countId: currentCountId,
                locationId: currentLocationId,
                productGroupId: currentGroupId,
              });
              const got = await SHOPIFY.storage.get(key);
              raw = (got && typeof got === "object" ? (got[key] ?? got) : null) || null;
            } else {
              const got = await SHOPIFY.storage.get(INVENTORY_COUNT_DRAFT_LEGACY_KEY);
              raw = (got && typeof got === "object" ? (got[INVENTORY_COUNT_DRAFT_LEGACY_KEY] ?? got) : null) || null;
            }
            if (raw) {
              const savedCountId = String(raw.countId || "").trim();
              const savedLocationId = String(raw.locationId || "").trim();
              const norm = (v) => (String(v || "").split("/").pop() || "").trim() || String(v || "").trim();
              const match = (savedCountId === currentCountId || norm(savedCountId) === norm(currentCountId))
                && (savedLocationId === currentLocationId || norm(savedLocationId) === norm(currentLocationId));
              if (match) {
                const savedLinesRaw = Array.isArray(raw.lines) ? raw.lines : [];
                draftLines = savedLinesRaw
                  .map((l, i) => ({
                    id: String(l?.id ?? `${Date.now()}-${i}`),
                    variantId: l?.variantId ?? null,
                    inventoryItemId: l?.inventoryItemId ?? null,
                    productTitle: String(l?.productTitle || ""),
                    variantTitle: String(l?.variantTitle || ""),
                    sku: String(l?.sku || ""),
                    barcode: String(l?.barcode || ""),
                    imageUrl: String(l?.imageUrl || ""),
                    currentQuantity: Number.isFinite(Number(l?.currentQuantity)) ? Number(l.currentQuantity) : 0,
                    actualQuantity: Number.isFinite(Number(l?.actualQuantity)) ? Number(l.actualQuantity) : 0,
                    isExtra: Boolean(l?.isExtra),
                    productGroupId: currentGroupId,
                  }))
                  .filter((l) => l.variantId || l.inventoryItemId);
                if (draftLines.length > 0) {
                  draftLoadedRef.current = true;
                  lastDraftProductGroupIdRef.current = currentGroupId;
                  toast("下書きを復元しました");
                }
              }
            }
          }
        } catch (e) {
          console.error("Failed to load draft:", e);
        }
      }

      // 下書きがある場合はそれを返す（商品リストは読み込まない）
      if (draftLines.length > 0) {
        // ✅ 単一グループモード：対象の商品グループの行だけ表示（他グループの行を除外）
        const currentGroupId = productGroupId || (targetProductGroupIds && targetProductGroupIds[0]) || null;
        const linesToSet = !isMultipleMode && currentGroupId
          ? draftLines.filter((l) => (l?.productGroupId === currentGroupId) || !l?.productGroupId)
          : draftLines;
        setLines(linesToSet);
        // ✅ 下書き復元時も初期表示の商品IDを記録（予定外リスト判定用）
        initialInventoryItemIdsRef.current = new Set(
          linesToSet.filter((l) => !l.isExtra).map((l) => normalizeInventoryItemIdForExtra(l.inventoryItemId)).filter(Boolean)
        );
        // ✅ 下書き復元時：「未読込」「さらに読み込む」は「読み込み失敗時」または「全リスト読込前に保存した部分下書きを復元した時」のみ表示
        // ＝ inventoryItemIdsByGroup があり且つ 総ID数 > 復元行数 のときだけ hasMore を true にする（それ以外は非表示）
        const idsByGroup = c?.inventoryItemIdsByGroup;
        let hasMoreRestored = false;
        if (idsByGroup && typeof idsByGroup === "object") {
          const groupIds = currentGroupId ? [currentGroupId] : targetProductGroupIds;
          let totalIds = 0;
          for (const gid of groupIds) {
            const key = Object.keys(idsByGroup).find((k) => normalizeIdForMatch(k) === normalizeIdForMatch(gid));
            if (key && Array.isArray(idsByGroup[key])) totalIds += idsByGroup[key].length;
          }
          hasMoreRestored = totalIds > linesToSet.length;
        }
        setHasMoreProducts(hasMoreRestored);
        hasMoreProductsRef.current = hasMoreRestored;
        loadCompletedRef.current = true; // ✅ 下書き復元完了後は「商品がありません」を表示してよい
        setLoading(false);
        console.log("[InventoryCountList] Draft loaded, lines count:", linesToSet.length, isMultipleMode ? "(all groups)" : `(group: ${currentGroupId})`, "hasMoreProducts:", hasMoreRestored);
        return;
      }

      // ✅ 現在のグループが完了/キャンセル済みのときは下書きを使わずAPIの groupItems から表示する
      if (isCurrentGroupCompletedOrCancelledSingle && groupItemsForCurrentSingle.length > 0) {
        try {
          const productFirst = Math.max(1, Math.min(250, Number(settings?.productList?.initialLimit ?? 250)));
          const productsForCompleted = await fetchProductsByGroups(
            [currentGroupIdSingle],
            c.locationId,
            { productFirst, filterByInventoryLevel: false, includeImages: showImages && !liteMode, inventoryItemIdsByGroup: c?.inventoryItemIdsByGroup || null }
          );
          const productMap = new Map();
          (Array.isArray(productsForCompleted) ? productsForCompleted : (productsForCompleted?.products ?? [])).forEach((p) => {
            if (p?.inventoryItemId) productMap.set(String(p.inventoryItemId).trim(), p);
          });
          const completedLines = await Promise.all(
            groupItemsForCurrentSingle.map(async (it, i) => {
              const t = (it?.title || it?.sku || "-").split(" / ");
              const productTitle = t[0] || "";
              const variantTitle = t[1] || "";
              const inventoryItemIdStr = String(it?.inventoryItemId || "").trim();
              const product = productMap.get(inventoryItemIdStr);
              let imageUrl = product?.imageUrl ?? "";
              const isExtra = Boolean(it?.isExtra);
              if (isExtra && !imageUrl && it?.imageUrl) imageUrl = String(it.imageUrl);
              return {
                id: String(it?.id ?? `ro-${currentGroupIdSingle}-${Date.now()}-${i}`),
                variantId: it?.variantId ?? null,
                inventoryItemId: it?.inventoryItemId ?? null,
                productTitle,
                variantTitle,
                sku: String(it?.sku ?? ""),
                barcode: String(it?.barcode ?? ""),
                imageUrl,
                currentQuantity: Number(it?.currentQuantity ?? 0),
                actualQuantity: Number(it?.actualQuantity ?? 0),
                isReadOnly: true,
                isExtra,
                productGroupId: currentGroupIdSingle,
              };
            })
          );
          isLoadingProductsRef.current = false;
          setLines(completedLines);
          loadCompletedRef.current = true;
          initialInventoryItemIdsRef.current = new Set(
            completedLines.filter((l) => !l.isExtra).map((l) => normalizeInventoryItemIdForExtra(l.inventoryItemId)).filter(Boolean)
          );
          setIsReadOnlyState(true);
          setLoading(false);
          return;
        } catch (e) {
          console.error("[InventoryCountList] Failed to load completed/cancelled group items:", e);
        }
      }
      if (isCurrentGroupCompletedOrCancelledSingle && groupItemsForCurrentSingle.length === 0) {
        setLines([]);
        loadCompletedRef.current = true;
        initialInventoryItemIdsRef.current = new Set();
        setIsReadOnlyState(true);
        setLoading(false);
        return;
      }

      // 在庫レベルがある商品のみを取得（初期表示用）・入庫並み：1回の取得で currentQuantity 付きで返るため二重取得しない
      const productFirst = Math.max(1, Math.min(250, Number(settings?.productList?.initialLimit ?? 250)));
      collectionPageInfoRef.current = null; // ✅ 棚卸/グループ切り替え時は cursor をリセット
      // ✅ さらに読み込む用の1回あたり件数（管理画面と揃える）
      // ✅ 常に画像付きで取得（画像ON/OFFは表示切替のみ。ロス・入庫・出庫と同様にリスト再読込しない）
      // ✅ 入庫並みの表示速度：初回は在庫クエリなしで商品リストのみ取得。在庫数は「在庫更新」ボタンで取得
      const rawProducts = await fetchProductsByGroups(targetProductGroupIds, c.locationId, {
        productFirst,
        filterByInventoryLevel: false,
        includeImages: true,
        inventoryItemIdsByGroup: c?.inventoryItemIdsByGroup || null, // ✅ 生成時の商品リストを使用
        offset: 0,
        limit: 600,
      });
      const products = Array.isArray(rawProducts) ? rawProducts : (rawProducts?.products ?? []);
      const hasMore = rawProducts?.hasMore ?? false;
      setHasMoreProducts(hasMore);
      collectionPageInfoRef.current = rawProducts?.collectionPageInfo ?? null; // ✅ コレクション経路のさらに読み込む用
      console.log("[InventoryCountList] fetchProductsByGroups result", { productCount: products.length, hasMore });
      
      // filterByInventoryLevel: false のため currentQuantity は付与されない。在庫列は「…」表示にし、バックグラウンドで随時取得
      const currentGroupIdForSingle = !isMultipleMode && targetProductGroupIds?.length > 0 ? targetProductGroupIds[0] : null;
      const linesWithCurrent = products.map((p, idx) => ({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${idx}`,
        variantId: p.variantId,
        inventoryItemId: p.inventoryItemId,
        productTitle: p.productTitle ?? "",
        variantTitle: p.variantTitle ?? "",
        sku: p.sku ?? "",
        barcode: p.barcode ?? "",
        imageUrl: p.imageUrl ?? "",
        currentQuantity: p.currentQuantity != null ? p.currentQuantity : 0,
        actualQuantity: 0, // ✅ 初期値は0（スキャンで積み上げる方式）
        productGroupId: currentGroupIdForSingle, // ✅ 単一グループモードで選択中のグループを付与
        stockLoading: true, // ✅ 在庫はバックグラウンドで取得するため「…」表示
        stockError: null,
      }));
      isLoadingProductsRef.current = false; // ✅ 商品読み込み完了前にフラグを下ろす（自動保存を有効化）
      setLines(linesWithCurrent);
      if (linesWithCurrent.length > 0) loadCompletedRef.current = true; // ✅ 1件以上読めたときだけ「商品がありません」を許可（0件のままコレクション→CSV で再読込する間のチラつき防止）
      // ✅ 初期表示の商品IDを記録（予定外リスト判定用）
      initialInventoryItemIdsRef.current = new Set(
        linesWithCurrent.map((l) => normalizeInventoryItemIdForExtra(l.inventoryItemId)).filter(Boolean)
      );
      console.log("[InventoryCountList] Products loaded, lines count:", linesWithCurrent.length);

      // ✅ リスト表示後、在庫数をバックグラウンドで一括取得（50件/リクエスト）。スキャン・カウントは並行して可能。actualQuantity は更新しない
      if (!c.locationId || linesWithCurrent.length === 0) return;
      const thisLoadId = ++backgroundInventoryLoadIdRef.current;
      const locationId = c.locationId;
      (async () => {
        const ids = linesWithCurrent.map((l) => l.inventoryItemId).filter(Boolean);
        if (ids.length === 0) return;
        if (backgroundInventoryLoadIdRef.current !== thisLoadId) return;
        try {
          const qtyMap = await getCurrentQuantitiesBulk(ids, locationId, { noCache: false });
          if (backgroundInventoryLoadIdRef.current !== thisLoadId) return;
          const lineIdToQty = new Map(
            linesWithCurrent.map((l) => [
              l.id,
              l.inventoryItemId != null ? (qtyMap.get(l.inventoryItemId) ?? 0) : 0,
            ])
          );
          setLines((prev) =>
            prev.map((l) => {
              const qty = lineIdToQty.get(l.id);
              if (qty === undefined) return l;
              return { ...l, currentQuantity: qty, stockLoading: false, stockError: null };
            })
          );
        } catch (e) {
          console.error("[InventoryCountList] background inventory load error:", e);
        }
      })();
    } catch (e) {
      toast(`商品の読み込みに失敗しました: ${e?.message || e}`);
      console.error("[InventoryCountList] loadProducts error:", e);
      setHasMoreProducts(true); // ✅ 読み込み失敗時は「未読込」「読込」「さらに読み込む」を表示して再試行可能に
      hasMoreProductsRef.current = true;
    } finally {
      setLoading(false);
      isLoadingProductsRef.current = false; // ✅ loadProducts完了時にフラグを下ろす
      console.log("[InventoryCountList] loadProducts completed, loading set to false");
    }
  }, [effectiveCount, count, targetProductGroupIds, readOnlyProp, productGroupId, isMultipleMode]);

  // ✅ さらに読み込む（POS棚卸リスト用）
  const LOAD_PAGE_SIZE = 600;
  const handleLoadMoreProducts = useCallback(async () => {
    if (!count || !count.locationId || targetProductGroupIds.length === 0) return;
    if (loadingMoreRef.current || loadingMore) return;
    // ✅ ref で最新値を参照（スタレ閉じ込めでタップ時に false のまま return するのを防ぐ）
    if (!hasMoreProductsRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    await new Promise((r) => setTimeout(r, 0)); // ✅ 押した直後に「読込中...」を描画してから取得開始（反応が遅く見えるのを防ぐ）
    try {
      const productFirst = Math.max(1, Math.min(250, Number(settings?.productList?.initialLimit ?? 250)));
      // ✅ 追加読み込みも在庫クエリなしで高速に。在庫数は「在庫更新」で一括取得可能
      const raw = await fetchProductsByGroups(targetProductGroupIds, count.locationId, {
        productFirst,
        filterByInventoryLevel: false,
        includeImages: true,
        inventoryItemIdsByGroup: count?.inventoryItemIdsByGroup || null,
        collectionPageInfo: collectionPageInfoRef.current || undefined,
        offset: lines.length,
        limit: LOAD_PAGE_SIZE,
        timeoutMs: 90000,
      });
      const products = Array.isArray(raw) ? raw : (raw?.products ?? []);
      const hasMore = raw?.hasMore ?? false;
      setHasMoreProducts(hasMore);
      if (raw?.collectionPageInfo != null) collectionPageInfoRef.current = raw.collectionPageInfo;
      const currentGroupIdForSingle = !isMultipleMode && targetProductGroupIds?.length > 0 ? targetProductGroupIds[0] : null;
      const newLines = products.map((p, idx) => ({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${idx}`,
        variantId: p.variantId,
        inventoryItemId: p.inventoryItemId,
        productTitle: p.productTitle ?? "",
        variantTitle: p.variantTitle ?? "",
        sku: p.sku ?? "",
        barcode: p.barcode ?? "",
        imageUrl: p.imageUrl ?? "",
        currentQuantity: p.currentQuantity != null ? p.currentQuantity : 0,
        actualQuantity: 0,
        productGroupId: currentGroupIdForSingle,
        stockLoading: true,
        stockError: null,
      }));
      setLines((prev) => [...prev, ...newLines]);
      // ✅ 追加した行の在庫もバックグラウンドで一括取得（50件/リクエスト）
      if (count.locationId && newLines.length > 0) {
        const thisLoadId = ++backgroundInventoryLoadIdRef.current;
        const locationId = count.locationId;
        const ids = newLines.map((l) => l.inventoryItemId).filter(Boolean);
        (async () => {
          if (ids.length === 0) return;
          if (backgroundInventoryLoadIdRef.current !== thisLoadId) return;
          try {
            const qtyMap = await getCurrentQuantitiesBulk(ids, locationId, { noCache: false });
            if (backgroundInventoryLoadIdRef.current !== thisLoadId) return;
            const lineIdToQty = new Map(
              newLines.map((l) => [
                l.id,
                l.inventoryItemId != null ? (qtyMap.get(l.inventoryItemId) ?? 0) : 0,
              ])
            );
            setLines((prev) =>
              prev.map((l) => {
                const qty = lineIdToQty.get(l.id);
                if (qty === undefined) return l;
                return { ...l, currentQuantity: qty, stockLoading: false, stockError: null };
              })
            );
          } catch (e) {
            console.error("[InventoryCountList] loadMore background inventory error:", e);
          }
        })();
      }
      if (newLines.length > 0) {
        const prevSet = initialInventoryItemIdsRef.current || new Set();
        const addIds = newLines.map((l) => normalizeInventoryItemIdForExtra(l.inventoryItemId)).filter(Boolean);
        initialInventoryItemIdsRef.current = new Set([...prevSet, ...addIds]);
      }
    } catch (e) {
      toast(`追加読み込みに失敗しました: ${e?.message || e}`);
      console.error("[InventoryCountList] handleLoadMoreProducts error:", e);
    } finally {
      setLoadingMore(false);
      loadingMoreRef.current = false;
    }
  }, [count, targetProductGroupIds, lines.length, loadingMore, isMultipleMode, settings?.productList?.initialLimit]);

  // ✅ まとめて表示：グループごと「読込」ボタンでそのグループの商品だけ読み込む（STOCKTAKE_39GROUPS_UX_IMPROVEMENTS.md）
  const loadGroupProducts = useCallback(async (groupId) => {
    if (!isMultipleMode || !count?.id || !count?.locationId || !groupId) return;
    if (loadingGroupIdRef.current != null) return; // 二重発火防止
    loadingGroupIdRef.current = groupId;
    setLoadingGroupId(groupId);
    await new Promise((r) => setTimeout(r, 0)); // ✅ 押した直後に「読込中...」を描画してから取得開始
    const groupName = productGroupNames.get(normalizeIdForMatch(groupId)) || groupId;
    try {
      const groupItemsMap = count?.groupItems && typeof count.groupItems === "object" ? count.groupItems : {};
      const countItemsLegacy = Array.isArray(count?.items) ? count.items : [];
      let cachedProductGroups = [];
      try {
        cachedProductGroups = await readProductGroups();
      } catch (e) {
        console.error("[InventoryCountList] readProductGroups in loadGroupProducts:", e);
      }
      const fetchOptsBase = {
        inventoryItemIdsByGroup: count?.inventoryItemIdsByGroup || null,
        ...(cachedProductGroups.length > 0 ? { cachedProductGroups } : {}),
      };
      let groupItemsForGroup = getGroupItemsByKey(groupItemsMap, groupId);
      if (groupItemsForGroup.length === 0 && countItemsLegacy.length > 0) {
        try {
          const productFirst = Math.max(1, Math.min(250, Number(settings?.productList?.initialLimit ?? 250)));
          const products = await fetchProductsByGroups([groupId], count.locationId, {
            productFirst,
            limit: 2000,
            filterByInventoryLevel: false,
            includeImages: false,
            ...fetchOptsBase,
          });
          const productList = Array.isArray(products) ? products : (products?.products ?? []);
          const productInventoryItemIds = new Set(
            productList.map((p) => String(p.inventoryItemId || "").trim()).filter(Boolean)
          );
          groupItemsForGroup = countItemsLegacy.filter((item) => {
            const itemId = String(item?.inventoryItemId || "").trim();
            return productInventoryItemIds.has(itemId);
          });
        } catch (e) {
          console.error(`[InventoryCountList] filter legacy for group ${groupId}:`, e);
        }
      }
      const completedItems = groupItemsForGroup.length > 0 ? groupItemsForGroup : null;
      let newLines = [];

      if (completedItems) {
        const productFirst = Math.max(1, Math.min(250, Number(settings?.productList?.initialLimit ?? 250)));
        let productsForCompleted = await fetchProductsByGroups([groupId], count.locationId, {
          productFirst,
          limit: 2000,
          filterByInventoryLevel: false,
          includeImages: showImages && !liteMode,
          ...fetchOptsBase,
        });
        productsForCompleted = Array.isArray(productsForCompleted) ? productsForCompleted : (productsForCompleted?.products ?? []);
        const productMap = new Map();
        productsForCompleted.forEach((p) => {
          if (p.inventoryItemId) productMap.set(String(p.inventoryItemId).trim(), p);
        });
        newLines = await Promise.all(
          completedItems.map(async (it, i) => {
            const t = (it?.title || it?.sku || "-").split(" / ");
            const inventoryItemIdStr = String(it?.inventoryItemId || "").trim();
            const product = productMap.get(inventoryItemIdStr);
            let imageUrl = product?.imageUrl ?? "";
            const isExtra = Boolean(it?.isExtra);
            if (isExtra && !imageUrl && it?.imageUrl) imageUrl = String(it.imageUrl);
            if (isExtra && !imageUrl && showImages && !liteMode && (it?.barcode || it?.sku)) {
              try {
                const resolved = await resolveVariantByCode(it.barcode || it.sku, { includeImages: true });
                if (resolved?.imageUrl) imageUrl = resolved.imageUrl;
              } catch {}
            }
            return {
              id: String(it?.id ?? `ro-${groupId}-${Date.now()}-${i}`),
              variantId: it?.variantId ?? null,
              inventoryItemId: it?.inventoryItemId ?? null,
              productTitle: t[0] || "",
              variantTitle: t[1] || "",
              sku: String(it?.sku ?? ""),
              barcode: String(it?.barcode ?? ""),
              imageUrl,
              currentQuantity: Number(it?.currentQuantity ?? 0),
              actualQuantity: Number(it?.actualQuantity ?? 0),
              isReadOnly: true,
              isExtra,
              productGroupId: groupId,
            };
          })
        );
      } else {
        const productFirst = Math.max(1, Math.min(250, Number(settings?.productList?.initialLimit ?? 250)));
        let productsRaw = await fetchProductsByGroups([groupId], count.locationId, {
          productFirst,
          limit: 2000,
          filterByInventoryLevel: false,
          includeImages: showImages && !liteMode,
          ...fetchOptsBase,
        });
        let products = Array.isArray(productsRaw) ? productsRaw : (productsRaw?.products ?? []);
        if (products.length === 0) {
          await new Promise((r) => setTimeout(r, 1000));
          productsRaw = await fetchProductsByGroups([groupId], count.locationId, {
            productFirst,
            limit: 2000,
            filterByInventoryLevel: false,
            includeImages: showImages && !liteMode,
            ...fetchOptsBase,
          });
          products = Array.isArray(productsRaw) ? productsRaw : (productsRaw?.products ?? []);
        }
        const linesWithCurrent = await Promise.all(
          products.map(async (p) => {
            try {
              const currentQty = await getCurrentQuantity(p.inventoryItemId, count.locationId);
              return {
                id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                variantId: p.variantId,
                inventoryItemId: p.inventoryItemId,
                productTitle: p.productTitle ?? "",
                variantTitle: p.variantTitle ?? "",
                sku: p.sku ?? "",
                barcode: p.barcode ?? "",
                imageUrl: p.imageUrl ?? "",
                currentQuantity: currentQty !== null ? currentQty : 0,
                actualQuantity: 0,
                isReadOnly: false,
                productGroupId: groupId,
              };
            } catch {
              return {
                id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                variantId: p.variantId,
                inventoryItemId: p.inventoryItemId,
                productTitle: p.productTitle ?? "",
                variantTitle: p.variantTitle ?? "",
                sku: p.sku ?? "",
                barcode: p.barcode ?? "",
                imageUrl: p.imageUrl ?? "",
                currentQuantity: 0,
                actualQuantity: 0,
                isReadOnly: false,
                productGroupId: groupId,
              };
            }
          })
        );
        newLines = linesWithCurrent;
      }

      setLines((prev) => {
        const rest = prev.filter((l) => l.productGroupId !== groupId);
        return [...rest, ...newLines];
      });
      if (newLines.length > 0 && !completedItems) {
        const prevSet = initialInventoryItemIdsRef.current || new Set();
        const addIds = newLines.filter((l) => !l.isExtra).map((l) => normalizeInventoryItemIdForExtra(l.inventoryItemId)).filter(Boolean);
        initialInventoryItemIdsRef.current = new Set([...prevSet, ...addIds]);
      }
      const hasIncomplete = newLines.some((l) => !l.isReadOnly);
      setIsReadOnlyState(count?.status === "completed" || count?.status === "cancelled" || !hasIncomplete);
    } catch (e) {
      toast(`グループ「${groupName}」の読み込みに失敗しました: ${e?.message || e}`);
    } finally {
      setLoadingGroupId(null);
      loadingGroupIdRef.current = null;
    }
  }, [count, isMultipleMode, productGroupNames, settings?.productList?.initialLimit, showImages, liteMode]);

  // ✅ linesRef を lines と同期（入庫の rowsRef と同様）
  useEffect(() => {
    linesRef.current = lines;
  }, [lines]);

  // ✅ VariantCacheの初期化
  useEffect(() => {
    (async () => {
      try {
        // VariantCacheはstocktakeApi.jsで定義されているが、initを呼び出す必要がある
        // resolveVariantByCode内で自動的に初期化されるため、ここでは不要
      } catch (e) {
        console.error("VariantCache init error:", e);
      }
    })();
  }, []);

  useEffect(() => {
    if (count?.id && isMinimalCount(count) && !effectiveCount) return;
    loadProducts();
  }, [loadProducts, count?.id, effectiveCount]);

  // ✅ 自動保存（lines変更時に下書きを保存）
  // ✅ 入庫の複数シップメントと同様：商品グループごとに別キーで保存
  useEffect(() => {
    if (!count || !count.id || !count.locationId) return;
    if (isReadOnly) return;
    if (isLoadingProductsRef.current) return;
    if (draftLoadedRef.current && lines.length === 0) return;

    const t = setTimeout(async () => {
      try {
        if (!SHOPIFY?.storage?.set) return;

        const minimized = lines
          .map((l, i) => ({
            id: String(l?.id ?? `${Date.now()}-${i}`),
            variantId: l?.variantId ?? null,
            inventoryItemId: l?.inventoryItemId ?? null,
            productTitle: String(l?.productTitle || ""),
            variantTitle: String(l?.variantTitle || ""),
            sku: String(l?.sku || ""),
            barcode: String(l?.barcode || ""),
            imageUrl: String(l?.imageUrl || ""),
            currentQuantity: Number.isFinite(Number(l?.currentQuantity)) ? Number(l.currentQuantity) : 0,
            actualQuantity: Number.isFinite(Number(l?.actualQuantity)) ? Number(l.actualQuantity) : 0,
            isReadOnly: Boolean(l?.isReadOnly),
            isExtra: Boolean(l?.isExtra),
            productGroupId: l?.productGroupId || null,
          }))
          .filter((l) => l.variantId || l.inventoryItemId);

        const payload = {
          version: 1,
          savedAt: Date.now(),
          countId: count.id,
          locationId: count.locationId,
          lines: minimized,
        };

        // ✅ 棚卸IDが複数グループを持つ場合のみグループごとキーで保存（商品グループごと表示・まとめて表示の両方で連動）
        const countHasMultipleGroupsSave = Array.isArray(count?.productGroupIds) && count.productGroupIds.length > 1;
        if (countHasMultipleGroupsSave) {
          const byGroup = new Map();
          for (const l of minimized) {
            const gid = l.productGroupId || targetProductGroupIds?.[0] || "_default";
            if (!byGroup.has(gid)) byGroup.set(gid, []);
            byGroup.get(gid).push(l);
          }
          for (const [groupId, groupLines] of byGroup) {
            const key = inventoryCountDraftKey({
              countId: count.id,
              locationId: count.locationId,
              productGroupId: groupId,
            });
            await SHOPIFY.storage.set(key, { ...payload, lines: groupLines });
          }
        } else {
          // 単一グループの棚卸ID：ロス・出庫と同様の単一キーに保存（従来どおり）
          await SHOPIFY.storage.set(INVENTORY_COUNT_DRAFT_LEGACY_KEY, payload);
        }
      } catch (e) {
        console.error("Failed to save inventory count draft:", e);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [lines, count?.id, count?.locationId, isReadOnly, isMultipleMode, productGroupId, targetProductGroupIds]);

  // ✅ TDZ対策：addLine はスキャンキュー useEffect の依存配列で使うため、その前に定義する必要がある
  // 商品を追加（検索結果から）※入庫の addOrIncrementByResolved と同一のコード処理
  // resolved: { variantId, inventoryItemId, productTitle, variantTitle, sku, barcode, imageUrl }（候補から組み立てたオブジェクト）
  // delta: 加算数量（既存行は +delta、新規は actualQuantity: delta）。未指定時は 1
  const addLine = useCallback(
    (resolved, delta = 1) => {
      if (readOnlyRef.current) return denyEdit();
      const inventoryItemId = resolved?.inventoryItemId;
      if (!inventoryItemId || !count) {
        toast("inventoryItemId が取得できませんでした");
        return;
      }
      const deltaNum = Number.isFinite(Number(delta)) ? Math.max(0, Math.floor(Number(delta))) : 1;
      const invIdStr = String(inventoryItemId || "").trim();
      const varIdStr = String(resolved?.variantId || "").trim();

      // ✅ 入庫と同様：linesRef で既存を同期的に判定（文字列比較）
      const existing = (linesRef.current || []).find(
        (l) =>
          String(l.inventoryItemId || "").trim() === invIdStr ||
          String(l.variantId || "").trim() === varIdStr
      );
      if (existing) {
        const newActual = Math.min(999999, Math.max(-999, (existing.actualQuantity || 0) + deltaNum));
        setLines((prev) =>
          prev.map((l) =>
            String(l.inventoryItemId || "").trim() === invIdStr || String(l.variantId || "").trim() === varIdStr
              ? { ...l, actualQuantity: newActual }
              : l
          )
        );
        return;
      }

      const normalizedId = normalizeInventoryItemIdForExtra(inventoryItemId);
      const isExtra = !initialInventoryItemIdsRef.current.has(normalizedId);
      // ✅ 予定外棚卸許可が不許可の場合は予定外商品の追加をブロック（明示的に true のときのみ許可。未読込・キーなしは不許可扱い）
      if (isExtra && settings?.inventoryCount?.allowExtraCount !== true) {
        toast("商品リストにない商品です。");
        return;
      }
      const assignedGroupId = isMultipleMode ? (targetProductGroupIds[0] || null) : (productGroupId || targetProductGroupIds[0] || null);
      // ✅ 在庫数は都度取得しない。表示・確定は「在庫更新」ボタンや確定時の処理で行う（入庫と同様に追加時はAPIを呼ばない）
      const newLine = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        variantId: resolved.variantId,
        inventoryItemId: resolved.inventoryItemId,
        productTitle: resolved.productTitle ?? "",
        variantTitle: resolved.variantTitle ?? "",
        sku: resolved.sku ?? "",
        barcode: resolved.barcode ?? "",
        imageUrl: resolved.imageUrl ?? "",
        currentQuantity: 0,
        actualQuantity: deltaNum,
        isExtra,
        productGroupId: assignedGroupId,
        stockLoading: false,
        stockError: null,
      };
      setLines((prev) => [newLine, ...prev]);
      toast(`${resolved.barcode || resolved.sku || resolved.productTitle || "(no title)"} を追加しました（+1）`);
      // ✅ 入庫と同様：追加後も検索はクリアしない
    },
    [count, denyEdit, isMultipleMode, targetProductGroupIds, productGroupId, settings]
  );

  // スキャンキュー処理
  useEffect(() => {
    if (!count || !count.locationId) return;
    
    const processScanQueue = async () => {
      if (scanProcessingRef.current) return;
      if (readOnlyRef.current) return;
      scanProcessingRef.current = true;
      try {
        const storage = SHOPIFY?.storage;
        if (!storage?.get) return;
        const queue = normalizeScanQueueObj_(await storage.get(SCAN_QUEUE_KEY));
        if (queue.items.length === 0) return;
        
        // 最初のアイテムを処理
        const code = queue.items[0];
        const remaining = queue.items.slice(1);
        await storage.set(SCAN_QUEUE_KEY, {
          items: remaining,
          lastV: remaining[remaining.length - 1] || "",
          lastT: Date.now(),
          updatedAt: Date.now(),
        });

        // 商品を検索して追加（入庫と同様：resolve のみ await、addLine は同期的に呼んで即リスト反映・次のスキャンへ）
        try {
          const includeImages = showImages && !liteMode;
          const resolvedFromScan = await resolveVariantByCode(code, { includeImages });
          if (!resolvedFromScan?.variantId || !resolvedFromScan?.inventoryItemId) {
            toast(`商品が見つかりません: ${code}`);
            return;
          }
          const resolved = {
            variantId: resolvedFromScan.variantId,
            inventoryItemId: resolvedFromScan.inventoryItemId,
            productTitle: resolvedFromScan.productTitle ?? "",
            variantTitle: resolvedFromScan.variantTitle ?? "",
            sku: resolvedFromScan.sku ?? "",
            barcode: resolvedFromScan.barcode ?? "",
            imageUrl: resolvedFromScan.imageUrl ?? "",
          };
          addLine(resolved, 1);
        } catch (e) {
          toast(`スキャン処理エラー: ${e?.message || e}`);
        }
      } finally {
        scanProcessingRef.current = false;
      }
    };

    const interval = setInterval(processScanQueue, 100); // ✅ 入庫と同じ100msでキューを消化（次のスキャンをすぐ取りにいく）
    return () => clearInterval(interval);
  }, [count, showImages, liteMode, denyEdit, addLine]);

  // 検索処理
  const debouncedQuery = useDebounce(query.trim(), 200);
  useEffect(() => {
    let mounted = true;
    const run = async () => {
      const q = String(debouncedQuery || "").trim();
      if (!q) {
        if (mounted) {
          setCandidates([]);
          setSearchPageInfo({ hasNextPage: false, endCursor: null });
          setCandidatesLoading(false);
          setAddQtyById({}); // ✅ 入庫と同様：検索クリア時に候補ごとの追加済み数量をリセット
        }
        return;
      }
      setCandidatesLoading(true);
      try {
        const searchLimit = Math.max(10, Math.min(50, Number(settings?.searchList?.initialLimit ?? 50)));
        const result = await searchVariants(q, { first: searchLimit, includeImages: showImages && !liteMode });
        const list = result?.nodes ?? [];
        const pageInfo = result?.pageInfo ?? { hasNextPage: false, endCursor: null };
        if (mounted) {
          setCandidates(Array.isArray(list) ? list : []);
          setSearchPageInfo(pageInfo);
        }
      } catch (e) {
        toast(`検索エラー: ${e?.message ?? e}`);
        if (mounted) {
          setCandidates([]);
          setSearchPageInfo({ hasNextPage: false, endCursor: null });
        }
      } finally {
        if (mounted) setCandidatesLoading(false);
      }
    };
    run();
    return () => {
      mounted = false;
    };
  }, [debouncedQuery, showImages, liteMode, settings, setAddQtyById]);

  // ✅ 検索リストの「さらに読み込む」（50件超の次のページを取得・出庫と同様）
  const handleLoadMoreSearch = useCallback(async () => {
    const raw = String(debouncedQuery || "").trim();
    if (!raw || loadingMoreSearch || !searchPageInfo?.hasNextPage || !searchPageInfo?.endCursor) return;
    setLoadingMoreSearch(true);
    await new Promise((r) => setTimeout(r, 0)); // ✅ 押した直後に「読込中...」を描画してから取得開始
    try {
      const searchLimit = Math.max(10, Math.min(50, Number(settings?.searchList?.initialLimit ?? 50)));
      const result = await searchVariants(raw, { includeImages: showImages && !liteMode, first: searchLimit, after: searchPageInfo.endCursor });
      const list = result?.nodes ?? [];
      const pageInfo = result?.pageInfo ?? { hasNextPage: false, endCursor: null };
      setCandidates((prev) => [...prev, ...list]);
      setSearchPageInfo(pageInfo);
    } catch (e) {
      toast(`検索の追加読み込みに失敗しました: ${e?.message ?? e}`);
    } finally {
      setLoadingMoreSearch(false);
    }
  }, [debouncedQuery, searchPageInfo?.hasNextPage, searchPageInfo?.endCursor, loadingMoreSearch, showImages, liteMode, settings?.searchList?.initialLimit]);

  // 実数を更新
  const updateActualQuantity = useCallback((id, delta) => {
    if (readOnlyRef.current) return denyEdit();
    setLines((prev) =>
      prev.map((l) => {
        if (String(l.id) !== String(id)) return l;
        // ✅ まとめて表示モードで完了済みの商品は編集不可
        if (l.isReadOnly) return denyEdit() || l;
        // ✅ 棚卸はマイナス在庫も入力可能（-999〜999999）
        const newActual = Math.min(999999, Math.max(-999, (l.actualQuantity || 0) + delta));
        return { ...l, actualQuantity: newActual };
      })
    );
  }, [denyEdit]);

  // 実数を直接入力（棚卸はマイナス在庫も入力可能）
  const setActualQuantity = useCallback((id, value) => {
    if (readOnlyRef.current) return denyEdit();
    const num = Math.min(999999, Math.max(-999, Math.floor(Number(value) || 0)));
    setLines((prev) =>
      prev.map((l) => {
        if (String(l.id) !== String(id)) return l;
        // ✅ まとめて表示モードで完了済みの商品は編集不可
        if (l.isReadOnly) return denyEdit() || l;
        return { ...l, actualQuantity: num };
      })
    );
  }, [denyEdit]);

  // 商品を削除
  const removeLine = useCallback((id) => {
    if (readOnlyRef.current) return denyEdit();
    setLines((prev) => prev.filter((l) => String(l.id) !== String(id)));
  }, [denyEdit]);

  // 棚卸完了
  // 調整対象アイテムを計算（モーダル表示用）
  const itemsToAdjust = useMemo(() => {
    return lines
      .filter((l) => !l.isReadOnly) // ✅ まとめて表示モードで完了済みの商品は除外
      .filter((l) => l.inventoryItemId && Number.isFinite(l.currentQuantity) && Number.isFinite(l.actualQuantity))
      .filter((l) => l.currentQuantity !== l.actualQuantity);
  }, [lines]);

  const buildGroupItemsEntry = useCallback(() => {
    return lines.map((l) => {
      const currentQty = Number(l.currentQuantity ?? 0);
      const actualQty = Number(l.actualQuantity ?? 0);
      return {
        inventoryItemId: l.inventoryItemId,
        variantId: l.variantId,
        sku: l.sku ?? "",
        title: [l.productTitle, l.variantTitle].filter(Boolean).join(" / ") || l.sku || "-",
        // ✅ 在庫は棚卸時の在庫数（currentQuantity）、実数は確定した在庫数（actualQuantity）
        currentQuantity: currentQty,
        actualQuantity: actualQty,
        delta: actualQty - currentQty,
      };
    });
  }, [lines]);

  const handleComplete = useCallback(async () => {
    if (!count) {
      toast("棚卸情報が見つかりません");
      return false;
    }

    // ✅ まとめて表示モードの場合：各商品グループごとに処理
    if (isMultipleMode) {
      const editableLines = lines.filter((l) => !l.isReadOnly);
      if (editableLines.length === 0) {
        toast("編集可能な商品がありません");
        return false;
      }
      
      // 編集可能な商品を商品グループごとにグループ化
      const linesByGroup = new Map();
      for (const line of editableLines) {
        const groupId = line.productGroupId || targetProductGroupIds[0];
        if (!groupId) continue;
        if (!linesByGroup.has(groupId)) {
          linesByGroup.set(groupId, []);
        }
        linesByGroup.get(groupId).push(line);
      }
      
      // ✅ 全グループの処理状況を記録（トースト表示用）
      const groupStatusMessages = [];
      
      // 在庫調整が必要なアイテムを計算（全グループ）
      const allItemsToAdjust = editableLines
        .filter((l) => l.inventoryItemId && Number.isFinite(l.currentQuantity) && Number.isFinite(l.actualQuantity))
        .filter((l) => l.currentQuantity !== l.actualQuantity);
      
      if (allItemsToAdjust.length === 0) {
        // ✅ 在庫差異なし：read → merge → write 後に merge 結果を onAfterConfirm に渡し、商品グループごと表示・1グループのみでも最後のグループが完了になるようする
        setSubmitting(true);
        setTimeout(() => {
          try {
            const locallyBuilt = buildUpdatedCountFromLocalState(count, lines, {
              isMultipleMode: true,
              targetProductGroupIds,
              productGroupId,
            });
            toast("棚卸を完了しました");
            readInventoryCountsRaw()
              .then((counts) => {
                const idStr = String(count?.id ?? "");
                const list = Array.isArray(counts) ? counts : [];
                const fromStorage = list.find((c) => String(c?.id ?? "") === idStr);
                const toWrite = mergeCountWithStorage(fromStorage, locallyBuilt);
                const merged = list.some((c) => String(c?.id ?? "") === idStr)
                  ? list.map((c) => (String(c?.id ?? "") === idStr ? toWrite : c))
                  : [...list, toWrite];
                return writeInventoryCounts(merged).then(() => toWrite);
              })
              .then((toWrite) => {
                if (toWrite) onAfterConfirm?.(toWrite);
                setSubmitting(false);
              })
              .catch((e) => {
                toast(`保存に失敗しました: ${e?.message ?? e}`);
                onAfterConfirm?.(null);
                setSubmitting(false);
              });
          } catch (e) {
            toast(`エラー: ${e?.message ?? e}`);
            onAfterConfirm?.(null);
            setSubmitting(false);
          }
        }, 0);
        return true;
      }
      
      // 在庫調整が必要な場合：全グループの編集可能な商品を一度に調整
      setSubmitting(true);
      let inventoryAdjustmentSuccess = false;
      
      // ✅ 在庫調整前にlinesのスナップショットを作成
      const linesSnapshot = editableLines.map((l) => ({
        inventoryItemId: l.inventoryItemId,
        variantId: l.variantId,
        sku: l.sku ?? "",
        barcode: l.barcode ?? "", // ✅ barcodeを追加
        productTitle: l.productTitle ?? "",
        variantTitle: l.variantTitle ?? "",
        productGroupId: l.productGroupId,
        currentQuantity: Number(l.currentQuantity ?? 0),
        actualQuantity: Number(l.actualQuantity ?? 0),
        isExtra: Boolean(l.isExtra), // ✅ 予定外商品フラグを追加
      }));
      
      try {
        // ✅ エラー要因を先に確認：在庫調整APIが失敗したらここで止める
        const result = await adjustInventoryToActual({
          locationId: count.locationId,
          items: allItemsToAdjust.map((l) => ({
            inventoryItemId: l.inventoryItemId,
            currentQuantity: l.currentQuantity,
            actualQuantity: l.actualQuantity,
          })),
          referenceDocumentUri: count.id,
        });
        inventoryAdjustmentSuccess = true;
        if (result?.invalidCount > 0) {
          console.warn(`${result.invalidCount}件の商品が不正なIDのため除外されました`);
          toast(`⚠️ ${result.invalidCount}件の商品が不正なIDのため除外されました`);
        }
        // ✅ ローカル状態で更新後 count を組み立て。保存完了後に merge 結果を onAfterConfirm に渡し、商品グループごと表示でも完了ステータスが正しくなるようにする
        const locallyBuiltAdjust = buildUpdatedCountFromLocalState(count, lines, {
          isMultipleMode: true,
          targetProductGroupIds,
          productGroupId,
        });
        toast("棚卸を完了しました");
        setSubmitting(false);
        Promise.all([
          logInventoryCountToApi({
            locationId: count.locationId,
            locationName: locationName || count.locationName || "",
            items: allItemsToAdjust,
            sourceId: count.id,
          }).catch((e) => console.error("[InventoryCountList] logInventoryCountToApi error:", e)),
          readInventoryCountsRaw().then((counts) => {
            const idStr = String(count?.id ?? "");
            const list = Array.isArray(counts) ? counts : [];
            const fromStorage = list.find((c) => String(c?.id ?? "") === idStr);
            const toWrite = mergeCountWithStorage(fromStorage, locallyBuiltAdjust);
            const merged = list.some((c) => String(c?.id ?? "") === idStr)
              ? list.map((c) => (String(c?.id ?? "") === idStr ? toWrite : c))
              : [...list, toWrite];
            return writeInventoryCounts(merged).then(() => toWrite);
          }),
          clearAllInventoryCountDraftsForCount({
            countId: count.id,
            locationId: count.locationId,
            productGroupIds: count?.productGroupIds || targetProductGroupIds || [],
          }).catch((e) => console.error("Failed to clear inventory count draft:", e)),
        ]).then((results) => {
          const writeResult = results[1];
          if (writeResult) onAfterConfirm?.(writeResult);
        }).catch((e) => {
          toast(`保存に失敗しました: ${e?.message ?? e}`);
          onAfterConfirm?.(null);
        });
        return true;
        } catch (updateError) {
          const updateMsg = String(updateError?.message ?? updateError);
          console.error("[InventoryCountList] build updated error:", updateError);
          toast(`エラー: ${updateMsg}`);
        }
      setSubmitting(false);
      return false;
    }

    const currentGroupId = productGroupId || (targetProductGroupIds && targetProductGroupIds[0]) || null;
    if (!currentGroupId) {
      toast("商品グループが特定できません");
      return false;
    }

    if (itemsToAdjust.length === 0) {
      // ✅ 在庫差異なし：read → merge → write 後に merge 結果を onAfterConfirm に渡し、1グループのみ・グループごと表示でも完了ステータスが正しくなるようにする
      setSubmitting(true);
      setTimeout(() => {
        try {
          const locallyBuiltNoAdjust = buildUpdatedCountFromLocalState(count, lines, {
            isMultipleMode,
            targetProductGroupIds,
            productGroupId,
          });
          toast("棚卸を完了しました");
          readInventoryCountsRaw()
            .then((counts) => {
              const idStr = String(count?.id ?? "");
              const list = Array.isArray(counts) ? counts : [];
              const fromStorage = list.find((c) => String(c?.id ?? "") === idStr);
              const toWrite = mergeCountWithStorage(fromStorage, locallyBuiltNoAdjust);
              const merged = list.some((c) => String(c?.id ?? "") === idStr)
                ? list.map((c) => (String(c?.id ?? "") === idStr ? toWrite : c))
                : [...list, toWrite];
              return Promise.all([
                writeInventoryCounts(merged).then(() => toWrite),
                clearAllInventoryCountDraftsForCount({
                  countId: count.id,
                  locationId: count.locationId,
                  productGroupIds: count?.productGroupIds || targetProductGroupIds || [],
                }).catch((e) => console.error("Failed to clear inventory count draft:", e)),
              ]).then(([toWriteResult]) => toWriteResult);
            })
            .then((toWrite) => {
              if (toWrite) onAfterConfirm?.(toWrite);
              setSubmitting(false);
            })
            .catch((e) => {
              toast(`保存に失敗しました: ${e?.message ?? e}`);
              onAfterConfirm?.(null);
              setSubmitting(false);
            });
        } catch (e) {
          toast(`エラー: ${e?.message ?? e}`);
          onAfterConfirm?.(null);
          setSubmitting(false);
        }
      }, 0);
      return true;
    }

    setSubmitting(true);
    let inventoryAdjustmentSuccess = false;
    // ✅ 在庫調整前にlinesのスナップショットを作成（在庫調整後にcurrentQuantityが更新されるのを防ぐため）
    // linesの値を直接コピーして保存（参照ではなく値のコピー）
    // ✅ まとめて表示モードでは、編集可能な商品のみを対象とする
    const targetLines = isMultipleMode ? lines.filter((l) => !l.isReadOnly) : lines;
    const linesSnapshot = targetLines.map((l) => ({
      inventoryItemId: l.inventoryItemId,
      variantId: l.variantId,
      sku: l.sku ?? "",
      barcode: l.barcode ?? "", // ✅ barcodeを追加
      productTitle: l.productTitle ?? "",
      variantTitle: l.variantTitle ?? "",
      imageUrl: l.imageUrl ?? "", // ✅ 画像URLを追加（予定外商品の画像表示用）
      productGroupId: l.productGroupId, // ✅ まとめて表示モード用
      // ✅ 在庫調整前の値を保存（棚卸時の在庫数）
      currentQuantity: Number(l.currentQuantity ?? 0),
      // ✅ 確定した在庫数（実数）
      actualQuantity: Number(l.actualQuantity ?? 0),
      isExtra: Boolean(l.isExtra), // ✅ 予定外商品フラグを追加
    }));
    // ✅ スナップショットからgroupItemsエントリを作成
    const entryBeforeAdjustment = linesSnapshot.map((l) => ({
      inventoryItemId: l.inventoryItemId,
      variantId: l.variantId,
      sku: l.sku,
      barcode: l.barcode, // ✅ barcodeを追加
      title: [l.productTitle, l.variantTitle].filter(Boolean).join(" / ") || l.sku || "-",
      imageUrl: l.imageUrl, // ✅ 画像URLを追加（予定外商品の画像表示用）
      // ✅ 在庫は棚卸時の在庫数（currentQuantity）、実数は確定した在庫数（actualQuantity）
      currentQuantity: l.currentQuantity,
      isExtra: l.isExtra, // ✅ 予定外商品フラグを追加
      actualQuantity: l.actualQuantity,
      delta: l.actualQuantity - l.currentQuantity,
    }));
    try {
      try {
        // ✅ エラー要因を先に確認：在庫調整APIが失敗したらここで止める
        try {
          const result = await adjustInventoryToActual({
            locationId: count.locationId,
            items: itemsToAdjust.map((l) => ({
              inventoryItemId: l.inventoryItemId,
              currentQuantity: l.currentQuantity,
              actualQuantity: l.actualQuantity,
            })),
            referenceDocumentUri: count.id,
          });
          inventoryAdjustmentSuccess = true;
          if (result?.invalidCount > 0) {
            console.warn(`${result.invalidCount}件の商品が不正なIDのため除外されました`);
            toast(`⚠️ ${result.invalidCount}件の商品が不正なIDのため除外されました`);
          }
        } catch (adjustError) {
          const adjustMsg = String(adjustError?.message ?? adjustError);
          console.error("[InventoryCountList] adjustInventoryToActual error:", adjustError);
          toast(`在庫調整エラー: ${adjustMsg}`);
          setSubmitting(false);
          return false;
        }

        // ✅ ローカル状態で更新後 count を組み立て。保存完了後に merge 結果を onAfterConfirm に渡し、1グループのみ・グループごと表示でも完了ステータスが正しくなるようにする
        const locallyBuiltResult = buildUpdatedCountFromLocalState(count, lines, {
          isMultipleMode,
          targetProductGroupIds,
          productGroupId,
        });
        if (!inventoryAdjustmentSuccess || !locallyBuiltResult) {
          setSubmitting(false);
          return false;
        }
        toast("棚卸を完了しました");
        setSubmitting(false);
        Promise.all([
          logInventoryCountToApi({
            locationId: count.locationId,
            locationName: locationName || count.locationName || "",
            items: itemsToAdjust,
            sourceId: count.id,
          }).catch((e) => console.error("[InventoryCountList] logInventoryCountToApi error:", e)),
          readInventoryCountsRaw().then((counts) => {
            const idStr = String(count?.id ?? "");
            const list = Array.isArray(counts) ? counts : [];
            const fromStorage = list.find((c) => String(c?.id ?? "") === idStr);
            const toWrite = mergeCountWithStorage(fromStorage, locallyBuiltResult);
            const merged = list.some((c) => String(c?.id ?? "") === idStr)
              ? list.map((c) => (String(c?.id ?? "") === idStr ? toWrite : c))
              : [...list, toWrite];
            return writeInventoryCounts(merged).then(() => toWrite);
          }),
          clearAllInventoryCountDraftsForCount({
            countId: count.id,
            locationId: count.locationId,
            productGroupIds: count?.productGroupIds || targetProductGroupIds || [],
          }).catch((e) => console.error("Failed to clear inventory count draft:", e)),
        ]).then((results) => {
          const writeResult = results[1];
          if (writeResult) onAfterConfirm?.(writeResult);
        }).catch((e) => {
          toast(`保存に失敗しました: ${e?.message ?? e}`);
          onAfterConfirm?.(null);
        });
        return true;
      } catch (updateError) {
        const updateMsg = String(updateError?.message ?? updateError);
        console.error("[InventoryCountList] handleComplete error:", updateError);
        toast(`エラー: ${updateMsg}`);
        setSubmitting(false);
        return false;
      }
    } catch (e) {
      const msg = String(e?.message ?? e);
      toast(`エラー: ${msg}`);
      console.error("[InventoryCountList] handleComplete error:", e);
      return false;
    } finally {
      setSubmitting(false);
    }
  }, [count, itemsToAdjust, lines, onAfterConfirm, productGroupId, targetProductGroupIds, buildGroupItemsEntry]);

  // Header
  useEffect(() => {
    // countNameがあればそれを使用、なければidを使用（後方互換性）
    const headNo = count?.countName || count?.id || "棚卸ID";
    // ✅ 管理画面で保存済みの名前を優先（ID→名前の切り替えを防ぐ）
    // ✅ まとめて表示時：targetProductGroupIds の表示順で名前を取得
    // ✅ 商品グループごとに表示時：表示中の productGroupId に対応する名前を取得（count.productGroupName は先頭グループなど別グループの名前になっている場合があるため）
    const groupNameText = isMultipleMode
      ? (targetProductGroupIds?.length > 0
          ? targetProductGroupIds
              .map((id) => {
                const norm = normalizeIdForMatch(id);
                const fromMap = productGroupNames.get(norm);
                if (fromMap) return fromMap;
                const idx = Array.isArray(count?.productGroupIds) ? count.productGroupIds.findIndex((pid) => normalizeIdForMatch(pid) === norm) : -1;
                const fromCount = idx >= 0 && Array.isArray(count?.productGroupNames) ? count.productGroupNames[idx] : null;
                return fromCount || id;
              })
              .join(", ") || "商品グループ"
          : Array.from(productGroupNames.values()).join(", ") || "商品グループ")
      : (() => {
          const currentId = productGroupId || targetProductGroupIds?.[0];
          if (!currentId) return count?.productGroupName || productGroupName || "商品グループ";
          const norm = normalizeIdForMatch(currentId);
          const fromMap = productGroupNames.get(norm);
          if (fromMap) return fromMap;
          const idx = Array.isArray(count?.productGroupIds) ? count.productGroupIds.findIndex((pid) => normalizeIdForMatch(pid) === norm) : -1;
          const fromCount = idx >= 0 && Array.isArray(count?.productGroupNames) ? count.productGroupNames[idx] : null;
          return fromCount || productGroupName || currentId || "商品グループ";
        })();
    
    // デバッグ: countとloadingの状態を確認
    console.log("[InventoryCountList] Header useEffect", { 
      hasCount: !!count, 
      countId: count?.id, 
      loading, 
      linesLength: lines.length 
    });

    setHeader?.(
      <s-box padding="small">
        <s-stack gap="tight">
          <s-stack direction="inline" justifyContent="space-between" alignItems="flex-start" gap="small" style={{ width: "100%", flexWrap: "nowrap" }}>
            <s-stack gap="none" style={{ minWidth: 0, flex: "1 1 auto" }}>
              <s-text emphasis="bold" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {headNo}
              </s-text>
              <s-text size="small" tone="subdued" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                ロケーション：{locationName}
              </s-text>
              <s-text size="small" tone="subdued" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                商品グループ：{groupNameText}
              </s-text>
            </s-stack>
            {/* 右：軽量モード / 在庫更新 / データ数量反映 / リセット */}
            <s-stack
              direction="inline"
              gap="small"
              alignItems="center"
              style={{ flex: "0 0 auto", flexWrap: "nowrap", whiteSpace: "nowrap" }}
            >
              <s-button
                kind="secondary"
                tone={liteMode ? "critical" : undefined}
                onClick={handleToggleLiteMode}
                style={{ paddingInline: 8, whiteSpace: "nowrap" }}
              >
                {liteMode ? "画像OFF" : "画像ON"}
              </s-button>
              <s-button
                onClick={async () => {
                  if (readOnlyRef.current) return denyEdit();
                  if (!count || !count.locationId) {
                    toast("棚卸情報が取得できません");
                    return;
                  }
                  
                  // ✅ 出庫リスト同様：linesを直接参照せず、setLinesのコールバック内で参照する
                  let currentLines = [];
                  setLines((prev) => {
                    currentLines = prev;
                    if (prev.length === 0) return prev;
                    // ✅ 出庫リストと同じ方式：stockLoading: trueを設定して在庫数部分だけ「…」を表示
                    return prev.map((l) => ({ ...l, stockLoading: true, stockError: null }));
                  });
                  
                  if (currentLines.length === 0) {
                    toast("商品がありません");
                    return;
                  }
                  
                  // ✅ 出庫リストと同じ方式：loadingではなくrefreshingを使う（商品リストが消えないように）
                  setRefreshing(true);
                  try {
                    // ✅ 在庫数だけ更新、数量（actualQuantity）は保持。一括取得（50件/リクエスト）で高速化
                    const ids = currentLines.map((l) => l.inventoryItemId).filter(Boolean);
                    const qtyMap = await getCurrentQuantitiesBulk(ids, count.locationId, { noCache: true });
                    const lineIdToQty = new Map(
                      currentLines.map((l) => [
                        l.id,
                        l.inventoryItemId != null ? (qtyMap.get(l.inventoryItemId) ?? l.currentQuantity ?? 0) : (l.currentQuantity ?? 0),
                      ])
                    );
                    setLines((prev) =>
                      prev.map((l) => {
                        const qty = lineIdToQty.get(l.id);
                        if (qty === undefined) return { ...l, stockLoading: false };
                        return {
                          ...l,
                          currentQuantity: qty,
                          stockLoading: false,
                          stockError: null,
                        };
                      })
                    );
                    
                    toast("在庫を更新しました");
                  } catch (e) {
                    toast(`在庫更新エラー: ${e?.message || e}`);
                    // ✅ エラー時もstockLoading: falseを設定
                    setLines((prev) =>
                      prev.map((l) => ({ ...l, stockLoading: false, stockError: e?.message || String(e) }))
                    );
                  } finally {
                    setRefreshing(false);
                  }
                }}
                disabled={loading || isReadOnly}
                style={{ paddingInline: 8, whiteSpace: "nowrap" }}
              >
                在庫更新
              </s-button>
              <s-button
                onClick={() => {
                  if (readOnlyRef.current) return denyEdit();
                  setLines((prev) =>
                    prev.map((l) => {
                      // ✅ 確定済み（isReadOnly: true）の商品は編集しない
                      if (l.isReadOnly) return l;
                      return {
                        ...l,
                        actualQuantity: Number(l.currentQuantity || 0),
                      };
                    })
                  );
                  toast("全数量を反映しました");
                }}
                disabled={loading || refreshing || isReadOnly}
                style={{ paddingInline: 8, whiteSpace: "nowrap" }}
              >
                全数量反映
              </s-button>
              <s-button
                tone="critical"
                onClick={() => {
                  if (readOnlyRef.current) return denyEdit();
                  setLines((prev) =>
                    prev.map((l) => {
                      // ✅ 確定済み（isReadOnly: true）の商品は編集しない
                      if (l.isReadOnly) return l;
                      return {
                        ...l,
                        actualQuantity: 0,
                      };
                    })
                  );
                  toast("実数をリセットしました");
                }}
                disabled={loading || isReadOnly}
                style={{ paddingInline: 8, whiteSpace: "nowrap" }}
              >
                リセット
              </s-button>
            </s-stack>
          </s-stack>
          <s-box inlineSize="100%" paddingBlockStart="small-200">
            <s-text-field
              label="検索"
              labelHidden
              placeholder="商品名 / SKU / バーコード"
              value={query}
              disabled={isReadOnly}
              onInput={(v) => setQuery(String(v?.target?.value ?? v?.currentValue?.value ?? ""))}
              onChange={(v) => setQuery(String(v?.target?.value ?? v?.currentValue?.value ?? ""))}
            >
              {query ? (
                <s-button slot="accessory" kind="secondary" tone="critical" onClick={() => { setQuery(""); setCandidates([]); }}>
                  ✕
                </s-button>
              ) : null}
            </s-text-field>
          </s-box>
          {candidatesLoading ? <s-text tone="subdued" size="small">読み込み中...</s-text> : null}
          {candidates.length > 0 ? (
            <s-text tone="subdued" size="small">
              検索結果：{candidates.length}件
            </s-text>
          ) : null}
        </s-stack>
      </s-box>
    );
    return () => setHeader?.(null);
  }, [setHeader, count, locationName, productGroupName, productGroupId, isMultipleMode, productGroupNames, targetProductGroupIds, query, candidates.length, candidatesLoading, liteMode, loading, isReadOnly, denyEdit]);

  // Footer
  const currentTotal = useMemo(() => lines.reduce((s, l) => s + (l.currentQuantity || 0), 0), [lines]);
  const actualTotal = useMemo(() => lines.reduce((s, l) => s + (l.actualQuantity || 0), 0), [lines]);
  const deltaTotal = useMemo(() => actualTotal - currentTotal, [actualTotal, currentTotal]);
  const extraCount = useMemo(() => lines.filter((l) => l.isExtra).length, [lines]);
  const overTotal = useMemo(() => {
    return lines.reduce((s, l) => {
      const delta = (l.actualQuantity || 0) - (l.currentQuantity || 0);
      return s + Math.max(0, delta);
    }, 0);
  }, [lines]);
  const shortageTotal = useMemo(() => {
    return lines.reduce((s, l) => {
      const delta = (l.actualQuantity || 0) - (l.currentQuantity || 0);
      return s + Math.max(0, -delta);
    }, 0);
  }, [lines]);

  useEffect(() => {
    const statusLabel = count?.status === "completed" ? "完了" : count?.status === "cancelled" ? "キャンセル" : "未完了";
    const footerStatusTone = getStatusBadgeTone(statusLabel);
    const summaryCenter = (
      <s-stack direction="inline" gap="base" alignItems="center">
        <s-badge tone={footerStatusTone}>{statusLabel}</s-badge>
        <s-stack gap="extra-tight" alignItems="center">
          <s-text size="small" tone="subdued">
            明細 {lines.length} / 在庫 {currentTotal} / 実数 {actualTotal}
          </s-text>
          <s-text size="small" tone={overTotal > 0 || shortageTotal > 0 ? "critical" : "subdued"}>
            超過 {overTotal} / 不足 {shortageTotal}
          </s-text>
          {extraCount > 0 ? (
            <s-text size="small" tone="critical">
              予定外 {extraCount}
            </s-text>
          ) : null}
        </s-stack>
      </s-stack>
    );

    setFooter?.(
      <FixedFooterNavBar
        summaryLeft=""
        summaryCenter={summaryCenter}
        summaryRight=""
        leftLabel="戻る"
        onLeft={onBack}
        rightLabel={submitting ? "処理中..." : "確定"}
        onRight={() => {
          // command="--show"とcommandForでモーダルを開くため、ここでは何もしない
        }}
        rightCommand="--show"
        rightCommandFor={CONFIRM_INVENTORY_COUNT_MODAL_ID}
        rightTone="success"
        rightDisabled={submitting || lines.length === 0 || isReadOnly}
        centerAlignWithButtons={true}
      />
    );
    return () => setFooter?.(null);
  }, [setFooter, onBack, submitting, currentTotal, actualTotal, extraCount, overTotal, shortageTotal, lines.length, handleComplete, itemsToAdjust.length, isReadOnly, count?.status]);

  // 入庫と同じUI構造にするためのヘルパー関数とコンポーネント
  const toSafeId = (s) => String(s || "x").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60);
  
  const normalizeVariantTitleForDisplay_ = (productTitle, variantTitle) => {
    const p = String(productTitle || "").trim();
    const v = String(variantTitle || "").trim();
    if (!v) return "";
    if (v.toLowerCase() === "default title") return "";
    if (p && v === p) return "";
    return v;
  };

  const normalizeVariantOptions_ = (productTitle, variantTitle) => {
    const v = normalizeVariantTitleForDisplay_(productTitle, variantTitle);
    if (!v) return [];
    const parts = v.split("/").map((s) => s.trim()).filter(Boolean);
    return parts;
  };

  const formatOptionsLine_ = (options) => {
    const ops = Array.isArray(options) ? options.filter(Boolean) : [];
    if (ops.length === 0) return "";
    return ops.join(" / ");
  };

  const qtyValueWidthByDigits_ = (digits) => {
    if (digits <= 1) return 56;
    if (digits === 2) return 64;
    if (digits === 3) return 76;
    if (digits === 4) return 96;
    return 112;
  };

  const safeImageSrc_ = (maybeUrl) => {
    const u = typeof maybeUrl === "string" ? maybeUrl.trim() : "";
    if (!u) return "";
    if (u.startsWith("//")) return `https:${u}`;
    if (u.startsWith("https://")) return u;
    if (u.startsWith("http://")) return "";
    return u;
  };

  const Thumb = ({ imageUrl, sizePx = 44 }) => {
    const src = safeImageSrc_(imageUrl);
    if (!src) return null;
    const n = Number(sizePx) || 44;
    const size = `${n}px`;
    return (
      <s-box inlineSize={size} blockSize={size}>
        <s-image src={src} alt="" inlineSize="fill" objectFit="cover" />
      </s-box>
    );
  };

  const ItemLeftCompact = ({ showImages, imageUrl, productTitle, variantTitle, line3 }) => {
    const clip_ = (s, max) => {
      const t = String(s || "").trim();
      if (!t) return "";
      return t.length > max ? t.slice(0, max - 1) + "…" : t;
    };

    const pRaw = String(productTitle || "").trim() || "(unknown)";
    const vRaw = String(variantTitle || "").trim();
    const p = pRaw;
    const v = vRaw;

    const options = normalizeVariantOptions_(pRaw, v);
    const optionsLine = formatOptionsLine_(options);
    const optText = String(optionsLine || "").trim();
    const line3Text = String(line3 || "").trim();

    const Line = ({ children, strong = false, subdued = false }) => (
      <s-text
        type={strong ? "strong" : subdued ? "small" : "generic"}
        tone={subdued ? "subdued" : "auto"}
        style={{
          display: "block",
          whiteSpace: "normal",
          overflow: "visible",
          wordBreak: "break-word",
        }}
      >
        {children}
      </s-text>
    );

    return (
      <s-stack direction="inline" gap="base" alignItems="center" justifyContent="start">
        {showImages ? (
          <s-box inlineSize="44px" blockSize="44px" padding="none">
            <Thumb imageUrl={imageUrl || ""} sizePx={44} />
          </s-box>
        ) : null}
        <s-box minInlineSize="0">
          <s-stack gap="extra-tight">
            <Line strong>{p}</Line>
            {optText ? <Line subdued>{optText}</Line> : null}
            {line3Text ? <Line subdued>{line3Text}</Line> : null}
          </s-stack>
        </s-box>
      </s-stack>
    );
  };

  const StockyRowShell = ({ children }) => {
    return (
      <s-box paddingInline="none" paddingBlockStart="small-100" paddingBlockEnd="small-200">
        {children}
      </s-box>
    );
  };

  const QtyControlCompact_3Buttons = ({ value, min = 0, max = 999999, title = "数量", modalId, onDec, onInc, onSetQty, onRemove, step = 1, disabled = false }) => {
    const v = Number.isFinite(Number(value)) ? Number(value) : min;
    const id = useMemo(() => String(modalId), [modalId]);
    const [text, setText] = useState(String(v));

    useEffect(() => setText(String(v)), [v]);

    const clamp = (n) => Math.min(max, Math.max(min, Math.floor(Number(n || min))));
    const digits = String(v).length;
    const valueWidth = qtyValueWidthByDigits_(digits);
    const isDisabled = Boolean(disabled);

    return (
      <>
        <s-stack direction="inline" gap="extra-tight" alignItems="center" justifyContent="end" style={{ flexWrap: "nowrap" }}>
          <s-box inlineSize="44px">
            {(() => {
              const canRemove = typeof onRemove === "function";
              const isRemoveMode = canRemove && v <= min;
              return (
                <s-button
                  tone={isRemoveMode ? "critical" : undefined}
                  onClick={() => (isRemoveMode ? onRemove?.() : onDec?.())}
                  disabled={isDisabled || (!isRemoveMode && v <= min)}
                  style={{ width: "100%" }}
                >
                  {isRemoveMode ? "×" : "−"}
                </s-button>
              );
            })()}
          </s-box>
          <s-box inlineSize={`${valueWidth}px`}>
            <s-button command="--show" commandFor={id} disabled={isDisabled} style={{ width: "100%" }}>
              {v}
            </s-button>
          </s-box>
          <s-box inlineSize="44px">
            <s-button onClick={() => onInc?.()} disabled={isDisabled || v >= max} style={{ width: "100%" }}>
              +
            </s-button>
          </s-box>
        </s-stack>
        <s-modal id={id} heading={title}>
          <s-box padding="base" paddingBlockEnd="none">
            <s-stack gap="base">
              <s-text type="small" tone="subdued">数量を入力してください（{min}〜{max}）</s-text>
              <s-text-field
                label="数量"
                value={text}
                inputMode="numeric"
                onInput={(e) => setText(String(e?.target?.value ?? e ?? ""))}
                onChange={(e) => setText(String(e?.target?.value ?? e ?? ""))}
              />
              {/* ✅ レイアウト統一：下線、削除ボタン、下線、戻るボタン */}
              {onRemove ? (
                <>
                  <s-divider />
                  <s-box padding="none">
                    <s-button tone="critical" command="--hide" commandFor={id} onClick={() => onRemove?.()}>
                      削除
                    </s-button>
                  </s-box>
                  <s-divider />
                </>
              ) : null}
              {/* ✅ 戻るボタン */}
              <s-box padding="none">
                <s-button command="--hide" commandFor={id} onClick={() => {}}>
                  戻る
                </s-button>
              </s-box>
            </s-stack>
          </s-box>
          <s-button slot="primary-action" tone="success" command="--hide" commandFor={id} onClick={() => onSetQty?.(clamp(String(text).trim()))}>
            確定
          </s-button>
          {/* ✅ slot="footer"は使用しない（削除ボタンはモーダル内に配置） */}
        </s-modal>
      </>
    );
  };

  // 検索候補行（入庫の InboundCandidateRow と同一のコード処理）
  const InventoryCountCandidateRow = ({ c, idx, addQtyById, setAddQtyById }) => {
    const vid = String(c?.variantId || "").trim();
    if (!vid) return null;

    const productTitle = String(c?.productTitle || "").trim();
    const variantTitle = String(c?.variantTitle || "").trim();
    const sku = String(c?.sku || "").trim();
    const barcode = String(c?.barcode || "").trim();
    const skuLine = `${sku ? `SKU: ${sku}` : ""}${barcode ? `${sku ? " / " : ""}JAN: ${barcode}` : ""}`.trim();

    const shownQty = Math.max(0, Number(addQtyById?.[vid] ?? 0));
    const [text, setText] = useState(String(shownQty > 0 ? shownQty : 1));
    useEffect(() => setText(String(shownQty > 0 ? shownQty : 1)), [shownQty]);

    const modalId = toSafeId(`INV_CAND_QTY_${vid}`);
    const clampAdd = (s) => {
      const x = Number(String(s || "").replace(/[^\d]/g, ""));
      if (!Number.isFinite(x)) return 1;
      return Math.max(1, Math.min(999999, Math.floor(x)));
    };

    // ✅ 入庫と同様：resolved を候補 c から組み立てて addLine(resolved, delta) を呼ぶ
    const resolved = {
      variantId: vid,
      inventoryItemId: c?.inventoryItemId,
      productTitle,
      variantTitle,
      sku,
      barcode,
      imageUrl: c?.imageUrl || "",
    };

    const commitAddByQty = () => {
      const next = clampAdd(text);
      addLine(resolved, next);
      toast(`${barcode || sku || productTitle || "(no title)"} を追加しました（+${next}）`);
      setAddQtyById((prev) => {
        const cur = Number(prev?.[vid] || 0);
        return { ...prev, [vid]: cur + next };
      });
    };

    const addOne = () => {
      addLine(resolved, 1);
      toast(`${barcode || sku || productTitle || "(no title)"} を追加しました（+1）`);
      setAddQtyById((prev) => {
        const cur = Number(prev?.[vid] || 0);
        return { ...prev, [vid]: cur + 1 };
      });
    };

    const digits = String(shownQty).length;
    const valueWidth = qtyValueWidthByDigits_(digits);

    return (
      <s-box padding="none">
        <StockyRowShell key={vid}>
          <s-stack gap="extra-tight">
            <s-box style={{ width: "100%" }}>
              <ItemLeftCompact
                showImages={showImages && !liteMode}
                imageUrl={c?.imageUrl || ""}
                productTitle={productTitle || "(no title)"}
                variantTitle={variantTitle}
                line3={skuLine}
              />
            </s-box>
            <s-box inlineSize="100%">
              <s-stack direction="inline" gap="base" justifyContent="space-between" alignItems="center" style={{ width: "100%", flexWrap: "nowrap" }}>
                <s-box style={{ flex: "1 1 auto", minWidth: 0 }}>
                  <s-text tone="subdued" size="small" style={{ whiteSpace: "nowrap" }}>
                    在庫: —
                  </s-text>
                </s-box>
                <s-box style={{ flex: "0 0 auto" }}>
                  <s-stack direction="inline" gap="extra-tight" alignItems="center" justifyContent="end" style={{ flexWrap: "nowrap", whiteSpace: "nowrap" }}>
                    <s-box inlineSize={`${valueWidth}px`}>
                      <s-button command="--show" commandFor={modalId} onClick={() => setText(String(shownQty > 0 ? shownQty : 1))} style={{ width: "100%", whiteSpace: "nowrap" }}>
                        {shownQty}
                      </s-button>
                    </s-box>
                    <s-box inlineSize="44px">
                      <s-button tone="success" onClick={addOne} onPress={addOne} style={{ width: "100%", whiteSpace: "nowrap" }}>
                        +
                      </s-button>
                    </s-box>
                  </s-stack>
                </s-box>
              </s-stack>
            </s-box>
          </s-stack>
          <s-modal id={modalId} heading="数量を指定して追加">
            <s-box padding="base" paddingBlockEnd="none">
              <s-stack gap="base">
                <s-text tone="subdued" size="small">
                  数量を入力して「追加」を押してください（1〜999999）
                </s-text>
                <s-text-field
                  label="数量"
                  value={text}
                  inputMode="numeric"
                  placeholder="例: 20"
                  onInput={(e) => setText(String(e?.target?.value ?? e ?? ""))}
                  onChange={(e) => setText(String(e?.target?.value ?? e ?? ""))}
                />
                <s-divider />
                <s-box padding="none">
                  <s-button command="--hide" commandFor={modalId} onClick={() => {}}>
                    戻る
                  </s-button>
                </s-box>
              </s-stack>
            </s-box>
        <s-button slot="primary-action" tone="success" command="--hide" commandFor={modalId} onClick={commitAddByQty} onPress={commitAddByQty}>
          追加
        </s-button>
      </s-modal>
        </StockyRowShell>
        <s-divider />
      </s-box>
    );
  };

  // 商品リスト行（入庫のInboundAddedLineRow風）。memo で変更のあった行だけ再描画し、数量ボタン操作時の体感を軽くする
  const inventoryCountLineRowRef = useRef(null);
  if (inventoryCountLineRowRef.current === null) {
    inventoryCountLineRowRef.current = memo(function InventoryCountLineRow({
      line,
      onRemove,
      updateActualQuantity,
      setActualQuantity,
      showImages,
      liteMode,
    }) {
      const productTitle = String(line?.productTitle || "").trim();
      const variantTitle = String(line?.variantTitle || "").trim();
      const sku = String(line?.sku || "").trim();
      const barcode = String(line?.barcode || "").trim();
      const skuLine = `${sku ? `SKU:${sku}` : ""}${barcode ? `${sku ? " / " : ""}JAN:${barcode}` : ""}`.trim();

      const currentQty = Number(line?.currentQuantity ?? 0);
      const actualQty = Number(line?.actualQuantity ?? 0);
      const delta = actualQty - currentQty;
      const stockText = line?.stockLoading ? "…" : String(currentQty);
      const bottomLeft = `在庫 ${stockText} / 実数 ${actualQty}`;
      const bottomLeftTone = delta !== 0 ? "critical" : "subdued";

      const modalKey = line?.id || line?.inventoryItemId || "row";
      const modalId = `qty-inv-${toSafeId(modalKey)}`;

      return (
        <s-box padding="none">
          <StockyRowShell>
            <s-stack gap="extra-tight" inlineSize="100%">
              <s-box inlineSize="100%">
                <ItemLeftCompact
                  showImages={showImages && !liteMode}
                  imageUrl={line?.imageUrl || ""}
                  productTitle={productTitle}
                  variantTitle={variantTitle}
                  line3={skuLine}
                />
              </s-box>
              <s-box inlineSize="100%">
                <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between" style={{ width: "100%", flexWrap: "nowrap" }}>
                  <s-box style={{ flex: "1 1 auto", minWidth: 0 }}>
                    <s-text tone={bottomLeftTone === "critical" ? "critical" : "subdued"} size="small" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {bottomLeft}
                    </s-text>
                  </s-box>
                  <s-box style={{ flex: "0 0 auto" }}>
                    <QtyControlCompact_3Buttons
                      value={actualQty}
                      min={-999}
                      modalId={modalId}
                      onDec={() => updateActualQuantity(line.id, -1)}
                      onInc={() => updateActualQuantity(line.id, 1)}
                      onSetQty={(n) => setActualQuantity(line.id, n)}
                      onRemove={onRemove && actualQty <= 1 ? () => onRemove(line.id) : undefined}
                      disabled={line?.isReadOnly}
                    />
                  </s-box>
                </s-stack>
              </s-box>
            </s-stack>
          </StockyRowShell>
          <s-divider />
        </s-box>
      );
    });
  }
  const InventoryCountLineRow = inventoryCountLineRowRef.current;

  if (count?.id && isMinimalCount(count)) {
    if (countLoading) {
      return (
        <s-box padding="base">
          <s-text tone="subdued">読み込み中...</s-text>
        </s-box>
      );
    }
    if (countError || !fullCount) {
      return (
        <s-box padding="base">
          <s-text tone="critical">{countError || "棚卸の取得に失敗しました"}</s-text>
        </s-box>
      );
    }
  }

  return (
    <s-stack gap="base">
      {/* ✅ 検索結果（入庫式の候補リスト） */}
      {String(query || "").trim().length >= 1 ? (
        <s-box padding="base">
          <s-stack gap="extra-tight">
            <s-text size="small" tone="subdued">
              検索リスト 候補： {candidatesLoading ? "..." : candidates.length}件
            </s-text>
            {candidates.length > 0 ? (
              <>
                {candidates.map((c, idx) => {
                  const stableKey = String(c?.variantId || c?.inventoryItemId || c?.sku || c?.barcode || `${c?.productTitle}__${c?.variantTitle}`);
                  return (
                    <InventoryCountCandidateRow
                      key={stableKey}
                      c={c}
                      idx={idx}
                      addQtyById={addQtyById}
                      setAddQtyById={setAddQtyById}
                    />
                  );
                })}
                {searchPageInfo?.hasNextPage ? (
                  <s-box paddingBlockStart="small">
                    <s-button
                      kind="secondary"
                      disabled={loadingMoreSearch}
                      onClick={() => handleLoadMoreSearch()}
                      onPress={() => handleLoadMoreSearch()}
                    >
                      {loadingMoreSearch ? "読込中..." : "さらに読み込む"}
                    </s-button>
                  </s-box>
                ) : null}
              </>
            ) : candidatesLoading ? (
              <s-text tone="subdued" size="small">読み込み中...</s-text>
            ) : (
              <s-text tone="subdued" size="small">該当なし</s-text>
            )}
          </s-stack>
        </s-box>
      ) : null}

      {/* ✅ 商品リスト（入庫式） */}
      {loading ? (
        <s-box padding="base">
          <s-text tone="subdued" size="small">読み込み中...</s-text>
        </s-box>
      ) : (
        <>
          {/* ✅ 未読み込み商品がある場合は最上部に表示（入庫・出庫の読込ボタンと同様）。まとめて表示では「さらに読み込む」用のため、既に1件以上表示されているときのみ表示（0件のときは各グループ横の「読込」を使う） */}
          {hasMoreProducts && (!isMultipleMode || lines.length > 0) ? (
            <s-box padding="base">
              <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
                <s-text tone="subdued" size="small">
                  未読み込みの商品があります。（要読込）
                </s-text>
                <s-button
                  kind="secondary"
                  disabled={loadingMore}
                  onClick={() => handleLoadMoreProducts()}
                  onPress={() => handleLoadMoreProducts()}
                >
                  {loadingMore ? "読込中..." : "読込"}
                </s-button>
              </s-stack>
            </s-box>
          ) : null}

          {/* ✅ まとめて表示モード：商品グループごとにセクションを分けて表示 */}
          {isMultipleMode ? (() => {
            const normalLines = lines.filter((l) => !l.isExtra);
            // ✅ 一度も商品グループごとに表示で開いていなくても、グループリストと各グループの「読込」ボタンは表示する（lines=0 のときは早期 return しない）
            if (normalLines.length === 0 && lines.length === 0 && targetProductGroupIds.length === 0 && loadCompletedRef.current) {
              return (
                <s-box key="inventory_count_list" padding="small">
                  <s-stack gap="small">
                    <s-text emphasis="bold">棚卸リスト</s-text>
                    <s-text tone="subdued">商品がありません</s-text>
                  </s-stack>
                </s-box>
              );
            }
            
            // 商品グループごとにグループ化
            const linesByGroup = new Map();
            // ✅ すべてのtargetProductGroupIdsを初期化（未完了グループも表示するため）
            for (const groupId of targetProductGroupIds) {
              if (!linesByGroup.has(groupId)) {
                linesByGroup.set(groupId, []);
              }
            }
            // ✅ normalLinesから商品をグループ化
            for (const l of normalLines) {
              const groupId = l.productGroupId || targetProductGroupIds[0];
              if (!groupId) continue;
              if (!linesByGroup.has(groupId)) {
                linesByGroup.set(groupId, []);
              }
              linesByGroup.get(groupId).push(l);
            }
            
            return (
              <s-box key="inventory_count_list" padding="small">
                <s-stack gap="base">
                  <s-text emphasis="bold">棚卸リスト（全グループ）</s-text>
                  {Array.from(linesByGroup.entries()).map(([groupId, groupLines]) => {
                    const groupName = productGroupNames.get(normalizeIdForMatch(groupId)) || groupId;
                    // ✅ 完了判定：count.groupItems[groupId]が存在し、かつ配列の長さが0より大きい場合に完了と判定
                    // ✅ 確実に判定するため、countオブジェクトから直接取得
                    // ✅ 後方互換性：groupItemsがない場合、itemsフィールドから該当グループの商品をフィルタリング（InventoryCountProductGroupSelectionと同じロジック）
                    const groupItemsMap = count?.groupItems && typeof count.groupItems === "object" ? count.groupItems : {};
                    let groupItemsFromMap = getGroupItemsByKey(groupItemsMap, groupId);
                    // ✅ 後方互換性：groupItemsがない場合、loadProductsで既に処理されているが、表示時の判定でも確認
                    // ✅ 後方互換性：groupItemsがない場合、itemsフィールドから該当グループの商品をフィルタリング（InventoryCountProductGroupSelectionと同じロジック）
                    const countItemsLegacy = Array.isArray(count?.items) ? count.items : [];
                    if (groupItemsFromMap.length === 0 && targetProductGroupIds.length === 1 && countItemsLegacy.length > 0) {
                      // 単一グループの場合、itemsフィールドのデータをそのまま使用（簡易判定）
                      groupItemsFromMap = countItemsLegacy;
                    }
                    // ✅ 完了判定：groupItemsが存在するか、またはlinesにisReadOnly: trueの商品が含まれている場合に完了と判定
                    const hasGroupItems = groupItemsFromMap.length > 0;
                    const hasReadOnlyLines = groupLines.some((l) => l.isReadOnly === true);
                    const isGroupCompleted = hasGroupItems || hasReadOnlyLines;
                    // ✅ 完了済みグループの数量を計算
                    // ✅ hasGroupItemsがtrueの場合はgroupItemsFromMapから、falseの場合はlinesから直接計算
                    const completedTotalQty = hasGroupItems 
                      ? groupItemsFromMap.reduce((sum, it) => sum + Number(it?.actualQuantity ?? 0), 0)
                      : (hasReadOnlyLines ? groupLines.reduce((sum, l) => sum + Number(l?.actualQuantity ?? 0), 0) : 0);
                    const completedCurrentQty = hasGroupItems
                      ? groupItemsFromMap.reduce((sum, it) => sum + Number(it?.currentQuantity ?? 0), 0)
                      : (hasReadOnlyLines ? groupLines.reduce((sum, l) => sum + Number(l?.currentQuantity ?? 0), 0) : 0);
                    // ✅ 完了済み時は件数は groupItemsFromMap を優先（まとめて表示で1グループ目のみlinesに乗る場合の 0/0 を防ぐ）
                    const completedCount = isGroupCompleted && groupItemsFromMap.length > 0 && groupLines.length === 0
                      ? groupItemsFromMap.length
                      : groupLines.filter((l) => l.isReadOnly === true).length;
                    const totalCount = isGroupCompleted && groupItemsFromMap.length > 0 && groupLines.length === 0
                      ? groupItemsFromMap.length
                      : groupLines.length;
                    
                    // ✅ 未完了グループで商品リストが空の場合：グループごと「読込」ボタンを表示（STOCKTAKE_39GROUPS_UX_IMPROVEMENTS.md）
                    if (groupLines.length === 0 && !isGroupCompleted && !loading) {
                      const isLoadingThisGroup = loadingGroupId === groupId;
                      return (
                        <s-box key={groupId} padding="small">
                          <s-stack gap="small">
                            <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="small" style={{ width: "100%" }}>
                              <s-text emphasis="bold" tone="auto">
                                {groupName}
                              </s-text>
                              <s-stack direction="inline" gap="small" alignItems="center">
                                <s-badge tone="subdued">未完了</s-badge>
                                <s-button
                                  kind="secondary"
                                  disabled={loadingGroupId != null}
                                  onClick={() => loadGroupProducts(groupId)}
                                  onPress={() => loadGroupProducts(groupId)}
                                >
                                  {isLoadingThisGroup ? "読込中..." : "読込"}
                                </s-button>
                              </s-stack>
                            </s-stack>
                            <s-text tone="subdued" size="small">
                              {isLoadingThisGroup ? "読み込み中..." : "読込ボタンで商品リストを読み込みます"}
                            </s-text>
                          </s-stack>
                        </s-box>
                      );
                    }
                    
                    return (
                      <s-box key={groupId} padding="small" background={isGroupCompleted ? "subdued" : undefined}>
                        <s-stack gap="small">
                          <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="small" style={{ width: "100%" }}>
                            <s-text emphasis="bold" tone={isGroupCompleted ? "success" : "auto"}>
                              {groupName}
                            </s-text>
                            <s-stack direction="inline" gap="small" alignItems="center">
                              <s-badge tone={isGroupCompleted ? "success" : "subdued"}>
                                {isGroupCompleted ? "完了済み" : "未完了"}
                              </s-badge>
                              <s-text tone="subdued" size="small">
                                {isGroupCompleted
                                  ? (totalCount > 0 ? `${completedCount}/${totalCount} ` : "") + `実数${completedTotalQty}${completedCurrentQty > 0 ? `/${completedCurrentQty}` : ""}`
                                  : `${totalCount}件`}
                              </s-text>
                            </s-stack>
                          </s-stack>
                          <s-stack gap="none">
                            {/* ✅ 予定外商品を除外して表示（予定外リストは最下部に別表示） */}
                            {groupLines.filter((l) => !l.isExtra).map((l) => (
                              <InventoryCountLineRow
                                key={l.id}
                                line={l}
                                onRemove={undefined}
                                updateActualQuantity={updateActualQuantity}
                                setActualQuantity={setActualQuantity}
                                showImages={showImages}
                                liteMode={liteMode}
                              />
                            ))}
                          </s-stack>
                        </s-stack>
                      </s-box>
                    );
                  })}
                  {hasMoreProducts && (
                    <s-box padding="small" paddingBlockStart="base">
                      <s-button
                        kind="secondary"
                        disabled={loadingMore}
                        onClick={() => handleLoadMoreProducts()}
                        onPress={() => handleLoadMoreProducts()}
                      >
                        {loadingMore ? "読込中..." : "さらに読み込む"}
                      </s-button>
                    </s-box>
                  )}
                </s-stack>
              </s-box>
            );
          })() : (
            // ✅ 単一商品グループモード：既存の表示を維持
            (() => {
              const normalLines = lines.filter((l) => !l.isExtra);
              if (normalLines.length === 0 && lines.length === 0 && loadCompletedRef.current) {
                return (
                  <s-box key="inventory_count_list" padding="small">
                    <s-stack gap="small">
                      <s-text emphasis="bold">棚卸リスト</s-text>
                      <s-text tone="subdued">商品がありません</s-text>
                    </s-stack>
                  </s-box>
                );
              }
              if (normalLines.length === 0) return null;
              return (
                <s-box key="inventory_count_list" padding="small">
                  <s-stack gap="small">
                    <s-text emphasis="bold">棚卸リスト</s-text>
                    <s-stack gap="none">
                      {normalLines.map((l) => (
                        <InventoryCountLineRow
                          key={l.id}
                          line={l}
                          onRemove={undefined}
                          updateActualQuantity={updateActualQuantity}
                          setActualQuantity={setActualQuantity}
                          showImages={showImages}
                          liteMode={liteMode}
                        />
                      ))}
                    </s-stack>
                    {hasMoreProducts && (
                      <s-box paddingBlockStart="small">
                        <s-button
                          kind="secondary"
                          disabled={loadingMore}
                          onClick={() => handleLoadMoreProducts()}
                          onPress={() => handleLoadMoreProducts()}
                        >
                          {loadingMore ? "読込中..." : "さらに読み込む"}
                        </s-button>
                      </s-box>
                    )}
                  </s-stack>
                </s-box>
              );
            })()
          )}

          {/* ✅ 予定外リスト（最下部に別表示、入庫リストと同じスタイル） */}
          {(() => {
            const extraLines = lines.filter((l) => l.isExtra);
            if (extraLines.length === 0) return null;
            return (
              <s-box key="inventory_count_extra_list" padding="small">
                <s-stack gap="small">
                  {/* ✅ 入庫リストと同じタイトルスタイル */}
                  <s-text emphasis="bold">予定外リスト（リストにない商品）</s-text>
                  <s-stack gap="none">
                    {extraLines.map((l) => (
                      <InventoryCountLineRow
                        key={l.id}
                        line={l}
                        onRemove={removeLine}
                        updateActualQuantity={updateActualQuantity}
                        setActualQuantity={setActualQuantity}
                        showImages={showImages}
                        liteMode={liteMode}
                      />
                    ))}
                  </s-stack>
                </s-stack>
              </s-box>
            );
          })()}
        </>
      )}

      {/* ✅ 確定モーダル（入庫の確定モーダルを参考） */}
      <s-modal id={CONFIRM_INVENTORY_COUNT_MODAL_ID} heading="棚卸を確定しますか？">
        <s-box
          padding="base"
          paddingBlockEnd="none"
          style={{ paddingInline: 8, paddingBlockStart: 8, maxHeight: "60vh", overflowY: "auto" }}
        >
          <s-stack gap="base">
            {/* ✅ サマリー */}
            <s-stack gap="extra-tight">
              <s-text size="small" tone="subdued">
                在庫 {currentTotal} / 実数 {actualTotal}
              </s-text>
              {deltaTotal !== 0 ? (
                <s-text size="small" tone={deltaTotal > 0 ? "success" : "critical"}>
                  差分: {deltaTotal > 0 ? "+" : ""}{deltaTotal}
                </s-text>
              ) : null}
              <s-text size="small" tone="subdued">
                調整対象: {itemsToAdjust.length}件
              </s-text>
            </s-stack>

            {/* ✅ 調整対象の明細（1件だけ表示、残りは「他X件」） */}
            {itemsToAdjust.length > 0 ? (
              <s-stack gap="extra-tight">
                <s-text size="small" tone="critical" emphasis="bold">
                  在庫調整対象（{itemsToAdjust.length}件）
                </s-text>
                {itemsToAdjust.slice(0, 1).map((l) => {
                  const delta = l.actualQuantity - l.currentQuantity;
                  const title = [l.productTitle, l.variantTitle].filter(Boolean).join(" / ") || l.sku || "-";
                  return (
                    <s-text key={l.id} size="small" tone="subdued" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      ・{title}：{l.currentQuantity} → {l.actualQuantity} ({delta > 0 ? "+" : ""}{delta})
                    </s-text>
                  );
                })}
                {itemsToAdjust.length > 1 ? (
                  <s-text size="small" tone="subdued">
                    …他 {itemsToAdjust.length - 1} 件
                  </s-text>
                ) : null}
              </s-stack>
            ) : (
              <s-stack gap="extra-tight">
                <s-text size="small" tone="subdued">
                  在庫数に差異はありません。
                </s-text>
                <s-text size="small" tone="subdued">
                  「確定する」で棚卸を完了できます。
                </s-text>
              </s-stack>
            )}

            {/* ✅ 戻るボタン（入庫の確定モーダルと同じ実装） */}
            {/* refを付与し、確定成功時のプログラム的なモーダル閉じにも利用（別の隠しボタンは不要） */}
            <s-divider />
            <s-box>
              <s-button
                ref={hideConfirmModalRef}
                command="--hide"
                commandFor={CONFIRM_INVENTORY_COUNT_MODAL_ID}
                onClick={() => {
                  // 何も実行せずにモーダルを閉じる
                }}
              >
                戻る
              </s-button>
            </s-box>
          </s-stack>
        </s-box>

        
        <s-button
          slot="primary-action"
          tone="success"
          disabled={submitting}
          onClick={async () => {
            const ok = await handleComplete();
            if (ok) hideConfirmModalRef.current?.click?.();
          }}
          onPress={async () => {
            const ok = await handleComplete();
            if (ok) hideConfirmModalRef.current?.click?.();
          }}
        >
          確定する
        </s-button>
      </s-modal>
    </s-stack>
  );
}
