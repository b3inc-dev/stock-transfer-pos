import { render, Component } from "preact";
import { useState, useCallback, useEffect, useRef } from "preact/hooks";
import { OrderScreen } from "./screens/OrderScreen.jsx";

const SHOPIFY = globalThis?.shopify ?? {};
const toast = (m) => SHOPIFY?.toast?.show?.(String(m));

let posModalApi = null;

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

const ORDER_SCAN_QUEUE_KEY = "stock_transfer_pos_order_scan_queue_v1";

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
    const cur = normalizeScanQueueObj_(await storage.get(ORDER_SCAN_QUEUE_KEY));

    // 同一値の短時間連打は捨てる（m-pop等の二重イベント対策）
    if (cur.lastV === v && Math.abs(now - Number(cur.lastT || 0)) < 350) return;

    const nextItems = [...cur.items, v];

    // 店舗で「最大1000件/回」を想定 → 余裕見て 5000 まで保持（必要なら増やしてOK）
    const MAX_ITEMS = 5000;
    const trimmed = nextItems.length > MAX_ITEMS ? nextItems.slice(nextItems.length - MAX_ITEMS) : nextItems;

    await storage.set(ORDER_SCAN_QUEUE_KEY, {
      items: trimmed,
      lastV: v,
      lastT: now,
      updatedAt: now,
    });
  } catch (e) {
    console.error("pushScanToQueue_ failed", e);
  }
}

export default async (rootArg, apiArg) => {
  if (rootArg !== undefined && apiArg?.navigation) posModalApi = apiArg;
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

// OrderScreen内のVIEW定数（OrderScreen.jsxと同期）
const ORDER_VIEW = { CONDITIONS: "conditions", PRODUCT_LIST: "productList", HISTORY: "history" };

function Extension() {
  const [prefs, setPrefs] = useUiPrefs();
  const [header, setHeader] = useState(null);
  const [footer, setFooter] = useState(null);
  const [cameraScannerVisible, setCameraScannerVisible] = useState(false);
  const [orderView, setOrderView] = useState(ORDER_VIEW.CONDITIONS);
  const liteMode = !!prefs?.liteMode;
  const onToggleLiteMode = useCallback(() => {
    setPrefs((p) => ({ ...(p && typeof p === "object" ? p : {}), liteMode: !p?.liteMode }));
  }, [setPrefs]);

  const orderViewRef = useRef(orderView);
  useEffect(() => {
    orderViewRef.current = orderView;
  }, [orderView]);

  // スキャナー購読（スキャン受信時にトースト表示し、商品リスト画面ではキューに積む）
  useEffect(() => {
    let unsub = null;
    try {
      // Shopify POS の scanner API へのアクセスは try-catch で囲む（ランタイムエラー対策）
      const scannerApi = SHOPIFY?.scanner?.scannerData?.current;
      if (!scannerApi || typeof scannerApi.subscribe !== "function") return;
      unsub = scannerApi.subscribe((result) => {
        try {
          const data = String(result?.data || "").trim();
          if (!data) return;
          toast(`スキャン: ${data}`);
          const currentOrderView = orderViewRef.current;
          if (currentOrderView === ORDER_VIEW.PRODUCT_LIST) {
            pushScanToQueue_(data);
          }
        } catch (e) {
          console.error("[Order] scanner callback error:", e);
        }
      });
    } catch (e) {
      console.error("[Order] scanner subscribe error:", e);
    }
    return () => {
      try { unsub?.(); } catch {}
    };
  }, []);

  // モーダルを閉じる（POS 渡し api → グローバル navigation → action の順で試す）
  const dismissModal = useCallback(() => {
    const tryDismiss = (fn) => { try { if (typeof fn === "function") { fn(); return true; } } catch {} return false; };
    if (tryDismiss(posModalApi?.navigation?.dismiss)) return;
    if (tryDismiss(globalThis?.navigation?.dismiss)) return;
    if (tryDismiss(globalThis?.shopify?.navigation?.dismiss)) return;
    if (tryDismiss(SHOPIFY?.navigation?.dismiss)) return;
    if (tryDismiss(SHOPIFY?.action?.dismissModal)) return;
    if (tryDismiss(SHOPIFY?.action?.dismiss)) return;
  }, []);
  const handleBackFromConditions = useCallback(() => { dismissModal(); }, [dismissModal]);

  const body = (
    <OrderScreen
      onBack={handleBackFromConditions}
      setHeader={setHeader}
      setFooter={setFooter}
      onViewChange={setOrderView}
      liteMode={liteMode}
      onToggleLiteMode={onToggleLiteMode}
    />
  );

  const handleCameraScanToggle = () => {
    const api = posModalApi ?? SHOPIFY;
    if (cameraScannerVisible) {
      if (typeof api?.scanner?.hideCameraScanner === "function") api.scanner.hideCameraScanner();
      setCameraScannerVisible(false);
    } else {
      if (typeof api?.scanner?.showCameraScanner === "function") {
        api.scanner.showCameraScanner();
        setCameraScannerVisible(true);
      } else {
        toast("バーコードをスキャンしてください");
      }
    }
  };
  return (
    <s-page heading="発注">
      <s-button slot="secondary-actions" kind="secondary" onClick={handleCameraScanToggle}>
        {cameraScannerVisible ? "カメラを閉じる" : "カメラスキャン"}
      </s-button>
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
