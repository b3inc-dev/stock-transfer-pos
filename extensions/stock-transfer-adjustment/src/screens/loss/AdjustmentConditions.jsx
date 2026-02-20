import { useState, useMemo, useEffect, useCallback, useRef } from "preact/hooks";
import { fetchLocations, fetchSettings, readValue } from "./adjustmentApi.js";
import { FixedFooterNavBar } from "./FixedFooterNavBar.jsx";

const SHOPIFY = globalThis?.shopify ?? {};
const toast = (m) => SHOPIFY?.toast?.show?.(String(m));
const ADJUSTMENT_CONDITIONS_DRAFT_KEY = "stock_transfer_pos_adjustment_conditions_draft_v1";

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

const ADJUSTMENT_LOCATION_MODAL_ID = "adjustment-location-modal";

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

export function AdjustmentConditions({ onBack, onStart, onOpenHistory, locations: locationsProp, setLocations, setHeader, setFooter, liteMode, onToggleLiteMode }) {
  const sessionLocationGid = useOriginLocationGid();
  const [locationId, setLocationId] = useState("");
  const [date, setDate] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
  const [memo, setMemo] = useState("");
  const [staffName, setStaffName] = useState("");
  const [loading, setLoading] = useState(false);
  const [locLoading, setLocLoading] = useState(false);
  const [locError, setLocError] = useState("");

  const allLocations = useMemo(() => (Array.isArray(locationsProp) ? locationsProp : []), [locationsProp]);
  const canStart = !!locationId && !!date && !!staffName.trim();

  const conditionsDraftRestoredRef = useRef(false); // 復元が完了したことを示すフラグ
  
  // 下書き復元（マウント時に実行）
  useEffect(() => {
    conditionsDraftRestoredRef.current = false;
    
    (async () => {
      try {
        if (!SHOPIFY?.storage?.get) {
          conditionsDraftRestoredRef.current = true;
          return;
        }

        const saved = await SHOPIFY.storage.get(ADJUSTMENT_CONDITIONS_DRAFT_KEY);
        if (!saved || typeof saved !== "object") {
          conditionsDraftRestoredRef.current = true;
          return;
        }

        let restored = false;

        // セッションのロケーションを優先し、下書きは補完として使用
        // locationIdが空の場合のみ下書きから復元
        if (!locationId && saved.locationId) {
          setLocationId(saved.locationId);
          restored = true;
        }
        if (saved.date) {
          setDate(saved.date);
          restored = true;
        }
        if (saved.memo !== undefined) {
          setMemo(saved.memo || "");
          restored = true;
        }
        if (saved.staffName) {
          setStaffName(saved.staffName);
          restored = true;
        }
        
        // 復元した場合はトーストを表示
        if (restored) {
          toast("下書きを復元しました");
        }
        
        // 復元が完了したことを示す（少し待ってから自動保存を開始）
        setTimeout(() => {
          conditionsDraftRestoredRef.current = true;
        }, 100);
      } catch (e) {
        console.error("Failed to restore adjustment conditions draft:", e);
        conditionsDraftRestoredRef.current = true;
      }
    })();
  }, []); // ✅ マウント時のみ実行

  // ✅ 自動保存（入力値変更時に下書きを保存）
  useEffect(() => {
    // 下書き復元が完了していない場合は保存しない
    if (!conditionsDraftRestoredRef.current) return;

    const t = setTimeout(async () => {
      try {
        if (!SHOPIFY?.storage?.set) return;

        await SHOPIFY.storage.set(ADJUSTMENT_CONDITIONS_DRAFT_KEY, {
          locationId,
          date,
          memo: memo || "",
          staffName,
          savedAt: Date.now(),
        });
      } catch (e) {
        console.error("Failed to save loss conditions draft:", e);
      }
    }, 500); // 500msのデバウンス

    return () => clearTimeout(t);
  }, [locationId, date, memo, staffName]);

  // セッションのロケーションをデフォルト選択（下書き復元の後に実行）
  useEffect(() => {
    // 下書き復元が完了してから実行
    if (!conditionsDraftRestoredRef.current) return;
    
    if (sessionLocationGid && allLocations.length > 0 && !locationId) {
      const found = allLocations.find((l) => l.id === sessionLocationGid);
      if (found) {
        setLocationId(sessionLocationGid);
      }
    }
  }, [sessionLocationGid, allLocations, locationId]);

  const locationName = useMemo(() => {
    const loc = allLocations.find((l) => l.id === locationId);
    return loc?.name ?? (locationId ? "（不明）" : "未選択");
  }, [locationId, allLocations]);

  const bootstrap = useCallback(async () => {
    setLocLoading(true);
    setLocError("");
    try {
      const list = await fetchLocations();
      setLocations?.(Array.isArray(list) ? list : []);
    } catch (e) {
      const msg = e?.message ?? String(e);
      toast(`ロケーション取得エラー: ${msg}`);
      setLocError(msg);
      setLocations?.([]);
    } finally {
      setLocLoading(false);
    }
  }, [setLocations]);

  useEffect(() => {
    setHeader?.(null);
    return () => setHeader?.(null);
  }, [setHeader]);

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  const staffDisplayName = useMemo(() => {
    return staffName.trim() || "未入力";
  }, [staffName]);

  const handleStart = useCallback(async () => {
    if (!canStart || loading) return;
    
    // ✅ 商品リストに進む時点では下書きをクリアしない（確定時のみクリア）
    // これにより、戻った時に復元できる
    
    const loc = allLocations.find((l) => l.id === locationId);
    onStart({
      locationId,
      locationName: loc?.name ?? "",
      date,
      memo: (memo || "").trim(),
      staffMemberId: null,
      staffName: staffName.trim(),
    });
  }, [canStart, loading, locationId, allLocations, date, memo, staffName, onStart]);
  

  useEffect(() => {
    setFooter?.(
      <FixedFooterNavBar
        summaryLeft={`ロケーション: ${locationName}`}
        summaryCenter=""
        summaryRight=""
        leftLabel={liteMode ? "画像OFF" : "画像ON"}
        leftTone={liteMode ? "critical" : "default"}
        onLeft={typeof onToggleLiteMode === "function" ? onToggleLiteMode : undefined}
        middleLabel="履歴一覧"
        onMiddle={onOpenHistory}
        middleTone="default"
        rightLabel={loading ? "処理中..." : "次へ"}
        onRight={handleStart}
        rightTone="success"
        rightDisabled={!canStart || loading}
      />
    );
    return () => setFooter?.(null);
  }, [
    setFooter,
    canStart,
    liteMode,
    onToggleLiteMode,
    onOpenHistory,
    loading,
    handleStart,
  ]);

  return (
    <>
    <s-box padding="base">
      <s-stack gap="base">
        {/* ロケーション（現状はPOSセッションのロケーションのみ利用） */}
        <s-stack gap="small">
          <s-box style={{ flex: "1 1 auto", minInlineSize: 0 }}>
            <s-text>ロケーション: {locationName}</s-text>
            {!locationId && locLoading ? (
              <s-text tone="subdued" size="small">
                端末のロケーションを取得しています...
              </s-text>
            ) : !locationId && locError ? (
              <s-text tone="critical" size="small">端末のロケーションが取得できません: {locError}</s-text>
            ) : !locationId ? (
              <s-text tone="critical" size="small">
                端末のロケーションが取得できません。POSでロケーションを選択しているか確認してください。
              </s-text>
            ) : null}
          </s-box>
        </s-stack>

        <s-divider />

        {/* 日付 */}
        <s-stack gap="base">
          <s-text-field
            type="date"
            label="日付（必須）"
            value={date}
            onInput={(e) => setDate(readValue(e))}
            onChange={(e) => setDate(readValue(e))}
          />
        </s-stack>

        {/* スタッフ（手入力、必須） */}
        <s-stack gap="base">
          <s-text-field
            label="スタッフ（必須）"
            value={staffName}
            onInput={(e) => setStaffName(readValue(e))}
            onChange={(e) => setStaffName(readValue(e))}
            placeholder="スタッフ名を入力"
          />
          {!staffName.trim() ? (
            <s-text tone="critical" size="small">
              スタッフ名を入力してください
            </s-text>
          ) : null}
        </s-stack>

        {/* メモ（自由記載） */}
        <s-stack gap="base">
          <s-text-field
            label="メモ"
            value={memo}
            onInput={(e) => setMemo(readValue(e))}
            onChange={(e) => setMemo(readValue(e))}
            placeholder="メモを入力（任意）"
          />
        </s-stack>
      </s-stack>
    </s-box>
    <LocationSelectModal
      id={ADJUSTMENT_LOCATION_MODAL_ID}
      title="ロケーションを選択"
      locations={allLocations}
      selectedId={locationId}
      onSelect={(id) => setLocationId(id || "")}
    />
    </>
  );
}
