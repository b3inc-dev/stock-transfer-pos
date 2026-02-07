import { useState, useCallback, useEffect, useRef, useMemo } from "preact/hooks";
import { OrderConditions } from "./order/OrderConditions.jsx";
import { OrderProductList } from "./order/OrderProductList.jsx";
import { OrderHistoryList } from "./order/OrderHistoryList.jsx";
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

export function OrderScreen({ onBack, setHeader, setFooter, onViewChange, liteMode, onToggleLiteMode }) {
  const [view, setView] = useState(VIEW.CONDITIONS);
  const [conds, setConds] = useState(null);
  const [locations, setLocations] = useState([]);
  const [conditionsKey, setConditionsKey] = useState(0); // ✅ コンディション画面の再マウント用キー
  const [selectedLocationId, setSelectedLocationId] = useState(null);
  const [selectedLocationName, setSelectedLocationName] = useState("");
  const sessionLocationGid = useOriginLocationGidForScreen();
  const didSetDefaultLocationRef = useRef(false);

  useEffect(() => {
    if (didSetDefaultLocationRef.current) return;
    if (!sessionLocationGid) return;
    didSetDefaultLocationRef.current = true;
    setSelectedLocationId(sessionLocationGid);
  }, [sessionLocationGid]);

  useEffect(() => {
    if (!selectedLocationId) return;
    const loc = locations.find((l) => l.id === selectedLocationId);
    if (loc) {
      setSelectedLocationName(loc.name || "");
    }
  }, [selectedLocationId, locations]);

  // ✅ 親コンポーネントにviewの変更を通知
  useEffect(() => {
    if (typeof onViewChange === "function") {
      onViewChange(view);
    }
  }, [view, onViewChange]);

  const handleStart = useCallback((c) => {
    setConds(c);
    setView(VIEW.PRODUCT_LIST);
  }, []);
  const handleOpenHistory = useCallback(() => setView(VIEW.HISTORY), []);
  const handleBackFromProduct = useCallback(() => {
    setConds(null);
    setView(VIEW.CONDITIONS);
    // ✅ コンディション画面に戻った時に復元できるように、コンポーネントを再マウント
    setConditionsKey((k) => k + 1);
  }, []);
  const handleAfterConfirm = useCallback(() => {
    setConds(null);
    setView(VIEW.HISTORY);
  }, []);
  const handleBackFromHistory = useCallback(() => {
    setView(VIEW.CONDITIONS);
    // ✅ コンディション画面に戻った時に復元できるように、コンポーネントを再マウント
    setConditionsKey((k) => k + 1);
  }, []);

  if (view === VIEW.PRODUCT_LIST) {
    return (
      <OrderProductList
        conds={conds}
        onBack={handleBackFromProduct}
        onAfterConfirm={handleAfterConfirm}
        setHeader={setHeader}
        setFooter={setFooter}
        liteMode={liteMode}
        onToggleLiteMode={onToggleLiteMode}
      />
    );
  }
  if (view === VIEW.HISTORY) {
    return (
      <OrderHistoryList
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
    <OrderConditions
      key={conditionsKey} // ✅ キーを変更することで再マウント
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
