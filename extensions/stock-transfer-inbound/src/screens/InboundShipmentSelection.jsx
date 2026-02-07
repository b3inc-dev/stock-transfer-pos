import { useState, useCallback, useEffect } from "preact/hooks";
import { getStateSlice, setStateSlice, toUserMessage, getStatusBadgeTone } from "../inboundHelpers.js";
import { useOriginLocationGid } from "../inboundHooks.js";
import {
  fetchTransfersForDestinationAll,
  fetchInventoryShipmentEnriched,
} from "../inboundApi.js";
import { FixedFooterNavBar } from "../FixedFooterNavBar.jsx";

const LIST_INITIAL_LIMIT = 100;

export function InboundShipmentSelection({
  showImages,
  liteMode,
  appState,
  setAppState,
  settings,
  onNext,
  onBack,
  setHeader,
  setFooter,
  onToggleLiteMode,
}) {
  const locationGid = useOriginLocationGid() || String(appState?.originLocationIdManual || "").trim() || null;
  const inbound = getStateSlice(appState, "inbound", {
    selectedTransferId: "",
    selectedTransferName: "",
    selectedOriginName: "",
    selectedDestinationName: "",
    selectedTransferStatus: "",
    selectedTransferTotalQuantity: 0,
    selectedTransferReceivedQuantity: 0,
    selectedTransferForSelection: null,
  });

  const transferId = String(inbound?.selectedTransferId || "").trim();
  const transferName = String(inbound?.selectedTransferName || "").trim();
  const cachedTransfer = inbound?.selectedTransferForSelection;

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [transfer, setTransfer] = useState(null);
  const [shipments, setShipments] = useState([]);
  const [shipmentQuantities, setShipmentQuantities] = useState(new Map());

  const formatShipmentLabel = useCallback((name, index) => {
    const base = String(name || "").trim() || "T0000";
    const match = base.match(/(\d+)$/);
    const numPart = match ? match[1] : base;
    return `#${numPart}-${index + 1}`;
  }, []);

  const loadShipmentQuantitiesOnly = useCallback(async (ships) => {
    const qtyMap = new Map();
    if (!Array.isArray(ships) || ships.length === 0) return qtyMap;
    await Promise.all(
      ships.map(async (shipment) => {
        const sid = String(shipment?.id || "").trim();
        if (!sid) return;
        try {
          const shipResult = await fetchInventoryShipmentEnriched(sid, { includeImages: false });
          const lineItems = Array.isArray(shipResult?.lineItems) ? shipResult.lineItems : [];
          const totalQty = lineItems.reduce((sum, li) => sum + Number(li?.quantity || 0), 0);
          const receivedQty = lineItems.reduce((sum, li) => sum + Number(li?.acceptedQuantity || 0), 0);
          qtyMap.set(sid, { total: totalQty, received: receivedQty });
        } catch (e) {
          qtyMap.set(sid, { total: 0, received: 0 });
        }
      })
    );
    return qtyMap;
  }, []);

  const loadTransfer = useCallback(async (forceRefetch = false) => {
    if (!transferId || !locationGid) return;
    setLoading(true);
    setError("");
    try {
      const useCache = !forceRefetch && cachedTransfer && String(cachedTransfer?.id || "").trim() === transferId;
      if (useCache) {
        setTransfer(cachedTransfer);
        const ships = Array.isArray(cachedTransfer?.shipments) ? cachedTransfer.shipments : [];
        setShipments(ships);
        const qtyMap = await loadShipmentQuantitiesOnly(ships);
        setShipmentQuantities(qtyMap);
      } else {
        const listLimit = Math.max(1, Math.min(250, Number(appState?.outbound?.settings?.inbound?.listInitialLimit ?? settings?.inbound?.listInitialLimit ?? LIST_INITIAL_LIMIT)));
        const result = await fetchTransfersForDestinationAll(locationGid, { first: listLimit });
        const found = Array.isArray(result?.transfers) ? result.transfers : [];
        const t = found.find((tr) => String(tr?.id || "").trim() === transferId);

        if (!t) {
          setError("Transferが見つかりません");
          setTransfer(null);
          setShipments([]);
          return;
        }

        setTransfer(t);
        const ships = Array.isArray(t?.shipments) ? t.shipments : [];
        setShipments(ships);
        const qtyMap = await loadShipmentQuantitiesOnly(ships);
        setShipmentQuantities(qtyMap);
      }
    } catch (e) {
      setError(toUserMessage(e));
      setTransfer(null);
      setShipments([]);
      setShipmentQuantities(new Map());
    } finally {
      setLoading(false);
    }
  }, [transferId, locationGid, cachedTransfer, appState?.outbound?.settings?.inbound?.listInitialLimit, settings?.inbound?.listInitialLimit, loadShipmentQuantitiesOnly]);

  useEffect(() => {
    loadTransfer();
  }, [loadTransfer]);

  const isShipmentReceived = useCallback((shipment) => {
    const status = String(shipment?.status || "").toUpperCase();
    return status === "RECEIVED" || status === "TRANSFERRED";
  }, []);

  const onSelectShipment = useCallback((shipmentId) => {
    if (!transfer) return;

    const readOnly = isShipmentReceived(
      (shipments || []).find((s) => String(s?.id || "").trim() === shipmentId)
    );

    setStateSlice(setAppState, "inbound", {
      selectedShipmentId: shipmentId,
      selectedShipmentIds: [],
      shipmentMode: "single",

      selectedTransferId: String(transfer?.id || ""),
      selectedTransferName: String(transfer?.name || ""),
      selectedOriginName: String(transfer?.originName || ""),
      selectedDestinationName: String(transfer?.destinationName || ""),
      selectedOriginLocationId: String(transfer?.originLocationId ?? ""),
      selectedTransferStatus: String(transfer?.status || ""),
      selectedTransferTotalQuantity: Number(transfer?.totalQuantity ?? 0),
      selectedTransferReceivedQuantity: Number(transfer?.receivedQuantityDisplay ?? transfer?.receivedQuantity ?? 0),
      selectedReadOnly: !!readOnly,
    });

    onNext?.();
  }, [transfer, shipments, setAppState, onNext, isShipmentReceived]);

  useEffect(() => {
    setHeader?.(
      <s-box padding="base">
        <s-stack gap="base">
          <s-text emphasis="bold">配送を選択</s-text>
          {transfer ? (
            <s-stack gap="none">
              <s-text tone="subdued" size="small">
                {transferName || String(transfer?.name || "").trim() || "入庫ID"}
              </s-text>
              <s-text tone="subdued" size="small">
                出庫元: {String(transfer?.originName || "").trim() || "-"}
              </s-text>
              <s-text tone="subdued" size="small">
                宛先: {String(transfer?.destinationName || "").trim() || "-"}
              </s-text>
              <s-text tone="subdued" size="small">
                配送数: {shipments.length}
              </s-text>
            </s-stack>
          ) : null}
        </s-stack>
      </s-box>
    );
    return () => setHeader?.(null);
  }, [setHeader, transfer, transferName, shipments.length]);

  useEffect(() => {
    setFooter?.(
      <FixedFooterNavBar
        summaryLeft={`${transferName || "-"}`}
        summaryRight={`${shipments.length}件`}
        leftLabel="戻る"
        onLeft={onBack}
        rightLabel="再読込"
        onRight={() => loadTransfer(true)}
        rightTone="default"
      />
    );
    return () => setFooter?.(null);
  }, [setFooter, transferName, shipments.length, onBack, loadTransfer]);

  if (loading) {
    return (
      <s-box padding="base">
        <s-text tone="subdued">読み込み中...</s-text>
      </s-box>
    );
  }

  if (error) {
    return (
      <s-box padding="base">
        <s-text tone="critical">エラー: {error}</s-text>
      </s-box>
    );
  }

  if (!transfer || shipments.length === 0) {
    return (
      <s-box padding="base">
        <s-text tone="subdued">配送が見つかりません</s-text>
      </s-box>
    );
  }

  return (
    <s-box padding="base">
      <s-stack gap="none">
        {shipments.map((shipment, index) => {
          const shipmentId = String(shipment?.id || "").trim();
          const shipmentLabel = formatShipmentLabel(transferName || transfer?.name || "", index);
          const status = String(shipment?.status || "").toUpperCase();
          const isReceived = isShipmentReceived(shipment);
          const statusJa = status === "RECEIVED" ? "入庫済み" :
                          status === "TRANSFERRED" ? "入庫済み" :
                          status === "IN_TRANSIT" ? "配送中" :
                          status === "READY_TO_SHIP" ? "配送準備完了" :
                          status || "不明";
          const statusBadgeTone = getStatusBadgeTone(statusJa);

          const qtyInfo = shipmentQuantities.get(shipmentId) || { total: 0, received: 0 };
          const qtyText = `${qtyInfo.received}/${qtyInfo.total}`;

          return (
            <s-box key={shipmentId} padding="none">
              <s-clickable
                onClick={() => {
                  onSelectShipment(shipmentId);
                }}
              >
                <s-box
                  paddingInline="none"
                  paddingBlockStart="small-100"
                  paddingBlockEnd="small-200"
                  style={{
                    opacity: isReceived ? 0.6 : 1,
                    backgroundColor: isReceived ? "var(--s-color-bg-surface-secondary)" : undefined
                  }}
                >
                  <s-stack gap="base">
                    <s-stack direction="inline" justifyContent="space-between" alignItems="flex-end" gap="small">
                      <s-box style={{ flex: "1 1 auto", minWidth: 0 }}>
                        <s-stack gap="none">
                          <s-text emphasis="bold" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {shipmentLabel}
                          </s-text>
                          <s-stack direction="inline" gap="small" alignItems="center">
                            <s-badge tone={statusBadgeTone}>{statusJa}</s-badge>
                          </s-stack>
                        </s-stack>
                      </s-box>
                      <s-box style={{ flex: "0 0 auto" }}>
                        <s-text tone="subdued" size="small" style={{ whiteSpace: "nowrap" }}>
                          {qtyText}
                        </s-text>
                      </s-box>
                    </s-stack>
                    {shipment?.tracking?.trackingNumber ? (
                      <s-text tone="subdued" size="small" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        追跡番号: {String(shipment.tracking.trackingNumber).trim()}
                      </s-text>
                    ) : null}
                  </s-stack>
                </s-box>
              </s-clickable>
              <s-divider />
            </s-box>
          );
        })}
      </s-stack>
    </s-box>
  );
}
