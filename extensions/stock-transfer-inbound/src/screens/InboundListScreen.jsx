/**
 * 入庫リスト画面（完全版）
 * - 明細・予定外入荷(extras)・超過/不足・下書き・検索・スキャン・確定モーダル・一部入庫まで対応
 */
import { useState, useCallback, useEffect, useRef, useMemo } from "preact/hooks";
import { getStateSlice, readValue, toUserMessage, getStatusBadgeTone } from "../inboundHelpers.js";
import { useOriginLocationGid, useDebounce } from "../inboundHooks.js";
import {
  fetchInventoryShipmentEnriched,
  fetchPendingTransfersForDestination,
  fetchVariantAvailable,
  loadInboundDraft,
  saveInboundDraft,
  clearInboundDraft,
  readInboundAuditLog,
  buildInboundOverIndex_,
  buildInboundExtrasIndex_,
  buildInboundRejectedIndex_,
  mergeInboundOverIntoTransfers_,
  buildInboundOverItemIndex_,
  receiveShipmentWithFallbackV2,
  appendInventoryTransferNote_,
  buildInboundNoteLine_,
  appendInboundAuditLog,
  adjustInventoryAtLocationWithFallback,
  ensureInventoryActivatedAtLocation,
  searchVariants,
  resolveVariantByCode,
  VariantCache,
} from "../inboundApi.js";
import {
  toSafeId,
  calcQtyWidthPx_,
  StockyRowShell,
  ItemLeftCompact,
  InboundAddedLineRow,
  InboundCandidateRow,
  renderInboundShipmentItems_,
  renderExtras_,
  renderExtrasHistory_,
  renderConfirmMemo_,
} from "../InboundUiParts.jsx";
import { logInventoryChangeToApi } from "../../../../common/logInventoryChange.js";

const SHOPIFY = globalThis?.shopify ?? {};
const toast = (m) => SHOPIFY?.toast?.show?.(String(m));
const SCAN_QUEUE_KEY = "stock_transfer_pos_scan_queue_v1";

// TDZ 対策: コンポーネント内で定義すると minify で jt 等になり参照順でエラーになるためモジュールレベルに配置
function denyEdit_(toastReadOnlyOnceRef, toastFn) {
  if (!toastReadOnlyOnceRef || toastReadOnlyOnceRef.current) return;
  toastReadOnlyOnceRef.current = true;
  if (typeof toastFn === "function") toastFn("この入庫は入庫済みのため変更できません");
}

// TDZ 対策: モジュールレベルに配置（loadShipment / setRowQty / setAllToPlanned 等で参照）
function clampReceiveQty_(r, n) {
  const min = Math.max(0, Math.floor(Number(r?.alreadyAcceptedTotalQty ?? (Number(r?.alreadyAcceptedQty || 0) + Number(r?.overAcceptedQty || 0)))));
  const v = Math.max(min, Math.floor(Number(n || 0)));
  return v;
}

// TDZ 対策: モジュールレベルに配置（loadShipment / loadMultipleShipments 等で参照）
function safeSet(mountedRef, fn, signal) {
  if (!mountedRef?.current) return;
  if (signal?.aborted) return;
  fn?.();
}

// TDZ 対策: モジュールレベルに配置（loadMultipleShipments で参照）
function formatShipmentLabelLocal(transferName, index) {
  const base = String(transferName || "").trim() || "T0000";
  const match = base.match(/(\d+)$/);
  const numPart = match ? match[1] : base;
  return `#${numPart}-${index + 1}`;
}

// TDZ 対策（Jt エラー）: コンポーネント内の incRow/setRowQty/setExtraQty/incExtra が minify で Jt 等になり参照順でエラーになるためモジュールレベルに配置
function incRow_(readOnlyRef, toastReadOnlyOnceRef, toastFn, rowsRef, setRows, key, delta) {
  if (readOnlyRef?.current) return denyEdit_(toastReadOnlyOnceRef, toastFn);
  const min = (rowsRef?.current || []).find((r) => r.key === key)?.alreadyAcceptedTotalQty ?? 0;
  setRows((prev) =>
    prev.map((r) =>
      r.key === key
        ? { ...r, receiveQty: Math.max(Number(min || 0), Math.floor(Number(r.receiveQty ?? 0)) + delta) }
        : r
    )
  );
}
function setRowQty_(readOnlyRef, toastReadOnlyOnceRef, toastFn, rowsRef, setRows, key, qty) {
  if (readOnlyRef?.current) return denyEdit_(toastReadOnlyOnceRef, toastFn);
  const k = String(key || "").trim();
  const n = Math.max(0, Number(qty || 0));
  setRows((prev) =>
    prev.map((r) =>
      String(r.key) === k || String(r.shipmentLineItemId) === k
        ? { ...r, receiveQty: clampReceiveQty_(r, n) }
        : r
    )
  );
}
function setExtraQty_(readOnlyRef, toastReadOnlyOnceRef, toastFn, extrasRef, setExtras, key, value) {
  if (readOnlyRef?.current) return denyEdit_(toastReadOnlyOnceRef, toastFn);
  const n = Math.max(0, Number(value || 0));
  setExtras((prev) =>
    prev.map((x) => (x.key === key ? { ...x, receiveQty: n } : x)).filter((x) => Number(x.receiveQty || 0) > 0)
  );
}
function incExtra_(readOnlyRef, toastReadOnlyOnceRef, toastFn, extrasRef, setExtras, key, delta) {
  if (readOnlyRef?.current) return denyEdit_(toastReadOnlyOnceRef, toastFn);
  setExtras((prev) =>
    prev.map((x) => (x.key === key ? { ...x, receiveQty: Math.max(0, Number(x.receiveQty || 0) + delta) } : x)).filter((x) => Number(x.receiveQty || 0) > 0)
  );
}

// TDZ 対策（Ot 等）: clearAddSearch / handleShowMoreAddCandidates をモジュールレベルに配置（headerNode や JSX が参照するため minify で Ot 等になるのを防ぐ）
function clearAddSearch_(setAddQuery, setAddCandidates, setAddCandidatesDisplayLimit, setAddQtyById) {
  if (typeof setAddQuery === "function") setAddQuery("");
  if (typeof setAddCandidates === "function") setAddCandidates([]);
  if (typeof setAddCandidatesDisplayLimit === "function") setAddCandidatesDisplayLimit(20);
  if (typeof setAddQtyById === "function") setAddQtyById({});
}
function handleShowMoreAddCandidates_(setAddCandidatesDisplayLimit) {
  if (typeof setAddCandidatesDisplayLimit === "function") setAddCandidatesDisplayLimit((prev) => (typeof prev === "number" ? prev : 20) + 20);
}

// TDZ 対策（Ot 等）: loadExtrasHistory をモジュールレベルに配置（useEffect の依存配列で参照されるため minify で宣言順が逆になると TDZ になるのを防ぐ）
async function loadExtrasHistory_(shipmentId, locationGid, setExtrasHistory, setExtrasHistoryLoading, setConfirmMemo, readInboundAuditLogFn) {
  if (!shipmentId || !locationGid) {
    if (typeof setExtrasHistory === "function") setExtrasHistory([]);
    if (typeof setConfirmMemo === "function") setConfirmMemo(null);
    return;
  }
  if (typeof setExtrasHistoryLoading === "function") setExtrasHistoryLoading(true);
  try {
    const audit = await (typeof readInboundAuditLogFn === "function" ? readInboundAuditLogFn() : Promise.resolve([]));
    const auditEntries = (Array.isArray(audit) ? audit : [])
      .filter((e) => String(e?.shipmentId || "").trim() === String(shipmentId || "").trim() && String(e?.locationId || "").trim() === String(locationGid || "").trim())
      .sort((a, b) => new Date(b?.at || 0).getTime() - new Date(a?.at || 0).getTime());
    const latestEntry = auditEntries[0];
    if (typeof setConfirmMemo === "function") {
      if (latestEntry && String(latestEntry?.note || "").trim()) setConfirmMemo(String(latestEntry.note).trim());
      else setConfirmMemo(null);
    }
    const historyEntries = auditEntries.flatMap((e) => (Array.isArray(e?.extras) ? e.extras : []).map((x) => ({ ...x, at: e?.at || "", note: e?.note || "", reason: e?.reason || "" }))).filter((x) => x.inventoryItemId && x.qty > 0);
    if (typeof setExtrasHistory === "function") setExtrasHistory(historyEntries);
  } catch (e) {
    if (typeof setExtrasHistory === "function") setExtrasHistory([]);
    if (typeof setConfirmMemo === "function") setConfirmMemo(null);
  } finally {
    if (typeof setExtrasHistoryLoading === "function") setExtrasHistoryLoading(false);
  }
}

// TDZ 対策: setAllToPlanned / resetAllCounts をモジュールレベルに配置（headerNode が参照するため minify で jt/Jt になるのを防ぐ）
function setAllToPlanned_(readOnlyRef, toastReadOnlyOnceRef, toastFn, rowsRef, setRows) {
  if (readOnlyRef?.current) return denyEdit_(toastReadOnlyOnceRef, toastFn);
  setRows((prev) =>
    prev.map((r) => ({ ...r, receiveQty: clampReceiveQty_(r, Number(r.plannedQty || 0)) }))
  );
  if (typeof toastFn === "function") toastFn("全行を予定数でセットしました");
}
function resetAllCounts_(readOnlyRef, toastReadOnlyOnceRef, toastFn, setRows, setExtras, setReason, setNote, setAckWarning) {
  if (readOnlyRef?.current) return denyEdit_(toastReadOnlyOnceRef, toastFn);
  setRows((prev) => prev.map((r) => ({ ...r, receiveQty: clampReceiveQty_(r, 0) })));
  setExtras([]);
  setReason("");
  setNote("");
  setAckWarning(false);
  if (typeof toastFn === "function") toastFn("入庫数をリセットしました");
}

