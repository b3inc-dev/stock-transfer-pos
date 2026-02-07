import { useState, useCallback, useEffect } from "preact/hooks";
import { LossConditions } from "./loss/LossConditions.jsx";
import { LossProductList } from "./loss/LossProductList.jsx";
import { LossHistoryList } from "./loss/LossHistoryList.jsx";

const VIEW = { CONDITIONS: "conditions", PRODUCT_LIST: "productList", HISTORY: "history" };

export function LossScreen({ onBack, setHeader, setFooter, onViewChange }) {
  const [view, setView] = useState(VIEW.CONDITIONS);
  const [conds, setConds] = useState(null);
  const [locations, setLocations] = useState([]);
  const [conditionsKey, setConditionsKey] = useState(0); // ✅ コンディション画面の再マウント用キー

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
      <LossProductList
        conds={conds}
        onBack={handleBackFromProduct}
        onAfterConfirm={handleAfterConfirm}
        setHeader={setHeader}
        setFooter={setFooter}
      />
    );
  }
  if (view === VIEW.HISTORY) {
    return (
      <LossHistoryList
        onBack={handleBackFromHistory}
        locations={locations}
        setLocations={setLocations}
        setHeader={setHeader}
        setFooter={setFooter}
      />
    );
  }
  return (
    <LossConditions
      key={conditionsKey} // ✅ キーを変更することで再マウント
      onBack={onBack}
      onStart={handleStart}
      onOpenHistory={handleOpenHistory}
      locations={locations}
      setLocations={setLocations}
      setHeader={setHeader}
      setFooter={setFooter}
    />
  );
}
