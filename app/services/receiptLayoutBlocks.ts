/**
 * レシートのブロック一覧（ブロックエディタの部品）
 *
 * 各ブロックは「設定の欄」と「Liquid の断片」を持つ。
 * 断片は設定を s_<key> という変数で読む（receiptLayoutRender.ts の blocksToCode が値を渡す）。
 * 文言の欄には {{ order.name }} のような差し込みが書ける（{% %} のタグは書けない）。
 * 文言の欄の値はレンダラが HTML エスケープ済みにするので、断片では `| raw` で出す。
 */
import type { BlockSettingValue, ReceiptKind } from "./receiptLayoutSchema";

export type SettingOption = { value: string; label: string };

export type SettingDef =
  | { key: string; label: string; type: "text"; default: string; help?: string; placeholder?: string }
  | { key: string; label: string; type: "textarea"; default: string; help?: string }
  | { key: string; label: string; type: "url"; default: string; help?: string }
  | { key: string; label: string; type: "checkbox"; default: boolean; help?: string }
  | { key: string; label: string; type: "select"; default: string; options: SettingOption[]; help?: string }
  | { key: string; label: string; type: "number"; default: number; min: number; max: number; unit?: string; help?: string };

export type BlockDef = {
  type: string;
  label: string;
  /** ブロックを追加するときの説明（1 文） */
  description: string;
  kinds: readonly ReceiptKind[];
  settings: SettingDef[];
  /** Liquid の断片。設定は s_<key> で読む */
  template: string;
  /** 設定から決まる値（例: 精算の行の金額／件数の書き方）。s_<key> として断片に渡す */
  derived?: (settings: Record<string, BlockSettingValue>) => Record<string, BlockSettingValue>;
  /** 一覧の中で見出しにする設定（例: 見出しの文言） */
  summaryKey?: string;
};

const ALL: readonly ReceiptKind[] = ["settlement", "sales", "gift", "receipt", "reservation"];

const ALIGN: SettingOption[] = [
  { value: "left", label: "左" },
  { value: "center", label: "中央" },
  { value: "right", label: "右" },
];
const SIZE: SettingOption[] = [
  { value: "s", label: "小" },
  { value: "m", label: "標準" },
  { value: "l", label: "大" },
  { value: "xl", label: "特大" },
];
const LINE: SettingOption[] = [
  { value: "none", label: "なし" },
  { value: "solid", label: "細線" },
  { value: "thick", label: "太線" },
  { value: "dashed", label: "破線" },
  { value: "dotted", label: "点線" },
];

const align = (d = "center"): SettingDef => ({ key: "align", label: "そろえ", type: "select", default: d, options: ALIGN });
const size = (d = "m", key = "size", label = "文字の大きさ"): SettingDef => ({ key, label, type: "select", default: d, options: SIZE });
const line = (key: string, label: string, d: string): SettingDef => ({ key, label, type: "select", default: d, options: LINE });

/** 精算の行に出せる値（Ciara の精算注文メタフィールド settlement.* と同じ名前） */
export const SETTLEMENT_FIELDS: { value: string; label: string; format: "money" | "count" }[] = [
  { value: "total", label: "総売上", format: "money" },
  { value: "net_sales", label: "純売上", format: "money" },
  { value: "tax", label: "消費税", format: "money" },
  { value: "discounts", label: "割引", format: "money" },
  { value: "vip_points_used", label: "ポイント利用額", format: "money" },
  { value: "refund_total", label: "返金", format: "money" },
  { value: "voucher_change", label: "商品券釣有り差額", format: "money" },
  { value: "non_sales_fee", label: "売上に含めない送料等", format: "money" },
  { value: "total_including_returns", label: "合計額（返品含む）", format: "money" },
  { value: "cash_deposit", label: "納金額", format: "money" },
  { value: "order_count", label: "件数", format: "count" },
  { value: "refund_count", label: "返金件数", format: "count" },
  { value: "item_count", label: "点数", format: "count" },
];

