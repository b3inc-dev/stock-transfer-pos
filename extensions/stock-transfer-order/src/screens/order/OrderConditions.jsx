import { useState, useMemo, useEffect, useCallback, useRef } from "preact/hooks";
import { fetchLocations, fetchSettings, readValue } from "./orderApi.js"; // lossApi と同じ構成を想定
import { FixedFooterNavBar } from "./FixedFooterNavBar.jsx";

const SHOPIFY = globalThis?.shopify ?? {};
const toast = (m) => SHOPIFY?.toast?.show?.(String(m));
const ORDER_CONDITIONS_DRAFT_KEY = "stock_transfer_pos_order_conditions_draft_v1";

// POS セッションのロケーションID/GID（LossConditions と同じ）
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


export function OrderConditions({
  onBack,
  onStart,
  onOpenHistory,
  locations: locationsProp,
  setLocations,
  setHeader,
  setFooter,
  liteMode,
  onToggleLiteMode,
}) {
  const sessionLocationGid = useOriginLocationGid();
  const [locationId, setLocationId] = useState("");
  const [date, setDate] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
  const [staffName, setStaffName] = useState("");
  const [note, setNote] = useState(""); // 備考
  const [desiredDeliveryDate, setDesiredDeliveryDate] = useState(""); // 希望納品日（任意）
  // 仕入先関連（内部データは destination のまま）
  const [settings, setSettings] = useState(null);
  const [useDestinationMaster, setUseDestinationMaster] = useState(false);
  const [destinations, setDestinations] = useState([]);
  const [destinationId, setDestinationId] = useState("");   // マスタ選択ID
  const [destinationName, setDestinationName] = useState(""); // 実際に保存する仕入先名
  const [destinationCustom, setDestinationCustom] = useState(""); // その他テキスト（任意）
  const [showDestinationPicker, setShowDestinationPicker] = useState(true); // 仕入先選択UIの表示/非表示（未選択時は開いた状態にする）
  const [destinationSearchQuery, setDestinationSearchQuery] = useState(""); // 仕入先検索クエリ
  const [showDestinationCustomInput, setShowDestinationCustomInput] = useState(false); // その他入力フィールドの表示/非表示
  const [loading, setLoading] = useState(false);
  const [locLoading, setLocLoading] = useState(false);
  const [locError, setLocError] = useState("");

  const allLocations = useMemo(() => (Array.isArray(locationsProp) ? locationsProp : []), [locationsProp]);

  // 設定読み込み（仕入先マスタ）
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const s = await fetchSettings();
        if (!mounted) return;
        setSettings(s);
        const useMaster = !!s?.order?.useDestinationMaster;
        setUseDestinationMaster(useMaster);
        setDestinations(Array.isArray(s?.order?.destinations) ? s.order.destinations : []);
      } catch (e) {
        console.error("[OrderConditions] fetchSettings error:", e);
      }
    })();
    return () => { mounted = false; };
  }, []);

  // 下書き復元用フラグ
  const draftRestoredRef = useRef(false);
  const destinationPickerInitializedRef = useRef(false);

  // 下書き復元
  useEffect(() => {
    draftRestoredRef.current = false;
    (async () => {
      try {
        if (!SHOPIFY?.storage?.get) {
          draftRestoredRef.current = true;
          return;
        }
        const saved = await SHOPIFY.storage.get(ORDER_CONDITIONS_DRAFT_KEY);
        if (!saved || typeof saved !== "object") {
          draftRestoredRef.current = true;
          return;
        }
        let restored = false;
        if (!locationId && saved.locationId) {
          setLocationId(saved.locationId);
          restored = true;
        }
        if (saved.date) {
          setDate(saved.date);
          restored = true;
        }
        if (saved.staffName) {
          setStaffName(saved.staffName);
          restored = true;
        }
        if (saved.note) {
          setNote(saved.note);
          restored = true;
        }
        if (saved.desiredDeliveryDate) {
          setDesiredDeliveryDate(saved.desiredDeliveryDate);
          restored = true;
        }
        if (saved.destinationId) {
          setDestinationId(saved.destinationId);
          restored = true;
        }
        if (saved.destinationName) {
          setDestinationName(saved.destinationName);
          restored = true;
        }
        if (saved.destinationCustom) {
          setDestinationCustom(saved.destinationCustom);
          restored = true;
        }
        // その他入力が復元された場合は、その他入力フィールドも表示
        if (saved.showDestinationCustomInput || saved.destinationCustom) {
          setShowDestinationCustomInput(true);
        }
        if (restored) {
          toast("下書きを復元しました");
        }
        setTimeout(() => {
          draftRestoredRef.current = true;
        }, 100);
      } catch (e) {
        console.error("Failed to restore order conditions draft:", e);
        draftRestoredRef.current = true;
      }
    })();
  }, []);

  // 自動保存
  useEffect(() => {
    if (!draftRestoredRef.current) return;
    const t = setTimeout(async () => {
      try {
        if (!SHOPIFY?.storage?.set) return;
        await SHOPIFY.storage.set(ORDER_CONDITIONS_DRAFT_KEY, {
          locationId,
          date,
          staffName,
          note,
          desiredDeliveryDate,
          destinationId,
          destinationName,
          destinationCustom,
          showDestinationCustomInput,
          savedAt: Date.now(),
        });
      } catch (e) {
        console.error("Failed to save order conditions draft:", e);
      }
    }, 500);
    return () => clearTimeout(t);
  }, [locationId, date, staffName, note, desiredDeliveryDate, destinationId, destinationName, destinationCustom, showDestinationCustomInput]);

  // ロケーション取得（LossConditions と同様）
  const bootstrapLocations = useCallback(async () => {
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
    bootstrapLocations();
  }, [bootstrapLocations]);

  // セッションロケーションをデフォルトに（LossConditions と同様）
  useEffect(() => {
    if (!draftRestoredRef.current) return;
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

  // 仕入先の最終表示名（マスタ＋その他）
  const finalDestinationName = useMemo(() => {
    if (!useDestinationMaster) return ""; // マスタ未使用時は何も持たない
    const custom = destinationCustom.trim();
    if (custom) return custom;
    const base =
      destinations.find((d) => d.id === destinationId)?.name ??
      destinationName ??
      "";
    return base;
  }, [useDestinationMaster, destinations, destinationId, destinationName, destinationCustom]);

  // 仕入先リスト（検索フィルタ適用）
  const filteredDestinations = useMemo(() => {
    const base = Array.isArray(destinations) ? destinations : [];
    const q = String(destinationSearchQuery || "").trim().toLowerCase();
    if (!q) return base;
    return base.filter((d) => String(d?.name || "").toLowerCase().includes(q));
  }, [destinations, destinationSearchQuery]);

  // 仕入先が必須の場合のバリデーション
  const destinationRequired = useDestinationMaster;
  const destinationValid = !destinationRequired || !!finalDestinationName.trim();
  const canStart = !!locationId && !!date && !!staffName.trim() && destinationValid;

  // 仕入先ピッカーの初期表示制御
  // - 下書き復元後に一度だけ、
  //   - 仕入先「未選択」（ID・その他とも空）の場合は開いた状態
  //   - 選択済みの場合は閉じた状態
  useEffect(() => {
    if (!draftRestoredRef.current) return;
    if (destinationPickerInitializedRef.current) return;
    const hasDestination = !!finalDestinationName.trim();
    setShowDestinationPicker(!hasDestination);
    destinationPickerInitializedRef.current = true;
  }, [finalDestinationName]);

  const handleStart = useCallback(() => {
    if (!canStart || loading) return;
    const loc = allLocations.find((l) => l.id === locationId);
    onStart({
      locationId,
      locationName: loc?.name ?? "",
      date,
      staffName: staffName.trim(),
      note: note.trim(),
      desiredDeliveryDate: desiredDeliveryDate || null,
      // 仕入先は useDestinationMaster が true のときだけ渡す
      destination: useDestinationMaster ? (finalDestinationName || null) : null,
      destinationId: useDestinationMaster && destinationId ? destinationId : null,
    });
  }, [
    canStart,
    loading,
    locationId,
    allLocations,
    date,
    staffName,
    note,
    useDestinationMaster,
    finalDestinationName,
    destinationId,
    onStart,
  ]);

  // フッター（LossConditions と同じ形）
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
  }, [setFooter, canStart, liteMode, onToggleLiteMode, onOpenHistory, loading, handleStart]);

  return (
    <>
      <s-box padding="base">
        <s-stack gap="base">
          {/* ロケーション */}
          <s-stack gap="small">
            <s-box style={{ flex: "1 1 auto", minInlineSize: 0 }}>
              <s-text>ロケーション: {locationName}</s-text>
              {!locationId && locLoading ? (
                <s-text tone="subdued" size="small">
                  端末のロケーションを取得しています...
                </s-text>
              ) : !locationId && locError ? (
                <s-text tone="critical" size="small">
                  端末のロケーションが取得できません: {locError}
                </s-text>
              ) : !locationId ? (
                <s-text tone="critical" size="small">
                  端末のロケーションが取得できません。POSでロケーションを選択しているか確認してください。
                </s-text>
              ) : null}
            </s-box>
          </s-stack>

          {/* 仕入先（マスタONの時だけ表示） */}
          {useDestinationMaster && (
            <s-stack gap="base">
              <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
                <s-box style={{ flex: "1 1 auto", minInlineSize: 0 }}>
                  <s-stack direction="inline" gap="small" alignItems="center">
                    <s-text>仕入先: {finalDestinationName || "未選択"}</s-text>
                    {destinationRequired && (
                      <s-badge
                        tone={finalDestinationName.trim() ? "success" : "critical"}
                      >
                        {finalDestinationName.trim() ? "選択中" : "必須"}
                      </s-badge>
                    )}
                  </s-stack>
                </s-box>
                <s-button
                  kind="secondary"
                  onClick={() => {
                    setShowDestinationPicker(!showDestinationPicker);
                    if (showDestinationPicker) {
                      setDestinationSearchQuery("");
                      setShowDestinationCustomInput(false);
                    }
                  }}
                >
                  {showDestinationPicker ? "閉じる" : "選択"}
                </s-button>
              </s-stack>
              {/* エラーテキストはバッジ表現に統一するため削除 */}

              {showDestinationPicker && (
                <s-stack gap="base">
                  <s-text-field
                    label="検索"
                    placeholder="仕入先名"
                    value={destinationSearchQuery}
                    onInput={(e) => setDestinationSearchQuery(readValue(e))}
                    onChange={(e) => setDestinationSearchQuery(readValue(e))}
                  />
                  <s-scroll-view style={{ maxBlockSize: "60vh" }}>
                    <s-stack gap="small">
                      {filteredDestinations.length === 0 ? (
                        <s-text tone="subdued">該当する仕入先がありません</s-text>
                      ) : (
                        filteredDestinations.map((d) => (
                          <s-button
                            key={d.id}
                            tone={d.id === destinationId ? "success" : undefined}
                            onClick={() => {
                              setDestinationId(d.id);
                              setDestinationName(d.name);
                              setDestinationCustom(""); // マスタ選択時はその他をクリア
                              setShowDestinationPicker(false);
                              setDestinationSearchQuery("");
                              setShowDestinationCustomInput(false);
                            }}
                          >
                            {d.name}
                          </s-button>
                        ))
                      )}
                      {/* その他オプション（設定.purchase.allowCustomSupplier に応じて表示） */}
                      {(settings?.purchase?.allowCustomSupplier ?? true) && (
                        <>
                          <s-button
                            kind="secondary"
                            tone={showDestinationCustomInput ? "success" : undefined}
                            onClick={() => {
                              setShowDestinationCustomInput(!showDestinationCustomInput);
                              if (!showDestinationCustomInput) {
                                // その他を選択したら、マスタ選択をクリア
                                setDestinationId("");
                                setDestinationName("");
                                setDestinationCustom("");
                              }
                            }}
                          >
                            その他
                          </s-button>
                          {showDestinationCustomInput && (
                            <s-text-field
                              label="その他（仕入先入力）"
                              value={destinationCustom}
                              onInput={(e) => setDestinationCustom(readValue(e))}
                              onChange={(e) => setDestinationCustom(readValue(e))}
                              placeholder=""
                            />
                          )}
                        </>
                      )}
                    </s-stack>
                  </s-scroll-view>
                </s-stack>
              )}
            </s-stack>
          )}

          <s-divider />

          {/* 日付 */}
          <s-text-field
            type="date"
            label="日付（必須）"
            value={date}
            onInput={(e) => setDate(readValue(e))}
            onChange={(e) => setDate(readValue(e))}
          />

          {/* 希望納品日（任意） */}
          <s-text-field
            type="date"
            label="希望納品日（任意）"
            value={desiredDeliveryDate}
            onInput={(e) => setDesiredDeliveryDate(readValue(e))}
            onChange={(e) => setDesiredDeliveryDate(readValue(e))}
            helpText="YYYY-MM-DD形式で入力してください"
          />

          {/* スタッフ */}
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

          {/* 備考 */}
          <s-text-field
            label="備考（任意）"
            value={note}
            onInput={(e) => setNote(readValue(e))}
            onChange={(e) => setNote(readValue(e))}
            multiline
          />
        </s-stack>
      </s-box>

    </>
  );
}
