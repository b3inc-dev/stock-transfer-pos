import { render, Component } from "preact";
import { useState, useCallback, useEffect, useRef, useMemo } from "preact/hooks";
import { getStateSlice, setStateSlice, toUserMessage, getStatusBadgeTone, readValue } from "./inboundHelpers.js";
import { useSessionLocationId, useOriginLocationGid, useLocationsIndex, getLocationName_ } from "./inboundHooks.js";
import {
  fetchTransfersForDestinationAll,
  fetchSettings,
  readInboundAuditLog,
  buildInboundOverIndex_,
  buildInboundExtrasIndex_,
  buildInboundRejectedIndex_,
  mergeInboundOverIntoTransfers_,
} from "./inboundApi.js";
import { FixedFooterNavBar } from "./FixedFooterNavBar.jsx";
import { InboundShipmentSelection } from "./screens/InboundShipmentSelection.jsx";
import { InboundListScreen } from "./screens/InboundListScreen.jsx";

const SHOPIFY = globalThis?.shopify ?? {};
const toast = (m) => SHOPIFY?.toast?.show?.(String(m));

let posModalApi = null;

const INBOUND_SCAN_QUEUE_KEY = "stock_transfer_pos_scan_queue_v1";

function normalizeScanQueueObj_(raw) {
  if (Array.isArray(raw)) {
    const items = raw.map((x) => (typeof x === "string" ? x.trim() : String(x?.v || "").trim())).filter(Boolean);
    return { items, lastV: items[items.length - 1] || "", lastT: Date.now(), updatedAt: Date.now() };
  }
  if (raw && typeof raw === "object") {
    const items = Array.isArray(raw.items) ? raw.items.map((s) => String(s || "").trim()).filter(Boolean) : [];
    return { items, lastV: String(raw.lastV || items[items.length - 1] || ""), lastT: Number(raw.lastT || 0), updatedAt: Number(raw.updatedAt || 0) };
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
    const cur = normalizeScanQueueObj_(await storage.get(INBOUND_SCAN_QUEUE_KEY));
    if (cur.lastV === v && Math.abs(now - Number(cur.lastT || 0)) < 350) return;
    const nextItems = [...cur.items, v];
    const trimmed = nextItems.length > 5000 ? nextItems.slice(nextItems.length - 5000) : nextItems;
    await storage.set(INBOUND_SCAN_QUEUE_KEY, { items: trimmed, lastV: v, lastT: now, updatedAt: now });
  } catch (e) {
    console.error("pushScanToQueue_ failed", e);
  }
}

const UI_PREFS_KEY = "stock_transfer_pos_ui_prefs_v1";
const APP_STATE_KEY = "stock_transfer_pos_state_v1";
const SCREENS = { INBOUND_COND: "in_cond", INBOUND_SHIPMENT_SELECTION: "in_shipment_selection", INBOUND_LIST: "in_list" };

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

function useNavStack(initial = { id: SCREENS.INBOUND_COND, params: {} }) {
  const [stack, setStack] = useState([initial]);
  const current = stack[stack.length - 1];
  const push = useCallback((id, params = {}) => setStack((prev) => [...prev, { id, params }]), []);
  const pop = useCallback(() => setStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev)), []);
  return { stack, current, push, pop };
}

const INBOUND_LOCATION_MODAL_ID = "inbound-location-modal";

