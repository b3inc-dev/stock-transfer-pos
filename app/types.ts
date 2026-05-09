// app/types.ts
// アプリ全体で共有する型定義
// 各ルートファイルに散在していた型をここに集約する

// ==========================================================================
// 共通型
// ==========================================================================

export type LocationNode = { id: string; name: string };

/** 在庫変動アクティビティ種別 */
export type InventoryActivity =
  | "inbound_transfer"
  | "outbound_transfer"
  | "loss_entry"
  | "inventory_count"
  | "adjustment"
  | "purchase_entry"
  | "purchase_cancel"
  | "order_sales"
  | "refund"
  | "order_cancel"
  | "admin_webhook";

// ==========================================================================
// 設定（SettingsV1）関連型
// ==========================================================================

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

export type DestinationGroup = {
  id: string;
  name: string;
  locationIds: string[]; // ✅ origin も必ず含める（POS側で所属グループ判定に使う）
};

/** CSV出力項目の定義（発注） */
export type OrderCsvColumn =
  | "orderId"            // 発注ID
  | "orderName"          // 名称
  | "locationName"       // 発注店舗
  | "destination"        // 発注先
  | "destinationCode"    // 発注先コード（発注先マスタのコード）
  | "date"               // 日付
  | "desiredDeliveryDate" // 希望納品日
  | "staffName"          // 担当者
  | "note"               // 備考
  | "status"             // ステータス
  | "productTitle"       // 商品名
  | "sku"                // SKU
  | "barcode"            // JAN
  | "option1"            // オプション1
  | "option2"            // オプション2
  | "option3"            // オプション3
  | "quantity"           // 数量
  | "arrivalDate"        // 入荷日
  | "inspectionDate"     // 検品日
  | "cost"               // 原価
  | "price";             // 販売価格

export type SettingsV1 = {
  version: 1;
  destinationGroups?: DestinationGroup[]; // 非推奨（後方互換性のため残す）
  carriers: CarrierOption[];
  suppliers?: SupplierOption[]; // 旧フィールド（後方互換のため残す）
  lossReasons?: LossReasonOption[];
  loss?: {
    allowCustomReason?: boolean;
    csvExportColumns?: string[];
  };
  order?: {
    useDestinationMaster?: boolean;
    useDesiredDeliveryDate?: boolean;
    desiredDeliveryQuickDays?: number[];
    desiredDeliveryQuickDayLabels?: Record<string, string>;
    destinations?: OrderDestinationOption[];
    csvExportColumns?: OrderCsvColumn[];
    csvExportColumnLabels?: Partial<Record<OrderCsvColumn, string>>;
  };
  purchase?: {
    suppliers?: SupplierOption[];
    allowCustomSupplier?: boolean;
    csvExportColumns?: string[];
  };
  visibleLocationIds?: string[];
  outbound?: {
    allowForceCancel?: boolean;
    historyInitialLimit?: number;
    shippingRequired?: boolean;
    allowCustomCarrier?: boolean;
    arrivalQuickDays?: number[];
    arrivalQuickDayLabels?: Record<string, string>;
  };
  inbound?: {
    allowOverReceive?: boolean;
    allowExtraReceive?: boolean;
    listInitialLimit?: number;
    csvExportColumns?: string[];
  };
  inventoryCount?: {
    allowExtraCount?: boolean;
    csvExportColumns?: string[];
  };
  adjustment?: {
    csvExportColumns?: string[];
  };
  productList?: {
    initialLimit?: number;
  };
  searchList?: {
    initialLimit?: number;
  };
};

// ==========================================================================
// 在庫移動（Transfer）関連型
// ==========================================================================

export type TransferLineItem = {
  id: string;
  inventoryItemId: string;
  variantId?: string;
  sku?: string;
  barcode?: string;
  title?: string;
  option1?: string;
  option2?: string;
  option3?: string;
  quantity: number; // 予定数
  receivedQuantity?: number; // 入庫数
  isExtra?: boolean; // 予定外入庫フラグ
  shipmentId?: string;
  shipmentDisplayId?: string;
  shipmentStatus?: string;
};

export type GroupedLineItemsEntry = {
  shipmentMetadata: { id: string; displayId: string; status: string };
  items: TransferLineItem[];
};

export type TransferHistory = {
  id: string;
  name: string;
  status: string;
  note?: string;
  extrasCount?: number;
  dateCreated: string;
  totalQuantity: number;
  receivedQuantity: number;
  originLocationId: string;
  originLocationName: string;
  destinationLocationId: string;
  destinationLocationName: string;
  shipmentCount: number;
  lineItems: TransferLineItem[];
  type: "outbound" | "inbound";
};

// ==========================================================================
// ロス関連型
// ==========================================================================

