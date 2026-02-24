import { useState, useMemo, useCallback, useEffect, useRef } from "preact/hooks";
import {
  readOrderEntriesFirstPage,
  readOrderEntriesPage,
  readOrderEntriesFull,
  readOrderEntryById,
  writeOrderEntries,
  fetchLocations,
  fetchVariantImage,
} from "./orderApi.js";
import { getStatusBadgeTone } from "../../lossHelpers.js";
import { FixedFooterNavBar } from "./FixedFooterNavBar.jsx";

const SHOPIFY = globalThis?.shopify ?? {};
const toast = (m) => SHOPIFY?.toast?.show?.(String(m));

/** 一覧用：items を落として軽くする（入庫・出庫と同様にタップ後に詳細を扱うため） */
function stripEntryForList(entry) {
  if (!entry) return entry;
  const { items, ...rest } = entry;
  return { ...rest, items: [] };
}

// =========================
// ヘルパー関数（LossProductListから移植）
// =========================

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

// ItemLeftInlineコンポーネント（出庫履歴詳細と同じデザイン）
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

// POS セッションのロケーションIDを取得（Outbound useSessionLocationId と同様）
function useSessionLocationId() {
  const [rawId, setRawId] = useState(
    () => SHOPIFY?.session?.currentSession?.locationId ?? null
  );

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
      if (tickCount >= 50) {
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

// POS セッションのロケーションGIDを取得（Outbound useOriginLocationGid と同様）
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

// 日付フォーマット（OutboundHistoryConditionsと同じ）
const formatDate = (iso) => {
  const s = String(iso || "").trim();
  if (!s) return "-";
  return s.slice(0, 10);
};

// 発注名称の表示用ラベル
// - 管理画面で付与される orderName (#P0001 形式) を優先
// - なければ「ロケーション / 日付」
// - それもなければ id をそのまま表示
function formatOrderDisplayName(entry) {
  const name = String(entry?.orderName || "").trim();
  if (name) return name;

  const loc = String(entry?.locationName || "").trim();
  const date = formatDate(entry?.date || entry?.createdAt);
  if (loc && date && date !== "-") {
    return `${loc} / ${date}`;
  }

  const id = String(entry?.id || "").trim();
  if (id) return id;
  return "-";
}

// ステータス表示用ラベル
const STATUS_LABEL = {
  pending: "未処理",
  shipped: "発注済み",
  cancelled: "キャンセル",
};

export function OrderHistoryList({
  onBack,
  locations: locationsProp = [],
  setLocations,
  setHeader,
  setFooter,
  liteMode,
  onToggleLiteMode,
}) {
  const sessionLocationGid = useOriginLocationGid();
  const [entries, setEntries] = useState([]);
  const [historyMode, setHistoryMode] = useState("pending"); // "pending" | "processed"
  const [loading, setLoading] = useState(false); // ✅ 初期状態をfalseに変更（出庫履歴一覧と同じ）
  const [historyError, setHistoryError] = useState("");
  const [detailId, setDetailId] = useState("");
  const [cancelling, setCancelling] = useState("");
  const [imageUrls, setImageUrls] = useState(new Map()); // ✅ 画像URLキャッシュ
  const [detailLoading, setDetailLoading] = useState(false); // ✅ 一覧タップ後の詳細API取得中
  const locs = Array.isArray(locationsProp) ? locationsProp : [];
  const [chunkCount, setChunkCount] = useState(0);
  const [loadedChunkCount, setLoadedChunkCount] = useState(0);
  /** タップ後に詳細表示する用（一覧タップでAPI取得） */
  const [detailEntry, setDetailEntry] = useState(null);
  const fullEntriesByIdRef = useRef(new Map());

  const refreshOrderHistory = useCallback(async () => {
    if (!sessionLocationGid) return;
    setLoading(true);
    setHistoryError("");
    setEntries([]);
    setChunkCount(0);
    setLoadedChunkCount(0);
    setDetailEntry(null);
    fullEntriesByIdRef.current = new Map();
    try {
      const result = await readOrderEntriesFirstPage();
      const raw = Array.isArray(result.entries) ? result.entries : [];
      raw.forEach((e) => fullEntriesByIdRef.current.set(e.id, e));
      setEntries(raw.map(stripEntryForList));
      setChunkCount(result.chunkCount ?? 0);
      setLoadedChunkCount(1);
    } catch (e) {
      setHistoryError(String(e?.message ?? e));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [sessionLocationGid]);

  useEffect(() => {
    // 出庫履歴一覧と同じ処理：originLocationGidが取得できたらrefreshを呼ぶ
    if (!sessionLocationGid) {
      return;
    }
    refreshOrderHistory().catch((e) => {
      console.error("[OrderHistoryList] refreshOrderHistory error:", e);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionLocationGid]); // refreshLossHistoryを依存配列から除外（無限ループ防止）

  useEffect(() => {
    if (locs.length > 0 || !setLocations) return;
    let mounted = true;
    fetchLocations().then((list) => { if (mounted) setLocations(list); });
    return () => { mounted = false; };
  }, [locs.length, setLocations]);

  // ロケーションIDをGID形式に正規化（管理画面が数値で保存している場合も一致させる）
  const normalizeLocationGidForCompare = useCallback((s) => {
    if (s == null || s === "") return "";
    const str = String(s).trim();
    if (str.startsWith("gid://shopify/Location/")) return str;
    const num = str.replace(/^gid:\/\/shopify\/Location\//, "").trim();
    if (/^\d+$/.test(num)) return `gid://shopify/Location/${num}`;
    return str;
  }, []);

  // 現在のロケーションでフィルター（セッションのロケーションのみ表示。GID/数値両対応）
  const filteredByLoc = useMemo(() => {
    if (!sessionLocationGid) return [];
    const sessionNorm = normalizeLocationGidForCompare(sessionLocationGid);
    if (!sessionNorm) return [];
    return entries.filter((e) => normalizeLocationGidForCompare(e.locationId) === sessionNorm);
  }, [entries, sessionLocationGid, normalizeLocationGidForCompare]);

  // 表示順: 新しい順（日付降順）。設定の表示件数はチャンク保存時に反映される
  const listToShow = useMemo(() => {
    let list;
    if (historyMode === "pending") {
      list = filteredByLoc.filter((e) => e.status === "pending");
    } else {
      list = filteredByLoc.filter((e) => e.status !== "pending");
    }
    const dateKey = (e) => e.date || e.createdAt || "";
    return [...list].sort((a, b) => (dateKey(b) > dateKey(a) ? 1 : dateKey(b) < dateKey(a) ? -1 : 0));
  }, [filteredByLoc, historyMode]);

  const hasMoreHistory = loadedChunkCount < chunkCount;
  const loadMoreHistory = useCallback(async () => {
    if (loadedChunkCount >= chunkCount) return;
    setLoading(true);
    try {
      const result = await readOrderEntriesPage(loadedChunkCount);
      const next = Array.isArray(result.entries) ? result.entries : [];
      next.forEach((e) => fullEntriesByIdRef.current.set(e.id, e));
      setEntries((prev) => [...prev, ...next.map(stripEntryForList)]);
      setLoadedChunkCount((prev) => prev + 1);
    } catch (e) {
      setHistoryError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, [loadedChunkCount, chunkCount]);

  const pendingCount = useMemo(
    () => filteredByLoc.filter((e) => e.status === "pending").length,
    [filteredByLoc]
  );

  const processedCount = useMemo(
    () => filteredByLoc.filter((e) => e.status !== "pending").length,
    [filteredByLoc]
  );

  const getLocationName = useCallback((id) => {
    return locs.find((l) => l.id === id)?.name ?? id ?? "-";
  }, [locs]);
  
  const currentLocationName = useMemo(
    () => (sessionLocationGid ? getLocationName(sessionLocationGid) : ""),
    [sessionLocationGid, getLocationName]
  );

  const cancelConfirmEntryRef = useRef(null);

  const handleCancel = useCallback(
    async (entry) => {
      if (!entry || entry.status !== "pending") return;
      setCancelling(entry.id);
      try {
        const full = await readOrderEntriesFull();
        const updated = full.map((e) =>
          e.id === entry.id ? { ...e, status: "cancelled" } : e
        );
        await writeOrderEntries(updated);
        const result = await readOrderEntriesFirstPage();
        const raw = Array.isArray(result.entries) ? result.entries : [];
        fullEntriesByIdRef.current = new Map(raw.map((e) => [e.id, e]));
        setEntries(raw.map(stripEntryForList));
        setChunkCount(result.chunkCount ?? 0);
        setLoadedChunkCount(1);
        setDetailId("");
        setDetailEntry(null);
        toast("発注をキャンセルしました（在庫は変わりません）");
      } catch (e) {
        toast(`キャンセルエラー: ${e?.message ?? e}`);
      } finally {
        setCancelling("");
        cancelConfirmEntryRef.current = null;
      }
    },
    []
  );


  const onTapHistoryEntry = useCallback((entry) => {
    const id = entry?.id;
    if (!id) return;
    setDetailId(id);
    setDetailEntry(null);
  }, []);

  useEffect(() => {
    if (!detailId) {
      setDetailEntry(null);
      setDetailLoading(false);
      return;
    }
    let mounted = true;
    setDetailLoading(true);
    readOrderEntryById(detailId)
      .then((entry) => {
        if (mounted) setDetailEntry(entry ?? null);
      })
      .catch((e) => {
        if (mounted) {
          toast(`詳細の取得に失敗しました: ${String(e?.message ?? e)}`);
          setDetailEntry(null);
        }
      })
      .finally(() => {
        if (mounted) setDetailLoading(false);
      });
    return () => { mounted = false; };
  }, [detailId]);

  useEffect(() => {
    if (!detailId) return;
    if (detailLoading) {
      setHeader?.(<s-box padding="base"><s-text tone="subdued">読み込み中...</s-text></s-box>);
      return;
    }
    if (!detailEntry) {
      setHeader?.(<s-box padding="base"><s-text tone="critical">詳細の取得に失敗しました</s-text></s-box>);
      return;
    }
    const entry = detailEntry;
    const entryIndex = listToShow.findIndex((e) => e.id === entry.id);
      const sessionNorm = sessionLocationGid ? normalizeLocationGidForCompare(sessionLocationGid) : "";
      const currentFilteredByLoc = sessionNorm ? entries.filter((e) => normalizeLocationGidForCompare(e.locationId) === sessionNorm) : [];
      const orderName = formatOrderDisplayName(entry);
      const locName = entry.locationName || getLocationName(entry.locationId);
      const date = formatDate(entry.date || entry.createdAt);
      const destination = entry.destination || "-";
      const desiredDeliveryDate = entry.desiredDeliveryDate ? formatDate(entry.desiredDeliveryDate) : "-";
      const staffName = entry.staffName || "-";
      const note = entry.note || "-";
      
      const headerNode = (
        <s-box padding="base">
          <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
            {/* ✅ 左：ID + ロケーション + 日付 + 理由 + スタッフ + キャンセル日時 */}
            <s-box style={{ flex: "1 1 auto", minInlineSize: 0 }}>
              <s-stack gap="extra-tight">
                <s-text emphasis="bold">{orderName}</s-text>
                <s-text tone="subdued" size="small">
                  ロケーション: {locName}
                </s-text>
                <s-text tone="subdued" size="small">
                  日付: {date}
                </s-text>
                <s-text tone="subdued" size="small">
                  仕入先: {destination}
                </s-text>
                <s-text tone="subdued" size="small">
                  希望納品日: {desiredDeliveryDate}
                </s-text>
                {staffName !== "-" && (
                  <s-text tone="subdued" size="small">
                    スタッフ: {staffName}
                  </s-text>
                )}
                {note && note !== "-" && (
                  <s-text tone="subdued" size="small">
                    備考: {note}
                  </s-text>
                )}
              </s-stack>
            </s-box>
            {/* ✅ 右：画像表示ボタン（商品リストヘッダーと同様） */}
            <s-stack direction="inline" gap="base" alignItems="center" justifyContent="end" style={{ flexShrink: 0 }}>
              {typeof onToggleLiteMode === "function" ? (
                <s-button
                  kind="secondary"
                  tone={liteMode ? "critical" : undefined}
                  onClick={onToggleLiteMode}
                  style={{ paddingInline: 8, whiteSpace: "nowrap" }}
                >
                  {liteMode ? "画像OFF" : "画像ON"}
                </s-button>
              ) : null}
            </s-stack>
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
                <s-button
                  variant={historyMode === "pending" ? "primary" : "secondary"}
                  onClick={() => setHistoryMode("pending")}
                >
                  未処理 {pendingCount}件
                </s-button>
              </s-box>
              <s-box inlineSize="50%">
                <s-button
                  variant={historyMode === "processed" ? "primary" : "secondary"}
                  onClick={() => setHistoryMode("processed")}
                >
                  処理済み {processedCount}件
                </s-button>
              </s-box>
            </s-stack>

            {/* 履歴一覧：設定件数を超える分はヘッダーの読込で表示（出庫・入庫・棚卸・ロスと同様） */}
            {hasMoreHistory ? (
              <s-box padding="none" style={{ paddingBlock: "4px", paddingInline: "16px" }}>
                <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
                  <s-text tone="subdued" size="small">
                    未読み込み一覧リストがあります。（過去分）
                  </s-text>
                  <s-button
                    kind="secondary"
                    onClick={loadMoreHistory}
                    onPress={loadMoreHistory}
                  >
                    読込
                  </s-button>
                </s-stack>
              </s-box>
            ) : null}
          </s-stack>
        </s-box>
      );
    }
    return () => setHeader?.(null);
  }, [
    detailId,
    detailEntry,
    entries,
    historyMode,
    pendingCount,
    processedCount,
    listToShow,
    hasMoreHistory,
    loadMoreHistory,
    detailLoading,
    sessionLocationGid,
    normalizeLocationGidForCompare,
    getLocationName,
    liteMode,
    onToggleLiteMode,
  ]);

  useEffect(() => {
    if (detailId) {
      const entry = detailEntry ?? fullEntriesByIdRef.current.get(detailId) ?? entries.find((e) => e.id === detailId);
      if (!entry) {
        if (!detailLoading) setDetailId("");
        return;
      }
      const locName = entry.locationName || getLocationName(entry.locationId);
      const CANCEL_CONFIRM_MODAL_ID = `cancel-confirm-${entry.id}`;
      // 履歴商品リスト：左＝ステータス（バッジ）、右＝合計（商品リストの数量合計）
      const statusJa = STATUS_LABEL[entry.status] || entry.status;
      const statusBadgeTone = getStatusBadgeTone(statusJa);
      const totalQty = (entry.items ?? []).reduce((s, it) => s + (it.quantity || 0), 0);
      setFooter?.(
        <FixedFooterNavBar
          summaryLeft={<s-badge tone={statusBadgeTone}>{statusJa}</s-badge>}
          summaryRight={`合計：${totalQty}`}
          leftLabel="戻る"
          onLeft={() => setDetailId("")}
          rightLabel={cancelling ? "処理中..." : "キャンセル"}
          onRight={() => {
            cancelConfirmEntryRef.current = entry;
          }}
          rightCommand="--show"
          rightCommandFor={CANCEL_CONFIRM_MODAL_ID}
          rightTone="critical"
          rightDisabled={entry.status !== "pending" || !!cancelling}
        />
      );
      return () => setFooter?.(null);
    }

    const summaryLeft = currentLocationName ? `ロケーション: ${currentLocationName}` : "";
    const summaryRight =
      historyMode === "pending"
        ? `未処理 ${listToShow.length}件`
        : `処理済み ${listToShow.length}件`;
    setFooter?.(
      <FixedFooterNavBar
        summaryLeft={summaryLeft}
        summaryRight={summaryRight}
        leftLabel="戻る"
        onLeft={onBack}
        middleLabel={liteMode ? "画像OFF" : "画像ON"}
        middleTone={liteMode ? "critical" : "default"}
        onMiddle={onToggleLiteMode}
        middleDisabled={typeof onToggleLiteMode !== "function"}
        rightLabel={loading ? "読込中..." : "再読込"}
        onRight={refreshOrderHistory}
        rightTone="secondary"
        rightDisabled={loading}
      />
    );
    return () => setFooter?.(null);
  }, [
    detailId,
    detailEntry,
    detailLoading,
    entries,
    historyMode,
    listToShow.length,
    currentLocationName,
    loading,
    cancelling,
    onBack,
    refreshOrderHistory,
    handleCancel,
    getLocationName,
    liteMode,
    onToggleLiteMode,
    sessionLocationGid,
  ]); // setFooter, filteredByLocを依存配列から除外（無限ループ防止）

  if (detailId) {
    if (detailLoading) {
      return (
        <s-box padding="base">
          <s-text tone="subdued">読み込み中...</s-text>
        </s-box>
      );
    }
    const e = detailEntry ?? fullEntriesByIdRef.current.get(detailId) ?? entries.find((x) => x.id === detailId);
    if (!e) {
      return (
        <s-box padding="base">
          <s-text tone="critical">詳細の取得に失敗しました</s-text>
        </s-box>
      );
    }
    const itemCount = e.items?.length ?? 0;
    const totalQty = (e.items ?? []).reduce((s, it) => s + (it.quantity || 0), 0);
    
    // ✅ 出庫履歴詳細と同じデザインで商品リストを表示（画像表示ON/OFFはロス内で連動）
    const showImages = !liteMode;
    
    const CANCEL_CONFIRM_MODAL_ID = `cancel-confirm-${e.id}`;
    
    // ✅ 画像URLがない商品に対して、variantIdから画像URLを取得
    useEffect(() => {
      if (!e?.items?.length || !detailId) return;
      
      const fetchImages = async () => {
        const urlMap = new Map();
        const promises = e.items.map(async (it) => {
          const key = it.inventoryItemId || it.variantId || "";
          if (!key) return;
          
          // 既にimageUrlがある場合はスキップ
          if (it.imageUrl) {
            urlMap.set(key, it.imageUrl);
            return;
          }
          
          // variantIdから画像URLを取得
          if (it.variantId) {
            try {
              const imageUrl = await fetchVariantImage(it.variantId);
              if (imageUrl) {
                urlMap.set(key, imageUrl);
              }
            } catch (err) {
              console.error("Failed to fetch variant image:", err);
            }
          }
        });
        
        await Promise.all(promises);
        if (urlMap.size > 0) {
          setImageUrls((prev) => {
            const merged = new Map(prev);
            urlMap.forEach((v, k) => merged.set(k, v));
            return merged;
          });
        }
      };
      
      fetchImages();
    }, [detailId, e?.id, e?.items]);
    
    return (
      <>
        {/* ✅ キャンセル確認モーダル（発注用） */}
        <s-modal id={CANCEL_CONFIRM_MODAL_ID} heading="発注をキャンセルしますか？">
          <s-box padding="base" paddingBlockEnd="none">
            <s-stack gap="base">
              <s-text tone="subdued">
                この操作により、この発注はキャンセル状態になります。
                この操作は取り消せません。
              </s-text>
              <s-divider />
              <s-box>
                <s-button
                  command="--hide"
                  commandFor={CANCEL_CONFIRM_MODAL_ID}
                  onClick={() => {
                    cancelConfirmEntryRef.current = null;
                  }}
                >
                  戻る
                </s-button>
              </s-box>
            </s-stack>
          </s-box>
          <s-button
            slot="primary-action"
            tone="critical"
            command="--hide"
            commandFor={CANCEL_CONFIRM_MODAL_ID}
            disabled={!!cancelling}
            onClick={() => {
              const entry = cancelConfirmEntryRef.current;
              if (entry) {
                handleCancel(entry);
              }
            }}
          >
            {cancelling ? "処理中..." : "キャンセルする"}
          </s-button>
        </s-modal>

        <s-box padding="base">
          <s-stack gap="base">
            {historyError ? <s-text tone="critical">{historyError}</s-text> : null}

            {/* ✅ 商品リスト（発注履歴詳細。ロス履歴と同じデザイン） */}
            {(e.items ?? []).map((it, idx) => {
            // ✅ productTitleとvariantTitleを取得（titleから分割する場合も考慮）
            let productTitle = String(it.productTitle || "").trim();
            let variantTitle = String(it.variantTitle || "").trim();
            
            // productTitleとvariantTitleが無い場合、titleから分割を試みる
            if (!productTitle && it.title) {
              const titleParts = String(it.title).split(" / ").map((s) => s.trim()).filter(Boolean);
              if (titleParts.length > 0) {
                productTitle = titleParts[0];
                if (titleParts.length > 1) {
                  variantTitle = titleParts.slice(1).join(" / ");
                }
              }
            }
            
            if (!productTitle) {
              productTitle = String(it.title || it.sku || "").trim() || "(unknown)";
            }
            
            const optionsLine = variantTitle ? formatOptionsLine_(normalizeVariantOptions_(productTitle, variantTitle)) : "";
            const sku = String(it.sku || "").trim();
            const jan = String(it.barcode || "").trim();

            const skuJanLine =
              sku || jan
                ? `${sku ? `SKU: ${sku}` : ""}${sku && jan ? " / " : ""}${jan ? `JAN: ${jan}` : ""}`
                : "";

            // ✅ 画像URLを取得（既存のimageUrlまたは取得したimageUrl）
            const itemKey = it.inventoryItemId || it.variantId || "";
            const imageUrl = String(it.imageUrl || "").trim() || (itemKey ? String(imageUrls.get(itemKey) || "") : "");
            
            // ✅ 履歴は編集不可なので、数量表示のみ
            const belowRight = `数量: ${Number(it.quantity || 0)}`;

            return (
              <s-box key={it.inventoryItemId || it.variantId || idx} padding="none">
                <s-box padding="base">
                  <s-stack gap="extra-tight">
                    <ItemLeftInline
                      showImages={showImages && !!imageUrl}
                      imageUrl={imageUrl}
                      productTitle={productTitle}
                      variantTitle={optionsLine}
                      line3={skuJanLine}
                    />

                    {/* ✅ 2行目（数量表示） */}
                    <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                      <s-box />
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
                {idx < (e.items ?? []).length - 1 ? <s-divider /> : null}
              </s-box>
            );
            })}
          </s-stack>
        </s-box>
      </>
    );
    }

  return (
    <s-box padding="base">
      <s-stack gap="base">
        {historyError ? <s-text tone="critical">{historyError}</s-text> : null}

        {!sessionLocationGid ? (
          <s-text tone="subdued" size="small">
            読み込み中...
          </s-text>
        ) : loading ? (
          <s-text tone="subdued" size="small">
            読み込み中...
          </s-text>
        ) : listToShow.length === 0 ? (
          <s-text tone="subdued" size="small">
            表示できる履歴がありません
          </s-text>
        ) : (
          <s-stack gap="base">
            {listToShow.map((e, index) => {
              const orderName = formatOrderDisplayName(e);
              const date = formatDate(e.date || e.createdAt);
              const location = e.locationName || getLocationName(e.locationId);
              const itemCount = e.items?.length ?? 0;
              const totalQty = (e.items ?? []).reduce((s, it) => s + (it.quantity || 0), 0);
              const statusJa = STATUS_LABEL[e.status] || e.status;
              const statusBadgeTone = getStatusBadgeTone(statusJa);

              return (
                <s-clickable key={e.id} onClick={() => onTapHistoryEntry(e)}>
                  <s-box padding="small">
                    <s-stack gap="tight">
                      <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="small">
                        <s-text emphasis="bold" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {orderName}
                        </s-text>
                        <s-text tone="subdued" size="small" style={{ whiteSpace: "nowrap" }}>
                          {date}
                        </s-text>
                      </s-stack>

                      <s-text
                        tone="subdued"
                        size="small"
                        style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                      >
                        ロケーション: {location}
                      </s-text>

                      <s-text
                        tone="subdued"
                        size="small"
                        style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                      >
                        スタッフ: {e.staffName || "-"}
                      </s-text>

                      <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="small">
                        <s-badge tone={statusBadgeTone}>{statusJa}</s-badge>
                        <s-text tone="subdued" size="small" style={{ whiteSpace: "nowrap" }}>
                          {itemCount}件・合計{totalQty}
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