export function InboundListScreen({
  showImages,
  liteMode,
  onToggleLiteMode,
  appState,
  setAppState,
  settings,
  onBack,
  onAfterReceive,
  setHeader,
  setFooter,
}) {
  const mountedRef = useRef(true);
  const locationGid = useOriginLocationGid() || String(appState?.originLocationIdManual || "").trim() || null;
  const inbound = getStateSlice(appState, "inbound", {
    selectedShipmentId: "",
    selectedShipmentIds: [],
    shipmentMode: "single",
    selectedTransferId: "",
    selectedTransferName: "",
    selectedOriginName: "",
    selectedDestinationName: "",
    selectedReadOnly: false,
    selectedTransferTotalQuantity: 0,
    selectedTransferReceivedQuantity: 0,
    selectedOriginLocationId: "",
    selectedTransferStatus: "",
  });
  const ids = Array.isArray(inbound.selectedShipmentIds) ? inbound.selectedShipmentIds : [];
  const selectedShipmentId = String(inbound.selectedShipmentId || "").trim()
    || (ids.length > 0 ? String(ids[0]).trim() : "");
  const isMultipleMode = inbound.shipmentMode === "multiple" && ids.length > 1;

  // REFERENCE 8304-8320: 定数はコンポーネント内で定義（そのままコピー）
  const CONFIRM_RECEIVE_MODAL_ID = "CONFIRM_RECEIVE_MODAL_ID";
  const WARNING_REASONS = [
    { id: "over_received", label: "予定超過" },
    { id: "unplanned", label: "予定外入荷" },
    { id: "damage_replace", label: "破損" },
    { id: "other", label: "その他" },
  ];
  const DIFF_PREVIEW_LIMIT = 1;
  const oneLineStyle = {
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  };

  const [shipmentLoading, setShipmentLoading] = useState(false);
  const [shipmentError, setShipmentError] = useState("");
  const [shipment, setShipment] = useState(null);
  const [rows, setRows] = useState([]);
  const [extras, setExtras] = useState([]);
  const [lineItemsPageInfo, setLineItemsPageInfo] = useState({ hasNextPage: false, endCursor: null });
  const [loadingMore, setLoadingMore] = useState(false);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [ackWarning, setAckWarning] = useState(false);
  const [scanValue, setScanValue] = useState("");
  const [scanDisabled, setScanDisabled] = useState(false);
  const [scanQueueLen, setScanQueueLen] = useState(0);
  const [addQuery, setAddQuery] = useState("");
  const [addLoading, setAddLoading] = useState(false);
  const [addCandidates, setAddCandidates] = useState([]);
  const [addCandidatesDisplayLimit, setAddCandidatesDisplayLimit] = useState(50); // REFERENCE 同型: 初期表示50件（「さらに表示」で追加読み込み可能）
  const [addQtyById, setAddQtyById] = useState({});
  const [inbCandidateStockVersion, setInbCandidateStockVersion] = useState(0);
  const inbCandidateStockCacheRef = useRef(new Map());
  const inbCandidateStockFetchedRef = useRef(new Set());
  const [draftSavedAt, setDraftSavedAt] = useState(null);
  const [onlyUnreceived, setOnlyUnreceived] = useState(false);
  const [processLog, setProcessLog] = useState([]);
  const [extrasHistory, setExtrasHistory] = useState([]);
  const [extrasHistoryLoading, setExtrasHistoryLoading] = useState(false);
  const [confirmMemo, setConfirmMemo] = useState(null);
  const [receiveSubmitting, setReceiveSubmitting] = useState(false);
  const [pendingLoading, setPendingLoading] = useState(false);
  const [pendingTransfers, setPendingTransfers] = useState([]);

  const rowsRef = useRef([]);
  const extrasRef = useRef([]);
  const scanQueueRef = useRef([]);
  const scanProcessingRef = useRef(false);
  const scanPausedRef = useRef(false);
  const scanFinalizeTimerRef = useRef(null);
  const scanDisabledRef = useRef(false);
  const readOnlyRef = useRef(false);
  const toastReadOnlyOnceRef = useRef(false);
  const receiveLockRef = useRef(false);

  const lastScanValueRef = useRef("");
  const lastScanChangeAtRef = useRef(0);

  const debouncedAddQuery = useDebounce(addQuery.trim(), 200);

  const productFirst = Math.max(1, Math.min(250, Number(settings?.productList?.initialLimit ?? 250)));
  const searchLimit = Math.max(10, Math.min(50, Number((appState?.outbound?.settings ?? settings)?.searchList?.initialLimit ?? 50)));

  // REFERENCE 5.2 #4: pendingTransfers から「現在の shipment を含む Transfer」を transferForShipment として算出（refresh 後に最新の total/received が反映される）
  const normalizeId_ = (v) => String(v || "").trim().split("/").pop();
  const transferForShipment = useMemo(() => {
    const sidRaw = String(shipment?.id || selectedShipmentId || "").trim();
    if (!sidRaw) return null;
    const sidNorm = normalizeId_(sidRaw);
    const p = Array.isArray(pendingTransfers) ? pendingTransfers : [];
    return (
      p.find((t) => {
        const ships = Array.isArray(t?.shipments) ? t.shipments : [];
        return ships.some((s) => {
          const idRaw = String(s?.id || "").trim();
          if (!idRaw) return false;
          return idRaw === sidRaw || normalizeId_(idRaw) === sidNorm;
        });
      }) || null
    );
  }, [pendingTransfers, shipment?.id, selectedShipmentId]);

  // REFERENCE 5.2 #4: transferId は transferForShipment 優先で refresh 後に最新化
  const transferId = String(transferForShipment?.id || inbound?.selectedTransferId || "").trim();

  const readOnly = useMemo(() => {
    if (String(shipment?.status || "").toUpperCase() === "RECEIVED") return true;
    if (String(shipment?.status || "").toUpperCase() === "TRANSFERRED") return true;
    if (!!inbound?.selectedReadOnly) return true;
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
    transferForShipment?.receivedQuantityDisplay,
  ]);

  // まとめて表示用：各シップメントの処理済み（入庫済み）判定
  const shipmentIdToReadOnly = useMemo(() => {
    const map = new Map();
    const ships = Array.isArray(transferForShipment?.shipments) ? transferForShipment.shipments : [];
    ships.forEach((s) => {
      const sid = String(s?.id || "").trim();
      const status = String(s?.status || "").toUpperCase();
      const isReadOnly = status === "RECEIVED" || status === "TRANSFERRED";
      if (sid) {
        map.set(sid, isReadOnly);
        map.set(normalizeId_(sid), isReadOnly);
      }
    });
    return map;
  }, [transferForShipment?.shipments]);

  useEffect(() => {
    rowsRef.current = Array.isArray(rows) ? rows : [];
  }, [rows]);
  useEffect(() => {
    extrasRef.current = Array.isArray(extras) ? extras : [];
  }, [extras]);
  useEffect(() => { scanDisabledRef.current = scanDisabled; }, [scanDisabled]);
  useEffect(() => {
    readOnlyRef.current = readOnly;
    if (!readOnly) toastReadOnlyOnceRef.current = false;
  }, [readOnly]);

  useEffect(() => { VariantCache.init?.().catch(() => {}); }, []);

  // TDZ 対策（Ot）: waitForOk の依存配列に [dialog] があるため、dialog は waitForOk より前に定義する必要がある（minify で dialog→Ot になり参照が先になると TDZ）
  const dialog = useMemo(() => ({}), []);

  // REFERENCE 8462: mountedRef とスキャン用 ref のクリーンアップ（denyEdit_ 直後の useEffects の並びを一致）
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      scanPausedRef.current = true;
      scanQueueRef.current = [];
      scanProcessingRef.current = false;
      try {
        if (scanFinalizeTimerRef.current) clearTimeout(scanFinalizeTimerRef.current);
      } catch (_) {}
    };
  }, []);

  const refreshPending = async () => {
    if (!locationGid) return;
    setPendingLoading(true);
    try {
      const listLimit = Math.max(1, Math.min(250, Number(appState?.outbound?.settings?.inbound?.listInitialLimit ?? settings?.inbound?.listInitialLimit ?? 100)));
      const data = await fetchPendingTransfersForDestination(locationGid, { first: listLimit });
      let list = Array.isArray(data) ? data : [];
      try {
        const audit = await readInboundAuditLog();
        const overIndex = buildInboundOverIndex_(audit, { locationId: locationGid });
        const extrasIndex = buildInboundExtrasIndex_(audit, { locationId: locationGid });
        const shipmentIds = list.flatMap((t) => 
          (Array.isArray(t?.shipments) ? t.shipments : [])
            .map((s) => String(s?.id || "").trim())
            .filter(Boolean)
        );
        const rejectedIndex = await buildInboundRejectedIndex_(shipmentIds);
        list = mergeInboundOverIntoTransfers_(list, overIndex, extrasIndex, rejectedIndex);
      } catch (_) {}
      setPendingTransfers(list);
    } catch {
      setPendingTransfers([]);
    } finally {
      setPendingLoading(false);
    }
  };

  useEffect(() => {
    if (!locationGid) return;
    refreshPending().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationGid]);

  // REFERENCE 8509: loadShipment そのままコピー（toast・first なし・baseRows で over 一括）
  const loadShipment = async (id, { signal } = {}) => {
    const shipmentId = String(id || "").trim();
    if (!shipmentId) return toast("Shipment ID が空です");
    if (!locationGid) return;

    safeSet(mountedRef, () => {
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
      } catch (_) {}
      scanQueueRef.current = [];
      scanProcessingRef.current = false;
      scanPausedRef.current = false;
      setScanDisabled(false);
      setShipmentLoading(true);
      setLineItemsPageInfo({ hasNextPage: false, endCursor: null });
    }, signal);

    try {
      const shipmentResult = await fetchInventoryShipmentEnriched(shipmentId, {
        includeImages: showImages && !liteMode,
        signal,
      });
      const s = shipmentResult || {};
      const pageInfo = shipmentResult?.pageInfo || { hasNextPage: false, endCursor: null };
      safeSet(mountedRef, () => setLineItemsPageInfo(pageInfo), signal);

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

      const baseRows = (s.lineItems ?? []).map((li) => {
        const plannedQty = Number(li.quantity ?? 0);
        const alreadyAcceptedQty = Math.max(0, Number(li.acceptedQuantity ?? 0));
        const alreadyRejectedQty = Math.max(0, Number(li.rejectedQuantity ?? 0));
        const inventoryItemId = li.inventoryItemId;
        const overAcceptedQty = Math.max(
          0,
          Math.floor(Number(inventoryItemId ? overByInventoryItemId.get(String(inventoryItemId)) || 0 : 0))
        );
        const alreadyAcceptedTotalQty = alreadyAcceptedQty;
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
          alreadyAcceptedQty,
          alreadyRejectedQty,
          overAcceptedQty,
          alreadyAcceptedTotalQty,
          receiveQty: initialReceiveQty,
        };
      });

      const transferIdLocal = String(inbound?.selectedTransferId || "").trim();
      let draft = null;
      try {
        draft = await loadInboundDraft({ locationGid, transferId: transferIdLocal, shipmentId: s.id });
      } catch (_) {
        draft = null;
      }

      safeSet(mountedRef, () => {
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
      safeSet(mountedRef, () => setShipmentError(toUserMessage(e)), signal);
    } finally {
      safeSet(mountedRef, () => setShipmentLoading(false), signal);
    }
  };

  const loadShipmentById = loadShipment;

  const loadMultipleShipments = useCallback(async (shipmentIdsArg, { signal } = {}) => {
    const shipmentIds = Array.isArray(shipmentIdsArg) ? shipmentIdsArg : [];
    if (shipmentIds.length === 0 || !locationGid) return;
    safeSet(mountedRef, () => {
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
      } catch (_) {}
      scanQueueRef.current = [];
      scanProcessingRef.current = false;
      scanPausedRef.current = false;
      setScanDisabled(false);
      setShipmentLoading(true);
      setLineItemsPageInfo({ hasNextPage: false, endCursor: null });
    }, signal);

    try {
      const transferName = String(inbound.selectedTransferName || "").trim();
      const results = await Promise.all(
        shipmentIds.map((id) =>
          fetchInventoryShipmentEnriched(id, {
            includeImages: showImages && !liteMode,
            signal,
          })
        )
      );
      let draft = null;
      try {
        draft = await loadInboundDraft({ locationGid, transferId, shipmentId: shipmentIds[0] });
      } catch (_) {}

      const allRows = results.flatMap((s, index) => {
        if (!s) return [];
        const shipmentLabel = formatShipmentLabelLocal(transferName, index);
        return (s.lineItems ?? []).map((li) => {
          const plannedQty = Number(li.quantity ?? 0);
          const alreadyAcceptedQty = Math.max(0, Number(li.acceptedQuantity ?? 0));
          const alreadyRejectedQty = Math.max(0, Number(li.rejectedQuantity ?? 0));
          const overAcceptedQty = 0;
          const alreadyAcceptedTotalQty = alreadyAcceptedQty;
          let initialReceiveQty = alreadyAcceptedTotalQty;
          if (draft && Array.isArray(draft.rows)) {
            const savedRow = draft.rows.find((r) => {
              if (r.shipmentId) {
                return String(r.shipmentId) === String(s.id) && String(r.shipmentLineItemId) === String(li.id);
              }
              return String(r.shipmentLineItemId) === String(li.id);
            });
            if (savedRow) {
              initialReceiveQty = Math.max(0, Math.floor(Number(savedRow.receiveQty || 0)));
            }
          }
          return {
            key: `${s.id}-${li.id}`,
            shipmentLineItemId: li.id,
            shipmentId: s.id,
            shipmentLabel,
            inventoryItemId: li.inventoryItemId,
            title: li.title || li.sku || li.inventoryItemId || "(unknown)",
            sku: li.sku || "",
            barcode: li.barcode || "",
            imageUrl: li.imageUrl || "",
            plannedQty,
            alreadyAcceptedQty,
            alreadyRejectedQty,
            overAcceptedQty,
            alreadyAcceptedTotalQty,
            receiveQty: initialReceiveQty,
          };
        });
      });

      safeSet(mountedRef, () => {
        setShipment(results[0] || null);
        setRows(allRows);
        setShipmentError("");
        if (draft) {
          setExtras(Array.isArray(draft.extras) ? draft.extras.map((x, i) => ({
            key: x.key || `extra-${i}-${x.inventoryItemId || ""}`,
            inventoryItemId: String(x.inventoryItemId || "").trim(),
            title: x.title || x.sku || "(unknown)",
            sku: x.sku || "",
            barcode: x.barcode || "",
            imageUrl: x.imageUrl || "",
            receiveQty: Math.max(0, Number(x.receiveQty || 0)),
          })) : []);
          setOnlyUnreceived(!!draft.onlyUnreceived);
          setReason(String(draft.reason || ""));
          setNote(String(draft.note || ""));
          setAckWarning(false);
          setDraftSavedAt(draft.savedAt || null);
          toast("下書きを復元しました");
        }
      }, signal);

      safeSet(mountedRef, () => setShipmentLoading(false), signal);

      // 二相ロード: 非同期で監査ログ over を反映
      try {
        const audit = await readInboundAuditLog();
        if (signal?.aborted) return;
        let overByInventoryItemId = new Map();
        shipmentIds.forEach((sid) => {
          const itemOver = buildInboundOverItemIndex_(audit, { locationId: locationGid, shipmentId: sid });
          itemOver.forEach((value, key) => {
            overByInventoryItemId.set(key, (overByInventoryItemId.get(key) || 0) + value);
          });
        });
        safeSet(mountedRef, () => {
          setRows((prev) => prev.map((r) => {
            const overAcceptedQty = Math.max(0, Math.floor(Number(r.inventoryItemId ? overByInventoryItemId.get(String(r.inventoryItemId)) || 0 : 0)));
            return { ...r, overAcceptedQty };
          }));
        }, signal);
      } catch (_) {}
    } catch (e) {
      if (signal?.aborted) return;
      safeSet(mountedRef, () => {
        setShipmentError(toUserMessage(e));
        setShipmentLoading(false);
      }, signal);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  // formatShipmentLabelLocal はモジュールレベルで安定参照のため依存から除外
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showImages, liteMode, locationGid]);

  const loadMoreLineItems_ = useCallback(async () => {
    if (loadingMore || !lineItemsPageInfo?.hasNextPage || !lineItemsPageInfo?.endCursor || !selectedShipmentId || !locationGid) return;
    setLoadingMore(true);
    const ac = new AbortController();
    try {
      const result = await fetchInventoryShipmentEnriched(selectedShipmentId, {
        includeImages: showImages && !liteMode,
        after: lineItemsPageInfo.endCursor,
        signal: ac.signal,
      });
      const newShip = result || {};
      const newLineItems = Array.isArray(newShip?.lineItems) ? newShip.lineItems : [];
      const newPageInfo = newShip?.pageInfo || { hasNextPage: false, endCursor: null };
      let overByInventoryItemId = new Map();
      try {
        if (locationGid) {
          const audit = await readInboundAuditLog();
          overByInventoryItemId = buildInboundOverItemIndex_(audit, { locationId: locationGid, shipmentId: newShip?.id || selectedShipmentId });
        }
      } catch (_) {
        overByInventoryItemId = new Map();
      }
      const newBaseRows = newLineItems.map((li) => {
        const plannedQty = Number(li.quantity ?? 0);
        const alreadyAcceptedQty = Math.max(0, Number(li.acceptedQuantity ?? 0));
        const alreadyRejectedQty = Math.max(0, Number(li.rejectedQuantity ?? 0));
        const inventoryItemId = li.inventoryItemId;
        const overAcceptedQty = Math.max(
          0,
          Math.floor(Number(inventoryItemId ? overByInventoryItemId.get(String(inventoryItemId)) || 0 : 0))
        );
        const alreadyAcceptedTotalQty = alreadyAcceptedQty;
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
          alreadyAcceptedQty,
          alreadyRejectedQty,
          overAcceptedQty,
          alreadyAcceptedTotalQty,
          receiveQty: initialReceiveQty,
        };
      });
      const existingMap = new Map();
      (rowsRef.current || []).forEach((r) => { if (r.shipmentLineItemId) existingMap.set(r.shipmentLineItemId, r); });
      newBaseRows.forEach((r) => { if (!existingMap.has(r.shipmentLineItemId)) existingMap.set(r.shipmentLineItemId, r); });
      setRows(Array.from(existingMap.values()));
      setLineItemsPageInfo(newPageInfo);
    } catch (e) {
      toast(`追加読み込みエラー: ${toUserMessage(e)}`);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, lineItemsPageInfo, selectedShipmentId, locationGid, showImages, liteMode]);

  // 依存を安定化: ids の参照ではなく内容で比較（毎レンダーで ids が新配列だと effect が連打され読み込みが完了しない）
  const idsKey = Array.isArray(inbound.selectedShipmentIds) && inbound.selectedShipmentIds.length
    ? inbound.selectedShipmentIds.join(",")
    : "";

  useEffect(() => {
    if (isMultipleMode) {
      if (ids.length === 0) {
        setShipment(null);
        setRows([]);
        setExtras([]);
        setShipmentError("");
        setLineItemsPageInfo({ hasNextPage: false, endCursor: null });
        return;
      }
      if (ids.length > 1) {
        const ac = new AbortController();
        const selectedShipmentIds = Array.isArray(inbound.selectedShipmentIds) ? inbound.selectedShipmentIds : [];
        (async () => {
          await loadMultipleShipments(selectedShipmentIds, { signal: ac.signal });
        })();
        return () => ac.abort();
      }
    }
    if (!selectedShipmentId) {
      setShipment(null);
      setRows([]);
      setExtras([]);
      setShipmentError("");
      setLineItemsPageInfo({ hasNextPage: false, endCursor: null });
      return;
    }
    const ac = new AbortController();
    (async () => {
      await loadShipment(selectedShipmentId, { signal: ac.signal });
    })();
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMultipleMode, idsKey, selectedShipmentId]);

  useEffect(() => {
    if (!locationGid || shipmentLoading || readOnlyRef.current) return;
    const tid = transferId.trim();
    const sid = shipment?.id || (isMultipleMode && ids.length > 0 ? ids[0] : "");
    if (!tid && !sid) return;
    const timer = setTimeout(() => {
      (async () => {
        try {
          const payload = {
            savedAt: new Date().toISOString(),
            transferId: tid || null,
            shipmentId: sid,
            rows: (rowsRef.current || []).map((r) => ({ shipmentLineItemId: r.shipmentLineItemId, receiveQty: Number(r.receiveQty || 0) })),
            extras: Array.isArray(extrasRef.current) ? extrasRef.current : [],
            onlyUnreceived: !!onlyUnreceived,
            reason: String(reason || ""),
            note: String(note || ""),
          };
          const ok = await saveInboundDraft({ locationGid, transferId: tid, shipmentId: payload.shipmentId, payload });
          if (ok && mountedRef.current) setDraftSavedAt(payload.savedAt);
        } catch (_) {}
      })();
    }, 300);
    return () => clearTimeout(timer);
  }, [locationGid, shipment && shipment.id, transferId, isMultipleMode, ids, onlyUnreceived, reason, note, rows, extras]);

  const overRows = rows
    .map((r) => {
      const planned = Number(r.plannedQty || 0);
      const want = Number(r.receiveQty || 0);
      const over = Math.max(0, want - planned);
      return over > 0
        ? { shipmentLineItemId: r.shipmentLineItemId, title: r.title, overQty: over, inventoryItemId: r.inventoryItemId, sku: r.sku }
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

  // 追加：不足（予定 > 受領 の差分合計）
  const shortageQtyTotal = (Array.isArray(rows) ? rows : []).reduce((a, r) => {
    const planned = Number(r.plannedQty || 0);
    const received = Number(r.receiveQty || 0);
    return a + Math.max(0, planned - received);
  }, 0);

  // 警告：予定外 / 超過 / 不足 のいずれかがあれば warning 扱い
  const hasWarning =
    overRows.length > 0 ||
    extras.length > 0 ||
    shortageQtyTotal > 0;

  // TDZ 対策: incRow/setRowQty/setExtraQty/incExtra はモジュールレベル（incRow_/setRowQty_/setExtraQty_/incExtra_）に移し、呼び出し時は ref/setter を渡す

  const bumpInbCandidateStock = useCallback(() => {
    setInbCandidateStockVersion((v) => v + 1);
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

  const addOrIncrementByResolved = useCallback((resolved, delta = 1, opts = {}) => {
    if (readOnlyRef.current) return denyEdit_(toastReadOnlyOnceRef, toast);
    const inventoryItemId = resolved?.inventoryItemId;
    if (!inventoryItemId) { toast("inventoryItemId が取得できませんでした"); return; }
    const titleForToast = String(resolved.productTitle || "").trim() || resolved.sku || "(no title)";
    const existing = (rowsRef.current || []).find((r) => String(r.inventoryItemId || "") === String(inventoryItemId));
    if (existing) {
      incRow_(readOnlyRef, toastReadOnlyOnceRef, toast, rowsRef, setRows, existing.key, delta);
      toast(`${titleForToast} を追加しました（+${delta}）`);
      return;
    }
    const key = `extra-${inventoryItemId}-${Date.now()}`;
    const cur = (extrasRef.current || []).find((x) => String(x.inventoryItemId) === String(inventoryItemId));
    if (cur) {
      incExtra_(readOnlyRef, toastReadOnlyOnceRef, toast, extrasRef, setExtras, cur.key, delta);
      if (opts.toastOnExtra) {
        const title = String(cur.title || "").trim() || resolved.productTitle || resolved.variantTitle || resolved.sku || inventoryItemId;
        toast(`予定外入荷に追加：${title}（+${delta}）`);
      }
      return;
    }
    const title = `${String(resolved.productTitle || "").trim()} / ${String(resolved.variantTitle || "").trim()}`.trim() || resolved.sku || inventoryItemId;
    if (opts.toastOnExtra) toast(`予定外入荷に追加：${title}（+${delta}）`);
    setExtras((prev) => [...prev, {
      key,
      inventoryItemId,
      title: title || resolved.sku || "(unknown)",
      sku: resolved.sku || "",
      barcode: resolved.barcode || "",
      imageUrl: resolved.imageUrl || "",
      receiveQty: Math.max(0, delta),
    }]);
  }, []);

  useEffect(() => {
    let alive = true;
    const q = String(debouncedAddQuery || "").trim();
    if (q.length < 1) {
      if (alive) { setAddCandidates([]); setAddCandidatesDisplayLimit(20); }
      return;
    }
    (async () => {
      try {
        if (alive) setAddLoading(true);
        const list = await searchVariants(q, { first: searchLimit, includeImages: Boolean(showImages && !liteMode) });
        if (!alive) return;
        setAddCandidates(Array.isArray(list) ? list : []);
        setAddCandidatesDisplayLimit(20);
      } catch (e) {
        if (alive) setAddCandidates([]);
      } finally {
        if (alive) setAddLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [debouncedAddQuery, showImages, liteMode, searchLimit]);

  const waitForOk = useCallback(async (title, msg) => {
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
  }, [dialog]);

  const kickProcessScanQueue = useCallback(async () => {
    if (scanProcessingRef.current || scanPausedRef.current) return;
    scanProcessingRef.current = true;
    try {
      while (scanQueueRef.current.length > 0 && mountedRef.current && !scanPausedRef.current) {
        const code = String(scanQueueRef.current.shift() || "").trim();
        if (!code) continue;
        setScanQueueLen(scanQueueRef.current.length);
        if (!shipment?.id) {
          await waitForOk("スキャンできません", "先に配送を読み込んでください。");
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
      }
    } finally {
      scanProcessingRef.current = false;
      if (!scanPausedRef.current && scanQueueRef.current.length > 0) kickProcessScanQueue();
    }
  }, [shipment && shipment.id, showImages, liteMode, addOrIncrementByResolved, waitForOk]);

  const scanFinalizeSoon = useCallback((nextValue) => {
    const next = String(nextValue ?? "").trim();
    lastScanValueRef.current = next;
    lastScanChangeAtRef.current = Date.now();
    if (scanFinalizeTimerRef.current) clearTimeout(scanFinalizeTimerRef.current);
    const FINALIZE_MS = 180;
    scanFinalizeTimerRef.current = setTimeout(() => {
      if (scanDisabledRef.current) return;
      const latest = String(lastScanValueRef.current || "").trim();
      if (!latest || latest.length < 6 || Date.now() - (lastScanChangeAtRef.current || 0) < FINALIZE_MS - 5) return;
      setScanValue("");
      lastScanValueRef.current = "";
      scanQueueRef.current.push(latest);
      setScanQueueLen(scanQueueRef.current.length);
      kickProcessScanQueue();
    }, FINALIZE_MS);
  }, [kickProcessScanQueue]);

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      if (stop || !SHOPIFY?.storage?.get || !SHOPIFY?.storage?.set) return;
      const q = (await SHOPIFY.storage.get(SCAN_QUEUE_KEY)) || {};
      const list = Array.isArray(q.items) ? q.items : [];
      if (list.length === 0) return;
      const head = String(list[0] || "").trim();
      const rest = list.slice(1);
      await SHOPIFY.storage.set(SCAN_QUEUE_KEY, { ...q, items: rest, updatedAt: Date.now() });
      if (!head) return;
      scanQueueRef.current.push(head);
      setScanQueueLen(scanQueueRef.current.length);
      kickProcessScanQueue();
    };
    const t = setInterval(() => { tick().catch(() => {}); }, 100);
    return () => { stop = true; clearInterval(t); };
  }, [shipment && shipment.id, kickProcessScanQueue]);

  const plannedTotal = rows.reduce((a, r) => a + Number(r.plannedQty || 0), 0);
  const receiveTotal = rows.reduce((a, r) => a + Number(r.receiveQty || 0), 0);

  // 確定できる条件（Shipmentあり + 処理中でない + スキャン停止でない）
  const canConfirm = !!shipment?.id && !receiveSubmitting && !scanDisabled && !readOnly;

  const warningReady = !hasWarning ? true : !!ackWarning; // 警告がある時だけ確認(ack)必須

  // モーダルを開ける条件（確定可能 + warning条件が揃っている）
  const canOpenConfirm = canConfirm;

  // 表示対象行（未受領のみフィルタ）
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

  // REFERENCE 同様: 確定処理（単一/複数シップメント・予定外・超過不足・出庫元マイナス・在庫調整履歴メモ）
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
    if (hasWarning && !ackWarning) {
      toast("差異があります。内容を確認してから確定してください。");
      return false;
    }
    if (receiveLockRef.current) return false;
    receiveLockRef.current = true;
    setReceiveSubmitting(true);

    const noteText = String(note || "").trim();
    const overForLog = (overRows || []).map((x) => ({
      inventoryItemId: String(x?.inventoryItemId || "").trim(),
      qty: Math.max(0, Math.floor(Number(x?.overQty || 0))),
      title: String(x?.title || "").trim(),
      sku: String(x?.sku ?? "").trim(),
    })).filter((x) => x.inventoryItemId && x.qty > 0);
    const extrasMap = new Map();
    (extras || []).forEach((x) => {
      const id = String(x?.inventoryItemId || "").trim();
      if (id) extrasMap.set(id, { title: String(x?.title || x?.sku || "(unknown)").trim(), inventoryItemId: id, sku: String(x?.sku || "").trim(), barcode: String(x?.barcode || "").trim(), imageUrl: String(x?.imageUrl || "").trim() });
    });
    const extrasForLog = (extras || []).map((x) => {
      const id = String(x?.inventoryItemId || "").trim();
      const meta = extrasMap.get(id) || {};
      return { inventoryItemId: id, qty: Math.max(0, Math.floor(Number(x?.receiveQty || 0))), title: meta.title || id, sku: meta.sku || "", barcode: meta.barcode || "", imageUrl: meta.imageUrl || "" };
    }).filter((x) => x.inventoryItemId && x.qty > 0);
    const hasSomething = noteText.length > 0 || (Array.isArray(overForLog) && overForLog.length > 0) || (Array.isArray(extrasForLog) && extrasForLog.length > 0);

    try {
      if (transferId && hasSomething) {
        const noteLine = buildInboundNoteLine_({ shipmentId: shipment.id, locationId: locationGid, finalize, note: noteText, over: overForLog, extras: extrasForLog });
        if (String(noteLine || "").trim()) {
          const addProcessLog = () => {}; // REFERENCE 5.2 #6: デバッグ用（空関数でログ記録なし）
          const ok = await appendInventoryTransferNote_({ transferId, line: noteLine, processLogCallback: addProcessLog });
          if (!ok) toast("管理画面メモへの追記に失敗しました（確定処理は続行します）");
        }
      }

      let extraDeltasMerged;
      let rejectedDeltas = [];
      const extraDeltas = (extras || []).map((x) => ({
        inventoryItemId: String(x?.inventoryItemId || "").trim(),
        delta: Math.max(0, Math.floor(Number(x?.receiveQty || 0))),
      })).filter((x) => x.inventoryItemId && x.delta > 0);

      if (!isMultipleMode) {
        const rejectedItems = finalize ? (shortageRows || []).map((r) => ({
          shipmentLineItemId: String(r.shipmentLineItemId || "").trim(),
          quantity: Math.max(0, Math.floor(Number(r.shortageQty || 0))),
          reason: "REJECTED",
        })).filter((x) => x.shipmentLineItemId && x.quantity > 0) : [];
        const plannedItems = rows.map((r) => {
          const shipmentLineItemId = String(r.shipmentLineItemId || "").trim();
          const targetAccepted = Math.max(0, Math.floor(Number(r.receiveQty || 0)));
          const alreadyAccepted = Math.max(0, Math.floor(Number(r.alreadyAcceptedQty || 0)));
          const alreadyOver = Math.max(0, Math.floor(Number(r.overAcceptedQty || 0)));
          const alreadyTotal = alreadyAccepted + alreadyOver;
          const delta = Math.max(0, targetAccepted - alreadyTotal);
          return { shipmentLineItemId, quantity: delta };
        }).filter((x) => x.shipmentLineItemId && x.quantity > 0);
        const hasAnyAction = plannedItems.length > 0 || extraDeltas.length > 0 || rejectedItems.length > 0;
        if (!hasAnyAction) {
          toast(finalize ? "送信する差分がありません" : "一部入庫として送る差分がありません");
          return false;
        }
        extraDeltasMerged = extraDeltas;

        let receivedItemsForLog = [];
        if (plannedItems.length > 0) {
          try {
            await receiveShipmentWithFallbackV2({ shipmentId: shipment.id, items: plannedItems });
            receivedItemsForLog = plannedItems;
          } catch (e) {
            const msg = String(e?.message || e || "");
            if (!/quantity|unreceived|exceed|max|greater|less/i.test(msg)) throw e;
            const overflowMap = new Map();
            const cappedItems = rows.map((r) => {
              const shipmentLineItemId = String(r.shipmentLineItemId || "").trim();
              const inventoryItemId = String(r.inventoryItemId || "").trim();
              const planned = Math.max(0, Math.floor(Number(r.plannedQty || 0)));
              const alreadyRejected = Math.max(0, Math.floor(Number(r.alreadyRejectedQty || 0)));
              const alreadyAccepted = Math.max(0, Math.floor(Number(r.alreadyAcceptedQty || 0)));
              const alreadyOver = Math.max(0, Math.floor(Number(r.overAcceptedQty || 0)));
              const alreadyTotal = alreadyAccepted + alreadyOver;
              const targetAccepted = Math.max(0, Math.floor(Number(r.receiveQty || 0)));
              const wantDelta = Math.max(0, targetAccepted - alreadyTotal);
              const remainingReceivable = Math.max(0, planned - alreadyRejected - alreadyAccepted);
              const deltaPlanned = Math.min(remainingReceivable, wantDelta);
              const overflow = Math.max(0, wantDelta - deltaPlanned);
              if (overflow > 0 && inventoryItemId) overflowMap.set(inventoryItemId, (overflowMap.get(inventoryItemId) || 0) + overflow);
              return { shipmentLineItemId, quantity: deltaPlanned };
            }).filter((x) => x.shipmentLineItemId && x.quantity > 0);
            if (cappedItems.length > 0) {
              await receiveShipmentWithFallbackV2({ shipmentId: shipment.id, items: cappedItems });
              receivedItemsForLog = cappedItems;
            }
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
              extraDeltasMerged = Array.from(m.entries()).map(([inventoryItemId, delta]) => ({ inventoryItemId, delta }));
            }
          }
        }
        if (receivedItemsForLog.length > 0) {
          const transferIdStr = String(transferId || "").trim();
          const transferIdMatch = transferIdStr.match(/(\d+)$/);
          const transferIdForUri = transferIdMatch ? transferIdMatch[1] : transferIdStr;
          const inboundDeltas = receivedItemsForLog.map((p) => {
            const row = rows.find((r) => String(r.shipmentLineItemId || "").trim() === String(p.shipmentLineItemId || "").trim());
            return row ? { inventoryItemId: String(row.inventoryItemId || "").trim(), delta: p.quantity } : null;
          }).filter((d) => d && d.inventoryItemId && d.delta > 0);
          if (inboundDeltas.length > 0) {
            await logInventoryChangeToApi({ activity: "inbound_transfer", locationId: locationGid, locationName: "", deltas: inboundDeltas, sourceId: transferIdForUri });
          }
        }

        if (finalize && rejectedItems.length > 0) {
          await receiveShipmentWithFallbackV2({ shipmentId: shipment.id, items: rejectedItems });
          const originLocationId = String(transferForShipment?.originLocationId || transferForShipment?.origin?.location?.id || inbound?.selectedOriginLocationId || "").trim() || null;
          if (originLocationId) {
            rejectedDeltas = rejectedItems.map((rejected) => {
              const row = rows.find((r) => String(r.shipmentLineItemId || "").trim() === String(rejected.shipmentLineItemId || "").trim());
              if (!row) return null;
              return {
                inventoryItemId: String(row.inventoryItemId || "").trim(),
                delta: Math.max(0, Math.floor(Number(rejected.quantity || 0))),
                sku: String(row.sku || "").trim(),
                title: String(row.title || "").trim(),
              };
            }).filter((d) => d && d.inventoryItemId && d.delta > 0);
            if (rejectedDeltas.length > 0) {
              await ensureInventoryActivatedAtLocation({ locationId: originLocationId, inventoryItemIds: rejectedDeltas.map((d) => d.inventoryItemId) });
              // transferIdからID部分を抽出（GID形式の場合は末尾の数字部分を取得）
              const transferIdStr = String(transferId || "").trim();
              const transferIdMatch = transferIdStr.match(/(\d+)$/);
              const transferIdForUri = transferIdMatch ? transferIdMatch[1] : transferIdStr;
              await adjustInventoryAtLocationWithFallback({ 
                locationId: originLocationId, 
                deltas: rejectedDeltas.map((d) => ({ inventoryItemId: d.inventoryItemId, delta: d.delta })),
                referenceDocumentUri: transferIdForUri || null
              });
              await logInventoryChangeToApi({
                activity: "inbound_transfer",
                locationId: originLocationId,
                locationName: "",
                deltas: rejectedDeltas.map((d) => ({ inventoryItemId: d.inventoryItemId, delta: d.delta, sku: d.sku })),
                sourceId: transferIdForUri,
              });
            }
          }
        }
      } else {
        const rowByLineId = new Map();
        (rows || []).forEach((r) => {
          const lid = String(r.shipmentLineItemId || "").trim();
          if (lid) rowByLineId.set(lid, r);
        });
        const byShipment = new Map();
        (rows || []).forEach((r) => {
          const sid = String(r.shipmentId || "").trim();
          if (!sid) return;
          if (!byShipment.has(sid)) byShipment.set(sid, []);
          byShipment.get(sid).push(r);
        });
        let hasAnyPlanned = false;
        let hasAnyRejected = false;
        const plannedByShip = new Map();
        const rejectedByShip = new Map();
        byShipment.forEach((sRows, sid) => {
          const plannedItems = sRows.map((r) => {
            const shipmentLineItemId = String(r.shipmentLineItemId || "").trim();
            const targetAccepted = Math.max(0, Math.floor(Number(r.receiveQty || 0)));
            const alreadyAccepted = Math.max(0, Math.floor(Number(r.alreadyAcceptedQty || 0)));
            const alreadyOver = Math.max(0, Math.floor(Number(r.overAcceptedQty || 0)));
            const alreadyTotal = alreadyAccepted + alreadyOver;
            const delta = Math.max(0, targetAccepted - alreadyTotal);
            return { shipmentLineItemId, quantity: delta };
          }).filter((x) => x.shipmentLineItemId && x.quantity > 0);
          if (plannedItems.length > 0) hasAnyPlanned = true;
          plannedByShip.set(sid, plannedItems);
          const shipShortage = (shortageRows || []).filter((sr) => {
            const row = rowByLineId.get(String(sr.shipmentLineItemId || "").trim());
            return row && String(row.shipmentId || "").trim() === sid;
          });
          const rejectedItems = finalize ? shipShortage.map((r) => ({
            shipmentLineItemId: String(r.shipmentLineItemId || "").trim(),
            quantity: Math.max(0, Math.floor(Number(r.shortageQty || 0))),
            reason: "REJECTED",
          })).filter((x) => x.shipmentLineItemId && x.quantity > 0) : [];
          if (rejectedItems.length > 0) hasAnyRejected = true;
          rejectedByShip.set(sid, rejectedItems);
        });
        const hasAnyAction = hasAnyPlanned || extraDeltas.length > 0 || (finalize && hasAnyRejected);
        if (!hasAnyAction) {
          toast(finalize ? "送信する差分がありません" : "一部入庫として送る差分がありません");
          return false;
        }
        const overflowMap = new Map();
        const multiReceivedDeltas = [];
        for (const [sid, sRows] of byShipment) {
          const plannedItems = plannedByShip.get(sid) || [];
          if (plannedItems.length === 0) continue;
          try {
            await receiveShipmentWithFallbackV2({ shipmentId: sid, items: plannedItems });
            for (const p of plannedItems) {
              const row = rowByLineId.get(String(p.shipmentLineItemId || "").trim());
              if (row) multiReceivedDeltas.push({ inventoryItemId: String(row.inventoryItemId || "").trim(), delta: p.quantity });
            }
          } catch (e) {
            const msg = String(e?.message || e || "");
            if (!/quantity|unreceived|exceed|max|greater|less/i.test(msg)) throw e;
            const cappedItems = sRows.map((r) => {
              const shipmentLineItemId = String(r.shipmentLineItemId || "").trim();
              const inventoryItemId = String(r.inventoryItemId || "").trim();
              const planned = Math.max(0, Math.floor(Number(r.plannedQty || 0)));
              const alreadyRejected = Math.max(0, Math.floor(Number(r.alreadyRejectedQty || 0)));
              const alreadyAccepted = Math.max(0, Math.floor(Number(r.alreadyAcceptedQty || 0)));
              const alreadyOver = Math.max(0, Math.floor(Number(r.overAcceptedQty || 0)));
              const alreadyTotal = alreadyAccepted + alreadyOver;
              const targetAccepted = Math.max(0, Math.floor(Number(r.receiveQty || 0)));
              const wantDelta = Math.max(0, targetAccepted - alreadyTotal);
              const remainingReceivable = Math.max(0, planned - alreadyRejected - alreadyAccepted);
              const deltaPlanned = Math.min(remainingReceivable, wantDelta);
              const overflow = Math.max(0, wantDelta - deltaPlanned);
              if (overflow > 0 && inventoryItemId) overflowMap.set(inventoryItemId, (overflowMap.get(inventoryItemId) || 0) + overflow);
              return { shipmentLineItemId, quantity: deltaPlanned };
            }).filter((x) => x.shipmentLineItemId && x.quantity > 0);
            if (cappedItems.length > 0) {
              await receiveShipmentWithFallbackV2({ shipmentId: sid, items: cappedItems });
              for (const p of cappedItems) {
                const row = sRows.find((r) => String(r.shipmentLineItemId || "").trim() === String(p.shipmentLineItemId || "").trim());
                if (row) multiReceivedDeltas.push({ inventoryItemId: String(row.inventoryItemId || "").trim(), delta: p.quantity });
              }
            }
          }
        }
        if (multiReceivedDeltas.length > 0 && locationGid) {
          const merged = new Map();
          multiReceivedDeltas.forEach((d) => {
            if (!d.inventoryItemId || d.delta <= 0) return;
            const k = d.inventoryItemId;
            merged.set(k, (merged.get(k) || 0) + d.delta);
          });
          const inboundDeltas = Array.from(merged.entries()).map(([inventoryItemId, delta]) => ({ inventoryItemId, delta }));
          if (inboundDeltas.length > 0) {
            const transferIdStr = String(transferId || "").trim();
            const transferIdMatch = transferIdStr.match(/(\d+)$/);
            const transferIdForUri = transferIdMatch ? transferIdMatch[1] : transferIdStr;
            await logInventoryChangeToApi({ activity: "inbound_transfer", locationId: locationGid, locationName: "", deltas: inboundDeltas, sourceId: transferIdForUri });
          }
        }
        for (const [sid, rejItems] of rejectedByShip) {
          if (!finalize || rejItems.length === 0) continue;
          await receiveShipmentWithFallbackV2({ shipmentId: sid, items: rejItems });
        }
        const originLocationId = String(transferForShipment?.originLocationId || transferForShipment?.origin?.location?.id || inbound?.selectedOriginLocationId || "").trim() || null;
        if (originLocationId && finalize) {
          const rawRejected = [];
          for (const [, rej] of rejectedByShip) {
            for (const rejected of rej) {
              const row = rowByLineId.get(String(rejected.shipmentLineItemId || "").trim());
              if (!row) continue;
              rawRejected.push({
                inventoryItemId: String(row.inventoryItemId || "").trim(),
                delta: Math.max(0, Math.floor(Number(rejected.quantity || 0))),
                sku: String(row.sku || "").trim(),
                title: String(row.title || "").trim(),
              });
            }
          }
          const merged = new Map();
          rawRejected.filter((d) => d.inventoryItemId && d.delta > 0).forEach((d) => {
            const k = d.inventoryItemId;
            const prev = merged.get(k);
            if (prev) prev.delta += d.delta;
            else merged.set(k, { ...d });
          });
          rejectedDeltas = Array.from(merged.values());
          if (rejectedDeltas.length > 0) {
            await ensureInventoryActivatedAtLocation({ locationId: originLocationId, inventoryItemIds: rejectedDeltas.map((d) => d.inventoryItemId) });
            // transferIdからID部分を抽出（GID形式の場合は末尾の数字部分を取得）
            const transferIdStr = String(transferId || "").trim();
            const transferIdMatch = transferIdStr.match(/(\d+)$/);
            const transferIdForUri = transferIdMatch ? transferIdMatch[1] : transferIdStr;
            await adjustInventoryAtLocationWithFallback({ 
              locationId: originLocationId, 
              deltas: rejectedDeltas.map((d) => ({ inventoryItemId: d.inventoryItemId, delta: d.delta })),
              referenceDocumentUri: transferIdForUri || null
            });
            await logInventoryChangeToApi({
              activity: "inbound_transfer",
              locationId: originLocationId,
              locationName: "",
              deltas: rejectedDeltas.map((d) => ({ inventoryItemId: d.inventoryItemId, delta: d.delta })),
              sourceId: transferIdForUri,
            });
          }
        }
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
          extraDeltasMerged = Array.from(m.entries()).map(([inventoryItemId, delta]) => ({ inventoryItemId, delta }));
        } else {
          extraDeltasMerged = extraDeltas;
        }
      }

      if (extraDeltasMerged.length > 0) {
        const inventoryItemIds = extraDeltasMerged.map((d) => d.inventoryItemId);
        const act = await ensureInventoryActivatedAtLocation({ locationId: locationGid, inventoryItemIds });
        if (!act?.ok) {
          const msg = (act?.errors || []).map((e) => `${e.inventoryItemId}: ${e.message}`).filter(Boolean).join("\n") || "在庫の有効化に失敗しました";
          throw new Error(msg);
        }
        // transferIdからID部分を抽出（GID形式の場合は末尾の数字部分を取得）
        const transferIdStr = String(transferId || "").trim();
        const transferIdMatch = transferIdStr.match(/(\d+)$/);
        const transferIdForUri = transferIdMatch ? transferIdMatch[1] : transferIdStr;
        
        await adjustInventoryAtLocationWithFallback({ 
          locationId: locationGid, 
          deltas: extraDeltasMerged,
          referenceDocumentUri: transferIdForUri || null
        });
        await logInventoryChangeToApi({
          activity: "inbound_transfer",
          locationId: locationGid,
          locationName: "",
          deltas: extraDeltasMerged,
          sourceId: transferIdForUri,
        });
        const originLocationId = String(transferForShipment?.originLocationId || transferForShipment?.origin?.location?.id || inbound?.selectedOriginLocationId || "").trim() || null;
        if (!originLocationId) {
          toast("警告: 出庫元のlocationIdが取得できませんでした（出庫元の在庫調整をスキップします）");
        } else {
          await ensureInventoryActivatedAtLocation({ locationId: originLocationId, inventoryItemIds });
          const originDeltas = extraDeltasMerged.map((d) => ({
            inventoryItemId: d.inventoryItemId,
            delta: -Math.max(0, Math.floor(Number(d.delta || 0))),
          }));
          await adjustInventoryAtLocationWithFallback({ 
            locationId: originLocationId, 
            deltas: originDeltas,
            referenceDocumentUri: transferIdForUri || null
          });
          await logInventoryChangeToApi({
            activity: "outbound_transfer",
            locationId: originLocationId,
            locationName: "",
            deltas: originDeltas,
            sourceId: transferIdForUri,
          });
        }
      }

      // REFERENCE: 監査ログの extras は「確定後に実際に反映した予定外」（extraDeltasMerged）から組み立てる
      const auditExtrasForLog = (extraDeltasMerged || []).map((d) => {
        const id = String(d?.inventoryItemId || "").trim();
        const meta = extrasMap.get(id) || {};
        return {
          inventoryItemId: id,
          qty: Math.max(0, Math.floor(Number(d?.delta || 0))),
          title: meta.title || id || "(unknown)",
          sku: meta.sku || "",
          barcode: meta.barcode || "",
          imageUrl: meta.imageUrl || "",
        };
      }).filter((x) => x.inventoryItemId && x.qty > 0);
      try {
        await appendInboundAuditLog({
          shipmentId: shipment.id,
          locationId: locationGid,
          reason: String(reason || "").trim(),
          note: noteText,
          over: overForLog,
          extras: auditExtrasForLog,
        });
      } catch (e) {
        toast(`履歴ログ保存に失敗: ${String(e?.message || e)}`);
      }

      if (transferId && (rejectedDeltas.length > 0 || (extraDeltasMerged && extraDeltasMerged.length > 0))) {
        try {
          const adjustments = [];
          const originLocationId = String(transferForShipment?.originLocationId || transferForShipment?.origin?.location?.id || inbound?.selectedOriginLocationId || "").trim() || null;
          const originLocationName = String(transferForShipment?.originName || transferForShipment?.origin?.name || inbound?.selectedOriginName || "").trim() || "出庫元";
          const destinationLocationName = String(transferForShipment?.destinationName || transferForShipment?.destination?.name || inbound?.selectedDestinationName || "").trim() || "入庫先";
          if (rejectedDeltas.length > 0) {
            rejectedDeltas.forEach((d) => {
              adjustments.push({ locationName: originLocationName, locationId: originLocationId, inventoryItemId: d.inventoryItemId, sku: d.sku, title: d.title, delta: d.delta });
            });
          }
          if (extraDeltasMerged && extraDeltasMerged.length > 0) {
            const extrasMapForAdj = new Map();
            (extras || []).forEach((x) => {
              const id = String(x?.inventoryItemId || "").trim();
              if (id) extrasMapForAdj.set(id, { title: String(x?.title || x?.sku || "(unknown)").trim(), sku: String(x?.sku || "").trim() });
            });
            extraDeltasMerged.forEach((d) => {
              const meta = extrasMapForAdj.get(d.inventoryItemId) || {};
              adjustments.push({ locationName: destinationLocationName, locationId: locationGid, inventoryItemId: d.inventoryItemId, sku: meta.sku || "", title: meta.title || d.inventoryItemId || "不明", delta: Math.max(0, Math.floor(Number(d.delta || 0))) });
            });
            if (originLocationId) {
              extraDeltasMerged.forEach((d) => {
                const meta = extrasMapForAdj.get(d.inventoryItemId) || {};
                adjustments.push({ locationName: originLocationName, locationId: originLocationId, inventoryItemId: d.inventoryItemId, sku: meta.sku || "", title: meta.title || d.inventoryItemId || "不明", delta: -Math.max(0, Math.floor(Number(d.delta || 0))) });
              });
            }
          }
          if (adjustments.length > 0) {
            const adjustmentNote = buildInboundNoteLine_({ shipmentId: shipment.id, locationId: locationGid, finalize, note: "", over: [], extras: [], inventoryAdjustments: adjustments });
            await appendInventoryTransferNote_({ transferId, line: adjustmentNote });
          }
        } catch (_) {}
      }

      toast(finalize ? "入庫を完了しました" : "一部入庫を確定しました");
      try {
        await clearInboundDraft({ locationGid, transferId, shipmentId: shipment.id });
      } catch (_) {}
      setDraftSavedAt(null);
      try {
        await refreshPending();
      } catch (_) {}
      try {
        if (!isMultipleMode) {
          await loadShipmentById(shipment.id);
        } else {
          const idsToReload = Array.isArray(inbound?.selectedShipmentIds) ? inbound.selectedShipmentIds : [];
          if (idsToReload.length > 0) await loadMultipleShipments(idsToReload);
        }
      } catch (_) {}
      if (!isMultipleMode && finalize && typeof onAfterReceive === "function") onAfterReceive(transferId).catch(() => {});
      if (finalize) onBack?.();
      return true;
    } catch (e) {
      toast(`入庫確定エラー: ${toUserMessage(e)}`);
      return false;
    } finally {
      if (mountedRef.current) setReceiveSubmitting(false);
      receiveLockRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly, shipment && shipment.id, locationGid, hasWarning, ackWarning, rows, extras, overRows, shortageRows, note, reason, transferId, transferForShipment, inbound, onAfterReceive, onBack, isMultipleMode]);

  const handleReceive = useCallback(async () => {
    if (hasWarning && !warningReady) return;
    const ok = await receiveConfirm({ finalize: true });
    if (ok) onBack?.();
  }, [hasWarning, warningReady, receiveConfirm, onBack]);

  useEffect(() => {
    if (!shipment?.id || !locationGid) return;
    loadExtrasHistory_(
      String(shipment.id || "").trim(),
      String(locationGid || "").trim(),
      setExtrasHistory,
      setExtrasHistoryLoading,
      setConfirmMemo,
      readInboundAuditLog
    );
  }, [shipment && shipment.id, locationGid]);

  // REFERENCE 同様: ヘッダーの #T0000 / 出庫元 / 入庫先 は transferForShipment 優先で refresh 後に最新化
  const headNo = useMemo(() => {
    const raw = String(transferForShipment?.name || inbound?.selectedTransferName || "").trim();
    const m = raw.match(/T\d+/i);
    if (m) return `#${String(m[0]).toUpperCase()}`;
    if (raw) return raw.startsWith("#") ? raw : `#${raw}`;
    const s = String(shipment?.id || selectedShipmentId || "").trim();
    return s ? `#${s.slice(-8)}` : "—";
  }, [transferForShipment?.name, inbound?.selectedTransferName, shipment?.id, selectedShipmentId]);
  const headerOriginName = useMemo(() => {
    const n = String(transferForShipment?.originName || inbound?.selectedOriginName || "").trim();
    return n || "—";
  }, [transferForShipment?.originName, inbound?.selectedOriginName]);
  const headerInboundTo = useMemo(() => {
    const n = String(transferForShipment?.destinationName || inbound?.selectedDestinationName || "").trim();
    if (n) return n;
    return "-";
  }, [transferForShipment?.destinationName, inbound?.selectedDestinationName]);

  const headerNode = useMemo(() => {
    if (!setHeader) return null;
    const originName = headerOriginName;
    const destName = headerInboundTo;
    const inboundTo = destName;
    const q = String(addQuery || "");
    const showResults = q.trim().length >= 1;
    return (
      <s-box padding="small">
        <s-stack gap="tight">
          <s-stack
            direction="inline"
            justifyContent="space-between"
            alignItems="center"
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
              {/* REFERENCE 同様：配送情報は常に3行表示（値は空可） */}
              <s-text size="small" tone="subdued" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                配送業者: {String(shipment?.tracking?.company ?? "").trim() || ""}
              </s-text>
              <s-text size="small" tone="subdued" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                配送番号: {String(shipment?.tracking?.trackingNumber ?? "").trim() || ""}
              </s-text>
              <s-text size="small" tone="subdued" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                予定日: {shipment?.tracking?.arrivesAt ? String(shipment.tracking.arrivesAt).trim().slice(0, 10) : ""}
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
                  {liteMode ? "画像OFF" : "画像ON"}
                </s-button>
              ) : null}
              <s-button
                onClick={() => setAllToPlanned_(readOnlyRef, toastReadOnlyOnceRef, toast, rowsRef, setRows)}
                disabled={!shipment?.id || readOnly}
                tone={readOnly ? "subdued" : undefined}
                style={{ paddingInline: 8, whiteSpace: "nowrap" }}
              >
                全入庫
              </s-button>
              <s-button
                onClick={() => resetAllCounts_(readOnlyRef, toastReadOnlyOnceRef, toast, setRows, setExtras, setReason, setNote, setAckWarning)}
                disabled={!shipment?.id || readOnly}
                tone={readOnly ? "subdued" : "critical"}
                style={{ paddingInline: 8, whiteSpace: "nowrap" }}
              >
                リセット
              </s-button>
            </s-stack>
          </s-stack>
          {/* リスト外追加（検索）※処理済み時はグレーアウト */}
          <s-box inlineSize="100%" paddingBlockStart="small-200" style={readOnly ? { opacity: 0.6 } : undefined}>
            <s-text-field
              label="検索"
              labelHidden
              placeholder="商品名 / SKU / バーコード"
              value={addQuery}
              onInput={(e) => setAddQuery(readValue(e))}
              onChange={(e) => setAddQuery(readValue(e))}
              disabled={readOnly}
            >
              {addQuery ? (
                <s-button slot="accessory" kind="secondary" tone="critical" onClick={() => clearAddSearch_(setAddQuery, setAddCandidates, setAddCandidatesDisplayLimit, setAddQtyById)}>
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
          {addLoading ? <s-text tone="subdued" size="small">読み込み中...</s-text> : null}
        </s-stack>
      </s-box>
    );
  }, [setHeader, headNo, headerOriginName, headerInboundTo, addQuery, addLoading, addCandidates, inbound, liteMode, onToggleLiteMode, shipment && shipment.id, shipment && shipment.tracking, readOnly]);

  useEffect(() => {
    if (!setHeader) return;
    setHeader(headerNode);
    return () => setHeader?.(null);
  }, [setHeader, headerNode]);

  // 下部固定フッター（戻る + 中央3行 + 確定）
  const footerLine1 = shipment?.id
    ? `予定 ${plannedTotal} / 入庫 ${receiveTotal}`
    : "未選択";
  const footerLine2 = shipment?.id
    ? `超過 ${overQtyTotal} / 不足 ${shortageQtyTotal}`
    : "";
  const footerLine3Extras = shipment?.id && extrasQtyTotal > 0
    ? `予定外 ${extrasQtyTotal}`
    : "";

  const hasStatusIssue = (extrasQtyTotal + overQtyTotal + shortageQtyTotal) > 0;

  // フッター中央：ステータスバッジ（トランスファー一覧の表示ステータスを引き継ぐ）
  const STATUS_LABEL_MAP = useMemo(() => ({
    DRAFT: "下書き", READY_TO_SHIP: "配送準備完了", IN_PROGRESS: "処理中", IN_TRANSIT: "進行中",
    RECEIVED: "入庫", TRANSFERRED: "入庫済み", CANCELED: "キャンセル", OTHER: "その他",
  }), []);
  const footerStatusLabel = useMemo(() => {
    // 一覧と同じ：Transfer の status を日本語ラベルに（transferForShipment 優先、未取得時は selectedTransferStatus）
    const raw = String((transferForShipment?.status ?? inbound?.selectedTransferStatus) || "").trim().toUpperCase();
    if (raw && STATUS_LABEL_MAP[raw]) return STATUS_LABEL_MAP[raw];
    return readOnly ? "入庫済み" : (draftSavedAt ? "下書き" : "未入庫");
  }, [transferForShipment?.status, inbound?.selectedTransferStatus, STATUS_LABEL_MAP, readOnly, draftSavedAt]);
  const footerStatusTone = getStatusBadgeTone(footerStatusLabel);

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
            {/* ✅ 中央：ステータスバッジ（一覧表示と合わせる） + 2行（予定/受領 + 状態） */}
            <s-box style={{ flex: "1 1 auto", minWidth: 0, paddingInline: 8 }}>
              <s-stack direction="inline" gap="base" alignItems="center" justifyContent="center">
                <s-badge tone={footerStatusTone}>{footerStatusLabel}</s-badge>
                <s-stack gap="none" alignItems="center">
                  <s-text alignment="center" size="small" tone="subdued">
                    {footerLine1}
                  </s-text>
                  {footerLine2 ? (
                    <s-text alignment="center" size="small" tone={hasWarning ? "critical" : "subdued"}>
                      {footerLine2}
                    </s-text>
                  ) : null}
                  {footerLine3Extras ? (
                    <s-text alignment="center" size="small" tone="critical">
                      {footerLine3Extras}
                    </s-text>
                  ) : null}
                  {liteMode ? (
                    <s-text alignment="center" size="small" tone="subdued">
                      画像ON
                    </s-text>
                  ) : null}
                </s-stack>
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
          {shipmentLoading ? <s-text size="small" tone="subdued">読み込み中...</s-text> : null}
          {shipmentError ? <s-text size="small" tone="critical">{shipmentError}</s-text> : null}
        </s-stack>
      </s-box>
    );
    return () => setFooter?.(null);
  }, [setFooter, onBack, footerLine1, footerLine2, hasWarning, canOpenConfirm, receiveSubmitting, shipmentLoading, shipmentError, liteMode, footerStatusLabel, footerStatusTone, readOnly, draftSavedAt]);

  if (shipmentLoading) {
    return (
      <s-box padding="base">
        <s-text tone="subdued">読み込み中...</s-text>
      </s-box>
    );
  }

  if (shipmentError) {
    return (
      <s-box padding="base">
        <s-text tone="critical">エラー: {shipmentError}</s-text>
        <s-button kind="secondary" onClick={() => loadShipment(selectedShipmentId)}>再読込</s-button>
      </s-box>
    );
  }

  if (!selectedShipmentId && !isMultipleMode) {
    return (
      <s-box padding="base">
        <s-stack gap="base">
          <s-text tone="subdued">配送が未選択です。前の画面で選択してください。</s-text>
          <s-divider />
          <s-button onClick={refreshPending} disabled={pendingLoading}>
            {pendingLoading ? "読込中..." : "入庫予定一覧を更新（任意）"}
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

  if (!shipment || rows.length === 0) {
    return (
      <s-box padding="base">
        <s-text tone="subdued">配送を読み込むと、ここに明細が出ます</s-text>
      </s-box>
    );
  }

  const warningAreaNode = !hasWarning ? null : (
    <s-stack gap="small">
      <s-text size="small" tone="critical">予定外/超過/不足があります。「確認しました」を押してから確定してください。</s-text>
      <s-button kind="secondary" size="small" onClick={() => setAckWarning(true)} disabled={ackWarning}>{ackWarning ? "確認済み" : "確認しました"}</s-button>
    </s-stack>
  );

  return (
    <s-stack gap="base">
      {/* 1. 検索結果ブロック（最上部・REFERENCE と同じ条件）※処理済み時はグレーアウト */}
      {String(addQuery || "").trim().length >= 1 ? (
        <s-box padding="base" style={readOnly ? { opacity: 0.6 } : undefined}>
          <s-stack gap="extra-tight">
            <s-text>検索リスト 候補： {addLoading ? "..." : addCandidates.length}件</s-text>
            {addCandidates.length > 0 ? (
              <>
                {addCandidates.slice(0, addCandidatesDisplayLimit).map((c, idx) => (
                  <InboundCandidateRow
                    key={c.variantId || idx}
                    c={c}
                    idx={idx}
                    showImages={showImages}
                    liteMode={liteMode}
                    addQtyById={addQtyById}
                    setAddQtyById={setAddQtyById}
                    addOrIncrementByResolved={addOrIncrementByResolved}
                    ensureInbCandidateStock={ensureInbCandidateStock}
                    getInbCandidateStock={getInbCandidateStock}
                    inbCandidateStockVersion={inbCandidateStockVersion}
                    readOnly={readOnly}
                  />
                ))}
                {addCandidates.length > addCandidatesDisplayLimit ? (
                  <s-box padding="small">
                    <s-button kind="secondary" onClick={() => handleShowMoreAddCandidates_(setAddCandidatesDisplayLimit)} onPress={() => handleShowMoreAddCandidates_(setAddCandidatesDisplayLimit)}>
                      さらに表示（残り {addCandidates.length - addCandidatesDisplayLimit}件）
                    </s-button>
                  </s-box>
                ) : null}
              </>
            ) : addLoading ? (
              <s-text>読み込み中...</s-text>
            ) : (
              <s-text>該当なし</s-text>
            )}
          </s-stack>
        </s-box>
      ) : null}

      {/* 2. 入庫リスト（shipment がある場合のみ・REFERENCE と同じ） */}
      {shipment ? (
        <s-box key="shipment_list" padding="small">
          <s-stack gap="small">
            <s-text emphasis="bold">入庫リスト</s-text>
            {lineItemsPageInfo?.hasNextPage ? (
              <s-box padding="base">
                <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
                  <s-text>未読み込み商品リストがあります。（要読込）</s-text>
                  <s-button kind="secondary" onClick={loadMoreLineItems_} disabled={loadingMore}>
                    {loadingMore ? "読込中..." : "読込"}
                  </s-button>
                </s-stack>
              </s-box>
            ) : null}
            {isMultipleMode ? (
              (() => {
                const groupedByShipment = new Map();
                visibleRows.forEach((row) => {
                  const shipmentId = row.shipmentId || "";
                  const shipmentLabel = row.shipmentLabel || "";
                  if (!groupedByShipment.has(shipmentId)) {
                    groupedByShipment.set(shipmentId, { shipmentId, shipmentLabel, rows: [] });
                  }
                  groupedByShipment.get(shipmentId).rows.push(row);
                });
                const STATUS_LABEL = { RECEIVED: "入庫済み", TRANSFERRED: "入庫済み" };
                return (
                  <s-stack gap="base">
                    {Array.from(groupedByShipment.values()).map((group, index) => {
                      const gid = String(group.shipmentId || "");
                      const isGroupReadOnly = shipmentIdToReadOnly.get(gid) ?? shipmentIdToReadOnly.get(normalizeId_(gid)) ?? false;
                      const statusRaw = (transferForShipment?.shipments || []).find((s) => String(s?.id || "") === String(group.shipmentId || ""))?.status || "";
                      const statusLabel = STATUS_LABEL[String(statusRaw).toUpperCase()] || "未入庫";
                      const statusTone = isGroupReadOnly ? "success" : "subdued";
                      return (
                        <s-box key={group.shipmentId || index}>
                          <s-stack gap="tight">
                            <s-box padding="small" style={{ backgroundColor: "var(--s-color-bg-surface-secondary)", borderRadius: 4 }}>
                              <s-stack direction="inline" gap="base" justifyContent="space-between" alignItems="center" style={{ width: "100%" }}>
                                <s-text emphasis="bold" size="small">{group.shipmentLabel || `配送${index + 1}`}</s-text>
                                <s-stack direction="inline" gap="small" alignItems="center">
                                  <s-badge tone={statusTone}>{statusLabel}</s-badge>
                                  <s-text tone="subdued" size="small">{group.rows.length}件</s-text>
                                </s-stack>
                              </s-stack>
                            </s-box>
                            {renderInboundShipmentItems_({
                              rows: group.rows,
                              showImages,
                              dialog,
                              setRowQty: isGroupReadOnly
                                ? () => denyEdit_(toastReadOnlyOnceRef, toast)
                                : (key, qty) => setRowQty_(readOnlyRef, toastReadOnlyOnceRef, toast, rowsRef, setRows, key, qty),
                              readOnly: isGroupReadOnly,
                            })}
                          </s-stack>
                          {index < groupedByShipment.size - 1 ? <s-divider /> : null}
                        </s-box>
                      );
                    })}
                  </s-stack>
                );
              })()
            ) : (
              renderInboundShipmentItems_({ rows: visibleRows, showImages, dialog, setRowQty: (key, qty) => setRowQty_(readOnlyRef, toastReadOnlyOnceRef, toast, rowsRef, setRows, key, qty), readOnly })
            )}
          </s-stack>
        </s-box>
      ) : (
        <s-box padding="base">
          <s-text>配送を読み込むと、ここに明細が出ます</s-text>
        </s-box>
      )}

      {/* 3. 確定モーダル（REFERENCE: 入庫リストの後・予定外入荷の前） */}
      <s-modal id={CONFIRM_RECEIVE_MODAL_ID} heading="入庫を確定しますか？">
          <s-box padding="none" style={{ paddingInline: 8, paddingBlockStart: 8, paddingBlockEnd: 0, maxHeight: "60vh", overflowY: "auto" }}>
            <s-stack gap="small">
              <s-stack gap="extra-tight">
                <s-text size="small" tone="subdued">予定 {plannedTotal} / 入庫 {receiveTotal}</s-text>
                <s-text size="small" tone="subdued">予定外 {extrasQtyTotal} / 超過 {overQtyTotal} / 不足 {shortageQtyTotal}</s-text>
                {hasWarning ? <s-text size="small" tone="critical">※ 予定外/超過/不足 があります。</s-text> : null}
              </s-stack>
              {shortageRows.length > 0 ? (
                <s-stack gap="extra-tight">
                  <s-text size="small" tone="critical">不足（{shortageRows.length}件）</s-text>
                  {shortageRows.slice(0, DIFF_PREVIEW_LIMIT).map((x) => <s-text key={x.shipmentLineItemId} size="small" tone="subdued" style={oneLineStyle}>・{x.title}：-{Number(x.shortageQty || 0)}</s-text>)}
                  {shortageRows.length > DIFF_PREVIEW_LIMIT ? <s-text size="small" tone="subdued">…他 {shortageRows.length - DIFF_PREVIEW_LIMIT} 件</s-text> : null}
                </s-stack>
              ) : null}
              {extras.length > 0 ? (
                <s-stack gap="extra-tight">
                  <s-text size="small" tone="critical">予定外（{extras.length}件）</s-text>
                  {extras.slice(0, DIFF_PREVIEW_LIMIT).map((x) => <s-text key={x.key} size="small" tone="subdued" style={oneLineStyle}>・{x.title}：{Number(x.receiveQty || 0)}</s-text>)}
                  {extras.length > DIFF_PREVIEW_LIMIT ? <s-text size="small" tone="subdued">…他 {extras.length - DIFF_PREVIEW_LIMIT} 件</s-text> : null}
                </s-stack>
              ) : null}
              {overRows.length > 0 ? (
                <s-stack gap="extra-tight">
                  <s-text size="small" tone="critical">超過（{overRows.length}件）</s-text>
                  {overRows.slice(0, DIFF_PREVIEW_LIMIT).map((x) => <s-text key={x.shipmentLineItemId} size="small" tone="subdued" style={oneLineStyle}>・{x.title}：+{Number(x.overQty || 0)}</s-text>)}
                  {overRows.length > DIFF_PREVIEW_LIMIT ? <s-text size="small" tone="subdued">…他 {overRows.length - DIFF_PREVIEW_LIMIT} 件</s-text> : null}
                </s-stack>
              ) : null}
              {hasWarning ? (
                <>
                  <s-divider />
                  {warningAreaNode}
                </>
              ) : null}
              <s-divider />
              <s-box>
                <s-button command="--hide" commandFor={CONFIRM_RECEIVE_MODAL_ID}>戻る</s-button>
              </s-box>
            </s-stack>
          </s-box>
          <s-button slot="secondary-actions" kind="secondary" tone="critical" disabled={!canConfirm || !warningReady || receiveSubmitting} onClick={async () => { const ok = await receiveConfirm({ finalize: false }); if (ok) document.querySelector(`#${CONFIRM_RECEIVE_MODAL_ID}`)?.hide?.(); }} onPress={async () => { const ok = await receiveConfirm({ finalize: false }); if (ok) document.querySelector(`#${CONFIRM_RECEIVE_MODAL_ID}`)?.hide?.(); }}>一部入庫（一時保存）</s-button>
          <s-button slot="primary-action" tone={hasWarning ? "critical" : "success"} disabled={!canConfirm || !warningReady || receiveSubmitting} onClick={async () => { const ok = await receiveConfirm({ finalize: true }); if (ok) { document.querySelector(`#${CONFIRM_RECEIVE_MODAL_ID}`)?.hide?.(); onBack?.(); } }} onPress={async () => { const ok = await receiveConfirm({ finalize: true }); if (ok) { document.querySelector(`#${CONFIRM_RECEIVE_MODAL_ID}`)?.hide?.(); onBack?.(); } }}>確定する</s-button>
        </s-modal>

      {/* 4. 予定外入荷エリア（shipment がある場合のみ・REFERENCE と同じ） */}
      {shipment ? (
        <s-box key="extras_area" padding="small">
          <s-stack gap="small">
            <s-text emphasis="bold">予定外入荷（リストにない商品）</s-text>
            {renderExtras_({ extras, extrasHistory, showImages, dialog, setExtraQty: (key, value) => setExtraQty_(readOnlyRef, toastReadOnlyOnceRef, toast, extrasRef, setExtras, key, value) })}
            {renderExtrasHistory_({ extrasHistory, extrasHistoryLoading, showImages, dialog })}
            {renderConfirmMemo_({ extrasHistoryLoading, confirmMemo })}
          </s-stack>
        </s-box>
      ) : null}
    </s-stack>
  );
}
