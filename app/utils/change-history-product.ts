type HistoryRow = { variantId?: string | null; inventoryItemId?: unknown; sku?: string | null };

export function historyProductKey(row: HistoryRow): string {
  if (row.variantId) return row.variantId;
  const id = row.inventoryItemId;
  if (typeof id !== "string") return "";
  if (/^gid:\/\/shopify\/InventoryItem\/\d+$/.test(id)) return id;
  return /^\d+$/.test(id) ? "gid://shopify/InventoryItem/" + id : "";
}

export function historyInventoryFilterIds(ids: string[]): string[] {
  const values = new Set<string>();
  for (const value of ids) {
    const id = value.trim();
    const gid = historyProductKey({ inventoryItemId: id });
    if (gid) {
      values.add(gid);
      values.add(gid.slice("gid://shopify/InventoryItem/".length));
    } else if (id) {
      values.add(id); // Preserve exact-match semantics for legacy values.
    }
  }
  return [...values];
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

const VARIANT_FIELDS = `fragment HistoryVariant on ProductVariant {
  id displayName barcode sku selectedOptions { name value } product { title }
}`;

const VARIANTS_QUERY = `#graphql
  query VariantsForChangeHistory($ids: [ID!]!) {
    nodes(ids: $ids) { ...HistoryVariant }
  }
  ${VARIANT_FIELDS}
`;

const ITEMS_QUERY = `#graphql
  query ItemsForChangeHistory($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on InventoryItem {
        id
        variants(first: 2) { nodes { ...HistoryVariant } pageInfo { hasNextPage } }
      }
    }
  }
  ${VARIANT_FIELDS}
`;

export function historyProductBatches(rows: HistoryRow[], maxBatches: number) {
  const keys = historyProductKeys(rows);
  const items = keys.filter(key => key.startsWith("gid://shopify/InventoryItem/"));
  const variants = keys.filter(key => !key.startsWith("gid://shopify/InventoryItem/"));
  const batches = [];
  for (const [ids, size, query] of [[variants, 250, VARIANTS_QUERY], [items, 25, ITEMS_QUERY]] as const) {
    for (let i = 0; i < ids.length && batches.length < maxBatches; i += size) {
      batches.push({ ids: ids.slice(i, i + size), query });
    }
  }
  return batches;
}

type Variant = {
  id: string;
  displayName?: string | null;
  barcode?: string | null;
  sku?: string | null;
  selectedOptions?: Array<{ value?: string }> | null;
  product?: { title?: string } | null;
};
type HistoryNode = Variant & { variants?: { nodes: Variant[]; pageInfo: { hasNextPage: boolean } } | null };
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
    let variant = node;
    if (node.id.startsWith("gid://shopify/InventoryItem/")) {
      const connection = node.variants;
      if (connection?.nodes?.length !== 1 || connection.pageInfo?.hasNextPage !== false) continue;
      variant = connection.nodes[0];
    }
    if (variant?.id.startsWith("gid://shopify/ProductVariant/")) {
      target.set(node.id, productFields(variant));
    }
  }
}

// A missing variant ID distinguishes unavailable event metadata from a known variant with no SKU.
export function recoveredHistorySku(row: HistoryRow, product?: HistoryProduct): string {
  return !row.variantId && !row.sku ? product?.currentSku ?? "" : "";
}
