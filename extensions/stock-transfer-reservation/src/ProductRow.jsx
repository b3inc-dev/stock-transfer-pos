/* eslint-disable react/prop-types */
import { useEffect, useState } from "preact/hooks";
export function ReservationProductRow({ product, quantity = 0, candidate = false, images, disabled, onAdd, onSet, onRemove }) {
  const [value, setValue] = useState(String(candidate ? 1 : quantity));
  useEffect(() => setValue(String(candidate ? 1 : quantity)), [candidate, quantity]);
  const id = `reservation-qty-${candidate ? "candidate" : "line"}-${String(product.id || product.variantId).replace(/[^a-zA-Z0-9]/g, "-")}`;
  const title = product.productTitle || product.displayName || product.title || "商品名を取得できません";
  const options = product.variantTitle && product.variantTitle !== "Default Title" && product.variantTitle !== title ? product.variantTitle : "";
  const image = /^https:\/\//.test(product.imageUrl || "") ? product.imageUrl : "";
  return <s-box padding="none"><s-stack gap="small" direction="block">
    <s-stack direction="inline" gap="base" alignItems="center">
      {images && image ? <s-box inlineSize="44px" blockSize="44px"><s-image src={image} inlineSize="fill" objectFit="cover" /></s-box> : null}
      <s-stack gap="none" direction="block"><s-text type="strong">{title}</s-text>{options ? <s-text>{options}</s-text> : null}<s-text type="small">{product.sku ? `SKU: ${product.sku}` : ""}{product.barcode ? ` / JAN: ${product.barcode}` : ""}</s-text></s-stack>
    </s-stack>
    <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
      <s-text>在庫: {product.available ?? "—"}</s-text>
      <s-stack direction="inline" gap="small">
        {!candidate ? <s-button disabled={disabled} tone={quantity <= 1 ? "critical" : undefined} onClick={() => quantity <= 1 ? onRemove() : onSet(quantity - 1)}>{quantity <= 1 ? "×" : "−"}</s-button> : null}
        <s-button disabled={disabled || product.eligible === false} command="--show" commandFor={id} onClick={() => setValue(String(candidate ? 1 : quantity))}>{quantity}</s-button>
        <s-button disabled={disabled || quantity >= 9999 || product.eligible === false} onClick={() => candidate ? onAdd(1) : onSet(quantity + 1)}>+</s-button>
      </s-stack>
    </s-stack>
    {product.eligible === false ? <s-text>この店舗では取置できません。</s-text> : null}
    <s-modal id={id} heading={candidate ? "数量を指定して追加" : "数量を変更"}>
      <s-box padding="base"><s-number-field label="数量（1〜9999）" min={1} max={9999} value={value} onInput={event => setValue(event.currentTarget.value)} /><s-button command="--hide" commandFor={id}>やめる</s-button></s-box>
      <s-button slot="primary-action" variant="primary" disabled={disabled || !Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > 9999} command="--hide" commandFor={id} onClick={() => candidate ? onAdd(Number(value)) : onSet(Number(value))}>{candidate ? "追加" : "変更"}</s-button>
    </s-modal>
  </s-stack><s-divider /></s-box>;
}