/** ロケーション選択モーダル（POSでは command="--show" commandFor={id} で開くため常にレンダー） */
function LocationSelectModal({ id, title, locations, selectedId, onSelect }) {
  const [searchQuery, setSearchQuery] = useState("");
  const list = useMemo(() => {
    const base = Array.isArray(locations) ? locations : [];
    const q = String(searchQuery || "").trim().toLowerCase();
    if (!q) return base;
    return base.filter((l) => String(l?.name || "").toLowerCase().includes(q));
  }, [locations, searchQuery]);

  return (
    <s-modal id={id} heading={title || "ロケーションを選択"} style={{ maxBlockSize: "85vh" }}>
      <s-box padding="base">
        <s-stack gap="base">
          <s-text-field
            label="検索"
            placeholder="ロケーション名"
            value={searchQuery}
            onInput={(e) => setSearchQuery(readValue(e))}
            onChange={(e) => setSearchQuery(readValue(e))}
          />
          <s-scroll-view style={{ maxBlockSize: "60vh" }}>
            <s-stack gap="small">
              {list.length === 0 ? (
                <s-text tone="subdued">該当するロケーションがありません</s-text>
              ) : (
                list.map((l) => (
                  <s-button
                    key={l.id}
                    tone={l.id === selectedId ? "success" : undefined}
                    command="--hide"
                    commandFor={id}
                    onClick={() => onSelect?.(l.id, l.name)}
                  >
                    {l.name}
                  </s-button>
                ))
              )}
            </s-stack>
          </s-scroll-view>
        </s-stack>
      </s-box>
    </s-modal>
  );
}

