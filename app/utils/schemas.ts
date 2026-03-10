// app/utils/schemas.ts
// Zod スキーマによる Metafield JSON のランタイムバリデーション
// 型定義は app/types.ts と一致させること

import { z } from "zod";
import type {
  SettingsV1,
  LossEntry,
  AdjustmentEntry,
  OrderRequestEntry,
  PurchaseEntry,
} from "../types";

// ==========================================================================
// 設定スキーマ
// ==========================================================================

const CarrierOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  company: z.string(),
  sortOrder: z.number().optional(),
});

const LossReasonOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  sortOrder: z.number().optional(),
});

const SupplierOptionSchema = z.object({
  id: z.string(),
  name: z.string(),
  code: z.string().optional(),
  sortOrder: z.number().optional(),
});

const OrderDestinationOptionSchema = z.object({
  id: z.string(),
  name: z.string(),
  code: z.string().optional(),
  sortOrder: z.number().optional(),
});

const DestinationGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  locationIds: z.array(z.string()),
});

const OrderCsvColumnSchema = z.enum([
  "orderId", "orderName", "locationName", "destination", "destinationCode",
  "date", "desiredDeliveryDate", "staffName", "note", "status",
  "productTitle", "sku", "barcode", "option1", "option2", "option3",
  "quantity", "arrivalDate", "inspectionDate", "cost", "price",
]);

export const SettingsV1Schema = z.object({
  version: z.literal(1),
  destinationGroups: z.array(DestinationGroupSchema).optional(),
  carriers: z.array(CarrierOptionSchema).default([]),
  suppliers: z.array(SupplierOptionSchema).optional(),
  lossReasons: z.array(LossReasonOptionSchema).optional(),
  loss: z.object({
    allowCustomReason: z.boolean().optional(),
    csvExportColumns: z.array(z.string()).optional(),
  }).optional(),
  order: z.object({
    useDestinationMaster: z.boolean().optional(),
    useDesiredDeliveryDate: z.boolean().optional(),
    desiredDeliveryQuickDays: z.array(z.number()).optional(),
    desiredDeliveryQuickDayLabels: z.record(z.string()).optional(),
    destinations: z.array(OrderDestinationOptionSchema).optional(),
    csvExportColumns: z.array(OrderCsvColumnSchema).optional(),
    csvExportColumnLabels: z.record(OrderCsvColumnSchema, z.string()).optional(),
  }).optional(),
  purchase: z.object({
    suppliers: z.array(SupplierOptionSchema).optional(),
    allowCustomSupplier: z.boolean().optional(),
    csvExportColumns: z.array(z.string()).optional(),
  }).optional(),
  visibleLocationIds: z.array(z.string()).optional(),
  outbound: z.object({
    allowForceCancel: z.boolean().optional(),
    historyInitialLimit: z.number().optional(),
    shippingRequired: z.boolean().optional(),
    allowCustomCarrier: z.boolean().optional(),
    arrivalQuickDays: z.array(z.number()).optional(),
    arrivalQuickDayLabels: z.record(z.string()).optional(),
  }).optional(),
  inbound: z.object({
    allowOverReceive: z.boolean().optional(),
    allowExtraReceive: z.boolean().optional(),
    listInitialLimit: z.number().optional(),
    csvExportColumns: z.array(z.string()).optional(),
  }).optional(),
  inventoryCount: z.object({
    allowExtraCount: z.boolean().optional(),
    csvExportColumns: z.array(z.string()).optional(),
  }).optional(),
  adjustment: z.object({
    csvExportColumns: z.array(z.string()).optional(),
  }).optional(),
  productList: z.object({
    initialLimit: z.number().optional(),
  }).optional(),
  searchList: z.object({
    initialLimit: z.number().optional(),
  }).optional(),
});

// ==========================================================================
// ロススキーマ
// ==========================================================================

const LossEntryItemSchema = z.object({
  id: z.string().optional(),
  inventoryItemId: z.string(),
  variantId: z.string().optional(),
  sku: z.string().optional(),
  barcode: z.string().optional(),
  title: z.string().optional(),
  option1: z.string().optional(),
  option2: z.string().optional(),
  option3: z.string().optional(),
  quantity: z.number(),
});

export const LossEntrySchema = z.object({
  id: z.string(),
  lossName: z.string().optional(),
  locationId: z.string(),
  locationName: z.string().optional(),
  date: z.string(),
  reason: z.string(),
  staffMemberId: z.string().nullable().optional(),
  staffName: z.string().nullable().optional(),
  items: z.array(LossEntryItemSchema),
  status: z.enum(["active", "cancelled"]),
  createdAt: z.string(),
  cancelledAt: z.string().optional(),
});

export const LossEntriesSchema = z.array(LossEntrySchema);

// ==========================================================================
// 調整スキーマ
// ==========================================================================

const AdjustmentEntryItemSchema = z.object({
  id: z.string().optional(),
  inventoryItemId: z.string(),
  variantId: z.string().optional(),
  sku: z.string().optional(),
  barcode: z.string().optional(),
  title: z.string().optional(),
  option1: z.string().optional(),
  option2: z.string().optional(),
  option3: z.string().optional(),
  currentQuantity: z.number().optional(),
  quantity: z.number(),
});

