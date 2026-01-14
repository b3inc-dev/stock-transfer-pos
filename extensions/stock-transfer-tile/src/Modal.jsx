// Modal.jsx (POS UI Extension)
// 出庫（移管） + 入庫（受領）
//
// - ✅ 閉じるボタンは設置しない（左上×に任せる）
// - ✅ 入庫予定一覧: QueryRoot.inventoryShipments は存在しないため inventoryTransfers(query:) を使用
// - ✅ 入庫側は「Shipment ID 手入力 → 読み込み → 受領確定」をまず動く形で実装（一覧から選択も可能なら出す）
// - ✅ スキャン: 改行不要（入力停止で即確定）＋キューで順番に処理（連続スキャン対応）
// - ✅ 見つからない場合: OK必須のブロッキングモーダル（押すまで処理も入力も停止）
// - ✅ liteMode ON のときは GraphQLで画像フィールドを取得しない（確実に軽くする）

// Modal.jsx
import { render, Component } from "preact";
import { useEffect, useMemo, useRef, useState, useCallback } from "preact/hooks";

const SHOPIFY = globalThis?.shopify;
const toast = (m) => SHOPIFY?.toast?.show?.(String(m));

export default async () => {
  try {
    SHOPIFY?.toast?.show?.("Modal entry: loaded");

    const root = document.body; // ✅ DOM root を自作しない（getElementById/createElement禁止）

    // 前回ツリーが残っていても確実に破棄
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
    try { SHOPIFY?.toast?.show?.(`UI Error: ${err?.message ?? err}`); } catch {}
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

// ================================
// Dialog統一（alert / confirm / input）
// ================================

const DIALOG_KIND = {
  ALERT: "ALERT",
  CONFIRM: "CONFIRM",
  INPUT: "INPUT",
};

function useUnifiedDialog() {
  const modalRef = useRef(null);
  const overlayOpenRef = useRef(false);

  const [dlg, setDlg] = useState({
    isVisible: false,
    kind: DIALOG_KIND.ALERT,
    type: "default",
    title: "",
    content: "",
    actionText: "OK",
    secondaryActionText: "キャンセル",
    showSecondaryAction: false,
    inputLabel: "",
    inputValue: "",
    inputPlaceholder: "",
    _resolve: null,
  });

  const openOverlay = () => {
    if (overlayOpenRef.current) return;
    try {
      modalRef.current?.showOverlay?.();
    } catch {}
    overlayOpenRef.current = true;
  };

  const closeOverlay = () => {
    if (!overlayOpenRef.current) return;
    try {
      modalRef.current?.hideOverlay?.();
    } catch {}
    overlayOpenRef.current = false;
  };

  const close = () => {
    setDlg((d) => ({ ...d, isVisible: false, _resolve: null }));
  };

  const alert = ({ type = "default", title, content, message, actionText = "OK" }) =>
    new Promise((resolve) => {
      setDlg({
        isVisible: true,
        kind: DIALOG_KIND.ALERT,
        type,
        title: title ?? "",
        content: (content ?? message ?? "") ?? "",
        actionText,
        secondaryActionText: "",
        showSecondaryAction: false,
        inputLabel: "",
        inputValue: "",
        inputPlaceholder: "",
        _resolve: resolve,
      });
    });

  const confirm = ({
    type = "default",
    title,
    content,
    actionText = "OK",
    secondaryActionText = "キャンセル",
  }) =>
    new Promise((resolve) => {
      setDlg({
        isVisible: true,
        kind: DIALOG_KIND.CONFIRM,
        type,
        title: title ?? "",
        content: content ?? "",
        actionText,
        secondaryActionText,
        showSecondaryAction: true,
        inputLabel: "",
        inputValue: "",
        inputPlaceholder: "",
        _resolve: resolve,
      });
    });

  const input = ({
    type = "default",
    title,
    content,
    actionText = "確定",
    secondaryActionText = "キャンセル",
    inputLabel = "数量",
    inputValue = "",
    inputPlaceholder = "",
  }) =>
    new Promise((resolve) => {
      setDlg({
        isVisible: true,
        kind: DIALOG_KIND.INPUT,
        type,
        title: title ?? "",
        content: content ?? "",
        actionText,
        secondaryActionText,
        showSecondaryAction: true,
        inputLabel,
        inputValue: String(inputValue ?? ""),
        inputPlaceholder,
        _resolve: resolve,
      });
    });

  useEffect(() => {
    if (dlg.isVisible) openOverlay();
    else closeOverlay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dlg.isVisible]);

  const DialogHost = () => {
    const toneOk =
      dlg.type === "destructive" || dlg.type === "error" ? "critical" : "success";

    // ✅ s-modal は常に描画して ref を維持（showOverlay/hideOverlay のため）
    // ✅ slot は s-modal 直下に置く（重要）
    return (
      <s-modal ref={modalRef} heading={dlg.title || "確認"}>
        <s-box padding="base">
          <s-stack gap="base">
            {dlg.content ? (
              <s-text tone={dlg.type === "error" ? "critical" : "subdued"}>
                {dlg.content}
              </s-text>
            ) : null}

            {dlg.kind === DIALOG_KIND.INPUT ? (
              <s-text-field
                label={dlg.inputLabel || "入力"}
                value={dlg.inputValue}
                placeholder={dlg.inputPlaceholder}
                onInput={(v) =>
                  setDlg((d) => ({ ...d, inputValue: readValue(v) }))
                }
                onChange={(v) =>
                  setDlg((d) => ({ ...d, inputValue: readValue(v) }))
                }
              />
            ) : null}
          </s-stack>
        </s-box>

        {dlg.showSecondaryAction ? (
          <s-button
            slot="secondary-actions"
            onClick={() => {
              const r = dlg._resolve;
              const kind = dlg.kind;
              close();
              if (kind === DIALOG_KIND.CONFIRM) r?.(false);
              if (kind === DIALOG_KIND.INPUT) r?.(null);
            }}
          >
            {dlg.secondaryActionText || "キャンセル"}
          </s-button>
        ) : null}

        <s-button
          slot="primary-action"
          tone={toneOk}
          onClick={() => {
            const r = dlg._resolve;
            const kind = dlg.kind;
            const value = kind === DIALOG_KIND.INPUT ? dlg.inputValue : true;
            close();
            if (kind === DIALOG_KIND.ALERT) r?.(true);
            if (kind === DIALOG_KIND.CONFIRM) r?.(true);
            if (kind === DIALOG_KIND.INPUT) r?.(value);
          }}
        >
          {dlg.actionText || "OK"}
        </s-button>
      </s-modal>
    );
  };

  return { alert, confirm, input, DialogHost };
}

/* =========================
   Const
========================= */

const SETTINGS_NS = "stock_transfer_pos";
const SETTINGS_KEY = "settings_v1";

const UI_PREFS_KEY = "stock_transfer_pos_ui_prefs_v1";
const APP_STATE_KEY = "stock_transfer_pos_state_v1";

const OUTBOUND_DRAFT_KEY = "stock_transfer_pos_outbound_draft_v1";

// 画面ID
const SCREENS = {
  MENU: "menu",

  OUTBOUND_COND: "out_cond",
  OUTBOUND_LIST: "out_list",

  // ✅ 追加：出庫履歴一覧（InboundConditions同型）
  OUTBOUND_HIST_COND: "out_hist_cond",

  OUTBOUND_HIST_DETAIL: "out_hist_detail",

  INBOUND_COND: "in_cond",
  INBOUND_LIST: "in_list",

  STOCKTAKE: "stocktake",
  LOSS: "loss",
};

/* =========================
   UI Root（Fixed Footer 安定版）
========================= */

const SCAN_QUEUE_KEY = "stock_transfer_pos_scan_queue_v1";

// storage helper（安全に配列化）
function normalizeScanQueue_(v) {
  if (Array.isArray(v)) return v;
  // string の場合 JSON を試す
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

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
    const cur = normalizeScanQueueObj_(await storage.get(SCAN_QUEUE_KEY));

    // 同一値の短時間連打は捨てる（m-pop等の二重イベント対策）
    if (cur.lastV === v && Math.abs(now - Number(cur.lastT || 0)) < 350) return;

    const nextItems = [...cur.items, v];

    // 店舗で「最大1000件/回」を想定 → 余裕見て 5000 まで保持（必要なら増やしてOK）
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

async function inventoryTransferCreateDraftSafe({ originLocationId, destinationLocationId, lineItems, note }) {
  const originId = String(originLocationId || "").trim();
  const destId = String(destinationLocationId || "").trim();
  const items = Array.isArray(lineItems) ? lineItems : [];

  if (!originId) throw new Error("originLocationId が空です");
  if (!destId) throw new Error("destinationLocationId が空です");
  if (items.length === 0) throw new Error("lineItems が空です");

  const data = await adminGraphql(
    `#graphql
    mutation InventoryTransferCreate($input: InventoryTransferCreateInput!) {
      inventoryTransferCreate(input: $input) {
        inventoryTransfer { id status name }
        userErrors { field message }
      }
    }`,
    {
      input: {
        originLocationId: originId,
        destinationLocationId: destId,
        lineItems: items,
        note: note ? String(note) : undefined,
      },
    }
  );

  const payload = data?.inventoryTransferCreate;
  assertNoUserErrors(payload, "inventoryTransferCreate");
  return payload?.inventoryTransfer;
}

async function inventoryTransferSetItemsSafe({ id, lineItems }) {
  const transferId = String(id || "").trim();
  const items = Array.isArray(lineItems) ? lineItems : [];

  if (!transferId) throw new Error("Transfer ID が空です");
  if (items.length === 0) throw new Error("lineItems が空です");

  const data = await adminGraphql(
    `#graphql
    mutation InventoryTransferSetItems($input: InventoryTransferSetItemsInput!) {
      inventoryTransferSetItems(input: $input) {
        inventoryTransfer { id status }
        userErrors { field message }
      }
    }`,
    { input: { id: transferId, lineItems: items } }
  );

  const payload = data?.inventoryTransferSetItems;
  assertNoUserErrors(payload, "inventoryTransferSetItems");
  return payload?.inventoryTransfer;
}

function Extension() {
  const [prefs, setPrefs] = useUiPrefs();
  const [appState, setAppState] = usePersistentAppState();

  const nav = useNavStack({ id: SCREENS.MENU, params: {} });
  const dialog = useUnifiedDialog();
  const DialogHost = dialog.DialogHost;

  // ✅ header/footer を保持（どちらも任意）
  const [header, setHeader] = useState(null);
  const [footer, setFooter] = useState(null);

  const liteMode = !!prefs?.liteMode;
  const showImages = !liteMode; // 画像ON/OFFを単独運用しない

  // ✅ nav.current が一瞬でも崩れても真っ白にしない
  const screen = nav.current?.id || SCREENS.MENU;

  // ✅ 追加：軽量モード切替（showImagesは派生なので触らない）
  const toggleLiteMode = useCallback(() => {
    setPrefs((prev) => {
      const p = prev && typeof prev === "object" ? prev : {};
      return { ...p, liteMode: !p.liteMode };
    });
  }, [setPrefs]);

  // screen を subscribe コールバックから参照するために ref 化
  const screenRef = useRef(screen);
  useEffect(() => {
    screenRef.current = screen;
  }, [screen]);

  // ✅ スキャナー購読（元のまま）
  useEffect(() => {
    try {
      const hasToast = !!SHOPIFY?.toast?.show;
      const hasScanner = !!SHOPIFY?.scanner;
      toast(`env: toast=${hasToast} scanner=${hasScanner}`);
    } catch {}

    const subscribe = SHOPIFY?.scanner?.scannerData?.current?.subscribe;
    if (typeof subscribe !== "function") {
      toast("scanner API が見つかりません");
      return;
    }

    toast("scanner subscribe start");

    const unsub = SHOPIFY.scanner.scannerData.current.subscribe((result) => {
      const data = String(result?.data || "").trim();
      const source = String(result?.source || "");
      if (!data) return;

      // ✅ 受信は確認できる
      toast(`SCAN: ${data} (${source})`);

      // ✅ 重要：リスト画面の時だけキューに積む
      const sc = screenRef.current;
      if (sc === SCREENS.OUTBOUND_LIST || sc === SCREENS.INBOUND_LIST) {
        pushScanToQueue_(data);
      }
    });

    return () => {
      try {
        unsub?.();
      } catch {}
    };
  }, []);

  // ✅ MENUに戻ったら header/footer を消す（元の footer クリア + header追加）
  useEffect(() => {
    if (screen === SCREENS.MENU) {
      setHeader(null);
      setFooter(null);
    }
  }, [screen]);

  // ✅ 画面遷移前に header/footer を必ずクリア
  const clearBars = useCallback(() => {
    setHeader(null);
    setFooter(null);
  }, []);

  // ---- stable handlers (✅ 遷移前に必ず header/footer をクリア) ----
  const goMenu = useCallback(() => {
    clearBars();
    nav.reset(SCREENS.MENU);
  }, [nav.reset, clearBars]);

  const goBack = useCallback(() => {
    clearBars();
    nav.pop();
  }, [nav.pop, clearBars]);

  const goOutboundCond = useCallback(() => {
    clearBars();
    nav.push(SCREENS.OUTBOUND_COND);
  }, [nav.push, clearBars]);

  // ✅ 新規作成で OutboundList に入る時は「履歴選択状態」を必ずクリア
  const goOutboundListNew = useCallback(() => {
    clearBars();

    // ②（履歴→編集）側でやっている「履歴状態クリア」を新規作成でも揃える
    // + ✅ 重要：壊れた outbound.lines を持ち込まない（下書き復元は OutboundList 側に任せる）
    setStateSlice(setAppState, "outbound", (prev) => ({
      ...(prev || {}),

      // ✅ これが効く可能性が高い
      lines: [],
      result: null,

      // 履歴選択クリア
      historySelectedTransferId: "",
      historySelectedTransferName: "",
      historySelectedOriginName: "",
      historySelectedDestName: "",
      historySelectedStatus: "",
      historySelectedReadOnly: false,
      historySelectedShipmentId: "",
      historySelectedOriginLocationId: "",
      historySelectedDestLocationId: "",
      historyDraftSourceTransferId: "",
    }));

    nav.push(SCREENS.OUTBOUND_LIST);
  }, [nav.push, clearBars, setAppState]);

  const goOutboundList = useCallback(() => {
    clearBars();
    nav.push(SCREENS.OUTBOUND_LIST);
  }, [nav.push, clearBars]);

  const goOutboundHistoryCond = useCallback(() => {
    clearBars();
    nav.push(SCREENS.OUTBOUND_HIST_COND);
  }, [nav.push, clearBars]);

  const goInboundCond = useCallback(() => {
    clearBars();
    nav.push(SCREENS.INBOUND_COND);
  }, [nav.push, clearBars]);

  const goInboundList = useCallback(() => {
    clearBars();
    nav.push(SCREENS.INBOUND_LIST);
  }, [nav.push, clearBars]);

  const goStocktake = useCallback(() => {
    clearBars();
    nav.push(SCREENS.STOCKTAKE);
  }, [nav.push, clearBars]);

  const goLoss = useCallback(() => {
    clearBars();
    nav.push(SCREENS.LOSS);
  }, [nav.push, clearBars]);

  let body = null;

  if (screen === SCREENS.MENU) {
    body = (
      <MenuScreen
        prefs={prefs}
        setPrefs={setPrefs}
        onOutbound={goOutboundCond}
        onInbound={goInboundCond}
        onStocktake={goStocktake}
        onLoss={goLoss}
      />
    );
  } else if (screen === SCREENS.OUTBOUND_COND) {
    body = (
      <OutboundConditions
        showImages={showImages}
        liteMode={liteMode}
        appState={appState}
        setAppState={setAppState}
        onBack={goBack}
        onNext={goOutboundListNew}
        setHeader={setHeader}
        setFooter={setFooter}
        onToggleLiteMode={toggleLiteMode}
        onOpenOutboundHistoryConditions={goOutboundHistoryCond}
        onOpenOutboundHistoryDetail={() => {
          clearBars();
          nav.push(SCREENS.OUTBOUND_HIST_DETAIL);
        }}
      />
    );
  } else if (screen === SCREENS.OUTBOUND_HIST_COND) {
    body = (
      <OutboundHistoryConditions
        showImages={showImages}
        liteMode={liteMode}
        appState={appState}
        setAppState={setAppState}
        onBack={goBack}
        setHeader={setHeader}
        setFooter={setFooter}
        onToggleLiteMode={toggleLiteMode}
        onOpenOutboundHistoryDetail={() => {
          clearBars();
          nav.push(SCREENS.OUTBOUND_HIST_DETAIL);
        }}
      />
    );
  } else if (screen === SCREENS.OUTBOUND_LIST) {
    body = (
      <OutboundList
        showImages={showImages}
        liteMode={liteMode}
        appState={appState}
        setAppState={setAppState}
        onBack={goBack}
        dialog={dialog}
        setHeader={setHeader}
        setFooter={setFooter}
        onToggleLiteMode={toggleLiteMode}
      />
    );
  } else if (screen === SCREENS.OUTBOUND_HIST_DETAIL) {
    body = (
      <OutboundHistoryDetail
        showImages={showImages}
        liteMode={liteMode}
        appState={appState}
        setAppState={setAppState}
        onBack={goBack}
        dialog={dialog}
        setHeader={setHeader}
        setFooter={setFooter}
        onToggleLiteMode={toggleLiteMode}
        onOpenOutboundList={() => {
          clearBars();
          nav.push(SCREENS.OUTBOUND_LIST);
        }}
      />
    );
  } else if (screen === SCREENS.INBOUND_COND) {
    body = (
      <InboundConditions
        showImages={showImages}
        liteMode={liteMode}
        appState={appState}
        setAppState={setAppState}
        onBack={goBack}
        onNext={goInboundList}
        setHeader={setHeader}
        setFooter={setFooter}
        onToggleLiteMode={toggleLiteMode}
      />
    );
  } else if (screen === SCREENS.INBOUND_LIST) {
    body = (
      <InboundList
        showImages={showImages}
        liteMode={liteMode}
        appState={appState}
        setAppState={setAppState}
        onBack={goBack}
        dialog={dialog}
        setHeader={setHeader}
        setFooter={setFooter}
        onToggleLiteMode={toggleLiteMode}
      />
    );
  } else if (screen === SCREENS.STOCKTAKE) {
    // ✅ 未定義の StocktakeScreen は使わず、元の placeholder で安全に固定
    body = (
      <s-box padding="base">
        <s-stack gap="base">
          <s-button onClick={goBack}>戻る</s-button>
          <StocktakePlaceholder />
        </s-stack>
      </s-box>
    );
  } else if (screen === SCREENS.LOSS) {
    // ✅ 未定義の LossScreen は使わず、元の placeholder で安全に固定
    body = (
      <s-box padding="base">
        <s-stack gap="base">
          <s-button onClick={goBack}>戻る</s-button>
          <LossPlaceholder />
        </s-stack>
      </s-box>
    );
  }

  // ✅ これが無いと「真っ白」になり得る（あなたの症状の最有力）
  if (!body) {
    body = (
      <s-box padding="base">
        <s-text tone="critical">画面の状態が不正です: {String(screen)}</s-text>
        <s-button onClick={goMenu}>メニューに戻す</s-button>
      </s-box>
    );
  }

  return (
    <>
      <s-page heading="在庫処理">
        <s-stack gap="none" blockSize="100%" inlineSize="100%" minBlockSize="0">
          {/* ✅ 上部固定ヘッダー（スクロール外） */}
          {header ? (
            <>
              <s-box padding="none">{header}</s-box>
              <s-divider />
            </>
          ) : null}

          {/* ✅ 本体スクロール（元の構造を維持） */}
          <s-scroll-box padding="none" blockSize="auto" maxBlockSize="100%" minBlockSize="0">
            <s-box padding="none">{body}</s-box>
          </s-scroll-box>

          {/* ✅ 下部固定フッター（元のまま） */}
          {footer ? (
            <>
              <s-divider />
              <s-box padding="none">{footer}</s-box>
            </>
          ) : null}
        </s-stack>
      </s-page>

      {/* ✅ DialogHost は元通り page の外（安全側） */}
      <DialogHost />
    </>
  );
}

function MenuScreen({ prefs, setPrefs, onOutbound, onInbound, onLoss, onStocktake }) {
  const liteMode = prefs?.liteMode === true;

  const toggleLite = () => {
    const nextLite = !liteMode;
    setPrefs((p) => ({
      ...(p || {}),
      liteMode: nextLite,
      showImages: !nextLite, // ← 互換のため追従させる
    }));
  };

  return (
    <s-box padding="base">
      <s-stack gap="base">
        <s-text emphasis="bold">メニュー</s-text>

        <s-stack direction="inline" gap="base" alignItems="center">
          <s-button kind="secondary" tone={liteMode ? "critical" : undefined} onClick={toggleLite}>
            軽量モード（画像OFF） {liteMode ? "ON" : "OFF"}
          </s-button>
        </s-stack>

        <s-divider />

        <s-button tone="success" onClick={onOutbound}>出庫（移管）</s-button>
        <s-button tone="success" onClick={onInbound}>入庫（受領）</s-button>
        <s-button onClick={onLoss}>ロス登録（準備中）</s-button>
        <s-button onClick={onStocktake}>棚卸（準備中）</s-button>
      </s-stack>
    </s-box>
  );
}

function StocktakePlaceholder() {
  return (
    <s-box padding="none">
      <s-stack gap="base">
        <s-text emphasis="bold">棚卸</s-text>
        <s-text tone="subdued">この機能は将来的に追加予定です（準備中）</s-text>
      </s-stack>
    </s-box>
  );
}

function LossPlaceholder() {
  return (
    <s-box padding="none">
      <s-stack gap="base">
        <s-text emphasis="bold">ロス登録</s-text>
        <s-text tone="subdued">この機能は将来的に追加予定です（準備中）</s-text>
      </s-stack>
    </s-box>
  );
}

/* =========================
   Common helpers
========================= */

const debug = (...args) => {
  try {
    console.log("[stock-transfer-pos]", ...args);
  } catch {}
};

const toUserMessage = (e) => {
  const msg = e?.message ?? String(e);
  try {
    const parsed = JSON.parse(msg);
    if (Array.isArray(parsed)) return parsed.map((x) => x?.message ?? JSON.stringify(x)).join(" / ");
  } catch {}
  return msg;
};

function safeParseJson(s, fallback) {
  if (!s) return fallback;
  try {
    return JSON.parse(String(s));
  } catch {
    return fallback;
  }
}

const readValue = (eOrValue) => {
  // ✅ POS UI は onChange/onInput が「文字列」を直接返す実装があるため両対応
  if (typeof eOrValue === "string" || typeof eOrValue === "number") {
    return String(eOrValue);
  }

  return String(
    eOrValue?.currentTarget?.value ??
      eOrValue?.target?.value ??
      eOrValue?.detail?.value ??
      eOrValue?.currentValue?.value ??
      ""
  );
};

/** field配列を "a.b[0].c" っぽく整形 */
function fieldPath(field) {
  if (!Array.isArray(field) || field.length === 0) return "";
  let out = "";
  for (const part of field) {
    const p = String(part);
    if (/^\d+$/.test(p)) out += `[${p}]`;
    else out += (out ? "." : "") + p;
  }
  return out;
}

/** userErrors を “行単位” で読みやすくする */
function formatUserErrors(userErrors, lineItemsMeta) {
  const errs = Array.isArray(userErrors) ? userErrors : [];
  if (errs.length === 0) return [];

  const lines = errs.map((e) => {
    const fp = fieldPath(e?.field);
    const msg = String(e?.message ?? "Unknown error");

    let itemHint = "";
    if (fp) {
      const m = fp.match(/lineItems\[(\d+)\]/);
      if (m?.[1] && Array.isArray(lineItemsMeta)) {
        const idx = Number(m[1]);
        const meta = lineItemsMeta[idx];
        if (meta?.label) itemHint = `（${meta.label}）`;
      }
    }

    return `- ${msg}${itemHint}${fp ? ` [${fp}]` : ""}`;
  });

  return Array.from(new Set(lines));
}

function assertNoUserErrors(payload, label = "Mutation", lineItemsMeta) {
  const errs = payload?.userErrors ?? [];
  if (!Array.isArray(errs) || errs.length === 0) return;

  const formatted = formatUserErrors(errs, lineItemsMeta);
  const msg = formatted.length ? formatted.join("\n") : errs.map((e) => e?.message).join(" / ");
  throw new Error(`${label} failed:\n${msg}`);
}

function useLocationsIndex(appState, setAppState) {
  const cache = getStateSlice(appState, "locations_cache_v1", {
    loaded: false,
    loading: false,
    error: "",
    list: [],
    byId: {},
  });

  const loaded = !!cache.loaded;
  const loading = !!cache.loading;

  useEffect(() => {
    let mounted = true;

    async function load() {
      if (loaded || loading) return;

      setStateSlice(setAppState, "locations_cache_v1", (prev) => ({
        ...prev,
        loading: true,
        error: "",
      }));

      try {
        const data = await adminGraphql(
          `#graphql
          query Locs($first: Int!) {
            locations(first: $first) { nodes { id name } }
          }`,
          { first: 250 }
        );

        const list = Array.isArray(data?.locations?.nodes) ? data.locations.nodes : [];
        const byId = {};
        for (const l of list) byId[l.id] = l.name;

        if (!mounted) return;

        setStateSlice(setAppState, "locations_cache_v1", {
          loaded: true,
          loading: false,
          error: "",
          list,
          byId,
        });
      } catch (e) {
        if (!mounted) return;
        setStateSlice(setAppState, "locations_cache_v1", (prev) => ({
          ...prev,
          loaded: false,
          loading: false,
          error: toUserMessage(e),
        }));
      }
    }

    load();
    return () => {
      mounted = false;
    };
  }, [loaded, loading, setAppState]);

  return {
    loaded,
    loading,
    error: String(cache.error || ""),
    list: Array.isArray(cache.list) ? cache.list : [],
    byId: cache.byId && typeof cache.byId === "object" ? cache.byId : {},
  };
}

function getLocationName_(locationId, locationsById) {
  const id = String(locationId || "").trim();
  if (!id) return "（不明）";
  const name = locationsById?.[id];
  return name ? String(name) : "（不明）";
}

function normalizeVariantTitleForDisplay_(productTitle, variantTitle) {
  const p = String(productTitle || "").trim();
  const v = String(variantTitle || "").trim();

  if (!v) return "";
  if (v.toLowerCase() === "default title") return "";
  if (p && v === p) return "";
  return v;
}

function normalizeVariantOptions_(productTitle, variantTitle) {
  const v = normalizeVariantTitleForDisplay_(productTitle, variantTitle);
  if (!v) return [];

  // Shopifyのvariant titleは "Red / Large" のように区切られることが多い
  const parts = v.split("/").map((s) => s.trim()).filter(Boolean);

  // 1つだけなら “オプション1” 扱い
  return parts;
}

function formatOptionsLine_(options) {
  const ops = Array.isArray(options) ? options.filter(Boolean) : [];
  if (ops.length === 0) return "";
  // “オプション1/2/3” 要件に合わせて値だけ並べる（区切りは " / "）
  return ops.join(" / ");
}

function FixedFooterNavBar({
  summaryLeft,
  summaryCenter,
  summaryRight,

  // ✅ 追加：サマリーの2行目（中央）
  summaryBelow,

  leftLabel,
  onLeft,
  leftDisabled = false,
  leftTone = "default",

  rightLabel,
  onRight,
  rightDisabled = false,
  rightTone = "default",

  primaryActionText,
  onPrimaryAction,
  primaryActionDisabled = false,

  secondaryActionText,
  onSecondaryAction,
  secondaryActionDisabled = false,

  middleLabel,
  onMiddle,
  middleDisabled = false,
  middleTone = "default",
}) {
  const hasCenter =
    summaryCenter !== undefined && summaryCenter !== null && String(summaryCenter).trim() !== "";

  const hasBelow =
    summaryBelow !== undefined && summaryBelow !== null && String(summaryBelow).trim() !== "";

  const hasMiddle = !!middleLabel && typeof onMiddle === "function";

  return (
    <s-box
      padding="base"
      border="base"
      style={{
        position: "sticky",
        bottom: 0,
        background: "var(--s-color-bg)",
        zIndex: 10,
      }}
    >
      <s-stack gap="base">
        {/* 上段：サマリー（左・中央・右） */}
        <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
          <s-box style={{ flex: "1 1 0", minInlineSize: 0 }}>
            <s-text size="small" tone="subdued">
              {summaryLeft}
            </s-text>
          </s-box>

          {hasCenter ? (
            <s-box style={{ flex: "1 1 0", minInlineSize: 0, textAlign: "center" }}>
              <s-text size="small" tone="subdued">
                {summaryCenter}
              </s-text>
            </s-box>
          ) : (
            <s-box style={{ flex: "1 1 0", minInlineSize: 0 }} />
          )}

          <s-box style={{ flex: "1 1 0", minInlineSize: 0, textAlign: "right" }}>
            <s-text size="small" tone="subdued">
              {summaryRight}
            </s-text>
          </s-box>
        </s-stack>

        {/* ✅ 追加：サマリー2行目（中央） */}
        {hasBelow ? (
          <s-box>
            <s-text size="small" tone="subdued" alignment="center">
              {summaryBelow}
            </s-text>
          </s-box>
        ) : null}

        {/* 下段：戻る [軽量] 次へ ＋任意アクション */}
        <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
          <s-button tone={leftTone} disabled={leftDisabled} onClick={onLeft}>
            {leftLabel}
          </s-button>

          {hasMiddle ? (
            <s-button tone={middleTone} disabled={middleDisabled} onClick={onMiddle}>
              {middleLabel}
            </s-button>
          ) : (
            <s-box />
          )}

          <s-button tone={rightTone} disabled={rightDisabled} onClick={onRight}>
            {rightLabel}
          </s-button>
        </s-stack>

        {/* 任意アクション */}
        {primaryActionText && typeof onPrimaryAction === "function" ? (
          <s-button
            tone="success"
            disabled={primaryActionDisabled}
            onClick={onPrimaryAction}
          >
            {primaryActionText}
          </s-button>
        ) : null}

        {secondaryActionText && typeof onSecondaryAction === "function" ? (
          <s-button
            tone="default"
            disabled={secondaryActionDisabled}
            onClick={onSecondaryAction}
          >
            {secondaryActionText}
          </s-button>
        ) : null}
      </s-stack>
    </s-box>
  );
}

function qtyValueWidthByDigits_(digits) {
  if (digits <= 1) return 56;
  if (digits === 2) return 64;
  if (digits === 3) return 76;
  if (digits === 4) return 96;
  return 112;
}

function calcQtyWidthPx_(v) {
  const n = Number.isFinite(Number(v)) ? Number(v) : 0;
  const digits = String(n).length;
  return qtyValueWidthByDigits_(digits);
}

// =========================
// Inbound: write memo into InventoryTransfer.note (Admin visible)
// =========================

const INVENTORY_TRANSFER_NOTE_QUERY = `
  query TransferNote($id: ID!) {
    inventoryTransfer(id: $id) {
      id
      note
    }
  }
`;

const INVENTORY_TRANSFER_EDIT_NOTE_MUTATION = `
  mutation TransferEditNote($id: ID!, $note: String!) {
    inventoryTransferEdit(id: $id, input: { note: $note }) {
      inventoryTransfer { id note }
      userErrors { field message }
    }
  }
`;

function buildInboundNoteLine_({ shipmentId, locationId, finalize, note, over, extras }) {
  const payload = {
    v: 1,
    at: new Date().toISOString(),
    shipmentId: String(shipmentId || "").trim(),
    locationId: String(locationId || "").trim(),
    finalize: !!finalize,
    note: String(note || "").trim(),
    over: Array.isArray(over) ? over : [],
    extras: Array.isArray(extras) ? extras : [],
  };
  return `[STPOS-INBOUND] ${JSON.stringify(payload)}`;
}

async function appendInventoryTransferNote_({ transferId, line, maxLen = 5000 }) {
  if (!transferId || !line) return false;

  const q1 = await adminGraphql(INVENTORY_TRANSFER_NOTE_QUERY, { id: transferId });
  const current = String(q1?.inventoryTransfer?.note || "");

  const merged = (current ? current + "\n" : "") + String(line);

  // NOTE: note の上限が明記されていないため、安全に切る
  const clipped = merged.length > maxLen ? merged.slice(-maxLen) : merged;

  const q2 = await adminGraphql(INVENTORY_TRANSFER_EDIT_NOTE_MUTATION, { id: transferId, note: clipped });
  const errs = q2?.inventoryTransferEdit?.userErrors || [];
  if (errs.length) {
    console.warn("[inventoryTransferEdit] userErrors:", errs);
    return false;
  }
  return true;
}

// =========================
// ✅ missing inventoryLevel 検知（宛先ロケーション）
// =========================
async function findMissingInventoryLevelsAtLocation({
  locationId,
  inventoryItemIds,
  metaById,
  debug,
}) {
  const loc = String(locationId || "").trim();
  const ids = (Array.isArray(inventoryItemIds) ? inventoryItemIds : [])
    .map((x) => String(x || "").trim())
    .filter(Boolean);

  if (!loc || ids.length === 0) return [];

  const query = `
    query($ids:[ID!]!, $loc:ID!) {
      nodes(ids:$ids) {
        ... on InventoryItem {
          id
          sku
          inventoryLevel(locationId:$loc) { id }
        }
      }
    }
  `;

  const missing = [];

  // 50件ずつ（安全）
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);

    try {
      const data = await adminGraphql(query, { ids: chunk, loc });
      const nodes = Array.isArray(data?.nodes) ? data.nodes : [];

      for (const n of nodes) {
        const invId = String(n?.id || "").trim();
        if (!invId) continue;

        const hasLevel = !!n?.inventoryLevel?.id;
        if (hasLevel) continue;

        const m = metaById?.[invId] || {};
        missing.push({
          inventoryItemId: invId,
          sku: String(m?.sku || n?.sku || "").trim(),
          title: String(m?.title || m?.label || "").trim(),
        });
      }
    } catch (e) {
      debug?.("findMissingInventoryLevelsAtLocation error", e);
      // ここで止めない（誤検知で詰まらせない）
    }
  }

  return missing;
}

async function waitForMissingInventoryLevelsToClear({
  locationId,
  inventoryItemIds,
  metaById,
  timeoutMs = 20000,
  intervalMs = 900,
  debug,
}) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const missing = await findMissingInventoryLevelsAtLocation({
      locationId,
      inventoryItemIds,
      metaById,
      debug,
    });

    if (!missing || missing.length === 0) {
      return { ok: true, remaining: [] };
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  const remaining = await findMissingInventoryLevelsAtLocation({
    locationId,
    inventoryItemIds,
    metaById,
    debug,
  });

  return { ok: false, remaining: Array.isArray(remaining) ? remaining : [] };
}

/* =========================
   Nav (internal stack) + Persistent Store (localStorage)
========================= */

// ナビ（戻る固定）
function useNavStack(initial = { id: SCREENS.MENU, params: {} }) {
  const [stack, setStack] = useState([initial]);
  const current = stack[stack.length - 1];

  const navLockRef = useRef(false);

  const withLock = useCallback((fn) => {
    if (navLockRef.current) return;
    navLockRef.current = true;
    try {
      fn();
    } finally {
      queueMicrotask(() => {
        navLockRef.current = false;
      });
    }
  }, []);

  const push = useCallback(
    (id, params = {}) => {
      withLock(() => setStack((prev) => [...prev, { id, params }]));
    },
    [withLock]
  );

  const replace = useCallback(
    (id, params = {}) => {
      withLock(() => setStack((prev) => [...prev.slice(0, -1), { id, params }]));
    },
    [withLock]
  );

  const pop = useCallback(() => {
    withLock(() =>
      setStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev))
    );
  }, [withLock]);

  const reset = useCallback(
    (id = SCREENS.MENU) => {
      withLock(() => setStack([{ id, params: {} }]));
    },
    [withLock]
  );

  return { stack, current, push, replace, pop, reset };
}

// UI prefs（端末永続）
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

// appState（端末永続）
function loadAppState_() {
  try {
    const raw = localStorage.getItem(APP_STATE_KEY);
    const s = raw ? JSON.parse(raw) : null;
    return s && typeof s === "object" ? s : {};
  } catch {
    return {};
  }
}
function saveAppState_(state) {
  try {
    localStorage.setItem(APP_STATE_KEY, JSON.stringify(state || {}));
  } catch {}
}
function usePersistentAppState() {
  const [state, setState] = useState(() => loadAppState_());
  useEffect(() => saveAppState_(state), [state]);
  return [state, setState];
}

function getStateSlice(appState, key, fallback = {}) {
  const s = appState?.[key];
  return s && typeof s === "object" ? s : fallback;
}
function setStateSlice(setAppState, key, patch) {
  setAppState((prev) => {
    const cur = (prev && typeof prev === "object" ? prev : {})[key];
    const base = cur && typeof cur === "object" ? cur : {};
    const next = typeof patch === "function" ? patch(base) : { ...base, ...(patch || {}) };
    return { ...(prev && typeof prev === "object" ? prev : {}), [key]: next };
  });
}

/* =========================
   Blocking Alert Modal（OK必須）
========================= */

function BlockingAlertModal({ open, title = "エラー", message, onOk }) {
  if (!open) return null;
  return (
    <s-modal>
      <s-box padding="none">
        <s-stack gap="base">
          <s-text emphasis="bold">{title}</s-text>
          <s-text tone="critical">{String(message || "")}</s-text>
          <s-stack direction="inline" gap="base" justifyContent="end">
            <s-button tone="critical" onClick={onOk}>
              OK
            </s-button>
          </s-stack>
        </s-stack>
      </s-box>
    </s-modal>
  );
}

/* =========================
   Qty Input Modal（タップで数値入力）
========================= */

// “入力”ボタンなし版：数字タップでモーダルを開く
function QtyStepperCompact({
  value,
  min = 0,
  onDec,
  onInc,
  onSetQty,   // ★追加：数量を直接セットする関数
  dialog,     // ★追加：useUnifiedDialog() の戻り（dialog.input を使う）
  title = "数量入力",
}) {
  const v = Number(value || 0);
  const decDisabled = v <= min;

  const onTapValue = async () => {
    // dialog が無ければ何もしない（安全）
    if (!dialog?.input) return;

    const r = await dialog.input({
      type: "default",
      title,
      content: "数量を入力してください",
      inputLabel: "数量",
      inputValue: String(v),
      actionText: "OK",
      secondaryActionText: "キャンセル",
      inputPlaceholder: "例: 1",
    });

    // キャンセル時は null
    if (r == null) return;

    const n = Math.max(min, Number(r || 0));
    if (!Number.isFinite(n)) return;

    onSetQty?.(n);
  };

  return (
    <s-stack direction="inline" gap="base" alignItems="center" justifyContent="end">
      <s-button onClick={onDec} disabled={decDisabled}>-</s-button>

      {/* 数字タップで input ダイアログ */}
      <s-button onClick={onTapValue}>{v}</s-button>

      <s-button onClick={onInc}>+</s-button>
    </s-stack>
  );
}

