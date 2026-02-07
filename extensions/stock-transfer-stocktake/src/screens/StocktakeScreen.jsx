import { useState, useCallback, useEffect, useRef, useMemo } from "preact/hooks";
import { InventoryCountConditions } from "./stocktake/InventoryCountConditions.jsx";
import { InventoryCountProductGroupSelection } from "./stocktake/InventoryCountProductGroupSelection.jsx";
import { InventoryCountList } from "./stocktake/InventoryCountList.jsx";

const SHOPIFY = globalThis?.shopify ?? {};
const toast = (m) => SHOPIFY?.toast?.show?.(String(m));

const VIEW = {
  CONDITIONS: "conditions",
  PRODUCT_GROUP_SELECTION: "productGroupSelection",
  PRODUCT_LIST: "productList",
};

// POS セッションのロケーションIDを取得（LossConditionsと同じ実装）
function useSessionLocationId() {
  const [rawId, setRawId] = useState(
    () => SHOPIFY?.session?.currentSession?.locationId ?? null
  );

  useEffect(() => {
    let alive = true;
    let tickCount = 0;

    const tick = () => {
      if (!alive) return;
      const next = SHOPIFY?.session?.currentSession?.locationId ?? null;
      setRawId((prev) => {
        const p = prev == null ? "" : String(prev);
        const n = next == null ? "" : String(next);
        return p === n ? prev : next;
      });
      tickCount += 1;
      if (next) return;
      if (tickCount >= 50) {
        clearInterval(iv);
      }
    };

    const iv = setInterval(tick, 100);
    tick();

    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, []);

  return rawId;
}

// POS セッションのロケーションGIDを取得（LossConditionsと同じ実装）
function useOriginLocationGid() {
  const raw = useSessionLocationId();
  return useMemo(() => {
    if (!raw) return null;
    const s = String(raw);
    if (s.startsWith("gid://shopify/Location/")) return s;
    if (/^\d+$/.test(s)) return `gid://shopify/Location/${s}`;
    const m = s.match(/Location\/(\d+)/);
    if (m?.[1]) return `gid://shopify/Location/${m[1]}`;
    return null;
  }, [raw]);
}

export function StocktakeScreen({ onBack, setHeader, setFooter, onViewChange, liteMode, onToggleLiteMode }) {
  const [view, setView] = useState(VIEW.CONDITIONS);
  const [count, setCount] = useState(null);
  const [selectedProductGroupId, setSelectedProductGroupId] = useState(null);
  const [selectedProductGroupIds, setSelectedProductGroupIds] = useState([]);
  const [productGroupMode, setProductGroupMode] = useState("single");
  const [listReadOnly, setListReadOnly] = useState(false);
  const [fromProductGroupSelection, setFromProductGroupSelection] = useState(false);
  const sessionLocationGid = useOriginLocationGid();
  const [locationGidManual, setLocationGidManual] = useState(null);
  const locationGid = locationGidManual ?? sessionLocationGid;

  // 親コンポーネントにviewの変更を通知
  useEffect(() => {
    if (typeof onViewChange === "function") {
      onViewChange(view);
    }
  }, [view, onViewChange]);

  // コンディション画面から商品グループ選択または商品リストへ
  const handleNext = useCallback(
    (params) => {
      if (params?.count) setCount(params.count);
      setListReadOnly(false);
      setFromProductGroupSelection(false);
      if (params?.productGroupId) {
        setSelectedProductGroupId(params.productGroupId);
        setSelectedProductGroupIds([params.productGroupId]);
        setProductGroupMode("single");
        setView(VIEW.PRODUCT_LIST);
      } else if (params?.productGroupIds && params?.productGroupMode) {
        setSelectedProductGroupIds(params.productGroupIds);
        setProductGroupMode(params.productGroupMode);
        if (params.productGroupMode === "multiple") {
          setView(VIEW.PRODUCT_LIST);
        } else {
          setView(VIEW.PRODUCT_GROUP_SELECTION);
        }
      }
    },
    []
  );

  // 商品グループ選択画面から商品リストへ
  const handleSelectProductGroup = useCallback(
    (params) => {
      if (params?.productGroupId) {
        setSelectedProductGroupId(params.productGroupId);
        setSelectedProductGroupIds([params.productGroupId]);
        setProductGroupMode("single");
        setListReadOnly(!!params?.readOnly);
        setFromProductGroupSelection(true);
        setView(VIEW.PRODUCT_LIST);
      }
    },
    []
  );

  // 商品リストから戻る
  const handleBackFromProductList = useCallback(() => {
    setListReadOnly(false);
    if (fromProductGroupSelection) {
      setFromProductGroupSelection(false);
      setView(VIEW.PRODUCT_GROUP_SELECTION);
    } else {
      setCount(null);
      setSelectedProductGroupId(null);
      setSelectedProductGroupIds([]);
      setProductGroupMode("single");
      setView(VIEW.CONDITIONS);
    }
  }, [fromProductGroupSelection]);

  // 商品グループ選択画面から戻る
  const handleBackFromProductGroupSelection = useCallback(() => {
    setView(VIEW.CONDITIONS);
  }, []);

  // 棚卸完了後の処理
  const handleAfterConfirm = useCallback(() => {
    setCount(null);
    setSelectedProductGroupId(null);
    setSelectedProductGroupIds([]);
    setProductGroupMode("single");
    setListReadOnly(false);
    setView(VIEW.CONDITIONS);
  }, []);

  // コンディション画面
  if (view === VIEW.CONDITIONS) {
    return (
      <InventoryCountConditions
        onNext={handleNext}
        onBack={onBack}
        onOpenProductGroupSelection={(c) => {
          setCount(c);
          setView(VIEW.PRODUCT_GROUP_SELECTION);
        }}
        liteMode={liteMode}
        onToggleLiteMode={onToggleLiteMode}
        setHeader={setHeader}
        setFooter={setFooter}
        locationGid={locationGid}
        onLocationChange={(id) => setLocationGidManual(id || null)}
      />
    );
  }

  // 商品グループ選択画面
  if (view === VIEW.PRODUCT_GROUP_SELECTION && count) {
    return (
      <InventoryCountProductGroupSelection
        count={count}
        onNext={handleSelectProductGroup}
        onBack={handleBackFromProductGroupSelection}
        setHeader={setHeader}
        setFooter={setFooter}
      />
    );
  }

  // 商品リスト画面（画像表示ON/OFFはコンディション画面と引き継ぐ）
  if (view === VIEW.PRODUCT_LIST && count) {
    return (
      <InventoryCountList
        countId={count.id}
        count={count}
        productGroupId={selectedProductGroupId}
        productGroupIds={selectedProductGroupIds}
        productGroupMode={productGroupMode}
        readOnly={listReadOnly}
        onBack={handleBackFromProductList}
        onAfterConfirm={handleAfterConfirm}
        setHeader={setHeader}
        setFooter={setFooter}
        locationGid={locationGid}
        liteMode={liteMode}
        onToggleLiteMode={onToggleLiteMode}
      />
    );
  }

  return null;
}