export const AdjustmentEntrySchema = z.object({
  id: z.string(),
  adjustmentName: z.string().optional(),
  locationId: z.string(),
  locationName: z.string().optional(),
  date: z.string(),
  memo: z.string(),
  staffMemberId: z.string().nullable().optional(),
  staffName: z.string().nullable().optional(),
  items: z.array(AdjustmentEntryItemSchema),
  status: z.enum(["active", "cancelled"]),
  createdAt: z.string(),
  cancelledAt: z.string().optional(),
});

export const AdjustmentEntriesSchema = z.array(AdjustmentEntrySchema);

// ==========================================================================
// 発注スキーマ
// ==========================================================================

const OrderRequestItemSchema = z.object({
  id: z.string().optional(),
  inventoryItemId: z.string(),
  variantId: z.string().optional(),
  sku: z.string().optional(),
  barcode: z.string().optional(),
  title: z.string().optional(),
  option1: z.string().optional(),
  option2: z.string().optional(),
  option3: z.string().optional(),
  quantity: z.number(),
  cost: z.number().optional(),
  price: z.number().optional(),
  isExtra: z.boolean().optional(),
});

export const OrderRequestEntrySchema = z.object({
  id: z.string(),
  orderName: z.string().optional(),
  locationId: z.string(),
  locationName: z.string().optional(),
  destination: z.string().optional(),
  date: z.string(),
  desiredDeliveryDate: z.string().optional(),
  note: z.string().optional(),
  staffName: z.string().optional(),
  items: z.array(OrderRequestItemSchema),
  approvedItems: z.array(OrderRequestItemSchema).optional(),
  status: z.enum(["pending", "shipped", "cancelled"]),
  createdAt: z.string(),
  linkedTransferId: z.string().nullable().optional(),
  arrivalDate: z.string().optional(),
  inspectionDate: z.string().optional(),
});

export const OrderRequestEntriesSchema = z.array(OrderRequestEntrySchema);

// ==========================================================================
// 仕入スキーマ
// ==========================================================================

export const PurchaseEntrySchema = z.object({
  id: z.string(),
  purchaseName: z.string(),
  sourceOrderId: z.string().optional(),
  locationId: z.string(),
  locationName: z.string().optional(),
  supplierId: z.string().optional(),
  supplierName: z.string().optional(),
  date: z.string(),
  desiredDeliveryDate: z.string().optional(),
  carrier: z.string().optional(),
  trackingNumber: z.string().optional(),
  expectedArrival: z.string().optional(),
  staffName: z.string().optional(),
  note: z.string().optional(),
  items: z.array(OrderRequestItemSchema),
  status: z.enum(["pending", "received", "cancelled"]),
  createdAt: z.string(),
  receivedAt: z.string().optional(),
  cancelledAt: z.string().optional(),
});

export const PurchaseEntriesSchema = z.array(PurchaseEntrySchema);

// ==========================================================================
// パーサーヘルパー関数
// ==========================================================================

/**
 * Metafield の JSON 文字列を安全にパースして型検証する汎用関数
 */
export function safeParseMetafield<T>(
  rawValue: unknown,
  schema: z.ZodType<T>,
  fallback: T,
  debugLabel?: string
): T {
  if (rawValue == null || rawValue === "") return fallback;
  try {
    const parsed = typeof rawValue === "string" ? JSON.parse(rawValue) : rawValue;
    const result = schema.safeParse(parsed);
    if (result.success) return result.data;
    if (debugLabel && process.env.NODE_ENV !== "production") {
      console.warn(`[safeParseMetafield] Validation failed for "${debugLabel}":`, result.error.issues);
    }
    return fallback;
  } catch {
    return fallback;
  }
}

/**
 * 設定 Metafield をパース・検証する
 */
export function parseSettings(rawValue: unknown): SettingsV1 {
  if (rawValue == null || rawValue === "") {
    return { version: 1, carriers: [] };
  }
  try {
    const parsed = typeof rawValue === "string" ? JSON.parse(rawValue) : rawValue;
    const result = SettingsV1Schema.safeParse(parsed);
    if (result.success) return result.data as SettingsV1;
    if (process.env.NODE_ENV !== "production") {
      console.warn("[parseSettings] Validation issues:", result.error.issues);
    }
    // バリデーション失敗時はデフォルト値でマージ（後方互換）
    return { version: 1, carriers: [], ...(typeof parsed === "object" && parsed !== null ? parsed : {}) } as SettingsV1;
  } catch {
    return { version: 1, carriers: [] };
  }
}

/**
 * ロスエントリ配列をパース・検証する
 */
export function parseLossEntries(rawValue: unknown): LossEntry[] {
  return safeParseMetafield(rawValue, LossEntriesSchema, [], "loss_entries_v1");
}

/**
 * 調整エントリ配列をパース・検証する
 */
export function parseAdjustmentEntries(rawValue: unknown): AdjustmentEntry[] {
  return safeParseMetafield(rawValue, AdjustmentEntriesSchema, [], "adjustment_entries_v1");
}

/**
 * 発注エントリ配列をパース・検証する
 */
export function parseOrderRequestEntries(rawValue: unknown): OrderRequestEntry[] {
  return safeParseMetafield(rawValue, OrderRequestEntriesSchema, [], "order_request_entries_v1");
}

/**
 * 仕入エントリ配列をパース・検証する
 */
export function parsePurchaseEntries(rawValue: unknown): PurchaseEntry[] {
  return safeParseMetafield(rawValue, PurchaseEntriesSchema, [], "purchase_entries_v1");
}
