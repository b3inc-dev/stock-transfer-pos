/**
 * 入庫リスト用 UI パーツ（Modal_REFERENCE.jsx から移植）
 * - Thumb, ItemLeftCompact, StockyRowShell, QtyControlCompact_3Buttons, InboundAddedLineRow
 * - renderInboundShipmentItems_
 * - ユーティリティ: toSafeId, calcQtyWidthPx_, normalizeVariantOptions_, formatOptionsLine_
 */
import { useState, useEffect, useMemo } from "preact/hooks";

// ----- ユーティリティ（REFERENCE 互換） -----
export function toSafeId(s) {
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

export function normalizeVariantOptions_(productTitle, variantTitle) {
  const v = normalizeVariantTitleForDisplay_(productTitle, variantTitle);
  if (!v) return [];
  return v.split("/").map((s) => s.trim()).filter(Boolean);
}

export function formatOptionsLine_(options) {
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

export function calcQtyWidthPx_(v) {
  const n = Number.isFinite(Number(v)) ? Number(v) : 0;
  const digits = String(n).length;
  return qtyValueWidthByDigits_(digits);
}

function safeImageSrc_(maybeUrl) {
  const u = typeof maybeUrl === "string" ? maybeUrl.trim() : "";
  if (!u) return "";
  if (u.startsWith("//")) return `https:${u}`;
  if (u.startsWith("https://")) return u;
  if (u.startsWith("http://")) return "";
  return u;
}

// ----- Thumb -----
export function Thumb({ imageUrl, sizePx = 44 }) {
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

// ----- ItemLeftCompact -----
export function ItemLeftCompact({ showImages, imageUrl, productTitle, variantTitle, line3 }) {
  const pRaw = String(productTitle || "").trim() || "(unknown)";
  const vRaw = String(variantTitle || "").trim();
  const p = pRaw;
  const v = vRaw;
  const options = normalizeVariantOptions_(pRaw, v);
  const optionsLine = formatOptionsLine_(options);
  const optText = String(optionsLine || "").trim();
  const line3Text = String(line3 || "").trim();

  const Line = ({ children, strong = false, subdued = false }) => (
    <s-text
      emphasis={strong ? "bold" : undefined}
      size={subdued ? "small" : undefined}
      tone={subdued ? "subdued" : undefined}
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
          <Line strong>{p}</Line>
          {optText ? <Line subdued>{optText}</Line> : null}
          {line3Text ? <Line subdued>{line3Text}</Line> : null}
        </s-stack>
      </s-box>
    </s-stack>
  );
}

// ----- StockyRowShell -----
export function StockyRowShell({ children }) {
  return (
    <s-box paddingInline="none" paddingBlockStart="small-100" paddingBlockEnd="small-200">
      {children}
    </s-box>
  );
}

// ----- QtyControlCompact_3Buttons -----
export function QtyControlCompact_3Buttons({
  value,
  min = 1,
  max = 999999,
  title = "数量",
  modalId,
  onDec,
  onInc,
  onSetQty,
  onRemove,
  step = 1,
  disabled = false,
}) {
  const v = Number.isFinite(Number(value)) ? Number(value) : min;
  const id = useMemo(() => String(modalId), [modalId]);
  const [text, setText] = useState(String(v));

  useEffect(() => setText(String(v)), [v]);

  const clamp = (n) => Math.min(max, Math.max(min, Math.floor(Number(n || min))));
  const digits = String(v).length;
  const valueWidth = qtyValueWidthByDigits_(digits);
  const subduedTone = disabled ? "subdued" : undefined;

  return (
    <>
      <s-stack
        direction="inline"
        gap="extra-tight"
        alignItems="center"
        justifyContent="end"
        style={{ flexWrap: "nowrap" }}
      >
        <s-box inlineSize="44px">
          {(() => {
            const canRemove = typeof onRemove === "function";
            const isRemoveMode = canRemove && v <= min;
            return (
              <s-button
                tone={disabled ? subduedTone : (isRemoveMode ? "critical" : undefined)}
                onClick={() => (isRemoveMode ? onRemove?.() : onDec?.())}
                disabled={disabled || (!isRemoveMode && v <= min)}
                style={{ width: "100%" }}
              >
                {isRemoveMode ? "×" : "−"}
              </s-button>
            );
          })()}
        </s-box>
        <s-box inlineSize={`${valueWidth}px`}>
          <s-button command="--show" commandFor={id} disabled={disabled} tone={subduedTone} style={{ width: "100%" }}>
            {v}
          </s-button>
        </s-box>
        <s-box inlineSize="44px">
          <s-button onClick={() => onInc?.()} disabled={disabled || v >= max} tone={subduedTone} style={{ width: "100%" }}>
            +
          </s-button>
        </s-box>
      </s-stack>

      <s-modal id={id} heading={title}>
        <s-box padding="base" paddingBlockEnd="none">
          <s-stack gap="base">
            <s-text size="small" tone="subdued">
              数量を入力してください（{min}〜{max}）
            </s-text>
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
                  <s-button tone="critical" command="--hide" commandFor={id} onClick={() => onRemove?.()}>
                    削除
                  </s-button>
                </s-box>
                <s-divider />
              </>
            ) : null}
            <s-box padding="none">
              <s-button command="--hide" commandFor={id} onClick={() => {}}>
                戻る
              </s-button>
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

// ----- InboundAddedLineRow -----
export function InboundAddedLineRow({
  row,
  showImages,
  dialog,
  qty,
  modalKey,
  skuLine,
  bottomLeft,
  bottomLeftTone,
  onDec,
  onInc,
  onSetQty,
  onRemove,
  minQty,
  readOnly = false,
}) {
  const rawLabel = String(row?.label || row?.title || "").trim();
  const parts = rawLabel ? rawLabel.split("/").map((s) => s.trim()).filter(Boolean) : [];
  const productTitle = String(row?.productTitle || "").trim() || parts[0] || rawLabel || "(unknown)";
  const variantTitle =
    String(row?.variantTitle || "").trim() || (parts.length >= 2 ? parts.slice(1).join(" / ") : "");
  const q = Math.max(0, Number(qty ?? row?.qty ?? 0));
  const keyBase =
    modalKey ||
    row?.key ||
    row?.shipmentLineItemId ||
    row?.inventoryItemId ||
    row?.variantId ||
    rawLabel ||
    "row";
  const modalId = `qty-in-${toSafeId(keyBase)}`;

  return (
    <s-box padding="none">
      <StockyRowShell>
        <s-stack gap="extra-tight" inlineSize="100%">
          <s-box inlineSize="100%">
            <ItemLeftCompact
              showImages={showImages}
              imageUrl={row?.imageUrl || ""}
              productTitle={productTitle}
              variantTitle={variantTitle}
              line3={String(skuLine || "").trim()}
            />
          </s-box>
          <s-box inlineSize="100%">
            <s-stack
              direction="inline"
              gap="base"
              alignItems="center"
              justifyContent="space-between"
              style={{ width: "100%", flexWrap: "nowrap" }}
            >
              <s-box style={{ flex: "1 1 auto", minWidth: 0 }}>
                <s-text
                  tone={bottomLeftTone === "critical" ? "critical" : "subdued"}
                  size="small"
                  style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                >
                  {String(bottomLeft || "").trim() || " "}
                </s-text>
              </s-box>
              {onDec !== null || onInc !== null || onSetQty !== null || onRemove !== null ? (
                <s-box style={{ flex: "0 0 auto" }}>
                  <QtyControlCompact_3Buttons
                    value={q}
                    min={Number.isFinite(Number(minQty)) ? Number(minQty) : 0}
                    modalId={modalId}
                    onDec={onDec}
                    onInc={onInc}
                    onSetQty={onSetQty}
                    onRemove={typeof onRemove === "function" ? onRemove : null}
                    disabled={readOnly}
                  />
                </s-box>
              ) : null}
            </s-stack>
          </s-box>
        </s-stack>
      </StockyRowShell>
      <s-divider />
    </s-box>
  );
}

// ----- InboundCandidateRow（検索候補1行・REFERENCE互換・コンポーネント内定義だと minify で Bt 初期化エラーになるためここに配置） -----
export function InboundCandidateRow({
  c,
  idx,
  showImages,
  liteMode,
  addQtyById,
  setAddQtyById,
  addOrIncrementByResolved,
  ensureInbCandidateStock,
  getInbCandidateStock,
  inbCandidateStockVersion,
  readOnly = false,
}) {
  const vid = String(c?.variantId || "").trim();
  if (!vid) return null;
  const productTitle = String(c?.productTitle || "").trim();
  const variantTitle = String(c?.variantTitle || "").trim();
  const sku = String(c?.sku || "").trim();
  const barcode = String(c?.barcode || "").trim();
  const skuLine = `${sku ? `SKU: ${sku}` : ""}${barcode ? `${sku ? " / " : ""}JAN: ${barcode}` : ""}`.trim();
  const shownQty = Math.max(0, Number(addQtyById[vid] || 0));
  const [text, setText] = useState(String(shownQty > 0 ? shownQty : 1));
  useEffect(() => setText(String(shownQty > 0 ? shownQty : 1)), [shownQty]);
  useEffect(() => {
    void inbCandidateStockVersion;
    ensureInbCandidateStock(vid, vid);
  }, [vid, ensureInbCandidateStock, inbCandidateStockVersion]);
  const stock = getInbCandidateStock(vid);
  const stockText =
    stock?.loading ? "在庫: …" : `在庫: ${Number.isFinite(Number(stock?.available)) ? Number(stock.available) : "—"}`;
  const modalId = toSafeId(`INB_CAND_QTY_${vid}`);
  const clampAdd = (s) => {
    const x = Number(String(s || "").replace(/[^\d]/g, ""));
    if (!Number.isFinite(x)) return 1;
    return Math.max(1, Math.min(999999, Math.floor(x)));
  };
  const resolved = {
    variantId: vid,
    inventoryItemId: c?.inventoryItemId,
    productTitle,
    variantTitle,
    sku,
    barcode,
    imageUrl: c?.imageUrl || "",
  };
  const commitAddByQty = () => {
    const next = clampAdd(text);
    addOrIncrementByResolved(resolved, next, { toastOnExtra: true });
    setAddQtyById((prev) => {
      const cur = Number(prev?.[vid] || 0);
      return { ...prev, [vid]: cur + next };
    });
  };
  const addOne = () => {
    addOrIncrementByResolved(resolved, 1, { toastOnExtra: true });
    setAddQtyById((prev) => {
      const cur = Number(prev?.[vid] || 0);
      return { ...prev, [vid]: cur + 1 };
    });
  };
  return (
    <s-box padding="none">
      <StockyRowShell key={vid}>
        <s-stack gap="extra-tight">
          <s-box style={{ width: "100%" }}>
            <ItemLeftCompact
              showImages={showImages && !liteMode}
              imageUrl={c?.imageUrl || ""}
              productTitle={productTitle || "(no title)"}
              variantTitle={variantTitle}
              line3={skuLine}
            />
          </s-box>
          <s-box inlineSize="100%">
            <s-stack direction="inline" gap="base" justifyContent="space-between" alignItems="center" style={{ width: "100%", flexWrap: "nowrap" }}>
              <s-box style={{ flex: "1 1 auto", minWidth: 0 }}>
                <s-text tone="subdued" size="small" style={{ whiteSpace: "nowrap" }}>{stockText}</s-text>
              </s-box>
              <s-box style={{ flex: "0 0 auto" }}>
                <s-stack direction="inline" gap="extra-tight" alignItems="center" justifyContent="end" style={{ flexWrap: "nowrap", whiteSpace: "nowrap" }}>
                  <s-box inlineSize={`${calcQtyWidthPx_(shownQty)}px`}>
                    <s-button command="--show" commandFor={modalId} onClick={() => setText(String(shownQty > 0 ? shownQty : 1))} disabled={readOnly} tone={readOnly ? "subdued" : undefined} style={{ width: "100%", whiteSpace: "nowrap" }}>
                      {shownQty}
                    </s-button>
                  </s-box>
                  <s-box inlineSize="44px">
                    <s-button tone={readOnly ? "subdued" : "success"} disabled={readOnly} onClick={addOne} onPress={addOne} style={{ width: "100%", whiteSpace: "nowrap" }}>+</s-button>
                  </s-box>
                </s-stack>
              </s-box>
            </s-stack>
          </s-box>
        </s-stack>
        <s-modal id={modalId} heading="数量を指定して追加">
          <s-box padding="base" paddingBlockEnd="none">
            <s-stack gap="base">
              <s-text tone="subdued" size="small">数量を入力して「追加」を押してください（1〜999999）</s-text>
              <s-text-field label="数量" value={text} inputMode="numeric" placeholder="例: 20" onInput={(e) => setText(String(e?.target?.value ?? e ?? ""))} onChange={(e) => setText(String(e?.target?.value ?? e ?? ""))} />
              <s-divider />
              <s-box>
                <s-button command="--hide" commandFor={modalId} onClick={() => {}}>戻る</s-button>
              </s-box>
            </s-stack>
          </s-box>
          <s-button slot="primary-action" tone={readOnly ? "subdued" : "success"} disabled={readOnly} command="--hide" commandFor={modalId} onClick={commitAddByQty} onPress={commitAddByQty}>追加</s-button>
        </s-modal>
      </StockyRowShell>
    </s-box>
  );
}

// ----- renderExtras_（予定外入荷リスト） -----
export function renderExtras_({ extras, extrasHistory, showImages, dialog, setExtraQty }) {
  const hasExtrasHistory = Array.isArray(extrasHistory) && extrasHistory.length > 0;
  if (!Array.isArray(extras) || extras.length === 0) {
    if (hasExtrasHistory) return null;
    return <s-text tone="subdued" size="small">予定外追加はありません</s-text>;
  }
  return (
    <s-stack gap="none">
      {extras.map((x) => {
        const received = Number(x?.receiveQty || 0);
        const sku = String(x?.sku || "").trim();
        const barcode = String(x?.barcode || "").trim();
        const skuLine = sku ? `SKU:${sku}${barcode ? ` / JAN:${barcode}` : ""}` : barcode ? `JAN:${barcode}` : "";
        const bottomLeft = `予定外 / 入庫 ${received}`;
        const bottomLeftTone = received > 0 ? "critical" : "subdued";
        return (
          <InboundAddedLineRow
            key={x.key}
            row={{ title: x.title || x.sku || x.inventoryItemId || "(unknown)", imageUrl: x.imageUrl || "" }}
            showImages={showImages}
            dialog={dialog}
            qty={received}
            modalKey={x.key}
            skuLine={skuLine}
            bottomLeft={bottomLeft}
            bottomLeftTone={bottomLeftTone}
            onDec={() => setExtraQty(x.key, Math.max(0, received - 1))}
            onInc={() => setExtraQty(x.key, received + 1)}
            onSetQty={(n) => setExtraQty(x.key, n)}
            minQty={1}
            onRemove={() => setExtraQty(x.key, 0)}
          />
        );
      })}
    </s-stack>
  );
}

// ----- renderExtrasHistory_（予定外入荷履歴） -----
export function renderExtrasHistory_({ extrasHistory, extrasHistoryLoading, showImages, dialog }) {
  if (extrasHistoryLoading) return <s-text tone="subdued" size="small">読み込み中...</s-text>;
  if (!Array.isArray(extrasHistory) || extrasHistory.length === 0) return null;
  return (
    <s-stack gap="none">
      {extrasHistory.map((h, idx) => {
        const titleRaw = String(h.title || h.inventoryItemId || "(unknown)").trim();
        const parts = titleRaw.split("/").map((s) => s.trim()).filter(Boolean);
        const productTitle = parts[0] || titleRaw;
        const variantTitle = parts.length >= 2 ? parts.slice(1).join(" / ") : "";
        const sku = String(h.sku || "").trim();
        const barcode = String(h.barcode || "").trim();
        const skuLine = sku ? `SKU:${sku}${barcode ? ` / JAN:${barcode}` : ""}` : barcode ? `JAN:${barcode}` : "";
        const imageUrl = String(h.imageUrl || "").trim();
        const received = Number(h.qty || 0);
        const bottomLeft = `予定外 / 入庫 ${received}`;
        const bottomLeftTone = received > 0 ? "critical" : "subdued";
        return (
          <InboundAddedLineRow
            key={`history-${idx}-${h.inventoryItemId || idx}`}
            row={{ title: titleRaw, productTitle, variantTitle, imageUrl, inventoryItemId: h.inventoryItemId }}
            showImages={showImages}
            dialog={dialog}
            qty={received}
            modalKey={`history-${idx}`}
            skuLine={skuLine}
            bottomLeft={bottomLeft}
            bottomLeftTone={bottomLeftTone}
            onDec={null}
            onInc={null}
            onSetQty={null}
            onRemove={null}
          />
        );
      })}
    </s-stack>
  );
}

// ----- renderConfirmMemo_（確定時メモ） -----
export function renderConfirmMemo_({ extrasHistoryLoading, confirmMemo }) {
  if (extrasHistoryLoading || !confirmMemo) return null;
  return (
    <s-stack gap="small">
      <s-text emphasis="bold" size="small">確定時メモ</s-text>
      <s-text tone="subdued" size="small" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{confirmMemo}</s-text>
    </s-stack>
  );
}

// ----- renderInboundShipmentItems_ -----
export function renderInboundShipmentItems_({ rows, showImages, dialog, setRowQty, readOnly = false }) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return <s-text tone="subdued">lineItems がありません</s-text>;
  }
  return (
    <s-stack gap="none">
      {rows.map((r) => {
        const planned = Number(r?.plannedQty ?? 0);
        const received = Number(r?.receiveQty ?? 0);
        const sku = String(r?.sku || "").trim();
        const barcode = String(r?.barcode || "").trim();
        const skuLine = sku
          ? `SKU:${sku}${barcode ? ` / JAN:${barcode}` : ""}`
          : barcode
          ? `JAN:${barcode}`
          : "";
        const bottomLeft = `予定 ${planned} / 入庫 ${received}`;
        const hasDiff = planned !== received;
        const bottomLeftTone = hasDiff ? "critical" : "subdued";
        return (
          <InboundAddedLineRow
            key={r.key}
            row={r}
            showImages={showImages}
            dialog={dialog}
            qty={received}
            modalKey={r.key}
            skuLine={skuLine}
            bottomLeft={bottomLeft}
            bottomLeftTone={bottomLeftTone}
            onDec={() => setRowQty(r.key, Math.max(0, received - 1))}
            onInc={() => setRowQty(r.key, received + 1)}
            onSetQty={(n) => setRowQty(r.key, n)}
            readOnly={readOnly}
          />
        );
      })}
    </s-stack>
  );
}
