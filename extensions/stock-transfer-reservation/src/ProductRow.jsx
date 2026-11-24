/* eslint-disable react/prop-types */
import { useState } from "preact/hooks";
import { StockyRowShell, ItemLeftCompact, QtyControlCompact_3Buttons, qtyValueWidthByDigits_ } from "../../common/StockProductRowParts.jsx";
export function ReservationProductRow({ product, quantity = 0, candidate = false, images, disabled, onAdd, onSet, onRemove }) {
  const [text, setText] = useState("1");
  const id = `reservation-qty-${candidate ? "candidate" : "line"}-${String(product.id || product.variantId).replace(/[^a-zA-Z0-9]/g, "-")}`;
  const sku = String(product.sku || "").trim(), barcode = String(product.barcode || "").trim();
  const skuLine = `${sku ? `SKU: ${sku}` : ""}${barcode ? `${sku ? " / " : ""}JAN: ${barcode}` : ""}`.trim();
  const stockText = product.stockLoading ? "在庫: …" : `在庫: ${product.available ?? "—"}`;
  const locked = disabled || product.eligible === false;
  return <s-box padding="none"><StockyRowShell><s-stack gap="small-400" inlineSize="100%">
    <s-box inlineSize="100%"><ItemLeftCompact modern showImages={images} imageUrl={product.imageUrl || ""} productTitle={product.productTitle || product.displayName || product.title || "(unknown)"} variantTitle={product.variantTitle} line3={skuLine} /></s-box>
    <s-box inlineSize="100%"><s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
      <s-box minInlineSize="0"><s-text color="subdued" type="small">{stockText}</s-text></s-box>
      <s-box>{candidate ? <s-stack direction="inline" gap="small-400" alignItems="center" justifyContent="end">
        <s-box inlineSize={`${qtyValueWidthByDigits_(String(quantity).length)}px`}><s-button disabled={locked} command="--show" commandFor={id} onClick={() => setText(String(quantity > 0 ? quantity : 1))}>{quantity}</s-button></s-box>
        <s-box inlineSize="44px"><s-button disabled={locked || quantity >= 9999} onClick={() => onAdd(1)}>+</s-button></s-box>
      </s-stack> : <QtyControlCompact_3Buttons modern value={quantity} min={1} max={9999} modalId={id} disabled={locked} onDec={() => onSet(quantity - 1)} onInc={() => onSet(quantity + 1)} onSetQty={onSet} onRemove={onRemove} />}</s-box>
    </s-stack></s-box>
    {product.eligible === false ? <s-text type="small" color="subdued">この店舗では取置できません。</s-text> : null}
  </s-stack></StockyRowShell>
  {candidate ? <s-modal id={id} heading="数量を指定して追加"><s-box padding="base" paddingBlockEnd="none"><s-stack gap="base">
    <s-text color="subdued" type="small">数量を入力して「追加」を押してください（1〜9999）</s-text>
    <s-number-field min={1} max={9999} label="数量" value={text} inputMode="numeric" placeholder="例: 20" onInput={event => setText(String(event.currentTarget.value))} onChange={event => setText(String(event.currentTarget.value))} />
    <s-divider /><s-box><s-button command="--hide" commandFor={id}>戻る</s-button></s-box>
  </s-stack></s-box><s-button slot="primary-action" variant="primary" disabled={locked || !Number.isInteger(Number(text)) || Number(text) < 1 || Number(text) > 9999} command="--hide" commandFor={id} onClick={() => onAdd(Number(text))}>追加</s-button></s-modal> : null}
  <s-divider /></s-box>;
}
