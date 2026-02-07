// app/routes/app.settings.tsx
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useEffect, useMemo, useState } from "react";
import { authenticate } from "../shopify.server";

export type LocationNode = { id: string; name: string };

export type DestinationGroup = {
  id: string;
  name: string;
  locationIds: string[]; // ✅ origin も必ず含める（POS側で所属グループ判定に使う）
};

export type CarrierOption = {
  id: string;
  label: string; // POSに出す表示名（例：ヤマト運輸）
  company: string; // Shopifyプリセットの company（例：Yamato (JA)）
  sortOrder?: number; // 表示順（小さい順、デフォルト: 999）
};

export type LossReasonOption = {
  id: string;
  label: string; // ロス区分名（例：破損、紛失）
  sortOrder?: number; // 表示順（小さい順、デフォルト: 999）
};

export type OrderDestinationOption = {
  id: string;
  name: string; // 発注先名（例: 本社）
  code?: string; // 任意コード
  sortOrder?: number; // 表示順（小さい順、デフォルト: 999）
};

export type SupplierOption = {
  id: string;
  name: string; // 仕入先名
  code?: string; // 仕入先コード（任意：社内管理用など）
  sortOrder?: number; // 表示順（小さい順、デフォルト: 999）
};

// CSV出力項目の定義
export type OrderCsvColumn = 
  | "orderId"           // 発注ID
  | "orderName"         // 名称
  | "locationName"       // 発注店舗
  | "destination"        // 発注先
  | "destinationCode"    // 発注先コード（発注先マスタのコード）
  | "date"              // 日付
  | "desiredDeliveryDate" // 希望納品日
  | "staffName"         // 担当者
  | "note"              // 備考
  | "status"            // ステータス
  | "productTitle"      // 商品名
  | "sku"               // SKU
  | "barcode"           // JAN
  | "option1"           // オプション1
  | "option2"           // オプション2
  | "option3"           // オプション3
  | "quantity"          // 数量
  | "arrivalDate"       // 入荷日（追加項目）
  | "inspectionDate"    // 検品日（追加項目）
  | "cost"              // 原価（追加項目）
  | "price"             // 販売価格（追加項目）
;

export type SettingsV1 = {
  version: 1;
  destinationGroups?: DestinationGroup[]; // 非推奨（後方互換性のため残す）
  carriers: CarrierOption[];
  suppliers?: SupplierOption[]; // 仕入で使用する仕入先設定（旧：purchase.suppliersに移行予定）
  lossReasons?: LossReasonOption[]; // ロス区分設定（破損/紛失 など）
  loss?: {
    allowCustomReason?: boolean; // 「その他（自由入力）」を許可するかどうか（デフォルト: true）
  };
  order?: {
    useDestinationMaster?: boolean; // 発注先マスタを使用するかどうか（true=使用, false=発注先項目を表示しない）
    destinations?: OrderDestinationOption[]; // 発注先マスタ一覧
    csvExportColumns?: OrderCsvColumn[]; // CSV出力項目（並び順を含む）
    csvExportColumnLabels?: Partial<Record<OrderCsvColumn, string>>; // CSV出力項目のカスタムラベル（項目名変更用）
  };
  purchase?: {
    suppliers?: SupplierOption[]; // 仕入で使用する仕入先設定（ここが正：発注もこのリストを使用）
    allowCustomSupplier?: boolean; // 「その他（仕入先入力）」を表示するかどうか（デフォルト: true）
  };
  // 追加設定項目
  visibleLocationIds?: string[]; // 表示ロケーション選択設定（空配列=全ロケーション表示）
  outbound?: {
    allowForceCancel?: boolean; // 強制キャンセル処理許可（デフォルト: true）
    historyInitialLimit?: number; // 出庫履歴（Transfer）初回件数。API上限250、推奨100
    shippingRequired?: boolean; // 配送情報を必須にする（true=必須：優先1・翌日・午前中、false=任意：直接入力・日付空白・未選択）
    allowCustomCarrier?: boolean; // 「その他（配送会社入力）」を表示するかどうか（デフォルト: true）
  };
  inbound?: {
    allowOverReceive?: boolean; // 過剰入庫許可（デフォルト: true）
    allowExtraReceive?: boolean; // 予定外入庫許可（デフォルト: true）
    listInitialLimit?: number; // 入庫リスト（Transfer）初回件数。API上限250、推奨100
  };
  productList?: {
    initialLimit?: number; // 商品リスト（追加行表示）初回件数。lineItems上限250、推奨250
  };
  searchList?: {
    initialLimit?: number; // 検索リスト（検索結果表示）初回件数。productVariants上限50、推奨50
  };
};

const NS = "stock_transfer_pos";
const KEY = "settings_v1";

// 仕入先リスト（purchase.suppliers）を、発注側のマスタ（order.destinations）形式に変換
// ✅ “仕入設定だけで管理し、発注も同じリストを使う” ための橋渡し
function toOrderDestinationsFromSuppliers(suppliers: SupplierOption[]): OrderDestinationOption[] {
  return (suppliers ?? [])
    .map((sp) => ({
      id: String(sp?.id ?? "").trim(),
      name: String(sp?.name ?? "").trim(),
      code: sp?.code ? String(sp.code).trim() : undefined,
      sortOrder: Number.isFinite(Number(sp?.sortOrder)) ? Number(sp.sortOrder) : 999,
    }))
    .filter((d) => d.id && d.name)
    .sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999));
}

// 日本の配送会社のデフォルト設定
const DEFAULT_CARRIERS_JP: CarrierOption[] = [
  { id: "car_yamato", label: "ヤマト運輸", company: "Yamato (JA)", sortOrder: 1 },
  { id: "car_sagawa", label: "佐川急便", company: "Sagawa (JA)", sortOrder: 2 },
  { id: "car_japanpost", label: "日本郵便", company: "Japan Post (JA)", sortOrder: 3 },
  { id: "car_ecohai", label: "エコ配", company: "エコ配", sortOrder: 4 },
];

// ロス区分のデフォルト設定（プリセット理由のみ。「その他（入力）」は別設定で制御）
const DEFAULT_LOSS_REASONS: LossReasonOption[] = [
  { id: "damage", label: "破損", sortOrder: 1 },
  { id: "lost", label: "紛失", sortOrder: 2 },
];

// CSV出力項目のデフォルト（並び順を含む）
const DEFAULT_ORDER_CSV_COLUMNS: OrderCsvColumn[] = [
  "orderId",
  "orderName",
  "locationName",
  "destination",
  "destinationCode",
  "date",
  "desiredDeliveryDate",
  "staffName",
  "note",
  "status",
  "productTitle",
  "sku",
  "barcode",
  "option1",
  "option2",
  "option3",
  "quantity",
];

function defaultSettings(): SettingsV1 {
  return {
    version: 1,
    destinationGroups: [], // 後方互換性のため残す（非推奨）
    carriers: DEFAULT_CARRIERS_JP.map((c) => ({ ...c })), // デフォルトで日本の配送会社を設定
    suppliers: [], // 仕入先初期値（空、旧：purchase.suppliersに移行予定）
    lossReasons: DEFAULT_LOSS_REASONS.map((r) => ({ ...r })), // デフォルトのロス区分
    loss: {
      allowCustomReason: true, // デフォルトで「その他（自由入力）」を許可
    },
    order: {
      useDestinationMaster: false,
      destinations: [],
      csvExportColumns: [...DEFAULT_ORDER_CSV_COLUMNS], // デフォルトCSV出力項目
      csvExportColumnLabels: undefined, // カスタムラベル（初期値は未設定）
    },
    purchase: {
      suppliers: [], // 仕入先初期値（空）
      allowCustomSupplier: true,
    },
    visibleLocationIds: [], // 空配列=全ロケーション表示
    outbound: {
      allowForceCancel: true, // デフォルト: 許可
      historyInitialLimit: 100, // 出庫履歴 初回表示件数
      shippingRequired: false, // デフォルト: 任意
      allowCustomCarrier: true,
    },
    inbound: {
      allowOverReceive: true,
      allowExtraReceive: true,
      listInitialLimit: 100, // 入庫リスト 初回。API上限250、推奨100
    },
    productList: { initialLimit: 250 }, // 商品リスト 初回。上限250、推奨250
    searchList: { initialLimit: 50 },  // 検索リスト 初回。API上限50、推奨50
  };
}

function safeParseSettings(raw: unknown): SettingsV1 {
  if (typeof raw !== "string" || !raw) return defaultSettings();
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.version === 1) {
      // ✅ 既存設定に対してもサニタイズ＋デフォルト補完を行う
      return sanitizeSettings(parsed);
    }
  } catch {
    // ignore
  }
  return defaultSettings();
}

