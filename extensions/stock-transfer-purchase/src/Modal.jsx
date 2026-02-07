import { render, Component } from "preact";
import { useState, useCallback, useEffect, useRef } from "preact/hooks";
import { PurchaseScreen } from "./screens/PurchaseScreen.jsx";

const SHOPIFY = globalThis?.shopify ?? {};

let posModalApi = null;

// =========================
// スキャンキュー管理（出庫/入庫と同じロジック）
// =========================

const PURCHASE_SCAN_QUEUE_KEY = "stock_transfer_pos_purchase_scan_queue_v1";

function normalizeScanQueueObj_(raw) {
  // 旧形式（配列）→ 新形式へ
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

  // 新形式（object）
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
    const cur = normalizeScanQueueObj_(await storage.get(PURCHASE_SCAN_QUEUE_KEY));

    // 同一値の短時間連打は捨てる
    if (cur.lastV === v && Math.abs(now - Number(cur.lastT || 0)) < 350) return;

    const nextItems = [...cur.items, v];
    const MAX_ITEMS = 5000;
    const trimmed = nextItems.length > MAX_ITEMS ? nextItems.slice(nextItems.length - MAX_ITEMS) : nextItems;

    await storage.set(PURCHASE_SCAN_QUEUE_KEY, {
      items: trimmed,
      lastV: v,
      lastT: now,
      updatedAt: now,
    });
  } catch (e) {
    console.error("[Purchase] pushScanToQueue_ failed", e);
  }
}

function dismissModal() {
  const tryDismiss = (fn) => {
    try {
      if (typeof fn === "function") {
        fn();
        return true;
      }
    } catch {}
    return false;
  };
  if (tryDismiss(posModalApi?.navigation?.dismiss)) return;
  if (tryDismiss(globalThis?.navigation?.dismiss)) return;
  if (tryDismiss(globalThis?.shopify?.navigation?.dismiss)) return;
  if (tryDismiss(SHOPIFY?.navigation?.dismiss)) return;
  if (tryDismiss(SHOPIFY?.action?.dismissModal)) return;
  if (tryDismiss(SHOPIFY?.action?.dismiss)) return;
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

function Extension() {
  const [header, setHeader] = useState(null);
  const [footer, setFooter] = useState(null);
  const [liteMode, setLiteMode] = useState(false);
  const [cameraScannerVisible, setCameraScannerVisible] = useState(false);
  const [purchaseView, setPurchaseView] = useState("conditions"); // 同期用
  const onToggleLiteMode = useCallback(() => setLiteMode((v) => !v), []);

  const handleBackFromConditions = useCallback(() => {
    dismissModal();
  }, []);

  const purchaseViewRef = useRef(purchaseView);
  useEffect(() => {
    purchaseViewRef.current = purchaseView;
  }, [purchaseView]);

  // スキャナー購読（出庫と同じロジック：商品リスト画面のみキューに積む）
  useEffect(() => {
    let unsub = null;
    try {
      const scannerApi = SHOPIFY?.scanner?.scannerData?.current;
      if (!scannerApi || typeof scannerApi.subscribe !== "function") return;
      unsub = scannerApi.subscribe((result) => {
        try {
          const data = String(result?.data || "").trim();
          if (!data) return;
          SHOPIFY?.toast?.show?.(`スキャン: ${data}`);
          const currentView = purchaseViewRef.current;
          if (currentView === "productList") {
            pushScanToQueue_(data);
          }
        } catch (e) {
          console.error("[Purchase] scanner callback error:", e);
        }
      });
    } catch (e) {
      console.error("[Purchase] scanner subscribe error:", e);
    }
    return () => {
      try {
        unsub?.();
      } catch {}
    };
  }, []);

  const body = (
    <PurchaseScreen
      onBack={handleBackFromConditions}
      setHeader={setHeader}
      setFooter={setFooter}
      liteMode={liteMode}
      onToggleLiteMode={onToggleLiteMode}
      onViewChange={setPurchaseView}
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
        SHOPIFY?.toast?.show?.("バーコードをスキャンしてください");
      }
    }
  };

  return (
    <s-page heading="仕入">
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
