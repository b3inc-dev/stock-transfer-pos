import { requestQuery, requestError, variantsFields, productLine, type RequestAdmin, type RequestLine } from "./outbound-requests.server";
import { withGraphQLRetry } from "./graphql-with-retry";
import { buildVariantSearchQuery } from "../../extensions/common/variantSearch.js";
import { parseProductCsv } from "./product-add-csv";
type Variant = Parameters<typeof productLine>[0];
type Page = { hasNextPage: boolean; endCursor: string | null };
const check = (condition: unknown, message: string) => { if (!condition) throw requestError(message); };
export async function catalogPage(admin: RequestAdmin, query: string, after = "", first = 50) {
  const result = await requestQuery<{ productVariants: { nodes: Variant[]; pageInfo: Page } }>(withGraphQLRetry(admin), `query RequestCatalog($query:String!,$after:String,$first:Int!){productVariants(first:$first,after:$after,query:$query){nodes{${variantsFields}}pageInfo{hasNextPage endCursor}}}`, { query, after: after || null, first });
  check(!result.productVariants.pageInfo.hasNextPage || Boolean(result.productVariants.pageInfo.endCursor), "商品の続きが取得できません。検索し直してください");
  return { products: result.productVariants.nodes.map(productLine), pageInfo: result.productVariants.pageInfo };
}
export async function collectionChoices(admin: RequestAdmin, query: string, after = "") {
  const result = await requestQuery<{ collections: { nodes: { id: string; title: string }[]; pageInfo: Page } }>(withGraphQLRetry(admin), "query RequestCollections($query:String!,$after:String){collections(first:50,after:$after,query:$query){nodes{id title}pageInfo{hasNextPage endCursor}}}", { query: query.slice(0, 100), after: after || null });
  check(!result.collections.pageInfo.hasNextPage || Boolean(result.collections.pageInfo.endCursor), "コレクションの続きが取得できません");
  return { collections: result.collections.nodes, pageInfo: result.collections.pageInfo };
}
export async function collectionProducts(admin: RequestAdmin, id: string) {
  check(/^gid:\/\/shopify\/Collection\/\d+$/.test(id), "コレクションを選び直してください");
  const products: RequestLine[] = [], cursors = new Set<string>(); let after = "";
  do {
    const page = await catalogPage(admin, "collection:" + id.split("/").pop(), after, 100);
    products.push(...page.products); check(products.length <= 3000, "3000商品を超えています。商品検索またはCSVで分けて追加してください");
    if (!page.pageInfo.hasNextPage) break;
    const cursor = page.pageInfo.endCursor!; check(!cursors.has(cursor), "商品の続きが取得できません"); cursors.add(cursor); after = cursor;
  } while (after);
  return [...new Map(products.map(product => [product.variantId, { ...product, quantity: 1 }])).values()];
}
export async function resolveProductCsv(admin: RequestAdmin, csv: string) {
  const rows = (() => { try { return parseProductCsv(csv); } catch (error) { throw requestError(error instanceof Error ? error.message : "CSVを確認してください"); } })(), skus = [...new Set(rows.filter(row => !row.error).map(row => row.sku))];
  const matches = new Map<string, Map<string, RequestLine>>();
  for (let i = 0; i < skus.length; i += 25) {
    const batch = skus.slice(i, i + 25), query = batch.map(sku => 'sku:"' + sku.replace(/[\\"]/g, '\\$&') + '"').join(" OR "), cursors = new Set<string>(); let after = "", count = 0;
    do {
      const page = await catalogPage(admin, query, after, 100); count += page.products.length; check(count <= 5000, "SKUの候補が多すぎます。CSVを分けるか、商品検索から選択してください");
      for (const product of page.products) if (batch.includes(product.sku)) { if (!matches.has(product.sku)) matches.set(product.sku, new Map()); matches.get(product.sku)!.set(product.variantId, product); }
      if (!page.pageInfo.hasNextPage) break;
      const cursor = page.pageInfo.endCursor!; check(!cursors.has(cursor), "商品の続きが取得できません"); cursors.add(cursor); after = cursor;
    } while (after);
  }
  return rows.map(row => {
    if (row.error) return row;
    const found = [...(matches.get(row.sku)?.values() || [])];
    return found.length === 1 ? { ...row, product: { ...found[0], quantity: row.quantity } } : { ...row, error: found.length ? "同じSKUの商品が複数あります。商品検索から選択してください" : "一致する商品が見つかりません" };
  });
}
export async function requestProductAdd(admin: RequestAdmin, command: string, form: FormData) {
  const query = String(form.get("query") || "").trim().slice(0, 100), after = String(form.get("after") || "");
  check(after.length < 2048, "ページを選び直してください");
  if (command === "search") return query ? catalogPage(admin, buildVariantSearchQuery(query), after) : { products: [], pageInfo: { hasNextPage: false, endCursor: null } };
  if (command === "collections") return collectionChoices(admin, query, after);
  if (command === "collectionProducts") return { products: await collectionProducts(admin, String(form.get("collectionId") || "")) };
  if (command === "csv") return { csvRows: await resolveProductCsv(admin, String(form.get("csv") || "")) };
  throw requestError("商品追加の方法を選択してください");
}
