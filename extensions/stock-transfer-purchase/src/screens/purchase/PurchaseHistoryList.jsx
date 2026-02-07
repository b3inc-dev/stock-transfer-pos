/**
 * 仕入履歴一覧画面（入庫コンディションUIをそのまま参考）
 * - 複数配送不要
 */
import { useState, useMemo, useCallback, useEffect, useRef } from "preact/hooks";
import {
  readPurchaseEntries,
  writePurchaseEntries,
  fetchLocations,
  fetchVariantImage,
  adjustInventoryAtLocation,
  searchVariants,
  fetchVariantAvailable,
} from "./purchaseApi.js";
import { getStatusBadgeTone } from "../../lossHelpers.js";
import { FixedFooterNavBar } from "../../FixedFooterNavBar.jsx";

// ヘルパー関数（入庫商品リストUIを参考）
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
  const parts = v.split("/").map((s) => s.trim()).filter(Boolean);
  return parts;
}

function formatOptionsLine_(options) {
  const ops = Array.isArray(options) ? options.filter(Boolean) : [];
  if (ops.length === 0) return "";
  return ops.join(" / ");
}

function safeImageSrc_(maybeUrl) {
  const u = typeof maybeUrl === "string" ? maybeUrl.trim() : "";
  if (!u) return "";
  if (u.startsWith("//")) return `https:${u}`;
  if (u.startsWith("https://")) return u;
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
      <s-image src={src} alt="" inlineSize="fill" objectFit="cover" />
    </s-box>
  );
}

function StockyRowShell({ children }) {
  // InboundUiParts.jsx と同じ
  return (
    <s-box paddingInline="none" paddingBlockStart="small-100" paddingBlockEnd="small-200">
      {children}
    </s-box>
  );
}

function ItemLeftCompact({ showImages, imageUrl, productTitle, variantTitle, line3 }) {
  const pRaw = String(productTitle || "").trim() || "(unknown)";
  const vRaw = String(variantTitle || "").trim();
  const options = normalizeVariantOptions_(pRaw, vRaw);
  const optionsLine = formatOptionsLine_(options);
  const optText = String(optionsLine || "").trim();
  const line3Text = String(line3 || "").trim();

  return (
    <s-stack direction="inline" gap="base" alignItems="center" justifyContent="start">
      {showImages ? <Thumb imageUrl={imageUrl} sizePx={44} /> : null}
      <s-stack gap="extra-tight">
        <s-text emphasis="bold" style={{ display: "block", whiteSpace: "normal", overflow: "visible", wordBreak: "break-word" }}>
          {pRaw}
        </s-text>
        {optText ? (
          <s-text tone="subdued" size="small" style={{ display: "block", whiteSpace: "normal", overflow: "visible", wordBreak: "break-word" }}>
            {optText}
          </s-text>
        ) : null}
        {line3Text ? (
          <s-text tone="subdued" size="small" style={{ display: "block", whiteSpace: "normal", overflow: "visible", wordBreak: "break-word" }}>
            {line3Text}
          </s-text>
        ) : null}
      </s-stack>
    </s-stack>
  );
}

function toInventoryKey_(id) {
  const s = String(id || "").trim();
  if (!s) return "";
  const m = s.match(/(\d+)$/);
  return m ? m[1] : s;
}

function toQtyModalId_(keyBase) {
  const s = String(keyBase || "row").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60);
  return `qty-purchase-${s}`;
}

function QtyControlCompact_3Buttons({
  value,
  min = 0,
  max = 999999,
  title = "数量",
  modalId,
  onDec,
  onInc,
  onSetQty,
  onRemove,
  disabled = false,
}) {
  // InboundUiParts.jsx と同じ
  const v = Number.isFinite(Number(value)) ? Number(value) : min;
  const id = useMemo(() => String(modalId), [modalId]);
  const [text, setText] = useState(String(v));
  useEffect(() => setText(String(v)), [v]);

  const clamp = (n) => Math.min(max, Math.max(min, Math.floor(Number(n || min))));
  const digits = String(v).length;
  const valueWidth = (() => {
    if (digits <= 1) return 56;
    if (digits === 2) return 64;
    if (digits === 3) return 76;
    if (digits === 4) return 96;
    return 112;
  })();
  const subduedTone = disabled ? "subdued" : undefined;

  return (
    <>
      <s-stack direction="inline" gap="extra-tight" alignItems="center" justifyContent="end" style={{ flexWrap: "nowrap" }}>
        <s-box inlineSize="44px">
          {(() => {
            const canRemove = typeof onRemove === "function";
            const isRemoveMode = canRemove && v <= min;
            return (
              <s-button
                tone={disabled ? subduedTone : (isRemoveMode ? "critical" : undefined)}
                onClick={() => (isRemoveMode ? onRemove?.() : onDec?.())}
                onPress={() => (isRemoveMode ? onRemove?.() : onDec?.())}
                disabled={disabled || (!isRemoveMode && v <= min)}
                style={{ width: "100%", whiteSpace: "nowrap" }}
              >
                {isRemoveMode ? "×" : "−"}
              </s-button>
            );
          })()}
        </s-box>
        <s-box inlineSize={`${valueWidth}px`}>
          <s-button
            command="--show"
            commandFor={id}
            disabled={disabled}
            tone={subduedTone}
            style={{ width: "100%", whiteSpace: "nowrap" }}
            onClick={() => setText(String(v))}
          >
            {v}
          </s-button>
        </s-box>
        <s-box inlineSize="44px">
          <s-button
            onClick={() => onInc?.()}
            onPress={() => onInc?.()}
            disabled={disabled || v >= max}
            tone={subduedTone}
            style={{ width: "100%", whiteSpace: "nowrap" }}
          >
            +
          </s-button>
        </s-box>
      </s-stack>

      <s-modal id={id} heading={title}>
        <s-box padding="base" paddingBlockEnd="none">
          <s-stack gap="base">
            <s-text size="small" tone="subdued">数量を入力してください（{min}〜{max}）</s-text>
            <s-text-field
              label="数量"
              value={text}
              inputMode="numeric"
              onInput={(e) => setText(String(e?.target?.value ?? e ?? ""))}
              onChange={(e) => setText(String(e?.target?.value ?? e ?? ""))}
            />
            {onRemove ? (
              <>
                <s-divider />
                <s-box padding="none">
                  <s-button tone="critical" command="--hide" commandFor={id} onClick={() => onRemove?.()} onPress={() => onRemove?.()}>
                    削除
                  </s-button>
                </s-box>
                <s-divider />
              </>
            ) : null}
            <s-box padding="none">
              <s-button command="--hide" commandFor={id}>戻る</s-button>
            </s-box>
          </s-stack>
        </s-box>
        <s-button
          slot="primary-action"
          tone="success"
          command="--hide"
          commandFor={id}
          onClick={() => {
            const raw = String(text ?? "").trim();
            const n = clamp(raw === "" ? min : raw);
            onSetQty?.(Number.isFinite(n) ? n : min);
          }}
        >
          OK
        </s-button>
      </s-modal>
    </>
  );
}

