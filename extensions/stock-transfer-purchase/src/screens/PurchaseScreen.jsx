import { useState, useCallback, useEffect, useRef, useMemo } from "preact/hooks";
import { PurchaseConditions } from "./purchase/PurchaseConditions.jsx";
import { PurchaseProductList } from "./purchase/PurchaseProductList.jsx";
import { PurchaseHistoryList } from "./purchase/PurchaseHistoryList.jsx";

const SHOPIFY = globalThis?.shopify ?? {};

function useSessionLocationId() {
  const [rawId, setRawId] = useState(() => SHOPIFY?.session?.currentSession?.locationId ?? null);

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
      if (tickCount >= 50) clearInterval(iv);
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

function useOriginLocationGidForScreen() {
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

const VIEW = { CONDITIONS: "conditions", PRODUCT_LIST: "productList", HISTORY: "history" };

export function PurchaseScreen({ onBack, setHeader, setFooter, liteMode, onToggleLiteMode, onViewChange }) {
  const [view, setView] = useState(VIEW.CONDITIONS);
  const [purchaseConds, setPurchaseConds] = useState(null);
  const [locations, setLocations] = useState([]);
  const [conditionsKey, setConditionsKey] = useState(0);

  const handleStart = useCallback((c) => {
    setPurchaseConds(c ?? null);
    setView(VIEW.PRODUCT_LIST);
  }, []);
  const handleOpenHistory = useCallback(() => setView(VIEW.HISTORY), []);
  const handleBackFromProduct = useCallback(() => {
    setPurchaseConds(null);
    setView(VIEW.CONDITIONS);
    setConditionsKey((k) => k + 1);
  }, []);
  const handleBackFromHistory = useCallback(() => {
    setView(VIEW.CONDITIONS);
    setConditionsKey((k) => k + 1);
  }, []);

  useEffect(() => {
    if (typeof onViewChange === "function") {
      onViewChange(view);
    }
  }, [view, onViewChange]);

  if (view === VIEW.PRODUCT_LIST) {
    return (
      <PurchaseProductList
        conds={purchaseConds}
        onBack={handleBackFromProduct}
        onAfterConfirm={() => setView(VIEW.CONDITIONS)}
        setHeader={setHeader}
        setFooter={setFooter}
        liteMode={liteMode}
        onToggleLiteMode={onToggleLiteMode}
      />
    );
  }
  if (view === VIEW.HISTORY) {
    return (
      <PurchaseHistoryList
        onBack={handleBackFromHistory}
        locations={locations}
        setLocations={setLocations}
        setHeader={setHeader}
        setFooter={setFooter}
        liteMode={liteMode}
        onToggleLiteMode={onToggleLiteMode}
      />
    );
  }
  return (
    <PurchaseConditions
      key={conditionsKey}
      onBack={onBack}
      onStart={handleStart}
      onOpenHistory={handleOpenHistory}
      locations={locations}
      setLocations={setLocations}
      setHeader={setHeader}
      setFooter={setFooter}
      liteMode={liteMode}
      onToggleLiteMode={onToggleLiteMode}
    />
  );
}
