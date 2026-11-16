type HistoryRow = { variantId?: string | null; inventoryItemId?: unknown; sku?: string | null };

export function historyProductKey(row: HistoryRow): string {
  if (row.variantId) return row.variantId;
  const id = row.inventoryItemId;
  if (typeof id !== "string") return "";
  if (/^gid:\/\/shopify\/InventoryItem\/\d+$/.test(id)) return id;
  return /^\d+$/.test(id) ? "gid://shopify/InventoryItem/" + id : "";
}

// Keep previously resolvable variants within the existing query cap before adding fallback lookups.
export function historyProductKeys(rows: HistoryRow[]): string[] {
  const variants = new Set<string>();
  const items = new Set<string>();
  for (const row of rows) {
    const key = historyProductKey(row);
    if (row.variantId) variants.add(key);
    else if (key) items.add(key);
  }
  return [...variants, ...items];
}

export const HISTORY_PRODUCTS_QUERY = `#graphql
  query VariantsForChangeHistory($ids: [ID!]!) {
    nodes(ids: $ids) {
      id
      ... on ProductVariant { ...HistoryVariant }
      ... on InventoryItem { variant { ...HistoryVariant } }
    }
  }
  fragment HistoryVariant on ProductVariant {
    id
    displayName
    barcode
    sku
    selectedOptions { name value }
    product { title }
  }
`;

type Variant = {
  id: string;
  displayName?: string | null;
  barcode?: string | null;
  sku?: string | null;
  selectedOptions?: Array<{ value?: string }> | null;
  product?: { title?: string } | null;
};
type HistoryNode = Variant & { variant?: Variant | null };
export type HistoryProduct = ReturnType<typeof productFields>;

function productFields(variant: Variant) {
  const options = variant.selectedOptions ?? [];
  return {
    productTitle: variant.product?.title ?? variant.displayName ?? "",
    barcode: variant.barcode ?? "",
    currentSku: variant.sku ?? "",
    option1: options[0]?.value ?? "",
    option2: options[1]?.value ?? "",
    option3: options[2]?.value ?? "",
  };
}

export function indexHistoryProducts(target: Map<string, HistoryProduct>, nodes: Array<HistoryNode | null>) {
  for (const node of nodes) {
    if (!node?.id) continue;
    const variant = node.id.startsWith("gid://shopify/InventoryItem/") ? node.variant : node;
    if (variant?.id.startsWith("gid://shopify/ProductVariant/")) {
      target.set(node.id, productFields(variant));
    }
  }
}

// A missing variant ID distinguishes unavailable event metadata from a known variant with no SKU.
export function recoveredHistorySku(row: HistoryRow, product?: HistoryProduct): string {
  return !row.variantId && !row.sku ? product?.currentSku ?? "" : "";
}
