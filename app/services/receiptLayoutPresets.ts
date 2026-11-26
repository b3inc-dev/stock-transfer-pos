/**
 * レイアウトのひな形
 *
 * - 標準: 一般の店向け。今の印字（printReceiptHtml.ts）と同じ項目・順番
 * - Ciara 風: Ciara が Shopify の「印刷用レシートのコード」で作っている見た目を、ブロックだけで作ったもの
 *   会社名・住所・登録番号などは店ごとの値なので空にしてある
 *   （T さんの liquid の全文 2026-11-22 から。精算は gift-receipt.liquid の精算の部分）
 */
import { defaultSettings, getBlockDef } from "./receiptLayoutBlocks";
import {
  DEFAULT_LAYOUT_STYLE,
  type BlockSettingValue,
  type LayoutBlock,
  type LayoutStyle,
  type ReceiptKind,
  type ReceiptLayout,
} from "./receiptLayoutSchema";

function block(id: string, type: string, settings: Record<string, BlockSettingValue> = {}, hidden = false): LayoutBlock {
  const def = getBlockDef(type);
  if (!def) throw new Error(`unknown block ${type}`);
  return { id, type, hidden, settings: { ...defaultSettings(def), ...settings } };
}

function layout(kind: ReceiptKind, blocks: LayoutBlock[], style: Partial<LayoutStyle> = {}): ReceiptLayout {
  return { version: 1, kind, mode: "blocks", paperWidthMm: 80, style: { ...DEFAULT_LAYOUT_STYLE, ...style }, blocks, code: "" };
}

const row = (id: string, field: string, label: string, extra: Record<string, BlockSettingValue> = {}) =>
  block(id, "settlement_row", { field, label, ...extra });

export const RESERVATION_FOOTER_TEXT = "商品・数量と受取期限をご確認ください。";

/** 標準のひな形（初めて開いたとき・保存が無いとき） */
export function defaultLayout(kind: ReceiptKind): ReceiptLayout {
  switch (kind) {
    case "outbound_request": return layout("outbound_request", [
      block("title", "heading", { text: "出庫依頼書", size: "l", bold: true, align: "center" }),
      block("meta", "outbound_request_info"), block("items", "outbound_request_items"),
      block("note", "text", { text: "{{ outbound_request.note }}", size: "s", align: "left" }),
    ], { fontSizePx: 14 });
    case "reservation":
      return layout("reservation", [
        block("title", "heading", { text: "取置控え", size: "m", bold: false, align: "center" }),
        block("store", "store_info"), block("items", "reservation_items"),
        block("footer", "text", { text: RESERVATION_FOOTER_TEXT, size: "s", align: "center" }),
        block("meta", "reservation_info"),
      ]);
    case "sales":
      return layout("sales", [
        block("title", "heading", { text: "{{ shop.name }}", size: "l" }),
        block("order", "order_info", { show_date: true, show_order_name: true }),
        block("store", "store_info", { show_name: true, name_bold: false, show_address: false, show_phone: false, size: "s" }),
        block("hr1", "divider", { style: "dashed" }),
        block("items", "line_items", { show_header: false, show_sku: false, quantity: "always" }),
        block("hr2", "divider", { style: "dashed" }),
        block("totals", "totals", { tax_label: "税", total_size: "l" }),
        block("hr3", "divider", { style: "dashed" }),
        block("payments", "payments"),
        block("attrs", "order_attributes", { heading: "注文属性" }, true),
        block("footer", "text", { text: "", size: "s" }),
      ]);
    case "gift":
      return layout("gift", [
        block("title", "heading", { text: "ギフトレシート", size: "l" }),
        block("store", "store_info", { show_address: false, show_phone: false, size: "s" }),
        block("order", "order_info", { show_date: false, show_order_name: true }),
        block("hr1", "divider", { style: "dashed" }),
        block("items", "gift_items"),
        block("hr2", "divider", { style: "dashed" }),
        block("footer", "text", { text: "", size: "s" }),
      ]);
    case "settlement":
      return layout("settlement", [
        block("title", "heading", { text: "{{ settlement.title }}", size: "l" }),
        block("meta", "settlement_meta"),
        block("hr1", "divider", { style: "dashed" }),
        row("total", "total", "総売上"),
        row("net", "net_sales", "純売上"),
        row("tax", "tax", "消費税"),
        row("disc", "discounts", "割引"),
        row("refund", "refund_total", "返金"),
        row("orders", "order_count", "件数", { unit: "件" }),
        row("items", "item_count", "点数", { unit: "点" }),
        row("voucher", "voucher_change", "商品券釣有り差額", { hide_zero: true }),
        row("fee", "non_sales_fee", "売上に含めない送料等", { hide_zero: true }),
        block("hr2", "divider", { style: "dashed" }),
        block("payments", "settlement_payments"),
      ]);
    case "receipt":
      return layout("receipt", [
        block("title", "heading", { text: "領　収　書", size: "l" }),
        block("issuer", "issuer"),
        block("hr1", "divider", { style: "dashed" }),
        block("recipient", "receipt_recipient"),
        block("amount", "receipt_amount", { size: "l", suffix: "", underline: "none" }),
        block("breakdown", "receipt_breakdown"),
        block("proviso", "receipt_proviso", { underline: "none" }),
        block("meta", "receipt_meta"),
      ]);
  }
}

