import { useState, useEffect, useMemo } from "preact/hooks";
import { normalizeVariantOptions_, formatOptionsLine_ } from "./modalHelpers.js";

export function safeImageSrc_(maybeUrl) {
  const u = typeof maybeUrl === "string" ? maybeUrl.trim() : "";
  if (!u) return "";
  if (u.startsWith("//")) return `https:${u}`;
  if (u.startsWith("https://")) return u;
  if (u.startsWith("http://")) return "";
  return u;
}

export function Thumb({ imageUrl, sizePx = 44 }) {
  const src = safeImageSrc_(imageUrl);
  if (!src) return null;
  const n = Number(sizePx) || 44;
  const size = `${n}px`;
  return (
    <s-box inlineSize={size} blockSize={size}>
      <s-image
        src={src}
        alt=""
        inlineSize="fill"
        objectFit="cover"
      />
    </s-box>
  );
}

export function getDisplayImageUrl_(maybeUrl) {
  const u = typeof maybeUrl === "string" ? maybeUrl.trim() : "";
  return u;
}

export function clampInt_(v, min = 0, max = 999999) {
  const n = Number(String(v ?? "").trim());
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  return Math.max(min, Math.min(max, i));
}

export function sumQty_(lines, key = "qty") {
  return (Array.isArray(lines) ? lines : []).reduce((a, x) => a + Number(x?.[key] || 0), 0);
}

export function ListSummaryBar({ left, right }) {
  return (
    <s-stack
      direction="inline"
      gap="none"
      alignItems="center"
      justifyContent="space-between"
      style={{ width: "100%" }}
    >
      <s-box style={{ minWidth: 0, flex: "1 1 auto" }}>
        <s-text size="small" tone="subdued">
          {left}
        </s-text>
      </s-box>
      <s-box style={{ minWidth: 0, flex: "0 0 auto" }}>
        <s-text size="small" tone="subdued">
          {right}
        </s-text>
      </s-box>
    </s-stack>
  );
}

export function ItemLeftCompact({ showImages, imageUrl, productTitle, variantTitle, line3 }) {
  const pRaw = String(productTitle || "").trim() || "(unknown)";
  const vRaw = String(variantTitle || "").trim();
  const p = pRaw;
  const options = normalizeVariantOptions_(pRaw, vRaw);
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
          <Line strong>{p}</Line>
          {optText ? <Line subdued>{optText}</Line> : null}
          {line3Text ? <Line subdued>{line3Text}</Line> : null}
        </s-stack>
      </s-box>
    </s-stack>
  );
}

export function QtyControlCompact({
  value,
  min = 0,
  max = 999999,
  title = "数量",
  onChange,
  step = 1,
  modalId,
}) {
  const v = Number.isFinite(Number(value)) ? Number(value) : min;
  const id = useMemo(() => {
    if (modalId) return String(modalId);
    return `qty-modal-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }, [modalId]);

  const [text, setText] = useState(String(v));
  useEffect(() => {
    setText(String(v));
  }, [v]);

  const clamp = (n) => Math.min(max, Math.max(min, n));
  const commit = () => {
    const raw = String(text ?? "").trim();
    const n = clamp(Number(raw === "" ? min : raw));
    onChange?.(Number.isFinite(n) ? n : min);
  };

  const decDisabled = v <= min;
  const digits = String(v).length;
  const valueWidth =
    digits <= 2 ? 52 :
    digits === 3 ? 64 :
    digits === 4 ? 72 : 84;

  return (
    <>
      <s-stack
        direction="inline"
        gap="extra-tight"
        alignItems="center"
        justifyContent="end"
        style={{ flexWrap: "nowrap" }}
      >
        <s-box inlineSize="44px" style={{ flex: "0 0 auto" }}>
          <s-button
            onClick={() => onChange?.(clamp(v - step))}
            disabled={decDisabled}
            style={{ width: "100%" }}
          >
            -
          </s-button>
        </s-box>
        <s-box inlineSize={`${valueWidth}px`} style={{ flex: "0 0 auto" }}>
          <s-button
            command="--show"
            commandFor={id}
            onClick={() => setText(String(v))}
            style={{ width: "100%" }}
          >
            {v}
          </s-button>
        </s-box>
        <s-box inlineSize="44px" style={{ flex: "0 0 auto" }}>
          <s-button
            onClick={() => onChange?.(clamp(v + step))}
            style={{ width: "100%" }}
          >
            +
          </s-button>
        </s-box>
      </s-stack>
      <s-modal id={id} heading={title}>
        <s-box padding="base" paddingBlockEnd="none">
          <s-stack gap="base">
            <s-text tone="subdued" size="small">
              数量を入力してください（{min}〜{max}）
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
          onClick={commit}
        >
          OK
        </s-button>
      </s-modal>
    </>
  );
}

export function StockyRowShell({ children }) {
  return (
    <s-box
      paddingInline="none"
      paddingBlockStart="small-100"
      paddingBlockEnd="small-200"
    >
      {children}
    </s-box>
  );
}

export function ItemLeft(props) {
  const showImages = !!(props.showImages ?? props.showImage);
  const title =
    (typeof props.title === "string" && props.title.trim()) ||
    `${props.productTitle || ""}${props.variantTitle ? ` / ${props.variantTitle}` : ""}`.trim() ||
    props.sku ||
    props.inventoryItemId ||
    "(unknown)";
  const meta1 =
    (typeof props.meta1 === "string" && props.meta1) ||
    ((props.sku || props.barcode)
      ? `${props.sku ? `SKU: ${props.sku}` : ""}${props.sku && props.barcode ? " / " : ""}${props.barcode ? `barcode: ${props.barcode}` : ""}`
      : "");
  const meta2 =
    (typeof props.meta2 === "string" && props.meta2) ||
    (props.plannedQty != null || props.receivedQty != null
      ? `予定 ${props.plannedQty ?? 0} / 入庫 ${props.receivedQty ?? 0}`
      : "");

  return (
    <s-stack direction="inline" gap="base" alignItems="center" justifyContent="start">
      {showImages ? <Thumb imageUrl={props.imageUrl || ""} sizePx={56} /> : null}
      <s-stack gap="extra-tight">
        <s-text emphasis="bold">{title}</s-text>
        {meta1 ? <s-text tone="subdued" size="small">{meta1}</s-text> : null}
        {meta2 ? <s-text tone="subdued" size="small">{meta2}</s-text> : null}
      </s-stack>
    </s-stack>
  );
}

export function useDebounce(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