function CandidateAddRow({
  c,
  showImages,
  liteMode,
  readOnly,
  shownQty,
  onAddOne,
  onAddQty,
  stockText,
}) {
  const vid = String(c?.variantId || "").trim();
  if (!vid) return null;
  const productTitle = String(c?.productTitle || "").trim() || "(no title)";
  const variantTitle = String(c?.variantTitle || "").trim();
  const sku = String(c?.sku || "").trim();
  const barcode = String(c?.barcode || "").trim();
  const skuLine = `${sku ? `SKU: ${sku}` : ""}${barcode ? `${sku ? " / " : ""}JAN: ${barcode}` : ""}`.trim();

  const q = Math.max(0, Number(shownQty || 0));
  const modalId = toQtyModalId_(`CAND_${vid}`);
  const clampAdd = (s) => {
    const x = Number(String(s || "").replace(/[^\d]/g, ""));
    if (!Number.isFinite(x)) return 1;
    return Math.max(1, Math.min(999999, Math.floor(x)));
  };
  const [text, setText] = useState(String(q > 0 ? q : 1));
  useEffect(() => setText(String(q > 0 ? q : 1)), [q]);

  // 入庫と同じ：数量ボタン幅は桁数で可変
  const qtyWidth = (() => {
    const digits = String(Math.max(0, Math.floor(q))).length;
    if (digits <= 1) return 56;
    if (digits === 2) return 64;
    if (digits === 3) return 76;
    if (digits === 4) return 96;
    return 112;
  })();

  return (
    <s-box padding="none">
      <StockyRowShell>
        <s-stack gap="extra-tight">
          <s-box style={{ width: "100%" }}>
            <ItemLeftCompact
              showImages={showImages && !liteMode}
              imageUrl={c?.imageUrl || ""}
              productTitle={productTitle}
              variantTitle={variantTitle}
              line3={skuLine}
            />
          </s-box>

          <s-box inlineSize="100%">
            <s-stack direction="inline" gap="base" justifyContent="space-between" alignItems="center" style={{ width: "100%", flexWrap: "nowrap" }}>
              <s-box style={{ flex: "1 1 auto", minWidth: 0 }}>
                <s-text tone="subdued" size="small" style={{ whiteSpace: "nowrap" }}>
                  {String(stockText || "").trim() ? stockText : " "}
                </s-text>
              </s-box>
              <s-box style={{ flex: "0 0 auto" }}>
                <s-stack direction="inline" gap="extra-tight" alignItems="center" justifyContent="end" style={{ flexWrap: "nowrap", whiteSpace: "nowrap" }}>
                  <s-box inlineSize={`${qtyWidth}px`}>
                    <s-button
                      command="--show"
                      commandFor={modalId}
                      onClick={() => setText(String(q > 0 ? q : 1))}
                      disabled={readOnly}
                      tone={readOnly ? "subdued" : undefined}
                      style={{ width: "100%", whiteSpace: "nowrap" }}
                    >
                      {q}
                    </s-button>
                  </s-box>
                  <s-box inlineSize="44px">
                    <s-button
                      tone={readOnly ? "subdued" : "success"}
                      disabled={readOnly}
                      onClick={onAddOne}
                      onPress={onAddOne}
                      style={{ width: "100%", whiteSpace: "nowrap" }}
                    >
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
        <s-box padding="base" paddingBlockEnd="none">
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
            <s-divider />
            <s-box>
              <s-button command="--hide" commandFor={modalId}>戻る</s-button>
            </s-box>
          </s-stack>
        </s-box>
        <s-button
          slot="primary-action"
          tone={readOnly ? "subdued" : "success"}
          disabled={readOnly}
          command="--hide"
          commandFor={modalId}
          onClick={() => onAddQty?.(clampAdd(text))}
          onPress={() => onAddQty?.(clampAdd(text))}
        >
          追加
        </s-button>
      </s-modal>
      <s-divider />
    </s-box>
  );
}

const SHOPIFY = globalThis?.shopify ?? {};
const toast = (m) => SHOPIFY?.toast?.show?.(String(m));

/** 仕入入庫確定時の在庫変動をアプリAPIに記録（履歴で「仕入」と表示されるようにする） */
async function logPurchaseToApi({ locationId, locationName, deltas, sourceId, lineItems }) {
  const session = SHOPIFY?.session;
  if (!session?.getSessionToken || !deltas?.length || !sourceId) return;
  try {
    const token = await session.getSessionToken();
    if (!token) return;
    const { getAppUrl } = await import("../../../../common/appUrl.js");
    const appUrl = getAppUrl(); // 公開アプリ本番: https://pos-stock-public.onrender.com
    const apiUrl = `${appUrl}/api/log-inventory-change`;
    const timestamp = new Date().toISOString();
    for (const d of deltas) {
      if (!d?.inventoryItemId || Number(d?.delta || 0) <= 0) continue;
      const li = lineItems?.find((l) => String(l?.inventoryItemId || "").trim() === d.inventoryItemId);
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          inventoryItemId: d.inventoryItemId,
          variantId: li?.variantId ?? d.variantId ?? null,
          sku: li?.sku ?? d.sku ?? "",
          locationId,
          locationName: locationName || locationId,
          activity: "purchase_entry",
          delta: Number(d.delta),
          quantityAfter: d.quantityAfter ?? null,
          sourceId,
          timestamp,
        }),
      });
      if (!res.ok) console.warn("[PurchaseHistoryList] log-inventory-change failed:", res.status);
    }
  } catch (e) {
    console.warn("[PurchaseHistoryList] logPurchaseToApi:", e);
  }
}

// POS セッションのロケーションIDを取得
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
      if (tickCount >= 50) clearInterval(iv);
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

