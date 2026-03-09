import { memo } from "preact/compat";
import { useState, useMemo, useEffect, useCallback, useRef } from "preact/hooks";
import {
  searchVariants,
  adjustInventoryToActual,
  readAdjustmentEntries,
  writeAdjustmentEntries,
  fetchVariantAvailable,
  resolveVariantByCode,
  fetchSettings,
} from "./adjustmentApi.js";
import { FixedFooterNavBar } from "./FixedFooterNavBar.jsx";

import { logInventoryChangeToApi } from "../../../../common/logInventoryChange.js";

const SHOPIFY = globalThis?.shopify ?? {};
const toast = (m) => SHOPIFY?.toast?.show?.(String(m));

// エラーメッセージ変換ヘルパ（OutboundListと同じ）
const toUserMessage = (e) => {
  const msg = e?.message ?? String(e);
  try {
    const parsed = JSON.parse(msg);
    if (Array.isArray(parsed)) return parsed.map((x) => x?.message ?? JSON.stringify(x)).join(" / ");
  } catch {}
  return msg;
};

// Debounceフック（OutboundListと同じ）
function useDebounce(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function generateAdjustmentId() {
  return `adj_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// =========================
// ヘルパー関数（OutboundListから移植）
// =========================

function toSafeId(s) {
  return String(s || "x").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60);
}

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

function qtyValueWidthByDigits_(digits) {
  if (digits <= 1) return 56;
  if (digits === 2) return 64;
  if (digits === 3) return 76;
  if (digits === 4) return 96;
  return 112;
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
  return (
    <s-box paddingInline="none" paddingBlockStart="small-100" paddingBlockEnd="small-200">
      {children}
    </s-box>
  );
}

function ItemLeftCompact({ showImages, imageUrl, productTitle, variantTitle, line3 }) {
  const pRaw = String(productTitle || "").trim() || "(unknown)";
  const vRaw = String(variantTitle || "").trim();
  const v = vRaw; // option解析用は生でOK（OutboundListと同じ）
  const options = normalizeVariantOptions_(pRaw, v);
  const optionsLine = formatOptionsLine_(options);
  const optText = String(optionsLine || "").trim();
  const line3Text = String(line3 || "").trim();

  const Line = ({ children, strong = false, subdued = false }) => (
    <s-text
      type={strong ? "strong" : subdued ? "small" : "generic"}
      tone={subdued ? "subdued" : "auto"}
      style={{
        display: "block",
        whiteSpace: "normal",
        overflow: "visible",
        wordBreak: "break-word",
      }}
    >
      {children}
    </s-text>
  );

  return (
    <s-stack direction="inline" gap="base" alignItems="center" justifyContent="start">
      {showImages ? (
        <s-box inlineSize="44px" blockSize="44px" padding="none">
          <Thumb imageUrl={imageUrl || ""} sizePx={44} />
        </s-box>
      ) : null}
      <s-box minInlineSize="0">
        <s-stack gap="extra-tight">
          <Line strong>{pRaw}</Line>
          {optText ? <Line subdued>{optText}</Line> : null}
          {line3Text ? <Line subdued>{line3Text}</Line> : null}
        </s-stack>
      </s-box>
    </s-stack>
  );
}

function QtyControlCompact_3Buttons({ value, min = 1, max = 999999, title = "数量", modalId, onDec, onInc, onSetQty, onRemove }) {
  const v = Number.isFinite(Number(value)) ? Number(value) : min;
  const id = useMemo(() => String(modalId), [modalId]);
  const [text, setText] = useState(String(v));

  useEffect(() => setText(String(v)), [v]);

  const clamp = (n) => Math.min(max, Math.max(min, Math.floor(Number(n || min))));
  const digits = String(v).length;
  const valueWidth = qtyValueWidthByDigits_(digits);

  return (
    <>
      <s-stack direction="inline" gap="extra-tight" alignItems="center" justifyContent="end" style={{ flexWrap: "nowrap" }}>
        <s-box inlineSize="44px">
          {(() => {
            const canRemove = typeof onRemove === "function";
            const isRemoveMode = canRemove && v <= min;
            return (
              <s-button
                tone={isRemoveMode ? "critical" : undefined}
                onClick={() => (isRemoveMode ? onRemove?.() : onDec?.())}
                disabled={!isRemoveMode && v <= min}
                style={{ width: "100%" }}
              >
                {isRemoveMode ? "×" : "−"}
              </s-button>
            );
          })()}
        </s-box>
        <s-box inlineSize={`${valueWidth}px`}>
          <s-button command="--show" commandFor={id} style={{ width: "100%" }}>
            {v}
          </s-button>
        </s-box>
        <s-box inlineSize="44px">
          <s-button onClick={() => onInc?.()} disabled={v >= max} style={{ width: "100%" }}>
            +
          </s-button>
        </s-box>
      </s-stack>

      <s-modal id={id} heading={title}>
        <s-box padding="base" paddingBlockEnd="none">
          <s-stack gap="base">
            <s-text type="small" tone="subdued">数量を入力してください（{min}〜{max}）</s-text>
            <s-text-field
              label="数量"
              value={text}
              inputMode="numeric"
              onInput={(e) => setText(String(e?.target?.value ?? e ?? ""))}
              onChange={(e) => setText(String(e?.target?.value ?? e ?? ""))}
            />
            {/* ✅ レイアウト統一：下線、削除ボタン、下線、戻るボタン */}
            {onRemove ? (
              <>
                <s-divider />
                <s-box padding="none">
                  <s-button tone="critical" command="--hide" commandFor={id} onClick={() => onRemove?.()}>
                    削除
                  </s-button>
                </s-box>
                <s-divider />
              </>
            ) : null}
            {/* ✅ 戻るボタン */}
            <s-box padding="none">
              <s-button command="--hide" commandFor={id} onClick={() => {}}>
                戻る
              </s-button>
            </s-box>
          </s-stack>
        </s-box>
        <s-button slot="primary-action" tone="success" command="--hide" commandFor={id} onClick={() => onSetQty?.(clamp(String(text).trim()))}>
          確定
        </s-button>
        {/* ✅ slot="footer"は使用しない（削除ボタンはモーダル内に配置） */}
      </s-modal>
    </>
  );
}

// =========================
// メインコンポーネント
// =========================

const ADJUSTMENT_DRAFT_KEY = "stock_transfer_pos_adjustment_draft_v1";
const ADJUSTMENT_CONDITIONS_DRAFT_KEY = "stock_transfer_pos_adjustment_conditions_draft_v1";
const SCAN_QUEUE_KEY = "stock_transfer_pos_adjustment_scan_queue_v1";

// スキャンキュー管理（OutboundListと同じロジック）
function normalizeScanQueueObj_(raw) {
  // ✅ 旧形式（配列）→ 新形式へ
  if (Array.isArray(raw)) {
    const items = raw
      .map((x) => {
        if (typeof x === "string") return x.trim();
        // 旧：{v,t} 形式も吸収
        return String(x?.v || "").trim();
      })
      .filter(Boolean);
    const lastV = items[items.length - 1] || "";
    return { items, lastV, lastT: Date.now(), updatedAt: Date.now() };
  }

  // ✅ 新形式（object）
  if (raw && typeof raw === "object") {
    const items = Array.isArray(raw.items)
      ? raw.items.map((s) => String(s || "").trim()).filter(Boolean)
      : [];
    return {
      items,
      lastV: String(raw.lastV || items[items.length - 1] || ""),
      lastT: Number(raw.lastT || 0),
      updatedAt: Number(raw.updatedAt || 0),
    };
  }

  return { items: [], lastV: "", lastT: 0, updatedAt: 0 };
}

// ✅ pushScanToQueue_はModal.jsxで定義（出庫/入庫と同じ実装）

// 高速スキャンで「JANが連結」されても、1スキャン=1コードに分解する
function splitScanInputToCodes_(raw) {
  const s0 = String(raw ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!s0) return [];

  const tokens = s0
    .split(/[\s,]+/g)
    .map((t) => String(t).trim())
    .filter(Boolean);

  const out = [];
  for (const t of tokens) {
    if (/^\d+$/.test(t) && t.length >= 8) {
      const sliced = splitConcatenatedEan_(t);
      if (sliced.length) out.push(...sliced);
      else out.push(t);
      continue;
    }
    out.push(t);
  }
  return out;
}

function splitConcatenatedEan_(digits) {
  const s = String(digits);
  const out = [];
  let i = 0;

  while (i < s.length) {
    if (i + 13 <= s.length) {
      const c13 = s.slice(i, i + 13);
      if (isEan13_(c13)) {
        out.push(c13);
        i += 13;
        continue;
      }
    }
    if (i + 8 <= s.length) {
      const c8 = s.slice(i, i + 8);
      if (isEan8_(c8)) {
        out.push(c8);
        i += 8;
        continue;
      }
    }
    return [];
  }
  return out;
}

function isEan13_(code) {
  if (!/^\d{13}$/.test(code)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const n = code.charCodeAt(i) - 48;
    sum += i % 2 === 0 ? n : n * 3;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === (code.charCodeAt(12) - 48);
}

function isEan8_(code) {
  if (!/^\d{8}$/.test(code)) return false;
  let sum = 0;
  for (let i = 0; i < 7; i++) {
    const n = code.charCodeAt(i) - 48;
    sum += i % 2 === 0 ? n * 3 : n;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === (code.charCodeAt(7) - 48);
}

export function AdjustmentProductList({ conds, onBack, onAfterConfirm, setHeader, setFooter, liteMode: liteModeProp, onToggleLiteMode }) {
  const CONFIRM_LOSS_MODAL_ID = "confirm-loss-modal";
  const CONFIRM_RESET_MODAL_ID = "confirm-reset-modal";
  const confirmLossModalRef = useRef(null);
  const confirmResetModalRef = useRef(null);
  const lossDraftLoadedRef = useRef(false);
  
  // -------------------------
  // 値/イベント両対応ヘルパ
  // -------------------------
  const readText = (v) => {
    if (typeof v === "string" || typeof v === "number") return String(v);
    const tv = v?.target?.value;
    if (typeof tv === "string" || typeof tv === "number") return String(tv);
    const dv = v?.detail?.value;
    if (typeof dv === "string" || typeof dv === "number") return String(dv);
    return "";
  };

  const bindPress = (fn) => ({
    onClick: fn,
    onPress: fn,
  });

  // --- search state ---
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searchMountKey, setSearchMountKey] = useState(0);
  const [settings, setSettings] = useState(null); // ✅ 設定を読み込む
  const [candidatesDisplayLimit, setCandidatesDisplayLimit] = useState(50); // ✅ 初期表示50件（設定で変更可能）
  const [searchPageInfo, setSearchPageInfo] = useState({ hasNextPage: false, endCursor: null });
  const [loadingMoreSearch, setLoadingMoreSearch] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [candidateQtyMap, setCandidateQtyMap] = useState({});
  
  // ✅ メニュー画面のprefsから初期値を読み込む
  const loadInitialLiteMode = () => {
    try {
      const raw = localStorage.getItem("stock_transfer_pos_ui_prefs_v1");
      const p = raw ? JSON.parse(raw) : null;
      return p && typeof p === "object" && p.liteMode === true;
    } catch {
      return false;
    }
  };
  const [liteModeLocal, setLiteModeLocal] = useState(loadInitialLiteMode);
  // ✅ 親から渡されたliteModeを優先（コンディション画面のON/OFFが反映される）
  const liteMode = liteModeProp !== undefined && liteModeProp !== null ? !!liteModeProp : liteModeLocal;
  const showImages = !liteMode; // ✅ 軽量モードがOFFの時だけ画像表示

  const handleToggleLiteMode = useCallback(() => {
    if (typeof onToggleLiteMode === "function") {
      onToggleLiteMode();
    } else {
      setLiteModeLocal((prev) => !prev);
    }
  }, [onToggleLiteMode]);

  // ✅ prefsの変更を監視（親から渡されていない場合のローカル同期）
  useEffect(() => {
    if (liteModeProp !== undefined && liteModeProp !== null) return;
    const checkPrefs = () => {
      try {
        const raw = localStorage.getItem("stock_transfer_pos_ui_prefs_v1");
        const p = raw ? JSON.parse(raw) : null;
        const newLiteMode = p && typeof p === "object" && p.liteMode === true;
        setLiteModeLocal((prev) => (prev !== newLiteMode ? newLiteMode : prev));
      } catch {}
    };
    const interval = setInterval(checkPrefs, 500);
    return () => clearInterval(interval);
  }, [liteModeProp]);

  // ✅ 設定を読み込む（マウント時のみ）
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const s = await fetchSettings();
        if (mounted) {
          setSettings(s);
          // 商品リストの初期表示件数を設定から読み込む（最大250、推奨250）
          const productLimit = Math.max(1, Math.min(250, Number(s?.productList?.initialLimit ?? 250)));
          setCandidatesDisplayLimit(productLimit);
        }
      } catch (e) {
        console.error("[LossProductList] fetchSettings error:", e);
        if (mounted) {
          setSettings({ version: 1, carriers: [] });
        }
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const [lines, setLines] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const linesRef = useRef(lines);
  useEffect(() => {
    linesRef.current = lines;
  }, [lines]);

  // スキャンキュー処理用のref（入庫と同様：ストレージ→メモリキュー→処理で連続スキャン可能に）
  const scanWorkingRef = useRef(false);
  const scanQueueRef = useRef([]);

  // 下書き復元（マウント時のみ実行）
  useEffect(() => {
    if (lossDraftLoadedRef.current) return;
    const currentLines = Array.isArray(lines) ? lines : [];
    if (currentLines.length > 0) return;

    lossDraftLoadedRef.current = true;

    (async () => {
      try {
        if (!SHOPIFY?.storage?.get) {
          lossDraftLoadedRef.current = false;
          return;
        }

        const saved = await SHOPIFY.storage.get(ADJUSTMENT_DRAFT_KEY);
        if (!saved || typeof saved !== "object") {
          lossDraftLoadedRef.current = false;
          return;
        }

        const savedConds = saved.conds;
        const savedLinesRaw = Array.isArray(saved.lines) ? saved.lines : [];
        if (savedLinesRaw.length === 0) {
          lossDraftLoadedRef.current = false;
          return;
        }

        // 条件が一致する場合のみ復元
        if (savedConds && conds) {
          const savedLocationId = String(savedConds.locationId || "").trim();
          const currentLocationId = String(conds.locationId || "").trim();
          if (savedLocationId !== currentLocationId) {
            lossDraftLoadedRef.current = false;
            return;
          }
        }

        const normalized = savedLinesRaw
          .map((l, i) => ({
            id: String(l?.id ?? `${Date.now()}-${i}`),
            variantId: l?.variantId ?? null,
            inventoryItemId: l?.inventoryItemId ?? null,
            productTitle: String(l?.productTitle || ""),
            variantTitle: String(l?.variantTitle || ""),
            sku: String(l?.sku || ""),
            barcode: String(l?.barcode || ""),
            imageUrl: String(l?.imageUrl || ""),
            currentQuantity: Number(l?.currentQuantity ?? l?.available ?? 0),
            qty: Math.max(0, Number(l?.qty ?? l?.quantity ?? l?.currentQuantity ?? 0)),
            available: l?.available ?? null,
            stockLoading: false,
          }))
          .filter((l) => l.variantId || l.inventoryItemId);

        if (normalized.length > 0) {
          setLines(normalized);
          toast("下書きを復元しました");
        }
      } catch (e) {
        console.error("Failed to load loss draft:", e);
        lossDraftLoadedRef.current = false;
      }
    })();
  }, []);

  // 自動保存（lines変更時に下書きを保存）
  useEffect(() => {
    if (!conds) return;
    if (lossDraftLoadedRef.current && lines.length === 0) return; // 復元直後は保存しない

    const t = setTimeout(async () => {
      try {
        if (!SHOPIFY?.storage?.set) return;

        const minimized = lines
          .map((l, i) => ({
            id: String(l?.id ?? `${Date.now()}-${i}`),
            currentQuantity: Number(l?.currentQuantity ?? l?.available ?? 0),
            qty: Math.max(0, Number(l?.qty ?? 0)),
            variantId: l?.variantId ?? null,
            inventoryItemId: l?.inventoryItemId ?? null,
            sku: String(l?.sku || ""),
            barcode: String(l?.barcode || ""),
            productTitle: String(l?.productTitle || ""),
            variantTitle: String(l?.variantTitle || ""),
            imageUrl: String(l?.imageUrl || ""),
          }))
          .filter((l) => l.variantId || l.inventoryItemId);

        await SHOPIFY.storage.set(ADJUSTMENT_DRAFT_KEY, {
          version: 1,
          savedAt: Date.now(),
          conds: {
            locationId: conds.locationId,
            locationName: conds.locationName,
            date: conds.date,
            memo: conds.memo,
            staffName: conds.staffName,
          },
          lines: minimized,
        });
      } catch (e) {
        console.error("Failed to save loss draft:", e);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [lines, conds]);

  // locationIdをGID形式に変換（OutboundListと同じ処理）
  const locationGid = useMemo(() => {
    if (!conds?.locationId) return null;
    const s = String(conds.locationId).trim();
    if (s.startsWith("gid://shopify/Location/")) return s;
    if (/^\d+$/.test(s)) return `gid://shopify/Location/${s}`;
    if (s.includes("gid://")) return s;
    return null;
  }, [conds?.locationId]);

  // 候補の在庫数管理（OutboundListと同じ処理）
  const candidateStockRef = useRef(new Map()); // key -> { available, error }
  const candidateStockInflightRef = useRef(new Set()); // key
  const [candidateStockVersion, setCandidateStockVersion] = useState(0); // 再描画トリガ

  const getCandidateStock = (k) => candidateStockRef.current.get(k);

  const ensureCandidateStock = useCallback(
    async (k, variantGid) => {
      if (!locationGid) return;
      if (!variantGid) return;

      if (candidateStockRef.current.has(k)) return;
      if (candidateStockInflightRef.current.has(k)) return;

      candidateStockInflightRef.current.add(k);

      try {
        const r = await fetchVariantAvailable({ variantGid, locationGid });
        candidateStockRef.current.set(k, { available: r?.available ?? null, error: null });
      } catch (e) {
        candidateStockRef.current.set(k, { available: null, error: toUserMessage(e) });
      } finally {
        candidateStockInflightRef.current.delete(k);
        setCandidateStockVersion((v) => v + 1);
      }
    },
    [locationGid]
  );

  const debouncedQuery = useDebounce(query.trim(), 200);

  const getCandidateQty = (key) => {
    const n = Number(candidateQtyMap?.[key] ?? 0);
    return Number.isFinite(n) ? n : 0;
  };

  const setCandidateQty = (key, qty) => {
    const n = Math.max(0, Number(qty || 0));
    setCandidateQtyMap((prev) => ({ ...(prev || {}), [key]: n }));
  };

  // 候補検索：v50(searchVariants/buildVariantSearchQuery) 仕様に合わせて発火条件を制御
  useEffect(() => {
    let mounted = true;

    async function run() {
      const raw = String(debouncedQuery || "").trim();

      if (!raw) {
        if (mounted) {
          setCandidates([]);
          setSearchPageInfo({ hasNextPage: false, endCursor: null });
          setLoading(false);
          const productLimit = Math.max(1, Math.min(250, Number(settings?.productList?.initialLimit ?? 250)));
          setCandidatesDisplayLimit(productLimit);
        }
        return;
      }

      setLoading(true);
      await new Promise((r) => setTimeout(r, 0)); // 押した直後に「読込中...」を描画してから取得開始
      try {
        const includeImages = showImages && !liteMode;
        const searchLimit = settings?.searchList?.initialLimit ?? 50;
        const first = Math.max(10, Math.min(50, Number.isFinite(searchLimit) ? searchLimit : 50));
        const result = await searchVariants(raw, { includeImages, first });
        const list = result?.nodes ?? [];
        const pageInfo = result?.pageInfo ?? { hasNextPage: false, endCursor: null };
        if (mounted) {
          setCandidates(Array.isArray(list) ? list : []);
          setSearchPageInfo(pageInfo);
          const productLimit = Math.max(1, Math.min(250, Number(settings?.productList?.initialLimit ?? 250)));
          setCandidatesDisplayLimit(Math.min(list.length, productLimit));
        }
      } catch (e) {
        toast(`検索エラー: ${toUserMessage(e)}`);
        if (mounted) {
          setCandidates([]);
          setSearchPageInfo({ hasNextPage: false, endCursor: null });
          const productLimit = Math.max(1, Math.min(250, Number(settings?.productList?.initialLimit ?? 250)));
          setCandidatesDisplayLimit(productLimit);
        }
      } finally {
        if (mounted) setLoading(false);
      }
    }

    run();
    return () => {
      mounted = false;
    };
  }, [debouncedQuery, showImages, liteMode, settings]);

  const upsertLineByResolvedVariant = useCallback((resolved, { incBy = 1, closeSearch = true }) => {
    if (!resolved?.inventoryItemId || !resolved?.variantId) return;
    // ✅ 既存行の数量追加のときは在庫取得しない。新規行のみバックグラウンドで在庫取得
    const isNewLine = !linesRef.current.some(
      (l) => l.inventoryItemId === resolved.inventoryItemId || l.variantId === resolved.variantId
    );
    const stockLoading = isNewLine && !!(locationGid && resolved.variantId);
    setLines((prev) => {
      const hit = prev.find((l) => l.inventoryItemId === resolved.inventoryItemId || l.variantId === resolved.variantId);
      if (hit) {
        return prev.map((l) =>
          l.id === hit.id ? { ...l, qty: Math.max(0, (l.qty ?? l.currentQuantity ?? 0) + incBy) } : l
        );
      }
      // スキャン・検索追加時は実数=1で追加し、数量ボタンでカウントできるようにする（在庫=実数だとカウントできないため）
      return [
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          variantId: resolved.variantId,
          inventoryItemId: resolved.inventoryItemId,
          productTitle: resolved.productTitle ?? "",
          variantTitle: resolved.variantTitle ?? "",
          sku: resolved.sku ?? "",
          barcode: resolved.barcode ?? "",
          imageUrl: resolved.imageUrl ?? "",
          currentQuantity: 0,
          qty: 1,
          available: null,
          stockLoading,
        },
        ...prev,
      ];
    });
    if (closeSearch) {
      setQuery("");
      setCandidates([]);
    }
    if (isNewLine && locationGid && resolved.variantId) {
      fetchVariantAvailable({ variantGid: resolved.variantId, locationGid })
        .then((r) => {
          const available = r?.available ?? null;
          const cur = available !== null && available !== undefined ? Number(available) : 0;
          setLines((prev) =>
            prev.map((l) =>
              l.variantId === resolved.variantId || l.inventoryItemId === resolved.inventoryItemId
                ? { ...l, currentQuantity: cur, available, stockLoading: false }
                : l
            )
          );
        })
        .catch(() => {
          setLines((prev) =>
            prev.map((l) =>
              l.variantId === resolved.variantId || l.inventoryItemId === resolved.inventoryItemId
                ? { ...l, stockLoading: false }
                : l
            )
          );
        });
    }
  }, [locationGid]);

  // ✅ スキャンイベントの購読はModal.jsxで行う（出庫/入庫と同じ実装）
  // ここでは削除（重複を避けるため）
  
  // ✅ スキャン処理：メモリキューから1件取り出して resolve → 追加（入庫と同様。連続スキャン時もキューが貯まる）
  const processScanQueue = useCallback(async () => {
    if (scanWorkingRef.current) return;
    if (scanQueueRef.current.length === 0) return;
    if (!locationGid) return;
    const head = scanQueueRef.current.shift();
    if (!head) return;
    scanWorkingRef.current = true;
    try {
      const includeImages = showImages && !liteMode;
      const resolved = await resolveVariantByCode(head, { includeImages });
      if (!resolved?.variantId) {
        toast(`商品が見つかりません: ${head}`);
        return;
      }
      upsertLineByResolvedVariant(resolved, { incBy: 1, closeSearch: false });
      toast(`${resolved.barcode || resolved.sku || resolved.productTitle || "(no title)"} を追加しました（+1）`);
    } catch (e) {
      console.error("processScanQueue error:", e);
    } finally {
      scanWorkingRef.current = false;
      if (scanQueueRef.current.length > 0) processScanQueue().catch(() => {});
    }
  }, [locationGid, showImages, upsertLineByResolvedVariant]);

  const kickProcessScanQueue = useCallback(() => {
    processScanQueue().catch(() => {});
  }, [processScanQueue]);

  // ✅ ストレージ→メモリキューを100ms間隔で取り出し（入庫と同様。resolveを待たず次を貯めるので連続スキャンが速い）
  useEffect(() => {
    const tick = async () => {
      if (!SHOPIFY?.storage?.get || !SHOPIFY?.storage?.set) return;
      const q = (await SHOPIFY.storage.get(SCAN_QUEUE_KEY)) || {};
      const list = Array.isArray(q.items) ? q.items : [];
      if (list.length === 0) return;
      const headRaw = String(list[0] || "").trim();
      const rest = list.slice(1);
      const codes = splitScanInputToCodes_(headRaw);
      const head = String(codes[0] || "").trim();
      const remainingCodes = codes.slice(1);
      const nextItems = [...remainingCodes, ...rest];
      await SHOPIFY.storage.set(SCAN_QUEUE_KEY, {
        items: nextItems,
        lastV: q.lastV || "",
        lastT: Number(q.lastT || 0),
        updatedAt: Date.now(),
      });
      if (head) {
        scanQueueRef.current.push(head);
        kickProcessScanQueue();
      }
    };
    const t = setInterval(() => { tick().catch(() => {}); }, 100);
    return () => clearInterval(t);
  }, [kickProcessScanQueue]);

  const addLine = useCallback((c) => {
    if (!c?.inventoryItemId || !c?.variantId) return;
    const resolved = {
      variantId: c.variantId ?? null,
      inventoryItemId: c.inventoryItemId ?? null,
      productTitle: c.productTitle ?? "",
      variantTitle: c.variantTitle ?? "",
      sku: c.sku ?? "",
      barcode: c.barcode ?? "",
      imageUrl: c.imageUrl ?? "",
    };
    upsertLineByResolvedVariant(resolved, { incBy: 1, closeSearch: false });
  }, [upsertLineByResolvedVariant]);

  const inc = useCallback((id, delta) => {
    setLines((prev) =>
      prev.map((l) => {
        if (String(l.id) !== String(id)) return l;
        const cur = l.currentQuantity ?? l.available ?? 0;
        const nextQty = Math.max(0, (l.qty ?? cur) + delta);
        return { ...l, qty: nextQty };
      })
    );
  }, []);

  const setQty = useCallback((id, qty) => {
    setLines((prev) =>
      prev.map((l) => {
        if (String(l.id) !== String(id)) return l;
        return { ...l, qty: Math.max(0, Number(qty ?? 0)) };
      })
    );
  }, []);

  const remove = useCallback((id) => {
    setLines((prev) => prev.filter((l) => String(l.id) !== String(id)));
  }, []);

  const currentTotal = useMemo(() => lines.reduce((s, l) => s + (Number(l.currentQuantity ?? l.available ?? 0)), 0), [lines]);
  const actualTotal = useMemo(() => lines.reduce((s, l) => s + (Number(l.qty) || 0), 0), [lines]);
  const totalLines = lines.length;
  const overTotal = useMemo(() => lines.reduce((s, l) => {
    const cur = Number(l.currentQuantity ?? l.available ?? 0);
    const act = Number(l.qty) || 0;
    return s + Math.max(0, act - cur);
  }, 0), [lines]);
  const shortTotal = useMemo(() => lines.reduce((s, l) => {
    const cur = Number(l.currentQuantity ?? l.available ?? 0);
    const act = Number(l.qty) || 0;
    return s + Math.max(0, cur - act);
  }, 0), [lines]);
  const canSubmit = totalLines > 0 && !submitting;

  // 確定処理：棚卸と同順（在庫調整 → 変動ログ → 履歴保存 → UI完了 → 下書き削除）
  const handleConfirm = useCallback(async () => {
    if (!canSubmit || !conds?.locationId) {
      if (totalLines === 0) toast("商品を追加してください");
      else if (!conds?.locationId) toast("ロケーションが指定されていません");
      return;
    }
    setSubmitting(true);
    const cur = (l) => Number(l.currentQuantity ?? l.available ?? 0);
    const act = (l) => Number(l.qty ?? 0);
    try {
      const adjustmentEntryId = generateAdjustmentId();
      const itemsForApi = lines.map((l) => ({
        inventoryItemId: l.inventoryItemId,
        currentQuantity: cur(l),
        actualQuantity: act(l),
      }));

      // 1) 在庫調整（棚卸と同様：在庫有効化→inventorySetQuantities・Throttleリトライ）
      const result = await adjustInventoryToActual({
        locationId: conds.locationId,
        items: itemsForApi,
        referenceDocumentUri: adjustmentEntryId,
      });
      const adjustmentGroupId = result?.adjustmentGroup?.id || null;
      if (result?.invalidCount > 0) {
        console.warn(`${result.invalidCount}件の商品が不正なIDのため除外されました`);
        toast(`⚠️ ${result.invalidCount}件の商品が不正なIDのため除外されました`);
      }

      const items = lines.map((l) => {
        const pRaw = String(l.productTitle || "").trim() || "(unknown)";
        const vRaw = String(l.variantTitle || "").trim();
        const options = normalizeVariantOptions_(pRaw, vRaw);
        return {
          inventoryItemId: l.inventoryItemId,
          variantId: l.variantId,
          sku: l.sku ?? "",
          barcode: l.barcode ?? "",
          imageUrl: l.imageUrl ?? "",
          productTitle: l.productTitle ?? "",
          variantTitle: l.variantTitle ?? "",
          title: [l.productTitle, l.variantTitle].filter(Boolean).join(" / ") || l.sku || "-",
          option1: options?.[0] || "",
          option2: options?.[1] || "",
          option3: options?.[2] || "",
          currentQuantity: cur(l),
          quantity: act(l),
        };
      });

      const deltas = lines.map((l) => ({
        inventoryItemId: l.inventoryItemId,
        variantId: l.variantId,
        sku: l.sku || "",
        delta: act(l) - cur(l),
        quantityAfter: act(l),
      })).filter((d) => d.delta !== 0);

      // 2) 変動ログ送信（API成功後のみ・棚卸と同様）
      if (deltas.length > 0) {
        await logInventoryChangeToApi({
          activity: "adjustment",
          locationId: conds.locationId,
          locationName: conds.locationName || "",
          deltas,
          sourceId: adjustmentEntryId,
          adjustmentGroupId,
        });
      }

      // 3) 履歴保存（メタフィールド）
      const existing = await readAdjustmentEntries();
      const existingCount = Array.isArray(existing) ? existing.length : 0;
      const adjustmentName = `#A${String(existingCount + 1).padStart(4, "0")}`;
      const entry = {
        id: adjustmentEntryId,
        adjustmentName,
        locationId: conds.locationId,
        locationName: conds.locationName ?? "",
        date: conds.date ?? "",
        memo: conds.memo ?? "",
        staffMemberId: conds.staffMemberId ?? null,
        staffName: conds.staffName ?? null,
        items,
        status: "active",
        createdAt: new Date().toISOString(),
        adjustmentGroupId,
      };
      await writeAdjustmentEntries([entry, ...existing]);

      // 4) UI完了（棚卸と同様：全処理成功後にトースト・モーダル閉じ・コールバック）
      toast("調整を確定しました");
      confirmLossModalRef?.current?.hideOverlay?.();
      confirmLossModalRef?.current?.hide?.();
      onAfterConfirm?.();
      setSubmitting(false);

      // 5) 下書き削除（確定成功時のみ・棚卸と同様）
      if (SHOPIFY?.storage?.delete) {
        Promise.all([
          SHOPIFY.storage.delete(ADJUSTMENT_DRAFT_KEY),
          SHOPIFY.storage.delete(ADJUSTMENT_CONDITIONS_DRAFT_KEY),
        ]).catch((e) => console.error("Failed to clear adjustment draft:", e));
      }
    } catch (e) {
      toast(`エラー: ${e?.message ?? e}`);
      setSubmitting(false);
    }
  }, [lines, conds, canSubmit, onAfterConfirm]);

  const closeSearchHard = () => {
    setQuery("");
    setCandidates([]);
    setCandidatesDisplayLimit(20); // ✅ 検索クリア時に表示件数もリセット
    setSearchMountKey((k) => k + 1);
  };

  useEffect(() => {
    if (!setHeader) return;
    const q = String(query || "");
    const showCount = q.trim().length > 0;
    
    // readText関数をuseEffect内で再定義（クロージャー問題を回避）
    const readTextLocal = (v) => {
      if (typeof v === "string" || typeof v === "number") return String(v);
      const tv = v?.target?.value;
      if (typeof tv === "string" || typeof tv === "number") return String(tv);
      const dv = v?.detail?.value;
      if (typeof dv === "string" || typeof dv === "number") return String(dv);
      return "";
    };
    
    // bindPressとcloseSearchHardをuseEffect内で再定義（無限ループを回避）
    const bindPressLocal = (fn) => ({
      onClick: fn,
      onPress: fn,
    });
    
    const closeSearchHardLocal = () => {
      setQuery("");
      setCandidates([]);
      setCandidatesDisplayLimit(20);
      setSearchMountKey((k) => k + 1);
    };
    
    setHeader(
      <s-box padding="base">
        <s-stack gap="tight">
          <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
            {/* 左：タイトル＋条件表示 */}
            <s-stack gap="none" style={{ flex: "1 1 0", minInlineSize: 0 }}>
              <s-text emphasis="bold" size="small">調整登録</s-text>
              <s-text size="small">ロケーション：{conds?.locationName || conds?.locationId || "-"}</s-text>
              <s-text size="small">日付：{conds?.date || "-"}</s-text>
              <s-text size="small">メモ：{conds?.memo || "-"}</s-text>
            </s-stack>
            {/* 右：画像表示とリセットを右寄せで並べる */}
            <s-stack direction="inline" gap="base" alignItems="center" justifyContent="end" style={{ flexShrink: 0 }}>
              <s-button
                kind="secondary"
                tone={liteMode ? "critical" : undefined}
                onClick={handleToggleLiteMode}
                style={{ paddingInline: 8, whiteSpace: "nowrap" }}
              >
                {liteMode ? "画像OFF" : "画像ON"}
              </s-button>
              <s-button
                kind="secondary"
                tone="critical"
                command="--show"
                commandFor={CONFIRM_RESET_MODAL_ID}
                {...bindPressLocal(() => {})}
                style={{ paddingInline: 8, whiteSpace: "nowrap" }}
              >
                リセット
              </s-button>
            </s-stack>
          </s-stack>

          {/* 検索（100%幅＋×は右端固定） */}
          <s-box inlineSize="100%" paddingBlockStart="small-200">
            <s-text-field
              key={searchMountKey}
              label="検索"
              labelHidden
              placeholder="商品名 / SKU / バーコード"
              value={q}
              onInput={(v) => setQuery(readTextLocal(v))}
              onChange={(v) => setQuery(readTextLocal(v))}
            >
              {q ? (
                <s-button slot="accessory" kind="secondary" tone="critical" {...bindPressLocal(closeSearchHardLocal)}>
                  ✕
                </s-button>
              ) : null}
            </s-text-field>
          </s-box>

          {showCount ? (
            <s-text tone="subdued" size="small">
              検索結果：{loading ? "…" : candidates.length}件
            </s-text>
          ) : null}

          {loading ? <s-text tone="subdued" size="small">読み込み中...</s-text> : null}
        </s-stack>
      </s-box>
    );
    return () => setHeader?.(null);
  }, [setHeader, conds?.locationName, conds?.date, conds?.memo, query, candidates.length, loading, searchMountKey, liteMode, handleToggleLiteMode]);

  useEffect(() => {
    if (!setFooter) return;
    setFooter(
      <FixedFooterNavBar
        summaryLeft=""
        summaryCenter={
        <s-stack gap="none" alignItems="center">
          <s-text size="small" tone="subdued">明細 {totalLines} / 在庫 {currentTotal} / 実数 {actualTotal}</s-text>
          <s-text size="small" tone={overTotal + shortTotal > 0 ? "critical" : "subdued"}>超過 {overTotal} / 不足 {shortTotal}</s-text>
        </s-stack>
      }
        summaryRight=""
        leftLabel="戻る"
        onLeft={onBack}
        leftDisabled={submitting}
        rightLabel={submitting ? "処理中..." : "確定"}
        onRight={() => {
          // command="--show"でモーダルを表示するため、ここでは何もしない
        }}
        rightCommand="--show"
        rightCommandFor={CONFIRM_LOSS_MODAL_ID}
        rightTone="success"
        rightDisabled={!canSubmit}
        centerAlignWithButtons={true} // ✅ 商品リストのフッター：明細/合計をボタンと上下中央揃え
      />
    );
    return () => setFooter?.(null);
  }, [setFooter, totalLines, currentTotal, actualTotal, overTotal, shortTotal, submitting, canSubmit, onBack]);

  // =========================
  // ✅ 表示する候補（表示件数制限適用）
  // =========================
  const displayedCandidates = useMemo(() => {
    return candidates.slice(0, candidatesDisplayLimit);
  }, [candidates, candidatesDisplayLimit]);

  const hasMoreCandidates = candidates.length > candidatesDisplayLimit;

  const handleShowMoreCandidates = useCallback(() => {
    setCandidatesDisplayLimit((prev) => prev + 20);
  }, []);

  const handleLoadMoreSearch = useCallback(async () => {
    const raw = String(debouncedQuery || "").trim();
    if (!raw || loadingMoreSearch || !searchPageInfo?.hasNextPage || !searchPageInfo?.endCursor) return;
    setLoadingMoreSearch(true);
    await new Promise((r) => setTimeout(r, 0)); // 押した直後に「読込中...」を描画してから取得開始
    try {
      const searchLimit = settings?.searchList?.initialLimit ?? 50;
      const first = Math.max(10, Math.min(50, Number.isFinite(searchLimit) ? searchLimit : 50));
      const result = await searchVariants(raw, { includeImages: showImages && !liteMode, first, after: searchPageInfo.endCursor });
      const list = result?.nodes ?? [];
      const pageInfo = result?.pageInfo ?? { hasNextPage: false, endCursor: null };
      setCandidates((prev) => [...prev, ...list]);
      setSearchPageInfo(pageInfo);
      setCandidatesDisplayLimit((prev) => prev + list.length);
    } catch (e) {
      toast(`追加読み込みに失敗しました: ${toUserMessage(e)}`);
    } finally {
      setLoadingMoreSearch(false);
    }
  }, [debouncedQuery, searchPageInfo?.hasNextPage, searchPageInfo?.endCursor, loadingMoreSearch, showImages, liteMode, settings?.searchList?.initialLimit]);

  // CandidateRow コンポーネント（OutboundListと同じデザイン）
  const CandidateRow = ({ c, idx }) => {
    const productTitle = String(c?.productTitle || "").trim();
    const variantTitle = String(c?.variantTitle || "").trim();
    const sku = String(c?.sku || "").trim();
    const barcode = String(c?.barcode || "").trim();
    const imageUrl = String(c?.imageUrl || "").trim();

    const stableKey = String(c?.variantId || c?.inventoryItemId || sku || barcode || `${productTitle}__${variantTitle}`);
    const key = stableKey;
    const safeKey = toSafeId(key);
    const shownQty = getCandidateQty(key);
    const modalId = `cand-qty-${safeKey}`;

    const resolved = {
      variantId: c?.variantId ?? null,
      inventoryItemId: c?.inventoryItemId ?? null,
      productTitle,
      variantTitle,
      sku,
      barcode,
      imageUrl,
    };

    const [text, setText] = useState(String(shownQty > 0 ? shownQty : 1));

    useEffect(() => {
      setText(String(shownQty > 0 ? shownQty : 1));
    }, [shownQty]);

    const clampAdd = (n) => {
      const x = Number(n);
      if (!Number.isFinite(x)) return 1;
      return Math.max(1, Math.min(999999, Math.floor(x)));
    };

    const addOne = async () => {
      upsertLineByResolvedVariant(resolved, { incBy: 1, closeSearch: false });
      setCandidateQty(key, shownQty + 1);
      toast(`${resolved?.barcode || resolved?.sku || productTitle || "(no title)"} を追加しました（+1）`);
    };

    const commitAddByQty = async () => {
      const n = clampAdd(String(text || "").trim());
      upsertLineByResolvedVariant(resolved, { incBy: n, closeSearch: false });
      setCandidateQty(key, n);
      toast(`${resolved?.barcode || resolved?.sku || productTitle || "(no title)"} を追加しました（+${n}）`);
    };

    // ▼ 在庫（すべての候補に対して取得）
    void candidateStockVersion;
    useEffect(() => {
      if (!c?.variantId) return;
      // ✅ 制限を外してすべての候補に対して在庫を取得
      ensureCandidateStock(key, c.variantId);
    }, [key, c?.variantId, ensureCandidateStock]);

    const stock = getCandidateStock(key);
    const stockText =
      stock?.error ? "在庫: —" :
      stock && stock.available !== null ? `在庫: ${stock.available}` :
      "在庫: …";

    const skuLine = `${sku ? `SKU: ${sku}` : ""}${barcode ? `${sku ? " / " : ""}JAN: ${barcode}` : ""}`.trim();
    const digits = String(shownQty).length;
    const valueWidth = qtyValueWidthByDigits_(digits);

    return (
      <s-box padding="none">
        <StockyRowShell>
          <s-stack gap="extra-tight" inlineSize="100%">
            <s-box>
              <ItemLeftCompact
                showImages={showImages && !liteMode}
                imageUrl={imageUrl}
                productTitle={productTitle || "(no title)"}
                variantTitle={variantTitle}
                line3={skuLine}
              />
            </s-box>
            <s-box inlineSize="100%">
              <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between" style={{ width: "100%", flexWrap: "nowrap" }}>
                <s-box style={{ flex: "1 1 auto", minWidth: 0 }}>
                  <s-text tone="subdued" size="small" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {stockText}
                  </s-text>
                </s-box>
                <s-box style={{ flex: "0 0 auto" }}>
                  <s-stack direction="inline" gap="extra-tight" alignItems="center" justifyContent="end">
                    <s-box inlineSize={`${valueWidth}px`}>
                      <s-button command="--show" commandFor={modalId} onClick={() => setText(String(shownQty > 0 ? shownQty : 1))} style={{ width: "100%", whiteSpace: "nowrap" }}>
                        {shownQty}
                      </s-button>
                    </s-box>
                    <s-box inlineSize="44px">
                      <s-button onClick={addOne} style={{ width: "100%" }}>
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
              <s-text tone="subdued" size="small">数量を入力して「追加」を押してください（1〜999999）</s-text>
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
                <s-button command="--hide" commandFor={modalId} onClick={() => {}}>
                  戻る
                </s-button>
              </s-box>
            </s-stack>
          </s-box>
          <s-button slot="primary-action" tone="success" command="--hide" commandFor={modalId} onClick={commitAddByQty}>
            追加
          </s-button>
        </s-modal>
        <s-divider />
      </s-box>
    );
  };

  // LossAddedLineRow コンポーネント（OutboundAddedLineRowと同じデザイン）
  const LossAddedLineRow = ({ line, onDec, onInc, onSetQty, onRemove }) => {
    const productTitle = String(line?.productTitle || "").trim() || "(unknown)";
    const variantTitle = String(line?.variantTitle || "").trim();
    const qty = Math.max(0, Number(line?.qty ?? line?.currentQuantity ?? line?.available ?? 0));
    const modalKey = line?.inventoryItemId || line?.variantId || productTitle || "row";
    const modalId = `qty-loss-${toSafeId(modalKey)}`;
    const sku = String(line?.sku || "").trim();
    const barcode = String(line?.barcode || "").trim();
    const skuLine = `${sku ? `SKU: ${sku}` : ""}${barcode ? `${sku ? " / " : ""}JAN: ${barcode}` : ""}`.trim();

    const currentQ = line?.currentQuantity ?? line?.available ?? "—";
    const actualQ = line?.qty ?? "—";
    const stockText = line?.stockLoading ? "在庫: …" : `在庫: ${currentQ}`;
    const actualText = `実数: ${actualQ}`;

    return (
      <s-box padding="none">
        <StockyRowShell>
          <s-stack gap="extra-tight" inlineSize="100%">
            <s-box inlineSize="100%">
              <ItemLeftCompact
                showImages={showImages && !liteMode}
                imageUrl={line?.imageUrl || ""}
                productTitle={productTitle}
                variantTitle={variantTitle}
                line3={skuLine}
              />
            </s-box>
            <s-box inlineSize="100%">
              <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between" style={{ width: "100%", flexWrap: "nowrap" }}>
                <s-box style={{ flex: "1 1 auto", minWidth: 0 }}>
                  <s-stack gap="none">
                    <s-text tone="subdued" size="small" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {stockText}
                    </s-text>
                    <s-text tone="subdued" size="small">{actualText}</s-text>
                  </s-stack>
                </s-box>
                <s-box style={{ flex: "0 0 auto" }}>
                  <QtyControlCompact_3Buttons
                    value={qty}
                    min={0}
                    modalId={modalId}
                    onDec={onDec}
                    onInc={onInc}
                    onSetQty={onSetQty}
                    onRemove={onRemove}
                  />
                </s-box>
              </s-stack>
            </s-box>
          </s-stack>
        </StockyRowShell>
        <s-divider />
      </s-box>
    );
  };

  const adjustmentAddedLineRowMemoRef = useRef(null);
  if (adjustmentAddedLineRowMemoRef.current === null) {
    adjustmentAddedLineRowMemoRef.current = memo(function AdjustmentAddedLineRowMemo({ line, inc, setQty, remove }) {
      return (
        <LossAddedLineRow
          line={line}
          onDec={() => inc(line.id, -1)}
          onInc={() => inc(line.id, 1)}
          onSetQty={(n) => setQty(line.id, n)}
          onRemove={() => remove(line.id)}
        />
      );
    });
  }
  const AdjustmentAddedLineRowMemo = adjustmentAddedLineRowMemoRef.current;

  const handleReset = useCallback(async () => {
    setLines([]);
    setQuery("");
    setCandidates([]);
    setCandidateQtyMap({});
    try {
      if (SHOPIFY?.storage?.delete) {
        await SHOPIFY.storage.delete(ADJUSTMENT_DRAFT_KEY);
      }
    } catch (e) {
      console.error("Failed to clear loss draft:", e);
    }
    confirmResetModalRef?.current?.hideOverlay?.();
    confirmResetModalRef?.current?.hide?.();
    toast("商品リストをリセットしました");
  }, []);

  return (
    <s-stack gap="none">
      {/* リセット確認モーダル */}
      <s-modal id={CONFIRM_RESET_MODAL_ID} heading="商品リストをリセットしますか？" ref={confirmResetModalRef}>
        <s-box padding="base" paddingBlockEnd="none">
          <s-stack gap="base">
            <s-text tone="subdued">
              商品リストがすべて削除されます。この操作は取り消せません。
            </s-text>
            <s-divider />
            <s-box>
              <s-button
                command="--hide"
                commandFor={CONFIRM_RESET_MODAL_ID}
                onClick={() => {}}
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
          commandFor={CONFIRM_RESET_MODAL_ID}
          onClick={handleReset}
        >
          リセットする
        </s-button>
      </s-modal>

      {/* 確定確認モーダル（OutboundListと同じ仕様） */}
      <s-modal id={CONFIRM_LOSS_MODAL_ID} heading="調整を確定しますか？" ref={confirmLossModalRef}>
        <s-box padding="base" paddingBlockEnd="none">
          <s-stack gap="extra-tight">
            <s-text size="small" tone="subdued">
              ロケーション: {conds?.locationName || conds?.locationId || "-"}
            </s-text>
            <s-text size="small" tone="subdued">
              明細: {totalLines} / 在庫: {currentTotal} / 実数: {actualTotal}
            </s-text>
            <s-text size="small" tone="subdued">
              日付: {conds?.date || "-"}
            </s-text>
            <s-text size="small" tone="subdued">
              メモ: {conds?.memo || "-"}
            </s-text>
            <s-text size="small" tone="subdued">
              スタッフ: {conds?.staffName || "-"}
            </s-text>
          </s-stack>
          <s-box paddingBlockStart="small" paddingBlockEnd="small">
            <s-divider />
          </s-box>
          <s-box>
            <s-button
              command="--hide"
              commandFor={CONFIRM_LOSS_MODAL_ID}
              onClick={() => {
                // 何も実行せずにモーダルを閉じる
              }}
            >
              戻る
            </s-button>
          </s-box>
        </s-box>
        <s-button
          slot="primary-action"
          tone="success"
          command="--hide"
          commandFor={CONFIRM_LOSS_MODAL_ID}
          disabled={!canSubmit || submitting}
          onClick={handleConfirm}
        >
          {submitting ? "処理中..." : "確定する"}
        </s-button>
      </s-modal>

      {candidates.length > 0 ? (
        <s-box padding="base">
          <s-stack gap="extra-tight">
            {displayedCandidates.map((c, idx) => {
              const stableKey = String(
                c?.variantId || c?.inventoryItemId || c?.sku || c?.barcode || `${c?.productTitle}__${c?.variantTitle}`
              );
              return <CandidateRow key={stableKey} c={c} idx={idx} />;
            })}
            
            {hasMoreCandidates ? (
              <s-box padding="small">
                <s-button kind="secondary" onClick={handleShowMoreCandidates} onPress={handleShowMoreCandidates}>
                  さらに表示（残り {candidates.length - candidatesDisplayLimit}件）
                </s-button>
              </s-box>
            ) : null}
            {searchPageInfo?.hasNextPage ? (
              <s-box padding="small">
                <s-button kind="secondary" disabled={loadingMoreSearch} onClick={handleLoadMoreSearch} onPress={handleLoadMoreSearch}>
                  {loadingMoreSearch ? "読込中..." : "さらに読み込む"}
                </s-button>
              </s-box>
            ) : null}
          </s-stack>
        </s-box>
      ) : null}

      {candidates.length > 0 ? <s-divider /> : null}

      <s-box padding="base">
        {/* ✅ 未読み込み商品リストがある場合は最上部に表示（入庫・出庫と同様の形式、ただしmetafieldは全件取得のため常に非表示） */}
        {/* 注意: ロスはmetafieldから全件取得しているため、実際には追加読み込みは不要 */}
        {/* pageInfoは常にfalseのため、読込ボタンは表示されない */}
        {false && (
          <s-box padding="base" style={{ paddingBlockStart: 0 }}>
            <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
              <s-text tone="subdued" size="small">
                未読み込み商品リストがあります。（要読込）
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

        {lines.length === 0 ? (
          <s-text tone="subdued">まだ追加されていません</s-text>
        ) : (
          <s-stack gap="none">
            <s-text emphasis="bold">調整リスト</s-text>
            <s-box style={{ blockSize: "8px" }} />
            {lines.map((l) => (
              <AdjustmentAddedLineRowMemo
                key={l.id}
                line={l}
                inc={inc}
                setQty={setQty}
                remove={remove}
              />
            ))}
          </s-stack>
        )}
      </s-box>
    </s-stack>
  );
}
