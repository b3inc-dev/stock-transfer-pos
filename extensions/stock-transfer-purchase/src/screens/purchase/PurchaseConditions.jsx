import { useState, useMemo, useEffect, useCallback, useRef } from "preact/hooks";
import { fetchLocations, fetchSettings, readValue } from "./purchaseApi.js";
import { FixedFooterNavBar } from "../../FixedFooterNavBar.jsx";

const SHOPIFY = globalThis?.shopify ?? {};
const toast = (m) => SHOPIFY?.toast?.show?.(String(m));
const PURCHASE_CONDITIONS_DRAFT_KEY = "stock_transfer_pos_purchase_conditions_draft_v1";

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

export function PurchaseConditions({
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
  const [note, setNote] = useState("");
  const [expectedArrival, setExpectedArrival] = useState("");
  const [trackingNumber, setTrackingNumber] = useState("");
  const [carrierId, setCarrierId] = useState("");
  const [carrierCustom, setCarrierCustom] = useState("");
  const [carrierSearchQuery, setCarrierSearchQuery] = useState("");
  const [showCarrierCustomInput, setShowCarrierCustomInput] = useState(false);
  const [settings, setSettings] = useState(null);
  const [suppliers, setSuppliers] = useState([]);
  const [supplierId, setSupplierId] = useState("");
  const [supplierCustom, setSupplierCustom] = useState("");
  const [supplierSearchQuery, setSupplierSearchQuery] = useState("");
  const [showSupplierPicker, setShowSupplierPicker] = useState(true);
  const [loading, setLoading] = useState(false);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [locLoading, setLocLoading] = useState(false);
  const [locError, setLocError] = useState("");
  const [showLocationPicker, setShowLocationPicker] = useState(false);
  const [locationSearchQuery, setLocationSearchQuery] = useState("");
  const [showCarrierPicker, setShowCarrierPicker] = useState(false);
  const [showArrivesTimePicker, setShowArrivesTimePicker] = useState(false);
  const [arrivesDateDraft, setArrivesDateDraft] = useState("");
  const [expectedArrivalTime, setExpectedArrivalTime] = useState("");

  const allLocations = useMemo(() => (Array.isArray(locationsProp) ? locationsProp : []), [locationsProp]);

  useEffect(() => {
    setHeader?.(null);
    return () => setHeader?.(null);
  }, [setHeader]);

  const locationList = useMemo(() => {
    const base = allLocations;
    const q = String(locationSearchQuery || "").trim().toLowerCase();
    if (!q) return base;
    return base.filter((l) => String(l?.name || "").toLowerCase().includes(q));
  }, [allLocations, locationSearchQuery]);

  // 設定読み込み（仕入先マスタ＋配送業者マスタ）
  useEffect(() => {
    let mounted = true;
    setSettingsLoading(true);
    (async () => {
      try {
        const s = await fetchSettings();
        if (!mounted) return;
        setSettings(s);
        const sp = Array.isArray(s?.purchase?.suppliers) ? s.purchase.suppliers : [];
        setSuppliers(sp);
      } catch (e) {
        console.error("[PurchaseConditions] fetchSettings error:", e);
      } finally {
        if (mounted) setSettingsLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const draftRestoredRef = useRef(false);
  const supplierPickerInitializedRef = useRef(false);

  // 下書き復元
  useEffect(() => {
    draftRestoredRef.current = false;
    (async () => {
      try {
        if (!SHOPIFY?.storage?.get) {
          draftRestoredRef.current = true;
          return;
        }
        const saved = await SHOPIFY.storage.get(PURCHASE_CONDITIONS_DRAFT_KEY);
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
        if (saved.note !== undefined) {
          setNote(saved.note);
          restored = true;
        }
        if (saved.supplierId) {
          setSupplierId(saved.supplierId);
          restored = true;
        }
        if (saved.supplierCustom) {
          setSupplierCustom(saved.supplierCustom);
          restored = true;
        }
        if (restored) {
          toast("下書きを復元しました");
        }
        setTimeout(() => {
          draftRestoredRef.current = true;
        }, 100);
      } catch (e) {
        console.error("Failed to restore purchase conditions draft:", e);
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
        await SHOPIFY.storage.set(PURCHASE_CONDITIONS_DRAFT_KEY, {
          locationId,
          date,
          note,
          supplierId,
          supplierCustom,
          savedAt: Date.now(),
        });
      } catch (e) {
        console.error("Failed to save purchase conditions draft:", e);
      }
    }, 500);
    return () => clearTimeout(t);
  }, [locationId, date, note, supplierId, supplierCustom]);

  // ロケーション取得
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

  // セッションロケーションをデフォルトに
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

  // 仕入先リスト（検索フィルタ適用）
  const filteredSuppliers = useMemo(() => {
    const base = Array.isArray(suppliers) ? suppliers : [];
    const q = String(supplierSearchQuery || "").trim().toLowerCase();
    if (!q) return base;
    return base.filter((s) => String(s?.name || "").toLowerCase().includes(q));
  }, [suppliers, supplierSearchQuery]);

  const finalSupplierName = useMemo(() => {
    const custom = String(supplierCustom || "").trim();
    if (custom) return custom;
    const base = suppliers.find((s) => s.id === supplierId)?.name ?? "";
    return base;
  }, [supplierCustom, supplierId, suppliers]);

  // 仕入先ピッカーの初期表示制御
  // - 下書き復元後に一度だけ、
  //   - 仕入先「未選択」の場合は開いた状態
  //   - 選択済みの場合は閉じた状態
  useEffect(() => {
    if (!draftRestoredRef.current) return;
    if (supplierPickerInitializedRef.current) return;
    const hasSupplier = !!String(finalSupplierName || "").trim();
    setShowSupplierPicker(!hasSupplier);
    supplierPickerInitializedRef.current = true;
  }, [finalSupplierName]);

  // 配送業者（設定.carriers）から候補を作る
  const carriers = useMemo(() => {
    const raw = settings?.carriers;
    if (!Array.isArray(raw)) return [];
    return raw;
  }, [settings]);

  const filteredCarriers = useMemo(() => {
    const base = Array.isArray(carriers) ? carriers : [];
    const q = String(carrierSearchQuery || "").trim().toLowerCase();
    if (!q) return base;
    return base.filter((c) => {
      const label = String(c?.label || "").toLowerCase();
      const company = String(c?.company || "").toLowerCase();
      return label.includes(q) || company.includes(q);
    });
  }, [carriers, carrierSearchQuery]);

  const finalCarrierLabel = useMemo(() => {
    const custom = String(carrierCustom || "").trim();
    if (custom) return custom;
    const base = carriers.find((c) => c.id === carrierId)?.label ?? "";
    return base;
  }, [carrierCustom, carrierId, carriers]);

  const arrivesTimeLabel = useMemo(() => (expectedArrivalTime ? expectedArrivalTime : "未設定"), [expectedArrivalTime]);

  const setArrivesPreset = useCallback((preset) => {
    const d = new Date();
    if (preset === "d1") d.setDate(d.getDate() + 1);
    else if (preset === "d2") d.setDate(d.getDate() + 2);
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    setExpectedArrival(ymd);
  }, []);
  const setArrivesClear = useCallback(() => {
    setExpectedArrival("");
    setExpectedArrivalTime("");
  }, []);
  const applyArrivesTime = useCallback((hh, mm) => {
    setExpectedArrivalTime(`${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`);
    setShowArrivesTimePicker(false);
  }, []);

  // 仕入先は必須（未選択のまま次へ進むと "-" 表示になりやすい）
  const canStart = !!locationId && !!date && !!String(finalSupplierName || "").trim();

  const handleStart = useCallback(() => {
    if (!canStart || loading) return;
    onStart?.({
      locationId,
      locationName: locationName || "",
      date,
      staffName: "",
      note: note.trim(),
      expectedArrival: "",
      expectedArrivalTime: "",
      trackingNumber: "",
      supplierName: String(finalSupplierName || "").trim(),
      carrier: "",
    });
  }, [
    canStart,
    loading,
    onStart,
    locationId,
    locationName,
    date,
    note,
    finalSupplierName,
  ]);

  // フッター（出庫コンディション同型：FixedFooterNavBar）。ヘッダーは出庫同様 null で見出しはモーダル側の s-page に一本化。
  useEffect(() => {
    const summaryLeft = `ロケーション: ${locationName}`;
    const summaryRight = "";
    setFooter?.(
      <FixedFooterNavBar
        summaryLeft={summaryLeft}
        summaryCenter=""
        summaryRight={summaryRight}
        leftLabel={liteMode ? "画像OFF" : "画像ON"}
        leftTone={liteMode ? "critical" : "default"}
        onLeft={typeof onToggleLiteMode === "function" ? onToggleLiteMode : undefined}
        leftDisabled={typeof onToggleLiteMode !== "function"}
        middleLabel="履歴一覧"
        onMiddle={typeof onOpenHistory === "function" ? onOpenHistory : undefined}
        middleTone="default"
        rightLabel="次へ"
        onRight={handleStart}
        rightTone="success"
        rightDisabled={!canStart || loading}
      />
    );
    return () => setFooter?.(null);
  }, [setHeader, setFooter, locationName, liteMode, onToggleLiteMode, onOpenHistory, canStart, loading, handleStart]);

  const read = readValue;

  /* 見出し・スクロールは Modal の s-page / s-scroll-box に任せる（出庫コンディションと同じ） */
  return (
    <s-box padding="base" paddingBlockEnd="extra-loose">
      <s-stack gap="base">
        {/* ロケーション（出庫の宛先と同型：1行＋「変更」でインライン展開） */}
        <s-stack gap="small">
              <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
                <s-box style={{ flex: "1 1 auto", minInlineSize: 0 }}>
                  <s-text>ロケーション: {locationName}</s-text>
                  {!locationId && locLoading ? (
                    <s-text tone="subdued" size="small">読み込み中...</s-text>
                  ) : !locationId && locError ? (
                    <s-text tone="critical" size="small">ロケーション取得に失敗しました: {locError}</s-text>
                  ) : !sessionLocationGid && !locationId ? (
                    <s-text tone="subdued" size="small">ロケーションを選択してください。</s-text>
                  ) : null}
                </s-box>
                <s-button kind="secondary" onClick={() => setShowLocationPicker((v) => !v)}>
                  {showLocationPicker ? "閉じる" : "変更"}
                </s-button>
              </s-stack>

              {showLocationPicker ? (
                <s-stack gap="base">
                  <s-text-field
                    label="検索"
                    placeholder="ロケーション名"
                    value={locationSearchQuery}
                    onInput={(e) => setLocationSearchQuery(read(e))}
                    onChange={(e) => setLocationSearchQuery(read(e))}
                  />
                  <s-scroll-view style={{ maxBlockSize: "60vh" }}>
                    <s-stack gap="small">
                      {locationList.length === 0 ? (
                        <s-text tone="subdued">該当するロケーションがありません</s-text>
                      ) : (
                        locationList.map((l) => (
                          <s-button
                            key={l.id}
                            tone={l.id === locationId ? "success" : undefined}
                            onClick={() => {
                              setLocationId(l.id || "");
                              setShowLocationPicker(false);
                              setLocationSearchQuery("");
                            }}
                          >
                            {l.name}
                          </s-button>
                        ))
                      )}
                    </s-stack>
                  </s-scroll-view>
                </s-stack>
              ) : null}
        </s-stack>

        {/* 仕入先（入庫先の直下：1行＋「変更」でインライン展開） */}
        <s-stack gap="small">
              <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
                <s-box style={{ flex: "1 1 auto", minInlineSize: 0 }}>
                  <s-stack direction="inline" gap="small" alignItems="center">
                    <s-text>仕入先: {finalSupplierName || "未選択"}</s-text>
                    <s-badge tone={String(finalSupplierName || "").trim() ? "info" : "critical"}>
                      {String(finalSupplierName || "").trim() ? "選択中" : "必須"}
                    </s-badge>
                  </s-stack>
                </s-box>
                <s-button kind="secondary" onClick={() => setShowSupplierPicker((v) => !v)}>
                  {showSupplierPicker ? "閉じる" : "変更"}
                </s-button>
              </s-stack>
              {/* エラーテキストはバッジ表現に統一するため削除 */}

              {showSupplierPicker ? (
                <s-stack gap="base">
                  <s-text-field
                    label="検索"
                    placeholder="仕入先名"
                    value={supplierSearchQuery}
                    onInput={(e) => setSupplierSearchQuery(read(e))}
                    onChange={(e) => setSupplierSearchQuery(read(e))}
                  />
                  <s-scroll-view style={{ maxBlockSize: "60vh" }}>
                    <s-stack gap="small">
                      {filteredSuppliers.length === 0 ? (
                        <s-text tone="subdued">該当する仕入先がありません</s-text>
                      ) : (
                        filteredSuppliers.map((sp) => (
                          <s-button
                            key={sp.id}
                            tone={supplierId === sp.id ? "success" : undefined}
                            onClick={() => {
                              setSupplierId(sp.id || "");
                              setSupplierCustom("");
                              setShowSupplierPicker(false);
                              setSupplierSearchQuery("");
                            }}
                          >
                            {sp.name}
                          </s-button>
                        ))
                      )}
                      {/* 「その他（仕入先入力）」は設定で表示/非表示を切り替え */}
                      {(settings?.purchase?.allowCustomSupplier ?? true) && (
                        <>
                          <s-button
                            kind="secondary"
                            tone={!supplierId ? "success" : undefined}
                            onClick={() => {
                              setSupplierId("");
                              setSupplierCustom("");
                            }}
                          >
                            その他
                          </s-button>
                          {!supplierId && (
                            <s-text-field
                              label="その他（仕入先入力）"
                              value={supplierCustom}
                              placeholder=""
                              onInput={(e) => setSupplierCustom(read(e))}
                              onChange={(e) => setSupplierCustom(read(e))}
                            />
                          )}
                        </>
                      )}
                    </s-stack>
                  </s-scroll-view>
                </s-stack>
              ) : null}
        </s-stack>

        <s-divider />

        {/* 日付（当日自動）・備考（任意） */}
        <s-text-field
          label="日付"
          type="date"
          value={date}
          onChange={(e) => setDate(read(e))}
        />
        <s-text-field
          label="備考（任意）"
          value={note}
          placeholder=""
          onChange={(e) => setNote(read(e))}
          multiline
        />
      </s-stack>
    </s-box>
  );
}