// POS セッションのロケーションGIDを取得
function useOriginLocationGid() {
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

// 日付フォーマット
const formatDate = (iso) => {
  const s = String(iso || "").trim();
  if (!s) return "-";
  return s.slice(0, 10);
};

// ステータス表示用ラベル
const STATUS_LABEL = {
  pending: "未入庫",
  received: "入庫済み",
  cancelled: "キャンセル",
};

const PURCHASE_HISTORY_DRAFT_PREFIX = "stock_transfer_pos_purchase_history_draft_v1_";

export function PurchaseHistoryList({
  onBack,
  locations: locationsProp = [],
  setLocations,
  setHeader,
  setFooter,
  liteMode,
  onToggleLiteMode,
}) {
  const locationGid = useOriginLocationGid();
  const locs = Array.isArray(locationsProp) ? locationsProp : [];
  const locationName = useMemo(() => {
    const loc = locs.find((l) => l.id === locationGid);
    return loc?.name || "現在店舗";
  }, [locationGid, locs]);

  const [viewMode, setViewMode] = useState("pending"); // "pending" | "received"
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [entries, setEntries] = useState([]);
  const [selectedEntryId, setSelectedEntryId] = useState("");
  const [imageUrls, setImageUrls] = useState(new Map()); // 画像URLキャッシュ
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [lines, setLines] = useState([]);
  const [extras, setExtras] = useState([]); // 予定外仕入（検索で追加したもの）
  const [addQtyById, setAddQtyById] = useState({}); // 検索リストでの「追加済み」表示（variantId -> qty）
  const [candStockVersion, setCandStockVersion] = useState(0);
  const candStockCacheRef = useRef({ map: new Map(), fetched: new Set() });
  const selectedEntry = useMemo(() => {
    if (!selectedEntryId) return null;
    return (Array.isArray(entries) ? entries : []).find((e) => e.id === selectedEntryId) || null;
  }, [selectedEntryId, entries]);
  const historyDraftLoadedRef = useRef(false);

  const isCompleted = (e) => e.status === "received" || e.status === "cancelled";
  const listToShow = useMemo(() => {
    const base = Array.isArray(entries) ? entries : [];
    return viewMode === "received" ? base.filter(isCompleted) : base.filter((e) => !isCompleted(e));
  }, [entries, viewMode]);
  const baseAll = Array.isArray(entries) ? entries : [];
  const pendingEntriesAll = baseAll.filter((e) => !isCompleted(e));
  const completedEntriesAll = baseAll.filter(isCompleted);
  const displayLocationName = useMemo(() => {
    const arr = Array.isArray(entries) ? entries : [];
    const any = arr.find((e) => String(e?.locationName || "").trim());
    if (any?.locationName) return String(any.locationName).trim();
    return locationName;
  }, [entries, locationName]);

  const refresh = useCallback(async () => {
    if (!locationGid) return;
    setLoading(true);
    setError("");
    setEntries([]);
    try {
      const list = await readPurchaseEntries();
      const allEntries = Array.isArray(list) ? list : [];
      // 現在のロケーションでフィルター
      const filtered = allEntries.filter((e) => e.locationId === locationGid);
      setEntries(filtered);
    } catch (e) {
      setError(String(e?.message ?? e));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [locationGid]);

  useEffect(() => {
    if (!locationGid) return;
    refresh().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationGid]);

  useEffect(() => {
    if (locs.length > 0 || !setLocations) return;
    let mounted = true;
    fetchLocations().then((list) => {
      if (mounted) setLocations(list);
    });
    return () => {
      mounted = false;
    };
  }, [locs.length, setLocations]);

  const onTapEntry = useCallback((entry) => {
    setSelectedEntryId(entry.id);
    // 詳細に入った瞬間に検索状態を初期化
    setQuery("");
    setCandidates([]);
    setImageUrls(new Map());
    setExtras([]);
    setAddQtyById({});
  }, []);

  // 選択中エントリに合わせて編集用 lines を生成
  useEffect(() => {
    if (!selectedEntryId) {
      setLines([]);
      setExtras([]);
      historyDraftLoadedRef.current = false;
      return;
    }
    const entry = (Array.isArray(entries) ? entries : []).find((e) => e.id === selectedEntryId);
    if (!entry) {
      setLines([]);
      setExtras([]);
      historyDraftLoadedRef.current = false;
      return;
    }
    const next = (Array.isArray(entry.items) ? entry.items : []).map((it, idx) => {
      const productTitle = String(it.productTitle || "").trim() || String(it.title || "").trim() || "(unknown)";
      // pending(from order) は option1-3 を持つことがある。received(from POS) は variantTitle を持つ。
      const optFromFields = [it.option1, it.option2, it.option3].map((s) => String(s || "").trim()).filter(Boolean);
      const variantTitle = String(it.variantTitle || "").trim() || (optFromFields.length ? optFromFields.join(" / ") : "");
      return ({
        id: String(it.inventoryItemId || it.variantId || idx),
        inventoryItemId: it.inventoryItemId,
        variantId: it.variantId,
        productTitle,
        variantTitle,
        sku: it.sku || "",
        barcode: it.barcode || "",
        imageUrl: it.imageUrl || "",
        plannedQty: Math.max(0, Number(it.quantity || 0)),
        // 入庫の未処理（未入庫）と同じ：初期は 0（検品で積み上げる）
        receiveQty: entry.status === "pending" ? 0 : Math.max(0, Number(it.quantity || 0)),
      });
    });
    setLines(next);
    setExtras([]);

    // 仕入履歴の編集中下書きがあれば復元（entry.id 単位）
    (async () => {
      try {
        if (historyDraftLoadedRef.current) return;
        if (!SHOPIFY?.storage?.get) return;
        const key = `${PURCHASE_HISTORY_DRAFT_PREFIX}${entry.id}`;
        const saved = await SHOPIFY.storage.get(key);
        if (!saved || typeof saved !== "object") return;
        if (String(saved.entryId || "") !== String(entry.id)) return;

        const savedLinesRaw = Array.isArray(saved.lines) ? saved.lines : [];
        const savedExtrasRaw = Array.isArray(saved.extras) ? saved.extras : [];

        const normLines = savedLinesRaw
          .map((l, i) => ({
            id: String(l?.id ?? `${entry.id}-L-${i}`),
            inventoryItemId: l?.inventoryItemId ?? null,
            variantId: l?.variantId ?? null,
            productTitle: String(l?.productTitle || ""),
            variantTitle: String(l?.variantTitle || ""),
            sku: String(l?.sku || ""),
            barcode: String(l?.barcode || ""),
            imageUrl: String(l?.imageUrl || ""),
            plannedQty: Math.max(0, Number(l?.plannedQty || 0)),
            receiveQty: Math.max(0, Number(l?.receiveQty || 0)),
          }))
          .filter((l) => l.variantId || l.inventoryItemId);

        const normExtras = savedExtrasRaw
          .map((l, i) => ({
            id: String(l?.id ?? `${entry.id}-E-${i}`),
            inventoryItemId: l?.inventoryItemId ?? null,
            variantId: l?.variantId ?? null,
            productTitle: String(l?.productTitle || ""),
            variantTitle: String(l?.variantTitle || ""),
            sku: String(l?.sku || ""),
            barcode: String(l?.barcode || ""),
            imageUrl: String(l?.imageUrl || ""),
            plannedQty: 0,
            receiveQty: Math.max(0, Number(l?.receiveQty || 0)),
          }))
          .filter((l) => l.variantId || l.inventoryItemId);

        if (normLines.length > 0 || normExtras.length > 0) {
          historyDraftLoadedRef.current = true;
          setLines(normLines.length > 0 ? normLines : next);
          setExtras(normExtras);
          toast("履歴の下書きを復元しました");
        }
      } catch (e) {
        console.error("[PurchaseHistoryList] failed to load draft", e);
      }
    })();
  }, [selectedEntryId, entries]);

  // 検索（入庫商品リストの「検索」ブロック相当）
  useEffect(() => {
    if (!selectedEntryId) return;
    const q = String(query || "").trim();
    if (q.length < 1) {
      setCandidates([]);
      return;
    }
    let alive = true;
    (async () => {
      try {
        const list = await searchVariants(q, { first: 50, includeImages: !liteMode });
        if (!alive) return;
        setCandidates(Array.isArray(list) ? list : []);
      } catch (e) {
        if (!alive) return;
        setCandidates([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [selectedEntryId, query, liteMode]);

  const bumpCandStock = useCallback(() => setCandStockVersion((v) => v + 1), []);

  const getCandStock = useCallback((key) => {
    void candStockVersion;
    return candStockCacheRef.current.map.get(String(key || ""));
  }, [candStockVersion]);

  const ensureCandStock = useCallback(
    async (key, variantId, locationId) => {
      const k = String(key || "").trim();
      const vid = String(variantId || "").trim();
      if (!k || !vid || !locationId) return;
      if (candStockCacheRef.current.fetched.has(k)) return;
      candStockCacheRef.current.fetched.add(k);
      candStockCacheRef.current.map.set(k, { loading: true, available: null, error: null });
      bumpCandStock();
      try {
        const r = await fetchVariantAvailable({ variantGid: vid, locationGid: locationId });
        const available = Number.isFinite(Number(r?.available)) ? Number(r.available) : null;
        candStockCacheRef.current.map.set(k, { loading: false, available, error: null });
      } catch (e) {
        candStockCacheRef.current.map.set(k, { loading: false, available: null, error: e });
      } finally {
        bumpCandStock();
      }
    },
    [bumpCandStock]
  );

  // 検索候補の在庫数を先読み（Hooksはループ内で呼ばない）
  useEffect(() => {
    if (!selectedEntryId) return;
    if (!selectedEntry?.locationId) return;
    const list = Array.isArray(candidates) ? candidates.slice(0, 20) : [];
    list.forEach((c) => {
      const vid = String(c?.variantId || "").trim();
      if (!vid) return;
      ensureCandStock(vid, vid, selectedEntry.locationId);
    });
  }, [selectedEntryId, selectedEntry?.locationId, candidates, ensureCandStock]);

  // 画像URLがない商品に対して、variantIdから画像URLを取得（Hooksは条件分岐の外で呼ぶ）
  useEffect(() => {
    if (!selectedEntryId) return;
    const entry = selectedEntry;
    if (!entry?.items?.length) return;
    let alive = true;
    (async () => {
      const urlMap = new Map();
      const list = Array.isArray(entry.items) ? entry.items : [];
      await Promise.all(list.map(async (it) => {
        const key = it.inventoryItemId || it.variantId || "";
        if (!key) return;
        if (it.imageUrl) {
          urlMap.set(key, it.imageUrl);
          return;
        }
        if (it.variantId) {
          try {
            const imageUrl = await fetchVariantImage(it.variantId);
            if (imageUrl) urlMap.set(key, imageUrl);
          } catch {
            // ignore
          }
        }
      }));
      if (!alive) return;
      if (urlMap.size > 0) {
        setImageUrls((prev) => {
          const merged = new Map(prev);
          urlMap.forEach((v, k) => merged.set(k, v));
          return merged;
        });
      }
    })();
    return () => {
      alive = false;
    };
  }, [selectedEntryId, selectedEntry]);

  const upsertLineByCandidate = useCallback((c, { incBy = 1 } = {}) => {
    const invIdRaw = c?.inventoryItemId;
    const varIdRaw = c?.variantId;
    if (!varIdRaw) return;
    const invKey = toInventoryKey_(invIdRaw);
    const varKey = String(varIdRaw || "").trim();
    if (!invKey && !varKey) return;
    // 既存 planned にあれば仕入数を増やす。なければ「予定外」に追加。
    let addedKind = "none"; // "planned" | "extras" | "none"
    setLines((prev) => {
      const list = Array.isArray(prev) ? prev : [];
      const hit = list.find((l) => {
        const lk = toInventoryKey_(l.inventoryItemId);
        if (lk && invKey) return lk === invKey;
        const lv = String(l.variantId || "").trim();
        return lv && varKey && lv === varKey;
      });
      if (!hit) return list;
      addedKind = "planned";
      return list.map((l) => {
        const lk = toInventoryKey_(l.inventoryItemId);
        const lv = String(l.variantId || "").trim();
        const isSame = (lk && invKey && lk === invKey) || (!lk && !invKey && lv && varKey && lv === varKey);
        if (!isSame) return l;
        return { ...l, receiveQty: Math.max(0, Number(l.receiveQty || 0) + incBy) };
      });
    });
    setExtras((prev) => {
      const list = Array.isArray(prev) ? prev : [];
      // planned に存在して数量を増やしただけの場合は、予定外には追加しない
      if (addedKind === "planned") {
        return list;
      }
      // 既に extras にあればそこも増やす
      const hit = list.find((l) => toInventoryKey_(l.inventoryItemId) === invKey);
      if (hit) {
        addedKind = "extras";
        return list.map((l) =>
          toInventoryKey_(l.inventoryItemId) === invKey
            ? { ...l, receiveQty: Math.max(0, Number(l.receiveQty || 0) + incBy) }
            : l
        );
      }
      // planned に存在しない場合だけ、新規に予定外を追加
      addedKind = "extras";
      const nextExtras = [
        ...list,
        {
          id: invKey || varKey,
          inventoryItemId: invIdRaw || varIdRaw,
          variantId: varIdRaw,
          productTitle: c.productTitle || "",
          variantTitle: c.variantTitle || "",
          sku: c.sku || "",
          barcode: c.barcode || "",
          imageUrl: c.imageUrl || "",
          plannedQty: 0,
          receiveQty: Math.max(0, incBy),
        },
      ];
      return nextExtras;
    });

    // 追加結果に応じてトースト（新規商品リストと同様のフィードバック）
    try {
      const baseTitle =
        String(c?.productTitle || "").trim() ||
        String(c?.variantTitle || "").trim() ||
        String(c?.sku || "").trim() ||
        "(no title)";
      if (addedKind === "planned") {
        toast(`${baseTitle} を追加しました（+${incBy}）`);
      } else if (addedKind === "extras") {
        toast(`${baseTitle} を予定外仕入に追加しました（+${incBy}）`);
      }
    } catch {
      // toast が失敗しても処理は続行
    }
  }, []);

  const addCandidateQty = useCallback((c, n) => {
    const qty = Math.max(1, Math.min(999999, Math.floor(Number(n || 1))));
    upsertLineByCandidate(c, { incBy: qty });
    const vid = String(c?.variantId || "").trim();
    if (!vid) return;
    setAddQtyById((prev) => {
      const cur = Number(prev?.[vid] || 0);
      return { ...(prev && typeof prev === "object" ? prev : {}), [vid]: cur + qty };
    });
  }, [upsertLineByCandidate]);

  const addCandidateOne = useCallback((c) => addCandidateQty(c, 1), [addCandidateQty]);

  const incLine = useCallback((id, delta) => {
    setLines((prev) => {
      const list = Array.isArray(prev) ? prev : [];
      const next = list
        .map((l) => (String(l.id) === String(id) ? { ...l, receiveQty: Math.max(0, Number(l.receiveQty || 0) + delta) } : l));
      return next;
    });
    setExtras((prev) => (Array.isArray(prev) ? prev : []).map((l) => (String(l.id) === String(id) ? { ...l, receiveQty: Math.max(0, Number(l.receiveQty || 0) + delta) } : l)).filter((l) => Number(l.receiveQty || 0) > 0));
  }, []);

  const setLineQty = useCallback((id, qty) => {
    const n = Math.max(0, Math.min(999999, Math.floor(Number(qty || 0))));
    setLines((prev) => {
      const list = Array.isArray(prev) ? prev : [];
      const next = list
        .map((l) => (String(l.id) === String(id) ? { ...l, receiveQty: n } : l));
      return next;
    });
    setExtras((prev) => (Array.isArray(prev) ? prev : []).map((l) => (String(l.id) === String(id) ? { ...l, receiveQty: n } : l)).filter((l) => Number(l.receiveQty || 0) > 0));
  }, []);

  const plannedTotal = useMemo(() => (Array.isArray(lines) ? lines : []).reduce((s, l) => s + Math.max(0, Number(l.plannedQty || 0)), 0), [lines]);
  const receiveTotal = useMemo(() => {
    const a = (Array.isArray(lines) ? lines : []).reduce((s, l) => s + Math.max(0, Number(l.receiveQty || 0)), 0);
    const b = (Array.isArray(extras) ? extras : []).reduce((s, l) => s + Math.max(0, Number(l.receiveQty || 0)), 0);
    return a + b;
  }, [lines, extras]);
  const extrasQtyTotal = useMemo(() => (Array.isArray(extras) ? extras : []).reduce((s, l) => s + Math.max(0, Number(l.receiveQty || 0)), 0), [extras]);
  const overQtyTotal = useMemo(() => (Array.isArray(lines) ? lines : []).reduce((s, l) => s + Math.max(0, Number(l.receiveQty || 0) - Number(l.plannedQty || 0)), 0), [lines]);
  const shortageQtyTotal = useMemo(() => (Array.isArray(lines) ? lines : []).reduce((s, l) => s + Math.max(0, Number(l.plannedQty || 0) - Number(l.receiveQty || 0)), 0), [lines]);

  const handleConfirmSelected = useCallback(async () => {
    const entry = (Array.isArray(entries) ? entries : []).find((e) => e.id === selectedEntryId);
    if (!entry) return;
    if (entry.status !== "pending") return;
    if (!entry.locationId) return toast("入庫先ロケーションが指定されていません");
    if (receiveTotal <= 0) return toast("数量を入力してください");
    if (submitting) return;

    setSubmitting(true);
    try {
      const deltas = [
        ...(Array.isArray(lines) ? lines : []).map((l) => ({ inventoryItemId: l.inventoryItemId, delta: Math.abs(Number(l.receiveQty) || 0), variantId: l.variantId, sku: l.sku })),
        ...(Array.isArray(extras) ? extras : []).map((l) => ({ inventoryItemId: l.inventoryItemId, delta: Math.abs(Number(l.receiveQty) || 0), variantId: l.variantId, sku: l.sku })),
      ].filter((d) => d.inventoryItemId && d.delta > 0);
      await adjustInventoryAtLocation({
        locationId: entry.locationId,
        deltas,
        referenceDocumentUri: entry.id,
      });
      await logPurchaseToApi({
        locationId: entry.locationId,
        locationName: entry.locationName || "",
        deltas,
        sourceId: entry.id,
        lineItems: [...(Array.isArray(lines) ? lines : []), ...(Array.isArray(extras) ? extras : [])],
      });

      // #P → #B 付番（既に #B の場合は維持）
      let nextPurchaseName = String(entry.purchaseName || "").trim();
      if (!/^#B\\d+$/.test(nextPurchaseName)) {
        const all = await readPurchaseEntries();
        const bCount = (Array.isArray(all) ? all : []).filter((p) => /^#B\\d+$/.test(String(p?.purchaseName || "").trim())).length;
        nextPurchaseName = `#B${String(bCount + 1).padStart(4, "0")}`;
      }

      const now = new Date().toISOString();
      const nextEntry = {
        ...entry,
        purchaseName: nextPurchaseName,
        items: [
          ...(Array.isArray(lines) ? lines : []).map((l) => ({
          inventoryItemId: l.inventoryItemId,
          variantId: l.variantId,
          sku: l.sku ?? "",
          barcode: l.barcode ?? "",
          imageUrl: l.imageUrl ?? "",
          productTitle: l.productTitle ?? "",
          variantTitle: l.variantTitle ?? "",
          title: [l.productTitle, l.variantTitle].filter(Boolean).join(" / ") || l.sku || "-",
          quantity: Math.abs(Number(l.receiveQty) || 0),
          option1: "",
          option2: "",
          option3: "",
        })),
          ...(Array.isArray(extras) ? extras : []).map((l) => ({
            inventoryItemId: l.inventoryItemId,
            variantId: l.variantId,
            sku: l.sku ?? "",
            barcode: l.barcode ?? "",
            imageUrl: l.imageUrl ?? "",
            productTitle: l.productTitle ?? "",
            variantTitle: l.variantTitle ?? "",
            title: [l.productTitle, l.variantTitle].filter(Boolean).join(" / ") || l.sku || "-",
            quantity: Math.abs(Number(l.receiveQty) || 0),
            option1: "",
            option2: "",
            option3: "",
          })),
        ],
        status: "received",
        receivedAt: now,
      };

      const all = await readPurchaseEntries();
      const list = Array.isArray(all) ? all : [];
      const merged = list.map((e) => (String(e.id) === String(entry.id) ? nextEntry : e));
      await writePurchaseEntries(merged);

      // 確定後は下書きを削除
      try {
        if (SHOPIFY?.storage?.delete) {
          await SHOPIFY.storage.delete(`${PURCHASE_HISTORY_DRAFT_PREFIX}${entry.id}`);
        }
      } catch (e) {
        console.error("[PurchaseHistoryList] failed to delete draft", e);
      }

      toast("入庫を確定しました");
      // ローカル表示も更新
      setEntries((prev) => prev.map((e) => (String(e.id) === String(entry.id) ? nextEntry : e)));
      setSelectedEntryId("");
    } catch (e) {
      toast(`確定エラー: ${String(e?.message ?? e)}`);
    } finally {
      setSubmitting(false);
    }
  }, [entries, selectedEntryId, lines, extras, receiveTotal, submitting]);

  // 仕入履歴詳細の編集中下書きを自動保存（pending のときのみ）
  useEffect(() => {
    if (!selectedEntryId) return;
    const entry = (Array.isArray(entries) ? entries : []).find((e) => e.id === selectedEntryId);
    if (!entry || entry.status !== "pending") return;
    const key = `${PURCHASE_HISTORY_DRAFT_PREFIX}${entry.id}`;
    const hasStorage = !!SHOPIFY?.storage?.set;
    if (!hasStorage) return;

    const t = setTimeout(async () => {
      try {
        const payload = {
          entryId: entry.id,
          savedAt: Date.now(),
          lines: (Array.isArray(lines) ? lines : []).map((l, i) => ({
            id: l.id ?? `${entry.id}-L-${i}`,
            inventoryItemId: l.inventoryItemId ?? null,
            variantId: l.variantId ?? null,
            productTitle: l.productTitle ?? "",
            variantTitle: l.variantTitle ?? "",
            sku: l.sku ?? "",
            barcode: l.barcode ?? "",
            imageUrl: l.imageUrl ?? "",
            plannedQty: Math.max(0, Number(l.plannedQty || 0)),
            receiveQty: Math.max(0, Number(l.receiveQty || 0)),
          })),
          extras: (Array.isArray(extras) ? extras : []).map((l, i) => ({
            id: l.id ?? `${entry.id}-E-${i}`,
            inventoryItemId: l.inventoryItemId ?? null,
            variantId: l.variantId ?? null,
            productTitle: l.productTitle ?? "",
            variantTitle: l.variantTitle ?? "",
            sku: l.sku ?? "",
            barcode: l.barcode ?? "",
            imageUrl: l.imageUrl ?? "",
            receiveQty: Math.max(0, Number(l.receiveQty || 0)),
          })),
        };
        await SHOPIFY.storage.set(key, payload);
      } catch (e) {
        console.error("[PurchaseHistoryList] failed to save draft", e);
      }
    }, 300);

    return () => clearTimeout(t);
  }, [selectedEntryId, entries, lines, extras]);

  useEffect(() => {
    if (selectedEntryId) {
      const entry = entries.find((e) => e.id === selectedEntryId);
      if (!entry) {
        setHeader?.(null);
        return;
      }

      // 仕入履歴詳細ヘッダー（入庫商品リストUIのヘッダーを参考）
      const purchaseName = String(entry?.purchaseName || "").trim() || String(entry?.id || "").trim() || "仕入ID";
      const locName = entry.locationName || locs.find((l) => l.id === entry.locationId)?.name || "-";
      const date = formatDate(entry.date || entry.createdAt);
      const supplier = entry.supplierName || entry.supplier || "-";
      const staffName = entry.staffName || "-";
      const note = entry.note || "-";
      const readOnly = entry.status !== "pending";
      const showResults = String(query || "").trim().length >= 1;

      const headerNode = (
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
                {/* 1行目：仕入ID（太字） */}
                <s-text
                  emphasis="bold"
                  style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                >
                  {purchaseName}
                </s-text>
                {/* 2行目：入庫先 */}
                <s-text
                  size="small"
                  tone="subdued"
                  style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                >
                  入庫先：{locName}
                </s-text>
                {/* 3行目：仕入先 */}
                <s-text
                  size="small"
                  tone="subdued"
                  style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                >
                  仕入先：{supplier}
                </s-text>
                {/* 4行目：日付 */}
                <s-text
                  size="small"
                  tone="subdued"
                  style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                >
                  日付：{date}
                </s-text>
                {staffName !== "-" && (
                  <s-text
                    size="small"
                    tone="subdued"
                    style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                  >
                    スタッフ：{staffName}
                  </s-text>
                )}
                {note && note !== "-" && (
                  <s-text
                    size="small"
                    tone="subdued"
                    style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                  >
                    備考：{note}
                  </s-text>
                )}
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
                  onClick={() => {
                    // 全入庫＝予定数を仕入数へ反映
                    setLines((prev) => (Array.isArray(prev) ? prev : []).map((l) => ({ ...l, receiveQty: Math.max(0, Number(l.plannedQty || 0)) })));
                  }}
                  disabled={readOnly || submitting}
                  tone={readOnly ? "subdued" : undefined}
                  style={{ paddingInline: 8, whiteSpace: "nowrap" }}
                >
                  全入庫
                </s-button>
                <s-button
                  onClick={() => {
                    // リセット＝仕入数を0 + 予定外をクリア
                    setLines((prev) => (Array.isArray(prev) ? prev : []).map((l) => ({ ...l, receiveQty: 0 })));
                    setExtras([]);
                  }}
                  disabled={readOnly || submitting}
                  tone={readOnly ? "subdued" : "critical"}
                  style={{ paddingInline: 8, whiteSpace: "nowrap" }}
                >
                  リセット
                </s-button>
              </s-stack>
            </s-stack>
            {/* 検索（ヘッダー内） */}
            <s-box inlineSize="100%" paddingBlockStart="small-200" style={readOnly ? { opacity: 0.6 } : undefined}>
              <s-text-field
                label="検索"
                labelHidden
                placeholder="商品名 / SKU / バーコード"
                value={query}
                onInput={(e) => setQuery(String(e?.target?.value ?? e ?? ""))}
                onChange={(e) => setQuery(String(e?.target?.value ?? e ?? ""))}
                disabled={readOnly || submitting}
              >
                {query ? (
                  <s-button slot="accessory" kind="secondary" tone="critical" onClick={() => setQuery("")} disabled={readOnly || submitting}>
                    ✕
                  </s-button>
                ) : null}
              </s-text-field>
            </s-box>
            {showResults ? (
              <s-text tone="subdued" size="small">
                検索結果：{candidates.length}件
              </s-text>
            ) : null}
          </s-stack>
        </s-box>
      );

      setHeader?.(headerNode);
    } else {
      setHeader?.(
        <s-box padding="base">
          <s-stack gap="base">
            <s-stack direction="inline" gap="none" inlineSize="100%">
              <s-box inlineSize="50%">
                <s-button variant={viewMode === "pending" ? "primary" : "secondary"} onClick={() => setViewMode("pending")}>
                  未処理 {pendingEntriesAll.length}件
                </s-button>
              </s-box>
              <s-box inlineSize="50%">
                <s-button variant={viewMode === "received" ? "primary" : "secondary"} onClick={() => setViewMode("received")}>
                  入庫済み {completedEntriesAll.length}件
                </s-button>
              </s-box>
            </s-stack>
          </s-stack>
        </s-box>
      );
    }
    return () => setHeader?.(null);
  }, [setHeader, selectedEntryId, entries, viewMode, pendingEntriesAll.length, completedEntriesAll.length, locs, liteMode, onToggleLiteMode, query, candidates.length, submitting]);

  useEffect(() => {
    if (selectedEntryId) {
      const entry = entries.find((e) => e.id === selectedEntryId);
      if (!entry) {
        setFooter?.(null);
        return;
      }
      const statusJa = STATUS_LABEL[entry.status] || entry.status || "不明";
      const statusBadgeTone = getStatusBadgeTone(statusJa);
      const footerLine1 = `予定 ${plannedTotal} / 仕入 ${receiveTotal}`;
      const footerLine2 = `超過 ${overQtyTotal} / 不足 ${shortageQtyTotal}`;
      const hasDiff = (extrasQtyTotal + overQtyTotal + shortageQtyTotal) > 0;
      setFooter?.(
        <s-box padding="base">
          <s-stack
            direction="inline"
            gap="base"
            justifyContent="space-between"
            alignItems="center"
            style={{ width: "100%", flexWrap: "nowrap" }}
          >
            <s-box style={{ flex: "0 0 auto" }}>
              <s-button kind="secondary" onClick={() => setSelectedEntryId("")} style={{ whiteSpace: "nowrap" }}>
                戻る
              </s-button>
            </s-box>

            <s-box style={{ flex: "1 1 auto", minWidth: 0 }}>
              {/* バッジを「予定/仕入」の左に配置しつつ3行構成 */}
              <s-stack direction="inline" gap="small" alignItems="center" justifyContent="center">
                <s-badge tone={statusBadgeTone}>{statusJa}</s-badge>
                <s-stack gap="none" alignItems="flex-start">
                  <s-text alignment="start" size="small" tone="subdued">
                    {footerLine1}
                  </s-text>
                  <s-text alignment="start" size="small" tone={hasDiff ? "critical" : "subdued"}>
                    {footerLine2}
                  </s-text>
                  {extrasQtyTotal > 0 && (
                    <s-text alignment="start" size="small" tone="critical">
                      予定外 {extrasQtyTotal}
                    </s-text>
                  )}
                </s-stack>
              </s-stack>
            </s-box>

            <s-box style={{ flex: "0 0 auto" }}>
              <s-button
                tone={entry.status === "pending" ? "success" : undefined}
                disabled={entry.status !== "pending" || submitting || receiveTotal <= 0}
                onClick={handleConfirmSelected}
                onPress={handleConfirmSelected}
                style={{ whiteSpace: "nowrap" }}
              >
                {entry.status === "pending" ? (submitting ? "確定中..." : "確定") : "確定"}
              </s-button>
            </s-box>
          </s-stack>
        </s-box>
      );
      return () => setFooter?.(null);
    }

    setFooter?.(
      <FixedFooterNavBar
        summaryLeft=""
        summaryCenter=""
        summaryRight=""
        leftLabel="戻る"
        onLeft={onBack}
        middleLabel={liteMode ? "画像OFF" : "画像ON"}
        onMiddle={typeof onToggleLiteMode === "function" ? onToggleLiteMode : undefined}
        middleTone={liteMode ? "critical" : "default"}
        rightLabel={loading ? "読込中..." : "再読込"}
        onRight={refresh}
        rightDisabled={loading || !locationGid}
      />
    );
    return () => setFooter?.(null);
  }, [setFooter, selectedEntryId, entries, displayLocationName, viewMode, listToShow.length, liteMode, onToggleLiteMode, refresh, loading, locationGid, submitting, handleConfirmSelected]);

  // 商品リスト表示（入庫商品リストUIを参考）
  if (selectedEntryId) {
    const entry = entries.find((e) => e.id === selectedEntryId);
    if (!entry) {
      setSelectedEntryId("");
      return null;
    }

    const showImages = !liteMode;
    const readOnly = entry.status !== "pending";

    return (
      <s-stack gap="base">
        {/* 1. 検索結果ブロック（スクロール部分の入庫リスト上に表示） */}
        {String(query || "").trim().length >= 1 ? (
          <s-box padding="base" style={readOnly ? { opacity: 0.6 } : undefined}>
            <s-stack gap="extra-tight">
              <s-text>検索リスト 候補： {candidates.length}件</s-text>
              <s-stack gap="none">
                {candidates.length === 0 ? (
                  <s-text tone="subdued" size="small">該当なし</s-text>
                ) : (
                  candidates.slice(0, 20).map((c, idx) => {
                    const key = c.variantId || idx;
                    const vid = String(c?.variantId || "").trim();
                    const shownQty = Math.max(0, Number(addQtyById?.[vid] || 0));
                    const stock = getCandStock(vid);
                    const stockText =
                      stock?.loading ? "在庫: …" : `在庫: ${Number.isFinite(Number(stock?.available)) ? Number(stock.available) : "—"}`;
                    return (
                      <CandidateAddRow
                        key={key}
                        c={c}
                        showImages={showImages}
                        liteMode={liteMode}
                        readOnly={readOnly || submitting}
                        shownQty={shownQty}
                        onAddOne={() => addCandidateOne(c)}
                        onAddQty={(n) => addCandidateQty(c, n)}
                        stockText={stockText}
                      />
                    );
                  })
                )}
              </s-stack>
            </s-stack>
          </s-box>
        ) : null}

        {/* 2. 商品リスト（入庫商品リストUI相当。数量操作 + 確定はフッター） */}
        <StockyRowShell>
          <s-stack gap="small">
            <s-box paddingInline="small">
              <s-text emphasis="bold">仕入リスト</s-text>
            </s-box>
            {lines.length === 0 ? (
              <s-text tone="subdued" size="small">商品がありません</s-text>
            ) : (
              <s-stack gap="none">
                {lines.map((l, idx) => {
                  const sku = String(l.sku || "").trim();
                  const barcode = String(l.barcode || "").trim();
                  const skuLine = `${sku ? `SKU: ${sku}` : ""}${sku && barcode ? " / " : ""}${barcode ? `JAN: ${barcode}` : ""}`.trim();
                  const itemKey = l.inventoryItemId || l.variantId || l.id || "";
                  const imageUrl = String(l.imageUrl || "").trim() || (itemKey ? String(imageUrls.get(itemKey) || "") : "");
                  const modalId = toQtyModalId_(l.id);
                  return (
                    <s-box key={l.id} padding="none">
                      <s-box padding="base">
                        <s-stack gap="extra-tight" inlineSize="100%">
                          <ItemLeftCompact
                            showImages={showImages && !!imageUrl}
                            imageUrl={imageUrl}
                            productTitle={l.productTitle}
                            variantTitle={l.variantTitle}
                            line3={skuLine}
                          />
                          <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base" style={{ width: "100%", flexWrap: "nowrap" }}>
                            <s-box style={{ flex: "1 1 auto", minWidth: 0 }}>
                              <s-text tone="subdued" size="small" style={{ whiteSpace: "nowrap" }}>
                                予定 {Number(l.plannedQty || 0)} / 仕入 {Number(l.receiveQty || 0)}
                              </s-text>
                            </s-box>
                            <s-box style={{ flex: "0 0 auto" }}>
                              <QtyControlCompact_3Buttons
                                value={Number(l.receiveQty || 0)}
                                min={0}
                                modalId={modalId}
                                disabled={readOnly || submitting}
                                onDec={() => incLine(l.id, -1)}
                                onInc={() => incLine(l.id, 1)}
                                onSetQty={(n) => setLineQty(l.id, n)}
                              />
                            </s-box>
                          </s-stack>
                        </s-stack>
                      </s-box>
                      {idx < lines.length - 1 ? <s-divider /> : null}
                    </s-box>
                  );
                })}
              </s-stack>
            )}
          </s-stack>
        </StockyRowShell>

        {/* 3. 予定外仕入（入庫の「予定外入荷」相当）: 数量発生時のみ表示 */}
        {extrasQtyTotal > 0 && (
          <StockyRowShell>
            <s-stack gap="small">
              <s-box paddingInline="small">
                <s-text emphasis="bold">予定外仕入（リストにない商品）</s-text>
              </s-box>
              <s-stack gap="none">
                {extras.map((l, idx) => {
                  const sku = String(l.sku || "").trim();
                  const barcode = String(l.barcode || "").trim();
                  const skuLine = `${sku ? `SKU: ${sku}` : ""}${sku && barcode ? " / " : ""}${barcode ? `JAN: ${barcode}` : ""}`.trim();
                  const itemKey = l.inventoryItemId || l.variantId || l.id || "";
                  const imageUrl = String(l.imageUrl || "").trim() || (itemKey ? String(imageUrls.get(itemKey) || "") : "");
                  const modalId = toQtyModalId_(l.id);
                  return (
                    <s-box key={l.id} padding="none">
                      <s-box padding="base">
                        <s-stack gap="extra-tight" inlineSize="100%">
                          <ItemLeftCompact
                            showImages={showImages && !!imageUrl}
                            imageUrl={imageUrl}
                            productTitle={l.productTitle}
                            variantTitle={l.variantTitle}
                            line3={skuLine}
                          />
                          <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base" style={{ width: "100%", flexWrap: "nowrap" }}>
                            <s-box style={{ flex: "1 1 auto", minWidth: 0 }}>
                              <s-text tone="critical" size="small" style={{ whiteSpace: "nowrap" }}>
                                予定外 / 仕入 {Number(l.receiveQty || 0)}
                              </s-text>
                            </s-box>
                            <s-box style={{ flex: "0 0 auto" }}>
                              <QtyControlCompact_3Buttons
                                value={Number(l.receiveQty || 0)}
                                min={1}
                                modalId={modalId}
                                disabled={readOnly || submitting}
                                onDec={() => incLine(l.id, -1)}
                                onInc={() => incLine(l.id, 1)}
                                onSetQty={(n) => setLineQty(l.id, n)}
                                onRemove={() => {
                                  // 予定外は削除可能（入庫と同じ）
                                  setExtras((prev) => (Array.isArray(prev) ? prev : []).filter((x) => String(x.id) !== String(l.id)));
                                }}
                              />
                            </s-box>
                          </s-stack>
                        </s-stack>
                      </s-box>
                      {idx < extras.length - 1 ? <s-divider /> : null}
                    </s-box>
                  );
                })}
              </s-stack>
            </s-stack>
          </StockyRowShell>
        )}
      </s-stack>
    );
  }

  return (
    <>
      <s-box padding="base">
        <s-stack gap="base">
          {error ? <s-box padding="none"><s-text tone="critical">仕入履歴一覧の取得に失敗しました: {error}</s-text></s-box> : null}
          {listToShow.length === 0 ? (
            <s-text tone="subdued" size="small">{loading ? "読み込み中..." : "表示できる仕入履歴がありません"}</s-text>
          ) : (
            <s-stack gap="base">
              {listToShow.map((e) => {
                const head = String(e?.purchaseName || "").trim() || String(e?.id || "").trim() || "仕入ID";
                const date = formatDate(e?.date || e?.createdAt);
                const supplier = e?.supplier || "-";
                const location = e?.locationName || locs.find((l) => l.id === e.locationId)?.name || "-";
                const totalQty = (e.items ?? []).reduce((s, it) => s + (it.quantity || 0), 0);
                const itemCount = e.items?.length ?? 0;
                const statusJa = STATUS_LABEL[e.status] || e.status || "不明";
                const statusBadgeTone = getStatusBadgeTone(statusJa);
                return (
                  <s-box key={e.id}>
                    <s-clickable onClick={() => onTapEntry(e)}>
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
                            入庫先: {location}
                          </s-text>
                          <s-text tone="subdued" size="small" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                            仕入先: {supplier}
                          </s-text>
                          <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="small">
                            <s-stack direction="inline" gap="small" alignItems="center">
                              <s-badge tone={statusBadgeTone}>{statusJa}</s-badge>
                            </s-stack>
                            <s-text tone="subdued" size="small" style={{ whiteSpace: "nowrap" }}>
                              {itemCount}件・合計{totalQty}
                            </s-text>
                          </s-stack>
                        </s-stack>
                      </s-box>
                    </s-clickable>
                    <s-divider />
                  </s-box>
                );
              })}
            </s-stack>
          )}
        </s-stack>
      </s-box>
    </>
  );
}
