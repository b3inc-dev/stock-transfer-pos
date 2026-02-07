import { useState, useMemo, useCallback, useEffect, useRef } from "preact/hooks";
import { readLossEntries, writeLossEntries, adjustInventoryAtLocation, fetchLocations, fetchVariantImage } from "./lossApi.js";
import { FixedFooterNavBar } from "./FixedFooterNavBar.jsx";

const SHOPIFY = globalThis?.shopify ?? {};
const toast = (m) => SHOPIFY?.toast?.show?.(String(m));

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

// ロスIDから連番表示を生成（#L0001形式）
function formatLossName(entry, allEntries, index) {
  // 既にlossNameが設定されている場合はそれを使用（既存のエントリの名称を変更しない）
  if (entry?.lossName && /^#L\d+$/.test(String(entry.lossName).trim())) {
    return String(entry.lossName).trim();
  }
  // lossNameが設定されていないエントリに対してのみ、新しい連番を生成
  // 既存のエントリ（lossNameが設定されているもの）から最大の連番を取得
  // ただし、現在のエントリ自身は除外する（自分自身のlossNameを参照しない）
  const maxNum = allEntries.reduce((max, e) => {
    // 現在のエントリ自身は除外
    if (e.id === entry.id) return max;
    // lossNameが設定されているエントリのみを対象
    if (e?.lossName && /^#L(\d+)$/.test(String(e.lossName).trim())) {
      const match = String(e.lossName).trim().match(/^#L(\d+)$/);
      const num = parseInt(match[1], 10);
      return Math.max(max, num);
    }
    return max;
  }, 0);
  // 最大値+1を使用（index+1は使用しない。indexは表示順序であり、連番とは関係ない）
  const num = maxNum + 1;
  return `#L${String(num).padStart(4, "0")}`;
}

export function LossHistoryList({ onBack, locations: locationsProp = [], setLocations, setHeader, setFooter }) {
  const sessionLocationGid = useOriginLocationGid();
  const [entries, setEntries] = useState([]);
  const [historyMode, setHistoryMode] = useState("active"); // "active" | "cancelled"
  const [loading, setLoading] = useState(false); // ✅ 初期状態をfalseに変更（出庫履歴一覧と同じ）
  const [historyError, setHistoryError] = useState("");
  const [detailId, setDetailId] = useState("");
  const [cancelling, setCancelling] = useState("");
  const [imageUrls, setImageUrls] = useState(new Map()); // ✅ 画像URLキャッシュ
  const locs = Array.isArray(locationsProp) ? locationsProp : [];

  const refreshLossHistory = useCallback(async () => {
    if (!sessionLocationGid) return;
    setLoading(true);
    setHistoryError("");
    setEntries([]);

    try {
      const list = await readLossEntries();
      const allEntries = Array.isArray(list) ? list : [];
      setEntries(allEntries);
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
    refreshLossHistory().catch((e) => {
      console.error("[LossHistoryList] refreshLossHistory error:", e);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionLocationGid]); // refreshLossHistoryを依存配列から除外（無限ループ防止）

  useEffect(() => {
    if (locs.length > 0 || !setLocations) return;
    let mounted = true;
    fetchLocations().then((list) => { if (mounted) setLocations(list); });
    return () => { mounted = false; };
  }, [locs.length, setLocations]);

  // 現在のロケーションでフィルター（セッションのロケーションのみ表示）
  const filteredByLoc = useMemo(() => {
    if (!sessionLocationGid) return [];
    return entries.filter((e) => e.locationId === sessionLocationGid);
  }, [entries, sessionLocationGid]);

  const listToShow = useMemo(() => {
    return filteredByLoc.filter((e) =>
      historyMode === "cancelled" ? e.status === "cancelled" : e.status === "active"
    );
  }, [filteredByLoc, historyMode]);

  const activeCount = useMemo(
    () => filteredByLoc.filter((e) => e.status === "active").length,
    [filteredByLoc]
  );
  const cancelledCount = useMemo(
    () => filteredByLoc.filter((e) => e.status === "cancelled").length,
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
      if (entry?.status !== "active" || !entry?.items?.length) return;
      setCancelling(entry.id);
      try {
        const deltas = entry.items.map((it) => ({
          inventoryItemId: it.inventoryItemId,
          delta: +(it.quantity || 0),
        }));
        await adjustInventoryAtLocation({ locationId: entry.locationId, deltas });
        const cancelledAt = new Date().toISOString();
        const updated = entries.map((e) =>
          e.id === entry.id
            ? { ...e, status: "cancelled", cancelledAt }
            : e
        );
        await writeLossEntries(updated);
        setEntries(updated);
        setDetailId("");
        toast("キャンセルしました（在庫を戻しました）");
      } catch (e) {
        toast(`キャンセルエラー: ${e?.message ?? e}`);
      } finally {
        setCancelling("");
        cancelConfirmEntryRef.current = null;
      }
    },
    [entries]
  );


  const onTapHistoryEntry = useCallback((entry) => {
    setDetailId(entry.id);
  }, []);

  useEffect(() => {
    if (detailId) {
      const entry = entries.find((e) => e.id === detailId);
      if (!entry) {
        setHeader?.(null);
        return;
      }
      
      // ✅ 出庫履歴詳細と同じヘッダーを追加
      const entryIndex = listToShow.findIndex((e) => e.id === entry.id);
      const currentFilteredByLoc = sessionLocationGid ? entries.filter((e) => e.locationId === sessionLocationGid) : [];
      const lossName = formatLossName(entry, currentFilteredByLoc, entryIndex >= 0 ? entryIndex : 0);
      const locName = entry.locationName || getLocationName(entry.locationId);
      const date = formatDate(entry.date || entry.createdAt);
      const reason = entry.reason || "-";
      const staffName = entry.staffName || "-";
      const cancelledAt = entry.cancelledAt ? formatDate(entry.cancelledAt) : null;
      
      const headerNode = (
        <s-box padding="base">
          <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
            {/* ✅ 左：ID + ロケーション + 日付 + 理由 + スタッフ + キャンセル日時 */}
            <s-box style={{ flex: "1 1 auto", minInlineSize: 0 }}>
              <s-stack gap="extra-tight">
                <s-text emphasis="bold">{lossName}</s-text>
                <s-text tone="subdued" size="small">
                  ロケーション: {locName}
                </s-text>
                <s-text tone="subdued" size="small">
                  日付: {date}
                </s-text>
                <s-text tone="subdued" size="small">
                  理由: {reason}
                </s-text>
                {staffName !== "-" && (
                  <s-text tone="subdued" size="small">
                    スタッフ: {staffName}
                  </s-text>
                )}
                {cancelledAt && (
                  <s-text tone="subdued" size="small">
                    キャンセル日時: {cancelledAt}
                  </s-text>
                )}
              </s-stack>
            </s-box>
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
                  kind={historyMode === "active" ? "primary" : "secondary"}
                  onClick={() => setHistoryMode("active")}
                >
                  登録済み {activeCount}件
                </s-button>
              </s-box>
              <s-box inlineSize="50%">
                <s-button
                  kind={historyMode === "cancelled" ? "primary" : "secondary"}
                  onClick={() => setHistoryMode("cancelled")}
                >
                  キャンセル済み {cancelledCount}件
                </s-button>
              </s-box>
            </s-stack>

            {/* ✅ さらに読み込みボタン（入庫・出庫と同様の形式、ただしmetafieldは全件取得のため常に非表示） */}
            {/* 注意: ロスはmetafieldから全件取得しているため、実際には追加読み込みは不要 */}
            {/* pageInfoは常にfalseのため、読込ボタンは表示されない */}
            {false && (
              <s-box padding="none" style={{ paddingBlock: "4px", paddingInline: "16px" }}>
                <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
                  <s-text tone="subdued" size="small">
                    未読み込み一覧リストがあります。（過去分）
                  </s-text>
                  <s-button
                    kind="secondary"
                    onClick={() => {}}
                    onPress={() => {}}
                    disabled={true}
                  >
                    読込
                  </s-button>
                </s-stack>
              </s-box>
            )}
          </s-stack>
        </s-box>
      );
    }
    return () => setHeader?.(null);
  }, [
    detailId,
    entries,
    historyMode,
    activeCount,
    cancelledCount,
    listToShow,
    sessionLocationGid,
    getLocationName,
  ]); // setHeaderを依存配列から除外（無限ループ防止）

  useEffect(() => {
    if (detailId) {
      const entry = entries.find((e) => e.id === detailId);
      if (!entry) {
        setDetailId("");
        return;
      }
      const locName = entry.locationName || getLocationName(entry.locationId);
      const entryIndex = listToShow.findIndex((e) => e.id === entry.id);
      // filteredByLocはentriesから動的に計算する（依存配列から除外）
      const currentFilteredByLoc = sessionLocationGid ? entries.filter((e) => e.locationId === sessionLocationGid) : [];
      const lossName = formatLossName(entry, currentFilteredByLoc, entryIndex >= 0 ? entryIndex : 0);
      const CANCEL_CONFIRM_MODAL_ID = `cancel-confirm-${entry.id}`;
      setFooter?.(
        <FixedFooterNavBar
          summaryLeft={`${lossName} / ${locName}`}
          summaryRight={entry.status === "cancelled" ? "キャンセル済み" : "登録済み"}
          leftLabel="戻る"
          onLeft={() => setDetailId("")}
          rightLabel={cancelling ? "処理中..." : "キャンセル"}
          onRight={() => {
            cancelConfirmEntryRef.current = entry;
          }}
          rightCommand="--show"
          rightCommandFor={CANCEL_CONFIRM_MODAL_ID}
          rightTone="critical"
          rightDisabled={entry.status !== "active" || !!cancelling}
        />
      );
      return () => setFooter?.(null);
    }

    const summaryLeft = currentLocationName ? `ロケーション: ${currentLocationName}` : "";
    const summaryRight =
      historyMode === "cancelled"
        ? `キャンセル済み ${listToShow.length}件`
        : `登録済み ${listToShow.length}件`;
    setFooter?.(
      <FixedFooterNavBar
        summaryLeft={summaryLeft}
        summaryRight={summaryRight}
        leftLabel="戻る"
        onLeft={onBack}
        rightLabel={loading ? "取得中..." : "再取得"}
        onRight={refreshLossHistory}
        rightTone="secondary"
        rightDisabled={loading}
      />
    );
    return () => setFooter?.(null);
  }, [
    detailId,
    entries,
    historyMode,
    listToShow.length,
    currentLocationName,
    loading,
    cancelling,
    onBack,
    refreshLossHistory,
    handleCancel,
    getLocationName,
    sessionLocationGid,
  ]); // setFooter, filteredByLocを依存配列から除外（無限ループ防止）

  if (detailId) {
    const e = entries.find((x) => x.id === detailId);
    if (!e) {
      setDetailId("");
      return null;
    }
    const itemCount = e.items?.length ?? 0;
    const totalQty = (e.items ?? []).reduce((s, it) => s + (it.quantity || 0), 0);
    const entryIndex = listToShow.findIndex((entry) => entry.id === e.id);
    // filteredByLocはentriesから動的に計算する（依存配列から除外）
    const currentFilteredByLoc = sessionLocationGid ? entries.filter((e) => e.locationId === sessionLocationGid) : [];
    const lossName = formatLossName(e, currentFilteredByLoc, entryIndex >= 0 ? entryIndex : 0);
    
    // ✅ 出庫履歴詳細と同じデザインで商品リストを表示
    const showImages = true; // 画像を常に表示（出庫履歴詳細と同じ）
    
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
        {/* ✅ キャンセル確認モーダル */}
        <s-modal id={CANCEL_CONFIRM_MODAL_ID} heading="ロスをキャンセルしますか？">
          <s-box padding="base" paddingBlockEnd="none">
            <s-stack gap="base">
              <s-text tone="subdued">
                この操作により、在庫が戻されます。この操作は取り消せません。
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

            {/* ✅ 商品リスト（出庫履歴詳細と同じデザイン） */}
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
            ロケーション情報を取得中...
          </s-text>
        ) : loading ? (
          <s-text tone="subdued" size="small">
            取得中...
          </s-text>
        ) : listToShow.length === 0 ? (
          <s-text tone="subdued" size="small">
            表示できる履歴がありません
          </s-text>
        ) : (
          <s-stack gap="base">
            {listToShow.map((e, index) => {
              // filteredByLocはentriesから動的に計算する（依存配列から除外）
              const currentFilteredByLoc = sessionLocationGid ? entries.filter((e) => e.locationId === sessionLocationGid) : [];
              const lossName = formatLossName(e, currentFilteredByLoc, index);
              const date = formatDate(e.date || e.createdAt);
              const location = e.locationName || getLocationName(e.locationId);
              const itemCount = e.items?.length ?? 0;
              const totalQty = (e.items ?? []).reduce((s, it) => s + (it.quantity || 0), 0);
              const statusJa = e.status === "cancelled" ? "キャンセル済み" : "登録済み";

              return (
                <s-clickable key={e.id} onClick={() => onTapHistoryEntry(e)}>
                  <s-box padding="small">
                    <s-stack gap="tight">
                      <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="small">
                        <s-text emphasis="bold" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {lossName}
                        </s-text>
                        <s-text tone="subdued" size="small" style={{ whiteSpace: "nowrap" }}>
                          {date}
                        </s-text>
                      </s-stack>

                      <s-text tone="subdued" size="small" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        ロケーション: {location}
                      </s-text>

                      <s-text tone="subdued" size="small" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        理由: {e.reason || "-"}
                      </s-text>

                      <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="small">
                        <s-text tone="subdued" size="small" style={{ whiteSpace: "nowrap" }}>
                          状態: {statusJa}
                        </s-text>
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
