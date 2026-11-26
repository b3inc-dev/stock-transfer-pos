import type { ReactNode } from "react";
import { SectionTabs } from "./admin-ui";
export type ProductAddMethod = "search" | "collection" | "csv";
/** 仕入と出庫依頼で共用する商品追加の入口。 */
export function ProductAddMethodTabs({ value, onChange, disabled = false }: { value: ProductAddMethod; onChange: (value: ProductAddMethod) => void; disabled?: boolean }) {
  return <SectionTabs label="商品の追加方法" selected={value} disabled={disabled} onSelect={value => onChange(value as ProductAddMethod)} items={[{ key: "search", label: "商品検索" }, { key: "collection", label: "コレクション検索" }, { key: "csv", label: "CSVアップロード" }]} />;
}
/** 仕入のCSVプレビューから抽出。行クリック・キーボード・チェックボックスを同じ操作にする。 */
export function ProductCandidateRow({ title, sku, selected, disabled = false, added = false, quantity, onToggle, children }: { title: string; sku?: string; selected: boolean; disabled?: boolean; added?: boolean; quantity: number | string; onToggle: () => void; children?: ReactNode }) {
  const blocked = disabled || added;
  return <div role="button" tabIndex={blocked ? -1 : 0} aria-pressed={selected} aria-disabled={blocked} onClick={() => { if (!blocked) onToggle(); }} onKeyDown={event => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); if (!blocked) onToggle(); } }} style={{ padding: "10px 12px", borderRadius: 6, cursor: blocked ? "default" : "pointer", backgroundColor: selected ? "#eff6ff" : "transparent", border: selected ? "1px solid #2563eb" : "1px solid transparent", borderBottom: selected ? undefined : "1px solid #e5e7eb", display: "flex", alignItems: "center", gap: 8, opacity: disabled ? 0.6 : 1, minWidth: 0 }}>
    <input type="checkbox" aria-label={title + "を選択"} checked={selected} disabled={blocked} onClick={event => event.stopPropagation()} onChange={() => { if (!blocked) onToggle(); }} style={{ width: 16, height: 16, flexShrink: 0 }} />
    <div style={{ flex: "1 1 auto", minWidth: 0, overflowWrap: "anywhere" }}><span style={{ fontWeight: selected ? 600 : 500, display: "block" }}>{title || "(商品名なし)"}</span>{sku ? <span style={{ fontSize: 12, color: "#6d7175", display: "block" }}>SKU：{sku}</span> : null}{added ? <span className="Admin-note">追加済み</span> : null}</div>
    <div role="presentation" onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} style={{ flexShrink: 0 }}>{children || <span style={{ fontSize: 13 }}>× {quantity}</span>}</div>
  </div>;
}
export function ProductCandidateList({ children }: { children: ReactNode }) {
  return <div style={{ maxHeight: 280, overflowY: "auto", border: "1px solid #e1e3e5", borderRadius: 8, padding: 6 }}>{children}</div>;
}
export function downloadProductCsvTemplate(filename: string) {
  const url = URL.createObjectURL(new Blob(["\uFEFFSKU,数量\r\n"], { type: "text/csv;charset=utf-8;" }));
  const link = document.createElement("a"); link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url);
}