function sanitizeSettings(input: any): SettingsV1 {
  const s: SettingsV1 = {
    version: 1,
    destinationGroups: [], // 後方互換性のため残す（非推奨）
    carriers: [],
    suppliers: [],
    lossReasons: [],
    order: {
      useDestinationMaster: false,
      destinations: [],
    },
    visibleLocationIds: [],
    outbound: {
      allowForceCancel: true,
      historyInitialLimit: 100,
      shippingRequired: Boolean(input?.outbound?.shippingRequired),
    },
    inbound: {
      allowOverReceive: true,
      allowExtraReceive: true,
      listInitialLimit: 100,
    },
    productList: { initialLimit: 250 },
    searchList: { initialLimit: 50 },
  };

  // 後方互換性のため、destinationGroupsは読み込むが表示しない
  const groups = Array.isArray(input?.destinationGroups) ? input.destinationGroups : [];
  s.destinationGroups = groups
    .map((g: any) => ({
      id: String(g?.id ?? "").trim(),
      name: String(g?.name ?? "").trim(),
      locationIds: Array.isArray(g?.locationIds) ? g.locationIds.map((x: any) => String(x)) : [],
    }))
    .filter((g: DestinationGroup) => g.id && g.name);

  const carriers = Array.isArray(input?.carriers) ? input.carriers : [];
  s.carriers = carriers
    .map((c: any) => ({
      id: String(c?.id ?? "").trim(),
      label: String(c?.label ?? "").trim(),
      company: String(c?.company ?? "").trim(),
      sortOrder: Number.isFinite(Number(c?.sortOrder)) ? Number(c.sortOrder) : 999,
    }))
    .filter((c: CarrierOption) => c.id && c.label && c.company)
    .sort((a: CarrierOption, b: CarrierOption) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999)); // 表示順でソート

  // ロス区分設定
  const lossReasonsRaw = Array.isArray(input?.lossReasons) ? input.lossReasons : [];
  s.lossReasons = lossReasonsRaw
    .map((r: any) => ({
      id: String(r?.id ?? "").trim() || String(r?.label ?? "").trim(),
      label: String(r?.label ?? "").trim() || String(r?.id ?? "").trim(),
      sortOrder: Number.isFinite(Number(r?.sortOrder)) ? Number(r.sortOrder) : 999,
    }))
    .filter((r: LossReasonOption) => r.id && r.label)
    .sort((a: LossReasonOption, b: LossReasonOption) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999));

  // 空の場合はデフォルトロス区分を採用
  if (!s.lossReasons || s.lossReasons.length === 0) {
    s.lossReasons = DEFAULT_LOSS_REASONS.map((r) => ({ ...r }));
  }

  // ロス設定（「その他（自由入力）」許可フラグ）
  if (input?.loss && typeof input.loss === "object") {
    s.loss = {
      allowCustomReason:
        typeof input.loss.allowCustomReason === "boolean"
          ? input.loss.allowCustomReason
          : true,
    };
  } else {
    s.loss = {
      allowCustomReason: true,
    };
  }

  // 仕入設定（「その他（仕入先入力）」表示フラグ）
  if (input?.purchase && typeof input.purchase === "object") {
    s.purchase = {
      ...(s.purchase ?? {}),
      allowCustomSupplier:
        typeof input.purchase.allowCustomSupplier === "boolean"
          ? input.purchase.allowCustomSupplier
          : true,
    };
  } else {
    s.purchase = {
      ...(s.purchase ?? {}),
      allowCustomSupplier: true,
    };
  }

  // 仕入先設定（旧フィールド。purchase.suppliers が正）
  const suppliers = Array.isArray(input?.suppliers) ? input.suppliers : [];
  s.suppliers = suppliers
    .map((sp: any) => ({
      id: String(sp?.id ?? "").trim(),
      name: String(sp?.name ?? "").trim(),
      code: sp?.code ? String(sp.code).trim() : undefined,
      sortOrder: Number.isFinite(Number(sp?.sortOrder)) ? Number(sp.sortOrder) : 999,
    }))
    .filter((sp: SupplierOption) => sp.id && sp.name)
    .sort((a: SupplierOption, b: SupplierOption) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999));

  // 発注先マスタ設定（order.destinations）
  if (input?.order && typeof input.order === "object") {
    const useDestinationMaster =
      typeof input.order.useDestinationMaster === "boolean"
        ? input.order.useDestinationMaster
        : false;
    const destinationsRaw = Array.isArray(input.order.destinations) ? input.order.destinations : [];
    const destinations: OrderDestinationOption[] = destinationsRaw
      .map((od: any) => ({
        id: String(od?.id ?? "").trim(),
        name: String(od?.name ?? "").trim(),
        code: od?.code ? String(od.code).trim() : undefined,
        sortOrder: Number.isFinite(Number(od?.sortOrder)) ? Number(od.sortOrder) : 999,
      }))
      .filter((od: OrderDestinationOption) => od.id && od.name)
      .sort((a: OrderDestinationOption, b: OrderDestinationOption) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999));

    // CSV出力項目設定
    const csvColumnsRaw = Array.isArray(input.order.csvExportColumns) ? input.order.csvExportColumns : [];
    const csvColumns: OrderCsvColumn[] = csvColumnsRaw
      .filter((col: any) => {
        const validColumns: OrderCsvColumn[] = [
          "orderId", "orderName", "locationName", "destination", "destinationCode", "date", "desiredDeliveryDate",
          "staffName", "note", "status", "productTitle", "sku", "barcode",
          "option1", "option2", "option3", "quantity", "arrivalDate", "inspectionDate", "cost", "price"
        ];
        return validColumns.includes(col);
      })
      .map((col: any) => col as OrderCsvColumn);
    
    // デフォルト項目が空の場合はデフォルトを設定
    const csvExportColumns = csvColumns.length > 0 ? csvColumns : [...DEFAULT_ORDER_CSV_COLUMNS];

    // CSV出力項目のカスタムラベル設定
    const csvColumnLabelsRaw = input.order.csvExportColumnLabels && typeof input.order.csvExportColumnLabels === "object"
      ? input.order.csvExportColumnLabels
      : {};
    const csvExportColumnLabels: Partial<Record<OrderCsvColumn, string>> = {};
    Object.keys(csvColumnLabelsRaw).forEach((key) => {
      const col = key as OrderCsvColumn;
      const label = String(csvColumnLabelsRaw[col as keyof typeof csvColumnLabelsRaw] || "").trim();
      if (label) {
        csvExportColumnLabels[col] = label;
      }
    });

    // purchase.suppliers を正とし、order.destinations はそこから自動生成する
    const purchaseSuppliersRaw = Array.isArray(input?.purchase?.suppliers) ? input.purchase.suppliers : [];
    const purchaseSuppliersFromPurchase: SupplierOption[] = purchaseSuppliersRaw
      .map((sp: any) => ({
        id: String(sp?.id ?? "").trim(),
        name: String(sp?.name ?? "").trim(),
        code: sp?.code ? String(sp.code).trim() : undefined,
        sortOrder: Number.isFinite(Number(sp?.sortOrder)) ? Number(sp.sortOrder) : 999,
      }))
      .filter((sp: SupplierOption) => sp.id && sp.name)
      .sort((a: SupplierOption, b: SupplierOption) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999));

    // 後方互換: purchase.suppliers が空のときだけ、旧 suppliers / 旧 order.destinations から復元
    const fallbackSuppliers: SupplierOption[] =
      purchaseSuppliersFromPurchase.length > 0
        ? []
        : (() => {
            const base = (s.suppliers ?? []).length > 0
              ? (s.suppliers ?? [])
              : destinations.map((d) => ({
                  id: d.id,
                  name: d.name,
                  code: d.code,
                  sortOrder: d.sortOrder,
                }));
            // IDで重複を除去
            return Array.from(new Map(base.map((sp) => [sp.id, sp])).values()).sort(
              (a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999)
            );
          })();

    const masterSuppliers = purchaseSuppliersFromPurchase.length > 0 ? purchaseSuppliersFromPurchase : fallbackSuppliers;

    s.purchase = { suppliers: masterSuppliers };
    s.order = {
      useDestinationMaster,
      // ✅ 発注側も同じ仕入先リストを使う（連動）
      destinations: toOrderDestinationsFromSuppliers(masterSuppliers),
      csvExportColumns,
      csvExportColumnLabels: Object.keys(csvExportColumnLabels).length > 0 ? csvExportColumnLabels : undefined,
    };
  } else {
    // order設定がない場合でも、purchase設定があれば読み込む
    if (input?.purchase && typeof input.purchase === "object") {
      const purchaseSuppliersRaw = Array.isArray(input.purchase.suppliers) ? input.purchase.suppliers : [];
      const purchaseSuppliers: SupplierOption[] = purchaseSuppliersRaw
        .map((sp: any) => ({
          id: String(sp?.id ?? "").trim(),
          name: String(sp?.name ?? "").trim(),
          code: sp?.code ? String(sp.code).trim() : undefined,
          sortOrder: Number.isFinite(Number(sp?.sortOrder)) ? Number(sp.sortOrder) : 999,
        }))
        .filter((sp: SupplierOption) => sp.id && sp.name)
        .sort((a: SupplierOption, b: SupplierOption) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999));

      s.purchase = {
        suppliers: purchaseSuppliers,
      };
    }
  }

  // ✅ 仕入先マスタ連動: order.destinations は常に purchase.suppliers から生成（保存のたびに統一）
  const masterSuppliersFinal = (s.purchase?.suppliers && s.purchase.suppliers.length > 0)
    ? s.purchase.suppliers
    : (s.suppliers ?? []);
  if (!s.order) s.order = {};
  s.order.destinations = toOrderDestinationsFromSuppliers(masterSuppliersFinal);

  // 表示ロケーション選択設定
  if (Array.isArray(input?.visibleLocationIds)) {
    s.visibleLocationIds = input.visibleLocationIds.map((id: any) => String(id)).filter(Boolean);
  }

  // 出庫設定
  if (input?.outbound && typeof input.outbound === "object") {
    s.outbound = {
      allowForceCancel:
        typeof input.outbound.allowForceCancel === "boolean"
          ? input.outbound.allowForceCancel
          : true,
      historyInitialLimit: clampInt(
        input.outbound.historyInitialLimit,
        1,
        250,
        100
      ),
      shippingRequired: Boolean(input.outbound.shippingRequired),
      allowCustomCarrier:
        typeof input.outbound.allowCustomCarrier === "boolean"
          ? input.outbound.allowCustomCarrier
          : true,
    };
  }

  // 入庫設定
  if (input?.inbound && typeof input.inbound === "object") {
    s.inbound = {
      allowOverReceive:
        typeof input.inbound.allowOverReceive === "boolean"
          ? input.inbound.allowOverReceive
          : true,
      allowExtraReceive:
        typeof input.inbound.allowExtraReceive === "boolean"
          ? input.inbound.allowExtraReceive
          : true,
      listInitialLimit: clampInt(
        input.inbound.listInitialLimit,
        1,
        250,
        100
      ),
    };
  }

  // 商品リスト表示件数（初期）。lineItems API 上限250
  if (input?.productList && typeof input.productList === "object") {
    s.productList = {
      initialLimit: clampInt(input.productList.initialLimit, 1, 250, 250),
    };
  }

  // 検索リスト表示件数（初期）。productVariants 検索 API 上限50
  if (input?.searchList && typeof input.searchList === "object") {
    s.searchList = {
      initialLimit: clampInt(input.searchList.initialLimit, 1, 50, 50),
    };
  }

  return s;
}

/** 文字列を半角数字に変換（全角数字→半角、空白除去） */
function normalizeToHalfWidthDigits(s: unknown): string {
  const str = String(s ?? "")
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\s/g, "")
    .trim();
  return str.replace(/\D/g, ""); // 数字以外を除去
}

function clampInt(
  v: number | string,
  min: number,
  max: number,
  defaultVal: number
): number {
  const normalized = normalizeToHalfWidthDigits(v);
  const n = normalized ? parseInt(normalized, 10) : Number(v);
  if (!Number.isFinite(n)) return defaultVal;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/**
 * company は Shopify が「追跡リンク生成など」で認識する文字列。
 * “公式一覧をAPIで取得” は一般公開APIに無い想定なので、まずはプリセット方式で運用。
 * ここは運用しながら増やせばOK。
 */
const COMPANY_PRESETS_GLOBAL = [
  "DHL Express",
  "FedEx",
  "UPS",
  "USPS",
  "Japan Post (EN)",
  "Japan Post (JA)",
  "Sagawa (EN)",
  "Sagawa (JA)",
  "Yamato (EN)",
  "Yamato (JA)",
];

const COMPANY_PRESETS_JP_EXTRA = [
  "エコ配",
  "西濃運輸",
  "西濃スーパーエキスプレス",
  "福山通運",
  "日本通運",
  "名鉄運輸",
  "第一貨物",
];

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const { admin } = await authenticate.admin(request);

    const resp = await admin.graphql(
      `#graphql
        query SettingsBoot($first: Int!) {
          locations(first: $first) { nodes { id name } }
          currentAppInstallation {
            id
            metafield(namespace: "${NS}", key: "${KEY}") { id value type }
          }
        }
      `,
      { variables: { first: 250 } }
    );

    const data = await resp.json();
    const locations: LocationNode[] = data?.data?.locations?.nodes ?? [];
    const raw = data?.data?.currentAppInstallation?.metafield?.value ?? null;

    let settings = safeParseSettings(raw);

    // 初回インストール時（carriersが空の場合）はデフォルト値を設定
    if (settings.carriers.length === 0) {
      settings = {
        ...settings,
        carriers: DEFAULT_CARRIERS_JP.map((c) => ({ ...c })),
      };
    }

    // ✅ React Router template: json() を使わず、そのまま返す
    return { locations, settings };
  } catch (error) {
    // 認証エラーの場合は、authenticate.admin が自動的にリダイレクトする
    // ここに到達することは通常ないが、念のためエラーハンドリング
    console.error("Settings loader error:", error);
    throw error;
  }
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();

  const raw = String(form.get("settings") ?? "");
  let incoming: any;
  try {
    incoming = JSON.parse(raw);
  } catch {
    return { ok: false, error: "settings JSON が不正です" as const };
  }

  if (incoming?.version !== 1) {
    return { ok: false, error: "settings version が不正です" as const };
  }

  const settings = sanitizeSettings(incoming);

  const appInstResp = await admin.graphql(
    `#graphql
      query AppInst {
        currentAppInstallation { id }
      }
    `
  );

  const appInstJson = await appInstResp.json();
  const ownerId = appInstJson?.data?.currentAppInstallation?.id as string;

  if (!ownerId) {
    return { ok: false, error: "currentAppInstallation.id が取得できませんでした" as const };
  }

  const saveResp = await admin.graphql(
    `#graphql
      mutation SaveSettings($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id namespace key type }
          userErrors { field message }
        }
      }
    `,
    {
      variables: {
        metafields: [
          {
            ownerId,
            namespace: NS,
            key: KEY,
            type: "json",
            value: JSON.stringify(settings),
          },
        ],
      },
    }
  );

  const saveJson = await saveResp.json();
  const errs = saveJson?.data?.metafieldsSet?.userErrors ?? [];
  if (errs.length) {
    return { ok: false, error: errs.map((e: any) => e.message).join(" / ") as const };
  }

  return { ok: true, settings };
}

