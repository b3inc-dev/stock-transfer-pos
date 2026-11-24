/**
 * コード編集の画面に出す「使える値」の一覧（receiptLayoutData.ts の形と同じ）
 */
import type { ReceiptKind } from "./receiptLayoutSchema";

export type TemplateVariable = { name: string; label: string };

const COMMON: TemplateVariable[] = [
  { name: "paper.width_mm", label: "印字用紙の幅（58/80）。実印字は印字設定を使用" },
  { name: "paper.printable_width_mm", label: "印字領域の基準幅（48/72）。CSSのmm指定による紙上実寸は機種で異なる" },
  { name: "paper.fontSizePt", label: "この用紙の本文サイズ" },
  { name: "paper.amountFontSizePt", label: "この用紙の金額・件数サイズ" },
  { name: "paper.logoWidthMm", label: "ロゴ幅の保存基準値。割合は logoWidthMm × 100 ÷ printable_width_mm" },
  { name: "shop.name", label: "ストア名" },
  { name: "shop.logo_url", label: "ストアのロゴの URL" },
  { name: "location.name", label: "ロケーション名" },
  { name: "location.zip", label: "郵便番号" },
  { name: "location.address_lines", label: "住所（1 行ずつの一覧。for で回す）" },
  { name: "location.phone", label: "電話番号" },
  { name: "staff.name", label: "スタッフ" },
  { name: "printed_at", label: "印字した日時" },
  { name: "print_mark_text", label: "再印字・再精算の印（印字設定でオンにした分。無ければ空）" },
  { name: "print_marks", label: "再印字・再精算の印の一覧（for で回す）" },
  { name: "is_reprint", label: "一度印刷したあとの印刷なら true" },
];

const ORDER: TemplateVariable[] = [
  { name: "order.name", label: "注文番号" },
  { name: "order.created_at_label", label: "注文の日時" },
  { name: "order.line_items", label: "明細の一覧（title・variant_title・sku・quantity・unit_price・line_total・compare_at_price・discount・discount_label・properties）" },
  { name: "order.created_date", label: "注文日（YYYY-MM-DD）" },
];

export const TEMPLATE_VARIABLES: Record<ReceiptKind, TemplateVariable[]> = {
  reservation: [...COMMON,
    { name: "reservation.number", label: "取置番号" }, { name: "reservation.due_date", label: "受取期限" },
    { name: "reservation.created_at_label", label: "受付日" }, { name: "reservation.copy_label", label: "控えの用途" },
    { name: "reservation.items", label: "商品（title・sku・barcode・quantity）" },
  ],
  sales: [
    ...COMMON,
    ...ORDER,
    { name: "order.subtotal", label: "小計" },
    { name: "order.discounts", label: "割引" },
    { name: "order.tax_lines", label: "税の一覧（title・rate_label・amount）" },
    { name: "order.shipping", label: "送料" },
    { name: "order.is_shipping_order", label: "配送の注文なら true" },
    { name: "order.shipping_address", label: "配送先（zip・lines・company・name・phone）" },
    { name: "order.total", label: "合計" },
    { name: "order.payments", label: "支払方法の一覧（label・amount）" },
    { name: "order.change", label: "お釣り" },
    { name: "order.attributes", label: "注文の属性（key・value）" },
    { name: "order.note", label: "注文メモ" },
  ],
  gift: [...COMMON, ...ORDER],
  settlement: [
    ...COMMON,
    { name: "settlement.title", label: "表題（【精算レシート】／【点検レシート】）" },
    { name: "settlement.is_inspection", label: "点検なら true" },
    { name: "settlement.kind_label", label: "「精算」か「点検」" },
    { name: "settlement.period_label", label: "対象の日" },
    { name: "settlement.location_label", label: "ロケーション" },
    { name: "settlement.as_of", label: "集計した時刻" },
    { name: "settlement.total", label: "総売上" },
    { name: "settlement.net_sales", label: "純売上" },
    { name: "settlement.tax", label: "消費税" },
    { name: "settlement.discounts", label: "割引" },
    { name: "settlement.vip_points_used", label: "ポイント利用額" },
    { name: "settlement.refund_total", label: "返金" },
    { name: "settlement.voucher_change", label: "商品券釣有り差額" },
    { name: "settlement.non_sales_fee", label: "売上に含めない送料等（総売上 = 支払方法別の合計 − これ）" },
    { name: "settlement.order_count", label: "件数" },
    { name: "settlement.refund_count", label: "返金件数" },
    { name: "settlement.item_count", label: "点数" },
    { name: "settlement.total_including_returns", label: "合計額（返品含む）" },
    { name: "settlement.cash_deposit", label: "納金額" },
    { name: "settlement.payments", label: "支払方法別の一覧（label・net・count・refund・refund_count）" },
    { name: "settlement.is_resettlement", label: "確定し直した精算（再精算）なら true" },
  ],
  receipt: [
    ...COMMON,
    { name: "receipt.title", label: "表題" },
    { name: "receipt.number", label: "領収書番号" },
    { name: "receipt.recipient", label: "宛名" },
    { name: "receipt.amount", label: "金額" },
    { name: "receipt.proviso", label: "但し書き" },
    { name: "receipt.issue_date", label: "発行日" },
    { name: "receipt.order_name", label: "注文番号" },
    { name: "receipt.tax_lines", label: "税の一覧（title・rate_label・amount）" },
    { name: "receipt.payments", label: "支払方法の一覧（label・amount）" },
  ],
};

/** 変数の名前 → 一覧に出す短い名前（「表題（【精算レシート】…）」の括弧の中は省く） */
const VARIABLE_SHORT_LABELS: Record<string, string> = Object.fromEntries(
  Object.values(TEMPLATE_VARIABLES)
    .flat()
    .map((v) => [v.name, v.label.replace(/（.*$/, "").replace(/^「(.+)」か「(.+)」$/, "$1／$2")]),
);

/** ブロックの一覧では {{ shop.name }} などを「［ストア名］」のように読める形にする（印字は変えない） */
export function readableSummaryText(text: string): string {
  return text.replace(/\{\{-?\s*([\w.]+)[^}]*\}\}/g, (_, name: string) => `［${VARIABLE_SHORT_LABELS[name] ?? "値"}］`);
}