export type LossEntryItem = {
  id?: string;
  inventoryItemId: string;
  variantId?: string;
  sku?: string;
  barcode?: string;
  title?: string;
  option1?: string;
  option2?: string;
  option3?: string;
  quantity: number;
};

export type LossEntry = {
  id: string;
  lossName?: string;
  locationId: string;
  locationName?: string;
  date: string;
  reason: string;
  staffMemberId?: string | null;
  staffName?: string | null;
  items: LossEntryItem[];
  status: "active" | "cancelled";
  createdAt: string;
  cancelledAt?: string;
};

// ==========================================================================
// 調整関連型
// ==========================================================================

export type AdjustmentEntryItem = {
  id?: string;
  inventoryItemId: string;
  variantId?: string;
  sku?: string;
  barcode?: string;
  title?: string;
  option1?: string;
  option2?: string;
  option3?: string;
  currentQuantity?: number;
  quantity: number;
};

export type AdjustmentEntry = {
  id: string;
  adjustmentName?: string;
  locationId: string;
  locationName?: string;
  date: string;
  memo: string;
  staffMemberId?: string | null;
  staffName?: string | null;
  items: AdjustmentEntryItem[];
  status: "active" | "cancelled";
  createdAt: string;
  cancelledAt?: string;
};

// ==========================================================================
// 発注・仕入関連型
// ==========================================================================

export type OrderRequestItem = {
  id?: string;
  inventoryItemId: string;
  variantId?: string;
  sku?: string;
  barcode?: string;
  title?: string;
  option1?: string;
  option2?: string;
  option3?: string;
  quantity: number;
  cost?: number;
  price?: number;
  isExtra?: boolean;
};

export type OrderRequestEntry = {
  id: string;
  orderName?: string;
  locationId: string;
  locationName?: string;
  destination?: string;
  date: string;
  desiredDeliveryDate?: string;
  note?: string;
  staffName?: string;
  items: OrderRequestItem[];
  approvedItems?: OrderRequestItem[];
  status: "pending" | "shipped" | "cancelled";
  createdAt: string;
  linkedTransferId?: string | null;
  arrivalDate?: string;
  inspectionDate?: string;
};

export type PurchaseEntry = {
  id: string;
  purchaseName: string;
  sourceOrderId?: string;
  locationId: string;
  locationName?: string;
  supplierId?: string;
  supplierName?: string;
  date: string;
  desiredDeliveryDate?: string;
  carrier?: string;
  trackingNumber?: string;
  expectedArrival?: string;
  staffName?: string;
  note?: string;
  items: OrderRequestItem[];
  status: "pending" | "received" | "cancelled";
  createdAt: string;
  receivedAt?: string;
  cancelledAt?: string;
};

// ==========================================================================
// セッション・API 用（any 削減）
// ==========================================================================

/** findSessionsByShop で取得するセッションの形（POS/API ルートで使用） */
export interface SessionWithShop {
  id: string;
  shop: string;
  isOnline?: boolean;
  expires?: number | Date;
  refreshToken?: string | null;
  accessToken: string;
}

/** sessionStorage に findSessionsByShop がある場合の型（PrismaSessionStorage の拡張） */
export type SessionStorageWithFindByShop = {
  findSessionsByShop(shop: string): Promise<SessionWithShop[]>;
};

/** Admin GraphQL の request のみ持つクライアント（Webhook 等で自前 fetch する場合） */
export interface AdminGraphQLRequestClient {
  request(options: { data: string; variables?: Record<string, unknown> }): Promise<Response>;
}

// ==========================================================================
// 棚卸（inventory-count）用（any 削減）
// ==========================================================================

/** 棚卸オブジェクト／カウント一覧要素の共通形（groupItems, cancelledGroupIds 等） */
export interface InventoryCountLike {
  groupItems?: Record<string, unknown[]>;
  cancelledGroupIds?: string[];
  productGroupNames?: string[];
  status?: string;
  completedAt?: string;
  items?: unknown[];
  inventoryItemIds?: string[];
  countName?: string;
  [key: string]: unknown;
}

/** 棚卸明細1行（inventoryItemId, currentQuantity, actualQuantity, isExtra 等） */
export interface InventoryCountEntryLike {
  inventoryItemId?: string;
  id?: string;
  currentQuantity?: number;
  actualQuantity?: number;
  isExtra?: boolean;
  groupId?: string;
  barcode?: string;
  sku?: string;
  title?: string;
  groupName?: string;
  isGroupCompleted?: boolean;
  [key: string]: unknown;
}

/** フォーム入力イベント（currentTarget / currentValue の value を読む用） */
export type InputLikeEvent = { currentTarget?: { value?: string }; currentValue?: { value?: string } };
