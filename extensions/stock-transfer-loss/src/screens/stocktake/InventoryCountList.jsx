import { useState, useMemo, useEffect, useCallback, useRef } from "preact/hooks";
import {
  fetchProductsByGroups,
  getCurrentQuantity,
  adjustInventoryToActual,
  searchVariants,
  readInventoryCounts,
  writeInventoryCounts,
  getLocationName,
  getProductGroupName,
  resolveVariantByCode,
} from "./stocktakeApi.js";
import { fetchSettings } from "../loss/lossApi.js";
import { FixedFooterNavBar } from "../loss/FixedFooterNavBar.jsx";

const SHOPIFY = globalThis?.shopify ?? {};
const toast = (m) => SHOPIFY?.toast?.show?.(String(m));

const SCAN_QUEUE_KEY = "stock_transfer_pos_inventory_count_scan_queue_v1";
const INVENTORY_COUNT_DRAFT_KEY = "stock_transfer_pos_inventory_count_draft_v1";
const CONFIRM_INVENTORY_COUNT_MODAL_ID = "confirm-inventory-count-modal";

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

// Debounceフック
function useDebounce(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
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
}) {
  const [lines, setLines] = useState([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false); // ✅ 在庫再取得用の別状態（出庫リストと同じ方式）
  const [submitting, setSubmitting] = useState(false);
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState([]);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [locationName, setLocationName] = useState("");
  const [productGroupName, setProductGroupName] = useState("");
  const [productGroupNames, setProductGroupNames] = useState(new Map());
  const scanQueueRef = useRef([]);
  const scanProcessingRef = useRef(false);
  const draftLoadedRef = useRef(false);
  const lastDraftCountIdRef = useRef(null); // ✅ 前回下書きを読み込んだcount.idを記録
  const lastDraftLocationIdRef = useRef(null); // ✅ 前回下書きを読み込んだlocationIdを記録
  const isLoadingProductsRef = useRef(false); // ✅ loadProducts実行中フラグ（自動保存をスキップするため）
  const hideConfirmModalRef = useRef(null);
  const initialInventoryItemIdsRef = useRef(new Set()); // ✅ 初期表示の商品IDを保持（予定外リスト判定用）
  const readOnlyRef = useRef(false);
  const toastReadOnlyOnceRef = useRef(false);

  const denyEdit = useCallback(() => {
    if (!toastReadOnlyOnceRef.current) {
      toast("この棚卸は処理済みのため編集できません");
      toastReadOnlyOnceRef.current = true;
    }
  }, []);

  // ✅ メニュー画面のprefsから初期値を読み込む
  const loadInitialLiteMode = () => {
    try {
      const raw = localStorage.getItem("stock_transfer_pos_ui_prefs_v1");
      const p = raw ? JSON.parse(raw) : null;
      return p && typeof p === "object" && p.liteMode === true;
    } catch {
      return false;
    }
  };
  const [liteMode, setLiteMode] = useState(loadInitialLiteMode);
  const showImages = !liteMode; // ✅ 軽量モードがOFFの時だけ画像表示

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
        if (mounted) setSettings({ version: 1, carriers: [] });
      }
    })();
    return () => { mounted = false; };
  }, []);
  
  // ✅ prefsの変更を監視してliteModeを更新
  useEffect(() => {
    const checkPrefs = () => {
      try {
        const raw = localStorage.getItem("stock_transfer_pos_ui_prefs_v1");
        const p = raw ? JSON.parse(raw) : null;
        const newLiteMode = p && typeof p === "object" && p.liteMode === true;
        setLiteMode(newLiteMode);
      } catch {}
    };
    const interval = setInterval(checkPrefs, 500);
    return () => clearInterval(interval);
  }, []);

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
  let groupItemsForCurrentGroupReadOnlyInitial = currentGroupIdInitial && groupItemsMapForReadOnlyInitial[currentGroupIdInitial] && Array.isArray(groupItemsMapForReadOnlyInitial[currentGroupIdInitial]) ? groupItemsMapForReadOnlyInitial[currentGroupIdInitial] : [];
  // ✅ 後方互換性：groupItemsがない場合、itemsフィールドから該当グループの商品をフィルタリング（簡易判定）
  const countItemsLegacyForReadOnlyInitial = Array.isArray(count?.items) ? count.items : [];
  if (groupItemsForCurrentGroupReadOnlyInitial.length === 0 && countItemsLegacyForReadOnlyInitial.length > 0 && currentGroupIdInitial) {
    // 単一グループの場合、itemsフィールドにデータがあれば完了と判定（簡易判定）
    const isSingleGroup = targetProductGroupIds.length === 1;
    if (isSingleGroup) {
      groupItemsForCurrentGroupReadOnlyInitial = countItemsLegacyForReadOnlyInitial;
    }
  }
  const isCurrentGroupCompletedInitial = groupItemsForCurrentGroupReadOnlyInitial.length > 0;
  const isReadOnlyInitial = readOnlyProp || count?.status === "completed" || isCurrentGroupCompletedInitial;
  
  // ✅ 初期値を設定
  useEffect(() => {
    setIsReadOnlyState(isReadOnlyInitial);
  }, [isReadOnlyInitial]);
  
  // ✅ 実際のisReadOnlyはloadProducts関数内で更新される
  const isReadOnly = isReadOnlyState;

  // ロケーション名と商品グループ名を取得
  useEffect(() => {
    const loadNames = async () => {
      if (count?.locationId) {
        const name = await getLocationName(count.locationId);
        setLocationName(name || count.locationName || "");
      }
      if (productGroupId) {
        const name = await getProductGroupName(productGroupId);
        setProductGroupName(name || "");
      }
      if (isMultipleMode && targetProductGroupIds.length > 0) {
        const groupMap = new Map();
        for (const id of targetProductGroupIds) {
          const name = await getProductGroupName(id);
          if (name) groupMap.set(id, name);
        }
        setProductGroupNames(groupMap);
      }
    };
    loadNames();
  }, [count, productGroupId, isMultipleMode, targetProductGroupIds]);

  // 商品リストを読み込む
  const loadProducts = useCallback(async () => {
    isLoadingProductsRef.current = true; // ✅ loadProducts開始時に即座にフラグを立てる（自動保存をスキップするため）
    if (!count || !count.locationId) {
      isLoadingProductsRef.current = false; // ✅ 早期リターン時はフラグを下ろす
      console.log("[InventoryCountList] loadProducts skipped: missing count or locationId", { count, locationId: count?.locationId });
      return;
    }
    if (targetProductGroupIds.length === 0) {
      isLoadingProductsRef.current = false; // ✅ 早期リターン時はフラグを下ろす
      console.log("[InventoryCountList] loadProducts skipped: targetProductGroupIds is empty", { 
        productGroupIds, 
        productGroupId, 
        countProductGroupIds: count?.productGroupIds,
        targetProductGroupIds 
      });
      return;
    }
    
    // ✅ count.idまたはlocationIdが変わった場合は、draftLoadedRefをリセット
    // ✅ または、前回下書きを読み込んだcount.id/locationIdと異なる場合もリセット
    const currentCountId = String(count.id || "").trim();
    const currentLocationId = String(count.locationId || "").trim();
    if (lastDraftCountIdRef.current !== currentCountId || lastDraftLocationIdRef.current !== currentLocationId) {
      draftLoadedRef.current = false;
      lastDraftCountIdRef.current = currentCountId;
      lastDraftLocationIdRef.current = currentLocationId;
    }
    const currentGroupId = productGroupId || targetProductGroupIds[0];
    const groupItemsMap = count?.groupItems && typeof count.groupItems === "object" ? count.groupItems : {};
    // ✅ 完了判定：groupItemsMap[currentGroupId]が存在し、かつ配列の長さが0より大きい場合に完了と判定
    // ✅ 確実に判定するため、currentGroupIdとgroupItemsMapの両方をチェック
    // ✅ 後方互換性：groupItemsがない場合、itemsフィールドから該当グループの商品をフィルタリング（InventoryCountProductGroupSelectionと同じロジック）
    let groupItemsForCurrentGroup = currentGroupId && groupItemsMap[currentGroupId] && Array.isArray(groupItemsMap[currentGroupId]) ? groupItemsMap[currentGroupId] : [];
    const countItemsLegacy = Array.isArray(count?.items) ? count.items : [];
    // ✅ 後方互換性：groupItemsがない場合、itemsフィールドから該当グループの商品をフィルタリング
    if (groupItemsForCurrentGroup.length === 0 && countItemsLegacy.length > 0 && currentGroupId) {
      try {
        const productFirst = Math.max(1, Math.min(250, Number(settings?.productList?.initialLimit ?? 250)));
        const products = await fetchProductsByGroups([currentGroupId], count.locationId, {
          productFirst,
          filterByInventoryLevel: false,
          includeImages: false,
          inventoryItemIdsByGroup: count?.inventoryItemIdsByGroup || null, // ✅ 生成時の商品リストを使用
        });
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
    const isMultipleGroups = targetProductGroupIds.length > 1 || (Array.isArray(count?.productGroupIds) && count.productGroupIds.length > 1);
    // ✅ グループごとに表示する場合：選択したグループのデータのみを表示（storedItemsFromGroupを優先）
    // ✅ 単一グループモードでgroupItemsにデータがない場合のみ、itemsフィールドを後方互換性として使用
    const storedItemsFromItems = !isMultipleGroups && !storedItemsFromGroup && Array.isArray(count?.items) && count.items.length > 0 ? count.items : null;
    // ✅ グループごとに表示する場合：選択したグループのデータのみを表示（storedItemsFromGroupを優先）
    const storedItems = storedItemsFromGroup || storedItemsFromItems;

    // ✅ readOnly判定：readOnlyPropがtrue、または選択したグループが完了している、または全体が完了している
    // ✅ 完了判定：groupItemsMap[currentGroupId]が存在し、かつ配列の長さが0より大きい場合に完了と判定
    // ✅ InventoryCountProductGroupSelectionと同じロジック：groupItemsが存在し、かつ配列の長さが0より大きい場合に完了と判定
    const isGroupCompleted = storedItemsFromGroup !== null && groupItemsForCurrentGroup.length > 0;
    const isReadOnlyCalculated = readOnlyProp || isGroupCompleted || count?.status === "completed";
    
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
        const products = await fetchProductsByGroups([currentGroupId], count.locationId, {
          productFirst,
          filterByInventoryLevel: false,
          includeImages: showImages && !liteMode,
          inventoryItemIdsByGroup: count?.inventoryItemIdsByGroup || null, // ✅ 生成時の商品リストを使用
        });
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
          linesFromGroup.filter((l) => !l.isExtra).map((l) => String(l.inventoryItemId || "").trim()).filter(Boolean)
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
          linesFromGroup.filter((l) => !l.isExtra).map((l) => String(l.inventoryItemId || "").trim()).filter(Boolean)
        );
      } finally {
        setLoading(false);
      }
      return;
    }

    console.log("[InventoryCountList] loadProducts starting", { 
      locationId: count.locationId, 
      targetProductGroupIds,
      isMultipleMode
    });
    // ✅ isLoadingProductsRef.currentは既にloadProducts関数の最初でtrueに設定済み
    setLoading(true);
    try {
      // ✅ まとめて表示モードの場合：各商品グループごとに完了済み/未完了を区別して処理
      if (isMultipleMode) {
        // ✅ 下書きを先に読み込む（まとめて表示モードでも下書きを復元）
        // ✅ まとめて表示モードでは、毎回下書きを読み込む（draftLoadedRefのチェックは行わない）
        let draftLines = [];
        try {
          if (SHOPIFY?.storage?.get) {
            const saved = await SHOPIFY.storage.get(INVENTORY_COUNT_DRAFT_KEY);
            if (saved && typeof saved === "object") {
              const savedCountId = String(saved.countId || "").trim();
              const savedLocationId = String(saved.locationId || "").trim();
              const currentCountId = String(count.id || "").trim();
              const currentLocationId = String(count.locationId || "").trim();
              
              if (savedCountId === currentCountId && savedLocationId === currentLocationId) {
                const savedLinesRaw = Array.isArray(saved.lines) ? saved.lines : [];
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
                    isReadOnly: Boolean(l?.isReadOnly), // ✅ まとめて表示モード用
                    isExtra: Boolean(l?.isExtra),
                    productGroupId: l?.productGroupId || null, // ✅ まとめて表示モード用
                  }))
                  .filter((l) => l.variantId || l.inventoryItemId);
                
                if (draftLines.length > 0) {
                  lastDraftCountIdRef.current = currentCountId;
                  lastDraftLocationIdRef.current = currentLocationId;
                  toast("下書きを復元しました");
                }
              }
            }
          }
        } catch (e) {
          console.error("Failed to load draft:", e);
        }
        
        // ✅ 下書きがある場合はそれを返す（まとめて表示モードでも下書きを優先）
        if (draftLines.length > 0) {
          isLoadingProductsRef.current = false; // ✅ 下書き復元前にフラグを下ろす（自動保存を有効化）
          setLines(draftLines);
          // ✅ 下書き復元時も初期表示の商品IDを記録（予定外リスト判定用）
          initialInventoryItemIdsRef.current = new Set(
            draftLines.filter((l) => !l.isExtra).map((l) => String(l.inventoryItemId || "").trim()).filter(Boolean)
          );
          // ✅ まとめて表示モードの場合、isReadOnlyStateを適切に設定
          const hasIncompleteGroups = draftLines.some((l) => !l.isReadOnly);
          const isAllCompleted = count?.status === "completed" || !hasIncompleteGroups;
          setIsReadOnlyState(isAllCompleted);
          setLoading(false);
          console.log("[InventoryCountList] Draft loaded (multiple mode), lines count:", draftLines.length);
          return;
        }
        
        const allLines = [];
        const groupItemsMap = count?.groupItems && typeof count.groupItems === "object" ? count.groupItems : {};
        // ✅ 後方互換性：groupItemsがない場合、itemsフィールドから該当グループの商品をフィルタリング
        const countItemsLegacy = Array.isArray(count?.items) ? count.items : [];
        
        // 各商品グループごとに処理
        for (const groupId of targetProductGroupIds) {
          const groupName = productGroupNames.get(groupId) || groupId;
          // ✅ 完了判定：groupItemsMap[groupId]が存在し、かつ配列の長さが0より大きい場合に完了と判定
          // ✅ 確実に判定するため、groupIdとgroupItemsMapの両方をチェック
          // ✅ 後方互換性：groupItemsがない場合、itemsフィールドから該当グループの商品をフィルタリング（InventoryCountProductGroupSelectionと同じロジック）
          let groupItemsForGroup = groupId && groupItemsMap[groupId] && Array.isArray(groupItemsMap[groupId]) ? groupItemsMap[groupId] : [];
          if (groupItemsForGroup.length === 0 && countItemsLegacy.length > 0) {
            // ✅ 後方互換性：groupItemsがない場合、itemsフィールドから該当グループの商品をフィルタリング
            // 商品グループの商品リストを取得してフィルタリング
            try {
              const productFirst = Math.max(1, Math.min(250, Number(settings?.productList?.initialLimit ?? 250)));
              const products = await fetchProductsByGroups([groupId], count.locationId, {
                productFirst,
                filterByInventoryLevel: false,
                includeImages: false,
              });
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
          
          if (completedItems) {
            // ✅ 完了済みのグループ：groupItemsから読み込んで読み取り専用で表示
            // ✅ 画像URLを取得するため、商品情報を取得
            try {
              const productFirst = Math.max(1, Math.min(250, Number(settings?.productList?.initialLimit ?? 250)));
              const products = await fetchProductsByGroups([groupId], count.locationId, {
                productFirst,
                filterByInventoryLevel: false,
                includeImages: showImages && !liteMode,
                inventoryItemIdsByGroup: count?.inventoryItemIdsByGroup || null, // ✅ 生成時の商品リストを使用
              });
              const productMap = new Map();
              products.forEach((p) => {
                if (p.inventoryItemId) {
                  productMap.set(String(p.inventoryItemId).trim(), p);
                }
              });
              
              // ✅ 予定外商品の画像URLを取得するため、Promise.allで並列処理
              const completedLines = await Promise.all(
                completedItems.map(async (it, i) => {
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
            // ✅ 未完了のグループ：商品リストをAPIから取得して編集可能で表示
            try {
              // ✅ 問題1の修正: filterByInventoryLevel: falseに変更（在庫レベルが0でも商品を表示）
              // ✅ 単一グループモードと同じロジックに統一（商品グループごとに選択した場合も表示されるため）
              const productFirst = Math.max(1, Math.min(250, Number(settings?.productList?.initialLimit ?? 250)));
              const products = await fetchProductsByGroups([groupId], count.locationId, {
                productFirst,
                filterByInventoryLevel: false,
                includeImages: showImages && !liteMode,
                inventoryItemIdsByGroup: count?.inventoryItemIdsByGroup || null, // ✅ 生成時の商品リストを使用
              });
              
              if (products.length === 0) {
                // ✅ 商品が0件でも、グループを表示するために空の配列を追加（表示ロジックで「商品を読み込み中...」が表示される）
                // ただし、allLinesには何も追加しない（表示ロジックで「商品がありません」が表示される）
                continue; // 次のグループへ
              }
              
              // ✅ 商品リストを取得して、在庫数を取得してlinesを作成
              let linesWithCurrent = [];
              try {
                linesWithCurrent = await Promise.all(
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
                        actualQuantity: 0, // ✅ 初期値は0（スキャンで積み上げる方式）
                        isReadOnly: false, // ✅ 未完了は編集可能
                        productGroupId: groupId, // ✅ どのグループに属するか記録
                      };
                    } catch (qtyError) {
                      // エラーが発生した商品も追加する（在庫数は0として扱う）
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
              } catch (promiseError) {
                throw promiseError;
              }
              
              allLines.push(...linesWithCurrent);
            } catch (e) {
              toast(`グループ「${groupName}」の商品読み込みに失敗しました: ${e?.message || e}`);
              // ✅ エラーが発生した場合でも、空の配列を追加してグループを表示（エラーメッセージを表示するため）
              // エラー時は何も追加しない（表示ロジックで「商品を読み込み中...」が表示される）
            }
          }
        }
        
        // ✅ まとめて表示モードの場合、isReadOnlyStateを適切に設定
        // ✅ 未完了グループ（isReadOnly: falseの商品）がある場合は編集可能、全て完了している場合は読み取り専用
        const hasIncompleteGroups = allLines.some((l) => !l.isReadOnly);
        const isAllCompleted = count?.status === "completed" || !hasIncompleteGroups;
        setIsReadOnlyState(isAllCompleted);
        
        isLoadingProductsRef.current = false; // ✅ 商品読み込み完了前にフラグを下ろす（自動保存を有効化）
        setLines(allLines);
        // ✅ 予定外商品を除外して初期表示の商品IDを記録（予定外リスト判定用）
        initialInventoryItemIdsRef.current = new Set(
          allLines.filter((l) => !l.isReadOnly && !l.isExtra).map((l) => String(l.inventoryItemId || "").trim()).filter(Boolean)
        );
        setLoading(false);
        return;
      }

      // ✅ 単一商品グループモード：既存の処理を維持
      // ✅ 下書きを先に読み込む（下書きがあればそれを優先、なければ商品リストを読み込む）
      let draftLines = [];
      if (!draftLoadedRef.current) {
        try {
          if (SHOPIFY?.storage?.get) {
            const saved = await SHOPIFY.storage.get(INVENTORY_COUNT_DRAFT_KEY);
            if (saved && typeof saved === "object") {
              const savedCountId = String(saved.countId || "").trim();
              const savedLocationId = String(saved.locationId || "").trim();
              const currentCountId = String(count.id || "").trim();
              const currentLocationId = String(count.locationId || "").trim();
              
              if (savedCountId === currentCountId && savedLocationId === currentLocationId) {
                const savedLinesRaw = Array.isArray(saved.lines) ? saved.lines : [];
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
                    actualQuantity: Number.isFinite(Number(l?.actualQuantity)) ? Number(l.actualQuantity) : 0, // 下書きから復元する場合は保存された値を使用
                    isExtra: Boolean(l?.isExtra), // ✅ 下書きから復元
                    productGroupId: l?.productGroupId || null, // ✅ まとめて表示モード用
                  }))
                  .filter((l) => l.variantId || l.inventoryItemId);
                
                if (draftLines.length > 0) {
                  draftLoadedRef.current = true;
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
        setLines(draftLines);
        // ✅ 下書き復元時も初期表示の商品IDを記録（予定外リスト判定用）
        initialInventoryItemIdsRef.current = new Set(
          draftLines.filter((l) => !l.isExtra).map((l) => String(l.inventoryItemId || "").trim()).filter(Boolean)
        );
        setLoading(false);
        console.log("[InventoryCountList] Draft loaded, lines count:", draftLines.length);
        return;
      }

      // 在庫レベルがある商品のみを取得（初期表示用）
      const productFirst = Math.max(1, Math.min(250, Number(settings?.productList?.initialLimit ?? 250)));
      const products = await fetchProductsByGroups(targetProductGroupIds, count.locationId, {
        productFirst,
        filterByInventoryLevel: true,
        includeImages: showImages && !liteMode,
        inventoryItemIdsByGroup: count?.inventoryItemIdsByGroup || null, // ✅ 生成時の商品リストを使用
      });
      console.log("[InventoryCountList] fetchProductsByGroups result", { productCount: products.length });
      
      // 現在在庫数を取得
      const linesWithCurrent = await Promise.all(
        products.map(async (p) => {
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
            actualQuantity: 0, // ✅ 初期値は0（スキャンで積み上げる方式）
          };
        })
      );
      isLoadingProductsRef.current = false; // ✅ 商品読み込み完了前にフラグを下ろす（自動保存を有効化）
      setLines(linesWithCurrent);
      // ✅ 初期表示の商品IDを記録（予定外リスト判定用）
      initialInventoryItemIdsRef.current = new Set(
        linesWithCurrent.map((l) => String(l.inventoryItemId || "").trim()).filter(Boolean)
      );
      console.log("[InventoryCountList] Products loaded, lines count:", linesWithCurrent.length);
    } catch (e) {
      toast(`商品の読み込みに失敗しました: ${e?.message || e}`);
      console.error("[InventoryCountList] loadProducts error:", e);
    } finally {
      setLoading(false);
      isLoadingProductsRef.current = false; // ✅ loadProducts完了時にフラグを下ろす
      console.log("[InventoryCountList] loadProducts completed, loading set to false");
    }
  }, [count, targetProductGroupIds, showImages, liteMode, readOnlyProp, productGroupId, isMultipleMode]);

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
    loadProducts();
  }, [loadProducts]);

  // ✅ 自動保存（lines変更時に下書きを保存）
  useEffect(() => {
    if (!count || !count.id || !count.locationId) return;
    if (isReadOnly) return; // 処理済み表示時は保存しない
    if (isLoadingProductsRef.current) return; // loadProducts実行中は保存しない（空のlinesで上書き保存されるのを防ぐ）
    if (draftLoadedRef.current && lines.length === 0) return; // 復元直後は保存しない

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
            isReadOnly: Boolean(l?.isReadOnly), // ✅ まとめて表示モード用（確定済みグループの状態を保存）
            isExtra: Boolean(l?.isExtra), // ✅ 予定外リスト判定を保存
            productGroupId: l?.productGroupId || null, // ✅ まとめて表示モード用
          }))
          .filter((l) => l.variantId || l.inventoryItemId);

        await SHOPIFY.storage.set(INVENTORY_COUNT_DRAFT_KEY, {
          version: 1,
          savedAt: Date.now(),
          countId: count.id,
          locationId: count.locationId,
          lines: minimized,
        });
      } catch (e) {
        console.error("Failed to save inventory count draft:", e);
      }
    }, 300); // 入庫と同じ300ms
    return () => clearTimeout(t);
  }, [lines, count?.id, count?.locationId, isReadOnly, isMultipleMode]);

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

        // 商品を検索して追加（VariantCache活用）
        try {
          const includeImages = showImages && !liteMode;
          const resolved = await resolveVariantByCode(code, { includeImages });
          
          if (!resolved?.variantId || !resolved?.inventoryItemId) {
            toast(`商品が見つかりません: ${code}`);
            return;
          }

          const currentQty = await getCurrentQuantity(resolved.inventoryItemId, count.locationId);
          // ✅ まとめて表示モードの場合：商品が属する最初の商品グループを設定（簡易実装）
          const assignedGroupId = isMultipleMode ? (targetProductGroupIds[0] || null) : null;
          const newLine = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            variantId: resolved.variantId,
            inventoryItemId: resolved.inventoryItemId,
            productTitle: resolved.productTitle ?? "",
            variantTitle: resolved.variantTitle ?? "",
            sku: resolved.sku ?? "",
            barcode: resolved.barcode ?? "",
            imageUrl: resolved.imageUrl ?? "",
            currentQuantity: currentQty !== null ? currentQty : 0,
            actualQuantity: 0, // ✅ 初期値は0（スキャンで積み上げる方式）
            isExtra: !initialInventoryItemIdsRef.current.has(String(resolved.inventoryItemId || "").trim()), // ✅ 予定外リスト判定
            productGroupId: assignedGroupId, // ✅ まとめて表示モード用
          };
            setLines((prev) => {
              const exists = prev.find((l) => l.inventoryItemId === resolved.inventoryItemId);
              if (exists) return prev;
              return [newLine, ...prev];
            });
            toast(`商品を追加しました: ${resolved.productTitle || resolved.sku}`);
        } catch (e) {
          toast(`スキャン処理エラー: ${e?.message || e}`);
        }
      } finally {
        scanProcessingRef.current = false;
      }
    };

    const interval = setInterval(processScanQueue, 500);
    return () => clearInterval(interval);
  }, [count, showImages, liteMode, denyEdit]);

  // 検索処理
  const debouncedQuery = useDebounce(query.trim(), 200);
  useEffect(() => {
    let mounted = true;
    const run = async () => {
      const q = String(debouncedQuery || "").trim();
      if (!q) {
        if (mounted) {
          setCandidates([]);
          setCandidatesLoading(false);
        }
        return;
      }
      setCandidatesLoading(true);
      try {
        const searchLimit = Math.max(10, Math.min(50, Number(settings?.searchList?.initialLimit ?? 50)));
        const list = await searchVariants(q, { first: searchLimit, includeImages: showImages && !liteMode });
        if (mounted) setCandidates(Array.isArray(list) ? list : []);
      } catch (e) {
        toast(`検索エラー: ${e?.message ?? e}`);
        if (mounted) setCandidates([]);
      } finally {
        if (mounted) setCandidatesLoading(false);
      }
    };
    run();
    return () => {
      mounted = false;
    };
  }, [debouncedQuery, showImages, liteMode, settings]);

  // 商品を追加（検索結果から）
  const addLine = useCallback(
    async (c) => {
      if (readOnlyRef.current) return denyEdit();
      if (!c?.inventoryItemId || !c?.variantId || !count) return;
      
      // 既に存在するかチェック
      setLines((prev) => {
        const hit = prev.find((l) => l.inventoryItemId === c.inventoryItemId || l.variantId === c.variantId);
        if (hit) {
          setQuery("");
          setCandidates([]);
          return prev;
        }
        return prev;
      });
      
      // 現在在庫数を取得
      let currentQty = 0;
      try {
        const qty = await getCurrentQuantity(c.inventoryItemId, count.locationId);
        currentQty = qty !== null ? qty : 0;
      } catch (e) {
        console.error("Failed to get current quantity:", e);
        currentQty = 0;
      }
      
      // 商品を追加
      // ✅ まとめて表示モードの場合：商品が属する最初の商品グループを設定（簡易実装）
      const assignedGroupId = isMultipleMode ? (targetProductGroupIds[0] || null) : null;
      setLines((prev) => {
        const hit = prev.find((l) => l.inventoryItemId === c.inventoryItemId || l.variantId === c.variantId);
        if (hit) return prev;
        return [
          {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            variantId: c.variantId,
            inventoryItemId: c.inventoryItemId,
            productTitle: c.productTitle ?? "",
            variantTitle: c.variantTitle ?? "",
            sku: c.sku ?? "",
            barcode: c.barcode ?? "",
            imageUrl: c.imageUrl ?? "",
            currentQuantity: currentQty,
            actualQuantity: 0, // ✅ 初期値は0（スキャンで積み上げる方式）
            isExtra: !initialInventoryItemIdsRef.current.has(String(c.inventoryItemId || "").trim()), // ✅ 予定外リスト判定
            productGroupId: assignedGroupId, // ✅ まとめて表示モード用
          },
          ...prev,
        ];
      });
      setQuery("");
      setCandidates([]);
    },
    [count, denyEdit]
  );

  // 実数を更新
  const updateActualQuantity = useCallback((id, delta) => {
    if (readOnlyRef.current) return denyEdit();
    setLines((prev) =>
      prev.map((l) => {
        if (String(l.id) !== String(id)) return l;
        // ✅ まとめて表示モードで完了済みの商品は編集不可
        if (l.isReadOnly) return denyEdit() || l;
        const newActual = Math.max(0, (l.actualQuantity || 0) + delta);
        return { ...l, actualQuantity: newActual };
      })
    );
  }, [denyEdit]);

  // 実数を直接入力
  const setActualQuantity = useCallback((id, value) => {
    if (readOnlyRef.current) return denyEdit();
    const num = Math.max(0, Number(value) || 0);
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
        toast("在庫数の変更がないため、調整は不要です");
        // 在庫調整なしでもgroupItemsに保存する
        try {
          const counts = await readInventoryCounts();
          const updated = counts.map((c) => {
            if (c.id !== count.id) return c;
            const groupItems = { ...(c.groupItems || {}) };
            
            // 各商品グループごとにgroupItemsに保存
            // ✅ カウントした商品があるグループのみ確定（actualQuantity > 0 または currentQuantity !== actualQuantity の商品がある場合のみ）
            for (const [groupId, groupLines] of linesByGroup.entries()) {
              const groupName = productGroupNames.get(groupId) || groupId;
              // ✅ グループ内にカウントした商品があるかチェック
              // ✅ actualQuantity > 0 の場合：実数が0より大きい（カウントした）
              // ✅ actualQuantity !== 0 && currentQuantity !== actualQuantity の場合：実数が0でなく、在庫数と実数が異なる（カウントした）
              // ✅ actualQuantity === 0 の場合は、カウントしていないと判断（確定しない）
              const hasCountedItems = groupLines.some((l) => {
                const actualQty = Number(l.actualQuantity ?? 0);
                const currentQty = Number(l.currentQuantity ?? 0);
                // ✅ 実数が0より大きい、または実数が0でなく在庫数と実数が異なる場合のみカウントしたと判断
                return actualQty > 0 || (actualQty !== 0 && currentQty !== actualQty);
              });
              
              // ✅ カウントした商品がないグループはスキップ（確定しない）
              if (!hasCountedItems) {
                groupStatusMessages.push(`「${groupName}」は未カウントのためスキップ`);
                continue;
              }
              
              const linesSnapshot = groupLines.map((l) => ({
                inventoryItemId: l.inventoryItemId,
                variantId: l.variantId,
                sku: l.sku ?? "",
                barcode: l.barcode ?? "", // ✅ barcodeを追加
                productTitle: l.productTitle ?? "",
                variantTitle: l.variantTitle ?? "",
                imageUrl: l.imageUrl ?? "", // ✅ 画像URLを追加（予定外商品の画像表示用）
                currentQuantity: Number(l.currentQuantity ?? 0),
                actualQuantity: Number(l.actualQuantity ?? 0),
                isExtra: Boolean(l.isExtra), // ✅ 予定外商品フラグを追加
              }));
              const entry = linesSnapshot.map((l) => ({
                inventoryItemId: l.inventoryItemId,
                variantId: l.variantId,
                sku: l.sku,
                barcode: l.barcode, // ✅ barcodeを追加
                title: [l.productTitle, l.variantTitle].filter(Boolean).join(" / ") || l.sku || "-",
                imageUrl: l.imageUrl, // ✅ 画像URLを追加（予定外商品の画像表示用）
                currentQuantity: l.currentQuantity,
                actualQuantity: l.actualQuantity,
                delta: l.actualQuantity - l.currentQuantity,
                isExtra: l.isExtra, // ✅ 予定外商品フラグを追加
              }));
              groupItems[groupId] = entry;
              groupStatusMessages.push(`「${groupName}」を確定しました`);
            }
            
            // ✅ 確定済みグループの確認
            const groupItemsMap = count?.groupItems && typeof count.groupItems === "object" ? count.groupItems : {};
            for (const groupId of targetProductGroupIds) {
              const groupName = productGroupNames.get(groupId) || groupId;
              // ✅ 既に確定済みのグループ（linesByGroupに含まれていない = isReadOnly: true）
              if (!linesByGroup.has(groupId)) {
                const groupItemsForGroup = groupId && groupItemsMap[groupId] && Array.isArray(groupItemsMap[groupId]) ? groupItemsMap[groupId] : [];
                if (groupItemsForGroup.length > 0) {
                  groupStatusMessages.push(`「${groupName}」は確定済みのためスキップ`);
                }
              }
            }
            
            const allIds = Array.isArray(c.productGroupIds) && c.productGroupIds.length > 0
              ? c.productGroupIds
              : c.productGroupId ? [c.productGroupId] : [];
            const allDone = allIds.length > 0 && allIds.every((id) => {
              const items = groupItems[id];
              return Array.isArray(items) && items.length > 0;
            });
            
            // ✅ 全商品グループのエントリをマージしてitemsに保存（後方互換性）
            // ✅ 未完了グループの商品も含めるため、linesから全商品を取得（linesByGroupには編集可能な商品のみが含まれる）
            const allItems = lines.filter((l) => {
              const groupId = l.productGroupId || targetProductGroupIds[0];
              return groupId && targetProductGroupIds.includes(groupId);
            });
            const mergedEntry = allItems.map((l) => ({
              inventoryItemId: l.inventoryItemId,
              variantId: l.variantId,
              sku: l.sku ?? "",
              barcode: l.barcode ?? "", // ✅ barcodeを追加
              title: [l.productTitle, l.variantTitle].filter(Boolean).join(" / ") || l.sku || "-",
              currentQuantity: Number(l.currentQuantity ?? 0),
              actualQuantity: Number(l.actualQuantity ?? 0),
              delta: Number(l.actualQuantity ?? 0) - Number(l.currentQuantity ?? 0),
              isExtra: Boolean(l.isExtra), // ✅ 予定外商品フラグを追加
            }));
            
            return {
              ...c,
              groupItems,
              status: allDone ? "completed" : "in_progress",
              completedAt: allDone ? new Date().toISOString() : undefined,
              items: mergedEntry,
            };
          });
          await writeInventoryCounts(updated);
          
          // ✅ 各グループの処理状況をトーストで表示
          if (groupStatusMessages.length > 0) {
            groupStatusMessages.forEach((msg) => toast(msg));
          }
          toast("棚卸を完了しました（在庫調整なし）");
          onAfterConfirm?.();
          return true;
        } catch (e) {
          toast(`エラー: ${e?.message ?? e}`);
          return false;
        }
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
        // 在庫調整を実行
        await adjustInventoryToActual({
          locationId: count.locationId,
          items: allItemsToAdjust.map((l) => ({
            inventoryItemId: l.inventoryItemId,
            currentQuantity: l.currentQuantity,
            actualQuantity: l.actualQuantity,
          })),
        });
        inventoryAdjustmentSuccess = true;
      } catch (adjustError) {
        const adjustMsg = String(adjustError?.message ?? adjustError);
        console.error("[InventoryCountList] adjustInventoryToActual error:", adjustError);
        toast(`在庫調整エラー: ${adjustMsg}`);
        setSubmitting(false);
        return false;
      }
      
      try {
        const counts = await readInventoryCounts();
        const updated = counts.map((c) => {
          if (c.id !== count.id) return c;
          const groupItems = { ...(c.groupItems || {}) };
          
          // 各商品グループごとにgroupItemsに保存
          // ✅ カウントした商品があるグループのみ確定（actualQuantity > 0 または currentQuantity !== actualQuantity の商品がある場合のみ）
          const groupStatusMessagesForAdjust = [];
          for (const [groupId, groupLines] of linesByGroup.entries()) {
            const groupName = productGroupNames.get(groupId) || groupId;
            const groupLinesSnapshot = linesSnapshot.filter((l) => l.productGroupId === groupId);
            
            // ✅ グループ内にカウントした商品があるかチェック（actualQuantity > 0 または currentQuantity !== actualQuantity）
            const hasCountedItems = groupLinesSnapshot.some((l) => {
              const actualQty = Number(l.actualQuantity ?? 0);
              const currentQty = Number(l.currentQuantity ?? 0);
              return actualQty > 0 || (actualQty !== 0 && currentQty !== actualQty);
            });
            
            // ✅ カウントした商品がないグループはスキップ（確定しない）
            if (!hasCountedItems) {
              groupStatusMessagesForAdjust.push(`「${groupName}」は未カウントのためスキップ`);
              continue;
            }
            
            const entry = groupLinesSnapshot.map((l) => ({
              inventoryItemId: l.inventoryItemId,
              variantId: l.variantId,
              sku: l.sku,
              barcode: l.barcode ?? "", // ✅ barcodeを追加（linesSnapshotから取得）
              title: [l.productTitle, l.variantTitle].filter(Boolean).join(" / ") || l.sku || "-",
              currentQuantity: l.currentQuantity,
              actualQuantity: l.actualQuantity,
              delta: l.actualQuantity - l.currentQuantity,
              isExtra: l.isExtra, // ✅ 予定外商品フラグを追加
            }));
            groupItems[groupId] = entry;
            groupStatusMessagesForAdjust.push(`「${groupName}」を確定しました`);
          }
          
          // ✅ 確定済みグループの確認
          const groupItemsMapForAdjust = count?.groupItems && typeof count.groupItems === "object" ? count.groupItems : {};
          for (const groupId of targetProductGroupIds) {
            const groupName = productGroupNames.get(groupId) || groupId;
            // ✅ 既に確定済みのグループ（linesByGroupに含まれていない = isReadOnly: true）
            if (!linesByGroup.has(groupId)) {
              const groupItemsForGroup = groupId && groupItemsMapForAdjust[groupId] && Array.isArray(groupItemsMapForAdjust[groupId]) ? groupItemsMapForAdjust[groupId] : [];
              if (groupItemsForGroup.length > 0) {
                groupStatusMessagesForAdjust.push(`「${groupName}」は確定済みのためスキップ`);
              }
            }
          }
          
          const allIds = Array.isArray(c.productGroupIds) && c.productGroupIds.length > 0
            ? c.productGroupIds
            : c.productGroupId ? [c.productGroupId] : [];
          const allDone = allIds.length > 0 && allIds.every((id) => {
            const items = groupItems[id];
            return Array.isArray(items) && items.length > 0;
          });
          
          // ✅ 全商品グループのエントリをマージしてitemsに保存（後方互換性）
          // ✅ 未完了グループの商品も含めるため、linesから全商品を取得（linesByGroupには編集可能な商品のみが含まれる）
          const allItems = lines.filter((l) => {
            const groupId = l.productGroupId || targetProductGroupIds[0];
            return groupId && targetProductGroupIds.includes(groupId);
          });
          const mergedEntry = allItems.map((l) => {
            const snapshot = linesSnapshot.find((s) => s.inventoryItemId === l.inventoryItemId);
            return {
              inventoryItemId: snapshot?.inventoryItemId || l.inventoryItemId,
              variantId: snapshot?.variantId || l.variantId,
              sku: snapshot?.sku ?? l.sku ?? "",
              barcode: snapshot?.barcode ?? l.barcode ?? "", // ✅ barcodeを追加
              title: [snapshot?.productTitle || l.productTitle, snapshot?.variantTitle || l.variantTitle].filter(Boolean).join(" / ") || snapshot?.sku || l.sku || "-",
              currentQuantity: snapshot?.currentQuantity ?? Number(l.currentQuantity ?? 0),
              actualQuantity: snapshot?.actualQuantity ?? Number(l.actualQuantity ?? 0),
              delta: (snapshot?.actualQuantity ?? Number(l.actualQuantity ?? 0)) - (snapshot?.currentQuantity ?? Number(l.currentQuantity ?? 0)),
              isExtra: snapshot?.isExtra ?? Boolean(l.isExtra), // ✅ 予定外商品フラグを追加
            };
          });
          
          return {
            ...c,
            groupItems,
            status: allDone ? "completed" : "in_progress",
            completedAt: allDone ? new Date().toISOString() : undefined,
            items: mergedEntry,
          };
          });
          await writeInventoryCounts(updated);
          
          // ✅ 各グループの処理状況をトーストで表示
          if (groupStatusMessagesForAdjust.length > 0) {
            groupStatusMessagesForAdjust.forEach((msg) => toast(msg));
          }
        } catch (updateError) {
          const updateMsg = String(updateError?.message ?? updateError);
          console.error("[InventoryCountList] writeInventoryCounts error:", updateError);
          toast(`警告: 在庫調整は完了しましたが、履歴の更新に失敗しました: ${updateMsg}`);
        }
        
        try {
          if (SHOPIFY?.storage?.delete) await SHOPIFY.storage.delete(INVENTORY_COUNT_DRAFT_KEY);
        } catch (e) {
          console.error("Failed to clear inventory count draft:", e);
        }
        
        if (inventoryAdjustmentSuccess) {
          toast("棚卸を完了しました");
          onAfterConfirm?.();
          setSubmitting(false);
          return true;
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
      toast("在庫数の変更がないため、調整は不要です");
      try {
        const counts = await readInventoryCounts();
        // ✅ まとめて表示モードの場合：各商品グループごとにgroupItemsに保存
        if (isMultipleMode) {
          // 編集可能な商品を商品グループごとにグループ化
          const editableLines = lines.filter((l) => !l.isReadOnly);
          const linesByGroup = new Map();
          for (const l of editableLines) {
            const groupId = l.productGroupId || targetProductGroupIds[0];
            if (!groupId) continue;
            if (!linesByGroup.has(groupId)) {
              linesByGroup.set(groupId, []);
            }
            linesByGroup.get(groupId).push(l);
          }
          
          const updated = counts.map((c) => {
            if (c.id !== count.id) return c;
            const groupItems = { ...(c.groupItems || {}) };
            
            // 各商品グループごとにgroupItemsに保存
            // ✅ カウントした商品があるグループのみ確定（actualQuantity > 0 または currentQuantity !== actualQuantity の商品がある場合のみ）
            const groupStatusMessagesForNoAdjust = [];
            for (const [groupId, groupLines] of linesByGroup.entries()) {
              const groupName = productGroupNames.get(groupId) || groupId;
              // ✅ グループ内にカウントした商品があるかチェック
              // ✅ actualQuantity > 0 の場合：実数が0より大きい（カウントした）
              // ✅ actualQuantity !== 0 && currentQuantity !== actualQuantity の場合：実数が0でなく、在庫数と実数が異なる（カウントした）
              // ✅ actualQuantity === 0 の場合は、カウントしていないと判断（確定しない）
              const hasCountedItems = groupLines.some((l) => {
                const actualQty = Number(l.actualQuantity ?? 0);
                const currentQty = Number(l.currentQuantity ?? 0);
                // ✅ 実数が0より大きい、または実数が0でなく在庫数と実数が異なる場合のみカウントしたと判断
                return actualQty > 0 || (actualQty !== 0 && currentQty !== actualQty);
              });
              
              // ✅ カウントした商品がないグループはスキップ（確定しない）
              if (!hasCountedItems) {
                groupStatusMessagesForNoAdjust.push(`「${groupName}」は未カウントのためスキップ`);
                continue;
              }
              
              const entry = groupLines.map((l) => ({
                inventoryItemId: l.inventoryItemId,
                variantId: l.variantId,
                sku: l.sku ?? "",
                barcode: l.barcode ?? "", // ✅ barcodeを追加
                title: [l.productTitle, l.variantTitle].filter(Boolean).join(" / ") || l.sku || "-",
                currentQuantity: Number(l.currentQuantity ?? 0),
                actualQuantity: Number(l.actualQuantity ?? 0),
                delta: Number(l.actualQuantity ?? 0) - Number(l.currentQuantity ?? 0),
                isExtra: Boolean(l.isExtra), // ✅ 予定外商品フラグを追加
              }));
              groupItems[groupId] = entry;
              groupStatusMessagesForNoAdjust.push(`「${groupName}」を確定しました`);
            }
            
            // ✅ 確定済みグループの確認
            const groupItemsMapForNoAdjust = count?.groupItems && typeof count.groupItems === "object" ? count.groupItems : {};
            for (const groupId of targetProductGroupIds) {
              const groupName = productGroupNames.get(groupId) || groupId;
              // ✅ 既に確定済みのグループ（linesByGroupに含まれていない = isReadOnly: true）
              if (!linesByGroup.has(groupId)) {
                const groupItemsForGroup = groupId && groupItemsMapForNoAdjust[groupId] && Array.isArray(groupItemsMapForNoAdjust[groupId]) ? groupItemsMapForNoAdjust[groupId] : [];
                if (groupItemsForGroup.length > 0) {
                  groupStatusMessagesForNoAdjust.push(`「${groupName}」は確定済みのためスキップ`);
                }
              }
            }
            
            const allIds = Array.isArray(c.productGroupIds) && c.productGroupIds.length > 0
              ? c.productGroupIds
              : c.productGroupId ? [c.productGroupId] : [];
            const allDone = allIds.length > 0 && allIds.every((id) => {
              const items = groupItems[id];
              return Array.isArray(items) && items.length > 0;
            });
            
            // ✅ 全商品グループのエントリをマージしてitemsに保存（後方互換性）
            // ✅ 未完了グループの商品も含めるため、linesから全商品を取得（linesByGroupには編集可能な商品のみが含まれる）
            const allItems = lines.filter((l) => {
              const groupId = l.productGroupId || targetProductGroupIds[0];
              return groupId && targetProductGroupIds.includes(groupId);
            });
            const mergedEntry = allItems.map((l) => ({
              inventoryItemId: l.inventoryItemId,
              variantId: l.variantId,
              sku: l.sku ?? "",
              barcode: l.barcode ?? "", // ✅ barcodeを追加
              title: [l.productTitle, l.variantTitle].filter(Boolean).join(" / ") || l.sku || "-",
              currentQuantity: Number(l.currentQuantity ?? 0),
              actualQuantity: Number(l.actualQuantity ?? 0),
              delta: Number(l.actualQuantity ?? 0) - Number(l.currentQuantity ?? 0),
              isExtra: Boolean(l.isExtra), // ✅ 予定外商品フラグを追加
            }));
            
            return {
              ...c,
              groupItems,
              status: allDone ? "completed" : "in_progress",
              completedAt: allDone ? new Date().toISOString() : undefined,
              items: mergedEntry,
            };
          });
          await writeInventoryCounts(updated);
          
          // ✅ 各グループの処理状況をトーストで表示
          if (groupStatusMessagesForNoAdjust.length > 0) {
            groupStatusMessagesForNoAdjust.forEach((msg) => toast(msg));
          }
        } else {
          // ✅ 単一商品グループモード：既存の処理を維持
          const linesSnapshot = lines.map((l) => ({
            inventoryItemId: l.inventoryItemId,
            variantId: l.variantId,
            sku: l.sku ?? "",
            barcode: l.barcode ?? "", // ✅ barcodeを追加
            productTitle: l.productTitle ?? "",
            variantTitle: l.variantTitle ?? "",
            imageUrl: l.imageUrl ?? "", // ✅ 画像URLを追加（予定外商品の画像表示用）
            currentQuantity: Number(l.currentQuantity ?? 0),
            actualQuantity: Number(l.actualQuantity ?? 0),
            isExtra: Boolean(l.isExtra), // ✅ 予定外商品フラグを追加
          }));
          const entry = linesSnapshot.map((l) => ({
            inventoryItemId: l.inventoryItemId,
            variantId: l.variantId,
            sku: l.sku,
            barcode: l.barcode, // ✅ barcodeを追加
            title: [l.productTitle, l.variantTitle].filter(Boolean).join(" / ") || l.sku || "-",
            imageUrl: l.imageUrl, // ✅ 画像URLを追加（予定外商品の画像表示用）
            currentQuantity: l.currentQuantity,
            actualQuantity: l.actualQuantity,
            isExtra: l.isExtra, // ✅ 予定外商品フラグを追加
            delta: l.actualQuantity - l.currentQuantity,
          }));
          const updated = counts.map((c) => {
            if (c.id !== count.id) return c;
            const groupItems = { ...(c.groupItems || {}) };
            groupItems[currentGroupId] = entry;
            const allIds = Array.isArray(c.productGroupIds) && c.productGroupIds.length > 0
              ? c.productGroupIds
              : c.productGroupId ? [c.productGroupId] : [];
            // ✅ 全グループが完了しているか判定：groupItems[id]が存在し、かつ配列の長さが0より大きい（入庫のシップメント完了判定と同じ実装）
            // 未処理のグループが1つでもあれば未完了（全グループが処理済みの場合のみ完了）
            const allDone = allIds.length > 0 && allIds.every((id) => {
              const items = groupItems[id];
              // ✅ 配列が存在し、かつ長さが0より大きい場合のみ完了と判定
              return Array.isArray(items) && items.length > 0;
            });
            // ✅ 全グループが完了していない場合は必ず"in_progress"に設定（既存のstatusを保持しない）
            return {
              ...c,
              groupItems,
              status: allDone ? "completed" : "in_progress",
              completedAt: allDone ? new Date().toISOString() : undefined,
              items: entry,
            };
          });
          await writeInventoryCounts(updated);
        }
        try {
          if (SHOPIFY?.storage?.delete) await SHOPIFY.storage.delete(INVENTORY_COUNT_DRAFT_KEY);
        } catch (e) {
          console.error("Failed to clear inventory count draft:", e);
        }
        toast("棚卸を完了しました（在庫調整なし）");
        onAfterConfirm?.();
        return true;
      } catch (e) {
        toast(`エラー: ${e?.message ?? e}`);
        return false;
      }
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
        await adjustInventoryToActual({
          locationId: count.locationId,
          items: itemsToAdjust.map((l) => ({
            inventoryItemId: l.inventoryItemId,
            currentQuantity: l.currentQuantity,
            actualQuantity: l.actualQuantity,
          })),
        });
        inventoryAdjustmentSuccess = true;
      } catch (adjustError) {
        const adjustMsg = String(adjustError?.message ?? adjustError);
        console.error("[InventoryCountList] adjustInventoryToActual error:", adjustError);
        toast(`在庫調整エラー: ${adjustMsg}`);
        return false;
      }

      try {
        const counts = await readInventoryCounts();
        // ✅ まとめて表示モードの場合：各商品グループごとにgroupItemsに保存
        if (isMultipleMode) {
          const updated = counts.map((c) => {
            if (c.id !== count.id) return c;
            const groupItems = { ...(c.groupItems || {}) };
            
            // 編集可能な商品を商品グループごとにグループ化
            const linesByGroup = new Map();
            for (const l of linesSnapshot) {
              const groupId = l.productGroupId || targetProductGroupIds[0];
              if (!groupId) continue;
              if (!linesByGroup.has(groupId)) {
                linesByGroup.set(groupId, []);
              }
              linesByGroup.get(groupId).push(l);
            }
            
            // 各商品グループごとにgroupItemsに保存
            // ✅ カウントした商品があるグループのみ確定（actualQuantity > 0 または currentQuantity !== actualQuantity の商品がある場合のみ）
            const groupStatusMessagesForSingleAdjust = [];
            for (const [groupId, groupLines] of linesByGroup.entries()) {
              const groupName = productGroupNames.get(groupId) || groupId;
              // ✅ グループ内にカウントした商品があるかチェック
              // ✅ actualQuantity > 0 の場合：実数が0より大きい（カウントした）
              // ✅ actualQuantity !== 0 && currentQuantity !== actualQuantity の場合：実数が0でなく、在庫数と実数が異なる（カウントした）
              // ✅ actualQuantity === 0 の場合は、カウントしていないと判断（確定しない）
              const hasCountedItems = groupLines.some((l) => {
                const actualQty = Number(l.actualQuantity ?? 0);
                const currentQty = Number(l.currentQuantity ?? 0);
                // ✅ 実数が0より大きい、または実数が0でなく在庫数と実数が異なる場合のみカウントしたと判断
                return actualQty > 0 || (actualQty !== 0 && currentQty !== actualQty);
              });
              
              // ✅ カウントした商品がないグループはスキップ（確定しない）
              if (!hasCountedItems) {
                groupStatusMessagesForSingleAdjust.push(`「${groupName}」は未カウントのためスキップ`);
                continue;
              }
              
              const entry = groupLines.map((l) => ({
                inventoryItemId: l.inventoryItemId,
                variantId: l.variantId,
                sku: l.sku,
                barcode: l.barcode ?? "", // ✅ barcodeを追加（linesSnapshotから取得）
                title: [l.productTitle, l.variantTitle].filter(Boolean).join(" / ") || l.sku || "-",
                imageUrl: l.imageUrl ?? "", // ✅ 画像URLを追加（予定外商品の画像表示用）
                currentQuantity: l.currentQuantity,
                actualQuantity: l.actualQuantity,
                delta: l.actualQuantity - l.currentQuantity,
                isExtra: Boolean(l.isExtra), // ✅ 予定外商品フラグを追加
              }));
              groupItems[groupId] = entry;
              groupStatusMessagesForSingleAdjust.push(`「${groupName}」を確定しました`);
            }
            
            // ✅ 確定済みグループの確認
            const groupItemsMapForSingleAdjust = count?.groupItems && typeof count.groupItems === "object" ? count.groupItems : {};
            for (const groupId of targetProductGroupIds) {
              const groupName = productGroupNames.get(groupId) || groupId;
              // ✅ 既に確定済みのグループ（linesByGroupに含まれていない = isReadOnly: true）
              if (!linesByGroup.has(groupId)) {
                const groupItemsForGroup = groupId && groupItemsMapForSingleAdjust[groupId] && Array.isArray(groupItemsMapForSingleAdjust[groupId]) ? groupItemsMapForSingleAdjust[groupId] : [];
                if (groupItemsForGroup.length > 0) {
                  groupStatusMessagesForSingleAdjust.push(`「${groupName}」は確定済みのためスキップ`);
                }
              }
            }
            
            const allIds = Array.isArray(c.productGroupIds) && c.productGroupIds.length > 0
              ? c.productGroupIds
              : c.productGroupId ? [c.productGroupId] : [];
            const allDone = allIds.length > 0 && allIds.every((id) => {
              const items = groupItems[id];
              return Array.isArray(items) && items.length > 0;
            });
            
            // ✅ 全商品グループのエントリをマージしてitemsに保存（後方互換性）
            // ✅ 未完了グループの商品も含めるため、linesから全商品を取得（linesByGroupには編集可能な商品のみが含まれる）
            const allItems = lines.filter((l) => {
              const groupId = l.productGroupId || targetProductGroupIds[0];
              return groupId && targetProductGroupIds.includes(groupId);
            });
            const mergedEntry = allItems.map((l) => ({
              inventoryItemId: l.inventoryItemId,
              variantId: l.variantId,
              sku: l.sku,
              title: [l.productTitle, l.variantTitle].filter(Boolean).join(" / ") || l.sku || "-",
              currentQuantity: l.currentQuantity,
              actualQuantity: l.actualQuantity,
              delta: l.actualQuantity - l.currentQuantity,
              isExtra: Boolean(l.isExtra), // ✅ 予定外商品フラグを追加
            }));
            
            return {
              ...c,
              groupItems,
              status: allDone ? "completed" : "in_progress",
              completedAt: allDone ? new Date().toISOString() : undefined,
              items: mergedEntry,
            };
          });
          await writeInventoryCounts(updated);
          
          // ✅ 各グループの処理状況をトーストで表示
          if (groupStatusMessagesForSingleAdjust.length > 0) {
            groupStatusMessagesForSingleAdjust.forEach((msg) => toast(msg));
          }
        } else {
          // ✅ 単一商品グループモード：既存の処理を維持
          const entry = entryBeforeAdjustment;
          const updated = counts.map((c) => {
            if (c.id !== count.id) return c;
            const groupItems = { ...(c.groupItems || {}) };
            groupItems[currentGroupId] = entry;
            const allIds = Array.isArray(c.productGroupIds) && c.productGroupIds.length > 0
              ? c.productGroupIds
              : c.productGroupId ? [c.productGroupId] : [];
            // ✅ 全グループが完了しているか判定：groupItems[id]が存在し、かつ配列の長さが0より大きい（入庫のシップメント完了判定と同じ実装）
            // 未処理のグループが1つでもあれば未完了（全グループが処理済みの場合のみ完了）
            const allDone = allIds.length > 0 && allIds.every((id) => {
              const items = groupItems[id];
              // ✅ 配列が存在し、かつ長さが0より大きい場合のみ完了と判定
              return Array.isArray(items) && items.length > 0;
            });
            // ✅ 全グループが完了していない場合は必ず"in_progress"に設定（既存のstatusを保持しない）
            return {
              ...c,
              groupItems,
              status: allDone ? "completed" : "in_progress",
              completedAt: allDone ? new Date().toISOString() : undefined,
              items: entry,
            };
          });
          await writeInventoryCounts(updated);
        }
      } catch (updateError) {
        const updateMsg = String(updateError?.message ?? updateError);
        console.error("[InventoryCountList] writeInventoryCounts error:", updateError);
        toast(`警告: 在庫調整は完了しましたが、履歴の更新に失敗しました: ${updateMsg}`);
      }

      try {
        if (SHOPIFY?.storage?.delete) await SHOPIFY.storage.delete(INVENTORY_COUNT_DRAFT_KEY);
      } catch (e) {
        console.error("Failed to clear inventory count draft:", e);
      }

      if (inventoryAdjustmentSuccess) {
        toast("棚卸を完了しました");
        onAfterConfirm?.();
        return true;
      }
      return false;
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
    const groupNameText = isMultipleMode
      ? Array.from(productGroupNames.values()).join(", ")
      : productGroupName || productGroupId || "商品グループ";
    
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
            {/* 右：軽量モード / 在庫再取得 / データ数量反映 / リセット */}
            <s-stack
              direction="inline"
              gap="small"
              alignItems="center"
              style={{ flex: "0 0 auto", flexWrap: "nowrap", whiteSpace: "nowrap" }}
            >
              <s-button
                kind="secondary"
                tone={liteMode ? "critical" : undefined}
                onClick={() => setLiteMode((prev) => !prev)}
                style={{ paddingInline: 8, whiteSpace: "nowrap" }}
              >
                軽量
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
                    // ✅ 出庫リスト同様：在庫数だけ更新、数量（actualQuantity）は保持
                    // ✅ キャッシュを無効化して最新の在庫数を取得
                    const results = await Promise.all(
                      currentLines.map(async (l) => {
                        if (!l.inventoryItemId) return { id: l.id, ok: true, currentQuantity: l.currentQuantity };
                        try {
                          const currentQty = await getCurrentQuantity(l.inventoryItemId, count.locationId, { noCache: true });
                          return { id: l.id, ok: true, currentQuantity: currentQty !== null ? currentQty : 0 };
                        } catch (e) {
                          return { id: l.id, ok: false, error: e?.message || String(e), currentQuantity: l.currentQuantity };
                        }
                      })
                    );
                    
                    // ✅ 既存のlinesを保持しつつ、currentQuantityだけ更新（stockLoading: falseも設定）
                    setLines((prev) =>
                      prev.map((l) => {
                        const r = results.find((x) => x.id === l.id);
                        if (!r) return { ...l, stockLoading: false };
                        if (!r.ok) {
                          console.warn(`在庫取得エラー (${l.id}): ${r.error}`);
                          return { ...l, stockLoading: false, stockError: r.error }; // エラー時もstockLoading: false
                        }
                        return {
                          ...l,
                          currentQuantity: r.currentQuantity,
                          stockLoading: false,
                          stockError: null,
                        };
                      })
                    );
                    
                    toast("在庫を更新しました");
                  } catch (e) {
                    toast(`在庫再取得エラー: ${e?.message || e}`);
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
                在庫再取得
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
          {candidatesLoading ? <s-text tone="subdued" size="small">検索中...</s-text> : null}
          {candidates.length > 0 ? (
            <s-text tone="subdued" size="small">
              検索結果：{candidates.length}件
            </s-text>
          ) : null}
        </s-stack>
      </s-box>
    );
    return () => setHeader?.(null);
  }, [setHeader, count, locationName, productGroupName, productGroupId, isMultipleMode, productGroupNames, query, candidates.length, candidatesLoading, liteMode, loading, isReadOnly, denyEdit]);

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
    const summaryCenter = (
      <s-stack gap="extra-tight" alignItems="center">
        <s-text size="small" tone="subdued">
          在庫 {currentTotal} / 実数 {actualTotal}
        </s-text>
        {extraCount > 0 ? (
          <s-text size="small" tone="critical">
            予定外 {extraCount}
          </s-text>
        ) : null}
        <s-text size="small" tone={overTotal > 0 || shortageTotal > 0 ? "critical" : "subdued"}>
          超過 {overTotal} / 不足 {shortageTotal}
        </s-text>
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
  }, [setFooter, onBack, submitting, currentTotal, actualTotal, extraCount, overTotal, shortageTotal, lines.length, handleComplete, itemsToAdjust.length, isReadOnly]);

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

  // 検索候補行（入庫のInboundCandidateRow風）
  const InventoryCountCandidateRow = ({ c, idx }) => {
    const vid = String(c?.variantId || "").trim();
    if (!vid) return null;

    const productTitle = String(c?.productTitle || "").trim();
    const variantTitle = String(c?.variantTitle || "").trim();
    const sku = String(c?.sku || "").trim();
    const barcode = String(c?.barcode || "").trim();
    const skuLine = `${sku ? `SKU: ${sku}` : ""}${barcode ? `${sku ? " / " : ""}JAN: ${barcode}` : ""}`.trim();

    const modalId = toSafeId(`INV_CAND_QTY_${vid}`);
    const [shownQty, setShownQty] = useState(1);
    const [text, setText] = useState("1");

    const clampAdd = (s) => {
      const x = Number(String(s || "").replace(/[^\d]/g, ""));
      if (!Number.isFinite(x)) return 1;
      return Math.max(1, Math.min(999999, Math.floor(x)));
    };

    const addOne = () => {
      addLine(c);
      setShownQty((prev) => prev + 1);
    };

    const commitAddByQty = () => {
      const next = clampAdd(text);
      addLine(c);
      setShownQty(next);
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
            <s-button slot="primary-action" tone="success" command="--hide" commandFor={modalId} onClick={commitAddByQty}>
              追加
            </s-button>
          </s-modal>
        </StockyRowShell>
        <s-divider />
      </s-box>
    );
  };

  // 商品リスト行（入庫のInboundAddedLineRow風）
  const InventoryCountLineRow = ({ line, onRemove }) => {
    const productTitle = String(line?.productTitle || "").trim();
    const variantTitle = String(line?.variantTitle || "").trim();
    const sku = String(line?.sku || "").trim();
    const barcode = String(line?.barcode || "").trim();
    const skuLine = `${sku ? `SKU:${sku}` : ""}${barcode ? `${sku ? " / " : ""}JAN:${barcode}` : ""}`.trim();

    const currentQty = Number(line?.currentQuantity ?? 0);
    const actualQty = Number(line?.actualQuantity ?? 0);
    const delta = actualQty - currentQty;
    // ✅ 出庫リストと同じ方式：stockLoadingがtrueの場合は「…」を表示
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
                    min={0}
                    modalId={modalId}
                    onDec={() => updateActualQuantity(line.id, -1)}
                    onInc={() => updateActualQuantity(line.id, 1)}
                    onSetQty={(n) => setActualQuantity(line.id, n)}
                    onRemove={onRemove && actualQty <= 1 ? () => onRemove(line.id) : undefined}
                    disabled={line?.isReadOnly} // ✅ まとめて表示モードで完了済みの商品は編集不可
                  />
                </s-box>
              </s-stack>
            </s-box>
          </s-stack>
        </StockyRowShell>
        <s-divider />
      </s-box>
    );
  };

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
                {candidates.slice(0, 50).map((c, idx) => {
                  const stableKey = String(c?.variantId || c?.inventoryItemId || c?.sku || c?.barcode || `${c?.productTitle}__${c?.variantTitle}`);
                  return <InventoryCountCandidateRow key={stableKey} c={c} idx={idx} />;
                })}
              </>
            ) : candidatesLoading ? (
              <s-text tone="subdued" size="small">検索中...</s-text>
            ) : (
              <s-text tone="subdued" size="small">該当なし</s-text>
            )}
          </s-stack>
        </s-box>
      ) : null}

      {/* ✅ 商品リスト（入庫式） */}
      {loading ? (
        <s-box padding="base">
          <s-text tone="subdued" size="small">商品を読み込み中...</s-text>
        </s-box>
      ) : (
        <>
          {/* ✅ 未読み込み商品リストがある場合は最上部に表示（入庫・出庫と同様の形式、ただしmetafieldは全件取得のため常に非表示） */}
          {/* 注意: 棚卸はmetafieldから全件取得しているため、実際には追加読み込みは不要 */}
          {/* pageInfoは常にfalseのため、読込ボタンは表示されない */}
          {false && (
            <s-box padding="base">
              <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
                <s-text tone="subdued" size="small">
                  未読み込み商品リストがあります。（要読込）
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

          {/* ✅ まとめて表示モード：商品グループごとにセクションを分けて表示 */}
          {isMultipleMode ? (() => {
            const normalLines = lines.filter((l) => !l.isExtra);
            if (normalLines.length === 0 && lines.length === 0) {
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
                    const groupName = productGroupNames.get(groupId) || groupId;
                    // ✅ 完了判定：count.groupItems[groupId]が存在し、かつ配列の長さが0より大きい場合に完了と判定
                    // ✅ 確実に判定するため、countオブジェクトから直接取得
                    // ✅ 後方互換性：groupItemsがない場合、itemsフィールドから該当グループの商品をフィルタリング（InventoryCountProductGroupSelectionと同じロジック）
                    const groupItemsMap = count?.groupItems && typeof count.groupItems === "object" ? count.groupItems : {};
                    let groupItemsFromMap = groupId && groupItemsMap[groupId] && Array.isArray(groupItemsMap[groupId]) ? groupItemsMap[groupId] : [];
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
                    const completedCount = groupLines.filter((l) => l.isReadOnly === true).length;
                    const totalCount = groupLines.length;
                    
                    // ✅ 未完了グループで商品リストが空の場合でも、グループタイトルを表示する
                    // ✅ loadingがfalseで、かつ商品リストが空の場合のみ「商品がありません」を表示
                    if (groupLines.length === 0 && !isGroupCompleted && !loading) {
                      return (
                        <s-box key={groupId} padding="small">
                          <s-stack gap="small">
                            <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="small">
                              <s-text emphasis="bold" tone="auto">
                                {groupName}
                              </s-text>
                              <s-text tone="subdued" size="small">
                                未完了 (0件)
                              </s-text>
                            </s-stack>
                            <s-text tone="subdued" size="small">
                              商品がありません
                            </s-text>
                          </s-stack>
                        </s-box>
                      );
                    }
                    
                    return (
                      <s-box key={groupId} padding="small" background={isGroupCompleted ? "subdued" : undefined}>
                        <s-stack gap="small">
                          <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="small">
                            <s-text emphasis="bold" tone={isGroupCompleted ? "success" : "auto"}>
                              {groupName}
                            </s-text>
                            <s-text tone="subdued" size="small">
                              {isGroupCompleted ? `完了済み (${completedCount}/${totalCount}) 実数${completedTotalQty}${completedCurrentQty > 0 ? `/${completedCurrentQty}` : ""}` : `未完了 (${totalCount}件)`}
                            </s-text>
                          </s-stack>
                          <s-stack gap="none">
                            {/* ✅ 予定外商品を除外して表示（予定外リストは最下部に別表示） */}
                            {groupLines.filter((l) => !l.isExtra).map((l) => (
                              <InventoryCountLineRow key={l.id} line={l} onRemove={undefined} />
                            ))}
                          </s-stack>
                        </s-stack>
                      </s-box>
                    );
                  })}
                </s-stack>
              </s-box>
            );
          })() : (
            // ✅ 単一商品グループモード：既存の表示を維持
            (() => {
              const normalLines = lines.filter((l) => !l.isExtra);
              if (normalLines.length === 0 && lines.length === 0) {
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
                        <InventoryCountLineRow key={l.id} line={l} onRemove={undefined} />
                      ))}
                    </s-stack>
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
                      <InventoryCountLineRow key={l.id} line={l} onRemove={removeLine} />
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
              <s-text size="small" tone="subdued">
                在庫数の変更がないため、調整は不要です。
              </s-text>
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