// ── Ciara 風 ────────────────────────────────────────────
// T さんの sales-receipt.liquid・gift-receipt.liquid（header / footer / line-items / transactions を含む。2026-11-22）から。
// 会社名・住所・登録番号・ロゴの URL・お問い合わせの URL は店の値なので空にしてある（管理画面で入れる）。
// 文字の大きさは、Shopify の印字（本文 1.5rem・太さ 600・system-ui）と用紙に対する比が同じになるようにした。

const CIARA_STYLE: Partial<LayoutStyle> = { fontWeight: 600, fontSizePx: 22, lineHeight: 1.35, paddingPx: 16 };

/** 2026・2027 年の日本の祝日・休日（Ciara の sales-receipt.liquid と同じ一覧） */
export const JP_HOLIDAYS_2026_2027 = [
  "2026-01-01", "2026-01-12", "2026-02-11", "2026-02-23", "2026-03-20", "2026-04-29", "2026-05-03", "2026-05-04",
  "2026-05-05", "2026-05-06", "2026-07-20", "2026-08-11", "2026-09-21", "2026-09-22", "2026-09-23", "2026-10-12",
  "2026-11-03", "2026-11-23", "2027-01-01", "2027-01-11", "2027-02-11", "2027-02-23", "2027-03-21", "2027-03-22",
  "2027-04-29", "2027-05-03", "2027-05-04", "2027-05-05", "2027-07-19", "2027-08-11", "2027-09-20", "2027-09-23",
  "2027-10-11", "2027-11-03", "2027-11-23",
].join("\n");

function ciaraLogo(): LayoutBlock {
  return block("logo", "logo", { image_url: "", use_shop_logo: true, text: "{{ shop.name }}", width_percent: 60, bold: true, align: "center" });
}

export function ciaraSalesLayout(): ReceiptLayout {
  return layout(
    "sales",
    [
      ciaraLogo(),
      block("title", "heading", { text: "領収書", size: "m", bold: false }),
      block("store", "store_info", { name_bold: true, size: "m" }),
      block("items", "line_items", {
        header_left: "アイテム",
        header_right: "商品価格",
        header_line: "solid",
        title_bold: true,
        show_variant: true,
        show_sku: true,
        quantity: "multiple",
        quantity_parens: true,
        show_compare_at: true,
        show_discounts: true,
      }),
      block("hr1", "divider", { style: "dotted" }),
      block("totals", "totals", {
        subtotal_label: "小計",
        discount_label: "値引き合計",
        shipping_label: "送料",
        tax_label: "CT",
        tax_note: "商品価格に含まれています",
        total_label: "合計",
        total_size: "m",
        total_bold: true,
      }),
      block("hr2", "divider", { style: "thick" }),
      block("payments", "payments"),
      block("hr3", "divider", { style: "thick" }),
      block("shipping", "shipping_address"),
      block("order", "order_info", {
        show_date: true,
        show_staff: true,
        staff_label: "スタッフ：",
        show_order_name: true,
        order_label: "領収書: ",
        align: "center",
      }),
      block("registration", "text", { text: "", align: "center", size: "s" }),
      block("notice", "shipping_notice", {
        title: "土日祝を除く4〜7営業日後の発送予定",
        start_days: 4,
        end_days: 7,
        holidays: JP_HOLIDAYS_2026_2027,
        date_prefix: "発送予定日：",
        date_suffix: "頃",
        note: "※在庫状況等により、店舗スタッフより別途ご案内がある場合は、\n上記の発送予定と異なる場合がございます。\n発送はメールにてお知らせいたします。",
        contact_label: "お問い合わせはこちら",
        contact_url: "",
        show_url: true,
        qr_width_percent: 30,
      }),
    ],
    CIARA_STYLE,
  );
}

