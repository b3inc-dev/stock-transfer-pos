import { useState, useMemo, useEffect, useCallback, useRef } from "preact/hooks";
import { fetchLocations, readValue } from "./lossApi.js";
import { FixedFooterNavBar } from "./FixedFooterNavBar.jsx";

const SHOPIFY = globalThis?.shopify ?? {};
const toast = (m) => SHOPIFY?.toast?.show?.(String(m));
const LOSS_CONDITIONS_DRAFT_KEY = "stock_transfer_pos_loss_conditions_draft_v1";

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

const REASONS = [
  { value: "破損", label: "破損" },
  { value: "紛失", label: "紛失" },
  { value: "その他", label: "その他" },
];

export function LossConditions({ onBack, onStart, onOpenHistory, locations: locationsProp, setLocations, setHeader, setFooter }) {
  const sessionLocationGid = useOriginLocationGid();
  const [locationId, setLocationId] = useState("");
  const [date, setDate] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
  const [reasonKey, setReasonKey] = useState("破損");
  const [reasonCustom, setReasonCustom] = useState(""); // 「その他」選択時のカスタム入力用
  const [staffName, setStaffName] = useState(""); // スタッフ名（必須）
  const [showLocationPicker, setShowLocationPicker] = useState(false);
  const [loading, setLoading] = useState(false);
  const [locLoading, setLocLoading] = useState(false);
  const [locError, setLocError] = useState("");

  const allLocations = useMemo(() => (Array.isArray(locationsProp) ? locationsProp : []), [locationsProp]);
  const reason = reasonKey === "その他" ? String(reasonCustom || "").trim() : reasonKey;
  const canStart = !!locationId && !!date && !!reason && !!staffName.trim();

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

        const saved = await SHOPIFY.storage.get(LOSS_CONDITIONS_DRAFT_KEY);
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
        if (saved.reasonKey) {
          setReasonKey(saved.reasonKey);
          restored = true;
        }
        if (saved.reasonCustom) {
          setReasonCustom(saved.reasonCustom);
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
        console.error("Failed to restore loss conditions draft:", e);
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

        await SHOPIFY.storage.set(LOSS_CONDITIONS_DRAFT_KEY, {
          locationId,
          date,
          reasonKey,
          reasonCustom,
          staffName,
          savedAt: Date.now(),
        });
      } catch (e) {
        console.error("Failed to save loss conditions draft:", e);
      }
    }, 500); // 500msのデバウンス

    return () => clearTimeout(t);
  }, [locationId, date, reasonKey, reasonCustom, staffName]);

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

  const reasonLabel = useMemo(() => {
    if (reasonKey === "その他") {
      return reasonCustom?.trim() || "その他（未入力）";
    }
    return REASONS.find((r) => r.value === reasonKey)?.label ?? reasonKey;
  }, [reasonKey, reasonCustom]);

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
      reason,
      staffMemberId: null, // スタッフIDは使用しない
      staffName: staffName.trim(),
    });
  }, [canStart, loading, locationId, allLocations, date, reason, staffName, onStart]);
  

  useEffect(() => {
    const summaryLeft = `ロケーション: ${locationName}`;
    const summaryCenter = `スタッフ: ${staffDisplayName}`;
    const summaryRight = `${date} / ${reasonLabel}`;
    setFooter?.(
      <FixedFooterNavBar
        summaryLeft={summaryLeft}
        summaryCenter={summaryCenter}
        summaryRight={summaryRight}
        leftLabel="戻る"
        onLeft={onBack}
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
    locationName,
    staffDisplayName,
    date,
    reasonLabel,
    onBack,
    onOpenHistory,
    loading,
    handleStart,
  ]);

  return (
    <s-box padding="base">
      <s-stack gap="base">
        <s-text emphasis="bold">ロス</s-text>

        {/* ロケーション（出庫「出庫元を設定」同様） */}
        <s-stack gap="small">
          <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
            <s-box style={{ flex: "1 1 auto", minInlineSize: 0 }}>
              <s-text>ロケーション: {locationName}</s-text>
              {!locationId ? (
                <s-text tone="critical" size="small">
                  ロケーションを選択してください。下の「ロケーションを設定」から選択してください。
                </s-text>
              ) : null}
              {locError ? (
                <s-text tone="critical" size="small">取得エラー: {locError}</s-text>
              ) : null}
            </s-box>
            <s-button kind="secondary" onClick={() => setShowLocationPicker((p) => !p)}>
              ロケーションを設定
            </s-button>
          </s-stack>
          {showLocationPicker ? (
            <s-stack gap="base">
              {allLocations.length === 0 ? (
                <s-text tone="subdued">ロケーション一覧がありません（再取得を試してください）</s-text>
              ) : (
                allLocations.map((l) => (
                  <s-button
                    key={l.id}
                    tone={l.id === locationId ? "success" : undefined}
                    onClick={() => {
                      setLocationId(l.id);
                      setShowLocationPicker(false);
                    }}
                  >
                    {l.id === locationId ? "✓ " : ""}{l.name}
                  </s-button>
                ))
              )}
              <s-stack direction="inline" justifyContent="end" gap="base">
                <s-button onClick={bootstrap} disabled={locLoading}>
                  {locLoading ? "取得中..." : "再取得"}
                </s-button>
              </s-stack>
            </s-stack>
          ) : null}
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

        {/* 理由（常に開いておく選択式） */}
        <s-stack gap="base">
          <s-text emphasis="bold" size="small">理由（必須）</s-text>
          <s-stack direction="inline" gap="small" style={{ width: "100%" }}>
            {REASONS.map((r) => (
              <s-box key={r.value} style={{ flex: "1 1 0", minWidth: 0, width: "100%" }}>
                <s-button
                  tone={reasonKey === r.value ? "success" : undefined}
                  onClick={() => {
                    setReasonKey(r.value);
                    // 「その他」以外を選択した場合はカスタム入力をクリア
                    if (r.value !== "その他") {
                      setReasonCustom("");
                    }
                  }}
                  style={{ width: "100%", maxWidth: "100%" }}
                >
                  {reasonKey === r.value ? "✓ " : ""}{r.label}
                </s-button>
              </s-box>
            ))}
          </s-stack>
          {/* 「その他」が選択されている場合は入力欄を表示 */}
          {reasonKey === "その他" ? (
            <s-text-field
              label="理由（必須）"
              value={reasonCustom}
              onInput={(e) => setReasonCustom(readValue(e))}
              onChange={(e) => setReasonCustom(readValue(e))}
              helpText="理由を入力してください"
              placeholder="理由を入力"
            />
          ) : null}
        </s-stack>
      </s-stack>
    </s-box>
  );
}