function InboundConditions({
  appState,
  setAppState,
  settings,
  onBack,
  onNext,
  onOpenShipmentSelection,
  setHeader,
  setFooter,
  showImages,
  liteMode,
  onToggleLiteMode,
}) {
  const locationGid = useOriginLocationGid() || String(appState?.originLocationIdManual || "").trim() || null;
  const locIndex = useLocationsIndex(appState, setAppState);
  const inbound = getStateSlice(appState, "inbound", { selectedShipmentId: "" });
  const locationName = useMemo(() => {
    const fromIndex = getLocationName_(locationGid, locIndex.byId);
    if (fromIndex && fromIndex !== "（不明）") return fromIndex;
    return String(appState?.originLocationNameManual || "").trim() || "現在店舗";
  }, [locationGid, locIndex.byId, appState?.originLocationNameManual]);

  const listInitialLimit = Math.max(1, Math.min(250, Number(appState?.outbound?.settings?.inbound?.listInitialLimit ?? settings?.inbound?.listInitialLimit ?? 100)));

  const [viewMode, setViewMode] = useState("pending");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [transfers, setTransfers] = useState([]);
  const [transfersPageInfo, setTransfersPageInfo] = useState({ hasNextPage: false, endCursor: null });
  const [loadingMore, setLoadingMore] = useState(false);
  const [pendingTransferForModal, setPendingTransferForModal] = useState(null);
  const pendingTransferForModalRef = useRef(null);
  const SHIPMENT_MODE_SELECTION_MODAL_ID = "shipment-mode-selection-modal";

  const STATUS_LABEL = useMemo(() => ({
    DRAFT: "下書き", READY_TO_SHIP: "配送準備完了", IN_PROGRESS: "処理中", IN_TRANSIT: "進行中",
    RECEIVED: "入庫", TRANSFERRED: "入庫済み", CANCELED: "キャンセル", OTHER: "その他",
  }), []);
  const formatDate = (iso) => (iso ? String(iso).trim().slice(0, 10) : "-");
  const isCompleted = (t) => String(t?.status || "").toUpperCase() === "TRANSFERRED";
  const listToShow = useMemo(() => {
    const base = Array.isArray(transfers) ? transfers : [];
    return viewMode === "received" ? base.filter(isCompleted) : base.filter((t) => !isCompleted(t));
  }, [transfers, viewMode]);
  const baseAll = Array.isArray(transfers) ? transfers : [];
  const pendingTransfersAll = baseAll.filter((t) => !isCompleted(t));
  const receivedTransfersAll = baseAll.filter(isCompleted);
  const displayLocationName = useMemo(() => {
    const arr = Array.isArray(transfers) ? transfers : [];
    const any = arr.find((t) => String(t?.destinationName || "").trim());
    if (any?.destinationName) return String(any.destinationName).trim();
    return locationName;
  }, [transfers, locationName]);

  const refresh = useCallback(async () => {
    if (!locationGid) return;
    setLoading(true);
    setError("");
    // 既存データをクリア（一度読み込まれたデータが残らないように）
    setTransfers([]);
    setTransfersPageInfo({ hasNextPage: false, endCursor: null });
    try {
      const result = await fetchTransfersForDestinationAll(locationGid, { first: listInitialLimit });
      const baseTransfers = Array.isArray(result?.transfers) ? result.transfers : [];
      setTransfersPageInfo(result?.pageInfo || { hasNextPage: false, endCursor: null });
      // 二相ロード：先に baseTransfers を表示
      setTransfers(baseTransfers);
      setLoading(false);
      // その後、非同期で監査ログをマージ
      try {
        const audit = await readInboundAuditLog();
        const overIdx = buildInboundOverIndex_(audit, { locationId: locationGid });
        const extrasIdx = buildInboundExtrasIndex_(audit, { locationId: locationGid });
        
        // 拒否分を集計（shipmentsのlineItemsから取得）
        const shipmentIds = baseTransfers.flatMap((t) => 
          (Array.isArray(t?.shipments) ? t.shipments : [])
            .map((s) => String(s?.id || "").trim())
            .filter(Boolean)
        );
        const rejectedIdx = await buildInboundRejectedIndex_(shipmentIds);
        
        const patched = mergeInboundOverIntoTransfers_(baseTransfers, overIdx, extrasIdx, rejectedIdx);
        setTransfers(patched);
      } catch (_) {
        // エラー時はそのまま
      }
    } catch (e) {
      setError(toUserMessage(e));
      setTransfers([]);
      setTransfersPageInfo({ hasNextPage: false, endCursor: null });
      setLoading(false);
    }
  }, [locationGid, listInitialLimit]);

  const loadMoreTransfers_ = useCallback(async () => {
    if (!locationGid || !transfersPageInfo?.hasNextPage || !transfersPageInfo?.endCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const result = await fetchTransfersForDestinationAll(locationGid, {
        after: transfersPageInfo.endCursor,
        first: listInitialLimit,
      });

      if (result?.pageInfo) {
        setTransfersPageInfo(result.pageInfo);
      }

      const newTransfers = Array.isArray(result?.transfers) ? result.transfers : [];
      // 二相ロード：先に newTransfers を追加表示
      setTransfers((prev) => [...prev, ...newTransfers]);
      setLoadingMore(false);
      // その後、非同期で監査ログをマージ
      try {
        const audit = await readInboundAuditLog();
        const overIdx = buildInboundOverIndex_(audit, { locationId: locationGid });
        const extrasIdx = buildInboundExtrasIndex_(audit, { locationId: locationGid });
        
        // 拒否分を集計（shipmentsのlineItemsから取得）
        const shipmentIds = newTransfers.flatMap((t) => 
          (Array.isArray(t?.shipments) ? t.shipments : [])
            .map((s) => String(s?.id || "").trim())
            .filter(Boolean)
        );
        const rejectedIdx = await buildInboundRejectedIndex_(shipmentIds);
        
        const patched = mergeInboundOverIntoTransfers_(newTransfers, overIdx, extrasIdx, rejectedIdx);
        // 既存の newTransfers を patched に置き換え
        setTransfers((prev) => {
          const withoutNew = prev.slice(0, prev.length - newTransfers.length);
          return [...withoutNew, ...patched];
        });
      } catch (_) {}
    } catch (e) {
      toast(String(e?.message || e || "追加読み込みに失敗しました"));
      setLoadingMore(false);
    }
  }, [locationGid, transfersPageInfo, loadingMore, listInitialLimit]);

  useEffect(() => {
    if (!locationGid) return;
    refresh().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationGid]);

  const pickShipmentIdFromTransfer = (t) => {
    const nodes = t?.shipments ?? [];
    const cand = nodes.find((s) => String(s?.status || "").toUpperCase() !== "RECEIVED") || nodes.find((s) => String(s?.status || "").toUpperCase() !== "TRANSFERRED") || nodes[0];
    return String(cand?.id || "").trim();
  };

  const onTapTransfer = (t) => {
    const shipments = Array.isArray(t?.shipments) ? t.shipments : [];
    if (shipments.length === 0) {
      toast("配送が見つかりません");
      return;
    }
    if (shipments.length === 1) {
      const shipmentId = pickShipmentIdFromTransfer(t);
      if (!shipmentId) return;
      const readOnly = isCompleted(t);
      setStateSlice(setAppState, "inbound", {
        selectedShipmentId: shipmentId,
        selectedTransferId: String(t?.id || ""),
        selectedTransferName: String(t?.name || ""),
        selectedOriginName: String(t?.originName || ""),
        selectedDestinationName: String(t?.destinationName || ""),
        selectedOriginLocationId: String(t?.originLocationId ?? ""),
        selectedTransferStatus: String(t?.status || ""),
        selectedTransferTotalQuantity: Number(t?.totalQuantity ?? 0),
        selectedTransferReceivedQuantity: Number(t?.receivedQuantityDisplay ?? t?.receivedQuantity ?? 0),
        selectedReadOnly: !!readOnly,
      });
      onNext?.();
      return;
    }
    setPendingTransferForModal(t);
  };

  const handleSelectSingleShipment = useCallback(() => {
    const t = pendingTransferForModal || pendingTransferForModalRef.current;
    if (!t) { pendingTransferForModalRef.current = null; setPendingTransferForModal(null); return; }
    const shipments = Array.isArray(t?.shipments) ? t.shipments : [];
    if (shipments.length === 0) { toast("配送が見つかりません"); pendingTransferForModalRef.current = null; setPendingTransferForModal(null); return; }
    setStateSlice(setAppState, "inbound", {
      selectedTransferId: String(t?.id || ""),
      selectedTransferName: String(t?.name || ""),
      selectedOriginName: String(t?.originName || ""),
      selectedDestinationName: String(t?.destinationName || ""),
      selectedOriginLocationId: String(t?.originLocationId ?? ""),
      selectedTransferStatus: String(t?.status || ""),
      selectedTransferTotalQuantity: Number(t?.totalQuantity ?? 0),
      selectedTransferReceivedQuantity: Number(t?.receivedQuantityDisplay ?? t?.receivedQuantity ?? 0),
      selectedTransferForSelection: t,
    });
    pendingTransferForModalRef.current = null;
    setPendingTransferForModal(null);
    onOpenShipmentSelection?.();
  }, [pendingTransferForModal, setAppState, onOpenShipmentSelection]);

  const handleShowAllShipments = useCallback(() => {
    const t = pendingTransferForModal || pendingTransferForModalRef.current;
    if (!t) { pendingTransferForModalRef.current = null; setPendingTransferForModal(null); return; }
    setStateSlice(setAppState, "inbound", {
      selectedShipmentIds: (Array.isArray(t?.shipments) ? t.shipments : []).map((s) => String(s?.id || "").trim()).filter(Boolean),
      shipmentMode: "multiple",
      selectedTransferId: String(t?.id || ""),
      selectedTransferName: String(t?.name || ""),
      selectedOriginName: String(t?.originName || ""),
      selectedDestinationName: String(t?.destinationName || ""),
      selectedOriginLocationId: String(t?.originLocationId ?? ""),
      selectedTransferStatus: String(t?.status || ""),
      selectedTransferTotalQuantity: Number(t?.totalQuantity ?? 0),
      selectedTransferReceivedQuantity: Number(t?.receivedQuantityDisplay ?? t?.receivedQuantity ?? 0),
    });
    pendingTransferForModalRef.current = null;
    setPendingTransferForModal(null);
    onNext?.();
  }, [pendingTransferForModal, setAppState, onNext]);

  useEffect(() => {
    setHeader?.(
      <s-box padding="base">
        <s-stack gap="base">
          <s-stack direction="inline" gap="none" inlineSize="100%">
            <s-box inlineSize="50%">
              <s-button variant={viewMode === "pending" ? "primary" : "secondary"} onClick={() => setViewMode("pending")}>未入庫 {pendingTransfersAll.length}件</s-button>
            </s-box>
            <s-box inlineSize="50%">
              <s-button variant={viewMode === "received" ? "primary" : "secondary"} onClick={() => setViewMode("received")}>入庫済み {receivedTransfersAll.length}件</s-button>
            </s-box>
          </s-stack>
          {transfersPageInfo?.hasNextPage ? (
            <s-box padding="none" style={{ paddingBlock: "4px", paddingInline: "16px" }}>
              <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
                <s-text tone="subdued" size="small">未読み込み一覧リストがあります。（過去分）</s-text>
                <s-button kind="secondary" onClick={loadMoreTransfers_} onPress={loadMoreTransfers_} disabled={loadingMore}>
                  {loadingMore ? "読込中..." : "読込"}
                </s-button>
              </s-stack>
            </s-box>
          ) : null}
        </s-stack>
      </s-box>
    );
    return () => setHeader?.(null);
  }, [setHeader, viewMode, pendingTransfersAll.length, receivedTransfersAll.length, transfersPageInfo?.hasNextPage, loadingMore, loadMoreTransfers_]);

  useEffect(() => {
    setFooter?.(
      <FixedFooterNavBar
        summaryLeft={`入庫先: ${displayLocationName}`}
        summaryRight={viewMode === "received" ? `入庫済み ${listToShow.length}件` : `未入庫 ${listToShow.length}件`}
        leftLabel={liteMode ? "画像OFF" : "画像ON"}
        leftTone={liteMode ? "critical" : "default"}
        onLeft={typeof onToggleLiteMode === "function" ? onToggleLiteMode : undefined}
        rightLabel={loading ? "読込中..." : "再読込"}
        onRight={refresh}
        rightDisabled={loading || !locationGid}
      />
    );
    return () => setFooter?.(null);
  }, [setFooter, displayLocationName, viewMode, listToShow.length, liteMode, onToggleLiteMode, refresh, loading, locationGid]);

  return (
    <>
      <s-box padding="base">
        <s-stack gap="base">
          {error ? <s-box padding="none"><s-text tone="critical">入庫ID一覧の取得に失敗しました: {error}</s-text></s-box> : null}
          {listToShow.length === 0 ? (
            <s-text tone="subdued" size="small">{loading ? "読み込み中..." : "表示できる入庫IDがありません"}</s-text>
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
                const statusSuffix = isPartial ? "一部入庫" : isOver ? "予定超過" : "";
                const statusJa = STATUS_LABEL[String(t?.status || "").trim()] || "不明";
                const shipmentCount = (Array.isArray(t?.shipments) ? t.shipments : []).length;
                const statusBadgeTone = getStatusBadgeTone(statusJa);
                const showListButton = shipmentCount > 1;
                return (
                  <s-box key={t.id}>
                    {showListButton ? (
                      // シップメントが2つ以上の場合：シップメントが1つの場合と同じレイアウト + 右端に「リスト」ボタン
                      <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between" style={{ width: "100%" }}>
                        <s-clickable onClick={() => onTapTransfer(t)} style={{ flex: "1 1 0", minWidth: 0 }}>
                          <s-box padding="small" style={{ width: "100%" }}>
                            <s-stack gap="tight" style={{ width: "100%" }}>
                              <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="small" style={{ width: "100%" }}>
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
                              <s-text tone="subdued" size="small" style={{ whiteSpace: "nowrap" }}>
                                配送数: {shipmentCount}
                              </s-text>
                              <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="small" style={{ width: "100%" }}>
                                <s-stack direction="inline" gap="small" alignItems="center">
                                  <s-badge tone={statusBadgeTone}>{statusJa}</s-badge>
                                  {statusSuffix ? <s-text tone={(isPartial || isOver) ? "critical" : "subdued"} size="small">{statusSuffix}</s-text> : null}
                                </s-stack>
                                <s-text tone={(isPartial || isOver) ? "critical" : "subdued"} size="small" style={{ whiteSpace: "nowrap" }}>
                                  {received}/{total}
                                </s-text>
                              </s-stack>
                            </s-stack>
                          </s-box>
                        </s-clickable>
                        
                        {/* 右端：「リスト」ボタン（右固定・縮まない） */}
                        <s-box style={{ flex: "0 0 auto", flexShrink: 0 }}>
                          <s-button
                            kind="secondary"
                            size="small"
                            command="--show"
                            commandFor={SHIPMENT_MODE_SELECTION_MODAL_ID}
                            onClick={() => {
                              pendingTransferForModalRef.current = t;
                              setPendingTransferForModal(t);
                            }}
                          >
                            リスト
                          </s-button>
                        </s-box>
                      </s-stack>
                    ) : (
                      // シップメントが1つの場合：元のレイアウト（全体がクリック可能、右上に日付、右下に数量）
                      <s-clickable onClick={() => onTapTransfer(t)}>
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
                              <s-stack direction="inline" gap="small" alignItems="center">
                                <s-badge tone={statusBadgeTone}>{statusJa}</s-badge>
                                {statusSuffix ? <s-text tone={(isPartial || isOver) ? "critical" : "subdued"} size="small">{statusSuffix}</s-text> : null}
                              </s-stack>
                              <s-text tone={(isPartial || isOver) ? "critical" : "subdued"} size="small" style={{ whiteSpace: "nowrap" }}>
                                {received}/{total}
                              </s-text>
                            </s-stack>
                          </s-stack>
                        </s-box>
                      </s-clickable>
                    )}
                    <s-divider />
                  </s-box>
                );
              })}
            </s-stack>
          )}
        </s-stack>
      </s-box>
      <s-modal id={SHIPMENT_MODE_SELECTION_MODAL_ID} heading="処理方法を選択">
        {(pendingTransferForModal || pendingTransferForModalRef.current) ? (
          <s-box padding="base" paddingBlockEnd="none">
            <s-stack gap="base">
              <s-stack gap="none">
                <s-text tone="subdued" size="small">{String((pendingTransferForModal || pendingTransferForModalRef.current)?.name || "").trim() || "入庫ID"}</s-text>
                <s-text tone="subdued" size="small">出庫元: {String((pendingTransferForModal || pendingTransferForModalRef.current)?.originName || "").trim() || "-"}</s-text>
                <s-text tone="subdued" size="small">宛先: {String((pendingTransferForModal || pendingTransferForModalRef.current)?.destinationName || "").trim() || "-"}</s-text>
                <s-text tone="subdued" size="small">配送数: {Array.isArray((pendingTransferForModal || pendingTransferForModalRef.current)?.shipments) ? (pendingTransferForModal || pendingTransferForModalRef.current).shipments.length : 0}</s-text>
              </s-stack>
              <s-divider />
              <s-stack gap="none">
                <s-box padding="none" style={{ border: "1px solid var(--s-color-border)", borderRadius: 4 }}>
                  <s-text tone="subdued" size="small">配送ごとに選択：1つの配送を選択して処理します</s-text>
                </s-box>
                <s-box padding="none" style={{ border: "1px solid var(--s-color-border)", borderRadius: 4 }}>
                  <s-text tone="subdued" size="small">まとめて表示：全配送を1画面で表示して処理します</s-text>
                </s-box>
              </s-stack>
              <s-divider />
              <s-box>
                <s-button command="--hide" commandFor={SHIPMENT_MODE_SELECTION_MODAL_ID} onClick={() => { pendingTransferForModalRef.current = null; setPendingTransferForModal(null); }}>戻る</s-button>
              </s-box>
            </s-stack>
          </s-box>
        ) : null}
        <s-button slot="secondary-actions" command="--hide" commandFor={SHIPMENT_MODE_SELECTION_MODAL_ID} onClick={handleSelectSingleShipment}>配送ごとに選択</s-button>
        <s-button slot="primary-action" tone="success" command="--hide" commandFor={SHIPMENT_MODE_SELECTION_MODAL_ID} onClick={handleShowAllShipments}>まとめて表示</s-button>
      </s-modal>
      <LocationSelectModal
        id={INBOUND_LOCATION_MODAL_ID}
        title="入庫先ロケーションを選択"
        locations={locIndex.list}
        selectedId={locationGid}
        onSelect={(id, name) => {
          setAppState((prev) => ({ ...(prev || {}), originLocationIdManual: id || "", originLocationNameManual: name || "" }));
        }}
      />
    </>
  );
}

