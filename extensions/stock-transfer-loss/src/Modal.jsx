import { render, Component } from "preact";
import { useState, useCallback, useEffect, useRef } from "preact/hooks";
import { LossScreen } from "./screens/LossScreen.jsx";
import { StocktakeScreen } from "./screens/StocktakeScreen.jsx";

const SHOPIFY = globalThis?.shopify ?? {};
const toast = (m) => SHOPIFY?.toast?.show?.(String(m));

// UI設定の永続化（入庫/出庫と同じ実装）
const UI_PREFS_KEY = "stock_transfer_pos_ui_prefs_v1";

function loadUiPrefs_() {
  try {
    const raw = localStorage.getItem(UI_PREFS_KEY);
    const p = raw ? JSON.parse(raw) : null;
    return p && typeof p === "object" ? p : {};
  } catch {
    return {};
  }
}

function saveUiPrefs_(prefs) {
  try {
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify(prefs || {}));
  } catch {}
}

function useUiPrefs() {
  const [prefs, setPrefs] = useState(() => loadUiPrefs_());
  useEffect(() => saveUiPrefs_(prefs), [prefs]);
  return [prefs, setPrefs];
}

// =========================
// スキャンキュー管理（出庫/入庫と同じロジック）
// =========================

const LOSS_SCAN_QUEUE_KEY = "stock_transfer_pos_loss_scan_queue_v1";

function normalizeScanQueueObj_(raw) {
  // ✅ 旧形式（配列）→ 新形式へ
  if (Array.isArray(raw)) {
    const items = raw
      .map((x) => {
        if (typeof x === "string") return x.trim();
        // 旧：{v,t} 形式も吸収
        return String(x?.v || "").trim();
      })
      .filter(Boolean);
    const lastV = items[items.length - 1] || "";
    return { items, lastV, lastT: Date.now(), updatedAt: Date.now() };
  }

  // ✅ 新形式（object）
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
    const cur = normalizeScanQueueObj_(await storage.get(LOSS_SCAN_QUEUE_KEY));

    // 同一値の短時間連打は捨てる（m-pop等の二重イベント対策）
    if (cur.lastV === v && Math.abs(now - Number(cur.lastT || 0)) < 350) return;

    const nextItems = [...cur.items, v];

    // 店舗で「最大1000件/回」を想定 → 余裕見て 5000 まで保持（必要なら増やしてOK）
    const MAX_ITEMS = 5000;
    const trimmed = nextItems.length > MAX_ITEMS ? nextItems.slice(nextItems.length - MAX_ITEMS) : nextItems;

    await storage.set(LOSS_SCAN_QUEUE_KEY, {
      items: trimmed,
      lastV: v,
      lastT: now,
      updatedAt: now,
    });
  } catch (e) {
    console.error("pushScanToQueue_ failed", e);
  }
}

export default async () => {
  try {
    const root = document.body;
    render(null, root);
    render(
      <ErrorBoundary>
        <Extension />
      </ErrorBoundary>,
      root
    );
  } catch (e) {
    console.error(e);
    SHOPIFY?.toast?.show?.(`Render Error: ${e?.message ?? e}`);
  }
};

class ErrorBoundary extends Component {
  constructor() {
    super();
    this.state = { err: null };
  }
  componentDidCatch(err) {
    console.error(err);
    this.setState({ err });
    try {
      SHOPIFY?.toast?.show?.(`UI Error: ${err?.message ?? err}`);
    } catch {}
  }
  render(props, state) {
    if (state.err) {
      return (
        <s-page heading="エラー">
          <s-box padding="base">
            <s-text tone="critical">{String(state.err?.message ?? state.err)}</s-text>
          </s-box>
        </s-page>
      );
    }
    return props.children;
  }
}

const VIEW = { MENU: "menu", LOSS: "loss", STOCKTAKE: "stocktake" };

// LossScreen内のVIEW定数（LossScreen.jsxと同期）
const LOSS_VIEW = { CONDITIONS: "conditions", PRODUCT_LIST: "productList", HISTORY: "history" };

// StocktakeScreen内のVIEW定数（StocktakeScreen.jsxと同期）
const STOCKTAKE_VIEW = { CONDITIONS: "conditions", PRODUCT_GROUP_SELECTION: "productGroupSelection", PRODUCT_LIST: "productList" };