export default function SettingsPage() {
  const loaderData = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  // loaderDataが存在しない場合（認証エラーなど）のエラーハンドリング
  if (!loaderData) {
    return (
      <s-page heading="設定">
        <s-box padding="base">
          <s-text tone="critical">
            設定を読み込めませんでした。ページをリロードしてください。
          </s-text>
        </s-box>
      </s-page>
    );
  }

  const { locations, settings: initial } = loaderData;
  const [settings, setSettings] = useState<SettingsV1>(initial);

  // carrier presets UI
  const [showCarrierPresets, setShowCarrierPresets] = useState(false);

  // 設定タブ（棚卸と同様のタブ構成）
  type SettingsTabId = "app" | "outbound" | "inbound" | "purchase" | "order" | "loss";
  const [activeTab, setActiveTab] = useState<SettingsTabId>("app");

  // アプリ表示件数の入力検証エラー（半角数字以外など）
  const [displayCountErrors, setDisplayCountErrors] = useState<{
    historyList?: string;
    productList?: string;
    searchList?: string;
  }>({});

  const readValue = (e: any) => String(e?.currentTarget?.value ?? e?.currentValue?.value ?? "");

  const DISPLAY_COUNT_ERROR_MSG = "値を確認してください。半角数字で入力をお願いします。";

  /** 全角数字→半角変換・空白除去し、半角数字のみ抽出。無効・範囲外の場合はエラーを返す。範囲外はclamped値を適用。 */
  const parseDisplayCountInput = (
    raw: string,
    min: number,
    max: number,
    defaultVal: number
  ): { value: number; displayValue: string; error: string | null; shouldUpdate: boolean } => {
    const s = String(raw ?? "")
      .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/\s/g, "")
      .trim();
    if (!s) return { value: defaultVal, displayValue: String(defaultVal), error: null, shouldUpdate: true };
    const digitsOnly = s.replace(/\D/g, "");
    if (digitsOnly !== s) {
      return { value: defaultVal, displayValue: s, error: DISPLAY_COUNT_ERROR_MSG, shouldUpdate: false };
    }
    const n = parseInt(digitsOnly, 10);
    if (!Number.isFinite(n)) return { value: defaultVal, displayValue: s, error: DISPLAY_COUNT_ERROR_MSG, shouldUpdate: false };
    const clamped = Math.max(min, Math.min(max, n));
    const hasRangeError = clamped !== n;
    return { value: clamped, displayValue: String(clamped), error: hasRangeError ? DISPLAY_COUNT_ERROR_MSG : null, shouldUpdate: true };
  };

  useEffect(() => {
    setSettings(initial);
    setDisplayCountErrors({});
  }, [initial]);

  const saving = fetcher.state !== "idle";
  const saveOk = fetcher.data && (fetcher.data as any).ok === true;
  const saveErr =
    fetcher.data && (fetcher.data as any).ok === false ? (fetcher.data as any).error : null;

  // 変更有無（初期値と比較）＋入力エラー有無でボタン活性/非活性を制御
  const isDirty = useMemo(
    () => JSON.stringify(settings) !== JSON.stringify(initial),
    [settings, initial],
  );
  const hasDisplayCountError = useMemo(
    () => Object.values(displayCountErrors).some((msg) => !!msg),
    [displayCountErrors],
  );

  // 保存成功したらサニタイズ後のsettingsでstateを更新
  useEffect(() => {
    if ((fetcher.data as any)?.ok && (fetcher.data as any)?.settings) {
      setSettings((fetcher.data as any).settings);
    }
  }, [fetcher.data]);

  const addCarrier = () => {
    const id = `car_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const maxSortOrder = Math.max(...settings.carriers.map((c) => c.sortOrder ?? 999), 0);
    setSettings((s) => ({
      ...s,
      carriers: [
        ...s.carriers,
        { id, label: "例）ヤマト運輸", company: "Yamato (JA)", sortOrder: maxSortOrder + 1 },
      ].sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999)),
    }));
  };

  const updateCarrier = (id: string, patch: Partial<CarrierOption>) => {
    setSettings((s) => {
      const updated = s.carriers.map((c) => (c.id === id ? { ...c, ...patch } : c));
      return {
        ...s,
        carriers: updated.sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999)),
      };
    });
  };

  const removeCarrier = (id: string) => {
    setSettings((s) => ({
      ...s,
      carriers: s.carriers.filter((c) => c.id !== id),
    }));
  };

  const moveCarrierUp = (id: string) => {
    setSettings((s) => {
      const index = s.carriers.findIndex((c) => c.id === id);
      if (index <= 0) return s;
      const carriers = [...s.carriers];
      // 配列の要素を直接入れ替え（新しい配列を作成）
      const newCarriers = [...carriers];
      [newCarriers[index - 1], newCarriers[index]] = [newCarriers[index], newCarriers[index - 1]];
      // sortOrderも更新（新しいオブジェクトを作成）
      const updatedCarriers = newCarriers.map((c, i) => ({
        ...c,
        sortOrder: i + 1,
      }));
      return {
        ...s,
        carriers: updatedCarriers,
      };
    });
  };

  const moveCarrierDown = (id: string) => {
    setSettings((s) => {
      const index = s.carriers.findIndex((c) => c.id === id);
      if (index < 0 || index >= s.carriers.length - 1) return s;
      const carriers = [...s.carriers];
      // 配列の要素を直接入れ替え（新しい配列を作成）
      const newCarriers = [...carriers];
      [newCarriers[index], newCarriers[index + 1]] = [newCarriers[index + 1], newCarriers[index]];
      // sortOrderも更新（新しいオブジェクトを作成）
      const updatedCarriers = newCarriers.map((c, i) => ({
        ...c,
        sortOrder: i + 1,
      }));
      return {
        ...s,
        carriers: updatedCarriers,
      };
    });
  };

  const resetCarriersToDefault = () => {
    if (
      !confirm(
        "配送会社をデフォルト設定に戻しますか？現在の設定は削除されます。"
      )
    )
      return;
    setSettings((s) => ({
      ...s,
      carriers: DEFAULT_CARRIERS_JP.map((c) => ({ ...c })),
    }));
  };

  // ロス区分設定（lossReasons）
  const addLossReason = () => {
    const id = `loss_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const current = settings.lossReasons ?? [];
    const maxSortOrder = Math.max(...current.map((r) => r.sortOrder ?? 999), 0);
    setSettings((s) => ({
      ...s,
      lossReasons: [
        ...current,
        {
          id,
          label: "例）破損",
          sortOrder: maxSortOrder + 1,
        },
      ].sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999)),
    }));
  };

  const updateLossReason = (id: string, patch: Partial<LossReasonOption>) => {
    setSettings((s) => {
      const current = s.lossReasons ?? [];
      const updated = current.map((lr) => (lr.id === id ? { ...lr, ...patch } : lr));
      return {
        ...s,
        lossReasons: updated.sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999)),
      };
    });
  };

  const removeLossReason = (id: string) => {
    setSettings((s) => ({
      ...s,
      lossReasons: (s.lossReasons ?? []).filter((lr) => lr.id !== id),
    }));
  };

  const moveLossReasonUp = (id: string) => {
    setSettings((s) => {
      const list = s.lossReasons ?? [];
      const index = list.findIndex((lr) => lr.id === id);
      if (index <= 0) return s;
      const newList = [...list];
      [newList[index - 1], newList[index]] = [newList[index], newList[index - 1]];
      const updated = newList.map((lr, i) => ({
        ...lr,
        sortOrder: i + 1,
      }));
      return {
        ...s,
        lossReasons: updated,
      };
    });
  };

  const moveLossReasonDown = (id: string) => {
    setSettings((s) => {
      const list = s.lossReasons ?? [];
      const index = list.findIndex((lr) => lr.id === id);
      if (index < 0 || index >= list.length - 1) return s;
      const newList = [...list];
      [newList[index], newList[index + 1]] = [newList[index + 1], newList[index]];
      const updated = newList.map((lr, i) => ({
        ...lr,
        sortOrder: i + 1,
      }));
      return {
        ...s,
        lossReasons: updated,
      };
    });
  };

  const addSupplier = () => {
    const id = `sup_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const current = settings.suppliers ?? [];
    const maxSortOrder = Math.max(...current.map((sp) => sp.sortOrder ?? 999), 0);
    setSettings((s) => ({
      ...s,
      suppliers: [
        ...current,
        {
          id,
          name: "例）〇〇商事",
          code: "",
          sortOrder: maxSortOrder + 1,
        },
      ].sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999)),
    }));
  };

  const updateSupplier = (id: string, patch: Partial<SupplierOption>) => {
    setSettings((s) => {
      const current = s.suppliers ?? [];
      const updated = current.map((sp) => (sp.id === id ? { ...sp, ...patch } : sp));
      return {
        ...s,
        suppliers: updated.sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999)),
      };
    });
  };

  const removeSupplier = (id: string) => {
    setSettings((s) => ({
      ...s,
      suppliers: (s.suppliers ?? []).filter((sp) => sp.id !== id),
    }));
  };

  const moveSupplierUp = (id: string) => {
    setSettings((s) => {
      const list = s.suppliers ?? [];
      const index = list.findIndex((sp) => sp.id === id);
      if (index <= 0) return s;
      const suppliers = [...list];
      const newSuppliers = [...suppliers];
      [newSuppliers[index - 1], newSuppliers[index]] = [newSuppliers[index], newSuppliers[index - 1]];
      const updatedSuppliers = newSuppliers.map((sp, i) => ({
        ...sp,
        sortOrder: i + 1,
      }));
      return {
        ...s,
        suppliers: updatedSuppliers,
      };
    });
  };

  const moveSupplierDown = (id: string) => {
    setSettings((s) => {
      const list = s.suppliers ?? [];
      const index = list.findIndex((sp) => sp.id === id);
      if (index < 0 || index >= list.length - 1) return s;
      const suppliers = [...list];
      const newSuppliers = [...suppliers];
      [newSuppliers[index], newSuppliers[index + 1]] = [newSuppliers[index + 1], newSuppliers[index]];
      const updatedSuppliers = newSuppliers.map((sp, i) => ({
        ...sp,
        sortOrder: i + 1,
      }));
      return {
        ...s,
        suppliers: updatedSuppliers,
      };
    });
  };

  // CSV出力項目操作
  const CSV_COLUMN_LABELS: Record<OrderCsvColumn, string> = {
    orderId: "発注ID",
    orderName: "名称",
    locationName: "発注店舗",
    destination: "発注先",
    destinationCode: "発注先コード",
    date: "日付",
    desiredDeliveryDate: "希望納品日",
    staffName: "担当者",
    note: "備考",
    status: "ステータス",
    productTitle: "商品名",
    sku: "SKU",
    barcode: "JAN",
    option1: "オプション1",
    option2: "オプション2",
    option3: "オプション3",
    quantity: "数量",
    arrivalDate: "入荷日",
    inspectionDate: "検品日",
    cost: "原価",
    price: "販売価格",
  };

  const ALL_CSV_COLUMNS: OrderCsvColumn[] = [
    "orderId", "orderName", "locationName", "destination", "destinationCode", "date", "desiredDeliveryDate",
    "staffName", "note", "status", "productTitle", "sku", "barcode",
    "option1", "option2", "option3", "quantity", "arrivalDate", "inspectionDate", "cost", "price"
  ];

  const toggleCsvColumn = (column: OrderCsvColumn) => {
    setSettings((s) => {
      const current = s.order?.csvExportColumns || DEFAULT_ORDER_CSV_COLUMNS;
      const isSelected = current.includes(column);
      
      if (isSelected) {
        // 削除（最低1つは残す）
        if (current.length <= 1) return s;
        const updated = current.filter((c) => c !== column);
        return {
          ...s,
          order: {
            ...s.order,
            useDestinationMaster: s.order?.useDestinationMaster ?? false,
            destinations: s.order?.destinations ?? [],
            csvExportColumns: updated,
          },
        };
      } else {
        // 追加（現在の並び順の最後に追加）
        const updated = [...current, column];
        return {
          ...s,
          order: {
            ...s.order,
            useDestinationMaster: s.order?.useDestinationMaster ?? false,
            destinations: s.order?.destinations ?? [],
            csvExportColumns: updated,
          },
        };
      }
    });
  };

  const moveCsvColumnUp = (column: OrderCsvColumn) => {
    setSettings((s) => {
      const current = s.order?.csvExportColumns || DEFAULT_ORDER_CSV_COLUMNS;
      const index = current.indexOf(column);
      if (index <= 0) return s;
      const updated = [...current];
      [updated[index - 1], updated[index]] = [updated[index], updated[index - 1]];
      return {
        ...s,
        order: {
          ...s.order,
          useDestinationMaster: s.order?.useDestinationMaster ?? false,
          destinations: s.order?.destinations ?? [],
          csvExportColumns: updated,
        },
      };
    });
  };

  const moveCsvColumnDown = (column: OrderCsvColumn) => {
    setSettings((s) => {
      const current = s.order?.csvExportColumns || DEFAULT_ORDER_CSV_COLUMNS;
      const index = current.indexOf(column);
      if (index < 0 || index >= current.length - 1) return s;
      const updated = [...current];
      [updated[index], updated[index + 1]] = [updated[index + 1], updated[index]];
      return {
        ...s,
        order: {
          ...s.order,
          useDestinationMaster: s.order?.useDestinationMaster ?? false,
          destinations: s.order?.destinations ?? [],
          csvExportColumns: updated,
        },
      };
    });
  };

  const moveCsvColumnToPosition = (column: OrderCsvColumn, targetPosition: number) => {
    setSettings((s) => {
      const current = s.order?.csvExportColumns || DEFAULT_ORDER_CSV_COLUMNS;
      const currentIndex = current.indexOf(column);
      if (currentIndex < 0) return s;
      
      // 目標位置を1ベースから0ベースに変換し、範囲チェック
      const targetIndex = Math.max(0, Math.min(current.length - 1, targetPosition - 1));
      
      // 同じ位置の場合は何もしない
      if (currentIndex === targetIndex) return s;
      
      // 項目を移動
      const updated = [...current];
      const [movedItem] = updated.splice(currentIndex, 1); // 元の位置から削除
      updated.splice(targetIndex, 0, movedItem); // 目標位置に挿入
      
      return {
        ...s,
        order: {
          ...s.order,
          useDestinationMaster: s.order?.useDestinationMaster ?? false,
          destinations: s.order?.destinations ?? [],
          csvExportColumns: updated,
        },
      };
    });
  };

  const resetCsvColumns = () => {
    setSettings((s) => ({
      ...s,
      order: {
        ...s.order,
        useDestinationMaster: s.order?.useDestinationMaster ?? false,
        destinations: s.order?.destinations ?? [],
        csvExportColumns: [...DEFAULT_ORDER_CSV_COLUMNS],
        csvExportColumnLabels: undefined, // カスタムラベルもリセット
      },
    }));
  };

  const updateCsvColumnLabel = (column: OrderCsvColumn, label: string) => {
    setSettings((s) => {
      const currentLabels = s.order?.csvExportColumnLabels || {};
      const updatedLabels = { ...currentLabels };
      
      const trimmedLabel = label.trim();
      if (trimmedLabel) {
        updatedLabels[column] = trimmedLabel;
      } else {
        // 空の場合は削除
        delete updatedLabels[column];
      }

      return {
        ...s,
        order: {
          ...s.order,
          useDestinationMaster: s.order?.useDestinationMaster ?? false,
          destinations: s.order?.destinations ?? [],
          csvExportColumns: s.order?.csvExportColumns,
          csvExportColumnLabels: Object.keys(updatedLabels).length > 0 ? updatedLabels : undefined,
        },
      };
    });
  };

  const save = () => {
    const fd = new FormData();
    fd.set("settings", JSON.stringify(settings));
    fetcher.submit(fd, { method: "post" });
  };

  return (
    <s-page heading="設定">
      <s-scroll-box padding="base">
        <s-stack gap="base">
          {/* 保存・破棄ボタン（最上部・右寄せ・上下余白を抑えて浮き感を軽減） */}
          <div style={{ width: "100%", display: "flex", justifyContent: "flex-end", padding: "8px 16px" }}>
            <s-stack direction="inline" gap="base" inlineAlignment="end">
              <s-button
                tone="critical"
                onClick={() => setSettings(initial)}
                disabled={saving || !isDirty}
              >
                破棄
              </s-button>
              <s-button
                tone="success"
                onClick={save}
                disabled={saving || !isDirty || hasDisplayCountError}
              >
                {saving ? "保存中..." : "保存"}
              </s-button>
            </s-stack>
          </div>

          {/* 成功・エラーメッセージ */}
          {saveOk ? (
            <s-box padding="base" background="subdued">
              <s-text tone="success" emphasis="bold">保存しました</s-text>
            </s-box>
          ) : null}
          {saveErr ? (
            <s-box padding="base" background="subdued">
              <s-text tone="critical" emphasis="bold">保存エラー: {saveErr}</s-text>
            </s-box>
          ) : null}

          {/* 上部タブナビゲーション（アプリ設定 / 出庫設定 / 入庫設定 / 仕入設定 / ロス設定） */}
          <s-box padding="none">
            <div
              style={{
                display: "flex",
                gap: "8px",
                padding: "0 16px 8px",
                borderBottom: "1px solid #e1e3e5",
                flexWrap: "wrap",
              }}
            >
              {[
                { id: "app" as SettingsTabId, label: "アプリ設定" },
                { id: "outbound" as SettingsTabId, label: "出庫設定" },
                { id: "inbound" as SettingsTabId, label: "入庫設定" },
                { id: "purchase" as SettingsTabId, label: "仕入設定" },
                { id: "order" as SettingsTabId, label: "発注設定" },
                { id: "loss" as SettingsTabId, label: "ロス設定" },
              ].map((tab) => {
                const selected = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setActiveTab(tab.id)}
                    style={{
                      border: "none",
                      backgroundColor: selected ? "#e5e7eb" : "transparent",
                      borderRadius: 8,
                      padding: "6px 12px",
                      cursor: "pointer",
                      fontSize: 14,
                      fontWeight: selected ? 600 : 500,
                    }}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>
          </s-box>

          {/* タブごとの内容（1カラムレイアウト） */}
          <s-stack gap="base">
            {/* ① アプリ設定タブ：店舗設定 / アプリ表示件数設定 */}
            {activeTab === "app" && (
              <>
                {/* 店舗設定：左（タイトル＋説明） / 右（白カード） */}
                <s-box padding="base">
                  <div
                    style={{
                      display: "flex",
                      gap: "24px",
                      alignItems: "flex-start",
                      flexWrap: "wrap",
                    }}
                  >
                    {/* 左：タイトル＋説明テキスト（PCでは約260px、SPでは横幅いっぱいに折り返し） */}
                    <div style={{ flex: "1 1 260px", minWidth: 0 }}>
                      <div
                        style={{
                          fontWeight: 600,
                          fontSize: 14,
                          marginBottom: 4,
                        }}
                      >
                        店舗設定
                      </div>
                      <s-text tone="subdued" size="small">
                        POS側で表示するロケーションを選択します。
                        <br />
                        全て表示のまま＝全ロケーション表示。項目を選ぶとそのロケーションのみ表示されます。
                      </s-text>
                    </div>

                    {/* 右：ロケーション選択カード（ここだけ白背景） */}
                    <div style={{ flex: "1 1 320px", minWidth: 280 }}>
                      {locations.length === 0 ? (
                        <div
                          style={{
                            background: "#ffffff",
                            borderRadius: 12,
                            boxShadow: "0 0 0 1px #e1e3e5",
                            padding: 16,
                          }}
                        >
                          <s-text tone="critical">ロケーションが取得できませんでした</s-text>
                        </div>
                      ) : (
                        <div
                          style={{
                            background: "#ffffff",
                            borderRadius: 12,
                            boxShadow: "0 0 0 1px #e1e3e5",
                            padding: 16,
                          }}
                        >
                          <div
                            style={{
                              maxHeight: "220px",
                              overflowY: "auto",
                              borderRadius: "8px",
                              border: "1px solid #e1e3e5",
                              padding: "6px",
                            }}
                          >
                            <div
                              onClick={() =>
                                setSettings((s) => ({ ...s, visibleLocationIds: [] }))
                              }
                              style={{
                                padding: "10px 12px",
                                borderRadius: "6px",
                                cursor: "pointer",
                                backgroundColor:
                                  (settings.visibleLocationIds ?? []).length === 0
                                    ? "#eff6ff"
                                    : "transparent",
                                border:
                                  (settings.visibleLocationIds ?? []).length === 0
                                    ? "1px solid #2563eb"
                                    : "1px solid transparent",
                                display: "flex",
                                alignItems: "center",
                                gap: "8px",
                              }}
                            >
                              <input
                                type="checkbox"
                                checked={(settings.visibleLocationIds ?? []).length === 0}
                                readOnly
                                style={{ width: "16px", height: "16px", flexShrink: 0 }}
                              />
                              <span
                                style={{
                                  fontWeight:
                                    (settings.visibleLocationIds ?? []).length === 0
                                      ? 600
                                      : 500,
                                }}
                              >
                                全て表示
                              </span>
                            </div>
                            {locations.map((l) => {
                              const isSelected = (settings.visibleLocationIds ?? []).includes(
                                l.id
                              );
                              return (
                                <div
                                  key={l.id}
                                  onClick={() => {
                                    const current = settings.visibleLocationIds ?? [];
                                    const newIds = isSelected
                                      ? current.filter((id) => id !== l.id)
                                      : [...current, l.id];
                                    setSettings((s) => ({
                                      ...s,
                                      visibleLocationIds: newIds,
                                    }));
                                  }}
                                  style={{
                                    padding: "10px 12px",
                                    borderRadius: "6px",
                                    cursor: "pointer",
                                    backgroundColor: isSelected ? "#eff6ff" : "transparent",
                                    border: isSelected
                                      ? "1px solid #2563eb"
                                      : "1px solid transparent",
                                    marginTop: "4px",
                                    display: "flex",
                                    alignItems: "center",
                                    gap: "8px",
                                  }}
                                >
                                  <input
                                    type="checkbox"
                                    checked={isSelected}
                                    readOnly
                                    style={{ width: "16px", height: "16px", flexShrink: 0 }}
                                  />
                                  <span
                                    style={{
                                      fontWeight: isSelected ? 600 : 500,
                                      overflow: "hidden",
                                      textOverflow: "ellipsis",
                                    }}
                                  >
                                    {l.name}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </s-box>

                {/* アプリ表示件数：左（タイトル＋説明） / 右（白カード） */}
                <s-box padding="base">
                  <div
                    style={{
                      display: "flex",
                      gap: "24px",
                      alignItems: "flex-start",
                      flexWrap: "wrap",
                    }}
                  >
                    {/* 左：タイトル＋説明（PCでは約260px、SPでは横幅いっぱいに折り返し） */}
                    <div style={{ flex: "1 1 260px", minWidth: 0 }}>
                      <div
                        style={{
                          fontWeight: 600,
                          fontSize: 14,
                          marginBottom: 4,
                        }}
                      >
                        アプリ表示件数（初回読み込み）
                      </div>
                      <s-text tone="subdued" size="small">
                        各画面の「初回に何件まで表示するか」を設定します。
                        <br />
                        大量データのショップでは、件数を抑えると表示が軽くなります。
                      </s-text>
                    </div>

                    {/* 右：入力カード（白背景） */}
                    <div style={{ flex: "1 1 320px", minWidth: 280 }}>
                      <div
                        style={{
                          background: "#ffffff",
                          borderRadius: 12,
                          boxShadow: "0 0 0 1px #e1e3e5",
                          padding: 16,
                        }}
                      >
                        <s-stack gap="base">
                          <s-text-field
                            type="text"
                            inputMode="numeric"
                            pattern="[0-9]*"
                            label="履歴一覧リスト"
                            value={String(settings.outbound?.historyInitialLimit ?? 100)}
                            helpText={displayCountErrors.historyList}
                            tone={displayCountErrors.historyList ? "critical" : undefined}
                            onInput={(e: any) => {
                              const r = parseDisplayCountInput(readValue(e), 1, 250, 100);
                              setDisplayCountErrors((prev) => ({
                                ...prev,
                                historyList: r.error ?? undefined,
                              }));
                              if (r.shouldUpdate) {
                                setSettings((s) => ({
                                  ...s,
                                  outbound: {
                                    ...(s.outbound ?? {}),
                                    historyInitialLimit: r.value,
                                  },
                                  inbound: { ...(s.inbound ?? {}), listInitialLimit: r.value },
                                }));
                              }
                            }}
                            onChange={(e: any) => {
                              const r = parseDisplayCountInput(readValue(e), 1, 250, 100);
                              setDisplayCountErrors((prev) => ({
                                ...prev,
                                historyList: r.error ?? undefined,
                              }));
                              if (r.shouldUpdate) {
                                setSettings((s) => ({
                                  ...s,
                                  outbound: {
                                    ...(s.outbound ?? {}),
                                    historyInitialLimit: r.value,
                                  },
                                  inbound: { ...(s.inbound ?? {}), listInitialLimit: r.value },
                                }));
                              }
                            }}
                          />
                          <s-text tone="subdued" size="small">
                            出庫・入庫・ロス履歴の一覧表示件数に適用（棚卸履歴は対象外）。最大250件、推奨100件。
                          </s-text>

                          <s-text-field
                            type="text"
                            inputMode="numeric"
                            pattern="[0-9]*"
                            label="商品リスト"
                            value={String(settings.productList?.initialLimit ?? 250)}
                            helpText={displayCountErrors.productList}
                            tone={displayCountErrors.productList ? "critical" : undefined}
                            onInput={(e: any) => {
                              const r = parseDisplayCountInput(readValue(e), 1, 250, 250);
                              setDisplayCountErrors((prev) => ({
                                ...prev,
                                productList: r.error ?? undefined,
                              }));
                              if (r.shouldUpdate) {
                                setSettings((s) => ({
                                  ...s,
                                  productList: {
                                    ...(s.productList ?? {}),
                                    initialLimit: r.value,
                                  },
                                }));
                              }
                            }}
                            onChange={(e: any) => {
                              const r = parseDisplayCountInput(readValue(e), 1, 250, 250);
                              setDisplayCountErrors((prev) => ({
                                ...prev,
                                productList: r.error ?? undefined,
                              }));
                              if (r.shouldUpdate) {
                                setSettings((s) => ({
                                  ...s,
                                  productList: {
                                    ...(s.productList ?? {}),
                                    initialLimit: r.value,
                                  },
                                }));
                              }
                            }}
                          />
                          <s-text tone="subdued" size="small">
                            出庫・入庫・ロス・棚卸の商品リスト表示に適用。最大250件、推奨250件。
                          </s-text>

                          <s-text-field
                            type="text"
                            inputMode="numeric"
                            pattern="[0-9]*"
                            label="検索リスト"
                            value={String(settings.searchList?.initialLimit ?? 50)}
                            helpText={displayCountErrors.searchList}
                            tone={displayCountErrors.searchList ? "critical" : undefined}
                            onInput={(e: any) => {
                              const r = parseDisplayCountInput(readValue(e), 1, 50, 50);
                              setDisplayCountErrors((prev) => ({
                                ...prev,
                                searchList: r.error ?? undefined,
                              }));
                              if (r.shouldUpdate) {
                                setSettings((s) => ({
                                  ...s,
                                  searchList: {
                                    ...(s.searchList ?? {}),
                                    initialLimit: r.value,
                                  },
                                }));
                              }
                            }}
                            onChange={(e: any) => {
                              const r = parseDisplayCountInput(readValue(e), 1, 50, 50);
                              setDisplayCountErrors((prev) => ({
                                ...prev,
                                searchList: r.error ?? undefined,
                              }));
                              if (r.shouldUpdate) {
                                setSettings((s) => ({
                                  ...s,
                                  searchList: {
                                    ...(s.searchList ?? {}),
                                    initialLimit: r.value,
                                  },
                                }));
                              }
                            }}
                          />
                          <s-text tone="subdued" size="small">
                            出庫・入庫・ロス・棚卸の検索結果表示に適用。最大50件、推奨50件。
                          </s-text>
                        </s-stack>
                      </div>
                    </div>
                  </div>
                </s-box>
              </>
            )}

            {/* ② 出庫設定タブ（出庫設定 + 配送設定） */}
            {activeTab === "outbound" && (
              <>
                {/* 出庫設定：左（タイトル＋説明） / 右（白カード） */}
                <s-box padding="base">
                  <div
                    style={{
                      display: "flex",
                      gap: "24px",
                      alignItems: "flex-start",
                      flexWrap: "wrap",
                    }}
                  >
                    {/* 左：タイトル＋説明（PCでは約260px、SPでは横幅いっぱいに折り返し） */}
                    <div style={{ flex: "1 1 260px", minWidth: 0 }}>
                      <div
                        style={{
                          fontWeight: 600,
                          fontSize: 14,
                          marginBottom: 4,
                        }}
                      >
                        出庫設定
                      </div>
                      <s-text tone="subdued" size="small">
                        出庫処理で強制キャンセル（在庫を戻す処理）を許可するかどうかを設定します。
                      </s-text>
                    </div>

                    {/* 右：白カード（強制キャンセル許可） */}
                    <div style={{ flex: "1 1 320px", minWidth: 280 }}>
                      <div
                        style={{
                          background: "#ffffff",
                          borderRadius: 12,
                          boxShadow: "0 0 0 1px #e1e3e5",
                          padding: 16,
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            gap: "12px",
                            alignItems: "center",
                            flexWrap: "wrap",
                          }}
                        >
                          <label
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "6px",
                              cursor: "pointer",
                            }}
                          >
                            <input
                              type="radio"
                              name="allowForceCancel"
                              checked={(settings.outbound?.allowForceCancel ?? true) === true}
                              onChange={() =>
                                setSettings((s) => ({
                                  ...s,
                                  outbound: { ...(s.outbound ?? {}), allowForceCancel: true },
                                }))
                              }
                            />
                            <span>許可</span>
                          </label>
                          <label
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "6px",
                              cursor: "pointer",
                            }}
                          >
                            <input
                              type="radio"
                              name="allowForceCancel"
                              checked={(settings.outbound?.allowForceCancel ?? true) === false}
                              onChange={() =>
                                setSettings((s) => ({
                                  ...s,
                                  outbound: { ...(s.outbound ?? {}), allowForceCancel: false },
                                }))
                              }
                            />
                            <span>不許可</span>
                          </label>
                        </div>
                      </div>
                    </div>
                  </div>
                </s-box>

                {/* 配送情報：左（タイトル＋説明） / 右（白カード） */}
                <s-box padding="base">
                  <div
                    style={{
                      display: "flex",
                      gap: "24px",
                      alignItems: "flex-start",
                      flexWrap: "wrap",
                    }}
                  >
                    {/* 左：タイトル＋説明（PCでは約260px、SPでは横幅いっぱいに折り返し） */}
                    <div style={{ flex: "1 1 260px", minWidth: 0 }}>
                      <div
                        style={{
                          fontWeight: 600,
                          fontSize: 14,
                          marginBottom: 4,
                        }}
                      >
                        配送情報
                      </div>
                      <s-text tone="subdued" size="small">
                        任意：配送業者＝直接入力・日付空白・時間未選択。
                        <br />
                        必須：配送業者＝配送設定の表示順1・翌日日付・午前中をデフォルトで入力します。
                      </s-text>
                    </div>

                    {/* 右：白カード（任意/必須） */}
                    <div style={{ flex: "1 1 320px", minWidth: 280 }}>
                      <div
                        style={{
                          background: "#ffffff",
                          borderRadius: 12,
                          boxShadow: "0 0 0 1px #e1e3e5",
                          padding: 16,
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            gap: "12px",
                            alignItems: "center",
                            flexWrap: "wrap",
                          }}
                        >
                          <label
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "6px",
                              cursor: "pointer",
                            }}
                          >
                            <input
                              type="radio"
                              name="shippingRequired"
                              checked={(settings.outbound?.shippingRequired ?? false) === false}
                              onChange={() =>
                                setSettings((s) => ({
                                  ...s,
                                  outbound: { ...(s.outbound ?? {}), shippingRequired: false },
                                }))
                              }
                            />
                            <span>任意</span>
                          </label>
                          <label
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "6px",
                              cursor: "pointer",
                            }}
                          >
                            <input
                              type="radio"
                              name="shippingRequired"
                              checked={(settings.outbound?.shippingRequired ?? false) === true}
                              onChange={() =>
                                setSettings((s) => ({
                                  ...s,
                                  outbound: { ...(s.outbound ?? {}), shippingRequired: true },
                                }))
                              }
                            />
                            <span>必須</span>
                          </label>
                        </div>
                      </div>
                    </div>
                  </div>
                </s-box>

                <s-divider />

                {/* 配送設定：左（タイトル＋説明） / 右（白カード群） */}
                <s-box padding="base">
                  <div
                    style={{
                      display: "flex",
                      gap: "24px",
                      alignItems: "flex-start",
                      flexWrap: "wrap",
                    }}
                  >
                    {/* 左：タイトル＋説明（PCでは約260px、SPでは横幅いっぱいに折り返し） */}
                    <div style={{ flex: "1 1 260px", minWidth: 0 }}>
                      <div
                        style={{
                          fontWeight: 600,
                          fontSize: 14,
                          marginBottom: 4,
                        }}
                      >
                        配送設定
                      </div>
                      <s-text tone="subdued" size="small">
                        アプリ表示名と Shopify のプリセット company を設定します。
                        <br />
                        例：Yamato (JA) / Sagawa (JA) / Japan Post (JA)
                      </s-text>
                    </div>

                    {/* 右：白カード（「その他（配送会社入力）」表示フラグ＋プリセット＆キャリア一覧） */}
                    <div style={{ flex: "1 1 320px", minWidth: 280 }}>
                      <div
                        style={{
                          background: "#ffffff",
                          borderRadius: 12,
                          boxShadow: "0 0 0 1px #e1e3e5",
                          padding: 16,
                        }}
                      >
                        <s-stack gap="base">
                          {/* 「その他（配送会社入力）」表示フラグ */}
                          <s-stack gap="base">
                            <s-stack direction="inline" gap="small" alignItems="center">
                              <s-text emphasis="bold" size="small">
                                「その他（配送会社入力）」の表示
                              </s-text>
                            </s-stack>
                            <s-stack direction="inline" gap="base" inlineAlignment="start">
                              <label
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: "6px",
                                  cursor: "pointer",
                                }}
                              >
                                <input
                                  type="radio"
                                  name="outbound_allowCustomCarrier"
                                  checked={(settings.outbound?.allowCustomCarrier ?? true) === true}
                                  onChange={() =>
                                    setSettings((s) => ({
                                      ...s,
                                      outbound: {
                                        ...(s.outbound ?? {}),
                                        allowCustomCarrier: true,
                                      },
                                    }))
                                  }
                                />
                                <span>表示する</span>
                              </label>
                              <label
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: "6px",
                                  cursor: "pointer",
                                }}
                              >
                                <input
                                  type="radio"
                                  name="outbound_allowCustomCarrier"
                                  checked={(settings.outbound?.allowCustomCarrier ?? true) === false}
                                  onChange={() =>
                                    setSettings((s) => ({
                                      ...s,
                                      outbound: {
                                        ...(s.outbound ?? {}),
                                        allowCustomCarrier: false,
                                      },
                                    }))
                                  }
                                />
                                <span>表示しない</span>
                              </label>
                            </s-stack>
                            <s-divider />
                          </s-stack>
                          <s-button onClick={() => setShowCarrierPresets((v) => !v)}>
                            {showCarrierPresets ? "プリセットを閉じる" : "プリセットを表示"}
                          </s-button>

                          {showCarrierPresets ? (
                            <s-box padding="base" background="subdued">
                              <s-stack gap="base">
                                <s-text emphasis="bold" size="small">
                                  グローバル（代表）
                                </s-text>
                                <s-stack gap="tight">
                                  {COMPANY_PRESETS_GLOBAL.map((name) => (
                                    <s-text key={name} tone="subdued" size="small">
                                      • {name}
                                    </s-text>
                                  ))}
                                </s-stack>
                                <s-divider />
                                <s-text emphasis="bold" size="small">
                                  日本（追加分）
                                </s-text>
                                <s-stack gap="tight">
                                  {COMPANY_PRESETS_JP_EXTRA.map((name) => (
                                    <s-text key={name} tone="subdued" size="small">
                                      • {name}
                                    </s-text>
                                  ))}
                                </s-stack>
                              </s-stack>
                            </s-box>
                          ) : null}

                          {settings.carriers.length === 0 ? (
                            <s-box padding="base">
                              <s-text tone="subdued">
                                配送会社が登録されていません
                              </s-text>
                            </s-box>
                          ) : (
                            <s-stack gap="base">
                              {settings.carriers.map((c, index) => (
                                <s-box key={c.id} padding="base" background="subdued">
                                  <s-stack gap="base">
                                    <s-stack
                                      direction="inline"
                                      gap="base"
                                      inlineAlignment="space-between"
                                    >
                                      <s-text emphasis="bold" size="small">
                                        表示順: {index + 1}
                                      </s-text>
                                    </s-stack>
                                    <s-text-field
                                      label="表示名（POSに出す）"
                                      value={c.label}
                                      onInput={(e: any) =>
                                        updateCarrier(c.id, { label: readValue(e) })
                                      }
                                      onChange={(e: any) =>
                                        updateCarrier(c.id, { label: readValue(e) })
                                      }
                                    />
                                    <s-text-field
                                      label="company（Shopifyプリセット）"
                                      value={c.company}
                                      onInput={(e: any) =>
                                        updateCarrier(c.id, { company: readValue(e) })
                                      }
                                      onChange={(e: any) =>
                                        updateCarrier(c.id, { company: readValue(e) })
                                      }
                                      helpText="例：Yamato (JA) / Sagawa (JA) / Japan Post (JA)"
                                    />
                                    <s-stack
                                      direction="inline"
                                      gap="base"
                                      inlineAlignment="center"
                                    >
                                      <s-button
                                        size="small"
                                        onClick={() =>
                                          updateCarrier(c.id, { company: "Yamato (JA)" })
                                        }
                                      >
                                        Yamato
                                      </s-button>
                                      <s-button
                                        size="small"
                                        onClick={() =>
                                          updateCarrier(c.id, { company: "Sagawa (JA)" })
                                        }
                                      >
                                        Sagawa
                                      </s-button>
                                      <s-button
                                        size="small"
                                        onClick={() =>
                                          updateCarrier(c.id, {
                                            company: "Japan Post (JA)",
                                          })
                                        }
                                      >
                                        Japan Post
                                      </s-button>
                                      <s-box inlineSize="fill" />
                                      <s-button
                                        tone="critical"
                                        size="small"
                                        onClick={() => removeCarrier(c.id)}
                                      >
                                        削除
                                      </s-button>
                                      <s-stack direction="inline" gap="tight">
                                        <s-button
                                          size="small"
                                          disabled={index === 0}
                                          onClick={() => moveCarrierUp(c.id)}
                                        >
                                          ↑
                                        </s-button>
                                        <s-button
                                          size="small"
                                          disabled={index === settings.carriers.length - 1}
                                          onClick={() => moveCarrierDown(c.id)}
                                        >
                                          ↓
                                        </s-button>
                                      </s-stack>
                                    </s-stack>
                                  </s-stack>
                                </s-box>
                              ))}
                            </s-stack>
                          )}

                          <s-box padding="base">
                            <s-stack
                              direction="inline"
                              gap="base"
                              inlineAlignment="start"
                            >
                              <s-button onClick={addCarrier}>配送会社を追加</s-button>
                              <s-button onClick={resetCarriersToDefault}>
                                デフォルトに戻す
                              </s-button>
                            </s-stack>
                          </s-box>
                        </s-stack>
                      </div>
                    </div>
                  </div>
                </s-box>
              </>
            )}

            {/* ③ 入庫設定タブ */}
            {activeTab === "inbound" && (
              <>
                {/* 過剰入庫許可：左（タイトル＋説明） / 右（白カード） */}
                <s-box padding="base">
                  <div
                    style={{
                      display: "flex",
                      gap: "24px",
                      alignItems: "flex-start",
                      flexWrap: "wrap",
                    }}
                  >
                    {/* 左：タイトル＋説明（PCでは約260px、SPでは横幅いっぱいに折り返し） */}
                    <div style={{ flex: "1 1 260px", minWidth: 0 }}>
                      <div
                        style={{
                          fontWeight: 600,
                          fontSize: 14,
                          marginBottom: 4,
                        }}
                      >
                        過剰入庫許可
                      </div>
                      <s-text tone="subdued" size="small">
                        予定数量を超える入庫を許可するかどうかを設定します。
                      </s-text>
                    </div>

                    {/* 右：白カード（ラジオ） */}
                    <div style={{ flex: "1 1 320px", minWidth: 280 }}>
                      <div
                        style={{
                          background: "#ffffff",
                          borderRadius: 12,
                          boxShadow: "0 0 0 1px #e1e3e5",
                          padding: 16,
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            gap: "12px",
                            alignItems: "center",
                            flexWrap: "wrap",
                          }}
                        >
                          <label
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "6px",
                              cursor: "pointer",
                            }}
                          >
                            <input
                              type="radio"
                              name="allowOverReceive"
                              checked={(settings.inbound?.allowOverReceive ?? true) === true}
                              onChange={() =>
                                setSettings((s) => ({
                                  ...s,
                                  inbound: { ...(s.inbound ?? {}), allowOverReceive: true },
                                }))
                              }
                            />
                            <span>許可</span>
                          </label>
                          <label
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "6px",
                              cursor: "pointer",
                            }}
                          >
                            <input
                              type="radio"
                              name="allowOverReceive"
                              checked={(settings.inbound?.allowOverReceive ?? true) === false}
                              onChange={() =>
                                setSettings((s) => ({
                                  ...s,
                                  inbound: { ...(s.inbound ?? {}), allowOverReceive: false },
                                }))
                              }
                            />
                            <span>不許可</span>
                          </label>
                        </div>
                      </div>
                    </div>
                  </div>
                </s-box>

                {/* 予定外入庫許可：左（タイトル＋説明） / 右（白カード） */}
                <s-box padding="base">
                  <div
                    style={{
                      display: "flex",
                      gap: "24px",
                      alignItems: "flex-start",
                      flexWrap: "wrap",
                    }}
                  >
                    {/* 左：タイトル＋説明（PCでは約260px、SPでは横幅いっぱいに折り返し） */}
                    <div style={{ flex: "1 1 260px", minWidth: 0 }}>
                      <div
                        style={{
                          fontWeight: 600,
                          fontSize: 14,
                          marginBottom: 4,
                        }}
                      >
                        予定外入庫許可
                      </div>
                      <s-text tone="subdued" size="small">
                        予定にない商品の入庫を許可するかどうかを設定します。
                      </s-text>
                    </div>

                    {/* 右：白カード（ラジオ） */}
                    <div style={{ flex: "1 1 320px", minWidth: 280 }}>
                      <div
                        style={{
                          background: "#ffffff",
                          borderRadius: 12,
                          boxShadow: "0 0 0 1px #e1e3e5",
                          padding: 16,
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            gap: "12px",
                            alignItems: "center",
                            flexWrap: "wrap",
                          }}
                        >
                          <label
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "6px",
                              cursor: "pointer",
                            }}
                          >
                            <input
                              type="radio"
                              name="allowExtraReceive"
                              checked={(settings.inbound?.allowExtraReceive ?? true) === true}
                              onChange={() =>
                                setSettings((s) => ({
                                  ...s,
                                  inbound: { ...(s.inbound ?? {}), allowExtraReceive: true },
                                }))
                              }
                            />
                            <span>許可</span>
                          </label>
                          <label
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "6px",
                              cursor: "pointer",
                            }}
                          >
                            <input
                              type="radio"
                              name="allowExtraReceive"
                              checked={(settings.inbound?.allowExtraReceive ?? true) === false}
                              onChange={() =>
                                setSettings((s) => ({
                                  ...s,
                                  inbound: { ...(s.inbound ?? {}), allowExtraReceive: false },
                                }))
                              }
                            />
                            <span>不許可</span>
                          </label>
                        </div>
                      </div>
                    </div>
                  </div>
                </s-box>
              </>
            )}

            {/* ④ 仕入設定タブ：仕入先設定 */}
            {activeTab === "purchase" && (
              <s-box padding="base">
                <div
                  style={{
                    display: "flex",
                    gap: "24px",
                    alignItems: "flex-start",
                    flexWrap: "wrap",
                  }}
                >
                  {/* 左：タイトル＋説明（PCでは約260px、SPでは横幅いっぱいに折り返し） */}
                  <div style={{ flex: "1 1 260px", minWidth: 0 }}>
                    <div
                      style={{
                        fontWeight: 600,
                        fontSize: 14,
                        marginBottom: 4,
                      }}
                    >
                      仕入設定
                    </div>
                    <s-text tone="subdued" size="small">
                      仕入先と仕入先コードを登録します。
                      <br />
                      例：倉庫名や卸業者やメーカー名などを登録しておくと、仕入履歴の集計がしやすくなります。
                    </s-text>
                  </div>

                  {/* 右：白カード（仕入先設定＋「その他（仕入先入力）」表示フラグ） */}
                  <div style={{ flex: "1 1 320px", minWidth: 280 }}>
                    <div
                      style={{
                        background: "#ffffff",
                        borderRadius: 12,
                        boxShadow: "0 0 0 1px #e1e3e5",
                        padding: 16,
                      }}
                    >
                      {/* 「その他（仕入先入力）」表示フラグ */}
                      <s-stack gap="base" style={{ marginBottom: 16 }}>
                        <s-stack direction="inline" gap="small" alignItems="center">
                          <s-text emphasis="bold" size="small">
                            「その他（仕入先入力）」の表示
                          </s-text>
                        </s-stack>
                        <s-stack direction="inline" gap="base" inlineAlignment="start">
                          <label
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "6px",
                              cursor: "pointer",
                            }}
                          >
                            <input
                              type="radio"
                              name="purchase_allowCustomSupplier"
                              checked={(settings.purchase?.allowCustomSupplier ?? true) === true}
                              onChange={() =>
                                setSettings((s) => ({
                                  ...s,
                                  purchase: {
                                    ...(s.purchase ?? {}),
                                    allowCustomSupplier: true,
                                  },
                                }))
                              }
                            />
                            <span>表示する</span>
                          </label>
                          <label
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "6px",
                              cursor: "pointer",
                            }}
                          >
                            <input
                              type="radio"
                              name="purchase_allowCustomSupplier"
                              checked={(settings.purchase?.allowCustomSupplier ?? true) === false}
                              onChange={() =>
                                setSettings((s) => ({
                                  ...s,
                                  purchase: {
                                    ...(s.purchase ?? {}),
                                    allowCustomSupplier: false,
                                  },
                                }))
                              }
                            />
                            <span>表示しない</span>
                          </label>
                        </s-stack>
                        <s-divider />
                      </s-stack>
                      {(!settings.suppliers || settings.suppliers.length === 0) ? (
                        <s-box padding="base">
                          <s-text tone="subdued">
                            仕入先が登録されていません
                          </s-text>
                        </s-box>
                      ) : (
                        <s-stack gap="base">
                          {(settings.suppliers ?? []).map((sp, index) => (
                            <s-box key={sp.id} padding="base" background="subdued">
                              <s-stack gap="base">
                                <s-stack
                                  direction="inline"
                                  gap="base"
                                  inlineAlignment="space-between"
                                >
                                  <s-text emphasis="bold" size="small">
                                    表示順: {index + 1}
                                  </s-text>
                                </s-stack>
                                <s-text-field
                                  label="仕入先"
                                  value={sp.name}
                                  onInput={(e: any) =>
                                    updateSupplier(sp.id, { name: readValue(e) })
                                  }
                                  onChange={(e: any) =>
                                    updateSupplier(sp.id, { name: readValue(e) })
                                  }
                                />
                                <s-text-field
                                  label="仕入先コード（任意）"
                                  value={sp.code ?? ""}
                                  onInput={(e: any) =>
                                    updateSupplier(sp.id, { code: readValue(e) })
                                  }
                                  onChange={(e: any) =>
                                    updateSupplier(sp.id, { code: readValue(e) })
                                  }
                                  helpText="任意の管理用コード（空欄でも問題ありません）"
                                />
                                <s-stack direction="inline" gap="base" inlineAlignment="end">
                                  <s-box inlineSize="fill" />
                                  <s-button
                                    tone="critical"
                                    size="small"
                                    onClick={() => removeSupplier(sp.id)}
                                  >
                                    削除
                                  </s-button>
                                  <s-stack direction="inline" gap="tight">
                                    <s-button
                                      size="small"
                                      disabled={index === 0}
                                      onClick={() => moveSupplierUp(sp.id)}
                                    >
                                      ↑
                                    </s-button>
                                    <s-button
                                      size="small"
                                      disabled={
                                        index === (settings.suppliers ?? []).length - 1
                                      }
                                      onClick={() => moveSupplierDown(sp.id)}
                                    >
                                      ↓
                                    </s-button>
                                  </s-stack>
                                </s-stack>
                              </s-stack>
                            </s-box>
                          ))}
                        </s-stack>
                      )}

                      <s-box padding="base">
                        <s-stack direction="inline" gap="base" inlineAlignment="start">
                          <s-button onClick={addSupplier}>仕入先を追加</s-button>
                        </s-stack>
                      </s-box>
                    </div>
                  </div>
                </div>
              </s-box>
            )}

            {/* ⑤ 発注設定タブ：発注先マスタ使用/不使用＋CSV出力項目設定 */}
            {activeTab === "order" && (
              <>
                {/* ① 発注先マスタ使用/不使用のラジオボタン */}
                <s-box padding="base">
                  <div
                    style={{
                      display: "flex",
                      gap: "24px",
                      alignItems: "flex-start",
                      flexWrap: "wrap",
                    }}
                  >
                    {/* 左：タイトル＋説明 */}
                    <div style={{ flex: "1 1 260px", minWidth: 0 }}>
                      <div
                        style={{
                          fontWeight: 600,
                          fontSize: 14,
                          marginBottom: 4,
                        }}
                      >
                        仕入先マスタの使用
                      </div>
                      <s-text tone="subdued" size="small">
                        POSアプリで仕入先マスタを使用するかどうかを設定します。
                        <br />
                        未使用にすると、仕入先項目が表示されません。
                      </s-text>
                    </div>

                    {/* 右：白カード（ラジオボタン） */}
                    <div style={{ flex: "1 1 320px", minWidth: 280 }}>
                      <div
                        style={{
                          background: "#ffffff",
                          borderRadius: 12,
                          boxShadow: "0 0 0 1px #e1e3e5",
                          padding: 16,
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            gap: "12px",
                            alignItems: "center",
                            flexWrap: "wrap",
                          }}
                        >
                          <label
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "6px",
                              cursor: "pointer",
                            }}
                          >
                            <input
                              type="radio"
                              name="useDestinationMaster"
                              checked={(settings.order?.useDestinationMaster ?? false) === true}
                              onChange={() =>
                                setSettings((s) => ({
                                  ...s,
                                  order: {
                                    ...s.order,
                                    useDestinationMaster: true,
                                    destinations: s.order?.destinations ?? [],
                                    csvExportColumns: s.order?.csvExportColumns,
                                  },
                                }))
                              }
                            />
                            <span>仕入先マスタを使用する</span>
                          </label>
                          <label
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "6px",
                              cursor: "pointer",
                            }}
                          >
                            <input
                              type="radio"
                              name="useDestinationMaster"
                              checked={(settings.order?.useDestinationMaster ?? false) === false}
                              onChange={() =>
                                setSettings((s) => ({
                                  ...s,
                                  order: {
                                    ...s.order,
                                    useDestinationMaster: false,
                                    destinations: s.order?.destinations ?? [],
                                    csvExportColumns: s.order?.csvExportColumns,
                                  },
                                }))
                              }
                            />
                            <span>仕入先マスタを使用しない（非表示）</span>
                          </label>
                        </div>
                      </div>
                    </div>
                  </div>
                </s-box>

                {/* ③ CSV出力項目設定 - 左に説明、右に設定内容、出力順序とチェックを一緒に */}
                <s-box padding="base">
                  <div
                    style={{
                      display: "flex",
                      gap: "24px",
                      alignItems: "flex-start",
                      flexWrap: "wrap",
                    }}
                  >
                    {/* 左：タイトル＋説明 */}
                    <div style={{ flex: "1 1 260px", minWidth: 0 }}>
                      <div
                        style={{
                          fontWeight: 600,
                          fontSize: 14,
                          marginBottom: 4,
                        }}
                      >
                        CSV出力項目設定
                      </div>
                      <s-text tone="subdued" size="small">
                        発注CSV出力時に含める項目を選択し、並び順を変更できます。
                        <br />
                        チェックを外すとその項目はCSVに出力されません。
                        <br />
                        並び順は上下ボタンまたは数字入力で変更できます。
                        <br />
                        <br />
                        <strong>項目名の変更について：</strong>
                        <br />
                        各項目の入力欄にデフォルト値が薄く表示されます。クリックしてカスタム名を入力すると、CSV出力時にその名前が使用されます。
                        <br />
                        空欄のままフォーカスを外すと、デフォルト値に戻ります。
                      </s-text>
                    </div>

                    {/* 右：白カード（CSV出力項目一覧 - チェックボックスと並び順を一緒に） */}
                    <div style={{ flex: "1 1 320px", minWidth: 280 }}>
                      <div
                        style={{
                          background: "#ffffff",
                          borderRadius: 12,
                          boxShadow: "0 0 0 1px #e1e3e5",
                          padding: 16,
                        }}
                      >
                        <s-stack gap="base">
                          {/* 選択された項目の並び順表示（チェックボックス付き） */}
                          <div>
                            {(settings.order?.csvExportColumns || DEFAULT_ORDER_CSV_COLUMNS).length === 0 ? (
                              <s-box padding="base">
                                <s-text tone="subdued">選択された項目がありません</s-text>
                              </s-box>
                            ) : (
                              <s-stack gap="tight">
                                {(settings.order?.csvExportColumns || DEFAULT_ORDER_CSV_COLUMNS).map((col, index) => (
                                  <div
                                    key={col}
                                    style={{
                                      position: "relative",
                                      display: "flex",
                                      alignItems: "center",
                                      gap: "8px",
                                      padding: "8px 12px",
                                      background: "#f6f6f7",
                                      borderRadius: "6px",
                                    }}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={true}
                                      onChange={() => toggleCsvColumn(col)}
                                      disabled={(settings.order?.csvExportColumns || DEFAULT_ORDER_CSV_COLUMNS).length === 1}
                                      style={{ cursor: (settings.order?.csvExportColumns || DEFAULT_ORDER_CSV_COLUMNS).length === 1 ? "not-allowed" : "pointer" }}
                                    />
                                    <input
                                      type="number"
                                      min={1}
                                      max={(settings.order?.csvExportColumns || DEFAULT_ORDER_CSV_COLUMNS).length}
                                      defaultValue={index + 1}
                                      key={`${col}-${index}`} // 位置が変わったときに再レンダリング
                                      onChange={(e) => {
                                        const newPos = parseInt(e.target.value, 10);
                                        if (!isNaN(newPos) && newPos >= 1 && newPos <= (settings.order?.csvExportColumns || DEFAULT_ORDER_CSV_COLUMNS).length) {
                                          moveCsvColumnToPosition(col, newPos);
                                        }
                                      }}
                                      onBlur={(e) => {
                                        // フォーカスが外れたときに値が範囲外の場合は現在の位置に戻す
                                        const current = settings.order?.csvExportColumns || DEFAULT_ORDER_CSV_COLUMNS;
                                        const currentIndex = current.indexOf(col);
                                        const inputValue = parseInt(e.target.value, 10);
                                        if (isNaN(inputValue) || inputValue < 1 || inputValue > current.length) {
                                          e.target.value = String(currentIndex + 1);
                                        }
                                      }}
                                      style={{
                                        width: "50px",
                                        padding: "4px 6px",
                                        fontSize: "12px",
                                        textAlign: "center",
                                        border: "1px solid #e1e3e5",
                                        borderRadius: "4px",
                                      }}
                                    />
                                    <div style={{ position: "relative", flex: 1, minWidth: "100px" }}>
                                      <input
                                        type="text"
                                        value={settings.order?.csvExportColumnLabels?.[col] ?? ""}
                                        onChange={(e) => updateCsvColumnLabel(col, e.target.value)}
                                        onBlur={(e) => {
                                          // 空欄のままフォーカスを外した場合はデフォルト値に戻す（カスタムラベルを削除）
                                          const trimmed = e.target.value.trim();
                                          if (!trimmed) {
                                            updateCsvColumnLabel(col, "");
                                          }
                                        }}
                                        style={{
                                          width: "100%",
                                          padding: "4px 8px",
                                          fontSize: "13px",
                                          border: "1px solid #e1e3e5",
                                          borderRadius: "4px",
                                          backgroundColor: "#ffffff",
                                          color: settings.order?.csvExportColumnLabels?.[col] ? "#000000" : "transparent", // カスタムラベルがない場合は透明（後ろの薄いテキストが見える）
                                          zIndex: 1,
                                        }}
                                      />
                                      {/* カスタムラベルがない場合、デフォルト値を薄く表示（入力欄の後ろに配置） */}
                                      {!settings.order?.csvExportColumnLabels?.[col] && (
                                        <span
                                          style={{
                                            position: "absolute",
                                            left: "8px",
                                            top: "50%",
                                            transform: "translateY(-50%)",
                                            fontSize: "13px",
                                            color: "#999999",
                                            pointerEvents: "none",
                                            fontStyle: "italic",
                                            zIndex: 0,
                                          }}
                                        >
                                          {CSV_COLUMN_LABELS[col]}
                                        </span>
                                      )}
                                    </div>
                                    <s-stack direction="inline" gap="tight">
                                      <s-button
                                        size="small"
                                        disabled={index === 0}
                                        onClick={() => moveCsvColumnUp(col)}
                                      >
                                        ↑
                                      </s-button>
                                      <s-button
                                        size="small"
                                        disabled={
                                          index === (settings.order?.csvExportColumns || DEFAULT_ORDER_CSV_COLUMNS).length - 1
                                        }
                                        onClick={() => moveCsvColumnDown(col)}
                                      >
                                        ↓
                                      </s-button>
                                    </s-stack>
                                  </div>
                                ))}
                              </s-stack>
                            )}
                          </div>

                          <s-divider />

                          {/* 未選択の項目（チェックボックスで追加可能） */}
                          <div>
                            <s-text emphasis="bold" size="small" style={{ marginBottom: 8, display: "block" }}>
                              未選択の項目
                            </s-text>
                            {ALL_CSV_COLUMNS.filter((col) => !(settings.order?.csvExportColumns || DEFAULT_ORDER_CSV_COLUMNS).includes(col)).length === 0 ? (
                              <s-box padding="base">
                                <s-text tone="subdued">すべての項目が選択されています</s-text>
                              </s-box>
                            ) : (
                              <s-stack gap="tight">
                                {ALL_CSV_COLUMNS.filter((col) => !(settings.order?.csvExportColumns || DEFAULT_ORDER_CSV_COLUMNS).includes(col)).map((col) => (
                                  <label
                                    key={col}
                                    style={{
                                      display: "flex",
                                      alignItems: "center",
                                      gap: "8px",
                                      padding: "8px 12px",
                                      borderRadius: "6px",
                                      cursor: "pointer",
                                      border: "1px solid #e1e3e5",
                                    }}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={false}
                                      onChange={() => toggleCsvColumn(col)}
                                    />
                                    <span style={{ flex: 1, fontSize: "13px" }}>
                                      {settings.order?.csvExportColumnLabels?.[col] || CSV_COLUMN_LABELS[col]}
                                    </span>
                                  </label>
                                ))}
                              </s-stack>
                            )}
                          </div>

                          <s-box padding="base">
                            <s-stack direction="inline" gap="base" inlineAlignment="start">
                              <s-button size="small" onClick={resetCsvColumns}>
                                デフォルトに戻す
                              </s-button>
                            </s-stack>
                          </s-box>
                        </s-stack>
                      </div>
                    </div>
                  </div>
                </s-box>
              </>
            )}

            {/* ⑤ ロス設定タブ：ロス区分設定（lossReasons） */}
            {activeTab === "loss" && (
              <s-box padding="base">
                <div
                  style={{
                    display: "flex",
                    gap: "24px",
                    alignItems: "flex-start",
                    flexWrap: "wrap",
                  }}
                >
                  {/* 左：タイトル＋説明（PCでは約260px、SPでは横幅いっぱいに折り返し） */}
                  <div style={{ flex: "1 1 260px", minWidth: 0 }}>
                    <div
                      style={{
                        fontWeight: 600,
                        fontSize: 14,
                        marginBottom: 4,
                      }}
                    >
                      ロス設定
                    </div>
                    <s-text tone="subdued" size="small">
                      ロス登録で選べる「ロス区分（理由）」を設定します。
                      <br />
                      例：破損 / 紛失 などをあらかじめ登録しておくと、POSでのロス登録時に選択するだけで入力できます。
                    </s-text>
                  </div>

                  {/* 右：白カード（ロス区分一覧） */}
                  <div style={{ flex: "1 1 320px", minWidth: 280 }}>
                    <div
                      style={{
                        background: "#ffffff",
                        borderRadius: 12,
                        boxShadow: "0 0 0 1px #e1e3e5",
                        padding: 16,
                      }}
                    >
                      {/* 「その他（理由入力）」表示フラグ */}
                      <s-stack gap="base" style={{ marginBottom: 16 }}>
                        <s-text emphasis="bold" size="small">
                          「その他（理由入力）」を表示
                        </s-text>
                        <s-stack direction="inline" gap="base" inlineAlignment="start">
                          <label
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "6px",
                              cursor: "pointer",
                            }}
                          >
                            <input
                              type="radio"
                              name="loss_allowCustomReason"
                              checked={(settings.loss?.allowCustomReason ?? true) === true}
                              onChange={() =>
                                setSettings((s) => ({
                                  ...s,
                                  loss: {
                                    ...(s.loss ?? {}),
                                    allowCustomReason: true,
                                  },
                                }))
                              }
                            />
                            <span>表示する</span>
                          </label>
                          <label
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "6px",
                              cursor: "pointer",
                            }}
                          >
                            <input
                              type="radio"
                              name="loss_allowCustomReason"
                              checked={(settings.loss?.allowCustomReason ?? true) === false}
                              onChange={() =>
                                setSettings((s) => ({
                                  ...s,
                                  loss: {
                                    ...(s.loss ?? {}),
                                    allowCustomReason: false,
                                  },
                                }))
                              }
                            />
                            <span>表示しない</span>
                          </label>
                        </s-stack>
                        <s-divider />
                      </s-stack>
                      {(!settings.lossReasons || settings.lossReasons.length === 0) ? (
                        <s-box padding="base">
                          <s-text tone="subdued">
                            ロス区分が登録されていません。
                            <br />
                            「ロス区分を追加」ボタンから、破損・紛失などの区分を登録してください。
                          </s-text>
                        </s-box>
                      ) : (
                        <s-stack gap="base">
                          {(settings.lossReasons ?? []).map((lr, index) => (
                            <s-box key={lr.id} padding="base" background="subdued">
                              <s-stack gap="base">
                                <s-stack
                                  direction="inline"
                                  gap="base"
                                  inlineAlignment="space-between"
                                >
                                  <s-text emphasis="bold" size="small">
                                    表示順: {index + 1}
                                  </s-text>
                                </s-stack>
                                <s-text-field
                                  label="ロス区分名"
                                  value={lr.label}
                                  onInput={(e: any) =>
                                    updateLossReason(lr.id, { label: readValue(e) })
                                  }
                                  onChange={(e: any) =>
                                    updateLossReason(lr.id, { label: readValue(e) })
                                  }
                                  helpText="例）破損、紛失、その他 など"
                                />
                                <s-stack direction="inline" gap="base" inlineAlignment="end">
                                  <s-box inlineSize="fill" />
                                  <s-button
                                    tone="critical"
                                    size="small"
                                    onClick={() => removeLossReason(lr.id)}
                                  >
                                    削除
                                  </s-button>
                                  <s-stack direction="inline" gap="tight">
                                    <s-button
                                      size="small"
                                      disabled={index === 0}
                                      onClick={() => moveLossReasonUp(lr.id)}
                                    >
                                      ↑
                                    </s-button>
                                    <s-button
                                      size="small"
                                      disabled={
                                        index === (settings.lossReasons ?? []).length - 1
                                      }
                                      onClick={() => moveLossReasonDown(lr.id)}
                                    >
                                      ↓
                                    </s-button>
                                  </s-stack>
                                </s-stack>
                              </s-stack>
                            </s-box>
                          ))}
                        </s-stack>
                      )}

                      <s-box padding="base">
                        <s-stack direction="inline" gap="base" inlineAlignment="start">
                          <s-button onClick={addLossReason}>ロス区分を追加</s-button>
                        </s-stack>
                      </s-box>
                    </div>
                  </div>
                </div>
              </s-box>
            )}
          </s-stack>

          <s-divider />
        </s-stack>
      </s-scroll-box>
    </s-page>
  );
}