function QtyStepperDirectInput({ value, onDec, onInc, onChange, min = 0 }) {
  const v = Number(value || 0);
  const decDisabled = v <= min;

  return (
    <s-stack direction="inline" gap="base" alignItems="center" justifyContent="end">
      <s-button onClick={onDec} disabled={decDisabled}>-</s-button>

      <s-box inlineSize="76px">
        <s-text-field
          label="Qty"
          value={String(v)}
          onInput={(e) => onChange?.(readValue(e))}
          onChange={(e) => onChange?.(readValue(e))}
        />
      </s-box>

      <s-button onClick={onInc}>+</s-button>
    </s-stack>
  );
}

// 行の数量UI：+/- と “入力” ボタン
function QtyStepperWithInput({ value, onDec, onInc, onInput, min = 0 }) {
  const v = Number(value || 0);

  return (
    <s-stack gap="base" alignItems="center" justifyContent="end">
      <s-button onClick={onDec} disabled={v <= min}>-</s-button>

      <s-box inlineSize="36px">
        <s-text alignment="center" emphasis="bold">{v}</s-text>
      </s-box>

      <s-button onClick={onInc}>+</s-button>
      <s-button onClick={onInput}>入力</s-button>
    </s-stack>
  );
}

function useSessionLocationId() {
  // 初回に取れるなら取る（取れないことも多い）
  const [rawId, setRawId] = useState(
    () => SHOPIFY?.session?.currentSession?.locationId ?? null
  );

  useEffect(() => {
    let alive = true;
    let tickCount = 0;

    const tick = () => {
      if (!alive) return;

      const next = SHOPIFY?.session?.currentSession?.locationId ?? null;

      // 値が変わったときだけ更新（null→値 も拾う）
      setRawId((prev) => {
        const p = prev == null ? "" : String(prev);
        const n = next == null ? "" : String(next);
        return p === n ? prev : next;
      });

      tickCount += 1;

      // locationId が取れたら監視終了（安定したら止める）
      if (next) return;

      // 最初の数秒だけ粘る（POS側の初期化待ち）
      // tickCount 50 & interval 100ms => 約5秒
      if (tickCount >= 50) {
        // 5秒たっても来ない場合は一旦諦める（必要なら延ばしてOK）
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

/* =========================
   POS current location gid
========================= */

// ✅ origin location id 正規化（数値 or gid）
function useOriginLocationGid() {
  const raw = useSessionLocationId();

  return useMemo(() => {
    if (!raw) return null;

    const s = String(raw);

    // すでにGIDならそのまま
    if (s.startsWith("gid://shopify/Location/")) return s;

    // 数字だけならGID化
    if (/^\d+$/.test(s)) return `gid://shopify/Location/${s}`;

    // 何か混ざってても Location/数字 を拾う
    const m = s.match(/Location\/(\d+)/);
    if (m?.[1]) return `gid://shopify/Location/${m[1]}`;

    return null;
  }, [raw]);
}

/* =========================
   Admin GraphQL（POSタイマー不安定対策版）
   - setTimeout 依存を避け、短周期 setInterval でタイムアウト監視
   - Promise.race で「await が永遠に返らない」を防止
========================= */

async function adminGraphql(query, variables, opts = {}) {
  const timeoutMsRaw = opts?.timeoutMs;
  const timeoutMs = Number.isFinite(Number(timeoutMsRaw)) ? Number(timeoutMsRaw) : 20000;

  const controller = new AbortController();
  const parentSignal = opts?.signal;

  // 親signalがあれば連動
  const onAbort = () => controller.abort(parentSignal?.reason || new Error("aborted"));
  if (parentSignal) {
    if (parentSignal.aborted) onAbort();
    else parentSignal.addEventListener("abort", onAbort, { once: true });
  }

  let done = false;
  let iv = null;

  const timeoutPromise = new Promise((_, reject) => {
    const started = Date.now();

    // ✅ POS iOS で setTimeout が不安定な報告があるため、短周期で監視する
    iv = setInterval(() => {
      if (done) return;

      const elapsed = Date.now() - started;
      if (elapsed >= timeoutMs) {
        try {
          controller.abort(new Error(`timeout ${timeoutMs}ms`));
        } catch {}
        reject(new Error(`timeout ${timeoutMs}ms`));
      }
    }, 200);
  });

  const fetchPromise = (async () => {
    const res = await fetch("shopify:admin/api/graphql.json", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });

    const text = await res.text().catch(() => "");
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);

    const json = text ? JSON.parse(text) : {};
    if (json.errors?.length) throw new Error(JSON.stringify(json.errors));
    return json.data;
  })();

  try {
    return await Promise.race([fetchPromise, timeoutPromise]);
  } finally {
    done = true;
    if (iv) clearInterval(iv);
  }
}

/* =========================
   Outbound screen split
========================= */

function OutboundConditions({
  showImages,
  liteMode,
  appState,
  setAppState,
  onNext,
  onBack,
  setHeader,
  setFooter,
  onToggleLiteMode,
  onOpenOutboundHistoryConditions,
  onOpenOutboundHistoryDetail,
}) {
  useEffect(() => {
    setHeader?.(null); // ★ 前画面の固定ヘッダーを確実に消す
    return () => setHeader?.(null);
  }, [setHeader]);

  const sessionOriginLocationGid = useOriginLocationGid();
  const manualOriginLocationGid = String(appState?.originLocationIdManual || "").trim();
  const originLocationGid = sessionOriginLocationGid || (manualOriginLocationGid ? manualOriginLocationGid : null);

  const locIndex = useLocationsIndex(appState, setAppState);

  const outbound = getStateSlice(appState, "outbound", {
    destinationLocationId: "",
    showDestPicker: false,
    showOriginPicker: false,

    carrierId: "",
    showCarrierPicker: false,
    manualCompany: "",

    trackingNumber: "",
    trackingUrl: "", // UIには出さないがstateは保持
    arrivesAtIso: "",

    showArrivesTimePicker: false,

    // ✅ クリア後に自動入力を止める
    arrivesAutoDisabled: false,

    // ✅ 日付入力の表示/入力用（TextFieldのvalue）
    arrivesDateDraft: "",

    settings: { version: 1, destinationGroups: [], carriers: [] },
    allLocations: [],
  });

  const [settingsLoading, setSettingsLoading] = useState(false);
  const [locationsLoading, setLocationsLoading] = useState(false);

  const allLocations = Array.isArray(outbound.allLocations) ? outbound.allLocations : [];
  const settings =
    outbound.settings && typeof outbound.settings === "object"
      ? outbound.settings
      : { version: 1, destinationGroups: [], carriers: [] };

  // ===== 出庫履歴（スクロール下部） =====
  const [historyMode, setHistoryMode] = useState("active"); // "active" | "done"
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [historyTransfers, setHistoryTransfers] = useState([]);

  // ✅ 追加：履歴で選択しているtransfer（フッターへ反映）
  const [selectedHistoryTransfer, setSelectedHistoryTransfer] = useState(null);

  const selectedHistoryTitle = useMemo(() => {
    const t = selectedHistoryTransfer;
    if (!t) return "";
    const name = String(t?.name || "").trim();
    return name ? `${name}` : `#${String(t?.id || "").slice(-6)}`;
  }, [selectedHistoryTransfer]);

  // ✅ 先に宣言（TDZ回避）
  const isCompletedTransfer = useCallback((t) => {
    const total = Number(t?.totalQuantity ?? 0);
    const received = Number(t?.receivedQuantity ?? 0);
    if (String(t?.status || "").toUpperCase() === "TRANSFERRED") return true;
    return total > 0 && received >= total;
  }, []);

  const commitHistorySelection_ = useCallback(
    (t) => {
      if (!t || !t.id) return;
      const readOnly = isCompletedTransfer(t);

      // ✅ ここで必ず定義（未定義参照で落ちるのを防止）
      const shipmentId = String(getShipmentIdFromTransferForHistory(t) || "").trim();

      setStateSlice(setAppState, "outbound", {
        historySelectedTransferId: String(t.id),
        historySelectedTransferName: String(t?.name || ""),
        historySelectedOriginName: String(t?.originName || ""),
        historySelectedDestName: String(t?.destinationName || ""),
        historySelectedStatus: String(t?.status || ""),
        historySelectedReadOnly: readOnly,
        historySelectedShipmentId: shipmentId,
      });
    },
    // ✅ v37: isCompletedTransfer が後で定義されているため deps に入れるとTDZで落ちる
    [setAppState]
  );

  const onSelectHistoryTransfer = useCallback(
    (t) => {
      const nextId = String(t?.id || "");

      setSelectedHistoryTransfer((cur) => {
        const curId = String(cur?.id || "");
        const next = curId === nextId ? null : t;

        if (next) {
          commitHistorySelection_(next);
        } else {
          setStateSlice(setAppState, "outbound", {
            historySelectedTransferId: "",
            historySelectedTransferName: "",
            historySelectedOriginName: "",
            historySelectedDestName: "",
            historySelectedStatus: "",
            historySelectedReadOnly: false,
          });
        }

        return next;
      });
    },
    [setAppState, commitHistorySelection_]
  );

  const STATUS_LABEL = useMemo(
    () => ({
      DRAFT: "下書き",
      READY_TO_SHIP: "配送準備完了",
      IN_PROGRESS: "処理中",
      IN_TRANSIT: "進行中",
      RECEIVED: "受領",
      TRANSFERRED: "入庫済み",
      CANCELED: "キャンセル",
      OTHER: "その他",
    }),
    []
  );

  const refreshOutboundHistory = useCallback(async () => {
    if (!originLocationGid) return;
    setHistoryLoading(true);
    setHistoryError("");

    // ✅ 再取得したら選択はいったん解除（ズレ防止）
    setSelectedHistoryTransfer(null);
    setStateSlice(setAppState, "outbound", {
      historySelectedTransferId: "",
      historySelectedTransferName: "",
      historySelectedOriginName: "",
      historySelectedDestName: "",
      historySelectedStatus: "",
      historySelectedReadOnly: false,
      historySelectedShipmentId: "",
    });

    try {
      const all = await fetchTransfersForOriginAll(originLocationGid);
      setHistoryTransfers(all);
    } catch (e) {
      setHistoryError(toUserMessage(e));
    } finally {
      setHistoryLoading(false);
    }
  }, [originLocationGid]);

  useEffect(() => {
    if (!originLocationGid) return;
    refreshOutboundHistory().catch(() => {});
  }, [originLocationGid, refreshOutboundHistory]);

  const onTapHistoryTransfer = useCallback(
    (t) => {
      if (!t || !t.id) return;

      const status = String(t?.status || "").toUpperCase();
      const readOnly = status === "TRANSFERRED";

      // ✅ Inbound同型：shipmentId を「混在吸収 helper」で確実に取る
      const shipmentId = String(getShipmentIdFromTransferForHistory(t) || "").trim();

      if (!shipmentId) return toast("履歴詳細に必要なshipmentIdが取得できませんでした");

      // ✅ OutboundHistoryDetail が読む state を必ず全部セット（未定義参照防止）
      setStateSlice(setAppState, "outbound", {
        historySelectedTransferId: String(t.id),
        historySelectedTransferName: String(t?.name || ""),
        historySelectedOriginName: String(t?.originName || ""),
        historySelectedDestName: String(t?.destinationName || ""),
        historySelectedStatus: String(t?.status || ""),
        historySelectedReadOnly: readOnly,
        historySelectedShipmentId: shipmentId,
      });

      onOpenOutboundHistoryDetail?.();
    },
    [setAppState, onOpenOutboundHistoryDetail]
  );

  // ===== 到着予定日時ユーティリティ（ローカルで作ってISO化） =====
  const makeArrivesIsoLocal_ = useCallback((daysFromToday, hh, mm) => {
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    d.setDate(d.getDate() + Number(daysFromToday || 0));
    d.setHours(Number(hh || 0), Number(mm || 0), 0, 0);
    return d.toISOString();
  }, []);

  const parseIsoToLocalParts_ = useCallback((iso) => {
    const s = String(iso || "").trim();
    if (!s) return null;
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return null;
    return {
      y: d.getFullYear(),
      m: d.getMonth(), // 0-based
      day: d.getDate(),
      hh: d.getHours(),
      mm: d.getMinutes(),
    };
  }, []);

  const localPartsToIso_ = useCallback((y, m0, day, hh, mm) => {
    const d = new Date(Number(y), Number(m0), Number(day), Number(hh || 0), Number(mm || 0), 0, 0);
    return d.toISOString();
  }, []);

  const normalizeYmd_ = useCallback((s) => {
    const t = String(s || "").trim();
    if (!t) return { ok: false, y: 0, m: 0, day: 0 };
    const m1 = t.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
    if (!m1) return { ok: false, y: 0, m: 0, day: 0 };
    const y = Number(m1[1]);
    const mo = Number(m1[2]);
    const day = Number(m1[3]);
    if (!y || mo < 1 || mo > 12 || day < 1 || day > 31) return { ok: false, y: 0, m: 0, day: 0 };
    return { ok: true, y, m: mo, day };
  }, []);

  const formatYmdFromIso_ = useCallback(
    (iso) => {
      const p = parseIsoToLocalParts_(iso);
      if (!p) return "";
      const y = String(p.y);
      const m = String(p.m + 1).padStart(2, "0");
      const d = String(p.day).padStart(2, "0");
      return `${y}-${m}-${d}`;
    },
    [parseIsoToLocalParts_]
  );

  const defaultTomorrowYmd_ = useMemo(() => {
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    d.setDate(d.getDate() + 1);
    const y = String(d.getFullYear());
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }, []);

  const arrivesTimeLabel = useMemo(() => {
    const cur = parseIsoToLocalParts_(outbound.arrivesAtIso);
    if (!cur) return "12:00";
    const hh = String(cur.hh).padStart(2, "0");
    const mm = String(cur.mm).padStart(2, "0");
    return `${hh}:${mm}`;
  }, [outbound.arrivesAtIso, parseIsoToLocalParts_]);

  // ✅ 初期は「1日後 12:00」を ISO + draft の両方に入れる（クリア後はしない）
  useEffect(() => {
    const isoCur = String(outbound.arrivesAtIso || "").trim();
    const draftCur = String(outbound.arrivesDateDraft || "").trim();

    if (isoCur) {
      if (!draftCur) {
        const ymd = formatYmdFromIso_(isoCur);
        if (ymd) setStateSlice(setAppState, "outbound", { arrivesDateDraft: ymd });
      }
      return;
    }

    if (outbound.arrivesAutoDisabled) return;

    const iso = makeArrivesIsoLocal_(1, 12, 0);
    const ymd = formatYmdFromIso_(iso) || defaultTomorrowYmd_;
    setStateSlice(setAppState, "outbound", { arrivesAtIso: iso, arrivesDateDraft: ymd });
  }, [
    outbound.arrivesAtIso,
    outbound.arrivesDateDraft,
    outbound.arrivesAutoDisabled,
    makeArrivesIsoLocal_,
    formatYmdFromIso_,
    defaultTomorrowYmd_,
    setAppState,
  ]);

  const applyTimeToArrivesIso_ = useCallback(
    (targetHh, targetMm) => {
      const cur = parseIsoToLocalParts_(outbound.arrivesAtIso);
      if (cur) {
        const iso = localPartsToIso_(cur.y, cur.m, cur.day, Number(targetHh), Number(targetMm));
        const ymd = formatYmdFromIso_(iso);
        setStateSlice(setAppState, "outbound", {
          arrivesAtIso: iso,
          arrivesDateDraft: ymd || outbound.arrivesDateDraft || "",
          showArrivesTimePicker: false,
          arrivesAutoDisabled: false,
        });
        return;
      }

      const iso = makeArrivesIsoLocal_(1, targetHh, targetMm);
      const ymd = formatYmdFromIso_(iso);
      setStateSlice(setAppState, "outbound", {
        arrivesAtIso: iso,
        arrivesDateDraft: ymd || outbound.arrivesDateDraft || defaultTomorrowYmd_,
        showArrivesTimePicker: false,
        arrivesAutoDisabled: false,
      });
    },
    [
      outbound.arrivesAtIso,
      outbound.arrivesDateDraft,
      parseIsoToLocalParts_,
      localPartsToIso_,
      makeArrivesIsoLocal_,
      formatYmdFromIso_,
      defaultTomorrowYmd_,
      setAppState,
    ]
  );

  // ✅ 右寄せプリセット（押したら必ず日付が見えるようにdraftも更新）
  const setArrivesPreset_ = useCallback(
    (kind) => {
      if (kind === "clear") {
        setStateSlice(setAppState, "outbound", {
          arrivesAtIso: "",
          arrivesDateDraft: "",
          showArrivesTimePicker: false,
          arrivesAutoDisabled: true,
        });
        return;
      }

      const days = kind === "d2" ? 2 : 1;

      const cur = parseIsoToLocalParts_(outbound.arrivesAtIso);
      const hh = cur ? cur.hh : 12;
      const mm = cur ? cur.mm : 0;

      const iso = makeArrivesIsoLocal_(days, hh, mm);
      const ymd = formatYmdFromIso_(iso);

      setStateSlice(setAppState, "outbound", {
        arrivesAtIso: iso,
        arrivesDateDraft: ymd || defaultTomorrowYmd_,
        showArrivesTimePicker: false,
        arrivesAutoDisabled: false,
      });
    },
    [
      outbound.arrivesAtIso,
      parseIsoToLocalParts_,
      makeArrivesIsoLocal_,
      formatYmdFromIso_,
      defaultTomorrowYmd_,
      setAppState,
    ]
  );

  // ✅ 日付入力：入力中はdraftだけ更新 → 確定（onChange）でISOへ反映
  const onArrivesDateDraftInput_ = useCallback(
    (e) => {
      const raw = readValue(e);
      setStateSlice(setAppState, "outbound", { arrivesDateDraft: raw, arrivesAutoDisabled: false });
    },
    [setAppState]
  );

  const onArrivesDateDraftCommit_ = useCallback(
    (e) => {
      const raw = readValue(e);
      const parsed = normalizeYmd_(raw);
      if (!parsed.ok) return;

      const cur = parseIsoToLocalParts_(outbound.arrivesAtIso);
      const hh = cur ? cur.hh : 12;
      const mm = cur ? cur.mm : 0;

      const iso = localPartsToIso_(parsed.y, parsed.m - 1, parsed.day, hh, mm);

      setStateSlice(setAppState, "outbound", {
        arrivesAtIso: iso,
        arrivesDateDraft: `${parsed.y}-${String(parsed.m).padStart(2, "0")}-${String(parsed.day).padStart(2, "0")}`,
        arrivesAutoDisabled: false,
      });
    },
    [normalizeYmd_, outbound.arrivesAtIso, parseIsoToLocalParts_, localPartsToIso_, setAppState]
  );

  const originLocationName = useMemo(() => {
    if (!originLocationGid) return "未取得";
    const fromIndex = getLocationName_(originLocationGid, locIndex.byId);
    if (fromIndex && fromIndex !== "（不明）") return fromIndex;
    return allLocations.find((l) => l.id === originLocationGid)?.name ?? "（不明）";
  }, [originLocationGid, locIndex.byId, allLocations]);

  const destinationGroups = useMemo(() => {
    const gs = Array.isArray(settings?.destinationGroups) ? settings.destinationGroups : [];
    return gs
      .map((g) => ({
        id: String(g.id ?? ""),
        name: String(g.name ?? ""),
        locationIds: Array.isArray(g.locationIds) ? g.locationIds.map(String) : [],
      }))
      .filter((g) => g.id && g.name);
  }, [settings]);

  const originGroups = useMemo(() => {
    if (!originLocationGid) return [];
    return destinationGroups.filter((g) => g.locationIds.includes(originLocationGid));
  }, [destinationGroups, originLocationGid]);

  const restrictedDestinationIds = useMemo(() => {
    if (!originLocationGid) return null;
    if (originGroups.length === 0) return null;

    const set = new Set();
    for (const g of originGroups) {
      for (const id of g.locationIds) {
        if (id && id !== originLocationGid) set.add(id);
      }
    }
    return Array.from(set);
  }, [originGroups, originLocationGid]);

  const destinationCandidates = useMemo(() => {
    if (!originLocationGid) return [];
    const base = allLocations.filter((l) => l.id !== originLocationGid);
    if (restrictedDestinationIds === null) return base;
    return base.filter((l) => restrictedDestinationIds.includes(l.id));
  }, [allLocations, originLocationGid, restrictedDestinationIds]);

  const selectedDestName = useMemo(() => {
    if (!outbound.destinationLocationId) return "未選択";
    return destinationCandidates.find((l) => l.id === outbound.destinationLocationId)?.name ?? "未選択";
  }, [destinationCandidates, outbound.destinationLocationId]);

  const carrierOptions = useMemo(() => {
    const cs = Array.isArray(settings?.carriers) ? settings.carriers : [];
    return cs
      .map((c) => ({
        id: String(c.id ?? ""),
        label: String(c.label ?? ""),
        company: String(c.company ?? ""),
      }))
      .filter((c) => c.id && c.label && c.company);
  }, [settings]);

  const selectedCarrier = useMemo(
    () => carrierOptions.find((c) => c.id === outbound.carrierId) ?? null,
    [carrierOptions, outbound.carrierId]
  );
  const selectedCarrierLabel = useMemo(() => (selectedCarrier ? selectedCarrier.label : "未選択"), [selectedCarrier]);

  const carrierCompanyText = useMemo(() => {
    const v = String(selectedCarrier?.company || "").trim();
    return v ? v : "";
  }, [selectedCarrier]);

  const showGroupFallbackNotice = !!originLocationGid && destinationGroups.length > 0 && originGroups.length === 0;

  async function bootstrap() {
    setLocationsLoading(true);
    setSettingsLoading(true);

    try {
      const data = await adminGraphql(
        `#graphql
        query Boot($first: Int!) {
          locations(first: $first) { nodes { id name } }
          currentAppInstallation {
            metafield(namespace: "${SETTINGS_NS}", key: "${SETTINGS_KEY}") { value type }
          }
        }`,
        { first: 250 }
      );

      const nodes = data?.locations?.nodes ?? [];

      const raw = data?.currentAppInstallation?.metafield?.value ?? null;
      const parsed = safeParseJson(raw, null);
      const nextSettings =
        parsed && parsed.version === 1 ? parsed : { version: 1, destinationGroups: [], carriers: [] };

      setStateSlice(setAppState, "outbound", (prev) => {
        const next = { ...prev, allLocations: nodes, settings: nextSettings };

        if (originLocationGid && !next.destinationLocationId) {
          const other = nodes.filter((l) => l.id !== originLocationGid);
          if (other.length > 0) next.destinationLocationId = other[0].id;
        }

        const cs = Array.isArray(nextSettings.carriers) ? nextSettings.carriers : [];
        const firstCarrierId = cs[0]?.id ? String(cs[0].id) : "";
        if (!next.carrierId && firstCarrierId) next.carrierId = firstCarrierId;

        if (next.carrierId && cs.length > 0) {
          const valid = cs.some((c) => String(c?.id || "") === String(next.carrierId));
          if (!valid) next.carrierId = firstCarrierId || "";
        }

        return next;
      });
    } catch (e) {
      toast(`初期化エラー: ${toUserMessage(e)}`);
      setStateSlice(setAppState, "outbound", (prev) => ({
        ...prev,
        allLocations: [],
        settings: { version: 1, destinationGroups: [], carriers: [] },
      }));
    } finally {
      setLocationsLoading(false);
      setSettingsLoading(false);
    }
  }

  useEffect(() => {
    bootstrap();
  }, [originLocationGid]);

  useEffect(() => {
    refreshOutboundHistory();
  }, [refreshOutboundHistory]);

  useEffect(() => {
    if (!originLocationGid) return;

    if (destinationCandidates.length === 0) {
      if (outbound.destinationLocationId) {
        setStateSlice(setAppState, "outbound", { destinationLocationId: "" });
      }
      return;
    }

    const stillValid = destinationCandidates.some((l) => l.id === outbound.destinationLocationId);
    if (!stillValid) {
      setStateSlice(setAppState, "outbound", { destinationLocationId: destinationCandidates[0].id });
    }
  }, [originLocationGid, restrictedDestinationIds, allLocations.length]);

  const canNext = !!originLocationGid && !!outbound.destinationLocationId;

  // フッター（固定）
  useEffect(() => {
    const summaryLeft = `出庫元: ${originLocationName}`;
    const summaryRight = `宛先: ${selectedDestName}`;

    setFooter?.(
      <FixedFooterNavBar
        summaryLeft={summaryLeft}
        summaryCenter=""
        summaryRight={summaryRight}
        middleLabel={`軽量:${liteMode ? "ON" : "OFF"}`}
        middleTone={liteMode ? "critical" : "default"}
        onMiddle={onToggleLiteMode}
        middleDisabled={typeof onToggleLiteMode !== "function"}
        leftLabel="戻る"
        onLeft={onBack}
        rightLabel="次へ"
        onRight={onNext}
        rightTone="success"
        rightDisabled={!canNext}
      />
    );

    return () => setFooter?.(null);
  }, [
    setFooter,
    originLocationName,
    selectedDestName,
    canNext,
    onBack,
    onNext,
    liteMode,
    onToggleLiteMode,
  ]);

  const pickManualOrigin = (id) => {
    setAppState((prev) => ({ ...(prev || {}), originLocationIdManual: id }));
    setStateSlice(setAppState, "outbound", (p) => ({
      ...p,
      showOriginPicker: false,
      destinationLocationId: p.destinationLocationId === id ? "" : p.destinationLocationId,
    }));
  };

  return (
    <s-box padding="base">
      <s-stack gap="base">
        {settingsLoading || locationsLoading ? <s-text tone="subdued">初期化中...</s-text> : null}

        {showGroupFallbackNotice ? (
          <s-text tone="subdued" size="small">
            ※この店舗が所属するグループが見つからないため、いまは全ロケーションを宛先候補として表示しています。
          </s-text>
        ) : null}

        {/* ===== 出庫元 & 宛先 ===== */}
        <s-stack gap="small">
          <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
            <s-box style={{ flex: "1 1 auto", minInlineSize: 0 }}>
              <s-text>出庫元: {originLocationName}</s-text>
              {!sessionOriginLocationGid && manualOriginLocationGid ? (
                <s-text tone="subdued" size="small">
                  （手動設定）
                </s-text>
              ) : null}
              {!originLocationGid ? (
                <s-text tone="critical" size="small">
                  出庫元が取得できません。下の「出庫元を設定」から選択してください。
                </s-text>
              ) : null}
            </s-box>

            <s-button
              kind="secondary"
              onClick={() =>
                setStateSlice(setAppState, "outbound", (p) => ({ ...p, showOriginPicker: !p.showOriginPicker }))
              }
            >
              出庫元を設定
            </s-button>
          </s-stack>

          {outbound.showOriginPicker ? (
            <s-stack gap="base">
              {allLocations.length === 0 ? (
                <s-text tone="subdued">ロケーション一覧がありません（再取得を試してください）</s-text>
              ) : (
                allLocations.map((l) => (
                  <s-button
                    key={l.id}
                    tone={l.id === originLocationGid ? "success" : undefined}
                    onClick={() => pickManualOrigin(l.id)}
                  >
                    {l.name}
                  </s-button>
                ))
              )}

              <s-stack direction="inline" justifyContent="end" gap="base">
                <s-button onClick={bootstrap}>再取得</s-button>
              </s-stack>
            </s-stack>
          ) : null}

          <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
            <s-box style={{ flex: "1 1 auto", minInlineSize: 0 }}>
              <s-text>宛先: {selectedDestName}（選択中）</s-text>
              {originLocationGid && destinationCandidates.length === 0 ? (
                <s-text tone="critical" size="small">
                  宛先候補がありません（グループ設定が “originのみ” になっていないか確認）
                </s-text>
              ) : null}
            </s-box>

            <s-button
              kind="secondary"
              onClick={() =>
                setStateSlice(setAppState, "outbound", (p) => ({ ...p, showDestPicker: !p.showDestPicker }))
              }
            >
              宛先を変更
            </s-button>
          </s-stack>

          {outbound.showDestPicker ? (
            <s-stack gap="base">
              {destinationCandidates.map((l) => (
                <s-button
                  key={l.id}
                  tone={l.id === outbound.destinationLocationId ? "success" : undefined}
                  onClick={() =>
                    setStateSlice(setAppState, "outbound", { destinationLocationId: l.id, showDestPicker: false })
                  }
                >
                  {l.name}
                </s-button>
              ))}

              <s-stack direction="inline" justifyContent="end" gap="base">
                <s-button onClick={bootstrap}>再取得</s-button>
              </s-stack>
            </s-stack>
          ) : null}
        </s-stack>

        <s-divider />

        {/* ===== 配送情報（任意） ===== */}
        <s-stack gap="base">
          <s-text emphasis="bold">配送情報（任意）</s-text>

          {/* 配送業者 */}
          {carrierOptions.length === 0 ? (
            <s-stack gap="base">
              <s-text tone="subdued" size="small">
                ※ 管理画面の「配送会社（選択式）」が未設定です。必要なら配送業者を手入力できます。
              </s-text>
              <s-text-field
                label="配送業者（任意）"
                placeholder='例: "Sagawa (JA)" / "Yamato (JA)"'
                value={String(outbound.manualCompany || "")}
                onInput={(e) => setStateSlice(setAppState, "outbound", { manualCompany: readValue(e) })}
                onChange={(e) => setStateSlice(setAppState, "outbound", { manualCompany: readValue(e) })}
              />
            </s-stack>
          ) : (
            <s-stack gap="base">
              <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
                <s-box style={{ flex: "1 1 auto", minInlineSize: 0 }}>
                  <s-text>配送業者: {selectedCarrierLabel}</s-text>
                  {carrierCompanyText ? (
                    <s-text tone="subdued" size="small">
                      {carrierCompanyText}
                    </s-text>
                  ) : null}
                </s-box>

                <s-button
                  kind="secondary"
                  onClick={() =>
                    setStateSlice(setAppState, "outbound", (p) => ({ ...p, showCarrierPicker: !p.showCarrierPicker }))
                  }
                >
                  配送業者を変更
                </s-button>
              </s-stack>

              {outbound.showCarrierPicker ? (
                <s-stack gap="base">
                  <s-button
                    tone={!outbound.carrierId ? "success" : undefined}
                    onClick={() => setStateSlice(setAppState, "outbound", { carrierId: "", showCarrierPicker: false })}
                  >
                    （未選択）
                  </s-button>

                  {carrierOptions.map((c) => (
                    <s-button
                      key={c.id}
                      tone={c.id === outbound.carrierId ? "success" : undefined}
                      onClick={() => setStateSlice(setAppState, "outbound", { carrierId: c.id, showCarrierPicker: false })}
                    >
                      {c.label}
                    </s-button>
                  ))}
                </s-stack>
              ) : null}

              {!outbound.carrierId ? (
                <s-text-field
                  label="配送業者（任意）"
                  placeholder='例: "Sagawa (JA)"'
                  value={String(outbound.manualCompany || "")}
                  onInput={(e) => setStateSlice(setAppState, "outbound", { manualCompany: readValue(e) })}
                  onChange={(e) => setStateSlice(setAppState, "outbound", { manualCompany: readValue(e) })}
                />
              ) : null}
            </s-stack>
          )}

          {/* 配送番号 */}
          <s-text-field
            label="配送番号（任意）"
            placeholder="例: 1234567890"
            value={String(outbound.trackingNumber || "")}
            onInput={(e) => setStateSlice(setAppState, "outbound", { trackingNumber: readValue(e) })}
            onChange={(e) => setStateSlice(setAppState, "outbound", { trackingNumber: readValue(e) })}
          />

          {/* ===== 到着予定（任意） ===== */}
          <s-stack gap="small">
            <s-text emphasis="bold">到着予定（任意）</s-text>

            <s-text-field
              label="日付"
              placeholder="YYYY-MM-DD"
              value={String(outbound.arrivesDateDraft || "")}
              onInput={onArrivesDateDraftInput_}
              onChange={onArrivesDateDraftCommit_}
            />

            <s-stack direction="inline" gap="small" justifyContent="end" alignItems="center">
              <s-button kind="secondary" onClick={() => setArrivesPreset_("d1")}>
                1日後
              </s-button>
              <s-button kind="secondary" onClick={() => setArrivesPreset_("d2")}>
                2日後
              </s-button>
              <s-button kind="secondary" onClick={() => setArrivesPreset_("clear")}>
                クリア
              </s-button>
            </s-stack>

            <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
              <s-box style={{ flex: "1 1 auto", minInlineSize: 0 }}>
                <s-text tone="subdued" size="small">
                  時間: {arrivesTimeLabel}（選択中）
                </s-text>
              </s-box>

              <s-button
                kind="secondary"
                onClick={() =>
                  setStateSlice(setAppState, "outbound", (p) => ({
                    ...p,
                    showArrivesTimePicker: !p.showArrivesTimePicker,
                  }))
                }
              >
                時間を選択
              </s-button>
            </s-stack>

            {outbound.showArrivesTimePicker ? (
              <s-stack gap="base">
                <s-button onClick={() => applyTimeToArrivesIso_(9, 0)}>午前中</s-button>
                <s-button onClick={() => applyTimeToArrivesIso_(12, 0)}>12:00</s-button>
                <s-button onClick={() => applyTimeToArrivesIso_(14, 0)}>14:00</s-button>
                <s-button onClick={() => applyTimeToArrivesIso_(16, 0)}>16:00</s-button>
                <s-button onClick={() => applyTimeToArrivesIso_(18, 0)}>18:00</s-button>

                <s-stack direction="inline" justifyContent="end" gap="base">
                  <s-button
                    kind="secondary"
                    onClick={() => setStateSlice(setAppState, "outbound", { showArrivesTimePicker: false })}
                  >
                    閉じる
                  </s-button>
                </s-stack>
              </s-stack>
            ) : null}
          </s-stack>
        </s-stack>

        {/* ===== 出庫履歴（別画面へ） ===== */}
        <s-divider />

        <s-stack gap="tight">
          <s-stack direction="inline" justifyContent="space-between" alignItems="center">
            <s-text emphasis="bold">出庫履歴</s-text>
            <s-button kind="secondary" onClick={() => onOpenOutboundHistoryConditions?.()}>
              履歴一覧
            </s-button>
          </s-stack>
        </s-stack>
      </s-stack>
    </s-box>
  );
}

async function pullScanFromQueue_() {
  const storage = SHOPIFY?.storage;
  if (!storage?.get || !storage?.set) return null;

  try {
    const cur = normalizeScanQueueObj_(await storage.get(SCAN_QUEUE_KEY));
    if (!cur.items.length) return null;

    const first = String(cur.items[0] || "").trim();
    const rest = cur.items.slice(1);

    // lastV/lastT は「直近pushの重複抑止」に使うので、pullでは基本維持
    await storage.set(SCAN_QUEUE_KEY, {
      items: rest,
      lastV: cur.lastV || "",
      lastT: Number(cur.lastT || 0),
      updatedAt: Date.now(),
    });

    return first || null;
  } catch (e) {
    console.error("pullScanFromQueue_ failed", e);
    return null;
  }
}

/**
 * 高速スキャンで「JANが連結」されても、1スキャン=1コードに分解する
 * - まず改行/空白/タブ/カンマで分割
 * - 残った「数字の塊」は EAN-13 / EAN-8 のチェックデジットで先頭から貪欲に切り出し
 * - 判定できない場合はそのまま1コードとして返す（安全フォールバック）
 */
function splitScanInputToCodes_(raw) {
  const s0 = String(raw ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!s0) return [];

  const tokens = s0
    .split(/[\s,]+/g)
    .map((t) => String(t).trim())
    .filter(Boolean);

  const out = [];
  for (const t of tokens) {
    if (/^\d+$/.test(t) && t.length >= 8) {
      const sliced = splitConcatenatedEan_(t);
      if (sliced.length) out.push(...sliced);
      else out.push(t);
      continue;
    }
    out.push(t);
  }
  return out;
}

function splitConcatenatedEan_(digits) {
  const s = String(digits);
  const out = [];
  let i = 0;

  while (i < s.length) {
    if (i + 13 <= s.length) {
      const c13 = s.slice(i, i + 13);
      if (isEan13_(c13)) {
        out.push(c13);
        i += 13;
        continue;
      }
    }
    if (i + 8 <= s.length) {
      const c8 = s.slice(i, i + 8);
      if (isEan8_(c8)) {
        out.push(c8);
        i += 8;
        continue;
      }
    }
    return [];
  }
  return out;
}

function isEan13_(code) {
  if (!/^\d{13}$/.test(code)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const n = code.charCodeAt(i) - 48;
    sum += i % 2 === 0 ? n : n * 3;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === (code.charCodeAt(12) - 48);
}

function isEan8_(code) {
  if (!/^\d{8}$/.test(code)) return false;
  let sum = 0;
  for (let i = 0; i < 7; i++) {
    const n = code.charCodeAt(i) - 48;
    sum += i % 2 === 0 ? n * 3 : n;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === (code.charCodeAt(7) - 48);
}

// ✅ Outbound履歴：Transfer から ShipmentId を取り出す（v39/v40/v43 混在吸収）
function getShipmentIdFromTransferForHistory(t) {
  // v43: { shipmentIds: [...] }
  const ids = Array.isArray(t?.shipmentIds) ? t.shipmentIds : [];
  const id0 = String(ids?.[0] || "").trim();
  if (id0) return id0;

  // v39/v40: { shipments: [{ id, ... }] }
  const ships = Array.isArray(t?.shipments) ? t.shipments : [];
  const s0 = String(ships?.[0]?.id || "").trim();
  if (s0) return s0;

  // 生GraphQL: { shipments: { nodes: [{ id, ... }] } }
  const nodes = Array.isArray(t?.shipments?.nodes) ? t.shipments.nodes : [];
  const n0 = String(nodes?.[0]?.id || "").trim();
  return n0;
}

/* =========================
   OutboundHistoryConditions（出庫履歴一覧 / InboundConditions同型）
   - タブ: 左右50%領域確保（Inboundと同じ）
   - 行: ボタンではなく情報テキストのタップ行（Inboundと同じ）
   - 更新/戻る: 固定フッターのみ
========================= */

function OutboundHistoryConditions({
  showImages,
  liteMode,
  appState,
  setAppState,
  onBack,
  setHeader,
  setFooter,
  onToggleLiteMode,
  onOpenOutboundHistoryDetail,
}) {
  useEffect(() => {
    setHeader?.(null);
    return () => setHeader?.(null);
  }, [setHeader]);

  const sessionOriginLocationGid = useOriginLocationGid();
  const manualOriginLocationGid = String(appState?.originLocationIdManual || "").trim();
  const originLocationGid = sessionOriginLocationGid || (manualOriginLocationGid ? manualOriginLocationGid : null);

  const locIndex = useLocationsIndex(appState, setAppState);

  const outbound = getStateSlice(appState, "outbound", { allLocations: [] });
  const allLocations = Array.isArray(outbound.allLocations) ? outbound.allLocations : [];

  const originLocationName = useMemo(() => {
    if (!originLocationGid) return "未取得";
    const fromIndex = getLocationName_(originLocationGid, locIndex.byId);
    if (fromIndex && fromIndex !== "（不明）") return fromIndex;
    return allLocations.find((l) => l.id === originLocationGid)?.name ?? "（不明）";
  }, [originLocationGid, locIndex.byId, allLocations]);

  const [historyMode, setHistoryMode] = useState("active"); // "active" | "done"
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [historyTransfers, setHistoryTransfers] = useState([]);

  const STATUS_LABEL = useMemo(
    () => ({
      DRAFT: "下書き",
      READY_TO_SHIP: "配送準備完了",
      IN_PROGRESS: "処理中",
      IN_TRANSIT: "進行中",
      RECEIVED: "受領",
      TRANSFERRED: "入庫済み",
      CANCELED: "キャンセル",
      OTHER: "その他",
    }),
    []
  );

  const formatDate = (iso) => {
    const s = String(iso || "").trim();
    if (!s) return "-";
    return s.slice(0, 10);
  };

  const refreshOutboundHistory = useCallback(async () => {
    if (!originLocationGid) return;
    setHistoryLoading(true);
    setHistoryError("");

    // ✅ 再取得時は選択をクリア（ズレ防止）
    setStateSlice(setAppState, "outbound", {
      historySelectedTransferId: "",
      historySelectedTransferName: "",
      historySelectedOriginName: "",
      historySelectedDestName: "",
      historySelectedStatus: "",
      historySelectedReadOnly: false,
      historySelectedShipmentId: "",
    });

    try {
      const all = await fetchTransfersForOriginAll(originLocationGid);
      setHistoryTransfers(Array.isArray(all) ? all : []);
    } catch (e) {
      setHistoryError(toUserMessage(e));
    } finally {
      setHistoryLoading(false);
    }
  }, [originLocationGid, setAppState]);

  useEffect(() => {
    if (!originLocationGid) return;
    refreshOutboundHistory().catch(() => {});
  }, [originLocationGid, refreshOutboundHistory]);

  // ✅ “完了扱い” 判定（未定義参照で落ちないように、このコンポーネント内で必ず定義する）
  const isCompletedTransfer = useCallback((t) => {
    const s = String(t?.status || "").toUpperCase();
    return s === "TRANSFERRED" || s === "RECEIVED" || s === "CANCELED";
  }, []);

  const isCompleted = useCallback((t) => isCompletedTransfer(t), []);
  const baseAll = Array.isArray(historyTransfers) ? historyTransfers : [];
  const activeTransfersAll = baseAll.filter((t) => !isCompleted(t));
  const doneTransfersAll = baseAll.filter((t) => isCompleted(t));

  const listToShow = useMemo(() => {
    return historyMode === "done" ? doneTransfersAll : activeTransfersAll;
  }, [historyMode, doneTransfersAll, activeTransfersAll]);

  const onTapHistoryTransfer = useCallback(
    (t) => {
      if (!t || !t.id) return;

      const status = String(t?.status || "").toUpperCase();
      const readOnly = status === "TRANSFERRED" || isCompleted(t);

      const shipmentId = getShipmentIdFromTransferForHistory(t);

      setStateSlice(setAppState, "outbound", {
        historySelectedTransferId: String(t.id),
        historySelectedTransferName: String(t?.name || ""),
        historySelectedOriginName: String(t?.originName || ""),
        historySelectedDestName: String(t?.destinationName || ""),
        historySelectedStatus: String(t?.status || ""),
        historySelectedReadOnly: !!readOnly,
        historySelectedShipmentId: String(shipmentId || ""),
      });

      onOpenOutboundHistoryDetail?.();
    },
    [setAppState, onOpenOutboundHistoryDetail, isCompleted]
  );

  // ✅ Footer（戻る／軽量／再取得）…InboundConditionsと同型
  useEffect(() => {
    const summaryLeft = `出庫元: ${originLocationName}`;
    const summaryRight =
      historyMode === "done"
        ? `処理済み ${listToShow.length}件`
        : `処理中 ${listToShow.length}件`;

    setFooter?.(
      <FixedFooterNavBar
        summaryLeft={summaryLeft}
        summaryRight={summaryRight}
        leftLabel="戻る"
        onLeft={onBack}
        middleLabel={liteMode ? "軽量:ON" : "軽量:OFF"}
        middleTone={liteMode ? "critical" : "default"}
        onMiddle={onToggleLiteMode}
        middleDisabled={typeof onToggleLiteMode !== "function"}
        rightLabel={historyLoading ? "取得中..." : "再取得"}
        onRight={refreshOutboundHistory}
        rightTone="secondary"
        rightDisabled={!originLocationGid || historyLoading}
      />
    );
    return () => setFooter?.(null);
  }, [
    setFooter,
    originLocationName,
    historyMode,
    listToShow.length,
    liteMode,
    onToggleLiteMode,
    onBack,
    refreshOutboundHistory,
    originLocationGid,
    historyLoading,
  ]);

  return (
    <s-box padding="base">
      <s-stack gap="base">
        {/* ✅ タブ（左右50%ずつ“領域”を確保：Inboundと同じ） */}
        <s-stack direction="inline" gap="none" inlineSize="100%">
          <s-box inlineSize="50%">
            <s-button
              kind={historyMode === "active" ? "primary" : "secondary"}
              onClick={() => setHistoryMode("active")}
            >
              処理中 {activeTransfersAll.length}件
            </s-button>
          </s-box>

          <s-box inlineSize="50%">
            <s-button
              kind={historyMode === "done" ? "primary" : "secondary"}
              onClick={() => setHistoryMode("done")}
            >
              処理済み {doneTransfersAll.length}件
            </s-button>
          </s-box>
        </s-stack>

        {historyError ? <s-text tone="critical">{historyError}</s-text> : null}

        {listToShow.length === 0 ? (
          <s-text tone="subdued" size="small">
            {historyLoading ? "取得中..." : "表示できる履歴がありません"}
          </s-text>
        ) : (
          <s-stack gap="base">
            {listToShow.map((t) => {
              const head = String(t?.name || "").trim() || "出庫ID";
              const date = formatDate(t?.dateCreated);
              const origin = t?.originName || "-";
              const dest = t?.destinationName || "-";
              const total = Number(t?.totalQuantity ?? 0);
              const received = Number(t?.receivedQuantity ?? 0);

              const rawStatus = String(t?.status || "").trim();
              const statusJa = STATUS_LABEL[rawStatus] || (rawStatus ? rawStatus : "不明");

              return (
                <s-clickable key={t.id} onClick={() => onTapHistoryTransfer(t)}>
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
                        出庫元: {origin}
                      </s-text>

                      <s-text tone="subdued" size="small" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        入庫先: {dest}
                      </s-text>

                      <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="small">
                        <s-text tone="subdued" size="small" style={{ whiteSpace: "nowrap" }}>
                          状態: {statusJa}
                        </s-text>
                        <s-text tone="subdued" size="small" style={{ whiteSpace: "nowrap" }}>
                          {received}/{total}
                        </s-text>
                      </s-stack>
                    </s-stack>
                  </s-box>
                  <s-divider />
                </s-clickable>
              );
            })}
          </s-stack>
        )}
      </s-stack>
    </s-box>
  );
}

/* =========================
   OutboundHistoryDetail
========================= */

function OutboundHistoryDetail({
  showImages,
  liteMode,
  appState,
  setAppState,
  onBack,
  dialog,
  setHeader,
  setFooter,
  onToggleLiteMode,
  onOpenOutboundList,
}) {
  const outbound = getStateSlice(appState, "outbound", {
    historySelectedTransferId: "",
    historySelectedTransferName: "",
    historySelectedOriginName: "",
    historySelectedDestName: "",
    historySelectedStatus: "",
    historySelectedReadOnly: false,
    historySelectedShipmentId: "",
    historySelectedOriginLocationId: "",
    historySelectedDestLocationId: "",
  });

  const transferId = String(outbound.historySelectedTransferId || "").trim();
  const selectedShipmentId = String(outbound.historySelectedShipmentId || "").trim();

  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [detail, setDetail] = useState(null); // fetchInventoryTransferDetailForHistory result
  const [items, setItems] = useState([]); // unified display items
  const [cancelArmedAt, setCancelArmedAt] = useState(0);

  const loadSeqRef = useRef(0);
  const abortRef = useRef(null);

  useEffect(() => {
    return () => {
      try {
        abortRef.current?.abort?.(new Error("unmount"));
      } catch {}
    };
  }, []);

  const STATUS_LABEL = useMemo(
    () => ({
      DRAFT: "下書き",
      READY_TO_SHIP: "配送準備完了",
      IN_PROGRESS: "処理中",
      IN_TRANSIT: "進行中",
      RECEIVED: "受領",
      TRANSFERRED: "入庫済み",
      CANCELED: "キャンセル",
      OTHER: "その他",
    }),
    []
  );

  // ✅ 親から毎回変わる可能性がある関数は ref に逃がして deps から外す（無限レンダー防止）
  const openOutboundListRef = useRef(null);

  useEffect(() => {
    openOutboundListRef.current = typeof onOpenOutboundList === "function" ? onOpenOutboundList : null;
  }, [onOpenOutboundList]);

  const onEdit_ = useCallback(() => {
    openOutboundListRef.current?.();
  }, []);

  const createDraftAndOpen_ = useCallback(async () => {
    if (!detail?.id) return;

    // ✅ OutboundList の「下書き復元」に勝つため、先に保存下書きを消す
    try {
      if (SHOPIFY?.storage?.delete) {
        await SHOPIFY.storage.delete(OUTBOUND_DRAFT_KEY);
      }
    } catch {}

    // ✅ items → OutboundList 用 lines を作る（ここはあなたの lines 形式に合わせて）
    const nextLines = (Array.isArray(items) ? items : []).map((it, i) => {
      const q = Math.max(0, Number(it.quantity ?? it.qty ?? 0));
      return {
        id: String(it.key || i),
        variantId: it.variantId ?? null,
        inventoryItemId: it.inventoryItemId ?? null,
        sku: String(it.sku || ""),
        barcode: String(it.barcode || ""),
        productTitle: String(it.productTitle || ""),
        variantTitle: String(it.variantTitle || ""),
        imageUrl: String(it.imageUrl || ""),
        qty: q,          // ✅ OutboundList が参照する本体
        quantity: q,     // ✅ 既存ロジック互換（draft保存など）
        // stock系など必要なら追加
      };
    });

    // ✅ 既存Transferは触らず、OutboundList を「新規下書き」扱いで初期化
    setStateSlice(setAppState, "outbound", (prev) => ({
      ...(prev || {}),
      destinationLocationId: detail.destinationLocationId || prev?.destinationLocationId || "",
      lines: nextLines,

      // 履歴選択は解除（戻っても選択状態が残らない）
      historySelectedTransferId: "",
      historySelectedTransferName: "",
      historySelectedOriginName: "",
      historySelectedDestName: "",
      historySelectedStatus: "",
      historySelectedReadOnly: false,

      // 任意：どの履歴から作ったか
      historyDraftSourceTransferId: detail.id,
    }));

    // ✅ OutboundListへ
    openOutboundListRef.current?.();
  }, [detail, items, setAppState]);

  // ✅ 「編集」＝同ID編集モードでOutboundListへ（下書き蓄積させない）
  const openEditAndOpen_ = useCallback(() => {
    if (!detail?.id) return;

    const nextLines = (Array.isArray(items) ? items : []).map((it, i) => ({
      id: String(it.key || i),
      variantId: it.variantId ?? null,
      inventoryItemId: it.inventoryItemId ?? null,
      sku: String(it.sku || ""),
      barcode: String(it.barcode || ""),
      productTitle: String(it.productTitle || ""),
      variantTitle: String(it.variantTitle || ""),
      imageUrl: String(it.imageUrl || ""),
      quantity: Number(it.quantity ?? 0),
    }));

    setStateSlice(setAppState, "outbound", (prev) => ({
      ...(prev || {}),
      // ✅ ここが本丸：OutboundList側で「同ID更新」に分岐するためのフラグ
      editingTransferId: String(detail.id),

      destinationLocationId: detail.destinationLocationId || prev?.destinationLocationId || "",
      lines: nextLines,

      // 履歴選択は解除（戻っても選択状態が残らない）
      historySelectedTransferId: "",
      historySelectedTransferName: "",
      historySelectedOriginName: "",
      historySelectedDestName: "",
      historySelectedStatus: "",
      historySelectedReadOnly: false,

      // ✅ 編集なので「どの履歴から複製したか」は空にする
      historyDraftSourceTransferId: "",
    }));

    openOutboundListRef.current?.();
  }, [detail, items, setAppState]);

  const title = useMemo(() => {
    const name = String(outbound.historySelectedTransferName || "").trim();
    if (name) return `${name}`;
    if (transferId) return `#${transferId.slice(-6)}`;
    return "出庫履歴詳細";
  }, [outbound.historySelectedTransferName, transferId]);

  const statusLabel = useMemo(() => {
    const s = String(outbound.historySelectedStatus || detail?.status || "").toUpperCase();
    return STATUS_LABEL[s] || s || "不明";
  }, [outbound.historySelectedStatus, detail?.status, STATUS_LABEL]);

  const statusRaw = useMemo(() => {
    return String(outbound.historySelectedStatus || detail?.status || "").toUpperCase();
  }, [outbound.historySelectedStatus, detail?.status]);

  // ✅ 編集モード（スキャン/検索/数量/確定 = OutboundList に任せる）
  const isEditable = statusRaw === "DRAFT" || statusRaw === "READY_TO_SHIP";

  // ✅ 処理中/処理済み（=複製＋キャンセルのみ）
  const isReadOnlyOps = !isEditable;

  const loadDetail_ = useCallback(async () => {
    if (!transferId) return;

    const seq = ++loadSeqRef.current;
    try {
      abortRef.current?.abort?.(new Error("reload"));
    } catch {}
    const ac = new AbortController();
    abortRef.current = ac;

    setDetailLoading(true);
    setDetailError("");
    setItems([]);

    try {
      const d = await fetchInventoryTransferDetailForHistory({ id: transferId, signal: ac.signal });
      if (seq !== loadSeqRef.current) return;

      setDetail(d);

      // ✅ shipmentId があれば shipment ベースで items を作る（画像/商品情報が揃う）
      const sid = String(selectedShipmentId || d?.shipments?.[0]?.id || "").trim();

      if (sid) {
        // ✅ state にも反映（次回以降の安定化）
        // 注意: setStateSliceを呼び出すとselectedShipmentIdが変更され、loadDetail_が再実行される可能性がある
        // そのため、この処理はコメントアウトして無限ループを防ぐ
        // 親コンポーネントでselectedShipmentIdを管理する
        // if (!selectedShipmentId && setAppStateRef.current) {
        //   try {
        //     setStateSlice(setAppStateRef.current, "outbound", { historySelectedShipmentId: sid });
        //   } catch (e) {
        //     console.warn("setStateSlice error in loadDetail_:", e);
        //   }
        // }

        try {
          const includeImages = !!showImages && !liteMode;

          // ✅ v51の関数定義に合わせる：fetchInventoryShipmentEnriched(id, { includeImages, signal })
          const ship = await fetchInventoryShipmentEnriched(sid, {
            includeImages,
            signal: ac.signal,
          });
          if (seq !== loadSeqRef.current) return;

          const src = Array.isArray(ship?.lineItems) ? ship.lineItems : [];

          // ✅ 同一商品をマージ（Inboundと同じ考え方）
          const map = new Map();
          for (const li of src) {
            const key = String(li?.inventoryItemId || li?.variantId || li?.id || "").trim();
            if (!key) continue;

            const qty = Number(li?.quantity ?? 0);
            const prev = map.get(key);
            if (prev) {
              prev.quantity += qty;
            } else {
              map.set(key, {
                key,
                inventoryItemId: li?.inventoryItemId ?? null,
                variantId: li?.variantId ?? null,
                sku: String(li?.sku || ""),
                barcode: String(li?.barcode || ""),
                productTitle: String(li?.productTitle || ""),
                variantTitle: String(li?.variantTitle || ""),
                imageUrl: String(li?.imageUrl || ""),
                quantity: qty,

                // ✅ 追加：UI表示用（無ければ null）
                available: li?.available ?? null,
                plannedQuantity: li?.plannedQuantity ?? li?.quantity ?? null,
                receivedQuantity: li?.receivedQuantity ?? null,
              });
            }
          }

          setItems(Array.from(map.values()));
          return;
        } catch (e) {
          // shipment 読めなくても transfer lineItems で表示継続
        }
      }

      // ✅ shipment が無い/読めない場合：下書き状態の場合はfetchTransferLineItemsEnrichedで画像付きで取得
      const includeImages = !!showImages && !liteMode;
      try {
        const transferLineItems = await fetchTransferLineItemsEnriched(transferId, {
          includeImages,
          signal: ac.signal,
        });
        if (seq !== loadSeqRef.current) return;

        const src = Array.isArray(transferLineItems) ? transferLineItems : [];
        const detailLineItems = Array.isArray(d?.lineItems) ? d.lineItems : [];

        // ✅ 数量情報をdetailLineItemsから取得してマージ
        const quantityMap = new Map();
        for (const dli of detailLineItems) {
          const key = String(dli?.inventoryItemId || "").trim();
          if (!key) continue;
          const qty = Number(dli.shippableQuantity ?? 0) + Number(dli.shippedQuantity ?? 0);
          quantityMap.set(key, qty);
        }

        // ✅ 同一商品をマージ（画像情報 + 数量情報）
        const map = new Map();
        for (const li of src) {
          const key = String(li?.inventoryItemId || li?.variantId || li?.id || "").trim();
          if (!key) continue;

          // ✅ 数量はdetailLineItemsから取得、なければ0
          const qty = quantityMap.get(li?.inventoryItemId) ?? Number(li?.quantity ?? 0);
          const prev = map.get(key);
          if (prev) {
            prev.quantity += qty;
          } else {
            map.set(key, {
              key,
              inventoryItemId: li?.inventoryItemId ?? null,
              variantId: li?.variantId ?? null,
              sku: String(li?.sku || ""),
              barcode: String(li?.barcode || ""),
              productTitle: String(li?.productTitle || ""),
              variantTitle: String(li?.variantTitle || ""),
              imageUrl: String(li?.imageUrl || ""),
              quantity: qty,

              // ✅ UI表示用
              available: null,
              plannedQuantity: qty,
              receivedQuantity: null,
            });
          }
        }

        setItems(Array.from(map.values()));
        return;
      } catch (e) {
        // ✅ fetchTransferLineItemsEnrichedが失敗した場合はtransfer lineItems で最低限表示（止めない）
      }

      // ✅ フォールバック：transfer lineItems で最低限表示（画像なし）
      const lis = Array.isArray(d?.lineItems) ? d.lineItems : [];
      setItems(
        lis.map((li, i) => {
          const qty = Number(li.shippableQuantity ?? 0) + Number(li.shippedQuantity ?? 0);
          return {
            key: String(li.id || i),
            productTitle: String(li.title || ""),
            variantTitle: "",
            sku: String(li.sku || ""),
            barcode: "",
            imageUrl: "",
            quantity: qty,

            available: null,
            plannedQuantity: qty,
            receivedQuantity: null,
          };
        })
      );
    } catch (e) {
      console.error("loadDetail_ error:", e);
      setDetailError(String(e?.message || e || "詳細の取得に失敗しました"));
      // ✅ エラー時もitemsを空配列に設定（「商品がありません」メッセージを表示）
      setItems([]);
    } finally {
      if (seq === loadSeqRef.current) {
        setDetailLoading(false);
      }
    }
  }, [transferId, selectedShipmentId, showImages, liteMode]);

  useEffect(() => {
    loadDetail_();
  }, [loadDetail_]);

  const onDuplicate_ = useCallback(async () => {
    if (!transferId) return;

    try {
      const dup = await inventoryTransferDuplicateSafe({ id: transferId });
      const newId = String(dup?.id || "").trim();
      const newName = String(dup?.name || "").trim();

      if (!newId) throw new Error("複製に失敗しました（新しいTransfer IDが取得できません）");

      toast(`複製しました：${newName ? "#" + newName : "#" + newId.slice(-6)}`);

      // ✅ この画面のまま、新しいTransferを表示
      setStateSlice(setAppState, "outbound", {
        historySelectedTransferId: newId,
        historySelectedTransferName: newName,
        historySelectedStatus: String(dup?.status || "DRAFT"),
        historySelectedShipmentId: "",
      });
    } catch (e) {
      toast(String(e?.message || e || "複製に失敗しました"));
    }
  }, [transferId, setAppState]);

  const confirm_ = dialog?.confirm;

  // ✅ confirm を ref に退避（レンダー毎に同期代入＝ズレない）
  const confirmRef = useRef(null);

  useEffect(() => {
    confirmRef.current =
      typeof dialog?.confirm === "function"
        ? (opts) => dialog.confirm(opts)
        : null;
  }, [dialog]);

  const onCancel_ = useCallback(async () => {
    // ✅ ここが空だと「押しても無反応」になるので必ず通知する
    if (!transferId) {
      toast("キャンセルできません（transferId 未取得）");
      return;
    }

    const confirmFn = confirmRef.current;
    if (typeof confirmFn !== "function") {
      toast("確認ダイアログが利用できません（dialog未接続）");
      return;
    }

    let ok = false;
    try {
      ok = await confirmFn({
        type: "destructive",
        title: "キャンセル確認",
        content:
          "この出庫（移管）をキャンセルします。処理中のものは状態/権限により失敗する可能性があります。\nよろしいですか？",
        actionText: "キャンセルする",
        secondaryActionText: "戻る",
      });
    } catch (e) {
      toast(`確認ダイアログ表示に失敗しました: ${String(e?.message || e)}`);
      return;
    }

    // ✅ ok が undefined になるケースがあり得るので true 以外はキャンセル扱い
    if (ok !== true) return;

    try {
      await inventoryTransferCancelSafe({ id: transferId });
      toast("キャンセルしました");
      onBack?.();
    } catch (e) {
      toast(String(e?.message || e || "キャンセルに失敗しました（権限/状態により不可の可能性）"));
    }
  }, [transferId, onBack]);

  const headerNode = useMemo(() => {
    return (
      <s-box padding="base">
        <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
          {/* ✅ 左：ID + 出庫元 + 入庫先 を “3行まとめて” */}
          <s-box style={{ flex: "1 1 auto", minInlineSize: 0 }}>
            <s-stack gap="extra-tight">
              <s-text emphasis="bold">{title}</s-text>

              <s-text tone="subdued" size="small">
                出庫元: {outbound.historySelectedOriginName || detail?.originName || "（不明）"}
              </s-text>
              <s-text tone="subdued" size="small">
                入庫先: {outbound.historySelectedDestName || detail?.destinationName || "（不明）"}
              </s-text>
            </s-stack>
          </s-box>

          {/* ✅ 右：複製ボタン */}
          <s-box style={{ flex: "0 0 auto" }}>
            <s-button tone="success" onClick={onDuplicate_}>
              複製（下書き）
            </s-button>
          </s-box>
        </s-stack>
      </s-box>
    );
  }, [
    title,
    outbound.historySelectedOriginName,
    outbound.historySelectedDestName,
    detail?.originName,
    detail?.destinationName,
    onDuplicate_,
  ]);

  const bindPress = (fn) => ({
    onClick: fn,
    onPress: fn,
  });

  useEffect(() => {
    setHeader?.(headerNode);
    return () => {
      setHeader?.(null);
    };
  }, [setHeader, headerNode]);

  useEffect(() => {
    const summaryLeft = `状態: ${statusLabel}`;
    const summaryRight = `数量: ${Number(detail?.receivedQuantity ?? 0)}/${Number(detail?.totalQuantity ?? 0)}`;

    setFooter?.(
      <FixedFooterNavBar
        summaryLeft={summaryLeft}
        summaryRight={summaryRight}
        leftLabel="戻る"
        onLeft={onBack}
        middleLabel={isEditable ? "編集" : "複製（下書き）"}
        onMiddle={isEditable ? openEditAndOpen_ : onDuplicate_}
        middleTone="success"
        rightLabel="キャンセル"
        onRight={onCancel_}
        rightTone="critical"
      />
    );

    return () => setFooter?.(null);
  }, [
    setFooter,
    statusLabel,
    detail?.receivedQuantity,
    detail?.totalQuantity,
    isEditable,
    onBack,
    onEdit_,
    onDuplicate_,
    onCancel_,
  ]);

  return (
    <s-box padding="tight">
      <s-stack gap="tight">
        {detailLoading ? <s-text tone="subdued">読み込み中…</s-text> : null}
        {detailError ? <s-text tone="critical">{detailError}</s-text> : null}

        <s-divider />

        {/* ✅ 商品リスト */}
        {Array.isArray(items) && items.length > 0 ? (
          <s-stack gap="none">
            {items.map((it, idx) => {
              const optionsLine = String(it.variantTitle || "").trim();
              const sku = String(it.sku || "").trim();
              const jan = String(it.barcode || "").trim();

              const skuJanLine =
                sku || jan
                  ? `${sku ? `SKU: ${sku}` : ""}${sku && jan ? " / " : ""}${jan ? `JAN: ${jan}` : ""}`
                  : "";

              // ✅ 状態で「画像下の行」に出す文言を切替（見た目はInbound/Outbound寄せ）
              const belowLeft = isEditable
                ? `在庫: ${it.available ?? "—"}`
                : `予定: ${Number(it.plannedQuantity ?? it.quantity ?? 0)} / 受領: ${Number(
                    it.receivedQuantity ?? 0
                  )}`;

              // ✅ 右側はボタンではなく “数量表示だけ”
              const belowRight = isEditable ? `数量: ${Number(it.quantity ?? 0)}` : "";

              return (
                <s-box key={it.key} padding="none">
                  <s-box padding="base">
                    <s-stack gap="extra-tight">
                      <ItemLeftInline
                        showImages={!!showImages && !liteMode}
                        imageUrl={String(it.imageUrl || "")}
                        productTitle={String(it.productTitle || "")}
                        variantTitle={optionsLine}
                        line3={skuJanLine}
                      />

                      {/* ✅ 2行目（Inbound/Outbound の “在庫/予定受領” 行に寄せる） */}
                      <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                        <s-text tone="subdued" size="small">
                          {belowLeft}
                        </s-text>

                        {belowRight ? (
                          <s-text tone="subdued" size="small">
                            {belowRight}
                          </s-text>
                        ) : (
                          <s-box />
                        )}
                      </s-stack>
                    </s-stack>
                  </s-box>

                  {/* divider は padding の外へ（上下の偏りを消す） */}
                  {idx < items.length - 1 ? <s-divider /> : null}
                </s-box>
              );
            })}
          </s-stack>
        ) : (
          <s-text tone="subdued">商品がありません（Shipment未作成の下書き等の可能性）</s-text>
        )}
      </s-stack>
    </s-box>
  );
}

/* =========================
   OutboundList（貼り替え完全版 / 同一SKU安定版）
   - 外部スキャンは Extension 側で toast 表示できている前提
   - このリスト側で「SCAN_QUEUE_KEY を購読」して処理（queue滞留数/RPS計測）
   - JAN/SKU -> variant は resolveVariantByCode（永続キャッシュ）で高速化
   - ✅ 連続スキャンで “同一SKUが別行になる” を防ぐため、hit判定を必ず setLines(prev) 内で実施
========================= */

function OutboundList({
  showImages,
  liteMode,
  onToggleLiteMode,
  appState,
  setAppState,
  onBack,
  dialog,
  setHeader,
  setFooter,
}) {
  const UI_REV = "OutboundList v2025-12-30 UI-FIX";
  const DEBUG_UI = false; // ✅ デバッグ表示は消す（必要なら true）

  const CONFIRM_TRANSFER_MODAL_ID = "confirm-transfer-modal";

  const originLocationGid =
    useOriginLocationGid() || String(appState?.originLocationIdManual || "").trim() || null;

  const debug = (..._args) => {};

  const outbound = getStateSlice(appState, "outbound", {
    destinationLocationId: "",
    carrierId: "",
    manualCompany: "",
    trackingNumber: "",
    trackingUrl: "",
    arrivesAtIso: "",
    settings: { version: 1, destinationGroups: [], carriers: [] },
    allLocations: [],
    lines: [],
    editingTransferId: "",
    draftTransferId: "",
    result: null,
  });

  const settings =
    outbound.settings && typeof outbound.settings === "object"
      ? outbound.settings
      : { version: 1, destinationGroups: [], carriers: [] };

  const carrierOptions = useMemo(() => {
    const cs = Array.isArray(settings?.carriers) ? settings.carriers : [];
    return cs
      .map((c) => ({
        id: String(c.id ?? ""),
        label: String(c.label ?? ""),
        company: String(c.company ?? ""),
      }))
      .filter((c) => c.id && c.label && c.company);
  }, [settings]);

  const selectedCarrier = useMemo(
    () => carrierOptions.find((c) => c.id === outbound.carrierId) ?? null,
    [carrierOptions, outbound.carrierId]
  );

  const resolvedCompany = useMemo(() => {
    const fromSelected = String(selectedCarrier?.company || "").trim();
    if (fromSelected) return fromSelected;
    return String(outbound.manualCompany || "").trim();
  }, [selectedCarrier, outbound.manualCompany]);

  const trackingNumberTrim = String(outbound.trackingNumber || "").trim();
  const trackingUrlTrim = String(outbound.trackingUrl || "").trim();

  // 追跡“番号/URL”が入っている時だけ true（これが今回欲しい判定）
  const hasTrackingRef = !!trackingNumberTrim || !!trackingUrlTrim;

  const confirmTransferModalRef = useRef(null);

  // （必要なら）到着予定や配送会社まで含めた「配送メタが入ってる」判定
  const hasShipmentMeta =
    hasTrackingRef ||
    !!String(outbound.arrivesAtIso || "").trim() ||
    !!resolvedCompany;

  const destinationLocationId = String(outbound.destinationLocationId || "");
  const lines = Array.isArray(outbound.lines) ? outbound.lines : [];
  const draftTransferId = String(outbound.draftTransferId || "").trim();

  // -------------------------
  // 値/イベント両対応ヘルパ
  // -------------------------
  const readText = (v) => {
    if (typeof v === "string" || typeof v === "number") return String(v);
    const tv = v?.target?.value;
    if (typeof tv === "string" || typeof tv === "number") return String(tv);
    const dv = v?.detail?.value;
    if (typeof dv === "string" || typeof dv === "number") return String(dv);
    return "";
  };

  const bindPress = (fn) => ({
    onClick: fn,
    onPress: fn,
  });

  // --- search state ---
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searchMountKey, setSearchMountKey] = useState(0);
  const [candidatesDisplayLimit, setCandidatesDisplayLimit] = useState(20); // ✅ 初期表示20件

  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [scanQueueLen, setScanQueueLen] = useState(0);
  const [scanRps, setScanRps] = useState(0);
  const scanProcessedTimestampsRef = useRef([]);
  const scanWorkingRef = useRef(false);

  const OUTBOUND_DRAFT_MAX_LINES = 300; // ✅ まずは安全側。必要なら 500 に
  const OUTBOUND_DRAFT_VERSION = 2;

  const normalizeDraftLine_ = (l, idx) => {
    const qtyRaw = l?.qty ?? l?.quantity ?? 0; // ✅ 互換（quantity も受ける）
    const qty = Math.max(0, Number(qtyRaw || 0));

    const variantId = l?.variantId ?? null;
    const inventoryItemId = l?.inventoryItemId ?? null;

    // ✅ 最低限のキーが無い行は捨てる（壊れた下書き対策）
    if (!variantId && !inventoryItemId && !String(l?.sku || "") && !String(l?.barcode || "")) return null;

    return {
      id: String(l?.id ?? `${idx}`),
      qty, // ✅ OutboundList 内部は基本 qty に寄せる
      variantId,
      inventoryItemId,
      sku: String(l?.sku || ""),
      barcode: String(l?.barcode || ""),
      productTitle: String(l?.productTitle || ""),
      variantTitle: String(l?.variantTitle || ""),
      imageUrl: String(l?.imageUrl || ""),
      // ✅ stockLoading / available など派生は保存しない（復元後に再計算）
    };
  };

  const normalizeDraftLines_ = (arr) => {
    const src = Array.isArray(arr) ? arr : [];
    const normalized = [];

    for (let i = 0; i < src.length; i++) {
      const n = normalizeDraftLine_(src[i], i);
      if (n) normalized.push(n);
      if (normalized.length >= OUTBOUND_DRAFT_MAX_LINES) break; // ✅ 上限
    }
    return normalized;
  };

  const outboundDraftLoadedRef = useRef(false);
  const submitLockRef = useRef(false);

  const [candidateQtyMap, setCandidateQtyMap] = useState({});

  const getCandidateQty = (key) => {
    const n = Number(candidateQtyMap?.[key] ?? 0);
    return Number.isFinite(n) ? n : 0;
  };

  const setCandidateQty = (key, qty) => {
    const n = Math.max(0, Number(qty || 0));
    setCandidateQtyMap((prev) => ({ ...(prev || {}), [key]: n }));
  };

  const resetCandidateQty = (key) => {
    setCandidateQtyMap((prev) => ({ ...(prev || {}), [key]: 0 })); // ✅ タイポ修正
  };

  const toSafeId = (s) =>
    String(s || "x")
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, 60);

  useEffect(() => {
    VariantCache.init?.().catch(() => {});
  }, []);

  useEffect(() => {
    return () => {
      setHeader?.(null);
      setFooter?.(null);
    };
  }, [setHeader, setFooter]);

  // 下書き復元
  useEffect(() => {
    if (outboundDraftLoadedRef.current) return;
    outboundDraftLoadedRef.current = true;

    (async () => {
      try {
        if (!SHOPIFY?.storage?.get) return;

        // ✅ すでに lines があるなら復元しない（ユーザー操作や別ルート初期化を優先）
        const currentLines = Array.isArray(lines) ? lines : [];
        if (currentLines.length > 0) return;

        const saved = await SHOPIFY.storage.get(OUTBOUND_DRAFT_KEY);
        if (!saved || typeof saved !== "object") return;

        const savedLinesRaw = Array.isArray(saved.lines) ? saved.lines : [];

        // ✅ 空の下書きは“復元しない”（setStateしない＝割り込みを消す）
        if (savedLinesRaw.length === 0) return;

        setStateSlice(setAppState, "outbound", (prev) => ({
          ...prev,
          lines: savedLinesRaw,
        }));
        toast("出庫の下書きを復元しました");
      } catch (e) {
        console.error("Failed to load outbound draft:", e);
      }
    })();
  }, [setAppState, lines]);

  const minimizeLineForDraft_ = (line, idx) => ({
    id: String(line?.id ?? idx),
    variantId: line?.variantId ?? null,
    inventoryItemId: line?.inventoryItemId ?? null,
    sku: String(line?.sku || ""),
    barcode: String(line?.barcode || ""),
    productTitle: String(line?.productTitle || ""),
    variantTitle: String(line?.variantTitle || ""),
    imageUrl: String(line?.imageUrl || ""),
    quantity: Number(line?.quantity ?? line?.qty ?? 0),
  });

  // 下書き保存
  useEffect(() => {
    const t = setTimeout(() => {
      (async () => {
        try {
          if (!SHOPIFY?.storage?.set) return;

          const src = Array.isArray(lines) ? lines : [];
          const minimized = src
            .map((l, i) => minimizeLineForDraft_(l, i))
            .filter((l) => Number(l.quantity || 0) > 0);

          await SHOPIFY.storage.set(OUTBOUND_DRAFT_KEY, {
            version: 1,
            savedAt: Date.now(),
            lines: minimized,
          });
        } catch (e) {
          console.error("Failed to save outbound draft:", e);
        }
      })();
    }, 250);
    return () => clearTimeout(t);
  }, [lines]);

  const clearOutboundDraft = async () => {
    try {
      if (!SHOPIFY?.storage?.delete) return;
      await SHOPIFY.storage.delete(OUTBOUND_DRAFT_KEY);
    } catch (e) {
      console.error("Failed to clear outbound draft:", e);
    }
  };

  // ✅ 手動「下書き保存」（確定モーダル用）
  const saveOutboundDraftNow_ = async () => {
    try {
      if (!SHOPIFY?.storage?.set) return;

      const src = Array.isArray(lines) ? lines : [];
      const minimized = src
        .map((l, i) => minimizeLineForDraft_(l, i))
        .filter((l) => Number(l.quantity || 0) > 0);

      await SHOPIFY.storage.set(OUTBOUND_DRAFT_KEY, {
        version: 1,
        savedAt: Date.now(),
        lines: minimized,
      });

      toast("下書きを保存しました");
    } catch (e) {
      console.error("Failed to save outbound draft (manual):", e);
      toast("下書き保存に失敗しました");
    }
  };

  const originLocationName = useMemo(() => {
    const all = Array.isArray(outbound.allLocations) ? outbound.allLocations : [];
    if (!originLocationGid) return "（不明）";
    return all.find((l) => l.id === originLocationGid)?.name ?? "（不明）";
  }, [outbound.allLocations, originLocationGid]);

  const destinationLocationName = useMemo(() => {
    const all = Array.isArray(outbound.allLocations) ? outbound.allLocations : [];
    if (!destinationLocationId) return "—";
    return (
      all.find((l) => l.id === destinationLocationId)?.name ??
      String(destinationLocationId).slice(-12)
    );
  }, [outbound.allLocations, destinationLocationId]);

  const debouncedQuery = useDebounce(query.trim(), 200);

  // 候補検索：v50(searchVariants/buildVariantSearchQuery) 仕様に合わせて発火条件を制御
  useEffect(() => {
    let mounted = true;

    async function run() {
      const raw = String(debouncedQuery || "").trim();

      if (!raw) {
        if (mounted) {
          setCandidates([]);
          setLoading(false);
          setCandidatesDisplayLimit(20); // ✅ 検索クリア時に表示件数もリセット
        }
        return;
      }

      // ✅ 1文字から検索可能に変更（文字数制限を削除）
      setLoading(true);
      try {
        const includeImages = showImages && !liteMode;
        const list = await searchVariants(raw, { includeImages, first: 50 });
        if (mounted) {
          setCandidates(Array.isArray(list) ? list : []);
          setCandidatesDisplayLimit(20); // ✅ 新しい検索時は表示件数をリセット
        }
      } catch (e) {
        toast(`検索エラー: ${toUserMessage(e)}`);
        if (mounted) {
          setCandidates([]);
          setCandidatesDisplayLimit(20);
        }
      } finally {
        if (mounted) setLoading(false);
      }
    }

    run();
    return () => {
      mounted = false;
    };
  }, [debouncedQuery, showImages, liteMode]);

  const setLines = (updater) => {
    setStateSlice(setAppState, "outbound", (prev) => {
      const cur = Array.isArray(prev.lines) ? prev.lines : [];
      const next = typeof updater === "function" ? updater(cur) : updater;
      return { ...prev, lines: Array.isArray(next) ? next : cur };
    });
  };

  const closeSearchHard = () => {
    setQuery("");
    setCandidates([]);
    setCandidatesDisplayLimit(20); // ✅ 検索クリア時に表示件数もリセット
    setSearchMountKey((k) => k + 1);
  };

  // ✅ 「さらに表示」ボタン用
  const handleShowMoreCandidates = useCallback(() => {
    setCandidatesDisplayLimit((prev) => prev + 20);
  }, []);

  const upsertLineByResolvedVariant = async (resolved, { incBy = 1, closeSearch = true } = {}) => {
    if (!resolved?.inventoryItemId || !resolved?.variantId) {
      toast("商品解決に失敗しました（inventoryItemId / variantId が不足）");
      return;
    }
    if (!originLocationGid) {
      toast("現在店舗（origin location）が取得できませんでした");
      return;
    }

    if (closeSearch) closeSearchHard();

    const tmpId = `${Date.now()}-${Math.random()}`;
    let createdNewRow = false;

    setLines((prev) => {
      const hit = prev.find(
        (l) =>
          (l.inventoryItemId && l.inventoryItemId === resolved.inventoryItemId) ||
          (l.variantId && l.variantId === resolved.variantId)
      );

      if (hit) {
        return prev.map((l) =>
          l.id === hit.id ? { ...l, qty: Math.max(1, Number(l.qty || 1) + incBy) } : l
        );
      }

      createdNewRow = true;
      return [
        {
          id: tmpId,
          qty: Math.max(1, Number(incBy || 1)),
          variantId: resolved.variantId,
          inventoryItemId: resolved.inventoryItemId,
          productTitle: resolved.productTitle || "",
          variantTitle: resolved.variantTitle || "",
          sku: resolved.sku || "",
          barcode: resolved.barcode || "",
          imageUrl: resolved.imageUrl || "",
          label: `${resolved.productTitle || ""} / ${resolved.variantTitle || ""}${
            resolved.sku ? `（${resolved.sku}）` : ""
          }`,
          available: null,
          stockLoading: true,
          stockError: null,
        },
        ...prev,
      ];
    });

    if (!createdNewRow) return;

    try {
      const { available, inventoryItemId: normalizedInventoryItemId } = await fetchVariantAvailable({
        variantGid: resolved.variantId,
        locationGid: originLocationGid,
      });

      setLines((prev) =>
        prev.map((l) =>
          l.id === tmpId
            ? {
                ...l,
                available,
                inventoryItemId: normalizedInventoryItemId ?? l.inventoryItemId,
                stockLoading: false,
                stockError: null,
              }
            : l
        )
      );
    } catch (e) {
      setLines((prev) =>
        prev.map((l) =>
          l.id === tmpId ? { ...l, stockLoading: false, stockError: toUserMessage(e) } : l
        )
      );
    }
  };

  const inc = (id, delta) => {
    setLines((prev) =>
      prev
        .map((l) => (l.id === id ? { ...l, qty: Math.max(1, Number(l.qty || 1) + delta) } : l))
        .filter((l) => Number(l.qty || 0) > 0)
    );
  };

  const setQty = (id, qty) => {
    const n = Math.max(1, Number(qty || 1));
    setLines((prev) => prev.map((l) => (l.id === id ? { ...l, qty: n } : l)));
  };

  const remove = (id) => setLines((prev) => prev.filter((l) => l.id !== id));

  const refreshStocks = async () => {
    if (!originLocationGid) return toast("現在店舗（origin location）が取得できませんでした");
    if (lines.length === 0) return;

    setRefreshing(true);
    setLines((prev) => prev.map((l) => ({ ...l, stockLoading: true, stockError: null })));

    try {
      const results = await Promise.all(
        lines.map(async (l) => {
          try {
            const r = await fetchVariantAvailable({ variantGid: l.variantId, locationGid: originLocationGid });
            return { id: l.id, ok: true, ...r };
          } catch (e) {
            return { id: l.id, ok: false, error: toUserMessage(e) };
          }
        })
      );

      setLines((prev) =>
        prev.map((l) => {
          const r = results.find((x) => x.id === l.id);
          if (!r) return { ...l, stockLoading: false };
          if (!r.ok) return { ...l, stockLoading: false, stockError: r.error };
          return {
            ...l,
            available: r.available,
            inventoryItemId: r.inventoryItemId ?? l.inventoryItemId,
            stockLoading: false,
            stockError: null,
          };
        })
      );

      toast("在庫を更新しました");
    } finally {
      setRefreshing(false);
    }
  };

  // scan queue
  const processScanQueueOnce = useCallback(async () => {
    if (scanWorkingRef.current) return;
    scanWorkingRef.current = true;

    try {
      const hasStorage = !!SHOPIFY?.storage?.get && !!SHOPIFY?.storage?.set;
      if (!hasStorage) return;

      const q = (await SHOPIFY.storage.get(SCAN_QUEUE_KEY)) || {};
      const list = Array.isArray(q.items) ? q.items : [];
      setScanQueueLen(list.length);
      if (list.length === 0) return;

      const headRaw = String(list[0] || "").trim();
      const rest = list.slice(1);

      const codes = splitScanInputToCodes_(headRaw);
      const head = String(codes[0] || "").trim();
      const remainingCodes = codes.slice(1);

      const nextItems = [...remainingCodes, ...rest];
      await SHOPIFY.storage.set(SCAN_QUEUE_KEY, { ...q, items: nextItems, updatedAt: Date.now() });
      setScanQueueLen(nextItems.length);

      if (!head) return;
      if (!originLocationGid) return;

      const includeImages = showImages && !liteMode;
      const resolved = await resolveVariantByCode(head, { includeImages });

      if (!resolved?.variantId) {
        toast(`商品が見つかりません: ${head}`);
        return;
      }

      await upsertLineByResolvedVariant(resolved, { incBy: 1 });

      const now = Date.now();
      const arr = scanProcessedTimestampsRef.current.filter((t) => now - t <= 1000);
      arr.push(now);
      scanProcessedTimestampsRef.current = arr;
      setScanRps(arr.length);
    } catch (e) {
      console.error("processScanQueueOnce error:", e);
    } finally {
      scanWorkingRef.current = false;
    }
  }, [originLocationGid, showImages, liteMode]);

  useEffect(() => {
    const t = setInterval(() => {
      processScanQueueOnce().catch(() => {});
    }, 100);
    return () => clearInterval(t);
  }, [processScanQueueOnce]);

  const totalLines = lines.length;
  const totalQty = sumQty_(lines, "qty");

  const canSubmit = !!originLocationGid && !!destinationLocationId && lines.length > 0 && !submitting;

  // =========================
  // ✅ 確定前ゲート（警告 / 在庫レベル不足 / マイナス在庫）
  // =========================
  const [gateDestMissing, setGateDestMissing] = useState([]);
  const [gateOriginMissing, setGateOriginMissing] = useState([]);
  const [gateNegative, setGateNegative] = useState([]);
  const [gateAck, setGateAck] = useState(false);
  const [gateLoading, setGateLoading] = useState(false);

  const gateRunningRef = useRef(false);

  const gateNeedsAck = gateOriginMissing.length > 0 || gateNegative.length > 0;

  const buildMetaByInventoryItemId = useCallback(() => {
    const metaById = {};
    for (const l of Array.isArray(lines) ? lines : []) {
      const inventoryItemId = String(l?.inventoryItemId || "").trim();
      if (!inventoryItemId) continue;

      const title = String(l?.productTitle || l?.title || l?.label || "").trim();
      const variantTitle = String(l?.variantTitle || "").trim();
      const sku = String(l?.sku || "").trim();

      const qty = Math.max(1, Number(l?.qty || 1));
      const available = Number.isFinite(Number(l?.available)) ? Number(l?.available) : null;

      metaById[inventoryItemId] = {
        inventoryItemId,
        title,
        variantTitle,
        sku,
        qty,
        available,
      };
    }
    return metaById;
  }, [lines]);

  const refreshOutboundGate = useCallback(async () => {
    if (!destinationLocationId || !Array.isArray(lines) || lines.length === 0) {
      setGateDestMissing([]);
      setGateOriginMissing([]);
      setGateNegative([]);
      setGateAck(false);
      return;
    }

    setGateLoading(true);
    try {
      const metaById = buildMetaByInventoryItemId();
      const inventoryItemIds = Object.keys(metaById || {}).filter(Boolean);

      const missingDest = await findMissingInventoryLevelsAtLocation({
        locationId: destinationLocationId,
        inventoryItemIds,
        metaById,
        debug,
      });

      const missingOrigin = originLocationGid
        ? await findMissingInventoryLevelsAtLocation({
            locationId: originLocationGid,
            inventoryItemIds,
            metaById,
            debug,
          })
        : [];

      const negative = [];
      for (const id of inventoryItemIds) {
        const m = metaById?.[id];
        if (!m) continue;
        if (m.available === null) continue; // 在庫未取得は negative 判定しない

        const projected = Number(m.available) - Number(m.qty);
        if (projected < 0) {
          negative.push({
            inventoryItemId: id,
            sku: m.sku,
            title: m.title,
            available: m.available,
            qty: m.qty,
            projected,
          });
        }
      }

      setGateDestMissing(Array.isArray(missingDest) ? missingDest : []);
      setGateOriginMissing(Array.isArray(missingOrigin) ? missingOrigin : []);
      setGateNegative(Array.isArray(negative) ? negative : []);
      setGateAck(false);
    } catch (e) {
      toast(`ゲート判定エラー: ${toUserMessage(e)}`);
      setGateDestMissing([]);
      setGateOriginMissing([]);
      setGateNegative([]);
      setGateAck(false);
    } finally {
      setGateLoading(false);
    }
  }, [destinationLocationId, originLocationGid, lines, buildMetaByInventoryItemId]);

  const submitTransferCore = async ({ skipActivate = false } = {}) => {
    toast("submitTransferCore: start");

    // --- 入力の正規化（全部 任意） ---
    const trackingNumber = String(outbound?.trackingNumber || "").trim();
    const trackingUrl = String(outbound?.trackingUrl || "").trim();
    const eta = String(outbound?.arrivesAtIso || "").trim();

    // ✅ company は resolvedCompany（carrier設定の company → 無ければ手入力 manualCompany）
    const company = String(resolvedCompany || "").trim();

    // 二重実行ガード
    if (submitLockRef.current || submitting) {
      toast(`処理中です… (lock=${submitLockRef.current ? "1" : "0"} submitting=${submitting ? "1" : "0"})`);
      return null;
    }

    // 必須チェック
    if (!originLocationGid) {
      toast("出庫元が取得できません（originLocationGid=null）");
      return null;
    }
    if (!destinationLocationId) {
      toast("宛先を選択してください");
      return null;
    }
    if (!Array.isArray(lines) || lines.length === 0) {
      toast("商品がありません");
      return null;
    }

    // ✅ lineItems を作る（InventoryTransferLineItemInput の形）
    const lineItems = lines
      .map((l) => ({
        inventoryItemId: String(l?.inventoryItemId || "").trim(),
        quantity: Math.max(0, Number(l?.qty || 0)),
      }))
      .filter((x) => x.inventoryItemId && Number.isFinite(x.quantity) && x.quantity > 0);

    if (lineItems.length === 0) {
      toast("明細の inventoryItemId / qty が不正です");
      return null;
    }

    // userErrors の field を分かりやすくするためのメタ
    const lineItemsMeta = lines.map((l) => ({
      inventoryItemId: String(l?.inventoryItemId || "").trim(),
      sku: String(l?.sku || "").trim(),
      barcode: String(l?.barcode || "").trim(),
      label: String(l?.label || "").trim(),
    }));

    closeSearchHard();

    submitLockRef.current = true;
    setSubmitting(true);

    try {
      // ✅ stocked化（ゲート側でやった場合はスキップ）
      if (!skipActivate) {
        try {
          if (typeof ensureInventoryActivatedAtLocation === "function") {
            await ensureInventoryActivatedAtLocation({
              locationId: destinationLocationId,
              inventoryItemIds: lineItems.map((x) => x.inventoryItemId),
              debug,
            });
          }
        } catch (e) {
          toast(`activate: skipped (${String(e?.message || e)})`);
        }
      }

      // ✅ 編集モード（同ID）：lineItems を差し替えるだけ（下書き蓄積させない）
      const editingTransferId = String(outbound?.editingTransferId || "").trim();
      if (editingTransferId) {
        const transfer = await inventoryTransferSetItemsSafe({
          id: editingTransferId,
          lineItems,
        });

        toast("明細を更新しました（同ID）");

        // 後処理（新規作成と同等にリセット）
        try { await clearOutboundDraft?.(); } catch (_) {}
        try { setLines([]); } catch (_) {}
        try { setCandidateQtyMap?.({}); } catch (_) {}

        setStateSlice(setAppState, "outbound", (prev) => ({
          ...(prev || {}),
          editingTransferId: "",
        }));

        onBack?.();
        return { transfer, shipment: null };
      }

      // ✅ 1) Transfer 作成（Ready to ship）
      const transfer = await createTransferReadyToShipWithFallback({
        originLocationId: String(originLocationGid || "").trim(),
        destinationLocationId: String(destinationLocationId || "").trim(),
        lineItems,
        lineItemsMeta,
      });

      const movementId = transfer?.id;
      if (!movementId) throw new Error("transfer.id が取得できません");

      // ✅ 2) Shipment 作成（tracking が何も無い時は作らない）
      let shipment = null;

      const hasAnyTracking = Boolean(company || trackingNumber || trackingUrl || eta);
      if (hasAnyTracking) {
        const trackingInput = {
          company: company || null,
          trackingNumber: trackingNumber || null,
          trackingUrl: trackingUrl || null,
          arrivesAt: eta || null,
        };

        shipment = await createInventoryShipmentInTransit({
          movementId,
          lineItems,
          trackingInput,
        });
      }

      toast(shipment ? "移管を作成しました（進行中）" : "移管を作成しました");

      // 後処理
      try { await clearOutboundDraft?.(); } catch (_) {}
      try { setLines([]); } catch (_) {}
      try { setCandidateQtyMap?.({}); } catch (_) {}

      setStateSlice(setAppState, "outbound", (prev) => ({
        ...(prev || {}),
        editingTransferId: "",
      }));

      // ✅ v50寄せ：成功したら戻る（不要ならここだけ消してOK）
      onBack?.();

      return { transfer, shipment };
    } catch (e) {
      const msg = String(e?.message || e || "unknown error");
      toast(`確定に失敗: ${msg}`);
      try {
        await dialog?.alert?.({ type: "error", title: "確定に失敗", content: msg, actionText: "OK" });
      } catch (_) {}
      return null;
    } finally {
      submitLockRef.current = false;
      setSubmitting(false);
    }
  };

  // ✅ フッターの「確定」ボタンから呼ぶ用（押下ログだけ）
  const submitTransfer = async () => {
    toast("submitTransfer: pressed");
    // ここでは確定処理を走らせない（confirm modal を開くだけにする）
  };

  const handleToggleLite = () => {
    if (typeof onToggleLiteMode === "function") onToggleLiteMode();
    else toast("軽量切替が未設定です（onToggleLiteMode）");
  };

  const safeBack = () => {
    setHeader?.(null);
    setFooter?.(null);
    onBack?.();
  };

  // =========================
  // Header（固定領域）
  //  - デバッグ削除
  //  - 検索枠を100%化
  //  - ×を accessory(slot) で右端固定
  //  - 検索件数を検索枠直下に表示
  // =========================
  useEffect(() => {
    const q = String(query || "");
    const showCount = q.trim().length > 0;

    setHeader?.(
      <s-box padding="base">
        <s-stack gap="tight">
          {DEBUG_UI ? (
            <s-text tone="subdued" size="small">
              {UI_REV} / query="{q}" / cand={candidates.length}
            </s-text>
          ) : null}

          <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
            <s-stack gap="none">
              <s-text size="small">出庫元：{originLocationName}</s-text>
              <s-text size="small">宛先：{destinationLocationName}</s-text>
            </s-stack>

            <s-stack direction="inline" gap="base" alignItems="center">
              <s-button kind="secondary" tone={liteMode ? "critical" : undefined} {...bindPress(handleToggleLite)}>
                {liteMode ? "軽量" : "軽量"}
              </s-button>

              <s-button {...bindPress(refreshStocks)} disabled={refreshing || lines.length === 0}>
                {refreshing ? "更新中..." : "在庫再取得"}
              </s-button>
            </s-stack>
          </s-stack>

          {/* 検索（100%幅＋×は右端固定） */}
          <s-box inlineSize="100%" paddingBlockStart="small-200">
            <s-text-field
              key={searchMountKey}
              label="検索"
              labelHidden
              placeholder="商品名 / SKU / バーコード"
              value={q}
              onInput={(v) => setQuery(readText(v))}
              onChange={(v) => setQuery(readText(v))}
            >
              {q ? (
                <s-button slot="accessory" kind="secondary" tone="critical" {...bindPress(closeSearchHard)}>
                  ✕
                </s-button>
              ) : null}
            </s-text-field>
          </s-box>

          {showCount ? (
            <s-text tone="subdued" size="small">
              検索結果：{loading ? "…" : candidates.length}件
            </s-text>
          ) : null}

          {loading ? <s-text tone="subdued" size="small">検索中...</s-text> : null}
        </s-stack>
      </s-box>
    );

    return () => setHeader?.(null);
  }, [
    setHeader,
    DEBUG_UI,
    UI_REV,
    originLocationName,
    destinationLocationName,
    liteMode,
    refreshing,
    lines.length,
    query,
    candidates.length,
    loading,
    searchMountKey,
  ]);

  // =========================
  // Footer（1行固定：戻る / 情報 / 確定）
  // =========================
  useEffect(() => {
    setFooter?.(
      <s-box padding="base">
        <s-stack
          direction="inline"
          alignItems="center"
          justifyContent="space-between"
          gap="base"
          style={{ width: "100%", flexWrap: "nowrap" }}  // ✅ 絶対に折り返さない
        >
          {/* 左：戻る */}
          <s-box style={{ flex: "0 0 auto" }}>
            <s-button tone="subdued" {...bindPress(onBack)} disabled={submitting}>
              戻る
            </s-button>
          </s-box>

          {/* 中央：情報（縮む担当） */}
          <s-box style={{ flex: "1 1 auto", minWidth: 0 }}>
            <s-stack gap="none">
              <s-text alignment="center" size="small" tone="subdued">
                明細 {totalLines} / 合計 {totalQty}
              </s-text>
              {liteMode ? (
                <s-text alignment="center" size="small" tone="subdued">
                  軽量ON
                </s-text>
              ) : null}
            </s-stack>
          </s-box>

          {/* 右：確定（ゲート更新→confirm を開く） */}
          <s-box style={{ flex: "0 0 auto" }}>
            <s-button
              tone={gateNeedsAck ? "critical" : "success"}
              disabled={!canSubmit || submitting}
              command="--show"
              commandFor={CONFIRM_TRANSFER_MODAL_ID}
              onClick={() => {
                refreshOutboundGate();
                setGateAck(false);
              }}
              onPress={() => {
                refreshOutboundGate();
                setGateAck(false);
              }}
            >
              確定
            </s-button>
          </s-box>
        </s-stack>
      </s-box>
    );

    return () => setFooter?.(null);
  }, [
    setFooter,
    submitting,
    totalLines,
    totalQty,
    liteMode,
    scanQueueLen,
    scanRps,
    canSubmit,
    gateNeedsAck,
    refreshOutboundGate,
  ]);

  // =========================
  // Candidate 在庫キャッシュ（堅実版：必要最小のプリフェッチ）
  // - 候補は最大50件になり得るので、上位だけ取得（必要なら増やせる）
  // - fetchVariantAvailable（既存）を流用し、originLocationGid の在庫を表示
  // =========================
  const CANDIDATE_STOCK_PREFETCH_LIMIT = 15;

  const candidateStockRef = useRef(new Map()); // key -> { available, error }
  const candidateStockInflightRef = useRef(new Set()); // key
  const [candidateStockVersion, setCandidateStockVersion] = useState(0); // 再描画トリガ

  const getCandidateStock = (k) => candidateStockRef.current.get(k);

  const ensureCandidateStock = useCallback(
    async (k, variantGid) => {
      if (!originLocationGid) return;
      if (!variantGid) return;

      if (candidateStockRef.current.has(k)) return;
      if (candidateStockInflightRef.current.has(k)) return;

      candidateStockInflightRef.current.add(k);

      try {
        const r = await fetchVariantAvailable({ variantGid, locationGid: originLocationGid });
        candidateStockRef.current.set(k, { available: r?.available ?? null, error: null });
      } catch (e) {
        candidateStockRef.current.set(k, { available: null, error: toUserMessage(e) });
      } finally {
        candidateStockInflightRef.current.delete(k);
        setCandidateStockVersion((v) => v + 1);
      }
    },
    [originLocationGid]
  );

  // =========================
  // Candidate row（堅実版：常に2行。上段=左情報 / 下段=右ボタン右寄せ固定）
  // - SKU(or JAN) の後ろに在庫数（originLocationGid）を表示
  // =========================
  const CandidateRow = ({ c, idx }) => {
    const productTitle = String(c?.productTitle || "").trim();
    const variantTitle = String(c?.variantTitle || "").trim();
    const sku = String(c?.sku || "").trim();
    const barcode = String(c?.barcode || "").trim();
    const imageUrl = String(c?.imageUrl || "").trim();

    const stableKey = String(
      c?.variantId || c?.inventoryItemId || sku || barcode || `${productTitle}__${variantTitle}`
    );
    const key = stableKey;
    const safeKey = toSafeId(key);

    const shownQty = getCandidateQty(key); // 0開始
    const modalId = `cand-qty-${safeKey}`;

    const resolved = {
      variantId: c?.variantId ?? null,
      inventoryItemId: c?.inventoryItemId ?? null,
      productTitle,
      variantTitle,
      sku,
      barcode,
      imageUrl,
    };

    const [text, setText] = useState(String(shownQty > 0 ? shownQty : 1));

    useEffect(() => {
      setText(String(shownQty > 0 ? shownQty : 1));
    }, [shownQty]);

    const clampAdd = (n) => {
      const x = Number(n);
      if (!Number.isFinite(x)) return 1;
      return Math.max(1, Math.min(999999, Math.floor(x)));
    };

    const addOne = async () => {
      await upsertLineByResolvedVariant(resolved, { incBy: 1, closeSearch: false });
      setCandidateQty(key, shownQty + 1);
      toast(`${productTitle || "(no title)"} を追加しました（+1）`);
    };

    const commitAddByQty = async () => {
      const n = clampAdd(String(text || "").trim());
      await upsertLineByResolvedVariant(resolved, { incBy: n, closeSearch: false });
      setCandidateQty(key, n);
      toast(`${productTitle || "(no title)"} を追加しました（+${n}）`);
    };

    // ▼ 在庫（候補は上位だけプリフェッチ）
    void candidateStockVersion;
    useEffect(() => {
      if (!c?.variantId) return;
      if (typeof idx === "number" && idx >= CANDIDATE_STOCK_PREFETCH_LIMIT) return;
      ensureCandidateStock(key, c.variantId);
    }, [idx, key, c?.variantId, ensureCandidateStock]);

    const stock = getCandidateStock(key);
    const stockText =
      stock?.error ? "在庫: —" :
      stock && stock.available !== null ? `在庫: ${stock.available}` :
      "在庫: …";

    const skuLine = `${sku ? `SKU: ${sku}` : ""}${barcode ? `${sku ? " / " : ""}JAN: ${barcode}` : ""}`.trim();

    const digits = String(shownQty).length;
    const valueWidth =
      digits <= 1 ? 56 :
      digits === 2 ? 64 :
      digits === 3 ? 76 :
      digits === 4 ? 96 : 112;

    return (
      <s-box padding="none">
        <StockyRowShell>
          <s-stack gap="extra-tight" inlineSize="100%">
            {/* 上段：情報（画像＋商品名＋SKU/JAN） */}
            <s-box>
              <ItemLeftCompact
                showImages={showImages}
                imageUrl={imageUrl}
                productTitle={productTitle || "(no title)"}
                variantTitle={variantTitle}
                line3={skuLine}
              />
            </s-box>

            {/* 下段：左=在庫、右=数量ボタン */}
            <s-box inlineSize="100%">
              <s-stack
                direction="inline"
                gap="base"
                alignItems="center"
                justifyContent="space-between"
                style={{ width: "100%", flexWrap: "nowrap" }}
              >
                <s-box style={{ flex: "1 1 auto", minWidth: 0 }}>
                  <s-text
                    tone="subdued"
                    size="small"
                    style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                  >
                    {stockText}
                  </s-text>
                </s-box>

                <s-box style={{ flex: "0 0 auto" }}>
                  {/* 既存の右ボタン群をそのまま移植 */}
                  <s-stack direction="inline" gap="extra-tight" alignItems="center" justifyContent="end">
                    <s-box inlineSize={`${valueWidth}px`}>
                      <s-button
                        command="--show"
                        commandFor={modalId}
                        onClick={() => setText(String(shownQty > 0 ? shownQty : 1))}
                        style={{ width: "100%", whiteSpace: "nowrap" }}
                      >
                        {shownQty}
                      </s-button>
                    </s-box>

                    <s-box inlineSize="44px">
                      <s-button onClick={addOne} style={{ width: "100%" }}>
                        +
                      </s-button>
                    </s-box>
                  </s-stack>
                </s-box>
              </s-stack>
            </s-box>
          </s-stack>
        </StockyRowShell>

        <s-modal id={modalId} heading="数量を指定して追加">
          <s-box padding="base">
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
            </s-stack>
          </s-box>


          <s-button slot="secondary-actions" command="--hide" commandFor={modalId}>
            キャンセル
          </s-button>

          <s-button
            slot="primary-action"
            tone="success"
            command="--hide"
            commandFor={modalId}
            onClick={commitAddByQty}
          >
            追加
          </s-button>
        </s-modal>

        <s-divider />
      </s-box>
    );
  };

  // =========================
  // Return（余白調整：gap none + divider）
  // =========================
  // ✅ 表示する候補（表示件数制限適用）
  const displayedCandidates = useMemo(() => {
    return candidates.slice(0, candidatesDisplayLimit);
  }, [candidates, candidatesDisplayLimit]);

  const hasMoreCandidates = candidates.length > candidatesDisplayLimit;

  return (
    <s-stack gap="none">
      {candidates.length > 0 ? (
        <s-box padding="base">
          <s-stack gap="extra-tight">
            {displayedCandidates.map((c, idx) => {
              const stableKey = String(
                c?.variantId || c?.inventoryItemId || c?.sku || c?.barcode || `${c?.productTitle}__${c?.variantTitle}`
              );
              return <CandidateRow key={stableKey} c={c} idx={idx} />;
            })}
            
            {/* ✅ 「さらに表示」ボタン */}
            {hasMoreCandidates ? (
              <s-box padding="small">
                <s-button kind="secondary" onClick={handleShowMoreCandidates} onPress={handleShowMoreCandidates}>
                  さらに表示（残り {candidates.length - candidatesDisplayLimit}件）
                </s-button>
              </s-box>
            ) : null}
          </s-stack>
        </s-box>
      ) : null}

      {candidates.length > 0 ? <s-divider /> : null}

      {/* ✅ 確定 confirm（ゲート統合版） */}
      <s-modal id={CONFIRM_TRANSFER_MODAL_ID} heading="出庫（移管）を確定しますか？" ref={confirmTransferModalRef}>
        <s-box padding="base">
          <s-stack gap="small">
            <s-text size="small" tone="subdued">
              宛先: {destinationLocationName || destinationLocationId || "-"}
            </s-text>
            <s-text size="small" tone="subdued">
              明細: {totalLines} / 合計: {totalQty}
            </s-text>

            {gateLoading ? <s-text size="small" tone="subdued">判定中...</s-text> : null}

            {/* ===== 宛先 missing（自動で在庫有効化対象） ===== */}
            {gateDestMissing.length > 0 ? (
              <s-box>
                <s-text size="small" tone="critical" emphasis="bold">
                  宛先に在庫レベルが無い商品（{gateDestMissing.length}件）
                </s-text>
                <s-stack gap="extra-tight">
                  {gateDestMissing.slice(0, 12).map((x) => (
                    <s-text key={String(x.inventoryItemId)} size="small" tone="subdued">
                      ・{x.title || "(unknown)"} {x.sku ? `（SKU:${x.sku}）` : ""}
                    </s-text>
                  ))}
                  {gateDestMissing.length > 12 ? (
                    <s-text size="small" tone="subdued">…他 {gateDestMissing.length - 12} 件</s-text>
                  ) : null}
                </s-stack>
              </s-box>
            ) : null}

            {/* ===== 出庫元 missing（確認必須） ===== */}
            {gateOriginMissing.length > 0 ? (
              <s-box>
                <s-text size="small" tone="critical" emphasis="bold">
                  出庫元に在庫レベルが無い商品（{gateOriginMissing.length}件）
                </s-text>
                <s-stack gap="extra-tight">
                  {gateOriginMissing.slice(0, 12).map((x) => (
                    <s-text key={String(x.inventoryItemId)} size="small" tone="subdued">
                      ・{x.title || "(unknown)"} {x.sku ? `（SKU:${x.sku}）` : ""}
                    </s-text>
                  ))}
                  {gateOriginMissing.length > 12 ? (
                    <s-text size="small" tone="subdued">…他 {gateOriginMissing.length - 12} 件</s-text>
                  ) : null}
                </s-stack>
              </s-box>
            ) : null}

            {/* ===== negative（確認必須） ===== */}
            {gateNegative.length > 0 ? (
              <s-box>
                <s-text size="small" tone="critical" emphasis="bold">
                  出庫後にマイナス在庫になる可能性（{gateNegative.length}件）
                </s-text>
                <s-stack gap="extra-tight">
                  {gateNegative.slice(0, 12).map((x) => (
                    <s-text key={String(x.inventoryItemId)} size="small" tone="subdued">
                      ・{x.title || "(unknown)"} {x.sku ? `（SKU:${x.sku}）` : ""} 在庫:{x.available} → {x.projected}
                    </s-text>
                  ))}
                  {gateNegative.length > 12 ? (
                    <s-text size="small" tone="subdued">…他 {gateNegative.length - 12} 件</s-text>
                  ) : null}
                </s-stack>
              </s-box>
            ) : null}

            {gateNeedsAck ? <s-divider /> : null}

            {/* ===== チェック必須（出庫元missing or negative がある場合） ===== */}
            {gateNeedsAck ? (
              <s-stack gap="small" alignItems="center" justifyContent="start">
                <s-button tone={gateAck ? "success" : "critical"} onClick={() => setGateAck((v) => !v)}>
                  {gateAck ? "OK" : "内容を確認しました（必須）"}
                </s-button>
                <s-text tone="subdued" size="small">
                  ※ チェックがONでないと「確定」できません
                </s-text>
              </s-stack>
            ) : null}
          </s-stack>
        </s-box>

        <s-button
          slot="secondary-actions"
          command="--hide"
          commandFor={CONFIRM_TRANSFER_MODAL_ID}
          onClick={async () => {
            try {
              if (!originLocationGid) return toast("出庫元ロケーションが未取得です");
              if (!destinationLocationId) return toast("宛先を選択してください");
              if (!Array.isArray(lines) || lines.length === 0) return toast("商品がありません");

              const lineItems = lines
                .map((l) => ({
                  inventoryItemId: String(l?.inventoryItemId || "").trim(),
                  quantity: Math.max(0, Number(l?.qty || l?.quantity || 0)),
                }))
                .filter((x) => x.inventoryItemId && Number.isFinite(x.quantity) && x.quantity > 0);

              if (lineItems.length === 0) return toast("数量が0のため下書き保存できません");

              if (draftTransferId) {
                await inventoryTransferSetItemsSafe({ id: draftTransferId, lineItems });
                toast("下書きを更新しました（同ID）");
                return;
              }

              const created = await inventoryTransferCreateDraftSafe({
                originLocationId: originLocationGid,
                destinationLocationId,
                lineItems,
                note: `POS draft saved ${new Date().toISOString()}`,
              });

              setStateSlice(setAppState, "outbound", (prev) => ({
                ...(prev || {}),
                draftTransferId: String(created?.id || ""),
              }));

              toast("下書きを作成しました（履歴に表示されます）");
            } catch (e) {
              console.error(e);
              toast(toUserMessage(e));
            }
          }}
        >
          下書き保存
        </s-button>

        <s-button slot="secondary-actions" command="--hide" commandFor={CONFIRM_TRANSFER_MODAL_ID}>
          キャンセル
        </s-button>

        <s-button
          slot="primary-action"
          tone="success"
          disabled={!canSubmit || submitting || gateLoading || (gateNeedsAck && !gateAck)}
          onClick={async () => {
            if (gateRunningRef.current) return;
            gateRunningRef.current = true;

            try {
              // 1) 最新化（念のため）
              await refreshOutboundGate();

              // 2) ACK 必須なら止める
              if (gateNeedsAck && !gateAck) {
                toast("内容の確認が必要です（チェックをONにしてください）");
                return;
              }

              const metaById = buildMetaByInventoryItemId();

              // 3) 出庫元 missing → activate → 反映待ち（失敗時は止める）
              if (gateOriginMissing.length > 0 && originLocationGid) {
                const ids = gateOriginMissing.map((m) => String(m.inventoryItemId)).filter(Boolean);

                await ensureInventoryActivatedAtLocation({
                  locationId: originLocationGid,
                  inventoryItemIds: ids,
                  debug,
                });

                const waited = await waitForMissingInventoryLevelsToClear({
                  locationId: originLocationGid,
                  inventoryItemIds: ids,
                  metaById,
                  timeoutMs: 20000,
                  intervalMs: 900,
                  debug,
                });

                if (!waited?.ok) {
                  toast("出庫元の在庫レベル反映待ちがタイムアウトしました");
                  return;
                }
              }

              // 4) 宛先 missing → activate → 反映待ち（失敗時は止める）
              if (gateDestMissing.length > 0 && destinationLocationId) {
                const ids = gateDestMissing.map((m) => String(m.inventoryItemId)).filter(Boolean);

                await ensureInventoryActivatedAtLocation({
                  locationId: destinationLocationId,
                  inventoryItemIds: ids,
                  debug,
                });

                const waited = await waitForMissingInventoryLevelsToClear({
                  locationId: destinationLocationId,
                  inventoryItemIds: ids,
                  metaById,
                  timeoutMs: 20000,
                  intervalMs: 900,
                  debug,
                });

                if (!waited?.ok) {
                  toast("宛先の在庫レベル反映待ちがタイムアウトしました");
                  return;
                }
              }

              // 5) 確定（activate 済み想定なので skipActivate=true）
              const r = await submitTransferCore({ skipActivate: true });

              if (r) {
                confirmTransferModalRef?.current?.hideOverlay?.();
                confirmTransferModalRef?.current?.hide?.();
              }
            } catch (e) {
              toast(`確定前処理エラー: ${toUserMessage(e)}`);
            } finally {
              gateRunningRef.current = false;
            }
          }}
          onPress={async () => {
            if (gateRunningRef.current) return;
            gateRunningRef.current = true;

            try {
              await refreshOutboundGate();

              if (gateNeedsAck && !gateAck) {
                toast("内容の確認が必要です（チェックをONにしてください）");
                return;
              }

              const metaById = buildMetaByInventoryItemId();

              if (gateOriginMissing.length > 0 && originLocationGid) {
                const ids = gateOriginMissing.map((m) => String(m.inventoryItemId)).filter(Boolean);

                await ensureInventoryActivatedAtLocation({
                  locationId: originLocationGid,
                  inventoryItemIds: ids,
                  debug,
                });

                const waited = await waitForMissingInventoryLevelsToClear({
                  locationId: originLocationGid,
                  inventoryItemIds: ids,
                  metaById,
                  timeoutMs: 20000,
                  intervalMs: 900,
                  debug,
                });

                if (!waited?.ok) {
                  toast("出庫元の在庫レベル反映待ちがタイムアウトしました");
                  return;
                }
              }

              if (gateDestMissing.length > 0 && destinationLocationId) {
                const ids = gateDestMissing.map((m) => String(m.inventoryItemId)).filter(Boolean);

                await ensureInventoryActivatedAtLocation({
                  locationId: destinationLocationId,
                  inventoryItemIds: ids,
                  debug,
                });

                const waited = await waitForMissingInventoryLevelsToClear({
                  locationId: destinationLocationId,
                  inventoryItemIds: ids,
                  metaById,
                  timeoutMs: 20000,
                  intervalMs: 900,
                  debug,
                });

                if (!waited?.ok) {
                  toast("宛先の在庫レベル反映待ちがタイムアウトしました");
                  return;
                }
              }

              const r = await submitTransferCore({ skipActivate: true });

              if (r) {
                confirmTransferModalRef?.current?.hideOverlay?.();
                confirmTransferModalRef?.current?.hide?.();
              }
            } catch (e) {
              toast(`確定前処理エラー: ${toUserMessage(e)}`);
            } finally {
              gateRunningRef.current = false;
            }
          }}
        >
          {gateDestMissing.length > 0 || gateOriginMissing.length > 0 ? "在庫有効化→確定" : "確定する"}
        </s-button>
      </s-modal>

      <s-box padding="base">
        {lines.length === 0 ? (
          <s-text tone="subdued">まだ追加されていません</s-text>
        ) : (
          <s-stack gap="none">
            <s-text emphasis="bold">出庫リスト</s-text>

            {/* タイトル直下の余白を “明示” したい場合だけ spacer を足す */}
            <s-box style={{ blockSize: "8px" }} />

            {lines.map((l) => (
              <OutboundAddedLineRow
                key={l.id}
                line={l}
                showImages={showImages}
                dialog={dialog}
                onDec={() => inc(l.id, -1)}
                onInc={() => inc(l.id, +1)}
                onSetQty={(n) => setQty(l.id, n)}
                onRemove={() => remove(l.id)}
              />
            ))}
          </s-stack>
        )}
      </s-box>
    </s-stack>
  );
}

function toSafeId(s) {
  return String(s || "x").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60);
}

/* =========================
   ✅ OutboundAddedLineRow（2行構成：SKUは上段、在庫は下段左）
========================= */
function OutboundAddedLineRow({
  line,
  showImages,
  dialog,
  onDec,
  onInc,
  onSetQty,
  onRemove,
}) {
  const rawLabel = String(line?.label || line?.title || "").trim();
  const parts = rawLabel ? rawLabel.split("/").map((s) => s.trim()).filter(Boolean) : [];

  const productTitle = String(line?.productTitle || "").trim() || parts[0] || "(unknown)";
  const variantTitle =
    String(line?.variantTitle || "").trim() || (parts.length >= 2 ? parts.slice(1).join(" / ") : "");

  const qty = Math.max(1, Number(line?.qty || 1));

  const modalKey = line?.key || line?.inventoryItemId || line?.variantId || rawLabel || "row";
  const modalId = `qty-out-${toSafeId(modalKey)}`;

  const sku = String(line?.sku || "").trim();
  const barcode = String(line?.barcode || "").trim();

  // ✅ 上段3行目（SKU/JANのみ）
  const skuLine = `${sku ? `SKU: ${sku}` : ""}${barcode ? `${sku ? " / " : ""}JAN: ${barcode}` : ""}`.trim();

  // ✅ 下段左（在庫のみ）
  const stockText = line?.stockLoading ? "在庫: …" : `在庫: ${line?.available ?? "—"}`;

  return (
    <s-box padding="none">
      <StockyRowShell>
        <s-stack gap="extra-tight" inlineSize="100%">
          {/* 上段：情報（画像＋商品名＋オプション＋SKU） */}
          <s-box inlineSize="100%">
            <ItemLeftCompact
              showImages={showImages}
              imageUrl={line?.imageUrl || ""}
              productTitle={productTitle}
              variantTitle={variantTitle}
              line3={skuLine}
            />
          </s-box>

          {/* 下段：左=在庫、右=数量ボタン（右寄せ崩れ防止で 100% 幅を確保） */}
          <s-box inlineSize="100%">
            <s-stack
              direction="inline"
              gap="base"
              alignItems="center"
              justifyContent="space-between"
              style={{ width: "100%", flexWrap: "nowrap" }}
            >
              <s-box style={{ flex: "1 1 auto", minWidth: 0 }}>
                <s-text
                  tone="subdued"
                  size="small"
                  style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                >
                  {stockText}
                </s-text>
              </s-box>

              <s-box style={{ flex: "0 0 auto" }}>
                <QtyControlCompact_3Buttons
                  value={qty}
                  min={1}
                  modalId={modalId}
                  onDec={onDec}
                  onInc={onInc}
                  onSetQty={onSetQty}
                  onRemove={onRemove}
                />
              </s-box>
            </s-stack>
          </s-box>
        </s-stack>
      </StockyRowShell>
      <s-divider />
    </s-box>
  );
}

/* =========================
   ✅ QtyControlCompact_3Buttons
   - リッチテキストの QtyControlCompact（commandFor + s-modal）をベースに、
     「qty=1 のとき左を ×（削除）」に拡張
   - 数量表示幅（valueWidth）もリッチテキスト準拠
========================= */
function QtyControlCompact_3Buttons({
  value,
  min = 1,
  max = 999999,
  title = "数量",
  modalId,
  onDec,
  onInc,
  onSetQty,
  onRemove,
  step = 1,
}) {
  const v = Number.isFinite(Number(value)) ? Number(value) : min;
  const id = useMemo(() => String(modalId), [modalId]);
  const [text, setText] = useState(String(v));

  useEffect(() => setText(String(v)), [v]);

  const clamp = (n) => Math.min(max, Math.max(min, Math.floor(Number(n || min))));
  const digits = String(v).length;
  const valueWidth = qtyValueWidthByDigits_(digits);

  return (
    <>
      <s-stack
      direction="inline"
      gap="extra-tight"
      alignItems="center"
      justifyContent="end"
      style={{ flexWrap: "nowrap" }}
      >
        <s-box inlineSize="44px">
          {/*
            qty=1 のときは「×」で削除
            qty>1 のときは「−」で減算
            ※ onRemove が無い場合は従来通り min で disable
          */}
          {(() => {
            const canRemove = typeof onRemove === "function";
            const isRemoveMode = canRemove && v <= min;

            return (
              <s-button
                tone={isRemoveMode ? "critical" : undefined}
                onClick={() => (isRemoveMode ? onRemove?.() : onDec?.())}
                disabled={!isRemoveMode && v <= min}
                style={{ width: "100%" }}
              >
                {isRemoveMode ? "×" : "−"}
              </s-button>
            );
          })()}
        </s-box>

        <s-box inlineSize={`${valueWidth}px`}>
          <s-button command="--show" commandFor={id} style={{ width: "100%" }}>
            {v}
          </s-button>
        </s-box>

        <s-box inlineSize="44px">
          <s-button onClick={() => onInc?.()} disabled={v >= max} style={{ width: "100%" }}>
            +
          </s-button>
        </s-box>
      </s-stack>

      <s-modal id={id} heading={title}>
        <s-box padding="base">
          <s-stack gap="base">
            <s-text type="small" tone="subdued">数量を入力してください（{min}〜{max}）</s-text>
            <s-text-field
              label="数量"
              value={text}
              inputMode="numeric"
              onInput={(e) => setText(String(e?.target?.value ?? e ?? ""))}
              onChange={(e) => setText(String(e?.target?.value ?? e ?? ""))}
            />
          </s-stack>
        </s-box>

        <s-button slot="secondary-actions" command="--hide" commandFor={id}>
          キャンセル
        </s-button>

        <s-button
          slot="primary-action"
          tone="success"
          command="--hide"
          commandFor={id}
          onClick={() => onSetQty?.(clamp(String(text).trim()))}
        >
          確定
        </s-button>

        {onRemove ? (
          <s-button
            slot="footer"
            tone="critical"
            command="--hide"
            commandFor={id}
            onClick={() => onRemove?.()}
          >
            削除
          </s-button>
        ) : null}
      </s-modal>
    </>
  );
}

/* =========================
   Inbound screen split
========================= */

function InboundConditions({
  showImages,
  liteMode,
  onToggleLiteMode,
  appState,
  setAppState,
  onNext,
  onBack,
  setHeader,
  setFooter,
}) {
  const locationGid = useOriginLocationGid() || String(appState?.originLocationIdManual || "").trim() || null;
  const locIndex = useLocationsIndex(appState, setAppState);

  const inbound = getStateSlice(appState, "inbound", { selectedShipmentId: "" });

  const locationName = useMemo(() => {
    // locIndex.byId は「gid -> name(文字列)」
    const fromIndex = getLocationName_(locationGid, locIndex.byId);
    if (fromIndex && fromIndex !== "（不明）") return fromIndex;

    return String(appState?.originLocationNameManual || "").trim() || "現在店舗";
  }, [locationGid, locIndex.byId, appState?.originLocationNameManual]);

  const [viewMode, setViewMode] = useState("pending"); // "pending" | "received"
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [transfers, setTransfers] = useState([]);

  const displayLocationName = useMemo(() => {
    const arr = Array.isArray(transfers) ? transfers : [];
    const any = arr.find((t) => String(t?.destinationName || "").trim());
    const fromTransfers = String(any?.destinationName || "").trim();
    if (fromTransfers) return fromTransfers;

    return locationName;
  }, [transfers, locationName]);

  const STATUS_LABEL = useMemo(
    () => ({
      DRAFT: "下書き",
      READY_TO_SHIP: "配送準備完了",
      IN_PROGRESS: "処理中",
      IN_TRANSIT: "進行中",
      RECEIVED: "受領",
      TRANSFERRED: "入庫済み",
      CANCELED: "キャンセル",
      OTHER: "その他",
    }),
    []
  );

  const formatDate = (iso) => {
    const s = String(iso || "").trim();
    if (!s) return "-";
    // "2025-12-30T..." -> "2025-12-30"
    return s.slice(0, 10);
  };

  const isCompleted = (t) => {
    const total = Number(t?.totalQuantity ?? 0);
    const received = Number(t?.receivedQuantity ?? 0);
    if (t?.status === "TRANSFERRED") return true;
    return total > 0 && received >= total;
  };

  const listToShow = useMemo(() => {
    const base = Array.isArray(transfers) ? transfers : [];
    return viewMode === "received" ? base.filter(isCompleted) : base.filter((t) => !isCompleted(t));
  }, [transfers, viewMode]);

  const baseAll = Array.isArray(transfers) ? transfers : [];
  const pendingTransfersAll = baseAll.filter((t) => !isCompleted(t));
  const receivedTransfersAll = baseAll.filter((t) => isCompleted(t));

  const refresh = useCallback(async () => {
    if (!locationGid) return;
    setLoading(true);
    setError("");
    try {
      const all = await fetchTransfersForDestinationAll(locationGid);

      // ✅ 監査ログから過剰分/予定外分を合算して display に反映
      let patched = all;
      try {
        const audit = await readInboundAuditLog();
        const overIdx = buildInboundOverIndex_(audit, { locationId: locationGid });
        const extrasIdx = buildInboundExtrasIndex_(audit, { locationId: locationGid }); // ✅追加
        patched = mergeInboundOverIntoTransfers_(all, overIdx, extrasIdx); // ✅第3引数を渡す
      } catch (_) {
        patched = all;
      }

      setTransfers(patched);
    } catch (e) {
      setError(toUserMessage(e));
    } finally {
      setLoading(false);
    }
  }, [locationGid]);

  // 初回取得（locationGid が取れたら1回）
  useEffect(() => {
    if (!locationGid) return;
    refresh().catch(() => {});
  }, [locationGid, refresh]);

  const pickShipmentIdFromTransfer = (t) => {
    const nodes = t?.shipments ?? [];
    // 未受領っぽい shipment を優先（なければ先頭）
    const cand =
      nodes.find((s) => String(s?.status || "").toUpperCase() !== "RECEIVED") ||
      nodes.find((s) => String(s?.status || "").toUpperCase() !== "TRANSFERRED") ||
      nodes[0];
    return String(cand?.id || "").trim();
  };

  const onTapTransfer = (t) => {
    const shipmentId = pickShipmentIdFromTransfer(t);
    if (!shipmentId) return;

    const readOnly = isCompleted(t); // ✅ 入庫済み（処理済み）扱い

    setStateSlice(setAppState, "inbound", {
      selectedShipmentId: shipmentId,

      // 表示用メタ（壊さない範囲で追加）
      selectedTransferId: String(t?.id || ""),
      selectedTransferName: String(t?.name || ""),

      // ✅ ここが重要：InboundList ヘッダーの fallback 用
      selectedOriginName: String(t?.originName || ""),
      selectedDestinationName: String(t?.destinationName || ""),
      selectedTransferStatus: String(t?.status || ""),
      selectedTransferTotalQuantity: Number(t?.totalQuantity ?? 0),
      selectedTransferReceivedQuantity: Number(t?.receivedQuantityDisplay ?? t?.receivedQuantity ?? 0),
      selectedReadOnly: !!readOnly,
    });

    onNext?.();
  };

  // Header（必要ならここで簡易表示。固定領域を増やさない）
  useEffect(() => {
    setHeader?.(
      <s-box padding="small">
        <s-stack gap="tight">
          <s-text emphasis="bold">入庫IDを選択</s-text>
          <s-text tone="subdued" size="small">
            入庫先: {displayLocationName}
          </s-text>
        </s-stack>
      </s-box>
    );
    return () => setHeader?.(null);
  }, [setHeader, displayLocationName]);

  // Footer（戻る／軽量／再取得）
  useEffect(() => {
    const summaryLeft = `入庫先: ${displayLocationName}`;
    const summaryRight =
      viewMode === "received"
        ? `入庫済み ${listToShow.length}件`
        : `未入庫 ${listToShow.length}件`;

    setFooter?.(
      <FixedFooterNavBar
        summaryLeft={summaryLeft}
        summaryRight={summaryRight}
        leftLabel="戻る"
        onLeft={onBack}
        middleLabel={liteMode ? "軽量:ON" : "軽量:OFF"}
        middleTone={liteMode ? "critical" : "default"}
        onMiddle={onToggleLiteMode}
        rightLabel={loading ? "取得中..." : "再取得"}
        onRight={refresh}
        rightDisabled={loading || !locationGid}
      />
    );
    return () => setFooter?.(null);
  }, [setFooter, displayLocationName, viewMode, listToShow.length, onBack, liteMode, onToggleLiteMode, refresh, loading, locationGid]);

  return (
    <s-box padding="base">
      <s-stack gap="base">
        {/* 切替（左右50%ずつ“領域”を確保：Button自体をfillするAPIが現状ないため） */}
        <s-stack direction="inline" gap="none" inlineSize="100%">
          <s-box inlineSize="50%">
            <s-button
              kind={viewMode === "pending" ? "primary" : "secondary"}
              onClick={() => setViewMode("pending")}
            >
              未入庫 {pendingTransfersAll.length}件
            </s-button>
          </s-box>

          <s-box inlineSize="50%">
            <s-button
              kind={viewMode === "received" ? "primary" : "secondary"}
              onClick={() => setViewMode("received")}
            >
              入庫済み
            </s-button>
          </s-box>
        </s-stack>

        {error ? (
          <s-box padding="none">
            <s-text tone="critical">入庫ID一覧の取得に失敗しました: {error}</s-text>
          </s-box>
        ) : null}

        {listToShow.length === 0 ? (
          <s-text tone="subdued" size="small">
            {loading ? "取得中..." : "表示できる入庫IDがありません"}
          </s-text>
        ) : (
          <s-stack gap="base">
            {listToShow.map((t) => {
              const head = String(t?.name || "").trim() || "入庫ID";
              const date = formatDate(t?.dateCreated);
              const origin = t?.originName || "-";
              const dest = t?.destinationName || "-";

              const total = Number(t?.totalQuantity ?? 0);
              const received = Number(t?.receivedQuantityDisplay ?? t?.receivedQuantity ?? 0);

              const hasProgress = received > 0;
              const isPartial = hasProgress && received < total;
              const isOver = hasProgress && received > total;
              const hasDiff = isPartial || isOver;
              const statusSuffix = isPartial ? "（一部受領）" : isOver ? "（予定超過）" : "";

              const rawStatus = String(t?.status || "").trim();
              const statusJa = STATUS_LABEL[rawStatus] || (rawStatus ? rawStatus : "不明");

              return (
                <s-clickable key={t.id} onClick={() => onTapTransfer(t)}>
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
                        出庫元: {origin}
                      </s-text>

                      <s-text tone="subdued" size="small" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        入庫先: {dest}
                      </s-text>

                      <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="small">
                        <s-text tone={hasDiff ? "critical" : "subdued"} size="small" style={{ whiteSpace: "nowrap" }}>
                          状態: {statusJa}
                          {statusSuffix}
                        </s-text>
                        <s-text tone={hasDiff ? "critical" : "subdued"} size="small" style={{ whiteSpace: "nowrap" }}>
                          {received}/{total}
                        </s-text>
                      </s-stack>

                    </s-stack>
                  </s-box>
                  <s-divider />
                </s-clickable>
              );
            })}
          </s-stack>
        )}
      </s-stack>
    </s-box>
  );
}

/* =========================
   InboundList（貼り替え完全版 / 同一SKU安定版）
   - 外部スキャン（SCAN_QUEUE_KEY）を scanQueueRef に合流
   - JAN/SKU -> variant は resolveVariantByCode（永続キャッシュ）を利用
   - footer に滞留数/処理率を表示
   - ✅ addOrIncrement の hit 判定が stale にならないよう rows/extras を ref で最新参照
========================= */

function InboundList({
  showImages,
  liteMode,
  onToggleLiteMode,
  appState,
  setAppState,
  onBack,
  dialog,
  setHeader,
  setFooter,
}) {
  const mountedRef = useRef(true);
  const locationGid = useOriginLocationGid();
  const locIndex = useLocationsIndex(appState, setAppState);
  const inbound = getStateSlice(appState, "inbound", {
    selectedShipmentId: "",
    selectedTransferId: "",
    selectedTransferName: "",
    selectedOriginName: "",
    selectedDestinationName: "",
    selectedTransferStatus: "",
    selectedTransferTotalQuantity: 0,
    selectedTransferReceivedQuantity: 0,
    selectedReadOnly: false,
  });
  const selectedShipmentId = String(inbound.selectedShipmentId || "").trim();

  const CONFIRM_RECEIVE_MODAL_ID = "CONFIRM_RECEIVE_MODAL_ID";

  const WARNING_REASONS = [
    { id: "over_received", label: "予定超過" },
    { id: "unplanned", label: "予定外入荷" },
    { id: "damage_replace", label: "破損" },
    { id: "other", label: "その他" },
  ];

  // ✅ 予定差異モーダル：各カテゴリの表示は“1件だけ”にして、残りは「…他N件」
  const DIFF_PREVIEW_LIMIT = 1;

  // ✅ 長い商品名で縦に伸びないように 1 行 + 省略
  const oneLineStyle = {
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  };

  const [pendingLoading, setPendingLoading] = useState(false);
  const [pendingTransfers, setPendingTransfers] = useState([]);

  const [allTransfersLoading, setAllTransfersLoading] = useState(false);
  const [allTransfers, setAllTransfers] = useState([]);

  const refreshAllTransfers = async () => {
    if (!locationGid) return;
    setAllTransfersLoading(true);
    try {
      const all = await fetchTransfersForDestinationAll(locationGid);

      let list = Array.isArray(all) ? all : [];
      try {
        const audit = await readInboundAuditLog();
        const overIndex = buildInboundOverIndex_(audit, { locationId: locationGid });
        const extrasIndex = buildInboundExtrasIndex_(audit, { locationId: locationGid });
        list = mergeInboundOverIntoTransfers_(list, overIndex, extrasIndex);
      } catch (_) {}

      setAllTransfers(list);
    } catch {
      setAllTransfers([]);
    } finally {
      setAllTransfersLoading(false);
    }
  };

  const refreshPending = async () => {
    if (!locationGid) return;
    setPendingLoading(true);
    try {
      const data = await fetchPendingTransfersForDestination(locationGid);

      let list = Array.isArray(data) ? data : [];
      try {
        const audit = await readInboundAuditLog();
        const overIndex = buildInboundOverIndex_(audit, { locationId: locationGid });
        const extrasIndex = buildInboundExtrasIndex_(audit, { locationId: locationGid });
        list = mergeInboundOverIntoTransfers_(list, overIndex, extrasIndex);
      } catch (_) {}

      setPendingTransfers(list);
    } catch {
      setPendingTransfers([]);
    } finally {
      setPendingLoading(false);
    }
  };

  // ✅ 追加：InboundList を開いたら pendingTransfers を自動取得（ヘッダーの #T / 出庫元 / 入庫先用）
  useEffect(() => {
    if (!locationGid) return;
    refreshPending().catch(() => {});
    refreshAllTransfers().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationGid]);

  const [shipmentLoading, setShipmentLoading] = useState(false);
  const [shipmentError, setShipmentError] = useState("");
  const [shipment, setShipment] = useState(null);

  const [rows, setRows] = useState([]);
  const [extras, setExtras] = useState([]);

  // ✅ stale回避用 ref
  const rowsRef = useRef([]);
  const extrasRef = useRef([]);
  useEffect(() => {
    rowsRef.current = Array.isArray(rows) ? rows : [];
  }, [rows]);
  useEffect(() => {
    extrasRef.current = Array.isArray(extras) ? extras : [];
  }, [extras]);

  const [onlyUnreceived, setOnlyUnreceived] = useState(false);

  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [ackWarning, setAckWarning] = useState(false);

  const [scanValue, setScanValue] = useState("");
  const scanFinalizeTimerRef = useRef(null);
  const scanQueueRef = useRef([]);
  const scanProcessingRef = useRef(false);
  const scanPausedRef = useRef(false);
  const headerDebounceRef = useRef(null);
  
  const [scanDisabled, setScanDisabled] = useState(false);

  // queue metrics
  const [scanQueueLen, setScanQueueLen] = useState(0);
  const [scanRps, setScanRps] = useState(0);
  const scanProcessedTimestampsRef = useRef([]);

  const scanDisabledRef = useRef(false);
  useEffect(() => {
    scanDisabledRef.current = scanDisabled;
  }, [scanDisabled]);

  // ✅ readOnly中の編集を完全に止める（state更新をブロック）
  const readOnlyRef = useRef(false);
  const toastReadOnlyOnceRef = useRef(false);

  const denyEdit_ = () => {
    if (toastReadOnlyOnceRef.current) return;
    toastReadOnlyOnceRef.current = true;
    toast("この入庫は入庫済みのため変更できません");
  };

  const lastScanValueRef = useRef("");
  const lastScanChangeAtRef = useRef(0);

  useEffect(() => {
    VariantCache.init?.().catch(() => {});
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;

      scanPausedRef.current = true;
      scanQueueRef.current = [];
      scanProcessingRef.current = false;

      try {
        if (scanFinalizeTimerRef.current) clearTimeout(scanFinalizeTimerRef.current);
      } catch {}
    };
  }, []);

  const [addQuery, setAddQuery] = useState("");
  const debouncedAddQuery = useDebounce(addQuery.trim(), 200);
  const [addLoading, setAddLoading] = useState(false);
  const [addCandidates, setAddCandidates] = useState([]);
  const [addCandidatesDisplayLimit, setAddCandidatesDisplayLimit] = useState(20); // ✅ 初期表示20件

  const [addQtyById, setAddQtyById] = useState({});

  const clearAddSearch = useCallback(() => {
    setAddQuery("");
    setAddCandidates([]);
    setAddCandidatesDisplayLimit(20); // ✅ 検索クリア時に表示件数もリセット
    setAddQtyById({});
  }, []);

  // ✅ 「さらに表示」ボタン用（Inbound）
  const handleShowMoreAddCandidates = useCallback(() => {
    setAddCandidatesDisplayLimit((prev) => prev + 20);
  }, []);

  const [receiveSubmitting, setReceiveSubmitting] = useState(false);
  const receiveLockRef = useRef(false);
  const hideReceiveConfirmRef = useRef(null);

  const [draftSavedAt, setDraftSavedAt] = useState(null);

  const safeSet = (fn, signal) => {
    if (!mountedRef.current) return;
    if (signal?.aborted) return;
    fn?.();
  };

  const loadShipment = async (id, { signal } = {}) => {
    const shipmentId = String(id || "").trim();
    if (!shipmentId) return toast("Shipment ID が空です");

    safeSet(() => {
      setShipment(null);
      setRows([]);
      setExtras([]);
      setShipmentError("");
      setReason("");
      setNote("");
      setAckWarning(false);
      setDraftSavedAt(null);

      setScanValue("");
      lastScanValueRef.current = "";
      lastScanChangeAtRef.current = 0;

      try {
        if (scanFinalizeTimerRef.current) clearTimeout(scanFinalizeTimerRef.current);
      } catch {}
      scanQueueRef.current = [];
      scanProcessingRef.current = false;
      scanPausedRef.current = false;
      setScanDisabled(false);

      setShipmentLoading(true);
    }, signal);

    try {
      const s = await fetchInventoryShipmentEnriched(shipmentId, {
        includeImages: showImages && !liteMode,
        signal,
      });

      // ✅ 監査ログの over（過剰分）を「明細（SKU行）」にも反映するために取得
      //    ※ readInboundAuditLog / buildInboundOverItemIndex_ は事前に定義済み前提
      let overByInventoryItemId = new Map();
      try {
        const audit = await readInboundAuditLog();
        overByInventoryItemId = buildInboundOverItemIndex_(audit, {
          locationId: locationGid,
          shipmentId: s?.id,
        });
      } catch (_) {
        overByInventoryItemId = new Map();
      }

      // ✅ baseRows は safeSet の外で作る（同期処理なのでOK）
      const baseRows = (s.lineItems ?? []).map((li) => {
        const plannedQty = Number(li.quantity ?? 0);

        // ✅ Shopify側の実績（未入庫=0 / 部分受領は>0）
        const alreadyAcceptedQty = Math.max(0, Number(li.acceptedQuantity ?? 0));
        const alreadyRejectedQty = Math.max(0, Number(li.rejectedQuantity ?? 0));

        // ✅ 監査ログ over（過剰分）を行に合算
        const inventoryItemId = li.inventoryItemId;
        const overAcceptedQty = Math.max(
          0,
          Math.floor(Number(inventoryItemId ? overByInventoryItemId.get(String(inventoryItemId)) || 0 : 0))
        );
        const alreadyAcceptedTotalQty = alreadyAcceptedQty + overAcceptedQty;

        // ✅ 初期表示は「accepted + over」に合わせる（5/3 を表示できる）
        const initialReceiveQty = alreadyAcceptedTotalQty;

        return {
          key: li.id,
          shipmentLineItemId: li.id,
          inventoryItemId: li.inventoryItemId,
          title: li.title || li.sku || li.inventoryItemId || "(unknown)",
          sku: li.sku || "",
          barcode: li.barcode || "",
          imageUrl: li.imageUrl || "",
          plannedQty,
          alreadyAcceptedQty,        // Shopify accepted（そのまま）
          alreadyRejectedQty,
          overAcceptedQty,           // ✅ 追加：監査ログ over
          alreadyAcceptedTotalQty,   // ✅ 追加：accepted + over
          receiveQty: initialReceiveQty,
        };
      });

      const transferId = String(inbound?.selectedTransferId || "").trim();

      let draft = null;
      try {
        draft = await loadInboundDraft({ locationGid, transferId, shipmentId: s.id });
      } catch (_) {
        draft = null;
      }

      // ✅ safeSet の中は “同期” で state を当てるだけにする
      safeSet(() => {
        setShipment(s);

        if (draft) {
          const nextRows = baseRows.map((r) => {
            const saved = draft.rows?.find((x) => x.shipmentLineItemId === r.shipmentLineItemId);
            if (!saved) return r;
            const savedQty = Math.max(0, Math.floor(Number(saved.receiveQty || 0)));
            const nextQty = clampReceiveQty_(r, savedQty);
            return { ...r, receiveQty: nextQty };
          });

          setRows(nextRows);
          setExtras(Array.isArray(draft.extras) ? draft.extras : []);
          setOnlyUnreceived(!!draft.onlyUnreceived);
          setReason(String(draft.reason || ""));
          setNote(String(draft.note || ""));
          setAckWarning(false);
          setDraftSavedAt(draft.savedAt || null);

          toast("下書きを復元しました");
        } else {
          setRows(baseRows);
        }
      }, signal);

    } catch (e) {
      if (signal?.aborted) return;
      safeSet(() => setShipmentError(toUserMessage(e)), signal);
    } finally {
      safeSet(() => setShipmentLoading(false), signal);
    }
  };

  const loadShipmentById = loadShipment;

  useEffect(() => {
    if (!selectedShipmentId) {
      setShipment(null);
      setRows([]);
      setExtras([]);
      setShipmentError("");
      return;
    }

    const ac = new AbortController();
    (async () => {
      await loadShipment(selectedShipmentId, { signal: ac.signal });
    })();

    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedShipmentId, showImages, liteMode]);

  useEffect(() => {
    let alive = true;

    (async () => {
      const q = String(debouncedAddQuery || "").trim();

      // ✅ 1文字未満は候補を消す
      if (q.length < 1) {
        if (alive) {
          setAddCandidates([]);
          setAddCandidatesDisplayLimit(20); // ✅ 検索クリア時に表示件数もリセット
        }
        return;
      }

      try {
        if (alive) setAddLoading(true);

        const list = await searchVariants(q, {
          first: 50,
          includeImages: Boolean(showImages && !liteMode),
        });

        if (!alive) return;
        setAddCandidates(Array.isArray(list) ? list : []);
        setAddCandidatesDisplayLimit(20); // ✅ 新しい検索時は表示件数をリセット
      } catch (e) {
        if (!alive) return;
        setAddCandidates([]);
        setAddCandidatesDisplayLimit(20);
      } finally {
        if (alive) setAddLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [debouncedAddQuery, showImages, liteMode]);

  // ✅ 受領入力の安全クランプ：下限=既受領（減らせない）/ 上限は設けない（予定超過を許可）
  const clampReceiveQty_ = (r, n) => {
    const min = Math.max(0, Math.floor(Number(r?.alreadyAcceptedTotalQty ?? (Number(r?.alreadyAcceptedQty || 0) + Number(r?.overAcceptedQty || 0)))));
    const v = Math.max(min, Math.floor(Number(n || 0)));
    return v;
  };

  const setAllToPlanned = useCallback(() => {
    if (readOnlyRef.current) return denyEdit_();
    setRows((prev) =>
      prev.map((r) => ({ ...r, receiveQty: clampReceiveQty_(r, Number(r.plannedQty || 0)) }))
    );
    toast("全行を予定数でセットしました");
  }, []);

  const resetAllCounts = useCallback(() => {
    if (readOnlyRef.current) return denyEdit_();
    setRows((prev) => prev.map((r) => ({ ...r, receiveQty: clampReceiveQty_(r, 0) })));
    setExtras([]);
    setReason("");
    setNote("");
    setAckWarning(false);
    toast("受領数をリセットしました");
  }, []);

  const setRowQty = (key, value) => {
    if (readOnlyRef.current) return denyEdit_();
    const k = String(key || "");
    const n = Math.max(0, Number(value || 0));

    setRows((prev) =>
      prev.map((r) =>
        String(r.key) === k || String(r.shipmentLineItemId) === k
          ? { ...r, receiveQty: clampReceiveQty_(r, n) }
          : r
      )
    );
  };

  const incRow = (key, delta) => {
    if (readOnlyRef.current) return denyEdit_();
    setRows((prev) =>
      prev.map((r) =>
        r.key === key
          ? { ...r, receiveQty: clampReceiveQty_(r, Number(r.receiveQty || 0) + delta) }
          : r
      )
    );
  };

  const setExtraQty = (key, value) => {
    if (readOnlyRef.current) return denyEdit_();
    const n = Math.max(0, Number(value || 0));
    setExtras((prev) =>
      prev
        .map((x) => (x.key === key ? { ...x, receiveQty: n } : x))
        .filter((x) => Number(x.receiveQty || 0) > 0)
    );
  };

  const incExtra = (key, delta) => {
    if (readOnlyRef.current) return denyEdit_();
    setExtras((prev) =>
      prev
        .map((x) => (x.key === key ? { ...x, receiveQty: Math.max(0, Number(x.receiveQty || 0) + delta) } : x))
        .filter((x) => Number(x.receiveQty || 0) > 0)
    );
  };

  // ✅ 同一行加算（inventoryItemId優先） ※ rows/extras は ref で最新参照
  const addOrIncrementByResolved = useCallback((resolved, delta = 1, opts = {}) => {
    if (readOnlyRef.current) return denyEdit_();
    const inventoryItemId = resolved?.inventoryItemId;
    if (!inventoryItemId) return toast("inventoryItemId が取得できませんでした");

    const toastOnExtra = !!opts.toastOnExtra;

    const curRows = rowsRef.current || [];
    const curExtras = extrasRef.current || [];

    const hitRow = curRows.find((r) => r.inventoryItemId === inventoryItemId);
    if (hitRow) {
      incRow(hitRow.key, delta);
      return;
    }

    const hitExtra = curExtras.find((x) => x.inventoryItemId === inventoryItemId);
    if (hitExtra) {
      incExtra(hitExtra.key, delta);

      if (toastOnExtra) {
        const title =
          String(hitExtra.title || "").trim() ||
          `${resolved.productTitle || ""} / ${resolved.variantTitle || ""}`.trim() ||
          resolved.sku ||
          inventoryItemId;

        toast(`予定外入荷に追加：${title}（+${delta}）`);
      }

      return;
    }

    const key = `${Date.now()}-${Math.random()}`;

    const title =
      `${resolved.productTitle || ""} / ${resolved.variantTitle || ""}`.trim() ||
      resolved.sku ||
      inventoryItemId;

    setExtras((prev) => [
      {
        key,
        inventoryItemId,
        variantId: resolved.variantId,
        title,
        sku: resolved.sku || "",
        barcode: resolved.barcode || "",
        imageUrl: resolved.imageUrl || "",
        receiveQty: Math.max(0, delta),
      },
      ...prev,
    ]);

    if (toastOnExtra) {
      toast(`予定外入荷に追加：${title}（+${delta}）`);
    }
  }, []);

  const waitForOk = async (title, msg) => {
    scanPausedRef.current = true;
    setScanDisabled(true);

    if (dialog?.alert) {
      await dialog.alert({
        type: "error",
        title: String(title || "スキャンエラー"),
        content: String(msg || ""),
        actionText: "OK",
      });
    } else {
      toast(String(msg || "エラー"));
    }

    setScanDisabled(false);
    scanPausedRef.current = false;
  };

  const kickProcessScanQueue = () => {
    if (scanProcessingRef.current) return;
    if (scanPausedRef.current) return;

    scanProcessingRef.current = true;

    (async () => {
      try {
        while (scanQueueRef.current.length > 0) {
          if (!mountedRef.current) break;
          if (scanPausedRef.current) break;

          const code = String(scanQueueRef.current.shift() || "").trim();
          if (!code) continue;

          setScanQueueLen(scanQueueRef.current.length);

          if (!shipment?.id) {
            await waitForOk("スキャンできません", "先にShipmentを読み込んでください。");
            continue;
          }

          let resolved = null;
          try {
            resolved = await resolveVariantByCode(code, { includeImages: showImages && !liteMode });
          } catch (e) {
            await waitForOk("スキャン検索エラー", `検索に失敗しました: ${code}\n${toUserMessage(e)}`);
            continue;
          }

          if (!resolved?.variantId) {
            await waitForOk("商品が見つかりません", `商品が見つかりません: ${code}`);
            continue;
          }

          addOrIncrementByResolved(resolved, 1);

          const now = Date.now();
          const arr = scanProcessedTimestampsRef.current.filter((t) => now - t <= 1000);
          arr.push(now);
          scanProcessedTimestampsRef.current = arr;
          setScanRps(arr.length);
        }
      } finally {
        scanProcessingRef.current = false;
        if (!scanPausedRef.current && scanQueueRef.current.length > 0) kickProcessScanQueue();
      }
    })();
  };

  // ✅ スキャン確定（入力フィールド用）
  const scanFinalizeSoon = (nextValue) => {
    const next = String(nextValue ?? "");
    lastScanValueRef.current = next;
    lastScanChangeAtRef.current = Date.now();

    try {
      if (scanFinalizeTimerRef.current) clearTimeout(scanFinalizeTimerRef.current);
    } catch {}

    const FINALIZE_MS = 180;

    scanFinalizeTimerRef.current = setTimeout(() => {
      if (scanDisabledRef.current) return;

      const latest = String(lastScanValueRef.current || "").trim();
      if (!latest) return;
      if (latest.length < 6) return;
      if (Date.now() - (lastScanChangeAtRef.current || 0) < FINALIZE_MS - 5) return;

      setScanValue("");
      lastScanValueRef.current = "";

      scanQueueRef.current.push(latest);
      setScanQueueLen(scanQueueRef.current.length);
      kickProcessScanQueue();
    }, FINALIZE_MS);
  };

  // ✅ 外部スキャン（SCAN_QUEUE_KEY）を取り出して scanQueueRef に合流（100msで1件ずつ）
  useEffect(() => {
    let stop = false;

    const tick = async () => {
      if (stop) return;
      if (!SHOPIFY?.storage?.get || !SHOPIFY?.storage?.set) return;

      const q = (await SHOPIFY.storage.get(SCAN_QUEUE_KEY)) || {};
      const list = Array.isArray(q.items) ? q.items : [];
      if (list.length === 0) return;

      const head = String(list[0] || "").trim();
      const rest = list.slice(1);

      // ✅ lastV/lastT を壊さない（...q を維持）
      await SHOPIFY.storage.set(SCAN_QUEUE_KEY, { ...q, items: rest, updatedAt: Date.now() });

      if (!head) return;

      scanQueueRef.current.push(head);
      setScanQueueLen(scanQueueRef.current.length);
      kickProcessScanQueue();
    };

    const t = setInterval(() => {
      tick().catch(() => {});
    }, 100);

    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [shipment?.id, showImages, liteMode]);

  const plannedTotal = rows.reduce((a, r) => a + Number(r.plannedQty || 0), 0);
  const receiveTotal = rows.reduce((a, r) => a + Number(r.receiveQty || 0), 0);

  const overRows = rows
    .map((r) => {
      const planned = Number(r.plannedQty || 0);
      const want = Number(r.receiveQty || 0);
      const over = Math.max(0, want - planned);
      return over > 0
        ? { shipmentLineItemId: r.shipmentLineItemId, title: r.title, overQty: over, inventoryItemId: r.inventoryItemId }
        : null;
    })
    .filter(Boolean);

  const shortageRows = rows
    .map((r) => {
      const planned = Number(r.plannedQty || 0);
      const received = Number(r.receiveQty || 0);
      const shortage = Math.max(0, planned - received);
      return shortage > 0
        ? {
            shipmentLineItemId: r.shipmentLineItemId,
            title: r.title,
            shortageQty: shortage,
            inventoryItemId: r.inventoryItemId,
          }
        : null;
    })
    .filter(Boolean);

  const overQtyTotal = overRows.reduce((a, x) => a + Number(x.overQty || 0), 0);
  const extrasQtyTotal = extras.reduce((a, x) => a + Number(x.receiveQty || 0), 0);

  // ✅ 追加：不足（予定 > 受領 の差分合計）
  const shortageQtyTotal = (Array.isArray(rows) ? rows : []).reduce((a, r) => {
    const planned = Number(r.plannedQty || 0);
    const received = Number(r.receiveQty || 0);
    return a + Math.max(0, planned - received);
  }, 0);

  // ✅ 警告：予定外 / 超過 / 不足 のいずれかがあれば warning 扱い
  const hasWarning =
    overRows.length > 0 ||
    extras.length > 0 ||
    shortageQtyTotal > 0;

  // ✅ GID/文字列差を吸収（末尾IDで一致させる）
  const normalizeId_ = (v) => String(v || "").trim().split("/").pop();

  // ✅ shipmentId（選択中）から、それを含む Transfer を逆引き（出庫元/入庫先/Transfer名を確実に出す）
  const transferForShipment = useMemo(() => {
    const sidRaw = String(shipment?.id || selectedShipmentId || "").trim();
    if (!sidRaw) return null;

    const sidNorm = normalizeId_(sidRaw);

    const p = Array.isArray(pendingTransfers) ? pendingTransfers : [];
    const a = Array.isArray(allTransfers) ? allTransfers : [];

    // ✅ pending優先でユニーク化
    const merged = [];
    const seen = new Set();
    [...p, ...a].forEach((t) => {
      const id = String(t?.id || "").trim();
      if (!id || seen.has(id)) return;
      seen.add(id);
      merged.push(t);
    });

    return (
      merged.find((t) => {
        const ships = Array.isArray(t.shipments) ? t.shipments : [];
        return ships.some((s) => {
          const idRaw = String(s?.id || "").trim();
          if (!idRaw) return false;
          return idRaw === sidRaw || normalizeId_(idRaw) === sidNorm;
        });
      }) || null
    );
  }, [pendingTransfers, allTransfers, shipment?.id, selectedShipmentId]);

  const readOnly = useMemo(() => {
    // 1) shipment 自体が RECEIVED なら確定で読み取り専用
    if (String(shipment?.status || "").toUpperCase() === "RECEIVED") return true;

    // 2) 遷移元で readOnly を持ってきている場合
    if (!!inbound?.selectedReadOnly) return true;

    // 3) transfer の total/received で完了判定
    const total = Number(transferForShipment?.totalQuantity ?? inbound?.selectedTransferTotalQuantity ?? 0);
    const received = Number(
      transferForShipment?.receivedQuantityDisplay ??
        transferForShipment?.receivedQuantity ??
        inbound?.selectedTransferReceivedQuantity ??
        0
    );

    if (total > 0 && received >= total) return true;

    return false;
  }, [
    shipment?.status,
    inbound?.selectedReadOnly,
    inbound?.selectedTransferTotalQuantity,
    inbound?.selectedTransferReceivedQuantity,
    transferForShipment?.totalQuantity,
    transferForShipment?.receivedQuantity,
  ]);

  useEffect(() => {
    readOnlyRef.current = !!readOnly;

    // readOnly が解除されたら次回また toast 出せるように戻す
    if (!readOnly) toastReadOnlyOnceRef.current = false;
  }, [readOnly]);

  // ✅ 下書き（自動保存）：Transfer単位で保存（transferIdが無ければshipmentIdでフォールバック）
  useEffect(() => {
    if (!locationGid) return;
    if (!shipment?.id) return;      // load中に “空保存” して上書きしない
    if (shipmentLoading) return;
    if (readOnlyRef.current) return;

    const transferId = String(inbound?.selectedTransferId || "").trim();
    const shipmentId = String(shipment.id || "").trim();

    const timer = setTimeout(() => {
      (async () => {
        try {
          const payload = {
            savedAt: new Date().toISOString(),
            transferId: transferId || null,
            shipmentId,
            rows: (rowsRef.current || []).map((r) => ({
              shipmentLineItemId: r.shipmentLineItemId,
              receiveQty: Number(r.receiveQty || 0),
            })),
            extras: Array.isArray(extrasRef.current) ? extrasRef.current : [],
            onlyUnreceived: !!onlyUnreceived,
            reason: String(reason || ""),
            note: String(note || ""),
          };

          const ok = await saveInboundDraft({
            locationGid,
            transferId,
            shipmentId,
            payload,
          });

          if (ok && mountedRef.current) {
            setDraftSavedAt(payload.savedAt);
          }
        } catch {
          // noop（保存失敗で画面を止めない）
        }
      })();
    }, 300);

    return () => clearTimeout(timer);
  }, [
    locationGid,
    shipment?.id,
    shipmentLoading,
    inbound?.selectedTransferId,
    onlyUnreceived,
    reason,
    note,
    rows,
    extras,
  ]);

  // ✅ 確定できる条件（Shipmentあり + 処理中でない + スキャン停止でない）
  const canConfirm = !!shipment?.id && !receiveSubmitting && !scanDisabled && !readOnly;

  const warningReady = !hasWarning ? true : !!ackWarning; // ✅ 警告がある時だけ確認(ack)必須

  // ✅ モーダルを開ける条件（確定可能 + warning条件が揃っている）
  const canOpenConfirm = canConfirm;

  // ✅ 表示対象行（未受領のみフィルタ）
  const visibleRows = useMemo(() => {
    const base = Array.isArray(rows) ? rows : [];
    if (!onlyUnreceived) return base;

    return base.filter((r) => {
      const planned = Number(r.plannedQty || 0);
      const rejected = Number(r.alreadyRejectedQty || 0);
      const acceptedTarget = Number(r.receiveQty || 0);
      const remaining = Math.max(0, planned - rejected - acceptedTarget);
      return remaining > 0;
    });
  }, [rows, onlyUnreceived]);

  // ✅ 表示する入庫ID：#T00... を優先（なければ #末尾8桁フォールバック）
  const headNo = useMemo(() => {
    const raw = String(
      transferForShipment?.name || inbound?.selectedTransferName || ""
    ).trim();

    const m = raw.match(/T\d+/i);
    if (m) return `#${String(m[0]).toUpperCase()}`;
    if (raw) return raw.startsWith("#") ? raw : `#${raw}`;

    const s = String(shipment?.id || selectedShipmentId || "").trim();
    return s ? `#${s.slice(-8)}` : "—";
  }, [transferForShipment?.name, inbound?.selectedTransferName, shipment?.id, selectedShipmentId]);

  // ✅ 出庫元名：Transferの originName を最優先（shipment側に無いのでここが本命）
  const originName = useMemo(() => {
    const n = String(
      transferForShipment?.originName || inbound?.selectedOriginName || ""
    ).trim();
    return n || "—";
  }, [transferForShipment?.originName, inbound?.selectedOriginName]);

  // ✅ 入庫先名：Transferの destinationName を最優先。無ければ現在ロケの名前へ
  const inboundTo = useMemo(() => {
    const n = String(
      transferForShipment?.destinationName || inbound?.selectedDestinationName || ""
    ).trim();
    if (n) return n;

    const fallback = getLocationName_(locationGid, locIndex.byId);
    return String(fallback || "").trim() || "—";
  }, [transferForShipment?.destinationName, inbound?.selectedDestinationName, locationGid, locIndex.byId]);

  const receiveConfirm = useCallback(async ({ finalize = true } = {}) => {
    if (readOnly) {
      toast("この入庫は処理済みのため編集できません");
      return false;
    }
    if (!shipment?.id) return false;
    if (!locationGid) {
      toast("現在店舗（origin location）が取得できませんでした");
      return false;
    }

    // ✅ 警告が出ている場合：理由は不要、確認（ackWarning）だけ必須
    if (hasWarning && !ackWarning) {
      toast("差異があります。内容を確認してから確定してください。");
      return false;
    }

    if (receiveLockRef.current) return false;
    receiveLockRef.current = true;
    setReceiveSubmitting(true);

    try {
      // 0) shortage（不足）を payload 化（※完了(finalize)のときだけ REJECT で送る）
      //    ✅ delta=0 でも「不足がある」なら「完了」は確定できる
      const rejectedItems = finalize
        ? (shortageRows || [])
            .map((r) => ({
              shipmentLineItemId: String(r.shipmentLineItemId || "").trim(),
              quantity: Math.max(0, Math.floor(Number(r.shortageQty || 0))),
              reason: "REJECTED",
            }))
            .filter((x) => x.shipmentLineItemId && x.quantity > 0)
        : [];

      // 1) 受領アイテム（planned rows）
      // ✅ 画面上の「受領」は累計目標、送信は「追加分（delta）」のみ
      const plannedItems = rows
        .map((r) => {
          const shipmentLineItemId = String(r.shipmentLineItemId || "").trim();

          const targetAccepted = Math.max(0, Math.floor(Number(r.receiveQty || 0)));
          const alreadyAccepted = Math.max(0, Math.floor(Number(r.alreadyAcceptedQty || 0))); // Shopify accepted
          const alreadyOver = Math.max(0, Math.floor(Number(r.overAcceptedQty || 0)));        // 監査ログ over
          const alreadyTotal = alreadyAccepted + alreadyOver;

          const delta = Math.max(0, targetAccepted - alreadyTotal);

          return { shipmentLineItemId, quantity: delta };
        })
        .filter((x) => x.shipmentLineItemId && x.quantity > 0);

      // 2) 予定外入荷（extras）: receiveQty で保持
      const extraDeltas = (extras || [])
        .map((x) => ({
          inventoryItemId: String(x?.inventoryItemId || "").trim(),
          delta: Math.max(0, Math.floor(Number(x?.receiveQty || 0))),
        }))
        .filter((x) => x.inventoryItemId && x.delta > 0);

      const hasAnyAction = plannedItems.length > 0 || extraDeltas.length > 0 || rejectedItems.length > 0;
      if (!hasAnyAction) {
        toast(finalize ? "送信する差分がありません" : "一部受領として送る差分がありません");
        return false;
      }

      // 3) planned を shipmentReceive（fallback付き）
      //    予定超過が Shopify 側で弾かれる可能性があるため、
      //    まずはそのまま試し、落ちたら「予定分まで receive + 超過分は adjust」にフォールバック
      let extraDeltasMerged = extraDeltas;

      if (plannedItems.length > 0) {
        try {
          await receiveShipmentWithFallbackV2({
            shipmentId: shipment.id,
            items: plannedItems,
          });
        } catch (e) {
          const msg = String(e?.message || e || "");
          const looksQuantityError = /quantity|unreceived|exceed|max|greater|less/i.test(msg);

          if (!looksQuantityError) throw e;

          const overflowMap = new Map();

          const cappedItems = rows
            .map((r) => {
              const shipmentLineItemId = String(r.shipmentLineItemId || "").trim();
              const inventoryItemId = String(r.inventoryItemId || "").trim();

              const planned = Math.max(0, Math.floor(Number(r.plannedQty || 0)));
              const alreadyRejected = Math.max(0, Math.floor(Number(r.alreadyRejectedQty || 0)));
              const alreadyAccepted = Math.max(0, Math.floor(Number(r.alreadyAcceptedQty || 0))); // Shopify accepted
              const alreadyOver = Math.max(0, Math.floor(Number(r.overAcceptedQty || 0)));        // 監査ログ over
              const alreadyTotal = alreadyAccepted + alreadyOver;

              const targetAccepted = Math.max(0, Math.floor(Number(r.receiveQty || 0)));

              // ✅ 追加分は「accepted+over」基準（既に過剰調整済みなら送らない）
              const wantDelta = Math.max(0, targetAccepted - alreadyTotal);

              // ✅ Shopify shipment で受けられる残りは accepted 基準（overは含めない）
              const remainingReceivable = Math.max(0, planned - alreadyRejected - alreadyAccepted);

              const deltaPlanned = Math.min(remainingReceivable, wantDelta);
              const overflow = Math.max(0, wantDelta - deltaPlanned);

              if (overflow > 0 && inventoryItemId) {
                overflowMap.set(inventoryItemId, (overflowMap.get(inventoryItemId) || 0) + overflow);
              }

              return { shipmentLineItemId, quantity: deltaPlanned };
            })
            .filter((x) => x.shipmentLineItemId && x.quantity > 0);

          // planned 側に送れる分があれば receive（無ければスキップ）
          if (cappedItems.length > 0) {
            await receiveShipmentWithFallbackV2({
              shipmentId: shipment.id,
              items: cappedItems,
            });
          }

          // overflow（予定超過）を extras に合算して adjust に回す
          if (overflowMap.size > 0) {
            const m = new Map();
            (extraDeltas || []).forEach((d) => {
              const k = String(d.inventoryItemId || "").trim();
              const v = Math.max(0, Math.floor(Number(d.delta || 0)));
              if (!k || v <= 0) return;
              m.set(k, (m.get(k) || 0) + v);
            });

            overflowMap.forEach((v, k) => {
              const kk = String(k || "").trim();
              const vv = Math.max(0, Math.floor(Number(v || 0)));
              if (!kk || vv <= 0) return;
              m.set(kk, (m.get(kk) || 0) + vv);
            });

            extraDeltasMerged = Array.from(m.entries()).map(([inventoryItemId, delta]) => ({
              inventoryItemId,
              delta,
            }));
          }
        }
      }

      // 3-b) 完了（finalize）の場合：不足があるなら不足分を REJECTED として確定（＝完了扱い）
      //     一部受領（finalize=false）の場合は不足を残して「続きができる」状態にする
      if (finalize && rejectedItems.length > 0) {
        await receiveShipmentWithFallbackV2({
          shipmentId: shipment.id,
          items: rejectedItems,
        });
      }

      // 4) extras（＋予定超過fallback分）がある場合は、入庫ロケーションに在庫を加算（Activate → Adjust）
      if (extraDeltasMerged.length > 0) {
        const inventoryItemIds = extraDeltasMerged.map((d) => d.inventoryItemId);

        const act = await ensureInventoryActivatedAtLocation({
          locationId: locationGid,
          inventoryItemIds,
          debug,
        });

        if (!act?.ok) {
          const msg =
            (act?.errors || [])
              .map((e) => `${e.inventoryItemId}: ${e.message}`)
              .filter(Boolean)
              .join("\n") || "在庫の有効化に失敗しました";
          throw new Error(msg);
        }

        await adjustInventoryAtLocationWithFallback({
          locationId: locationGid,
          deltas: extraDeltasMerged,
        });
      }

      // 5) 監査ログ（任意）
      if (typeof appendInboundAuditLog === "function") {
        try {
          const reasonText = String(reason || "").trim();
          const noteText = String(note || "").trim();

          // ✅ overRows は「この確定で発生した過剰分（planned超え）」の増分
          // ✅ extraDeltasMerged は「予定外入荷 + 過剰fallback」を含む場合がある
          const overForLog = (overRows || [])
            .map((x) => ({
              inventoryItemId: String(x?.inventoryItemId || "").trim(),
              qty: Math.max(0, Math.floor(Number(x?.overQty || 0))),
              title: String(x?.title || "").trim(),
            }))
            .filter((x) => x.inventoryItemId && x.qty > 0);

          const extrasForLog = (extraDeltasMerged || [])
            .map((d) => ({
              inventoryItemId: String(d?.inventoryItemId || "").trim(),
              qty: Math.max(0, Math.floor(Number(d?.delta || 0))),
            }))
            .filter((x) => x.inventoryItemId && x.qty > 0);

          await appendInboundAuditLog({
            shipmentId: shipment.id,
            locationId: locationGid,
            reason: reasonText,
            note: noteText,
            over: overForLog,
            extras: extrasForLog,
          });
        } catch (e) {
          toast(`履歴ログ保存に失敗: ${String(e?.message || e)}（write_metafields 等を確認）`);
          debug("appendInboundAuditLog failed", e);
        }
      }

      // ✅ 管理画面の「メモ(note)」へも追記（任意）
      try {
        const noteLine = buildInboundNoteLine_({
          shipmentId: shipment?.id,
          locationId: locationGid,
          finalize,
          note: noteText,
          over: overForLog,
          extras: extrasForLog,
        });

        const hasSomething =
          String(noteText || "").trim() ||
          (Array.isArray(overForLog) && overForLog.length > 0) ||
          (Array.isArray(extrasForLog) && extrasForLog.length > 0);

        if (hasSomething) {
          const ok = await appendInventoryTransferNote_({
            transferId,
            line: noteLine,
          });
          if (!ok) toast("管理画面メモへの追記に失敗しました（権限/スコープを確認）");
        }
      } catch (e) {
        toast(`管理画面メモへの追記エラー: ${String(e?.message || e)}`);
        debug("appendInventoryTransferNote_ failed", e);
      }

      toast(finalize ? "入庫を完了しました" : "一部受領を確定しました");

      // ✅ 確定後：下書きをリセット（次回に残さない）
      try {
        await clearInboundDraft({
          locationGid,
          transferId: String(inbound?.selectedTransferId || "").trim(),
          shipmentId: shipment.id,
        });
      } catch (_) {}
      setDraftSavedAt(null);

      // 6) 画面更新
      try {
        await refreshPending();
      } catch (_) {}

      try {
        await loadShipmentById(shipment.id);
      } catch (_) {}

      return true;
    } catch (e) {
      const msg = toUserMessage(e);

      // ✅ まず必ず可視化（POSで modal を await すると“確定中..”で固まることがある）
      toast(`入庫確定エラー: ${msg}`);

      // ✅ dialog は “await しない” （表示できれば出す、できなくても処理は戻す）
      try {
        dialog?.alert?.({
          type: "error",
          title: "入庫確定に失敗しました",
          content: msg,
          actionText: "OK",
        });
      } catch (_) {}

      return false;
    } finally {
      setReceiveSubmitting(false);
      receiveLockRef.current = false;
    }
  }, [
    shipment?.id,
    locationGid,
    rows,
    extras,
    hasWarning,
    reason,
    ackWarning,
    inbound?.selectedTransferId,
    note,
    dialog,
    refreshPending,
    loadShipmentById,
  ]);

  // =========================
  // Header（固定領域 / 出庫と同じ setHeader 方式）
  //  - 1行目：#番号 + 出庫元/入庫先
  //  - 右：軽量 / 全受領 / リセット
  //  - 2行目：リスト外追加（検索）＋結果
  // =========================
  const headerNode = useMemo(() => {
    if (!setHeader) return null;

    const q = String(addQuery || "");
    const showResults = q.trim().length >= 1;

    return (
      <s-box padding="small">
        <s-stack gap="tight">
          <s-stack
            direction="inline"
            justifyContent="space-between"
            alignItems="flex-start"
            gap="small"
            style={{ width: "100%", flexWrap: "nowrap" }}
          >
            {/* 左：縮められる（minWidth:0 + flex が重要） */}
            <s-stack gap="none" style={{ minWidth: 0, flex: "1 1 auto" }}>
              {/* 1行目：#T0000（太字） */}
              <s-text
                emphasis="bold"
                style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
              >
                {headNo}
              </s-text>

              {/* 2行目：出庫元（省略表示） */}
              <s-text
                size="small"
                tone="subdued"
                style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
              >
                出庫元：{originName}
              </s-text>

              {/* 3行目：入庫先（省略表示） */}
              <s-text
                size="small"
                tone="subdued"
                style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
              >
                入庫先：{inboundTo}
              </s-text>
            </s-stack>

            {/* 右：絶対に折り返さない */}
            <s-stack
              direction="inline"
              gap="small"
              alignItems="center"
              style={{ flex: "0 0 auto", flexWrap: "nowrap", whiteSpace: "nowrap" }}
            >
              {onToggleLiteMode ? (
                <s-button
                  kind="secondary"
                  tone={liteMode ? "critical" : undefined}
                  onClick={onToggleLiteMode}
                  style={{ paddingInline: 8, whiteSpace: "nowrap" }}
                >
                  軽量
                </s-button>
              ) : null}

              <s-button
                onClick={setAllToPlanned}
                disabled={!shipment?.id || readOnly}
                style={{ paddingInline: 8, whiteSpace: "nowrap" }}
              >
                全受領
              </s-button>

              <s-button
                onClick={resetAllCounts}
                disabled={!shipment?.id || readOnly}
                style={{ paddingInline: 8, whiteSpace: "nowrap" }}
              >
                リセット
              </s-button>
            </s-stack>
          </s-stack>

          {/* リスト外追加（検索） */}
          <s-box inlineSize="100%" paddingBlockStart="small-200">
            <s-text-field
              label="検索"
              labelHidden
              placeholder="商品名 / SKU / バーコード"
              value={q}
              onInput={(v) => setAddQuery(readValue(v))}
              onChange={(v) => setAddQuery(readValue(v))}
            >
              {q ? (
                <s-button slot="accessory" kind="secondary" tone="critical" onClick={clearAddSearch}>
                  ✕
                </s-button>
              ) : null}
            </s-text-field>
          </s-box>

          {showResults ? (
            <s-text tone="subdued" size="small">
              検索結果：{addLoading ? "…" : addCandidates.length}件
            </s-text>
          ) : null}

          {addLoading ? <s-text tone="subdued" size="small">検索中...</s-text> : null}

        </s-stack>
      </s-box>
    );
  }, [
    setHeader,
    addQuery,
    addLoading,
    addCandidates,
    headNo,
    originName,
    inboundTo,
    liteMode,
    onToggleLiteMode,
    shipment?.id,
    setAllToPlanned,
    resetAllCounts,
    clearAddSearch,
    addOrIncrementByResolved,
    showImages,
  ]);

  useEffect(() => {
    if (!setHeader) return;
    setHeader(headerNode);
    return () => setHeader(null);
  }, [setHeader, headerNode]);

  // ✅ 下部固定フッター（戻る + 中央2行 + 確定）
  const footerLine1 = shipment?.id
    ? `予定 ${plannedTotal} / 受領 ${receiveTotal}`
    : "未選択";

  const footerLine2 = shipment?.id
    ? `予定外 ${extrasQtyTotal} / 超過 ${overQtyTotal} / 不足 ${shortageQtyTotal}`
    : "";

  const hasStatusIssue = (extrasQtyTotal + overQtyTotal + shortageQtyTotal) > 0;

  useEffect(() => {
    setFooter?.(
      <s-box
        padding="base"
        border="base"
        style={{
          position: "sticky",
          bottom: 0,
          background: "var(--s-color-bg)",
          zIndex: 10,
        }}
      >
        <s-stack gap="extra-tight">
          <s-stack
            direction="inline"
            gap="base"
            alignItems="center"
            justifyContent="space-between"
            style={{ width: "100%", flexWrap: "nowrap" }}
          >
            <s-box style={{ flex: "0 0 auto" }}>
              <s-button onClick={onBack} disabled={receiveSubmitting}>
                戻る
              </s-button>
            </s-box>

            {/* ✅ 中央：2行（予定/受領 + 状態） */}
            <s-box style={{ flex: "1 1 auto", minWidth: 0, paddingInline: 8 }}>
              <s-stack gap="none" alignItems="center">
                <s-text alignment="center" size="small" tone="subdued">
                  {footerLine1}
                </s-text>

                {footerLine2 ? (
                  <s-text alignment="center" size="small" tone={hasWarning ? "critical" : "subdued"}>
                    {footerLine2}
                  </s-text>
                ) : null}

                {liteMode ? (
                  <s-text alignment="center" size="small" tone="subdued">
                    軽量ON
                  </s-text>
                ) : null}
              </s-stack>
            </s-box>

            <s-box style={{ flex: "0 0 auto" }}>
              <s-button
                tone={hasWarning ? "critical" : "success"}
                command="--show"
                commandFor={CONFIRM_RECEIVE_MODAL_ID}
                disabled={!canOpenConfirm}
              >
                {receiveSubmitting ? "確定中..." : "確定"}
              </s-button>
            </s-box>
          </s-stack>

          {shipmentLoading ? <s-text size="small" tone="subdued">Shipment 読み込み中...</s-text> : null}
          {shipmentError ? <s-text size="small" tone="critical">{shipmentError}</s-text> : null}
        </s-stack>
      </s-box>
    );

    return () => setFooter?.(null);
  }, [
    setFooter,
    onBack,
    footerLine1,
    footerLine2,
    hasWarning,
    canOpenConfirm,
    receiveSubmitting,
    shipmentLoading,
    shipmentError,
    liteMode,
  ]);

  const renderExtras_ = () => {
    if (!Array.isArray(extras) || extras.length === 0) {
      return <s-text tone="subdued" size="small">予定外追加はありません</s-text>;
    }

    return (
      <s-stack gap="none">
        {extras.map((x) => {
          const received = Number(x?.receiveQty || 0);

          const sku = String(x?.sku || "").trim();
          const barcode = String(x?.barcode || "").trim();

          // ✅ Shipment内の skuLine と同じ作り（SKU/JAN をここで確実に定義）
          const skuLine = sku
            ? `SKU:${sku}${barcode ? ` / JAN:${barcode}` : ""}`
            : barcode
            ? `JAN:${barcode}`
            : "";

          // ✅ 下段左：予定外は「予定外 / 受領 n」にする（要件に合わせて文言はここで調整）
          const bottomLeft = `予定外 / 受領 ${received}`;
          const bottomLeftTone = received > 0 ? "critical" : "subdued";

          return (
            <InboundAddedLineRow
              key={x.key}
              row={{
                title: x.title || x.sku || x.inventoryItemId || "(unknown)",
                imageUrl: x.imageUrl || "",
              }}
              showImages={showImages}
              dialog={dialog}
              qty={received}
              modalKey={x.key}
              skuLine={skuLine}
              bottomLeft={bottomLeft}
              bottomLeftTone={bottomLeftTone}
              onDec={() => setExtraQty(x.key, Math.max(0, received - 1))}
              onInc={() => setExtraQty(x.key, received + 1)}
              onSetQty={(n) => setExtraQty(x.key, n)}
              minQty={1}
              onRemove={() => setExtraQty(x.key, 0)}
            />
          );
        })}
      </s-stack>
    );
  };

  // ▼ 入庫候補（検索結果）用：在庫キャッシュ（上位だけプリフェッチ）
  const CANDIDATE_STOCK_PREFETCH_LIMIT = 8;

  const [inbCandidateStockVersion, setInbCandidateStockVersion] = useState(0);
  const inbCandidateStockCacheRef = useRef(new Map());
  const inbCandidateStockFetchedRef = useRef(new Set());

  const bumpInbCandidateStock = useCallback(() => {
    setInbCandidateStockVersion((x) => x + 1);
  }, []);

  const getInbCandidateStock = useCallback((key) => {
    return inbCandidateStockCacheRef.current.get(String(key || ""));
  }, []);

  const ensureInbCandidateStock = useCallback(
    async (key, variantId) => {
      const k = String(key || "").trim();
      const vId = String(variantId || "").trim();
      if (!k || !vId || !locationGid) return;
      if (inbCandidateStockFetchedRef.current.has(k)) return;

      inbCandidateStockFetchedRef.current.add(k);

      // 先に loading を入れて描画更新
      inbCandidateStockCacheRef.current.set(k, { loading: true, available: null, error: null });
      bumpInbCandidateStock();

      try {
        const r = await fetchVariantAvailable({ variantGid: vId, locationGid });
        const available = Number.isFinite(Number(r?.available)) ? Number(r.available) : null;
        inbCandidateStockCacheRef.current.set(k, { loading: false, available, error: null });
      } catch (e) {
        inbCandidateStockCacheRef.current.set(k, { loading: false, available: null, error: e });
      } finally {
        bumpInbCandidateStock();
      }
    },
    [locationGid, bumpInbCandidateStock]
  );

  // =========================
  // Inbound 検索結果行（出庫の CandidateRow と同じ配置）
  //  - 1行目：商品情報（SKU/JAN までここに出す）
  //  - 2行目：左に在庫、右に「数量ボタン + ＋」
  // =========================
  const InboundCandidateRow = ({ c, idx }) => {
    const vid = String(c?.variantId || "").trim();
    if (!vid) return null;

    const productTitle = String(c?.productTitle || "").trim();
    const variantTitle = String(c?.variantTitle || "").trim();
    const sku = String(c?.sku || "").trim();
    const barcode = String(c?.barcode || "").trim();

    // 1段目の3行目（SKU/JAN をここに寄せる）
    const skuLine = `${sku ? `SKU: ${sku}` : ""}${barcode ? `${sku ? " / " : ""}JAN: ${barcode}` : ""}`.trim();

    const shownQty = Math.max(0, Number(addQtyById[vid] || 0));
    const [text, setText] = useState(String(shownQty > 0 ? shownQty : 1));

    useEffect(() => {
      setText(String(shownQty > 0 ? shownQty : 1));
    }, [shownQty]);

    // ✅ 上位だけ在庫をプリフェッチ
    useEffect(() => {
      // state を使って再描画が走るための参照（preact対策）
      void inbCandidateStockVersion;

      if (idx < CANDIDATE_STOCK_PREFETCH_LIMIT) {
        ensureInbCandidateStock(vid, vid);
      }
    }, [idx, vid, ensureInbCandidateStock, inbCandidateStockVersion]);

    const stock = getInbCandidateStock(vid);
    const stockText =
      stock?.loading ? "在庫: …" : `在庫: ${Number.isFinite(Number(stock?.available)) ? Number(stock.available) : "—"}`;

    const modalId = toSafeId(`INB_CAND_QTY_${vid}`);

    const clampAdd = (s) => {
      const x = Number(String(s || "").replace(/[^\d]/g, ""));
      if (!Number.isFinite(x)) return 1;
      return Math.max(1, Math.min(999999, Math.floor(x)));
    };

    // addOrIncrementByResolved が期待する形に揃える
    const resolved = {
      variantId: vid,
      inventoryItemId: c?.inventoryItemId,
      productTitle,
      variantTitle,
      sku,
      barcode,
      imageUrl: c?.imageUrl || "",
    };

    // 次回の初期値として保持（出庫の挙動に寄せる）
    const commitAddByQty = () => {
      const next = clampAdd(text);

      addOrIncrementByResolved(resolved, next, { toastOnExtra: true });

      // ✅ 出庫と同じ：右の数字ボタンは累積で増やす
      setAddQtyById((prev) => {
        const cur = Number(prev?.[vid] || 0);
        return { ...prev, [vid]: cur + next };
      });
    };

    const addOne = () => {
      addOrIncrementByResolved(resolved, 1, { toastOnExtra: true });

      // ✅ 出庫と同じ：右の数字ボタンも増やす
      setAddQtyById((prev) => {
        const cur = Number(prev?.[vid] || 0);
        return { ...prev, [vid]: cur + 1 };
      });
    };

    return (
    <s-box padding="none">
        <StockyRowShell key={vid}>
          <s-stack gap="extra-tight">
            {/* 1行目：商品情報（SKU/JAN を line3 に） */}
            <s-box style={{ width: "100%" }}>
              <ItemLeftCompact
                showImages={showImages && !liteMode}
                imageUrl={c?.imageUrl || ""}
                productTitle={productTitle || "(no title)"}
                variantTitle={variantTitle}
                line3={skuLine}
              />
            </s-box>

            {/* 2行目：左に在庫、右に「数量 + ＋」 */}
            <s-box inlineSize="100%">
              <s-stack
                direction="inline"
                gap="base"
                justifyContent="space-between"
                alignItems="center"
                style={{ width: "100%", flexWrap: "nowrap" }}
              >
                <s-box style={{ flex: "1 1 auto", minWidth: 0 }}>
                  <s-text tone="subdued" size="small" style={{ whiteSpace: "nowrap" }}>
                    {stockText}
                  </s-text>
                </s-box>

                <s-box style={{ flex: "0 0 auto" }}>
                  {(() => {
                    const valueWidth = calcQtyWidthPx_(shownQty);
                    const plusWidth = 44;

                    return (
                      <s-stack
                        direction="inline"
                        gap="extra-tight"
                        alignItems="center"
                        justifyContent="end"
                        style={{ flexWrap: "nowrap", whiteSpace: "nowrap" }}
                      >
                        <s-box inlineSize={`${valueWidth}px`}>
                          <s-button
                            command="--show"
                            commandFor={modalId}
                            onClick={() => setText(String(shownQty > 0 ? shownQty : 1))}
                            style={{ width: "100%", whiteSpace: "nowrap" }}
                          >
                            {shownQty}
                          </s-button>
                        </s-box>

                        <s-box inlineSize={`${plusWidth}px`}>
                          <s-button
                            tone="success"
                            onClick={addOne}
                            onPress={addOne}
                            style={{ width: "100%", whiteSpace: "nowrap" }}
                          >
                            +
                          </s-button>
                        </s-box>
                      </s-stack>
                    );
                  })()}
                </s-box>
              </s-stack>
            </s-box>
          </s-stack>

          {/* 数量入力モーダル */}
          <s-modal id={modalId} heading="数量を指定して追加">
            <s-box padding="base">
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
              </s-stack>
            </s-box>

            <s-button slot="secondary-actions" command="--hide" commandFor={modalId}>
              キャンセル
            </s-button>

            <s-button
              slot="primary-action"
              tone="success"
              command="--hide"
              commandFor={modalId}
              onClick={commitAddByQty}
              onPress={commitAddByQty}
            >
              追加
            </s-button>
          </s-modal>
        </StockyRowShell>
        <s-divider />
      </s-box>
    );
  };

  const warningAreaNode = !hasWarning ? null : (
    <s-stack gap="small">
      <s-text tone="critical" emphasis="bold">
        予定差異があります（予定外/超過/不足）
      </s-text>

      <s-text-field
        label="メモ（任意）"
        placeholder="例: 発注数誤り / 同梱漏れで追加到着 / 破損 など"
        value={String(note || "")}
        onInput={(v) => setNote(readValue(v))}
        onChange={(v) => setNote(readValue(v))}
      />

      <s-divider />

      <s-stack gap="small" alignItems="center" justifyContent="start">
        <s-button tone={ackWarning ? "success" : "critical"} onClick={() => setAckWarning((x) => !x)}>
          {ackWarning ? "OK" : "内容を確認しました（必須）"}
        </s-button>

        <s-text tone="subdued" size="small">
          ※ チェックがONでないと「確定」できません
        </s-text>
      </s-stack>
    </s-stack>
  );

  if (!selectedShipmentId) {
    return (
      <s-box padding="base">
        <s-stack gap="base">
          <s-text tone="subdued">Shipment が未選択です。前の画面で選択してください。</s-text>

          <s-divider />

          <s-button onClick={refreshPending} disabled={pendingLoading}>
            {pendingLoading ? "取得中..." : "入庫予定一覧を更新（任意）"}
          </s-button>

          {pendingTransfers.length > 0 ? (
            <s-stack gap="base">
              <s-text emphasis="bold">入庫予定（Transfer）</s-text>
              {pendingTransfers.slice(0, 8).map((t) => (
                <s-text key={t.id} tone="subdued" size="small">
                  ・{t.name ? `${t.name} / ` : ""}{String(t.id).slice(-12)}（{t.status ?? "-"}）
                </s-text>
              ))}
              {pendingTransfers.length > 8 ? (
                <s-text tone="subdued" size="small">…他 {pendingTransfers.length - 8} 件</s-text>
              ) : null}
            </s-stack>
          ) : null}
        </s-stack>
      </s-box>
    );
  }

  return (
    <s-stack gap="base">
      {/* ✅ 検索結果（出庫式の候補リスト：全件表示 / 最大50件） */}
      {String(addQuery || "").trim().length >= 1 ? (
        <s-box padding="base">
          <s-stack gap="extra-tight">
            <s-text size="small" tone="subdued">
              検索リスト 候補： {addLoading ? "..." : addCandidates.length}件
            </s-text>

            {addCandidates.length > 0 ? (
              <>
                {addCandidates.slice(0, addCandidatesDisplayLimit).map((c, idx) => {
                  const stableKey = String(
                    c?.variantId ||
                      c?.inventoryItemId ||
                      c?.sku ||
                      c?.barcode ||
                      `${c?.productTitle}__${c?.variantTitle}`
                  );
                  return <InboundCandidateRow key={stableKey} c={c} idx={idx} />;
                })}
                
                {/* ✅ 「さらに表示」ボタン */}
                {addCandidates.length > addCandidatesDisplayLimit ? (
                  <s-box padding="small">
                    <s-button kind="secondary" onClick={handleShowMoreAddCandidates} onPress={handleShowMoreAddCandidates}>
                      さらに表示（残り {addCandidates.length - addCandidatesDisplayLimit}件）
                    </s-button>
                  </s-box>
                ) : null}
              </>
            ) : addLoading ? (
              <s-text tone="subdued" size="small">
                検索中...
              </s-text>
            ) : (
              <s-text tone="subdued" size="small">
                該当なし
              </s-text>
            )}
          </s-stack>
        </s-box>
      ) : null}

      {shipment ? (
        <s-box key="shipment_list" padding="small">
          <s-stack gap="small">
            <s-text emphasis="bold">入庫リスト</s-text>
            {renderInboundShipmentItems_({ rows: visibleRows, showImages, dialog, setRowQty })}
          </s-stack>
        </s-box>
      ) : (
        <s-box padding="base">
          <s-text tone="subdued">Shipmentを読み込むと、ここに明細が出ます</s-text>
        </s-box>
      )}

      {/* ✅ 入庫：確定 confirm（出庫と同じ commandFor 方式 / 二重定義しない） */}
      <s-modal id={CONFIRM_RECEIVE_MODAL_ID} heading="入庫を確定しますか？">
          <s-box
            padding="none"
            style={{ paddingInline: 8, paddingBlock: 8, maxHeight: "60vh", overflowY: "auto" }}
          >
          <s-stack gap="small">
            {/* ✅ 残したいサマリー */}
            <s-stack gap="extra-tight">
              <s-text size="small" tone="subdued">
                予定 {plannedTotal} / 受領 {receiveTotal}
              </s-text>

              <s-text size="small" tone="subdued">
                予定外 {extrasQtyTotal} / 超過 {overQtyTotal} / 不足 {shortageQtyTotal}
              </s-text>

              {hasWarning ? (
                <s-text size="small" tone="critical">
                  ※ 予定外/超過/不足 があります。
                </s-text>
              ) : null}
            </s-stack>

            {/* ✅ 明細（不足/予定外/超過の件数＋行） */}
            {shortageRows.length > 0 ? (
              <s-stack gap="extra-tight">
                <s-text size="small" tone="critical">
                  不足（{shortageRows.length}件）
                </s-text>

                {shortageRows.slice(0, DIFF_PREVIEW_LIMIT).map((x) => (
                  <s-text key={x.shipmentLineItemId} size="small" tone="subdued" style={oneLineStyle}>
                    ・{x.title}：-{Number(x.shortageQty || 0)}
                  </s-text>
                ))}

              {shortageRows.length > DIFF_PREVIEW_LIMIT ? (
                <s-text size="small" tone="subdued">
                  …他 {shortageRows.length - DIFF_PREVIEW_LIMIT} 件
                </s-text>
              ) : null}
              </s-stack>
            ) : null}

            {extras.length > 0 ? (
              <s-stack gap="extra-tight">
                <s-text size="small" tone="critical">
                  予定外（{extras.length}件）
                </s-text>

                {extras.slice(0, DIFF_PREVIEW_LIMIT).map((x) => (
                  <s-text key={x.shipmentLineItemId} size="small" tone="subdued" style={oneLineStyle}>
                    ・{x.title || x.sku || x.inventoryItemId || "(unknown)"}：{Number(x.receiveQty || 0)}
                  </s-text>
                ))}

                {extras.length > DIFF_PREVIEW_LIMIT ? (
                  <s-text size="small" tone="subdued">
                    …他 {extras.length - DIFF_PREVIEW_LIMIT} 件
                  </s-text>
                ) : null}
              </s-stack>
            ) : null}

            {overRows.length > 0 ? (
              <s-stack gap="extra-tight">
                <s-text size="small" tone="critical">
                  超過（{overRows.length}件）
                </s-text>

                {overRows.slice(0, DIFF_PREVIEW_LIMIT).map((x) => (
                  <s-text key={x.shipmentLineItemId} size="small" tone="subdued" style={oneLineStyle}>
                    ・{x.title}：+{Number(x.overQty || 0)}
                  </s-text>
                ))}

                {overRows.length > DIFF_PREVIEW_LIMIT ? (
                  <s-text size="small" tone="subdued">
                    …他 {overRows.length - DIFF_PREVIEW_LIMIT} 件
                  </s-text>
              ) : null}
              </s-stack>
            ) : null}

            {/* ✅ 入力UI（集約） */}
            {hasWarning ? (
              <>
                <s-divider />
                {warningAreaNode}
              </>
            ) : null}
          </s-stack>
        </s-box>

        <s-button slot="secondary-actions" command="--hide" commandFor={CONFIRM_RECEIVE_MODAL_ID}>
          キャンセル
        </s-button>

        <s-button
          slot="secondary-actions"
          tone={hasWarning ? "critical" : "success"}
          disabled={!canConfirm || !warningReady || receiveSubmitting}
          onClick={async () => {
            const ok = await receiveConfirm({ finalize: false });
            if (ok) hideReceiveConfirmRef.current?.click?.();
          }}
          onPress={async () => {
            const ok = await receiveConfirm({ finalize: false });
            if (ok) hideReceiveConfirmRef.current?.click?.();
          }}
        >
          一部受領（一時保存）
        </s-button>

        <s-button
          slot="primary-action"
          tone={hasWarning ? "critical" : "success"}
          disabled={!canConfirm || !warningReady || receiveSubmitting}
          onClick={async () => {
            const ok = await receiveConfirm({ finalize: true });
            if (ok) hideReceiveConfirmRef.current?.click?.();
          }}
          onPress={async () => {
            const ok = await receiveConfirm({ finalize: true });
            if (ok) hideReceiveConfirmRef.current?.click?.();
          }}
        >
          確定する
        </s-button>
      </s-modal>

      {shipment ? (
        <s-box key="extras_area" padding="base">
          <s-stack gap="base">
            <s-stack direction="inline" gap="base" justifyContent="space-between" alignItems="center">
              <s-text emphasis="bold">予定外入荷（リストにない商品）</s-text>
            </s-stack>

            {renderExtras_()}

            <s-divider />
          </s-stack>
        </s-box>
      ) : null}
    </s-stack>
  );
}

/* =========================
   ✅ InboundAddedLineRow（2行構成：SKUは上段、予定/受領は下段左）
========================= */
function InboundAddedLineRow({
  row,
  showImages,
  dialog,
  qty,
  modalKey,
  skuLine,
  bottomLeft,
  bottomLeftTone,
  onDec,
  onInc,
  onSetQty,
  onRemove,
  minQty,
}) {
  const rawLabel = String(row?.label || row?.title || "").trim();
  const parts = rawLabel ? rawLabel.split("/").map((s) => s.trim()).filter(Boolean) : [];

  const productTitle = String(row?.productTitle || "").trim() || parts[0] || rawLabel || "(unknown)";
  const variantTitle =
    String(row?.variantTitle || "").trim() || (parts.length >= 2 ? parts.slice(1).join(" / ") : "");

  const q = Math.max(0, Number(qty ?? row?.qty ?? 0));

  const keyBase =
    modalKey ||
    row?.key ||
    row?.shipmentLineItemId ||
    row?.inventoryItemId ||
    row?.variantId ||
    rawLabel ||
    "row";

  const modalId = `qty-in-${toSafeId(keyBase)}`;

  return (
    <s-box padding="none">
      <StockyRowShell>
        <s-stack gap="extra-tight" inlineSize="100%">
          {/* 上段：情報（画像＋商品名＋オプション＋SKU） */}
          <s-box inlineSize="100%">
            <ItemLeftCompact
              showImages={showImages}
              imageUrl={row?.imageUrl || ""}
              productTitle={productTitle}
              variantTitle={variantTitle}
              line3={String(skuLine || "").trim()}
            />
          </s-box>

          {/* 下段：左=予定/受領（or予定外）、右=数量ボタン */}
          <s-box inlineSize="100%">
            <s-stack
              direction="inline"
              gap="base"
              alignItems="center"
              justifyContent="space-between"
              style={{ width: "100%", flexWrap: "nowrap" }}
            >
              <s-box style={{ flex: "1 1 auto", minWidth: 0 }}>
                <s-text
                  tone={bottomLeftTone === "critical" ? "critical" : "subdued"}
                  size="small"
                  style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                >
                  {String(bottomLeft || "").trim() || " "}
                </s-text>
              </s-box>

              <s-box style={{ flex: "0 0 auto" }}>
                <QtyControlCompact_3Buttons
                  value={q}
                  min={Number.isFinite(Number(minQty)) ? Number(minQty) : 0}
                  modalId={modalId}
                  onDec={onDec}
                  onInc={onInc}
                  onSetQty={onSetQty}
                  onRemove={typeof onRemove === "function" ? onRemove : null}
                />
              </s-box>
            </s-stack>
          </s-box>
        </s-stack>
      </StockyRowShell>
      <s-divider />
    </s-box>
  );
}

/* =========================
   Search / Inventory (Outbound+Inbound)
========================= */

// ✅ 大規模カタログ対策：短いフリーテキスト検索を抑制して固まりを回避
function buildVariantSearchQuery(raw) {
  const q = String(raw || "").trim();
  if (!q) return "";

  const isDigitsOnly = /^\d+$/.test(q);
  const hasAlpha = /[A-Za-z]/.test(q);
  const hasSkuLikeSymbol = /[-_./]/.test(q);
  const hasCJK = /[\u3040-\u30ff\u3400-\u9fff]/.test(q);

  const parts = [];

  // ✅ 1文字から検索可能に変更
  // バーコード検索：数字のみの場合（1文字以上）
  if (isDigitsOnly) {
    // 8桁以上なら barcode 検索、それ以下は通常検索
    if (q.length >= 8) {
      parts.push(`barcode:${q}`);
    } else {
      parts.push(q); // 短い数字も通常検索に含める
    }
  }

  // SKU検索：英字や記号が含まれる場合（1文字以上）
  if (hasAlpha || hasSkuLikeSymbol) {
    parts.push(`sku:${q}`);
  }

  // フリーテキスト検索：1文字から検索可能
  parts.push(q);

  // 重複を除去して結合
  const uniq = Array.from(new Set(parts));
  return uniq.join(" OR ");
}

async function searchVariants(q, opts = {}) {
  const includeImages = opts?.includeImages !== false;

  const firstRaw = Number(opts?.first ?? opts?.limit ?? 50);
  const first = Math.max(10, Math.min(50, Number.isFinite(firstRaw) ? firstRaw : 50));

  const query = buildVariantSearchQuery(q);
  if (!query) return []; // ✅ ここで止めることで「1文字入力で固まる」を回避

  // 画像不要なら最初から軽量クエリへ
  if (!includeImages) {
    const requestBody = {
      query: `#graphql
        query GetVariants($first: Int!, $query: String!) {
          productVariants(first: $first, query: $query) {
            nodes {
              id
              title
              sku
              barcode
              inventoryItem { id }
              product { title }
            }
          }
        }`,
      variables: { first, query },
    };

    const res = await fetch("shopify:admin/api/graphql.json", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    const json = await res.json();
    if (json.errors?.length) throw new Error(JSON.stringify(json.errors));
    const nodes = json?.data?.productVariants?.nodes ?? [];

    return nodes.map((n) => ({
      variantId: n.id,
      inventoryItemId: n.inventoryItem?.id,
      productTitle: n.product?.title ?? "",
      variantTitle: n.title ?? "",
      sku: n.sku ?? "",
      barcode: n.barcode ?? "",
      imageUrl: "",
    }));
  }

  // 画像あり（試す→ダメならフォールバック）
  try {
    const requestBody = {
      query: `#graphql
        query GetVariants($first: Int!, $query: String!) {
          productVariants(first: $first, query: $query) {
            nodes {
              id
              title
              sku
              barcode
              image { url }
              inventoryItem { id }
              product {
                title
                featuredImage { url }
              }
            }
          }
        }`,
      variables: { first, query },
    };

    const res = await fetch("shopify:admin/api/graphql.json", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    const json = await res.json();
    if (json.errors?.length) throw new Error(JSON.stringify(json.errors));
    const nodes = json?.data?.productVariants?.nodes ?? [];

    return nodes.map((n) => ({
      variantId: n.id,
      inventoryItemId: n.inventoryItem?.id,
      productTitle: n.product?.title ?? "",
      variantTitle: n.title ?? "",
      sku: n.sku ?? "",
      barcode: n.barcode ?? "",
      imageUrl: n.image?.url ?? n.product?.featuredImage?.url ?? "",
    }));
  } catch (e) {
    // （既存フォールバックがこの後に続くなら、そのまま残してOK）
    throw e;
  }
}

function CandidateRow({
  showImages,
  candidate,
  stockText,
  qtyControl,
  onAdd,
}) {
  const title = candidate?.title || "";
  const option = candidate?.option || "";
  const sku = candidate?.sku || "";

  return (
    <s-box padding="base">
      <s-stack gap="none">
        {/* 1行目 */}
        <s-stack direction="inline" gap="base" alignItems="center">
          {showImages ? (
            <s-image source={candidate?.imageUrl} alt={title} />
          ) : null}

          <s-stack gap="none" inlineSize="fill">
            <s-text emphasis="bold" truncate>
              {title}
            </s-text>

            {option ? (
              <s-text tone="subdued" size="small" truncate>
                {option}
              </s-text>
            ) : null}

            {sku ? (
              <s-text tone="subdued" size="small" truncate>
                SKU: {sku}
              </s-text>
            ) : null}
          </s-stack>
        </s-stack>

        {/* 2行目（左=在庫 / 右=数量UI） */}
        <s-box inlineSize="100%">
          <s-stack direction="inline" justifyContent="space-between" alignItems="center">
            <s-text tone="subdued" size="small">
              {stockText || "在庫: -"}
            </s-text>

            <s-box>
              {qtyControl}
            </s-box>
          </s-stack>
        </s-box>
      </s-stack>
    </s-box>
  );
}

async function fetchVariantAvailable({ variantGid, locationGid }) {
  const query = `#graphql
    query VariantInv($variantId: ID!, $locationId: ID!) {
      productVariant(id: $variantId) {
        inventoryItem {
          id
          inventoryLevel(locationId: $locationId) {
            quantities(names: ["available"]) { name quantity }
          }
        }
      }
    }`;
  const data = await adminGraphql(query, { variantId: variantGid, locationId: locationGid });
  const level = data?.productVariant?.inventoryItem?.inventoryLevel;
  const available = level?.quantities?.find((x) => x.name === "available")?.quantity ?? null;
  return { inventoryItemId: data?.productVariant?.inventoryItem?.id, available };
}

/* =========================
   Ensure destination has inventory levels (Outbound/Inbound extras)
========================= */

// ✅ inventoryActivate を “必要なときだけ available 付き” で呼べるようにする
async function ensureInventoryActivatedAtLocation({
  locationId,
  inventoryItemIds,
  initialAvailableByInventoryItemId = null,
  debug,
}) {
  const activated = [];
  const errors = [];

  if (!locationId || !Array.isArray(inventoryItemIds) || inventoryItemIds.length === 0) {
    return { ok: true, activated, errors };
  }

  for (const inventoryItemIdRaw of inventoryItemIds) {
    const inventoryItemId = String(inventoryItemIdRaw || "").trim();
    if (!inventoryItemId) continue;

    // ✅ 出庫元 missing のときだけ「初期数量」を入れたい（渡されていれば使う）
    let initialQty = null;
    if (
      initialAvailableByInventoryItemId &&
      Object.prototype.hasOwnProperty.call(initialAvailableByInventoryItemId, inventoryItemId)
    ) {
      const n = Number(initialAvailableByInventoryItemId[inventoryItemId]);
      if (Number.isFinite(n)) initialQty = Math.max(0, Math.floor(n));
    }

    try {
      const variables = { inventoryItemId, locationId };

      // ✅ Shopify公式：inventoryActivate は available/onHand を渡せる。
      //    渡さないと 0 扱いになりやすいので、初期数量を入れる場合は両方そろえる。
      if (initialQty !== null) {
        variables.available = initialQty;
        variables.onHand = initialQty;
      }

      const data = await adminGraphql(
        `#graphql
          mutation ActivateInventoryItem(
            $inventoryItemId: ID!
            $locationId: ID!
            $available: Int
            $onHand: Int
          ) {
            inventoryActivate(
              inventoryItemId: $inventoryItemId
              locationId: $locationId
              available: $available
              onHand: $onHand
            ) {
              inventoryLevel { id }
              userErrors { field message }
            }
          }
        `,
        variables
      );

      const payload = data?.inventoryActivate;
      const userErrors = payload?.userErrors;

      if (Array.isArray(userErrors) && userErrors.length > 0) {
        errors.push({
          inventoryItemId,
          message:
            userErrors
              .map((e) => String(e?.message || "").trim())
              .filter(Boolean)
              .join(" / ") || "unknown user error",
        });
        continue;
      }

      if (payload?.inventoryLevel?.id) {
        activated.push({ inventoryItemId, locationId, initialQty });
      }
    } catch (e) {
      errors.push({ inventoryItemId, message: toUserMessage(e) });
    }
  }

  return { ok: errors.length === 0, activated, errors };
}

async function inventoryTransferDuplicateSafe({ id }) {
  if (!id) throw new Error("inventoryTransferDuplicateSafe: id is required");

  const q = `
    mutation InventoryTransferDuplicate($id: ID!) {
      inventoryTransferDuplicate(id: $id) {
        inventoryTransfer {
          id
          name
          status
        }
        userErrors { field message }
      }
    }
  `;

  const res = await adminGraphql(q, { id });
  assertNoUserErrors(res?.inventoryTransferDuplicate?.userErrors);
  return res?.inventoryTransferDuplicate?.inventoryTransfer || null;
}

async function inventoryTransferCancelSafe({ id }) {
  if (!id) return null;

  const res = await adminGraphql(
    `mutation inventoryTransferCancel($id: ID!) {
      inventoryTransferCancel(id: $id) {
        inventoryTransfer { id status }
        userErrors { field message }
      }
    }`,
    { id }
  );

  assertNoUserErrors(res?.inventoryTransferCancel?.userErrors);
  return res?.inventoryTransferCancel?.inventoryTransfer || null;
}

async function fetchInventoryTransferDetailForHistory({ id, signal }) {
  if (!id) throw new Error("fetchInventoryTransferDetailForHistory: id is required");

  const q = `
    query InventoryTransferForHistory($id: ID!) {
      inventoryTransfer(id: $id) {
        id
        name
        status
        dateCreated
        totalQuantity
        receivedQuantity

        origin { name location { id name } }
        destination { name location { id name } }

        shipments(first: 10) {
          nodes { id status }
        }

        lineItems(first: 250) {
          nodes {
            id
            title
            shippableQuantity
            shippedQuantity
            processableQuantity
            inventoryItem { id sku }
          }
        }
      }
    }
  `;

  const res = await adminGraphql(q, { id }, { signal });
  const t = res?.inventoryTransfer;
  if (!t) return null;

  const shipmentNodes = Array.isArray(t?.shipments?.nodes) ? t.shipments.nodes : [];
  const lineNodes = Array.isArray(t?.lineItems?.nodes) ? t.lineItems.nodes : [];

  return {
    id: String(t.id || ""),
    name: String(t.name || ""),
    status: String(t.status || ""),
    dateCreated: String(t.dateCreated || ""),
    totalQuantity: Number(t.totalQuantity ?? 0),
    receivedQuantity: Number(t.receivedQuantity ?? 0),

    originName: String(t?.origin?.name || ""),
    originLocationId: String(t?.origin?.location?.id || ""),
    destinationName: String(t?.destination?.name || ""),
    destinationLocationId: String(t?.destination?.location?.id || ""),

    shipments: shipmentNodes.map((s) => ({ id: String(s.id || ""), status: String(s.status || "") })),
    lineItems: lineNodes.map((li) => ({
      id: String(li.id || ""),
      title: String(li.title || ""),
      shippableQuantity: Number(li.shippableQuantity ?? 0),
      shippedQuantity: Number(li.shippedQuantity ?? 0),
      processableQuantity: Number(li.processableQuantity ?? 0),
      inventoryItemId: String(li?.inventoryItem?.id || ""),
      sku: String(li?.inventoryItem?.sku || ""),
    })),
  };
}

/* =========================
   Inventory Transfer / Shipment (Outbound)
========================= */

async function inventoryTransferCreateAsReadyToShip({ originLocationId, destinationLocationId, lineItems, lineItemsMeta }) {
  const mutation = `#graphql
    mutation CreateTransferReady($input: InventoryTransferCreateAsReadyToShipInput!) {
      inventoryTransferCreateAsReadyToShip(input: $input) {
        inventoryTransfer { id status }
        userErrors { field message }
      }
    }`;

  const data = await adminGraphql(mutation, { input: { originLocationId, destinationLocationId, lineItems } });

  assertNoUserErrors(data?.inventoryTransferCreateAsReadyToShip, "inventoryTransferCreateAsReadyToShip", lineItemsMeta);
  return data.inventoryTransferCreateAsReadyToShip.inventoryTransfer;
}

async function inventoryTransferCreateDraft({ originLocationId, destinationLocationId, lineItems, lineItemsMeta }) {
  const mutation = `#graphql
    mutation CreateTransfer($input: InventoryTransferCreateInput!) {
      inventoryTransferCreate(input: $input) {
        inventoryTransfer { id status }
        userErrors { field message }
      }
    }`;
  const data = await adminGraphql(mutation, { input: { originLocationId, destinationLocationId, lineItems } });
  assertNoUserErrors(data?.inventoryTransferCreate, "inventoryTransferCreate", lineItemsMeta);
  return data.inventoryTransferCreate.inventoryTransfer;
}

async function inventoryTransferMarkAsReadyToShip(transferId) {
  const mutation = `#graphql
    mutation Ready($id: ID!) {
      inventoryTransferMarkAsReadyToShip(id: $id) {
        inventoryTransfer { id status }
        userErrors { field message }
      }
    }`;
  const data = await adminGraphql(mutation, { id: transferId });
  assertNoUserErrors(data?.inventoryTransferMarkAsReadyToShip, "inventoryTransferMarkAsReadyToShip");
  return data.inventoryTransferMarkAsReadyToShip.inventoryTransfer;
}

async function createTransferReadyToShipWithFallback({ originLocationId, destinationLocationId, lineItems, lineItemsMeta }) {
  try {
    return await inventoryTransferCreateAsReadyToShip({ originLocationId, destinationLocationId, lineItems, lineItemsMeta });
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (msg.includes("inventoryTransferCreateAsReadyToShip") || msg.includes("Field") || msg.includes("undefined")) {
      const draft = await inventoryTransferCreateDraft({ originLocationId, destinationLocationId, lineItems, lineItemsMeta });
      return await inventoryTransferMarkAsReadyToShip(draft.id);
    }
    throw e;
  }
}

async function createInventoryShipmentInTransit({ movementId, lineItems, trackingInput, lineItemsMeta }) {
  const mutation = `#graphql
    mutation CreateInTransit($input: InventoryShipmentCreateInput!) {
      inventoryShipmentCreateInTransit(input: $input) {
        inventoryShipment {
          id
          status
          tracking { trackingNumber company trackingUrl arrivesAt }
        }
        userErrors { field message }
      }
    }`;

  const cleanTracking = {};
  if (trackingInput?.trackingNumber) cleanTracking.trackingNumber = trackingInput.trackingNumber;
  if (trackingInput?.company) cleanTracking.company = trackingInput.company;
  if (trackingInput?.trackingUrl) cleanTracking.trackingUrl = trackingInput.trackingUrl;
  if (trackingInput?.arrivesAt) cleanTracking.arrivesAt = trackingInput.arrivesAt;

  const data = await adminGraphql(mutation, {
    input: {
      movementId,
      lineItems,
      trackingInput: Object.keys(cleanTracking).length ? cleanTracking : null,
    },
  });

  assertNoUserErrors(data?.inventoryShipmentCreateInTransit, "inventoryShipmentCreateInTransit", lineItemsMeta);
  return data.inventoryShipmentCreateInTransit.inventoryShipment;
}

async function fetchTransfer(id) {
  const query = `#graphql
    query GetTransfer($id: ID!) {
      inventoryTransfer(id: $id) { id status }
    }`;
  const data = await adminGraphql(query, { id });
  return data?.inventoryTransfer ?? null;
}

/* =========================
   Transfer から直接 lineItems を取得（下書き状態対応）
========================= */
async function fetchTransferLineItemsEnriched(transferId, opts = {}) {
  const includeImages = opts?.includeImages !== false;
  const signal = opts?.signal || null;

  const id = String(transferId || "").trim();
  if (!id) throw new Error("Transfer ID が空です");

  if (includeImages) {
    try {
      const qImg = `#graphql
        query GetTransferEnrichedWithImages($id: ID!) {
          inventoryTransfer(id: $id) {
            id
            status
            lineItems(first: 250) {
              nodes {
                id
                inventoryItem {
                  id
                  variant {
                    id
                    sku
                    barcode
                    title
                    image { url }
                    product {
                      title
                      featuredImage { url }
                    }
                  }
                }
              }
            }
          }
        }`;

      const d1 = await adminGraphql(qImg, { id }, { signal });
      const t = d1?.inventoryTransfer;
      if (!t || !t?.id) throw new Error("Transfer が見つかりませんでした");

      const lineItems = (t.lineItems?.nodes ?? []).map((li) => {
        const v = li.inventoryItem?.variant;

        const productTitle = String(v?.product?.title || "").trim();
        const variantTitle = String(v?.title || "").trim();

        // ✅ 画像URL取得：variant.image → product.featuredImage の順で取得
        const variantImageUrl = v?.image?.url ?? null;
        const productImageUrl = v?.product?.featuredImage?.url ?? null;
        const imageUrl = String(variantImageUrl ?? productImageUrl ?? "").trim();

        // ✅ inventoryTransfer.lineItemsには数量フィールドが存在しないため、0を設定
        const quantity = 0;

        return {
          id: li.id,
          quantity,
          inventoryItemId: li.inventoryItem?.id ?? null,
          variantId: v?.id ?? null,
          sku: v?.sku ?? "",
          barcode: v?.barcode ?? "",
          productTitle,
          variantTitle,
          title: productTitle && variantTitle ? `${productTitle} / ${variantTitle}` : (variantTitle || productTitle || v?.sku || li.inventoryItem?.id || "(unknown)"),
          imageUrl,
        };
      });

      return lineItems;
    } catch (e) {
      const msg = String(e?.message ?? e ?? "不明なエラー");
      // ✅ 画像フィールドが存在しないエラーの場合のみフォールバック
      if (/doesn\\'t exist|Field .* doesn't exist|undefined/i.test(msg)) {
        console.warn("Transfer画像取得に失敗しました（フォールバック処理に進みます）:", msg);
      } else {
        throw e;
      }
    }
  }

  try {
    const qNoImg = `#graphql
      query GetTransferEnrichedNoImages($id: ID!) {
        inventoryTransfer(id: $id) {
          id
          status
          lineItems(first: 250) {
            nodes {
              id
              inventoryItem {
                id
                variant {
                  id
                  sku
                  barcode
                  title
                  product { title }
                }
              }
            }
          }
        }
      }`;

    const d2 = await adminGraphql(qNoImg, { id }, { signal });
    const t2 = d2?.inventoryTransfer;
    if (!t2 || !t2?.id) throw new Error("Transfer が見つかりませんでした");

    const lineItems = (t2.lineItems?.nodes ?? []).map((li) => {
      const v = li.inventoryItem?.variant;

      const productTitle = String(v?.product?.title || "").trim();
      const variantTitle = String(v?.title || "").trim();

      // ✅ inventoryTransfer.lineItemsには数量フィールドが存在しないため、0を設定
      const quantity = 0;

      return {
        id: li.id,
        quantity,
        inventoryItemId: li.inventoryItem?.id ?? null,
        variantId: v?.id ?? null,
        sku: v?.sku ?? "",
        barcode: v?.barcode ?? "",
        productTitle,
        variantTitle,
        title: productTitle && variantTitle ? `${productTitle} / ${variantTitle}` : (variantTitle || productTitle || v?.sku || li.inventoryItem?.id || "(unknown)"),
        imageUrl: "",
      };
    });

    return lineItems;
  } catch (e) {
    const msg = String(e?.message ?? e ?? "不明なエラー");
    if (!/doesn\\'t exist|Field .* doesn't exist|undefined/i.test(msg)) {
      throw e;
    }
    console.warn("[fetchTransferLineItemsEnriched] エラー（フォールバック処理に進みます）:", msg);
  }

  // 最小限のフォールバック（数量フィールドは使わない）
  const qMin = `#graphql
    query GetTransferMin($id: ID!) {
      inventoryTransfer(id: $id) {
        id
        status
        lineItems(first: 250) {
          nodes {
            id
            inventoryItem { id }
          }
        }
      }
    }`;

  const d3 = await adminGraphql(qMin, { id }, { signal });
  const t3 = d3?.inventoryTransfer;
  if (!t3 || !t3?.id) throw new Error("Transfer が見つかりませんでした（フォールバック）");

  return (t3.lineItems?.nodes ?? []).map((li) => {
    // ✅ inventoryTransfer.lineItemsには数量フィールドが存在しないため、0を設定
    const quantity = 0;
    
    return {
      id: li.id,
      quantity,
      inventoryItemId: li.inventoryItem?.id ?? null,
      variantId: null,
      sku: "",
      barcode: "",
      productTitle: "",
      variantTitle: "",
      title: li.inventoryItem?.id ?? "(unknown)",
      imageUrl: "",
    };
  });
}

/* =========================
   Inbound APIs
========================= */

/**
 * ✅ 入庫予定一覧（Transfer）: inventoryTransfers を使う
 * ※ query文法差分が出やすいので、GraphQLでは強く絞らず、取得後にJSで確実に絞る実装
 */
async function fetchPendingTransfersForDestination(destinationLocationGid) {
  const query = `#graphql
    query PendingTransfers($first: Int!) {
      inventoryTransfers(first: $first, sortKey: CREATED_AT, reverse: true) {
        nodes {
          id
          name
          status
          dateCreated
          totalQuantity
          receivedQuantity

          origin { name location { id name } }
          destination { name location { id name } }

          shipments(first: 10) {
            nodes {
              id
              status
              tracking { trackingNumber company trackingUrl arrivesAt }
            }
          }
        }
      }
    }`;

  const data = await adminGraphql(query, { first: 50 });
  const nodes = data?.inventoryTransfers?.nodes ?? [];

  const filtered = nodes.filter((t) => {
    const destId = t?.destination?.location?.id;
    if (destinationLocationGid && destId !== destinationLocationGid) return false;

    const total = t?.totalQuantity ?? 0;
    const received = t?.receivedQuantity ?? 0;
    if (total > 0 && received >= total) return false;

    if ((t?.shipments?.nodes ?? []).length === 0) return false;

    return true;
  });

  return filtered.map((t) => ({
    id: t.id,
    name: t.name,
    status: t.status,
    dateCreated: t.dateCreated ?? null,
    originName: t.origin?.name ?? t.origin?.location?.name ?? "",
    destinationName: t.destination?.name ?? t.destination?.location?.name ?? "",
    totalQuantity: t.totalQuantity ?? 0,
    receivedQuantity: t.receivedQuantity ?? 0,
    shipments: (t.shipments?.nodes ?? []).map((s) => ({
      id: s.id,
      status: s.status,
      tracking: s.tracking ?? null,
    })),
  }));
}

async function fetchTransfersForDestinationAll(destinationLocationGid) {
  const query = `#graphql
    query TransfersAll($first: Int!) {
      inventoryTransfers(first: $first, sortKey: CREATED_AT, reverse: true) {
        nodes {
          id
          name
          status
          dateCreated
          totalQuantity
          receivedQuantity
          origin { name location { id name } }
          destination { name location { id name } }
          shipments(first: 10) {
            nodes {
              id
              status
              tracking { trackingNumber company trackingUrl arrivesAt }
            }
          }
        }
      }
    }`;

  const data = await adminGraphql(query, { first: 50 });
  const nodes = data?.inventoryTransfers?.nodes ?? [];

  // destination が取れる時だけ一致判定（現行方針を踏襲）
  const filtered = nodes.filter((t) => {
    const destId = t?.destination?.location?.id;
    if (destinationLocationGid && destId !== destinationLocationGid) return false;
    // 受領操作に進めない Transfer は除外（現行踏襲）
    if ((t?.shipments?.nodes ?? []).length === 0) return false;
    return true;
  });

  return filtered.map((t) => {
    const receivedQuantity = Number(t.receivedQuantity ?? 0);

    return {
      id: t.id,
      name: t.name,
      status: t.status,
      dateCreated: t.dateCreated ?? null,
      originName: t.origin?.name ?? t.origin?.location?.name ?? "",
      destinationName: t.destination?.name ?? t.destination?.location?.name ?? "",
      totalQuantity: t.totalQuantity ?? 0,
      receivedQuantity,

      // ✅ 追加：過剰分（監査ログで後から上書き）
      overQuantity: 0,
      receivedQuantityDisplay: receivedQuantity,

      shipments: (t.shipments?.nodes ?? []).map((s) => ({
        id: s.id,
        status: s.status,
        tracking: s.tracking ?? null,
      })),
    };
  });
}

/**
 * inventoryTransfers を「originLocationGid で」取得（ページング対応）
 * - 可能なら query(origin_id:...) でサーバ側フィルタ（失敗時は fallback）
 * - Inbound と同じ shape の shipments: [{id,status,tracking}] を返す
 * - 互換のため shipmentIds も付与
 * - 無限ループ対策（cursor 重複/停止）
 *
 * 依存: adminGraphql(query, variables)
 */
async function fetchTransfersForOriginAll(originLocationGid, opts = {}) {
  const originId = String(originLocationGid || "").trim();
  if (!originId) return [];

  // POSでフリーズしやすいので、デフォルトは控えめ（必要なら増やせる）
  const first = Math.max(1, Math.min(100, Number(opts.first ?? 50)));
  const maxPages = Math.max(1, Math.min(20, Number(opts.maxPages ?? 8))); // 無限ループ/過剰取得防止
  const maxItems = Math.max(1, Math.min(2000, Number(opts.maxItems ?? 500)));

  const out = [];

  const mapNodeToTransfer = (t) => {
    const oId = String(t?.origin?.location?.id || "").trim();
    const dId = String(t?.destination?.location?.id || "").trim();

    const ships = Array.isArray(t?.shipments?.nodes)
      ? t.shipments.nodes
          .map((s) => ({
            id: String(s?.id || "").trim(),
            status: String(s?.status || ""),
          }))
          .filter((s) => s.id)
      : [];

    return {
      id: String(t?.id || ""),
      name: String(t?.name || ""),
      status: String(t?.status || ""),
      dateCreated: t?.dateCreated || "",
      totalQuantity: Number(t?.totalQuantity ?? 0),
      receivedQuantity: Number(t?.receivedQuantity ?? 0),

      originName: String(t?.origin?.name || t?.origin?.location?.name || ""),
      destinationName: String(t?.destination?.name || t?.destination?.location?.name || ""),

      // ✅ Inboundと完全に同じ形（OutboundHistoryもこれを使う）
      shipments: ships,

      // ✅ 互換用（残してもOK）
      shipmentIds: ships.map((s) => s.id),

      // ✅ UI 絞り込み用（現状の設計維持）
      originLocationId: oId,
      destinationLocationId: dId,
    };
  };

  // A) query が効くストアでは origin_id でサーバ側絞り込み（軽い）
  let after = null;
  const tryQuery = async () => {
    const query = `origin_id:${originId}`;
    for (let page = 0; page < maxPages; page++) {
      const data = await adminGraphql(
        `#graphql
        query TransfersByOrigin($first: Int!, $after: String, $query: String) {
          inventoryTransfers(first: $first, after: $after, sortKey: CREATED_AT, reverse: true, query: $query) {
            nodes {
              id
              name
              status
              dateCreated
              totalQuantity
              receivedQuantity
              origin { name location { id name } }
              destination { name location { id name } }
              shipments(first: 10) { nodes { id status } }
            }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { first, after, query }
      );

      const nodes = data?.inventoryTransfers?.nodes ?? [];
      for (const t of nodes) {
        const mapped = mapNodeToTransfer(t);
        // query が効いていれば一致するはずだが、念のためガード
        if (mapped.originLocationId !== originId) continue;
        out.push(mapped);
        if (out.length >= maxItems) return;
      }

      const pi = data?.inventoryTransfers?.pageInfo;
      if (!pi?.hasNextPage || !pi?.endCursor) break;
      after = pi.endCursor;
    }
  };

  try {
    await tryQuery();
    if (out.length) return out;
  } catch (e) {
    // query が使えない環境もあるので fallback へ
  }

  // B) fallback：query無しで取得 → ローカルで origin 絞り込み（堅実）
  after = null;
  out.length = 0;

  for (let page = 0; page < maxPages; page++) {
    const data = await adminGraphql(
      `#graphql
      query TransfersAll($first: Int!, $after: String) {
        inventoryTransfers(first: $first, after: $after, sortKey: CREATED_AT, reverse: true) {
          nodes {
            id
            name
            status
            dateCreated
            totalQuantity
            receivedQuantity
            origin { name location { id name } }
            destination { name location { id name } }
            shipments(first: 10) { nodes { id status } }
          }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { first, after }
    );

    const nodes = data?.inventoryTransfers?.nodes ?? [];
    for (const t of nodes) {
      const mapped = mapNodeToTransfer(t);
      if (mapped.originLocationId !== originId) continue;
      out.push(mapped);
      if (out.length >= maxItems) return out;
    }

    const pi = data?.inventoryTransfers?.pageInfo;
    if (!pi?.hasNextPage || !pi?.endCursor) break;
    after = pi.endCursor;
  }

  return out;
}

/* =========================
   Shipment fetch (Inbound)
========================= */

async function fetchInventoryShipmentEnriched(id, opts = {}) {
  const includeImages = opts?.includeImages !== false;
  const signal = opts?.signal;

  const shipmentId = String(id || "").trim();
  if (!shipmentId) throw new Error("Shipment ID が空です");

  if (includeImages) {
    try {
      const qImg = `#graphql
        query GetShipmentEnrichedWithImages($id: ID!) {
          inventoryShipment(id: $id) {
            id
            status
            tracking { trackingNumber company trackingUrl arrivesAt }
            lineItems(first: 250) {
              nodes {
                id
                quantity
                acceptedQuantity
                rejectedQuantity
                unreceivedQuantity
                inventoryItem {
                  id
                  variant {
                    id
                    sku
                    barcode
                    title
                    image { url }
                    product {
                      title
                      featuredImage { url }
                    }
                  }
                }
              }
            }
          }
        }`;

      const d1 = await adminGraphql(qImg, { id: shipmentId }, { signal });
      const s = d1?.inventoryShipment;
      if (!s?.id) throw new Error("Shipment が見つかりませんでした");

      const lineItems = (s.lineItems?.nodes ?? []).map((li) => {
        const v = li.inventoryItem?.variant;

        const productTitle = String(v?.product?.title || "").trim();
        const variantTitle = String(v?.title || "").trim();

        const imageUrl = v?.image?.url ?? v?.product?.featuredImage?.url ?? "";

        return {
          id: li.id,
          quantity: Number(li.quantity ?? 0),

          // ✅ 追加：Shopify側の受領/却下/未受領
          acceptedQuantity: Number(li.acceptedQuantity ?? 0),
          rejectedQuantity: Number(li.rejectedQuantity ?? 0),
          unreceivedQuantity: Number(li.unreceivedQuantity ?? 0),

          inventoryItemId: li.inventoryItem?.id ?? null,
          variantId: v?.id ?? null,
          sku: v?.sku ?? "",
          barcode: v?.barcode ?? "",
          productTitle,
          variantTitle,
          // 互換用（他が title を参照しても崩れない）
          title:
            productTitle && variantTitle
              ? `${productTitle} / ${variantTitle}`
              : (variantTitle || productTitle || v?.sku || li.inventoryItem?.id || "(unknown)"),
          imageUrl,
        };
      });

      return {
        id: s.id,
        status: s.status,
        tracking: s.tracking ?? null,
        lineItems,
      };
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (!/doesn\\'t exist|Field .* doesn't exist|undefined/i.test(msg)) throw e;
    }
  }

  try {
    const qNoImg = `#graphql
      query GetShipmentEnrichedNoImages($id: ID!) {
        inventoryShipment(id: $id) {
          id
          status
          tracking { trackingNumber company trackingUrl arrivesAt }
          lineItems(first: 250) {
            nodes {
              id
              quantity
              acceptedQuantity
              rejectedQuantity
              unreceivedQuantity
              inventoryItem {
                id
                variant {
                  id
                  sku
                  barcode
                  title
                  product { title }
                }
              }
            }
          }
        }
      }`;

    const d2 = await adminGraphql(qNoImg, { id: shipmentId }, { signal });
    const s2 = d2?.inventoryShipment;
    if (!s2?.id) throw new Error("Shipment が見つかりませんでした");

    const lineItems = (s2.lineItems?.nodes ?? []).map((li) => {
      const v = li.inventoryItem?.variant;

      const productTitle = String(v?.product?.title || "").trim();
      const variantTitle = String(v?.title || "").trim();

      return {
        id: li.id,
        quantity: Number(li.quantity ?? 0),

        // ✅ 追加：Shopify側の受領/却下/未受領
        acceptedQuantity: Number(li.acceptedQuantity ?? 0),
        rejectedQuantity: Number(li.rejectedQuantity ?? 0),
        unreceivedQuantity: Number(li.unreceivedQuantity ?? 0),

        inventoryItemId: li.inventoryItem?.id ?? null,
        variantId: v?.id ?? null,
        sku: v?.sku ?? "",
        barcode: v?.barcode ?? "",
        productTitle,
        variantTitle,
        title:
          productTitle && variantTitle
            ? `${productTitle} / ${variantTitle}`
            : (variantTitle || productTitle || v?.sku || li.inventoryItem?.id || "(unknown)"),
        imageUrl: "",
      };
    });

    return {
      id: s2.id,
      status: s2.status,
      tracking: s2.tracking ?? null,
      lineItems,
    };
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (!/doesn\\'t exist|Field .* doesn't exist|undefined/i.test(msg)) throw e;
  }

  const qMin = `#graphql
    query GetShipmentMin($id: ID!) {
      inventoryShipment(id: $id) {
        id
        status
        tracking { trackingNumber company trackingUrl arrivesAt }
        lineItems(first: 250) {
          nodes {
            id
            quantity
            inventoryItem { id }
          }
        }
      }
    }`;

  const d3 = await adminGraphql(qMin, { id: shipmentId }, { signal });
  const s3 = d3?.inventoryShipment;
  if (!s3?.id) throw new Error("Shipment が見つかりませんでした");

  return {
    id: s3.id,
    status: s3.status,
    tracking: s3.tracking ?? null,
    lineItems: (s3.lineItems?.nodes ?? []).map((li) => ({
      id: li.id,
      quantity: Number(li.quantity ?? 0),
      inventoryItemId: li.inventoryItem?.id ?? null,
      variantId: null,
      sku: "",
      barcode: "",
      productTitle: "",
      variantTitle: "",
      title: li.inventoryItem?.id ?? "(unknown)",
      imageUrl: "",
    })),
  };
}

/* =========================
   Receive shipment (Inbound)
========================= */

async function receiveShipmentWithFallbackV2({ shipmentId, items }) {
  const clean = (items || [])
    .map((x) => ({
      shipmentLineItemId: x.shipmentLineItemId || x.id || x.lineItemId || null,
      quantity: Number(x.quantity || 0),

      // ✅ 新しめのスキーマでは reason が必須になる場合があるため保険（ACCEPTED / REJECTED）
      reason: String(x.reason || "ACCEPTED").trim().toUpperCase(),
    }))
    .filter((x) => x.shipmentLineItemId && x.quantity > 0);

  if (clean.length === 0) return null;

  // 1) try: inventoryShipmentReceiveItems（古い環境向け）
  try {
    const m1 = `#graphql
      mutation ReceiveItems($id: ID!, $items: [InventoryShipmentReceiveItemInput!]!) {
        inventoryShipmentReceiveItems(id: $id, items: $items) {
          inventoryShipment { id status }
          userErrors { field message }
        }
      }`;
    const d1 = await adminGraphql(m1, { id: shipmentId, items: clean });
    assertNoUserErrors(d1?.inventoryShipmentReceiveItems, "inventoryShipmentReceiveItems");
    return d1?.inventoryShipmentReceiveItems?.inventoryShipment ?? null;
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (!/doesn\\'t exist|Field .* doesn't exist|undefined/i.test(msg)) throw e;
  }

  // 2) fallback: inventoryShipmentReceive（現行スキーマは lineItems）
  try {
    const m2 = `#graphql
      mutation Receive($id: ID!, $lineItems: [InventoryShipmentReceiveItemInput!]!) {
        inventoryShipmentReceive(id: $id, lineItems: $lineItems) {
          inventoryShipment { id status }
          userErrors { field message }
        }
      }`;
    const d2 = await adminGraphql(m2, { id: shipmentId, lineItems: clean });
    assertNoUserErrors(d2?.inventoryShipmentReceive, "inventoryShipmentReceive");
    return d2?.inventoryShipmentReceive?.inventoryShipment ?? null;
  } catch (e) {
    // ✅ もし reason が未対応のAPIバージョンなら、reason無しで再トライ
    const msg = String(e?.message ?? e);
    if (/reason/i.test(msg) && /(not defined by type|Unknown field|invalid)/i.test(msg)) {
      const noReason = clean.map(({ shipmentLineItemId, quantity }) => ({ shipmentLineItemId, quantity }));

      const m2b = `#graphql
        mutation Receive($id: ID!, $lineItems: [InventoryShipmentReceiveItemInput!]!) {
          inventoryShipmentReceive(id: $id, lineItems: $lineItems) {
            inventoryShipment { id status }
            userErrors { field message }
          }
        }`;
      const d2b = await adminGraphql(m2b, { id: shipmentId, lineItems: noReason });
      assertNoUserErrors(d2b?.inventoryShipmentReceive, "inventoryShipmentReceive");
      return d2b?.inventoryShipmentReceive?.inventoryShipment ?? null;
    }
    throw e;
  }
}

/* =========================
   Adjust inventory (Inbound extras)
========================= */

async function adjustInventoryAtLocationWithFallback({ locationId, deltas }) {
  const changes = (deltas ?? [])
    .filter((x) => x?.inventoryItemId && Number(x?.delta || 0) > 0)
    .map((x) => ({ inventoryItemId: x.inventoryItemId, delta: Number(x.delta) }));

  if (!locationId || changes.length === 0) return null;

  // 1) try: inventoryAdjustQuantities（差分加算）
  try {
    const m1 = `#graphql
      mutation Adjust($input: InventoryAdjustQuantitiesInput!) {
        inventoryAdjustQuantities(input: $input) {
          inventoryAdjustmentGroup { id }
          userErrors { field message }
        }
      }`;

    const d1 = await adminGraphql(m1, {
      input: {
        reason: "correction",
        name: "available",
        changes: changes.map((c) => ({
          inventoryItemId: c.inventoryItemId,
          locationId,
          delta: c.delta,
        })),
      },
    });

    assertNoUserErrors(d1?.inventoryAdjustQuantities, "inventoryAdjustQuantities");
    return d1?.inventoryAdjustQuantities?.inventoryAdjustmentGroup ?? null;
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (!/doesn\\'t exist|Field .* doesn't exist|undefined/i.test(msg)) throw e;
  }

  // 2) fallback: inventorySetQuantities（現在値を読んでから new=cur+delta でセット）
  const currentMap = new Map();

  for (const c of changes) {
    const q = `#graphql
      query Cur($id: ID!, $loc: ID!) {
        inventoryItem(id: $id) {
          id
          inventoryLevel(locationId: $loc) {
            quantities(names: ["available"]) { name quantity }
          }
        }
      }`;
    const d = await adminGraphql(q, { id: c.inventoryItemId, loc: locationId });
    const cur = d?.inventoryItem?.inventoryLevel?.quantities?.find((x) => x.name === "available")?.quantity ?? 0;
    currentMap.set(c.inventoryItemId, Number(cur || 0));
  }

  const quantities = changes.map((c) => {
    const cur = currentMap.get(c.inventoryItemId) ?? 0;
    const next = cur + c.delta;
    return {
      inventoryItemId: c.inventoryItemId,
      locationId,
      quantity: next,
      compareQuantity: cur,
    };
  });

  const m2 = `#graphql
    mutation Set($input: InventorySetQuantitiesInput!) {
      inventorySetQuantities(input: $input) {
        inventoryAdjustmentGroup { id }
        userErrors { field message }
      }
    }`;

  const d2 = await adminGraphql(m2, {
    input: {
      name: "available",
      reason: "correction",
      quantities,
    },
  });

  assertNoUserErrors(d2?.inventorySetQuantities, "inventorySetQuantities");
  return d2?.inventorySetQuantities?.inventoryAdjustmentGroup ?? null;
}

// =========================================================
// Inbound Draft（下書き：Transfer優先）
// =========================================================
const INBOUND_DRAFT_PREFIX_V2 = "stock_transfer_pos_inbound_draft_v2"; // ✅ Transfer基準
const INBOUND_DRAFT_PREFIX_V1 = "stock_transfer_pos_inbound_draft_v1"; // 旧：Shipment基準（移行用）

function inboundDraftKeyV2({ locationGid, transferId }) {
  const loc = String(locationGid || "").trim();
  const tid = String(transferId || "").trim();
  return `${INBOUND_DRAFT_PREFIX_V2}:${loc}:${tid}`;
}

function inboundDraftKeyV1({ locationGid, shipmentId }) {
  const loc = String(locationGid || "").trim();
  const sid = String(shipmentId || "").trim();
  return `${INBOUND_DRAFT_PREFIX_V1}:${loc}:${sid}`;
}

// ✅ 互換：transferId があれば必ず v2 を使う（Transferごと保存）
function inboundDraftKey({ locationGid, transferId, shipmentId }) {
  const tid = String(transferId || "").trim();
  if (tid) return inboundDraftKeyV2({ locationGid, transferId: tid });
  return inboundDraftKeyV1({ locationGid, shipmentId });
}

async function loadInboundDraft({ locationGid, transferId, shipmentId }) {
  const tid = String(transferId || "").trim();
  const sid = String(shipmentId || "").trim();

  // 1) ✅ v2（Transferキー）を優先して読む
  if (tid) {
    const keyV2 = inboundDraftKeyV2({ locationGid, transferId: tid });

    // storage
    try {
      if (SHOPIFY?.storage?.get) {
        const got = await SHOPIFY.storage.get(keyV2);
        const parsed = got?.[keyV2] ?? got ?? null;
        if (parsed && String(parsed.transferId || "") === tid) return parsed;
      }
    } catch {
      // noop
    }

    // localStorage fallback
    try {
      const raw = localStorage.getItem(keyV2);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && String(parsed.transferId || "") === tid) return parsed;
      }
    } catch {
      // noop
    }
  }

  // 2) ✅ v1（Shipmentキー）を読む → 見つかったら v2 に移行
  if (sid) {
    const keyV1 = inboundDraftKeyV1({ locationGid, shipmentId: sid });

    // storage
    try {
      if (SHOPIFY?.storage?.get) {
        const got = await SHOPIFY.storage.get(keyV1);
        const parsed = got?.[keyV1] ?? got ?? null;
        if (parsed && String(parsed.shipmentId || "") === sid) {
          // 移行（transferIdがある場合のみ）
          if (tid) {
            const keyV2 = inboundDraftKeyV2({ locationGid, transferId: tid });
            const migrated = { ...parsed, transferId: tid };
            try {
              if (SHOPIFY?.storage?.set) await SHOPIFY.storage.set(keyV2, migrated);
              if (SHOPIFY?.storage?.delete) await SHOPIFY.storage.delete(keyV1);
            } catch {
              // noop
            }
          }
          return parsed;
        }
      }
    } catch {
      // noop
    }

    // localStorage
    try {
      const raw = localStorage.getItem(keyV1);
      if (!raw) return null;

      const parsed = JSON.parse(raw);
      if (!parsed || String(parsed.shipmentId || "") !== sid) return null;

      // 移行（失敗しても parsed は返す）
      if (tid) {
        const keyV2 = inboundDraftKeyV2({ locationGid, transferId: tid });
        const migrated = { ...parsed, transferId: tid };
        try {
          if (SHOPIFY?.storage?.set) await SHOPIFY.storage.set(keyV2, migrated);
        } catch {
          // noop
        }
      }

      try {
        localStorage.removeItem(keyV1);
      } catch {
        // noop
      }

      return parsed;
    } catch {
      return null;
    }
  }

  return null;
}

async function saveInboundDraft({ locationGid, transferId, shipmentId, payload }) {
  const key = inboundDraftKey({ locationGid, transferId, shipmentId });

  // ✅ まずは storage に保存
  try {
    if (SHOPIFY?.storage?.set) {
      await SHOPIFY.storage.set(key, payload);
      return true;
    }
  } catch {
    // noop
  }

  // 開発プレビュー等の保険（localStorage fallback）
  try {
    localStorage.setItem(key, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

async function clearInboundDraft({ locationGid, transferId, shipmentId }) {
  // ✅ v2（Transfer）
  const tid = String(transferId || "").trim();
  if (tid) {
    const keyV2 = inboundDraftKeyV2({ locationGid, transferId: tid });

    try {
      if (SHOPIFY?.storage?.delete) await SHOPIFY.storage.delete(keyV2);
    } catch {}
    try {
      localStorage.removeItem(keyV2);
    } catch {}
  }

  // ✅ v1（Shipment）も掃除（移行前の残骸対策）
  const sid = String(shipmentId || "").trim();
  if (sid) {
    const keyV1 = inboundDraftKeyV1({ locationGid, shipmentId: sid });

    try {
      if (SHOPIFY?.storage?.delete) await SHOPIFY.storage.delete(keyV1);
    } catch {}
    try {
      localStorage.removeItem(keyV1);
    } catch {}
  }
}

/* =========================
   Inbound Audit Log (AppInstallation Metafield)
   - 任意: write_metafields があれば保存
========================= */

const INBOUND_AUDIT_NS = "stock_transfer_pos";
const INBOUND_AUDIT_KEY = "inbound_audit_v1";
const INBOUND_AUDIT_MAX = 50;

async function readInboundAuditLog() {
  const q = `#graphql
    query AuditGet {
      currentAppInstallation {
        id
        metafield(namespace: "${INBOUND_AUDIT_NS}", key: "${INBOUND_AUDIT_KEY}") { id value type }
      }
    }`;

  const d = await adminGraphql(q, {});
  const app = d?.currentAppInstallation;
  if (!app?.id) return [];

  const raw = app?.metafield?.value || "[]";
  let cur = [];
  try {
    cur = JSON.parse(raw);
  } catch {
    cur = [];
  }
  return Array.isArray(cur) ? cur : [];
}

function buildInboundOverIndex_(auditEntries, { locationId } = {}) {
  const idx = new Map(); // shipmentId -> overSum

  (auditEntries || []).forEach((e) => {
    const sid = String(e?.shipmentId || "").trim();
    const loc = String(e?.locationId || "").trim();
    if (!sid) return;
    if (locationId && loc && loc !== String(locationId || "").trim()) return;

    const overArr = Array.isArray(e?.over) ? e.over : [];
    const sum = overArr.reduce((a, x) => {
      const n = Math.max(0, Math.floor(Number(x?.qty ?? x?.overQty ?? x?.delta ?? 0)));
      return a + n;
    }, 0);

    if (sum > 0) idx.set(sid, (idx.get(sid) || 0) + sum);
  });

  return idx;
}

function buildInboundExtrasIndex_(auditEntries, { locationId } = {}) {
  const idx = new Map(); // shipmentId -> extrasSum

  (auditEntries || []).forEach((e) => {
    const sid = String(e?.shipmentId || "").trim();
    const loc = String(e?.locationId || "").trim();
    if (!sid) return;
    if (locationId && loc && loc !== String(locationId || "").trim()) return;

    const extrasArr = Array.isArray(e?.extras) ? e.extras : [];
    const sum = extrasArr.reduce((a, x) => {
      const n = Math.max(0, Math.floor(Number(x?.qty ?? x?.delta ?? x?.receiveQty ?? 0)));
      return a + n;
    }, 0);

    if (sum > 0) idx.set(sid, (idx.get(sid) || 0) + sum);
  });

  return idx;
}

function buildInboundOverItemIndex_(auditEntries, { locationId, shipmentId } = {}) {
  const idx = new Map(); // inventoryItemId -> overSum

  const sidNeedle = String(shipmentId || "").trim();
  const locNeedle = String(locationId || "").trim();

  (auditEntries || []).forEach((e) => {
    const sid = String(e?.shipmentId || "").trim();
    const loc = String(e?.locationId || "").trim();

    if (!sid) return;
    if (sidNeedle && sid !== sidNeedle) return;
    if (locNeedle && loc && loc !== locNeedle) return;

    const overArr = Array.isArray(e?.over) ? e.over : [];
    overArr.forEach((x) => {
      const inventoryItemId = String(x?.inventoryItemId || "").trim();
      if (!inventoryItemId) return;

      const n = Math.max(0, Math.floor(Number(x?.overQty ?? x?.qty ?? x?.delta ?? 0)));
      if (n <= 0) return;

      idx.set(inventoryItemId, (idx.get(inventoryItemId) || 0) + n);
    });
  });

  return idx;
}

function mergeInboundOverIntoTransfers_(transfers, overByShipmentId, extrasByShipmentId) {
  const arr = Array.isArray(transfers) ? transfers : [];
  const overMap = overByShipmentId instanceof Map ? overByShipmentId : new Map();
  const extrasMap = extrasByShipmentId instanceof Map ? extrasByShipmentId : new Map();

  return arr.map((t) => {
    const shipments = Array.isArray(t?.shipments) ? t.shipments : [];

    const overQuantity = shipments.reduce((a, s) => {
      const sid = String(s?.id || "").trim();
      return a + (sid ? Number(overMap.get(sid) || 0) : 0);
    }, 0);

    const extrasQuantity = shipments.reduce((a, s) => {
      const sid = String(s?.id || "").trim();
      return a + (sid ? Number(extrasMap.get(sid) || 0) : 0);
    }, 0);

    const receivedQuantity = Number(t?.receivedQuantity ?? 0);
    const receivedQuantityDisplay = receivedQuantity + Number(overQuantity || 0) + Number(extrasQuantity || 0);

    return {
      ...t,
      overQuantity,
      extrasQuantity,
      receivedQuantityDisplay,
    };
  });
}

async function appendInboundAuditLog({ locationId, shipmentId, reason, note, over, extras }) {
  // 1) read current
  const q = `#graphql
    query AuditGet {
      currentAppInstallation {
        id
        metafield(namespace: "${INBOUND_AUDIT_NS}", key: "${INBOUND_AUDIT_KEY}") { id value type }
      }
    }`;
  const d = await adminGraphql(q, {});
  const app = d?.currentAppInstallation;
  if (!app?.id) throw new Error("currentAppInstallation が取得できませんでした");

  const curRaw = app?.metafield?.value || "[]";
  let cur = [];
  try {
    cur = JSON.parse(curRaw);
  } catch {
    cur = [];
  }
  if (!Array.isArray(cur)) cur = [];

  const entry = {
    at: new Date().toISOString(),
    locationId,
    shipmentId,
    reason: String(reason || ""),
    note: String(note || ""),
    over: Array.isArray(over) ? over : [],
    extras: Array.isArray(extras) ? extras : [],
  };

  const next = [entry, ...cur].slice(0, INBOUND_AUDIT_MAX);

  // 2) write
  const m = `#graphql
    mutation AuditSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id key namespace }
        userErrors { field message }
      }
    }`;

  const r = await adminGraphql(m, {
    metafields: [
      {
        ownerId: app.id,
        namespace: INBOUND_AUDIT_NS,
        key: INBOUND_AUDIT_KEY,
        type: "json",
        value: JSON.stringify(next),
      },
    ],
  });

  assertNoUserErrors(r?.metafieldsSet, "metafieldsSet");
}

/* =========================
   Row UI helpers（1行: [画像][テキスト][数量]）
========================= */

function RowShell({ children }) {
  // ✅ 横paddingは付けない（親のbaseに合わせる）
  // ✅ 縦だけ余白を付ける
  return (
    <s-box padding="none" style={{ paddingTop: "8px", paddingBottom: "8px" }}>
      {children}
    </s-box>
  );
}

function ItemLeftInline({ showImages, imageUrl, productTitle, variantTitle, line3 }) {
  const p = String(productTitle || "").trim() || "(unknown)";
  const v = String(variantTitle || "").trim();

  const options = normalizeVariantOptions_(p, v);
  const optionsLine = formatOptionsLine_(options);

  return (
    <s-stack direction="inline" gap="base" alignItems="center" justifyContent="start">
      {showImages ? <Thumb imageUrl={imageUrl} sizePx={44} /> : null}

      <s-stack gap="extra-tight">
        <s-text emphasis="bold">{p}</s-text>
        {optionsLine ? <s-text tone="subdued" size="small">{optionsLine}</s-text> : null}
        {line3 ? <s-text tone="subdued" size="small">{line3}</s-text> : null}
      </s-stack>
    </s-stack>
  );
}

/* =========================
   Variant Cache（永続チャンク / SHOPIFY.storage）
   - JAN/SKU -> {variantId, inventoryItemId, sku, barcode, productTitle, variantTitle, imageUrl?}
   - storage key はチャンク数ぶんだけ（100キー制限に引っかからない設計）
========================= */

const VARIANT_CACHE_NS = "stock_transfer_pos_variant_cache_v1";
const VARIANT_CACHE_META_KEY = `${VARIANT_CACHE_NS}:meta`;
const VARIANT_CACHE_CHUNK_PREFIX = `${VARIANT_CACHE_NS}:chunk:`;

// 6000SKU想定なら 32〜48 くらいが扱いやすい（1チャンク 125〜190件目安）
const VARIANT_CACHE_CHUNKS = 32;

// flush（永続書き込み）を頻繁にやらない
const VARIANT_CACHE_FLUSH_MS = 2500;

// code 正規化（JAN/SKU 共通）
function normalizeScanCode_(code) {
  const s = String(code ?? "").trim();
  if (!s) return "";
  // 改行や空白は落とす、英字は大文字
  // SKUにハイフン等がある想定で「英数+._-」は残す
  return s
    .replace(/\s+/g, "")
    .toUpperCase()
    .replace(/[^0-9A-Z._-]/g, "");
}

// ざっくりハッシュ（チャンク振り分け用）
function hashString_(s) {
  // djb2
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return Math.abs(h) >>> 0;
}

function chunkIndexForCode_(code) {
  const n = hashString_(code);
  return n % VARIANT_CACHE_CHUNKS;
}

function chunkKey_(idx) {
  return `${VARIANT_CACHE_CHUNK_PREFIX}${String(idx).padStart(2, "0")}`;
}

/**
 * VariantCache: lazy-load chunk, batched flush
 */
const VariantCache = (() => {
  let inited = false;
  let initPromise = null;

  // chunkIdx -> object map
  const chunks = new Map();
  const loadingChunkPromises = new Map();

  const dirtyChunks = new Set();
  let flushTimer = null;

  async function ensureStorage_() {
    if (!SHOPIFY?.storage?.get || !SHOPIFY?.storage?.set) return false;
    return true;
  }

  async function init_() {
    if (inited) return true;
    if (initPromise) return initPromise;

    initPromise = (async () => {
      const ok = await ensureStorage_();
      if (!ok) {
        inited = true; // storage無しでも inited 扱い（メモリのみ動作）
        return false;
      }
      try {
        // metaは今はほぼ使わない（将来のバージョン用）
        const meta = await SHOPIFY.storage.get(VARIANT_CACHE_META_KEY);
        if (!meta || typeof meta !== "object") {
          await SHOPIFY.storage.set(VARIANT_CACHE_META_KEY, {
            v: 1,
            chunks: VARIANT_CACHE_CHUNKS,
            savedAt: Date.now(),
          });
        }
      } catch (_) {
        // metaが取れなくても運用はできる
      }
      inited = true;
      return true;
    })();

    return initPromise;
  }

  async function loadChunk_(idx) {
    await init_();
    const key = chunkKey_(idx);

    if (chunks.has(idx)) return chunks.get(idx);

    if (loadingChunkPromises.has(idx)) return loadingChunkPromises.get(idx);

    const p = (async () => {
      const hasStorage = await ensureStorage_();
      if (!hasStorage) {
        const empty = {};
        chunks.set(idx, empty);
        return empty;
      }

      try {
        const obj = await SHOPIFY.storage.get(key);
        const map = obj && typeof obj === "object" ? obj : {};
        chunks.set(idx, map);
        return map;
      } catch {
        const empty = {};
        chunks.set(idx, empty);
        return empty;
      } finally {
        loadingChunkPromises.delete(idx);
      }
    })();

    loadingChunkPromises.set(idx, p);
    return p;
  }

  function scheduleFlush_() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush_().catch(() => {});
    }, VARIANT_CACHE_FLUSH_MS);
  }

  async function flush_() {
    const hasStorage = await ensureStorage_();
    if (!hasStorage) {
      dirtyChunks.clear();
      return;
    }

    // キューが溜まっているときに無理にflushしない（体感優先）
    // → ここは “今の実装では” キュー状態を知らないので常にflushする。
    //   必要なら「キュー空のときだけflush」に拡張可能。

    const idxs = Array.from(dirtyChunks.values());
    if (idxs.length === 0) return;

    try {
      for (const idx of idxs) {
        const key = chunkKey_(idx);
        const map = chunks.get(idx) || {};
        await SHOPIFY.storage.set(key, map);
      }
      dirtyChunks.clear();

      try {
        await SHOPIFY.storage.set(VARIANT_CACHE_META_KEY, {
          v: 1,
          chunks: VARIANT_CACHE_CHUNKS,
          savedAt: Date.now(),
          dirtyFlushedAt: Date.now(),
        });
      } catch (_) {}
    } catch (_) {
      // flush失敗時は dirty を保持（次回flushに回る）
    }
  }

  async function get(codeRaw) {
    const code = normalizeScanCode_(codeRaw);
    if (!code) return null;

    const idx = chunkIndexForCode_(code);
    const map = await loadChunk_(idx);
    const v = map?.[code] ?? null;
    return v && typeof v === "object" ? v : null;
  }

  async function put(codeRaw, valueObj) {
    const code = normalizeScanCode_(codeRaw);
    if (!code) return;

    const idx = chunkIndexForCode_(code);
    const map = await loadChunk_(idx);

    map[code] = {
      // 最小限（重くしない）
      variantId: valueObj?.variantId ?? null,
      inventoryItemId: valueObj?.inventoryItemId ?? null,
      sku: valueObj?.sku ?? "",
      barcode: valueObj?.barcode ?? "",
      productTitle: valueObj?.productTitle ?? "",
      variantTitle: valueObj?.variantTitle ?? "",
      // 画像は任意（liteMode/画像OFF時は空にしてOK）
      imageUrl: valueObj?.imageUrl ?? "",
      updatedAt: Date.now(),
    };

    chunks.set(idx, map);
    dirtyChunks.add(idx);
    scheduleFlush_();
  }

  async function clearAll() {
    const hasStorage = await ensureStorage_();
    chunks.clear();
    dirtyChunks.clear();
    if (!hasStorage) return;

    try {
      await SHOPIFY.storage.delete(VARIANT_CACHE_META_KEY);
    } catch (_) {}
    for (let i = 0; i < VARIANT_CACHE_CHUNKS; i++) {
      try {
        await SHOPIFY.storage.delete(chunkKey_(i));
      } catch (_) {}
    }
  }

  return {
    init: init_,
    get,
    put,
    flush: flush_,
    clearAll,
  };
})();

/**
 * searchVariants の結果から「一番それっぽい1件」を選ぶ
 * - バーコード完全一致 > SKU完全一致 > 先頭
 */
function pickBestVariant_(codeRaw, list) {
  const code = normalizeScanCode_(codeRaw);
  if (!code) return null;
  const arr = Array.isArray(list) ? list : [];
  if (arr.length === 0) return null;

  // barcode exact
  const byBarcode = arr.find((x) => normalizeScanCode_(x?.barcode) === code);
  if (byBarcode) return byBarcode;

  // sku exact
  const bySku = arr.find((x) => normalizeScanCode_(x?.sku) === code);
  if (bySku) return bySku;

  return arr[0];
}

/**
 * JAN/SKU -> variant 解決（キャッシュ優先）
 * - includeImages は “候補検索” の負荷に関わるので必要時だけtrue
 */
async function resolveVariantByCode(codeRaw, { includeImages = false } = {}) {
  const code = normalizeScanCode_(codeRaw);
  if (!code) return null;

  // 1) cache hit
  const cached = await VariantCache.get(code);
  if (cached?.variantId && cached?.inventoryItemId) return cached;

  // 2) network (searchVariants)
  const list = await searchVariants(code, { includeImages });
  const v = pickBestVariant_(code, list);
  if (!v?.variantId || !v?.inventoryItemId) return null;

  const resolved = {
    variantId: v.variantId,
    inventoryItemId: v.inventoryItemId,
    sku: v.sku || "",
    barcode: v.barcode || "",
    productTitle: v.productTitle || "",
    variantTitle: v.variantTitle || "",
    imageUrl: v.imageUrl || "",
  };

  // 3) write-through cache（次回からネット0）
  await VariantCache.put(code, resolved);

  // ついでに SKU / barcode でも引けるように別名で入れる（効きが良い）
  if (resolved.sku) await VariantCache.put(resolved.sku, resolved);
  if (resolved.barcode) await VariantCache.put(resolved.barcode, resolved);

  return resolved;
}

/* =========================
   ✅ StockLineRow（完全版：汎用 / Inbound・Outbound両対応）
   - row.productTitle / row.variantTitle があれば優先
   - 旧 row.title 互換も維持（"商品 / バリアント" 形式）
   - right があれば右側を差し替え（数量UI以外も置ける）
   - QtyControlCompact（commandFor版/旧版 両対応で連携）
========================= */
function StockLineRow({ row, showImages, dialog, right, onSetQty }) {
  const productTitle = String(row?.productTitle || "").trim();
  const variantTitle = String(row?.variantTitle || "").trim();

  // ✅ 互換：row.title / row.label が "商品 / バリアント" 形式のとき
  const raw = String(row?.title || row?.label || "").trim();
  const parts = raw ? raw.split("/").map((s) => s.trim()).filter(Boolean) : [];

  const fallbackProduct = parts[0] || raw || "(unknown)";
  const fallbackVariant = parts.length >= 2 ? parts.slice(1).join(" / ") : "";

  const p = productTitle || fallbackProduct;
  const v = variantTitle || fallbackVariant;

  const qty = Math.max(0, Number(row?.qty || 0));
  const modalKey =
    row?.key ||
    row?.shipmentLineItemId ||
    row?.inventoryItemId ||
    row?.variantId ||
    raw ||
    "row";

  return (
    <RowShell>
      <s-stack
        direction="inline"
        gap="base"
        justifyContent="space-between"
        alignItems="center"
        style={{ width: "100%", flexWrap: "nowrap" }}
      >
        {/* 左：情報 */}
        <s-box style={{ flex: "1 1 auto", minWidth: 0 }}>
          <ItemLeftInline
            showImages={showImages}
            imageUrl={row?.imageUrl || ""}
            productTitle={p}
            variantTitle={v}
            line3={row?.line3 || ""}
          />
        </s-box>

        {/* 右：数量 or 任意差し込み */}
        <s-box inlineSize="160px" style={{ flex: "0 0 auto" }}>
          {right ?? (
            <QtyControlCompact
              value={qty}
              min={0}
              max={999999}
              title="数量"
              step={1}
              modalId={`qty-row-${String(modalKey)}`}
              onChange={(n) => onSetQty?.(Math.max(0, Number(n || 0)))}
            />
          )}
        </s-box>
      </s-stack>

      <s-divider />
    </RowShell>
  );
}

/* ===== 入庫（Shipment内）描画 ===== */
function renderInboundShipmentItems_({ rows, showImages, dialog, setRowQty }) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return <s-text tone="subdued">lineItems がありません</s-text>;
  }

  return (
    <s-stack gap="none">
      {rows.map((r) => {
        const planned = Number(r?.plannedQty ?? 0);
        const received = Number(r?.receiveQty ?? 0);

        const sku = String(r?.sku || "").trim();
        const barcode = String(r?.barcode || "").trim();

        const skuLine = sku
          ? `SKU:${sku}${barcode ? ` / JAN:${barcode}` : ""}`
          : barcode
          ? `JAN:${barcode}`
          : "";

        const bottomLeft = `予定 ${planned} / 受領 ${received}`;

        // ✅ 未入庫（0/予定）を全部赤にしないため「進捗がある行だけ」差異判定する
        const hasAnyProgress =
          received > 0 ||
          Number(r?.alreadyAcceptedTotalQty ?? 0) > 0 ||
          Number(r?.alreadyRejectedQty ?? 0) > 0;

        const hasDiff = hasAnyProgress && received !== planned;
        const bottomLeftTone = hasDiff ? "critical" : "subdued";

        return (
          <InboundAddedLineRow
            key={r.key}
            row={r}
            showImages={showImages}
            dialog={dialog}
            qty={received}
            modalKey={r.key}
            skuLine={skuLine}
            bottomLeft={bottomLeft}
            bottomLeftTone={bottomLeftTone}
            onDec={() => setRowQty(r.key, Math.max(0, received - 1))}
            onInc={() => setRowQty(r.key, received + 1)}
            onSetQty={(n) => setRowQty(r.key, n)}
          />
        );
      })}
    </s-stack>
  );
}

/* =========================
   UI parts (Thumb / ItemLeft) - s-image版
========================= */

function safeImageSrc_(maybeUrl) {
  const u = typeof maybeUrl === "string" ? maybeUrl.trim() : "";
  if (!u) return "";

  // //cdn.shopify.com/... を https に
  if (u.startsWith("//")) return `https:${u}`;

  // だいたい https しか通さない（POS内での安全策）
  if (u.startsWith("https://")) return u;

  // http は混在で落ちることがあるので弾く（必要なら許可に変えてOK）
  if (u.startsWith("http://")) return "";

  return u;
}

function Thumb({ imageUrl, sizePx = 44 }) {
  const src = safeImageSrc_(imageUrl);
  if (!src) return null;

  const n = Number(sizePx) || 44;
  const size = `${n}px`;

  return (
    <s-box inlineSize={size} blockSize={size}>
      <s-image
        src={src}
        alt=""
        inlineSize="fill"
        objectFit="cover"
      />
    </s-box>
  );
}

// 画像URL決定（超安全版）
function getDisplayImageUrl_(maybeUrl) {
  const u = typeof maybeUrl === "string" ? maybeUrl.trim() : "";
  return u;
}

function clampInt_(v, min = 0, max = 999999) {
  const n = Number(String(v ?? "").trim());
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  return Math.max(min, Math.min(max, i));
}

function sumQty_(lines, key = "qty") {
  return (Array.isArray(lines) ? lines : []).reduce((a, x) => a + Number(x?.[key] || 0), 0);
}

/** ✅ Stocky風：上部サマリー（最小情報） */
function ListSummaryBar({ left, right }) {
  return (
    <s-stack
      direction="inline"
      gap="none"
      alignItems="center"
      justifyContent="space-between"
      style={{ width: "100%" }}
    >
      <s-box style={{ minWidth: 0, flex: "1 1 auto" }}>
        <s-text size="small" tone="subdued">
          {left}
        </s-text>
      </s-box>

      <s-box style={{ minWidth: 0, flex: "0 0 auto" }}>
        <s-text size="small" tone="subdued">
          {right}
        </s-text>
      </s-box>
    </s-stack>
  );
}

/** ✅ 左：画像 + テキスト（自然折り返しで、右ボタンを落とさない） */
function ItemLeftCompact({ showImages, imageUrl, productTitle, variantTitle, line3 }) {
  const clip_ = (s, max) => {
    const t = String(s || "").trim();
    if (!t) return "";
    return t.length > max ? t.slice(0, max - 1) + "…" : t;
  };

  // ✅ ここで確実に短くする（環境差ゼロ）
  const pRaw = String(productTitle || "").trim() || "(unknown)";
  const vRaw = String(variantTitle || "").trim();

  //const p = clip_(pRaw, 34);         // 商品名
  const p = pRaw;
  const v = vRaw;                   // option解析用は生でOK

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
        whiteSpace: "normal",        // ✅ 折り返す
        overflow: "visible",         // ✅ 切らない
        wordBreak: "break-word",     // ✅ 長い英数字も折る
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
}

// 数量コントロール（+/- と 数字タップでモーダル入力）
// - dialog.input を使わず、Polaris web components の commandFor で確実に開く
export function QtyControlCompact({
  value,
  min = 0,
  max = 999999,
  title = "数量",
  onChange,
  step = 1,
  modalId,
}) {
  const v = Number.isFinite(Number(value)) ? Number(value) : min;

  const id = useMemo(() => {
    if (modalId) return String(modalId);
    return `qty-modal-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }, [modalId]);

  const [text, setText] = useState(String(v));

  useEffect(() => {
    setText(String(v));
  }, [v]);

  const clamp = (n) => Math.min(max, Math.max(min, n));

  const commit = () => {
    const raw = String(text ?? "").trim();
    const n = clamp(Number(raw === "" ? min : raw));
    onChange?.(Number.isFinite(n) ? n : min);
  };

  const decDisabled = v <= min;

  // 桁数に応じて「数字ボタンの幅」を少しだけ可変に（崩れ防止）
  const digits = String(v).length;
  const valueWidth =
    digits <= 2 ? 52 :
    digits === 3 ? 64 :
    digits === 4 ? 72 : 84;

  return (
    <>
      <s-stack
        direction="inline"
        gap="extra-tight"
        alignItems="center"
        justifyContent="end"
        style={{ flexWrap: "nowrap" }}   // ✅ 折り返しを防ぐ
      >
        <s-box inlineSize="44px" style={{ flex: "0 0 auto" }}>
          <s-button
            onClick={() => onChange?.(clamp(v - step))}
            disabled={decDisabled}
            style={{ width: "100%" }}
          >
            -
          </s-button>
        </s-box>

        <s-box inlineSize={`${valueWidth}px`} style={{ flex: "0 0 auto" }}>
          <s-button
            command="--show"
            commandFor={id}
            onClick={() => setText(String(v))}
            style={{ width: "100%" }}   // ✅ 数字ボタンを固定幅に
          >
            {v}
          </s-button>
        </s-box>

        <s-box inlineSize="44px" style={{ flex: "0 0 auto" }}>
          <s-button
            onClick={() => onChange?.(clamp(v + step))}
            style={{ width: "100%" }}
          >
            +
          </s-button>
        </s-box>
      </s-stack>

      <s-modal id={id} heading={title}>
        <s-box padding="base">
          <s-stack gap="base">
            <s-text tone="subdued" size="small">
              数量を入力してください（{min}〜{max}）
            </s-text>

            <s-text-field
              label="数量"
              value={text}
              inputMode="numeric"
              placeholder="例: 20"
              onInput={(e) => setText(String(e?.target?.value ?? e ?? ""))}
              onChange={(e) => setText(String(e?.target?.value ?? e ?? ""))}
            />
          </s-stack>
        </s-box>

        <s-button slot="secondary-actions" command="--hide" commandFor={id}>
          キャンセル
        </s-button>

        <s-button
          slot="primary-action"
          tone="success"
          command="--hide"
          commandFor={id}
          onClick={commit}
        >
          OK
        </s-button>
      </s-modal>
    </>
  );
}

/** ✅ 行：左右パディングなし、縦だけ（propsで指定） */
function StockyRowShell({ children }) {
  return (
    <s-box
      paddingInline="none"
      paddingBlockStart="small-100"
      paddingBlockEnd="small-200"
    >
      {children}
    </s-box>
  );
}

/* =========================
   UI parts (ItemLeft)
========================= */

function ItemLeft(props) {
  const showImages = !!(props.showImages ?? props.showImage);

  const title =
    (typeof props.title === "string" && props.title.trim()) ||
    `${props.productTitle || ""}${props.variantTitle ? ` / ${props.variantTitle}` : ""}`.trim() ||
    props.sku ||
    props.inventoryItemId ||
    "(unknown)";

  const meta1 =
    (typeof props.meta1 === "string" && props.meta1) ||
    ((props.sku || props.barcode)
      ? `${props.sku ? `SKU: ${props.sku}` : ""}${props.sku && props.barcode ? " / " : ""}${props.barcode ? `barcode: ${props.barcode}` : ""}`
      : "");

  const meta2 =
    (typeof props.meta2 === "string" && props.meta2) ||
    (props.plannedQty != null || props.receivedQty != null
      ? `予定 ${props.plannedQty ?? 0} / 受領 ${props.receivedQty ?? 0}`
      : "");

  return (
    <s-stack direction="inline" gap="base" alignItems="center" justifyContent="start">
      {showImages ? <Thumb imageUrl={props.imageUrl || ""} sizePx={56} /> : null}

      <s-stack gap="extra-tight">
        <s-text emphasis="bold">{title}</s-text>

        {meta1 ? <s-text tone="subdued" size="small">{meta1}</s-text> : null}
        {meta2 ? <s-text tone="subdued" size="small">{meta2}</s-text> : null}
      </s-stack>
    </s-stack>
  );
}

/* =========================
   debounce
========================= */

function useDebounce(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