function Extension() {
  const [view, setView] = useState(VIEW.MENU);
  const [header, setHeader] = useState(null);
  const [footer, setFooter] = useState(null);
  const [lossView, setLossView] = useState(LOSS_VIEW.CONDITIONS); // LossScreen内の現在のviewを追跡
  const [stocktakeView, setStocktakeView] = useState(STOCKTAKE_VIEW.CONDITIONS); // StocktakeScreen内の現在のviewを追跡
  const [prefs, setPrefs] = useUiPrefs();

  const goMenu = useCallback(() => setView(VIEW.MENU), []);
  const goLoss = useCallback(() => setView(VIEW.LOSS), []);
  const goStocktake = useCallback(() => setView(VIEW.STOCKTAKE), []);

  // ✅ スキャナー購読（出庫/入庫と同じ実装）
  const lossViewRef = useRef(lossView);
  const stocktakeViewRef = useRef(stocktakeView);
  useEffect(() => {
    lossViewRef.current = lossView;
  }, [lossView]);
  useEffect(() => {
    stocktakeViewRef.current = stocktakeView;
  }, [stocktakeView]);

  useEffect(() => {
    const subscribe = SHOPIFY?.scanner?.scannerData?.current?.subscribe;
    if (typeof subscribe !== "function") {
      return;
    }

    const unsub = SHOPIFY.scanner.scannerData.current.subscribe((result) => {
      const data = String(result?.data || "").trim();
      const source = String(result?.source || "");
      if (!data) return;

      // ✅ 重要：ロス商品リスト画面の時だけキューに積む
      const currentView = view;
      const currentLossView = lossViewRef.current;
      if (currentView === VIEW.LOSS && currentLossView === LOSS_VIEW.PRODUCT_LIST) {
        pushScanToQueue_(data);
        return;
      }

      // ✅ 重要：棚卸商品リスト画面の時だけキューに積む
      const currentStocktakeView = stocktakeViewRef.current;
      if (currentView === VIEW.STOCKTAKE && currentStocktakeView === STOCKTAKE_VIEW.PRODUCT_LIST) {
        // 棚卸用のスキャンキューに積む（InventoryCountList内で処理）
        const STOCKTAKE_SCAN_QUEUE_KEY = "stock_transfer_pos_inventory_count_scan_queue_v1";
        pushScanToQueueForStocktake_(data, STOCKTAKE_SCAN_QUEUE_KEY);
      }
    });

    return () => {
      try {
        unsub?.();
      } catch {}
    };
  }, [view, lossView, stocktakeView]);

  // 棚卸用のスキャンキューに積む関数
  async function pushScanToQueueForStocktake_(value, queueKey) {
    const storage = SHOPIFY?.storage;
    if (!storage?.get || !storage?.set) return;
    const v = String(value || "").trim();
    if (!v) return;
    try {
      const now = Date.now();
      const raw = await storage.get(queueKey);
      // normalizeScanQueueObj_と同じロジック
      let cur;
      if (Array.isArray(raw)) {
        const items = raw
          .map((x) => {
            if (typeof x === "string") return x.trim();
            return String(x?.v || "").trim();
          })
          .filter(Boolean);
        const lastV = items[items.length - 1] || "";
        cur = { items, lastV, lastT: Date.now(), updatedAt: Date.now() };
      } else if (raw && typeof raw === "object") {
        const items = Array.isArray(raw.items)
          ? raw.items.map((s) => String(s || "").trim()).filter(Boolean)
          : [];
        cur = {
          items,
          lastV: String(raw.lastV || items[items.length - 1] || ""),
          lastT: Number(raw.lastT || 0),
          updatedAt: Number(raw.updatedAt || 0),
        };
      } else {
        cur = { items: [], lastV: "", lastT: 0, updatedAt: 0 };
      }
      
      if (cur.lastV === v && Math.abs(now - Number(cur.lastT || 0)) < 350) return;
      const nextItems = [...cur.items, v];
      const MAX_ITEMS = 5000;
      const trimmed = nextItems.length > MAX_ITEMS ? nextItems.slice(nextItems.length - MAX_ITEMS) : nextItems;
      await storage.set(queueKey, {
        items: trimmed,
        lastV: v,
        lastT: now,
        updatedAt: now,
      });
    } catch (e) {
      console.error("pushScanToQueueForStocktake_ failed", e);
    }
  }

  useEffect(() => {
    if (view === VIEW.MENU || view === VIEW.STOCKTAKE) {
      setHeader(null);
      setFooter(null);
    }
  }, [view]);

  let body = null;
  if (view === VIEW.LOSS) {
    body = <LossScreen onBack={goMenu} setHeader={setHeader} setFooter={setFooter} onViewChange={setLossView} />;
  } else if (view === VIEW.STOCKTAKE) {
    body = <StocktakeScreen onBack={goMenu} setHeader={setHeader} setFooter={setFooter} onViewChange={setStocktakeView} />;
  } else {
    const liteMode = prefs?.liteMode === true;
    const toggleLite = () => {
      const nextLite = !liteMode;
      setPrefs((p) => ({
        ...(p || {}),
        liteMode: nextLite,
        showImages: !nextLite,
      }));
    };

    body = (
      <s-box padding="base">
        <s-stack gap="base">
          <s-text emphasis="bold">メニュー</s-text>

          <s-stack direction="inline" gap="base" alignItems="center">
            <s-button kind="secondary" tone={liteMode ? "critical" : undefined} onClick={toggleLite}>
              軽量モード（画像OFF） {liteMode ? "ON" : "OFF"}
            </s-button>
          </s-stack>

          <s-divider />

          <s-button tone="success" onClick={goLoss}>ロス</s-button>
          <s-button tone="success" onClick={goStocktake}>棚卸</s-button>
        </s-stack>
      </s-box>
    );
  }

  return (
    <s-page heading="在庫調整">
      <s-stack gap="none" blockSize="100%" inlineSize="100%" minBlockSize="0">
        {header ? (
          <>
            <s-box padding="none">{header}</s-box>
            <s-divider />
          </>
        ) : null}
        <s-scroll-box padding="none" blockSize="auto" maxBlockSize="100%" minBlockSize="0">
          <s-box padding="none">{body}</s-box>
        </s-scroll-box>
        {footer ? (
          <>
            <s-divider />
            <s-box padding="none">{footer}</s-box>
          </>
        ) : null}
      </s-stack>
    </s-page>
  );
}
