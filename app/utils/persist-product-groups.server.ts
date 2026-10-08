/**
 * 商品グループ保存（DB SoT + 任意 metafield ミラー）
 */
import { replaceProductGroupsForShop } from "./product-group-document.server";
import { shouldWriteMetafield } from "./metafield-db-sot";

const NS = "stock_transfer_pos";
const PRODUCT_GROUPS_KEY = "product_groups_v1";
const PRODUCT_GROUP_IDS_KEY = "product_group_ids_v1";
const PRODUCT_GROUP_NAMES_KEY = "product_group_names_v1";

export function productGroupsMetafieldInputs(
  ownerId: string,
  productGroups: Array<{ id: string; name?: string | null }>
) {
  return [
    { ownerId, namespace: NS, key: PRODUCT_GROUPS_KEY, type: "json", value: JSON.stringify(productGroups) },
    {
      ownerId,
      namespace: NS,
      key: PRODUCT_GROUP_IDS_KEY,
      type: "json",
      value: JSON.stringify(productGroups.map((g) => g.id)),
    },
    {
      ownerId,
      namespace: NS,
      key: PRODUCT_GROUP_NAMES_KEY,
      type: "json",
      value: JSON.stringify(Object.fromEntries(productGroups.map((g) => [g.id, g.name ?? ""]))),
    },
  ];
}

export async function persistProductGroupsForShop(
  admin: { graphql: (q: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response> },
  ownerId: string,
  shop: string,
  productGroups: Array<{ id: string; name?: string | null }>
): Promise<{ ok: boolean; error?: string }> {
  if (!shop) return { ok: false, error: "shop が必要です" };
  const dbRes = await replaceProductGroupsForShop(shop, productGroups);
  if (!dbRes.ok) return { ok: false, error: dbRes.error || "商品グループの DB 保存に失敗しました" };
  if (!shouldWriteMetafield("product_groups")) return { ok: true };

  const saveResp = await admin.graphql(
    `#graphql
      mutation SaveProductGroups($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          userErrors { field message }
        }
      }
    `,
    { variables: { metafields: productGroupsMetafieldInputs(ownerId, productGroups) } }
  );
  const saveJson = (await saveResp.json()) as {
    data?: { metafieldsSet?: { userErrors?: Array<{ message?: string }> } };
  };
  const errs = saveJson?.data?.metafieldsSet?.userErrors ?? [];
  if (errs.length) {
    return { ok: false, error: errs.map((e) => e.message ?? "").join(" / ") };
  }
  return { ok: true };
}