export const BLOCK_DEFS: BlockDef[] = [
  { type: "reservation_info", label: "取置番号・受取期限", description: "下部の固定欄に取置番号と受取期限を印字します。並び順は変わりません。", kinds: ["reservation"], settings: [
    { key: "show_date", label: "受付日", type: "checkbox", default: true },
    { key: "show_staff", label: "担当番号", type: "checkbox", default: true },
  ], template: `<div class="blk"><div class="b">{{ reservation.copy_label }}</div><div class="b">取置番号 {{ reservation.number }}</div><div class="b">受取期限 {{ reservation.due_date }}</div>{% if s_show_date %}<div>受付 {{ reservation.created_at_label }}</div>{% endif %}{% if s_show_staff %}<div>担当 {{ staff.name }}</div>{% endif %}</div>` },
  { type: "reservation_items", label: "取置商品・数量", description: "商品名・数量を印字します。SKU・JANの表示を選べます。", kinds: ["reservation"], settings: [
    { key: "show_sku", label: "SKU", type: "checkbox", default: true },
    { key: "show_barcode", label: "JAN", type: "checkbox", default: false },
  ], template: `<div class="blk">{% for item in reservation.items %}<div class="row"><span>{{ item.title }}{% if s_show_sku and item.sku != blank %}<br>SKU: {{ item.sku }}{% endif %}{% if s_show_barcode and item.barcode != blank %}<br>JAN: {{ item.barcode }}{% endif %}</span><span>{{ item.quantity }}点</span></div>{% endfor %}</div>` },
  // ── どのレシートにも使える ──────────────────────────────
  {
    type: "logo",
    label: "ロゴ",
    description: "画像の URL か、店名などの文字を大きく出します。",
    kinds: ALL,
    settings: [
      { key: "image_url", label: "画像の URL", type: "url", default: "", help: "https:// で始まる画像（Shopify の「ファイル」の URL など）。" },
      { key: "use_shop_logo", label: "画像の URL が空なら、ストアのロゴを使う", type: "checkbox", default: false, help: "Shopify の「ブランド」に入れたロゴです。どちらも無いときは下の文字を出します。" },
      { key: "text", label: "画像がないときの文字", type: "text", default: "{{ shop.name }}" },
      { key: "width_percent", label: "画像の幅", type: "number", default: 50, min: 10, max: 100, unit: "%" },
      { key: "bold", label: "文字を太字", type: "checkbox", default: true },
      align(),
    ],
    template:
      `<div class="blk a-{{ s_align }}">{% if s_image_url != blank %}<img class="logo" src="{{ s_image_url | raw }}" alt="" style="width:{{ s_width_percent }}%"/>{% elsif s_use_shop_logo and shop.logo_url != blank %}<img class="logo" src="{{ shop.logo_url }}" alt="" style="width:{{ s_width_percent }}%"/>{% else %}<div class="logo-text fs-xl{% if s_bold %} b{% endif %}">{{ s_text | raw }}</div>{% endif %}</div>`,
  },
  {
    type: "heading",
    label: "見出し",
    description: "「領収書」「精算レシート」などの表題です。",
    kinds: ALL,
    settings: [
      { key: "text", label: "文言", type: "text", default: "見出し" },
      size("l"),
      { key: "bold", label: "太字", type: "checkbox", default: true },
      { key: "thin", label: "細字（太字を外したとき）", type: "checkbox", default: false },
      align(),
    ],
    template: `<div class="blk a-{{ s_align }} fs-{{ s_size }}{% if s_bold %} b{% endif %}{% if s_thin %} thin{% endif %}">{{ s_text | raw }}</div>`,
    summaryKey: "text",
  },
  {
    type: "print_marks",
    label: "再印字・再精算の印",
    description: "印刷し直したときの「再印字」、確定し直した精算の「再精算」をここに出します。出すかどうかと文言は印字設定で決めます。",
    kinds: ["settlement", "sales", "gift"],
    settings: [
      size("l"),
      { key: "bold", label: "太字", type: "checkbox", default: true },
      { key: "boxed", label: "四角で囲む", type: "checkbox", default: true },
      align(),
    ],
    template:
      `{% if print_mark_text != blank %}<div class="blk a-{{ s_align }}"><span class="fs-{{ s_size }}{% if s_bold %} b{% endif %}"{% if s_boxed %} style="display:inline-block;border:2px solid #000;padding:2px 10px"{% endif %}>{{ print_mark_text }}</span></div>{% endif %}`,
  },
  {
    type: "text",
    label: "文章",
    description: "自由な文章です。{{ order.name }} のような差し込みも使えます。",
    kinds: ALL,
    settings: [
      { key: "text", label: "文章", type: "textarea", default: "" },
      size("m"),
      { key: "bold", label: "太字", type: "checkbox", default: false },
      { key: "muted", label: "少し薄く", type: "checkbox", default: false },
      align(),
    ],
    template: `{% if s_text != blank %}<div class="blk a-{{ s_align }} fs-{{ s_size }}{% if s_bold %} b{% endif %}{% if s_muted %} muted{% endif %}">{{ s_text | raw }}</div>{% endif %}`,
    summaryKey: "text",
  },
  {
    type: "store_info",
    label: "店舗の情報",
    description: "ロケーションの名前・住所・電話番号です。",
    kinds: ALL,
    settings: [
      { key: "show_name", label: "店舗名を出す", type: "checkbox", default: true },
      { key: "name_bold", label: "店舗名を太字", type: "checkbox", default: true },
      { key: "show_address", label: "住所を出す", type: "checkbox", default: true },
      { key: "show_phone", label: "電話番号を出す", type: "checkbox", default: true },
      size("m"),
      align(),
    ],
    template:
      `<div class="blk a-{{ s_align }} fs-{{ s_size }}">{% if s_show_name and location.name != blank %}<div{% if s_name_bold %} class="b"{% endif %}>{{ location.name }}</div>{% endif %}{% if s_show_address %}{% if location.zip != blank %}<div>{{ location.zip }}</div>{% endif %}{% for line in location.address_lines %}<div>{{ line }}</div>{% endfor %}{% endif %}{% if s_show_phone and location.phone != blank %}<div>{{ location.phone }}</div>{% endif %}</div>`,
  },
  {
    type: "divider",
    label: "区切り線",
    description: "線で区切ります。",
    kinds: ALL,
    settings: [line("style", "線の種類", "dashed")],
    template: `<hr class="hr hr-{{ s_style }}"/>`,
  },
  {
    type: "spacer",
    label: "余白",
    description: "上下に空きを入れます。",
    kinds: ALL,
    settings: [{ key: "height", label: "高さ", type: "number", default: 12, min: 2, max: 120, unit: "px" }],
    template: `<div style="height:{{ s_height }}px"></div>`,
  },

  // ── 販売・ギフト ──────────────────────────────────────
  {
    type: "order_info",
    label: "注文の情報",
    description: "日時・注文番号・スタッフです。",
    kinds: ["sales", "gift"],
    settings: [
      { key: "show_date", label: "日時を出す", type: "checkbox", default: true },
      { key: "date_label", label: "日時の前の文字", type: "text", default: "" },
      { key: "show_order_name", label: "注文番号を出す", type: "checkbox", default: true },
      { key: "order_label", label: "注文番号の前の文字", type: "text", default: "" },
      { key: "show_staff", label: "スタッフを出す", type: "checkbox", default: false },
      { key: "staff_label", label: "スタッフの前の文字", type: "text", default: "スタッフ：" },
      { key: "bold", label: "太字", type: "checkbox", default: false },
      align(),
    ],
    template:
      `<div class="blk a-{{ s_align }}{% if s_bold %} b{% endif %}">{% if s_show_date %}<div>{{ s_date_label | raw }}{{ order.created_at_label }}</div>{% endif %}{% if s_show_staff and staff.name != blank %}<div>{{ s_staff_label | raw }}{{ staff.name }}</div>{% endif %}{% if s_show_order_name %}<div>{{ s_order_label | raw }}{{ order.name }}</div>{% endif %}</div>`,
  },
  {
    type: "line_items",
    label: "商品の明細",
    description: "商品名・バリエーション・SKU・金額です。",
    kinds: ["sales"],
    settings: [
      { key: "show_header", label: "明細の見出しを出す", type: "checkbox", default: true },
      { key: "header_left", label: "見出し（左）", type: "text", default: "アイテム" },
      { key: "header_right", label: "見出し（右）", type: "text", default: "商品価格" },
      line("header_line", "見出しの下の線", "solid"),
      { key: "title_bold", label: "商品名を太字", type: "checkbox", default: true },
      { key: "show_variant", label: "バリエーションを出す", type: "checkbox", default: true },
      { key: "show_sku", label: "SKU を出す", type: "checkbox", default: false },
      {
        key: "quantity",
        label: "数量と単価",
        type: "select",
        default: "always",
        options: [
          { value: "always", label: "いつも出す" },
          { value: "multiple", label: "2 個以上のときだけ" },
          { value: "never", label: "出さない" },
        ],
      },
      { key: "quantity_parens", label: "数量と単価をかっこで囲む", type: "checkbox", default: false },
      { key: "show_compare_at", label: "通常価格（セール前）を出す", type: "checkbox", default: false },
      { key: "compare_at_label", label: "通常価格の前の文字", type: "text", default: "通常価格" },
      { key: "show_properties", label: "商品のプロパティ（属性）を出す", type: "checkbox", default: false },
      { key: "show_discounts", label: "商品ごとの割引を出す", type: "checkbox", default: true },
    ],
    template:
      `<div class="blk">{% if s_show_header %}<div class="row b ul-{{ s_header_line }}"><span>{{ s_header_left | raw }}</span><span>{{ s_header_right | raw }}</span></div>{% endif %}{% for item in order.line_items %}<div class="item"><div class="row"><span{% if s_title_bold %} class="b"{% endif %}>{{ item.title }}</span><span class="print-value{% if s_title_bold %} b{% endif %}">{{ item.line_total | money }}</span></div>{% if s_show_variant and item.variant_title != blank %}<div>{{ item.variant_title }}</div>{% endif %}{% if s_show_sku and item.sku != blank %}<div>{{ item.sku }}</div>{% endif %}{% if s_quantity == "always" or s_quantity == "multiple" and item.quantity > 1 %}<div class="print-value">{% if s_quantity_parens %}({% endif %}{{ item.quantity }} x {{ item.unit_price | money }}{% if s_quantity_parens %}){% endif %}</div>{% endif %}{% if s_show_compare_at and item.compare_at_price > 0 %}<div class="row muted"><span>{{ s_compare_at_label | raw }}</span><span class="print-value strike">{{ item.compare_at_price | money }}</span></div>{% endif %}{% if s_show_discounts and item.discount > 0 %}<div class="row"><span>{{ item.discount_label }}</span><span class="print-value">-{{ item.discount | money }}</span></div>{% endif %}{% if s_show_properties %}{% for p in item.properties %}<div class="indent fs-s">{{ p.key }}: {{ p.value }}</div>{% endfor %}{% endif %}</div>{% endfor %}</div>`,
  },
  {
    type: "totals",
    label: "小計・税・合計",
    description: "小計・割引・消費税・合計です。",
    kinds: ["sales"],
    settings: [
      { key: "show_subtotal", label: "小計を出す", type: "checkbox", default: true },
      { key: "subtotal_label", label: "小計の名前", type: "text", default: "小計" },
      { key: "show_discounts", label: "割引を出す（あるときだけ）", type: "checkbox", default: true },
      { key: "discount_label", label: "割引の名前", type: "text", default: "割引" },
      { key: "show_shipping", label: "送料を出す（配送の注文だけ）", type: "checkbox", default: true },
      { key: "shipping_label", label: "送料の名前", type: "text", default: "送料" },
      { key: "show_tax", label: "消費税を出す", type: "checkbox", default: true },
      { key: "tax_label", label: "消費税の名前", type: "text", default: "消費税" },
      { key: "tax_note", label: "消費税の下の文", type: "text", default: "", placeholder: "商品価格に含まれています" },
      { key: "total_label", label: "合計の名前", type: "text", default: "合計" },
      size("m", "total_size", "合計の文字の大きさ"),
      { key: "total_bold", label: "合計を太字", type: "checkbox", default: true },
    ],
    template:
      `<div class="blk">{% if s_show_subtotal %}<div class="row"><span>{{ s_subtotal_label | raw }}</span><span class="print-value">{{ order.subtotal | money }}</span></div>{% endif %}{% if s_show_discounts and order.discounts > 0 %}<div class="row"><span>{{ s_discount_label | raw }}</span><span class="print-value">-{{ order.discounts | money }}</span></div>{% endif %}{% if s_show_shipping and order.is_shipping_order %}<div class="row"><span>{{ s_shipping_label | raw }}</span><span class="print-value">{{ order.shipping | money }}</span></div>{% endif %}{% if s_show_tax %}{% for t in order.tax_lines %}<div class="row"><span>{{ s_tax_label | raw }} ({{ t.rate_label }}){% if s_tax_note != blank %}<br/>{{ s_tax_note | raw }}{% endif %}</span><span class="print-value">{{ t.amount | money }}</span></div>{% endfor %}{% endif %}<div class="row fs-{{ s_total_size }}{% if s_total_bold %} b{% endif %}"><span>{{ s_total_label | raw }}</span><span class="print-value print-total">{{ order.total | money }}</span></div></div>`,
  },
  {
    type: "payments",
    label: "支払方法",
    description: "支払方法ごとの金額とお釣りです。",
    kinds: ["sales"],
    settings: [
      { key: "bold", label: "太字", type: "checkbox", default: false },
      { key: "show_change", label: "お釣りを出す（あるときだけ）", type: "checkbox", default: true },
      { key: "change_label", label: "お釣りの名前", type: "text", default: "お釣り" },
    ],
    template:
      `<div class="blk{% if s_bold %} b{% endif %}">{% for p in order.payments %}<div class="row"><span>{{ p.label }}</span><span class="print-value">{{ p.amount | money }}</span></div>{% endfor %}{% if s_show_change and order.change > 0 %}<div class="row"><span>{{ s_change_label | raw }}</span><span class="print-value">{{ order.change | money }}</span></div>{% endif %}</div>`,
  },
  {
    type: "order_attributes",
    label: "注文の属性",
    description: "注文に付いたメモ・属性です（あるときだけ）。",
    kinds: ["sales"],
    settings: [
      { key: "heading", label: "見出し", type: "text", default: "" },
      { key: "show_note", label: "注文メモも出す", type: "checkbox", default: false },
    ],
    template:
      `{% if order.attributes.size > 0 or s_show_note and order.note != blank %}<div class="blk fs-s">{% if s_heading != blank %}<div class="b">{{ s_heading | raw }}</div>{% endif %}{% for a in order.attributes %}<div>{{ a.key }}: {{ a.value }}</div>{% endfor %}{% if s_show_note and order.note != blank %}<div>{{ order.note }}</div>{% endif %}</div>{% endif %}`,
  },
  {
    type: "shipping_address",
    label: "配送先",
    description: "配送の注文のときだけ、配送先の住所・名前・電話番号を出します。",
    kinds: ["sales"],
    settings: [
      { key: "heading", label: "見出し", type: "text", default: "配送先：" },
      { key: "zip_prefix", label: "郵便番号の前の文字", type: "text", default: "〒" },
      { key: "name_suffix", label: "名前のあとの文字", type: "text", default: " 様" },
      { key: "phone_prefix", label: "電話番号の前の文字", type: "text", default: "TEL：" },
      align("left"),
    ],
    template:
      `{% assign s__a = order.shipping_address %}{% if s__a and s__a.lines.size > 0 %}<div class="blk lines a-{{ s_align }}">{% if s_heading != blank %}<div class="b">{{ s_heading | raw }}</div>{% endif %}{% if s__a.zip != blank %}<div>{{ s_zip_prefix | raw }}{{ s__a.zip }}</div>{% endif %}{% for line in s__a.lines %}<div>{{ line }}</div>{% endfor %}{% if s__a.company != blank %}<div>{{ s__a.company }}</div>{% endif %}{% if s__a.name != blank %}<div>{{ s__a.name }}{{ s_name_suffix | raw }}</div>{% endif %}{% if s__a.phone != blank %}<div>{{ s_phone_prefix | raw }}{{ s__a.phone }}</div>{% endif %}</div>{% endif %}`,
  },
  {
    type: "shipping_notice",
    label: "発送予定とお問い合わせ",
    description: "配送の注文のときだけ、土日と休みの日を除いた発送予定日と、お問い合わせの QR コードを出します。",
    kinds: ["sales"],
    settings: [
      { key: "title", label: "見出し", type: "text", default: "土日祝を除く4〜7営業日後の発送予定" },
      { key: "start_days", label: "何営業日後から", type: "number", default: 4, min: 1, max: 60, unit: "営業日" },
      { key: "end_days", label: "何営業日後まで", type: "number", default: 7, min: 1, max: 60, unit: "営業日" },
      { key: "holidays", label: "休みの日（土日のほか）", type: "textarea", default: "", help: "2026-01-01 の形で、改行か , で区切ります。" },
      { key: "date_prefix", label: "日付の前の文字", type: "text", default: "発送予定日：" },
      { key: "date_suffix", label: "日付のあとの文字", type: "text", default: "頃" },
      { key: "note", label: "注意書き", type: "textarea", default: "" },
      { key: "contact_label", label: "お問い合わせの文", type: "text", default: "お問い合わせはこちら" },
      { key: "contact_url", label: "お問い合わせの URL（QR コードにします）", type: "url", default: "" },
      { key: "show_url", label: "URL も文字で出す", type: "checkbox", default: true },
      { key: "qr_width_percent", label: "QR コードの幅", type: "number", default: 30, min: 10, max: 100, unit: "%" },
    ],
    template:
      `{% if order.is_shipping_order %}<div class="blk a-center b"><hr class="hr hr-dashed"/>{% if s_title != blank %}<div class="fs-l">{{ s_title | raw }}</div>{% endif %}{% assign s__from = order.created_date | business_day_label: s_start_days, s_holidays %}{% assign s__to = order.created_date | business_day_label: s_end_days, s_holidays %}{% if s__from != blank and s__to != blank %}<div class="fs-s">{{ s_date_prefix | raw }}{{ s__from }}〜{{ s__to }}{{ s_date_suffix | raw }}</div>{% endif %}{% if s_note != blank %}<div class="fs-s muted">{{ s_note | raw }}</div>{% endif %}{% if s_contact_url != blank %}<div class="fs-s">{{ s_contact_label | raw }}</div><div class="qr" style="width:{{ s_qr_width_percent }}%">{{ s_contact_url | qrcode | raw }}</div>{% if s_show_url %}<div class="fs-s">{{ s_contact_url | raw }}</div>{% endif %}{% endif %}</div>{% endif %}`,
  },
  {
    type: "gift_items",
    label: "ギフトの明細",
    description: "商品名と数量だけを出します（金額は出しません）。",
    kinds: ["gift"],
    settings: [
      { key: "title_bold", label: "商品名を太字", type: "checkbox", default: true },
      { key: "show_variant", label: "バリエーションを出す", type: "checkbox", default: true },
      { key: "show_quantity", label: "数量を出す", type: "checkbox", default: true },
    ],
    template:
      `<div class="blk">{% for item in order.line_items %}<div class="item"><div class="row"><span{% if s_title_bold %} class="b"{% endif %}>{{ item.title }}</span>{% if s_show_quantity %}<span class="print-value">×{{ item.quantity }}</span>{% endif %}</div>{% if s_show_variant and item.variant_title != blank %}<div>{{ item.variant_title }}</div>{% endif %}</div>{% endfor %}</div>`,
  },

  // ── 精算・点検 ─────────────────────────────────────────
  {
    type: "settlement_meta",
    label: "精算の対象",
    description: "対象の日・ロケーション・集計した時刻です。",
    kinds: ["settlement"],
    settings: [
      { key: "show_period", label: "対象の日を出す", type: "checkbox", default: true },
      { key: "period_label", label: "対象の日の名前", type: "text", default: "日付" },
      { key: "show_location", label: "ロケーションを出す", type: "checkbox", default: true },
      { key: "location_label", label: "ロケーションの名前", type: "text", default: "ロケーション" },
      { key: "show_as_of", label: "集計した時刻を出す", type: "checkbox", default: false },
      { key: "as_of_label", label: "集計した時刻の名前", type: "text", default: "集計" },
    ],
    template:
      `<div class="blk">{% if s_show_period %}<div class="row"><span>{{ s_period_label | raw }}</span><span>{{ settlement.period_label }}</span></div>{% endif %}{% if s_show_location %}<div class="row"><span>{{ s_location_label | raw }}</span><span>{{ settlement.location_label }}</span></div>{% endif %}{% if s_show_as_of and settlement.as_of != blank %}<div class="row"><span>{{ s_as_of_label | raw }}</span><span>{{ settlement.as_of }}</span></div>{% endif %}</div>`,
  },
  {
    type: "settlement_row",
    label: "精算の行",
    description: "総売上・純売上・件数などを 1 行で出します。何行でも足せます。",
    kinds: ["settlement"],
    settings: [
      {
        key: "field",
        label: "出す値",
        type: "select",
        default: "total",
        options: SETTLEMENT_FIELDS.map((f) => ({ value: f.value, label: f.label })),
      },
      { key: "label", label: "名前", type: "text", default: "総売上" },
      { key: "unit", label: "件数のあとの文字", type: "text", default: "件", help: "件数・点数のときだけ使います。" },
      { key: "hide_zero", label: "0 のときは出さない", type: "checkbox", default: false },
      { key: "bold", label: "太字", type: "checkbox", default: false },
    ],
    derived: (s) => ({
      format: SETTLEMENT_FIELDS.find((f) => f.value === s.field)?.format ?? "money",
    }),
    template:
      `{% assign s__v = settlement[s_field] | default: 0 %}{% unless s_hide_zero and s__v == 0 %}<div class="row{% if s_bold %} b{% endif %}"><span>{{ s_label | raw }}</span><span class="print-value{% if s_field == "total" or s_field == "total_including_returns" %} print-total{% endif %}">{% if s_format == "money" %}{{ s__v | money }}{% else %}{{ s__v | number }}{{ s_unit | raw }}{% endif %}</span></div>{% endunless %}`,
    summaryKey: "label",
  },
  {
    type: "settlement_deposit",
    label: "納金額",
    description: "レジから納める現金の額と、差し引いた商品券釣りです。",
    kinds: ["settlement"],
    settings: [
      { key: "label", label: "名前", type: "text", default: "納金額" },
      { key: "show_voucher_change", label: "商品券釣りを出す（あるときだけ）", type: "checkbox", default: true },
      { key: "voucher_label", label: "商品券釣りの名前", type: "text", default: "商品券釣り" },
      { key: "bold", label: "太字", type: "checkbox", default: false },
    ],
    template:
      `<div class="blk item"><div class="row{% if s_bold %} b{% endif %}"><span>{{ s_label | raw }}</span><span class="print-value">{{ settlement.cash_deposit | money }}</span></div>{% if s_show_voucher_change and settlement.voucher_change > 0 %}<div class="row indent"><span>{{ s_voucher_label | raw }}</span><span class="print-value">-{{ settlement.voucher_change | money }}</span></div>{% endif %}</div>`,
  },
  {
    type: "settlement_payments",
    label: "支払方法別",
    description: "支払方法ごとの金額・件数・返金です。",
    kinds: ["settlement"],
    settings: [
      { key: "heading", label: "見出し", type: "text", default: "" },
      { key: "show_count", label: "件数を出す", type: "checkbox", default: true },
      { key: "count_unit", label: "件数のあとの文字", type: "text", default: "件" },
      { key: "show_refund", label: "返金を出す（あるときだけ）", type: "checkbox", default: true },
      { key: "refund_label", label: "返金の名前", type: "text", default: "うち返金" },
      {
        key: "style",
        label: "出し方",
        type: "select",
        default: "compact",
        options: [
          { value: "compact", label: "1 行（金額と件数）" },
          { value: "detailed", label: "支払方法ごとに 4 行（取引額・返金額・件数）" },
        ],
      },
      { key: "net_label", label: "4 行: 取引額の名前", type: "text", default: "取引額" },
      { key: "refund_amount_label", label: "4 行: 返金額の名前", type: "text", default: "返金額" },
      { key: "count_label", label: "4 行: 取引件数の名前", type: "text", default: "取引件数" },
      { key: "refund_count_label", label: "4 行: 返金件数の名前", type: "text", default: "返金件数" },
    ],
    template:
      `<div class="blk">{% if s_heading != blank %}<div class="b">{{ s_heading | raw }}</div>{% endif %}{% for p in settlement.payments %}{% if s_style == "detailed" %}<div class="item"><div class="row"><span>{{ p.label }}</span><span></span></div><div class="row indent"><span>{{ s_net_label | raw }}</span><span class="print-value">{{ p.net | money }}</span></div><div class="row indent"><span>{{ s_refund_amount_label | raw }}</span><span class="print-value">{{ p.refund | money }}</span></div><div class="row indent"><span>{{ s_count_label | raw }}</span><span class="print-value">{{ p.count | number }}{{ s_count_unit | raw }}</span></div><div class="row indent"><span>{{ s_refund_count_label | raw }}</span><span class="print-value">{{ p.refund_count | number }}{{ s_count_unit | raw }}</span></div></div>{% else %}<div class="row"><span>{{ p.label }}{% if s_show_count %} (<span class="print-value">{{ p.count | number }}{{ s_count_unit | raw }}</span>){% endif %}</span><span class="print-value">{{ p.net | money }}</span></div>{% if s_show_refund and p.refund > 0 %}<div class="row indent fs-s"><span>{{ s_refund_label | raw }} <span class="print-value">{{ p.refund_count | number }}{{ s_count_unit | raw }}</span></span><span class="print-value">-{{ p.refund | money }}</span></div>{% endif %}{% endif %}{% endfor %}</div>`,
  },

  // ── 領収書 ──────────────────────────────────────────
  {
    type: "receipt_recipient",
    label: "宛名",
    description: "宛名と「様」です。",
    kinds: ["receipt"],
    settings: [
      { key: "suffix", label: "宛名のあとの文字", type: "text", default: "様" },
      line("underline", "下の線", "solid"),
      size("m"),
    ],
    template:
      `<div class="blk row fs-{{ s_size }} ul-{{ s_underline }}"><span>{{ receipt.recipient }}</span><span>{{ s_suffix | raw }}</span></div>`,
  },
  {
    type: "receipt_amount",
    label: "金額",
    description: "領収した金額です。",
    kinds: ["receipt"],
    settings: [
      { key: "prefix", label: "金額の前の文字", type: "text", default: "" },
      { key: "suffix", label: "金額のあとの文字", type: "text", default: "-" },
      { key: "padding", label: "上下の余白", type: "number", default: 8, min: 0, max: 120, unit: "px" },
      size("xl"),
      line("underline", "下の線", "thick"),
      align(),
    ],
    template:
      `<div class="blk print-total a-{{ s_align }} fs-{{ s_size }} b ul-{{ s_underline }}" style="padding:{{ s_padding }}px 0">{{ s_prefix | raw }}{{ receipt.amount | money }}{{ s_suffix | raw }}</div>`,
  },
  {
    type: "receipt_breakdown",
    label: "内訳（税・支払方法）",
    description: "消費税と支払方法の内訳です。",
    kinds: ["receipt"],
    settings: [
      { key: "show_tax", label: "消費税を出す", type: "checkbox", default: true },
      { key: "tax_label", label: "消費税の名前", type: "text", default: "消費税" },
      { key: "show_payments", label: "支払方法を出す", type: "checkbox", default: true },
      { key: "separator", label: "名前と金額の間", type: "text", default: "：" },
      align("right"),
    ],
    template:
      `<div class="blk a-{{ s_align }}">{% if s_show_tax %}{% for t in receipt.tax_lines %}<div>{{ s_tax_label | raw }} ({{ t.rate_label }}){{ s_separator | raw }}<span class="print-value">{{ t.amount | money }}</span></div>{% endfor %}{% endif %}{% if s_show_payments %}{% for p in receipt.payments %}<div>{{ p.label }}{{ s_separator | raw }}<span class="print-value">{{ p.amount | money }}</span></div>{% endfor %}{% endif %}</div>`,
  },
  {
    type: "receipt_proviso",
    label: "但し書き",
    description: "「但 ◯◯ として」です。",
    kinds: ["receipt"],
    settings: [
      { key: "prefix", label: "前の文字", type: "text", default: "但" },
      { key: "suffix", label: "あとの文字", type: "text", default: "として" },
      line("underline", "下の線", "solid"),
    ],
    template:
      `<div class="blk row ul-{{ s_underline }}"><span>{{ s_prefix | raw }}\u3000{{ receipt.proviso }}</span><span>{{ s_suffix | raw }}</span></div>`,
  },
  {
    type: "receipt_meta",
    label: "発行日・番号",
    description: "発行日・領収書番号・注文番号です。",
    kinds: ["receipt"],
    settings: [
      { key: "show_date", label: "発行日を出す", type: "checkbox", default: true },
      { key: "date_label", label: "発行日の名前", type: "text", default: "発行日" },
      { key: "show_number", label: "領収書番号を出す", type: "checkbox", default: false },
      { key: "number_label", label: "領収書番号の名前", type: "text", default: "No." },
      { key: "show_order", label: "注文番号を出す", type: "checkbox", default: true },
      { key: "order_label", label: "注文番号の名前", type: "text", default: "注文" },
      {
        key: "style",
        label: "出し方",
        type: "select",
        default: "rows",
        options: [
          { value: "rows", label: "名前を左・値を右" },
          { value: "center", label: "中央に「名前 値」" },
        ],
      },
    ],
    template:
      `{% if s_style == "center" %}<div class="blk a-center lines">{% if s_show_date %}<div>{% if s_date_label != blank %}{{ s_date_label | raw }} {% endif %}{{ receipt.issue_date }}</div>{% endif %}{% if s_show_number and receipt.number != blank %}<div>{% if s_number_label != blank %}{{ s_number_label | raw }} {% endif %}{{ receipt.number }}</div>{% endif %}{% if s_show_order and receipt.order_name != blank %}<div>{% if s_order_label != blank %}{{ s_order_label | raw }} {% endif %}{{ receipt.order_name }}</div>{% endif %}</div>{% else %}<div class="blk">{% if s_show_date %}<div class="row"><span>{{ s_date_label | raw }}</span><span>{{ receipt.issue_date }}</span></div>{% endif %}{% if s_show_number and receipt.number != blank %}<div class="row"><span>{{ s_number_label | raw }}</span><span>{{ receipt.number }}</span></div>{% endif %}{% if s_show_order and receipt.order_name != blank %}<div class="row"><span>{{ s_order_label | raw }}</span><span>{{ receipt.order_name }}</span></div>{% endif %}</div>{% endif %}`,
  },
  {
    type: "stamp_box",
    label: "印の枠",
    description: "「担当印」などの四角い枠です。",
    kinds: ["receipt", "settlement"],
    settings: [
      { key: "label", label: "枠の中の文字", type: "text", default: "担当印" },
      { key: "size", label: "枠の大きさ", type: "number", default: 80, min: 40, max: 240, unit: "px" },
      align("right"),
      { key: "show_revenue_stamp", label: "金額が大きいとき、左に収入印紙の枠を出す（領収書だけ）", type: "checkbox", default: false },
      { key: "revenue_stamp_label", label: "収入印紙の枠の文字", type: "text", default: "収入印紙" },
      { key: "revenue_stamp_from", label: "収入印紙の枠を出す金額", type: "number", default: 50000, min: 1, max: 100000000, unit: "円以上" },
    ],
    template:
      `{% assign s__amount = receipt.amount | default: 0 %}{% if s_show_revenue_stamp and s__amount >= s_revenue_stamp_from %}<div class="blk stamps"><div class="stamp" style="width:{{ s_size }}px;height:{{ s_size }}px">{{ s_revenue_stamp_label | raw }}</div><div class="stamp" style="width:{{ s_size }}px;height:{{ s_size }}px">{{ s_label | raw }}</div></div>{% else %}<div class="blk a-{{ s_align }}"><div class="stamp" style="width:{{ s_size }}px;height:{{ s_size }}px">{{ s_label | raw }}</div></div>{% endif %}`,
  },
  {
    type: "issuer",
    label: "発行者",
    description: "会社名・住所・電話番号・登録番号です。",
    kinds: ["receipt", "sales"],
    settings: [
      { key: "name", label: "会社名", type: "text", default: "{{ shop.name }}" },
      { key: "zip", label: "郵便番号", type: "text", default: "" },
      { key: "address", label: "住所", type: "textarea", default: "" },
      { key: "phone", label: "電話番号", type: "text", default: "" },
      { key: "registration", label: "登録番号の行", type: "text", default: "", placeholder: "登録番号：T1234567890123" },
      { key: "bold", label: "太字", type: "checkbox", default: false },
      align(),
    ],
    template:
      `<div class="blk a-{{ s_align }}{% if s_bold %} b{% endif %}">{% if s_name != blank %}<div>{{ s_name | raw }}</div>{% endif %}{% if s_zip != blank %}<div>{{ s_zip | raw }}</div>{% endif %}{% if s_address != blank %}<div>{{ s_address | raw }}</div>{% endif %}{% if s_phone != blank %}<div>{{ s_phone | raw }}</div>{% endif %}{% if s_registration != blank %}<div>{{ s_registration | raw }}</div>{% endif %}</div>`,
  },
];

const BY_TYPE = new Map(BLOCK_DEFS.map((d) => [d.type, d]));

export function getBlockDef(type: string): BlockDef | undefined {
  return BY_TYPE.get(type);
}

export function blockDefsForKind(kind: ReceiptKind): BlockDef[] {
  return BLOCK_DEFS.filter((d) => d.kinds.includes(kind));
}

export function defaultSettings(def: BlockDef): Record<string, BlockSettingValue> {
  const out: Record<string, BlockSettingValue> = {};
  for (const s of def.settings) out[s.key] = s.default;
  return out;
}
