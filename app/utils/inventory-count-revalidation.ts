/**
 * 棚卸画面（/app/inventory-count）の読み取り専用 action。
 * これらはメタフィールド・DB に書き込まないため、完了後に loader を再実行する必要がない。
 */
export const INVENTORY_COUNT_READ_ONLY_ACTIONS: ReadonlySet<string> = new Set([
  "search_variants_by_sku",
  "searchCollectionsForInventoryCount",
  "searchVariantsForInventoryCount",
  "getCollectionsByIds",
  "getVariantsByInventoryItemIds",
  "getVariantsBySkus",
  "preview_csv_inventory_count",
  "get_collection_products",
  "get_incomplete_group_products",
  "get_count_full",
]);

const INVENTORY_COUNT_PATH = "/app/inventory-count";

type FormDataLike = { get(name: string): unknown } | null | undefined;

export function isInventoryCountReadOnlyAction(formMethod: string | null | undefined, formData: FormDataLike): boolean {
  if (!formMethod || formMethod.toUpperCase() !== "POST" || !formData) return false;
  const raw = formData.get("action") ?? formData.get("actionType");
  return typeof raw === "string" && INVENTORY_COUNT_READ_ONLY_ACTIONS.has(raw.trim());
}

export function isInventoryCountFormAction(formAction: string | null | undefined): boolean {
  if (!formAction) return false;
  try {
    const pathname = new URL(formAction, "http://localhost").pathname.replace(/\.data$/, "").replace(/\/+$/, "");
    return pathname === INVENTORY_COUNT_PATH;
  } catch {
    return false;
  }
}

/** 親ルート（app.tsx）用：棚卸画面の読み取り専用 POST のときだけ true。他画面の挙動は変えない */
export function isInventoryCountReadOnlySubmission(args: {
  formMethod?: string | null;
  formAction?: string | null;
  formData?: FormDataLike;
}): boolean {
  return isInventoryCountFormAction(args.formAction) && isInventoryCountReadOnlyAction(args.formMethod, args.formData);
}