class ErrorBoundary extends Component {
  constructor() { super(); this.state = { err: null }; }
  componentDidCatch(err) { this.setState({ err }); try { SHOPIFY?.toast?.show?.(`UI Error: ${err?.message ?? err}`); } catch {} }
  render(props, state) {
    if (state.err) return (<s-page heading="エラー"><s-box padding="base"><s-text tone="critical">{String(state.err?.message ?? state.err)}</s-text></s-box></s-page>);
    return props.children;
  }
}

function Extension() {
  const [appState, setAppState] = usePersistentAppState();
  const [prefs, setPrefs] = useUiPrefs();
  const [header, setHeader] = useState(null);
  const [footer, setFooter] = useState(null);
  const [settings, setSettings] = useState(null);
  const [cameraScannerVisible, setCameraScannerVisible] = useState(false);
  const sessionLocationGid = useOriginLocationGid();
  const locationGid = sessionLocationGid;
  const defaultLocationSetRef = useRef(false);

  useEffect(() => {
    if (defaultLocationSetRef.current) return;
    if (!sessionLocationGid) return;
    defaultLocationSetRef.current = true;
    setAppState((prev) => ({
      ...(prev || {}),
      originLocationIdManual: sessionLocationGid,
      originLocationNameManual: "",
    }));
  }, [sessionLocationGid, setAppState]);
  const nav = useNavStack({ id: SCREENS.INBOUND_COND, params: {} });
  const screen = nav.current?.id || SCREENS.INBOUND_COND;
  const screenRef = useRef(screen);
  useEffect(() => {
    screenRef.current = screen;
  }, [screen]);
  const liteMode = !!prefs?.liteMode;
  const showImages = !liteMode;

  // スキャナー購読（スキャン受信時にトースト表示し、入庫リスト画面ではキューに積む）
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
          if (screenRef.current === SCREENS.INBOUND_LIST) {
            pushScanToQueue_(data);
          }
        } catch (e) {
          console.error("[Inbound] scanner callback error:", e);
        }
      });
    } catch (e) {
      console.error("[Inbound] scanner subscribe error:", e);
    }
    return () => {
      try {
        unsub?.();
      } catch {}
    };
  }, []);

  useEffect(() => {
    let alive = true;
    fetchSettings()
      .then((s) => { if (alive) setSettings(s); })
      .catch(() => { if (alive) setSettings({ version: 1, inbound: { listInitialLimit: 100 }, productList: { initialLimit: 250 }, searchList: { initialLimit: 50 } }); });
    return () => { alive = false; };
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
  const goBackFromInboundCond = useCallback(() => {
    if (nav.stack.length <= 1) dismissModal();
    else nav.pop();
  }, [nav.stack.length, dismissModal, nav.pop]);

  const goInboundList = useCallback(() => { setHeader(null); setFooter(null); nav.push(SCREENS.INBOUND_LIST, {}); }, [nav.push]);
  const goInboundShipmentSelection = useCallback(() => { setHeader(null); setFooter(null); nav.push(SCREENS.INBOUND_SHIPMENT_SELECTION, {}); }, [nav.push]);
  const goBack = useCallback(() => { setHeader(null); setFooter(null); nav.pop(); }, [nav.pop]);

  // REFERENCE 5.2 #3: 確定後に Transfer の完了状態で INBOUND_COND / INBOUND_SHIPMENT_SELECTION へ振り分け
  const onAfterReceiveInboundList = useCallback(
    async (transferId) => {
      try {
        if (!locationGid) {
          goBack();
          return;
        }
        const listLimit = Math.max(1, Math.min(250, Number(appState?.outbound?.settings?.inbound?.listInitialLimit ?? settings?.inbound?.listInitialLimit ?? 100)));
        const result = await fetchTransfersForDestinationAll(locationGid, { first: listLimit });
        const transfers = Array.isArray(result?.transfers) ? result.transfers : [];
        const transfer = transfers.find((t) => String(t?.id || "").trim() === String(transferId || "").trim());
        if (!transfer) {
          goBack();
          return;
        }
        const shipments = Array.isArray(transfer?.shipments) ? transfer.shipments : [];
        const allReceived = shipments.length > 0 && shipments.every((s) => {
          const status = String(s?.status || "").toUpperCase();
          return status === "RECEIVED" || status === "TRANSFERRED";
        });
        if (allReceived) {
          toast("すべての配送の入庫が完了しました");
          setStateSlice(setAppState, "inbound", {
            selectedTransferId: "",
            selectedShipmentId: "",
            selectedShipmentIds: [],
            shipmentMode: "single",
            selectedTransferName: "",
            selectedOriginName: "",
            selectedDestinationName: "",
            selectedTransferStatus: "",
            selectedTransferTotalQuantity: 0,
            selectedTransferReceivedQuantity: 0,
            selectedReadOnly: false,
            selectedOriginLocationId: "",
          });
          setHeader(null);
          setFooter(null);
          nav.push(SCREENS.INBOUND_COND);
        } else {
          setStateSlice(setAppState, "inbound", (prev) => ({
            ...(prev || {}),
            selectedShipmentId: "",
            selectedShipmentIds: [],
            shipmentMode: "single",
          }));
          setHeader(null);
          setFooter(null);
          nav.push(SCREENS.INBOUND_SHIPMENT_SELECTION);
        }
      } catch (e) {
        goBack();
      }
    },
    [locationGid, appState?.outbound?.settings?.inbound?.listInitialLimit, settings?.inbound?.listInitialLimit, setAppState, nav.push, goBack]
  );

  const toggleLiteMode = useCallback(() => setPrefs((prev) => ({ ...(prev && typeof prev === "object" ? prev : {}), liteMode: !prev?.liteMode })), [setPrefs]);

  let body = null;
  if (screen === SCREENS.INBOUND_COND) {
    body = (
      <InboundConditions
        appState={appState}
        setAppState={setAppState}
        settings={settings}
        onBack={goBackFromInboundCond}
        onNext={goInboundList}
        onOpenShipmentSelection={goInboundShipmentSelection}
        setHeader={setHeader}
        setFooter={setFooter}
        showImages={showImages}
        liteMode={liteMode}
        onToggleLiteMode={toggleLiteMode}
      />
    );
  } else if (screen === SCREENS.INBOUND_SHIPMENT_SELECTION) {
    body = (
      <InboundShipmentSelection
        showImages={showImages}
        liteMode={liteMode}
        appState={appState}
        setAppState={setAppState}
        settings={settings}
        onNext={goInboundList}
        onBack={goBack}
        setHeader={setHeader}
        setFooter={setFooter}
        onToggleLiteMode={toggleLiteMode}
      />
    );
  } else if (screen === SCREENS.INBOUND_LIST) {
    body = (
      <InboundListScreen
        showImages={showImages}
        liteMode={liteMode}
        appState={appState}
        setAppState={setAppState}
        settings={settings}
        onBack={goBack}
        onAfterReceive={onAfterReceiveInboundList}
        setHeader={setHeader}
        setFooter={setFooter}
        onToggleLiteMode={toggleLiteMode}
      />
    );
  }

  if (!body) body = <s-box padding="base"><s-text tone="critical">画面の状態が不正です</s-text><s-button onClick={dismissModal}>閉じる</s-button></s-box>;

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
    <s-page heading="入庫">
      <s-button slot="secondary-actions" kind="secondary" onClick={handleCameraScanToggle}>
        {cameraScannerVisible ? "カメラを閉じる" : "カメラスキャン"}
      </s-button>
      <s-stack gap="none" blockSize="100%" inlineSize="100%" minBlockSize="0">
        {header ? (<><s-box padding="none">{header}</s-box><s-divider /></>) : null}
        <s-scroll-box padding="none" blockSize="auto" maxBlockSize="100%" minBlockSize="0">
          <s-box padding="none">{body}</s-box>
        </s-scroll-box>
        {footer ? (<><s-divider /><s-box padding="none">{footer}</s-box></>) : null}
      </s-stack>
    </s-page>
  );
}

export default async (rootArg, apiArg) => {
  try {
    if (rootArg !== undefined && apiArg?.navigation) posModalApi = apiArg;
    const root = document.body;
    render(null, root);
    render(<ErrorBoundary><Extension /></ErrorBoundary>, root);
  } catch (e) {
    SHOPIFY?.toast?.show?.(`Render Error: ${e?.message ?? e}`);
  }
};
