/**
 * テンプレートに渡すデータ（Liquid の変数）の形と、プレビュー用の見本
 *
 * 名前は Shopify のレシートの Liquid と Ciara の精算メタフィールド（settlement.*）に寄せた。
 * 金額は数値（円）、日付は表示用に整えた文字で渡す（タイムゾーンの扱いを印字側でそろえるため）。
 * 印字の道（販売・精算・領収書・ギフト）からこの形に変える部分は、#22 が main に入ってから作る。
 */
import type { ReceiptKind } from "./receiptLayoutSchema";

export type NamedAmount = { label: string; amount: number };
export type TaxLine = { title: string; rate_label: string; amount: number };
export type KeyValue = { key: string; value: string };

export type ShopData = {
  name: string;
  currency: string;
  /** ストアのロゴ（Shopify のブランドの設定）。無ければ "" */
  logo_url: string;
};
export type LocationData = {
  name: string;
  zip: string;
  /**
   * 住所を 1 行ずつ。日本の住所は「都道府県＋市区町村＋番地」「建物」の順に、県名は日本語にして渡す
   * （Ciara の header.liquid と同じ。電話番号も +81 を 0 にして渡す）
   */
  address_lines: string[];
  phone: string;
};

export type OrderLineItem = {
  title: string;
  variant_title: string;
  sku: string;
  quantity: number;
  unit_price: number;
  line_total: number;
  /** 通常価格（セール前）。無ければ 0 */
  compare_at_price: number;
  discount: number;
  discount_label: string;
  properties: KeyValue[];
};

export type ShippingAddress = {
  zip: string;
  /** 住所を 1 行ずつ（会社名は company） */
  lines: string[];
  company: string;
  name: string;
  phone: string;
};

export type OrderData = {
  name: string;
  created_at_label: string;
  /** 注文日（店のタイムゾーン）"YYYY-MM-DD"。発送予定日の計算に使う */
  created_date: string;
  /** 配送先がある・配送グループがある注文 */
  is_shipping_order: boolean;
  shipping_address: ShippingAddress | null;
  /** 送料 */
  shipping: number;
  line_items: OrderLineItem[];
  subtotal: number;
  discounts: number;
  tax_lines: TaxLine[];
  total: number;
  payments: NamedAmount[];
  change: number;
  attributes: KeyValue[];
  note: string;
};

export type SettlementPayment = {
  label: string;
  net: number;
  count: number;
  refund: number;
  refund_count: number;
  /** まとめの行（電子マネー(合計) など） */
  is_group?: boolean;
};

export type SettlementData = {
  title: string;
  is_inspection: boolean;
  /** 「精算」か「点検」 */
  kind_label: string;
  period_label: string;
  location_label: string;
  as_of: string;
  total: number;
  net_sales: number;
  tax: number;
  discounts: number;
  vip_points_used: number;
  refund_total: number;
  voucher_change: number;
  /** 売上に含めない送料等。総売上 = 支払方法別の合計 − これ。無い日は 0 */
  non_sales_fee: number;
  order_count: number;
  refund_count: number;
  item_count: number;
  /** 合計額（返品含む）= total + refund_total（Ciara の gift-receipt.liquid と同じ） */
  total_including_returns: number;
  /** 納金額（現金の取引額 − 特例の返金 − 商品券釣り ＋ 事後調整）。計算は精算エンジン */
  cash_deposit: number;
  /** 表示する順に並べた支払方法（電子マネーの合計などの行も精算側で入れる） */
  payments: SettlementPayment[];
  /** 確定済みの日を確定し直した精算（再精算）なら true */
  is_resettlement?: boolean;
};

export type ReceiptData = {
  title: string;
  number: string;
  recipient: string;
  amount: number;
  proviso: string;
  issue_date: string;
  order_name: string;
  tax_lines: TaxLine[];
  payments: NamedAmount[];
};

type Common = {
  shop: ShopData;
  location: LocationData;
  staff: { name: string };
  printed_at: string;
  document: { title: string };
  /** 一度印刷したあとの印刷（再印字）なら true。印を出す設定かどうかには関係しない */
  is_reprint?: boolean;
  /** 紙に出す印（印字設定でオンにした分だけ。例: ["再精算", "再印字"]） */
  print_marks?: string[];
  /** 印を 1 行にした文（「再精算・再印字」）。出さないときは空 */
  print_mark_text?: string;
};

export type ReservationPrintData = { number: string; due_date: string; created_at_label: string; copy_label: string; intake_label?: string; items: { title: string; variant_title?: string; sku: string; barcode: string; quantity: number }[] };
export type OutboundRequestPrintData = { number: string; version: number; origin_name: string; destination_name: string; due_date: string; status_label: string; note: string; items: { title: string; variant_title: string; sku: string; barcode: string; requested: number; actual: number | null; reason: string }[] };
export type ReceiptTemplateData =
  | (Common & { kind: "outbound_request"; outbound_request: OutboundRequestPrintData })
  | (Common & { kind: "reservation"; reservation: ReservationPrintData })
  | (Common & { kind: "sales"; order: OrderData })
  | (Common & { kind: "gift"; order: OrderData })
  | (Common & { kind: "settlement"; settlement: SettlementData })
  | (Common & { kind: "receipt"; receipt: ReceiptData });