export function ciaraReceiptLayout(): ReceiptLayout {
  return layout(
    "receipt",
    [
      ciaraLogo(),
      block("title", "heading", { text: "領収書", size: "xl", bold: false, thin: true }),
      block("sp1", "spacer", { height: 72 }),
      block("recipient", "receipt_recipient", { suffix: "様", underline: "solid" }),
      block("amount", "receipt_amount", { suffix: "-", size: "xl", underline: "thick", padding: 28 }),
      block("breakdown", "receipt_breakdown", { tax_label: "消費税", separator: "：", align: "right" }),
      block("statement", "text", { text: "上記金額を正に領収いたしました。", align: "center", size: "m" }),
      block("sp2", "spacer", { height: 72 }),
      block("proviso", "receipt_proviso", { prefix: "但", suffix: "として", underline: "solid" }),
      block("stamp", "stamp_box", {
        label: "担当印",
        size: 140,
        align: "right",
        show_revenue_stamp: true,
        revenue_stamp_label: "収入印紙",
        revenue_stamp_from: 50000,
      }),
      block("hr1", "divider", { style: "thick" }),
      block("issuer", "issuer", { name: "", align: "center", bold: false }),
      block("meta", "receipt_meta", {
        show_date: true,
        date_label: "",
        show_number: true,
        number_label: "領収書:",
        show_order: false,
        style: "center",
      }),
      block("registration", "text", { text: "", align: "center" }),
    ],
    CIARA_STYLE,
  );
}

/** 精算・点検（gift-receipt.liquid の精算レシートの部分） */
export function ciaraSettlementLayout(): ReceiptLayout {
  const unit = { unit: "" };
  return layout(
    "settlement",
    [
      ciaraLogo(),
      block("title", "heading", { text: "{{ settlement.kind_label }}", size: "xl", bold: true }),
      block("asof", "text", { text: "{{ settlement.as_of }} 発行", align: "center", muted: true }),
      block("hr1", "divider", { style: "thick" }),
      block("meta", "settlement_meta", { show_period: false, show_location: true, location_label: "店舗", show_as_of: false }),
      row("total", "total", "合計額"),
      row("refund", "refund_total", "返金額"),
      row("net", "net_sales", "純売上"),
      row("tax", "tax", "消費税"),
      row("disc", "discounts", "値引額"),
      row("points", "vip_points_used", "ポイント利用"),
      row("orders", "order_count", "販売件数", unit),
      row("refunds", "refund_count", "返金件数", unit),
      row("items", "item_count", "販売点数", unit),
      row("with_returns", "total_including_returns", "合計額（返品含む）"),
      row("fee", "non_sales_fee", "売上に含めない送料等", { hide_zero: true }),
      block("hr2", "divider", { style: "thick" }),
      block("deposit", "settlement_deposit", { label: "納金額", voucher_label: "商品券釣り" }),
      block("payments", "settlement_payments", {
        heading: "",
        style: "detailed",
        count_unit: "",
        net_label: "\u2002取引額",
        refund_amount_label: "\u2002返金額",
        count_label: "\u2002取引件数",
        refund_count_label: "\u2002返金件数",
      }),
      block("hr3", "divider", { style: "thick" }),
    ],
    CIARA_STYLE,
  );
}

export type LayoutPreset = { id: string; label: string; kinds: ReceiptKind[]; build: (kind: ReceiptKind) => ReceiptLayout };

export const LAYOUT_PRESETS: LayoutPreset[] = [
  { id: "standard", label: "標準", kinds: ["settlement", "sales", "gift", "receipt", "reservation", "outbound_request"], build: defaultLayout },
  { id: "ciara-sales", label: "Ciara 風", kinds: ["sales"], build: () => ciaraSalesLayout() },
  { id: "ciara-receipt", label: "Ciara 風", kinds: ["receipt"], build: () => ciaraReceiptLayout() },
  { id: "ciara-settlement", label: "Ciara 風", kinds: ["settlement"], build: () => ciaraSettlementLayout() },
];

export function presetsForKind(kind: ReceiptKind): LayoutPreset[] {
  return LAYOUT_PRESETS.filter((p) => p.kinds.includes(kind));
}
