/* eslint-disable react/prop-types */
// Loss row geometry. Legacy props stay unchanged; modern uses supported 2026-07 props.
import { useEffect, useMemo, useState } from "preact/hooks";
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
  const parts = v.split("/").map((s) => s.trim()).filter(Boolean);
  return parts;
}

function formatOptionsLine_(options) {
  const ops = Array.isArray(options) ? options.filter(Boolean) : [];
  if (ops.length === 0) return "";
  return ops.join(" / ");
}

export function qtyValueWidthByDigits_(digits) {
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

export function StockyRowShell({ children }) {
  return (
    <s-box paddingInline="none" paddingBlockStart="small-100" paddingBlockEnd="small-200">
      {children}
    </s-box>
  );
}

export function ItemLeftCompact({ showImages, imageUrl, productTitle, variantTitle, line3, modern = false }) {
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
      {...(modern ? { color: subdued ? "subdued" : "base" } : { tone: subdued ? "subdued" : "auto", style: {
        display: "block",
        whiteSpace: "normal",
        overflow: "visible",
        wordBreak: "break-word",
      } })}
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
        <s-stack gap={modern ? "small-400" : "extra-tight"}>
          <Line strong>{pRaw}</Line>
          {optText ? <Line subdued>{optText}</Line> : null}
          {line3Text ? <Line subdued>{line3Text}</Line> : null}
        </s-stack>
      </s-box>
    </s-stack>
  );
}

export function QtyControlCompact_3Buttons({ value, min = 1, max = 999999, title = "数量", modalId, onDec, onInc, onSetQty, onRemove, disabled = false, modern = false, addMode = false, incrementId }) {
  const v = Number.isFinite(Number(value)) ? Number(value) : min;
  const id = useMemo(() => String(modalId), [modalId]);
  const [text, setText] = useState(String(v));

  useEffect(() => setText(String(v)), [v]);

  const clamp = (n) => Math.min(max, Math.max(min, Math.floor(Number(n || min))));
  const digits = String(v).length;
  const valueWidth = qtyValueWidthByDigits_(digits);

  if (modern) return <>
    <s-stack direction="inline" gap="small-400" alignItems="center" justifyContent="end">
      {onDec || onRemove ? <s-box inlineSize="44px"><s-button tone={onRemove && v <= min ? "critical" : "auto"} disabled={disabled || (!onRemove && v <= min)} onClick={() => onRemove && v <= min ? onRemove() : onDec?.()}>{onRemove && v <= min ? "×" : "−"}</s-button></s-box> : null}
      <s-box inlineSize={`${valueWidth}px`}><s-button disabled={disabled} command="--show" commandFor={id}>{v}</s-button></s-box>
      <s-box inlineSize="44px"><s-button disabled={disabled || (!addMode && v >= max)} id={incrementId} onClick={() => onInc?.()}>+</s-button></s-box>
    </s-stack>
    <s-modal id={id} heading={title}><s-box padding="base" paddingBlockEnd="none"><s-stack gap="base">
      <s-text type="small" color="subdued">数量を入力してください（{min}〜{max}）</s-text>
      <s-number-field disabled={disabled} label="数量" value={text} min={min} max={max} inputMode="numeric" onInput={event => setText(String(event.currentTarget.value))} onChange={event => setText(String(event.currentTarget.value))} />
      {onRemove ? <><s-divider /><s-box padding="none"><s-button disabled={disabled} tone="critical" command="--hide" commandFor={id} onClick={onRemove}>削除</s-button></s-box><s-divider /></> : null}
      <s-box padding="none"><s-button command="--hide" commandFor={id}>戻る</s-button></s-box>
    </s-stack></s-box><s-button disabled={disabled} slot="primary-action" variant="primary" command="--hide" commandFor={id} onClick={() => onSetQty?.(clamp(String(text).trim()))}>確定</s-button></s-modal>
  </>;
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
                disabled={disabled || (!isRemoveMode && v <= min)}
                style={{ width: "100%" }}
              >
                {isRemoveMode ? "×" : "−"}
              </s-button>
            );
          })()}
        </s-box>
        <s-box inlineSize={`${valueWidth}px`}>
          <s-button disabled={disabled} command="--show" commandFor={id} style={{ width: "100%" }}>
            {v}
          </s-button>
        </s-box>
        <s-box inlineSize="44px">
          <s-button onClick={() => onInc?.()} disabled={disabled || v >= max} style={{ width: "100%" }}>
            +
          </s-button>
        </s-box>
      </s-stack>

      <s-modal id={id} heading={title}>
        <s-box padding="base" paddingBlockEnd="none">
          <s-stack gap="base">
            <s-text type="small" tone="subdued">数量を入力してください（{min}〜{max}）</s-text>
            <s-text-field
              disabled={disabled}
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
                  <s-button disabled={disabled} tone="critical" command="--hide" commandFor={id} onClick={() => onRemove?.()}>
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
        <s-button disabled={disabled} slot="primary-action" tone="success" command="--hide" commandFor={id} onClick={() => onSetQty?.(clamp(String(text).trim()))}>
          確定
        </s-button>
        {/* ✅ slot="footer"は使用しない（削除ボタンはモーダル内に配置） */}
      </s-modal>
    </>
  );
}