const SAMPLE_COMMON: Common = {
  shop: { name: "サンプルストア", currency: "JPY", logo_url: "" },
  location: {
    name: "サンプルストア 渋谷店",
    zip: "150-0001",
    address_lines: ["東京都渋谷区神宮前1-2-3", "サンプルビル 2F"],
    phone: "03-1234-5678",
  },
  staff: { name: "山田" },
  printed_at: "2026年11月22日 20:58",
  document: { title: "" },
  // 見本では印の位置が分かるよう「再印字」を出す（印のブロックを置いたときだけ見える）
  is_reprint: true,
  print_marks: ["再印字"],
  print_mark_text: "再印字",
};

const SAMPLE_ORDER: OrderData = {
  name: "#1042",
  created_at_label: "2026年11月22日 20:58",
  created_date: "2026-11-20",
  is_shipping_order: true,
  shipping_address: {
    zip: "530-0001",
    lines: ["大阪府大阪市北区梅田1-2-3", "梅田ハイツ 101"],
    company: "",
    name: "山田 花子",
    phone: "090-1234-5678",
  },
  shipping: 0,
  line_items: [
    {
      title: "シェルインナーシート",
      variant_title: "ShellBlue / iPhone15",
      sku: "SKU-0001-BL-15",
      quantity: 1,
      unit_price: 990,
      line_total: 990,
      compare_at_price: 0,
      discount: 0,
      discount_label: "",
      properties: [],
    },
    {
      title: "スマホケース",
      variant_title: "Clear / iPhone15",
      sku: "SKU-0002-CL-15",
      quantity: 2,
      unit_price: 2200,
      line_total: 3960,
      compare_at_price: 2750,
      discount: 440,
      discount_label: "セット割",
      properties: [{ key: "ギフト包装", value: "あり" }],
    },
  ],
  subtotal: 4950,
  // 商品ごとの割引は明細に出す。注文全体の割引はこの見本ではなし
  discounts: 0,
  tax_lines: [{ title: "消費税", rate_label: "10%", amount: 450 }],
  total: 4950,
  payments: [
    { label: "現金", amount: 5000 },
  ],
  change: 50,
  attributes: [{ key: "販売担当", value: "山田" }],
  note: "",
};

/** プレビューの見本のデータ（実際の注文ではない） */
export function sampleTemplateData(kind: ReceiptKind): ReceiptTemplateData {
  switch (kind) {
    case "outbound_request": return { ...SAMPLE_COMMON, kind, document: { title: "出庫依頼書" }, outbound_request: { number: "OR-0001", version: 1, origin_name: "サンプルストア 渋谷店", destination_name: "サンプルストア 横浜店", due_date: "2026-12-03", status_label: "作業中", note: "商品と数量を確認して出庫してください。", items: [{ title: "シェルインナーシート", variant_title: "ブルー / iPhone15", sku: "SAMPLE-001", barcode: "1234567890123", requested: 2, actual: 1, reason: "在庫不足" }] } };
    case "reservation": return { ...SAMPLE_COMMON, kind, document: { title: "取置控え" }, reservation: { number: "#R0001", due_date: "2026-12-02", created_at_label: "2026/11/25", copy_label: "お客様控え", items: [{ title: "サンプル商品", variant_title: "ブルー / M", sku: "SAMPLE-001", barcode: "1234567890123", quantity: 2 }] } };
    case "sales":
      return { ...SAMPLE_COMMON, kind, document: { title: `販売レシート ${SAMPLE_ORDER.name}` }, order: SAMPLE_ORDER };
    case "gift":
      return { ...SAMPLE_COMMON, kind, document: { title: "ギフトレシート" }, order: SAMPLE_ORDER };
    case "settlement":
      return {
        ...SAMPLE_COMMON,
        kind,
        document: { title: "精算レシート" },
        settlement: {
          title: "【精算レシート】",
          is_inspection: false,
          kind_label: "精算",
          period_label: "2026-11-22",
          location_label: "サンプルストア 渋谷店",
          as_of: "2026-11-22 21:05",
          total: 128400,
          net_sales: 116728,
          tax: 11672,
          discounts: 3200,
          vip_points_used: 500,
          refund_total: 4950,
          voucher_change: 0,
          non_sales_fee: 0,
          order_count: 42,
          refund_count: 1,
          item_count: 57,
          total_including_returns: 133350,
          cash_deposit: 45300,
          payments: [
            { label: "現金", net: 45300, count: 18, refund: 4950, refund_count: 1 },
            { label: "クレジットカード", net: 61200, count: 16, refund: 0, refund_count: 0 },
            { label: "電子マネー(QR)", net: 21900, count: 8, refund: 0, refund_count: 0 },
          ],
        },
      };
    case "receipt":
      return {
        ...SAMPLE_COMMON,
        kind,
        document: { title: "領収書" },
        receipt: {
          title: "領収書",
          number: "R-000123",
          recipient: "山田 太郎",
          amount: 4950,
          proviso: "お品代",
          issue_date: "2026年11月22日",
          order_name: "#1042",
          tax_lines: [{ title: "消費税", rate_label: "10%", amount: 450 }],
          payments: [{ label: "現金", amount: 4950 }],
        },
      };
  }
}
