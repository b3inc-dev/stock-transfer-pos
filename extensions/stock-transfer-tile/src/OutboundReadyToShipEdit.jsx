import { useEffect, useMemo, useRef, useState, useCallback } from "preact/hooks";

const SHOPIFY = globalThis?.shopify;
const toast = (m) => SHOPIFY?.toast?.show?.(String(m));

async function adminGraphql(query, variables, opts = {}) {
  const signal = opts?.signal ?? null;
  const res = await fetch("shopify:admin/api/graphql.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
    ...(signal ? { signal } : {}),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
  const json = text ? JSON.parse(text) : {};
  if (json.errors?.length) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

const TRANSFER_DETAIL_QUERY = `
  query TransferForReadyEdit($id: ID!) {
    inventoryTransfer(id: $id) {
      id name status
      shipments(first: 20) { nodes { id status name } }
    }
  }
`;

const MARK_IN_TRANSIT_MUTATION = `
  mutation MarkInTransit($id: ID!) {
    inventoryShipmentMarkInTransit(id: $id) {
      inventoryShipment { id status }
      userErrors { field message }
    }
  }
`;

export default function OutboundReadyToShipEdit({
  transferId,
  appState,
  setAppState,
  onBack,
  setHeader,
  setFooter,
  onAddShipment,
}) {
  const tid = String(transferId || "").trim();
  const [loading, setLoading] = useState(!!tid);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState(null);
  const [submittingId, setSubmittingId] = useState("");
  const abortRef = useRef(null);

  const shipments = useMemo(() => {
    if (!detail?.shipments?.nodes) return [];
    return detail.shipments.nodes.map((s) => ({
      id: String(s.id || ""),
      status: String(s.status || ""),
      name: String(s.name || ""),
    })).filter((s) => s.id);
  }, [detail]);

  const draftShipments = useMemo(
    () => shipments.filter((s) => String(s.status).toUpperCase() === "DRAFT" || String(s.status).toUpperCase() === "READY_TO_SHIP"),
    [shipments]
  );

  const loadDetail = useCallback(async () => {
    if (!tid) return;
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    setError("");
    setDetail(null);
    try {
      const data = await adminGraphql(TRANSFER_DETAIL_QUERY, { id: tid }, { signal: ac.signal || undefined });
      const t = data?.inventoryTransfer;
      if (!t) {
        setError("Transfer を取得できませんでした");
        return;
      }
      setDetail({
        id: String(t.id || ""),
        name: String(t.name || ""),
        status: String(t.status || ""),
        shipments: t.shipments || { nodes: [] },
      });
    } catch (e) {
      setError(String(e?.message || e || "取得に失敗しました"));
    } finally {
      setLoading(false);
    }
  }, [tid]);

  useEffect(() => {
    loadDetail();
    return () => {
      try { abortRef.current?.abort?.(); } catch (_) {}
    };
  }, [loadDetail]);

  const handleMarkInTransit = useCallback(
    async (shipmentId) => {
      if (!shipmentId || submittingId) return;
      setSubmittingId(shipmentId);
      try {
        const data = await adminGraphql(MARK_IN_TRANSIT_MUTATION, { id: shipmentId });
        const payload = data?.inventoryShipmentMarkInTransit;
        const errs = Array.isArray(payload?.userErrors) ? payload.userErrors : [];
        if (errs.length > 0) {
          const msg = errs.map((e) => e?.message).filter(Boolean).join(" / ") || "失敗しました";
          throw new Error(msg);
        }
        toast("出庫を確定しました");
        setAppState((prev) => {
          const o = prev?.outbound && typeof prev.outbound === "object" ? prev.outbound : {};
          return { ...prev, outbound: { ...o, historyEditTransferId: "" } };
        });
        onBack?.();
      } catch (e) {
        toast(String(e?.message || e || "確定に失敗しました"));
      } finally {
        setSubmittingId("");
      }
    },
    [setAppState, onBack, submittingId]
  );

  const handleAddShipment = useCallback(() => {
    if (!tid) return;
    setAppState((prev) => {
      const o = prev?.outbound && typeof prev.outbound === "object" ? prev.outbound : {};
      return { ...prev, outbound: { ...o, addShipmentToTransferId: tid, historyEditTransferId: "" } };
    });
    onAddShipment?.(tid);
  }, [tid, setAppState, onAddShipment]);

  useEffect(() => {
    if (!setHeader) return;
    setHeader(
      <s-box padding="base">
        <s-stack direction="inline" gap="small" alignItems="center">
          <s-button onClick={onBack}>戻る</s-button>
          <s-text emphasis="bold">配送準備完了の編集</s-text>
        </s-stack>
      </s-box>
    );
    return () => setHeader(null);
  }, [setHeader, onBack]);

  useEffect(() => {
    setFooter?.(null);
    return () => setFooter?.(null);
  }, [setFooter]);

  if (!tid) {
    return (
      <s-box padding="base">
        <s-text tone="subdued">Transfer が選択されていません</s-text>
      </s-box>
    );
  }

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
        <s-text tone="critical">{error}</s-text>
      </s-box>
    );
  }

  if (draftShipments.length === 0) {
    return (
      <s-box padding="base">
        <s-text tone="subdued">確定できる配送がありません</s-text>
      </s-box>
    );
  }

  return (
    <s-box padding="base">
      <s-stack gap="base">
        {draftShipments.length === 1 ? (
          <s-stack gap="small">
            <s-button
              tone="success"
              disabled={!!submittingId}
              onClick={() => handleMarkInTransit(draftShipments[0].id)}
            >
              {submittingId === draftShipments[0].id ? "確定中..." : "この配送を確定"}
            </s-button>
            <s-button kind="secondary" onClick={handleAddShipment}>
              配送を追加
            </s-button>
          </s-stack>
        ) : (
          <>
            <s-text emphasis="bold" size="small">配送一覧</s-text>
            {draftShipments.map((s) => (
              <s-box key={s.id} padding="small" border="base">
                <s-stack gap="small">
                  <s-text size="small">{s.name || s.id}</s-text>
                  <s-button
                    tone="success"
                    disabled={!!submittingId}
                    onClick={() => handleMarkInTransit(s.id)}
                  >
                    {submittingId === s.id ? "確定中..." : "この配送を確定"}
                  </s-button>
                </s-stack>
              </s-box>
            ))}
            <s-button kind="secondary" onClick={handleAddShipment}>
              配送を追加
            </s-button>
          </>
        )}
      </s-stack>
    </s-box>
  );
}
