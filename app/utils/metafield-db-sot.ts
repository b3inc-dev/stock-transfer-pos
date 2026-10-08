/**
 * Metafield → DB SoT 段階移行フラグ。
 * settings_v1 は metafield のまま。Transfer / Shipment は Shopify 正本（アプリ DB で二重管理しない）。
 *
 * 環境変数（任意）:
 * - METAFIELD_MIRROR_<TYPE>=1 … DB 書き込み成功後も metafield へミラー（移行期の POS 互換）
 * - METAFIELD_DB_SOT_<TYPE>=0 … 当該タイプの DB 優先読取を無効（緊急フォールバック）
 *
 * 既定: DB 優先読取 ON / metafield 書き込みは退職（ミラー OFF）。
 * POS は /api/pos-app-documents 経由で DB を読む。
 */

export type SotDocumentType =
  | "inventory_counts"
  | "product_groups"
  | "entries"
  | "daily_snapshots";

const ENV_MIRROR: Record<SotDocumentType, string> = {
  inventory_counts: "METAFIELD_MIRROR_INVENTORY_COUNTS",
  product_groups: "METAFIELD_MIRROR_PRODUCT_GROUPS",
  entries: "METAFIELD_MIRROR_ENTRIES",
  daily_snapshots: "METAFIELD_MIRROR_DAILY_SNAPSHOTS",
};

const ENV_SOT: Record<SotDocumentType, string> = {
  inventory_counts: "METAFIELD_DB_SOT_INVENTORY_COUNTS",
  product_groups: "METAFIELD_DB_SOT_PRODUCT_GROUPS",
  entries: "METAFIELD_DB_SOT_ENTRIES",
  daily_snapshots: "METAFIELD_DB_SOT_DAILY_SNAPSHOTS",
};

function envTruthy(name: string): boolean {
  const v = (process.env[name] || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function envFalsy(name: string): boolean {
  const v = (process.env[name] || "").trim().toLowerCase();
  return v === "0" || v === "false" || v === "no" || v === "off";
}

/** Admin/API が DB を優先して読むか（既定 true） */
export function preferDbSot(type: SotDocumentType): boolean {
  const key = ENV_SOT[type];
  if (envFalsy(key)) return false;
  return true;
}

/**
 * DB 書き込み成功後に metafield へも書くか。
 * 既定 false（書き込み退職）。移行期に POS が metafield のみのときだけミラーを ON にする。
 */
export function shouldMirrorMetafield(type: SotDocumentType): boolean {
  return envTruthy(ENV_MIRROR[type]);
}

/** metafield への新規書き込みを行うか（ミラー ON のときのみ） */
export function shouldWriteMetafield(type: SotDocumentType): boolean {
  return shouldMirrorMetafield(type);
}

export const APP_ENTRY_TYPES = ["loss", "adjustment", "purchase", "order_request"] as const;
export type AppEntryType = (typeof APP_ENTRY_TYPES)[number];

export function isAppEntryType(v: string): v is AppEntryType {
  return (APP_ENTRY_TYPES as readonly string[]).includes(v);
}
