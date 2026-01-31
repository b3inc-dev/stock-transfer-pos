// app/routes/app.inventory-count.tsx
// 棚卸（商品グループ設定・棚卸ID発行・履歴管理）画面
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useState, useMemo, useEffect, useRef } from "react";
import { authenticate } from "../shopify.server";

const NS = "stock_transfer_pos";
const PRODUCT_GROUPS_KEY = "product_groups_v1";
const INVENTORY_COUNTS_KEY = "inventory_counts_v1";

export type LocationNode = { id: string; name: string };
export type CollectionNode = { 
  id: string; 
  title: string;
  image?: {
    url: string;
    altText?: string;
  } | null;
};

export type CollectionConfig = {
  collectionId: string; // コレクションID
  selectedVariantIds: string[]; // 選択されたバリアントIDの配列（空配列=全選択）
  totalVariantCount?: number; // コレクション内の全バリアント数（0/0表示用）
};

export type ProductGroup = {
  id: string; // グループID（自動生成）
  name: string; // グループ名
  collectionIds: string[]; // ShopifyコレクションIDの配列（後方互換性のため残す）
  collectionConfigs?: CollectionConfig[]; // コレクションごとの選択商品設定（新規）
  productIds?: string[]; // 直接指定する商品ID（オプション）
  variantIds?: string[]; // 直接指定するバリアントID（オプション）
  skus?: string[]; // グループ名＋SKUで指定する場合のSKU一覧（コレクションに依存しない）
  inventoryItemIds?: string[]; // ✅ 商品グループに含まれるinventoryItemIdのリスト（判定用に保存）
  parentGroupId?: string; // 親グループID（ネスト用）
  createdAt: string; // 作成日時（ISO）
};

export type CollectionProduct = {
  variantId: string;
  inventoryItemId: string;
  productTitle: string;
  variantTitle: string;
  sku: string;
  barcode?: string;
};

export type InventoryCount = {
  id: string; // 棚卸ID（自動生成: count_${timestamp}_${random}）
  countName?: string; // 表示用名称（#C0000形式）
  locationId: string; // ロケーションID
  locationName?: string;
  productGroupId?: string; // 商品グループID（後方互換性のため残す）
  productGroupIds: string[]; // 商品グループIDの配列（複数選択対応）
  productGroupName?: string; // 後方互換性のため残す
  productGroupNames?: string[]; // 商品グループ名の配列
  inventoryItemIdsByGroup?: Record<string, string[]>; // ✅ 商品グループごとのinventoryItemIds（生成時の状態を保持）
  status: "draft" | "in_progress" | "completed" | "cancelled";
  createdAt: string; // 作成日時（ISO）
  completedAt?: string; // 完了日時（ISO）
  items?: Array<{
    inventoryItemId: string;
    variantId?: string;
    sku?: string;
    title?: string;
    currentQuantity?: number; // 現在の在庫数
    actualQuantity?: number; // 実数
    delta?: number; // 差分（actualQuantity - currentQuantity）
  }>;
};

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin } = await authenticate.admin(request);

  // ロケーション・メタフィールドは単発取得。コレクション・商品はページネーションで全件取得
  const [locResp, appResp] = await Promise.all([
    admin.graphql(
      `#graphql
        query Locations($first: Int!) {
          locations(first: $first) { nodes { id name } }
        }
      `,
      { variables: { first: 250 } }
    ),
    admin.graphql(
      `#graphql
        query InventoryCountData {
          currentAppInstallation {
            productGroupsMetafield: metafield(namespace: "${NS}", key: "${PRODUCT_GROUPS_KEY}") { value }
            inventoryCountsMetafield: metafield(namespace: "${NS}", key: "${INVENTORY_COUNTS_KEY}") { value }
          }
        }
      `
    ),
  ]);

  const locData = await locResp.json();
  const appData = await appResp.json();

  const locations: LocationNode[] = locData?.data?.locations?.nodes ?? [];

  // コレクション: ページネーションで全件取得（250件以上対応）
  const collections: CollectionNode[] = [];
  let collectionsCursor: string | null = null;
  const COLLECTIONS_QUERY = `#graphql
    query Collections($first: Int!, $after: String) {
      collections(first: $first, after: $after) {
        nodes {
          id
          title
          image {
            url
            altText
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;
  do {
    const collectionsResp: Response = await admin.graphql(COLLECTIONS_QUERY, {
      variables: { first: 250, after: collectionsCursor },
    });
    const collectionsData = (await collectionsResp.json()) as { data?: { collections?: { nodes?: CollectionNode[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string } } } };
    const nodes = collectionsData?.data?.collections?.nodes ?? [];
    const pageInfo = collectionsData?.data?.collections?.pageInfo ?? {};
    collections.push(...nodes);
    collectionsCursor = pageInfo.hasNextPage ? pageInfo.endCursor ?? null : null;
  } while (collectionsCursor);

  let productGroups: ProductGroup[] = [];
  const groupsRaw = appData?.data?.currentAppInstallation?.productGroupsMetafield?.value;
  if (typeof groupsRaw === "string" && groupsRaw) {
    try {
      const parsed = JSON.parse(groupsRaw);
      productGroups = Array.isArray(parsed) ? parsed : [];
    } catch {
      productGroups = [];
    }
  }

  let inventoryCounts: InventoryCount[] = [];
  const countsRaw = appData?.data?.currentAppInstallation?.inventoryCountsMetafield?.value;
  if (typeof countsRaw === "string" && countsRaw) {
    try {
      const parsed = JSON.parse(countsRaw);
      inventoryCounts = Array.isArray(parsed) ? parsed : [];
      
      // ✅ 完了判定を修正：全グループが完了している場合のみ完了ステータスにする
      inventoryCounts = inventoryCounts.map((c) => {
        const allIds = Array.isArray(c.productGroupIds) && c.productGroupIds.length > 0
          ? c.productGroupIds
          : c.productGroupId ? [c.productGroupId] : [];
        
        if (allIds.length === 0) {
          // 商品グループがない場合は既存のステータスを保持
          return c;
        }
        
        const groupItemsMap = (c as any)?.groupItems && typeof (c as any).groupItems === "object" ? (c as any).groupItems : {};
        // ✅ 全グループが完了しているか判定：groupItems[id]が存在し、かつ配列の長さが0より大きい
        // ✅ InventoryCountProductGroupSelectionと同じロジック：各グループIDについて、groupItems[groupId]が存在し、かつ配列の長さが0より大きい場合に完了と判定
        const countItemsLegacy = Array.isArray(c.items) && c.items.length > 0 ? c.items : [];
        const allDone = allIds.every((id) => {
          let groupItems = Array.isArray(groupItemsMap[id]) ? groupItemsMap[id] : [];
          // ✅ 問題2の修正: アプリ側と同じロジックに統一（複数グループでもitemsからフィルタリングを試みる）
          // ✅ 後方互換性：groupItemsがない場合、itemsフィールドから該当グループの商品をフィルタリング
          // ✅ InventoryCountProductGroupSelectionと同じロジック：groupItemsが空の場合、itemsフィールドから該当グループの商品をフィルタリング
          if (groupItems.length === 0 && countItemsLegacy.length > 0) {
            // ✅ 商品グループのinventoryItemIdsを取得（保存されている場合）
            const productGroup = productGroups.find((g) => g.id === id);
            const groupInventoryItemIds = productGroup?.inventoryItemIds || [];
            
            if (groupInventoryItemIds.length > 0) {
              // ✅ inventoryItemIdsが保存されている場合、それを使ってフィルタリング
              const groupInventoryItemIdsSet = new Set(groupInventoryItemIds);
              groupItems = countItemsLegacy.filter((item) => {
                const itemId = String(item?.inventoryItemId || "").trim();
                return groupInventoryItemIdsSet.has(itemId);
              });
            } else if (allIds.length === 1) {
              // ✅ 単一グループの場合、itemsフィールドのデータをそのまま使用（後方互換性）
              groupItems = countItemsLegacy;
            }
            // ✅ 複数グループでinventoryItemIdsが保存されていない場合は、groupItemsが空のまま（完了と判定しない）
          }
          // ✅ 完了判定：groupItemsが存在し、かつ配列の長さが0より大きい場合に完了と判定
          return groupItems.length > 0;
        });
        
        // ✅ 商品グループが1つの場合のみ、古いデータ形式（itemsフィールド）を後方互換性として使用
        // ✅ 複数商品グループがある場合は、必ずgroupItemsで判定する（itemsは使用しない）
        const isSingleGroup = allIds.length === 1;
        const hasItems = Array.isArray(c.items) && c.items.length > 0;
        const hasNoGroupItems = Object.keys(groupItemsMap).length === 0;
        const isCompleted = allDone || (isSingleGroup && hasItems && hasNoGroupItems);
        
        // ✅ 全グループが完了していない場合は必ず"in_progress"に設定（既存のstatusを保持しない）
        if (!isCompleted && c.status === "completed") {
          return {
            ...c,
            status: "in_progress",
            completedAt: undefined,
          };
        }
        
        // ✅ 全グループが完了している場合は"completed"に設定
        if (isCompleted && c.status !== "completed") {
          return {
            ...c,
            status: "completed",
            completedAt: c.completedAt || new Date().toISOString(),
          };
        }
        
        return c;
      });
    } catch {
      inventoryCounts = [];
    }
  }

  // SKU一覧: ページネーションで全商品・バリアントを取得（250件以上のショップ対応）。画面上で入力により絞り込み。
  const skuVariantList: Array<{ variantId: string; inventoryItemId: string; sku: string; barcode?: string; variantTitle: string; productTitle: string; title: string; option1?: string; option2?: string; option3?: string }> = [];
  try {
    const PRODUCTS_QUERY = `#graphql
      query ProductsWithVariants($first: Int!, $after: String, $variantsFirst: Int!) {
        products(first: $first, after: $after) {
          nodes {
            id
            title
            variants(first: $variantsFirst) {
              nodes {
                id
                title
                sku
                barcode
                inventoryItem { id }
                selectedOptions { name value }
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `;
    let productsCursor: string | null = null;
    const VARIANTS_FIRST = 250; // 商品あたり最大250バリアント（API上限）
    do {
      const skuResp: Response = await admin.graphql(PRODUCTS_QUERY, {
        variables: { first: 250, after: productsCursor, variantsFirst: VARIANTS_FIRST },
      });
      const skuJson = (await skuResp.json()) as { data?: { products?: { nodes?: unknown[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string } } } };
      const products = skuJson?.data?.products?.nodes ?? [];
      const pageInfo = skuJson?.data?.products?.pageInfo ?? {};
      for (const p of products) {
        const productTitle = p.title ?? "";
        for (const v of p.variants?.nodes ?? []) {
          const invId = v.inventoryItem?.id;
          if (!invId) continue;
          const opts = (v.selectedOptions as { name: string; value: string }[] | undefined) ?? [];
          const option1 = opts[0]?.value?.trim() ?? "";
          const option2 = opts[1]?.value?.trim() ?? "";
          const option3 = opts[2]?.value?.trim() ?? "";
          skuVariantList.push({
            variantId: v.id,
            inventoryItemId: invId,
            sku: v.sku ?? "",
            barcode: v.barcode ?? "",
            variantTitle: v.title ?? "",
            productTitle,
            title: productTitle + (v.title && v.title !== "Default Title" ? ` / ${v.title}` : ""),
            option1: option1 || undefined,
            option2: option2 || undefined,
            option3: option3 || undefined,
          });
        }
      }
      productsCursor = pageInfo.hasNextPage ? (pageInfo.endCursor ?? null) : null;
    } while (productsCursor);
  } catch {
    // skuVariantList は空のまま
  }

  return { locations, collections, productGroups, inventoryCounts, skuVariantList };
}

function generateId(prefix: string): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 9);
  return `${prefix}_${timestamp}_${random}`;
}

const SKU_BATCH_SIZE = 25;
const SKU_BATCH_CONCURRENCY = 10;

/**
 * SKU一覧をShopify APIで検索し、対応するinventoryItemIdの配列を返す。
 * コレクションに依存せず「グループ名＋SKU」で商品グループを定義するために使用。
 * 行数が多いCSV用に、複数SKUを1クエリ（OR）でバッチ取得し、並列実行で時間を短縮する。
 */
async function resolveSkusToInventoryItemIds(
  admin: { graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response> },
  skus: string[]
): Promise<string[]> {
  const trimmed = [...new Set(skus.map((s) => String(s ?? "").trim()).filter(Boolean))];
  if (trimmed.length === 0) return [];

  const escapeSku = (s: string) => `sku:${s.replace(/"/g, '\\"')}`;

  if (trimmed.length <= 3) {
    const ids: string[] = [];
    for (const sku of trimmed) {
      try {
        const resp = await admin.graphql(
          `#graphql
            query VariantBySku($first: Int!, $query: String!) {
              productVariants(first: $first, query: $query) {
                nodes { id inventoryItem { id } }
              }
            }
          `,
          { variables: { first: 1, query: escapeSku(sku) } }
        );
        const json = await resp.json();
        const nodes = json?.data?.productVariants?.nodes ?? [];
        for (const node of nodes) {
          if (node?.inventoryItem?.id && !ids.includes(node.inventoryItem.id)) {
            ids.push(node.inventoryItem.id);
          }
        }
      } catch (e) {
        console.warn(`SKU resolve failed for "${sku}":`, e);
      }
    }
    return ids;
  }

  const batches: string[][] = [];
  for (let i = 0; i < trimmed.length; i += SKU_BATCH_SIZE) {
    batches.push(trimmed.slice(i, i + SKU_BATCH_SIZE));
  }

  const inventoryItemIds: string[] = [];
  const seen = new Set<string>();

  const runBatch = async (batch: string[]): Promise<string[]> => {
    const queryStr = batch.map(escapeSku).join(" OR ");
    if (!queryStr) return [];
    try {
      const resp = await admin.graphql(
        `#graphql
          query VariantsBySkus($first: Int!, $query: String!) {
            productVariants(first: $first, query: $query) {
              nodes { id inventoryItem { id } }
            }
          }
        `,
        { variables: { first: batch.length + 10, query: queryStr } }
      );
      const json = await resp.json();
      const nodes = json?.data?.productVariants?.nodes ?? [];
      const ids: string[] = [];
      for (const node of nodes) {
        if (node?.inventoryItem?.id) ids.push(node.inventoryItem.id);
      }
      return ids;
    } catch {
      const ids: string[] = [];
      for (const sku of batch) {
        try {
          const resp = await admin.graphql(
            `#graphql
              query VariantBySku($first: Int!, $query: String!) {
                productVariants(first: $first, query: $query) {
                  nodes { id inventoryItem { id } }
                }
              }
            `,
            { variables: { first: 1, query: escapeSku(sku) } }
          );
          const json = await resp.json();
          const nodes = json?.data?.productVariants?.nodes ?? [];
          for (const node of nodes) {
            if (node?.inventoryItem?.id && !ids.includes(node.inventoryItem.id)) ids.push(node.inventoryItem.id);
          }
        } catch {
          //
        }
      }
      return ids;
    }
  };

  for (let i = 0; i < batches.length; i += SKU_BATCH_CONCURRENCY) {
    const chunk = batches.slice(i, i + SKU_BATCH_CONCURRENCY);
    const results = await Promise.all(chunk.map(runBatch));
    for (const ids of results) {
      for (const id of ids) {
        if (!seen.has(id)) {
          seen.add(id);
          inventoryItemIds.push(id);
        }
      }
    }
  }

  return inventoryItemIds;
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionType = formData.get("action") as string;

  // SKU検索は metafield 不要のため先に実行（ownerId 未取得で早期 return されないようにする）
  if (actionType === "search_variants_by_sku") {
    const query = (formData.get("query") as string)?.trim();
    if (!query || query.length < 1) {
      return { ok: true, variants: [] };
    }
    try {
      const resp = await admin.graphql(
        `#graphql
          query SearchVariants($first: Int!, $query: String!) {
            productVariants(first: $first, query: $query) {
              nodes {
                id
                title
                sku
                barcode
                inventoryItem { id }
                product { title }
              }
            }
          }
        `,
        { variables: { first: 50, query: `sku:${query.replace(/"/g, '\\"')}` } }
      );
      const json = await resp.json();
      const nodes = json?.data?.productVariants?.nodes ?? [];
      const variants = nodes.map((n: { id: string; title?: string; sku?: string; barcode?: string; inventoryItem?: { id: string }; product?: { title?: string } }) => ({
        variantId: n.id,
        inventoryItemId: n.inventoryItem?.id,
        sku: n.sku ?? "",
        barcode: n.barcode ?? "",
        variantTitle: n.title ?? "",
        productTitle: n.product?.title ?? "",
        title: (n.product?.title ?? "") + (n.title && n.title !== "Default Title" ? ` / ${n.title}` : ""),
      })).filter((v: { inventoryItemId?: string }) => v.inventoryItemId);
      return { ok: true, variants };
    } catch (e) {
      console.warn("search_variants_by_sku failed:", e);
      return { ok: true, variants: [] };
    }
  }

  const appInstResp = await admin.graphql(
    `#graphql
      query GetAppInstallation {
        currentAppInstallation { id }
      }
    `
  );
  const appInstJson = await appInstResp.json();
  const ownerId = appInstJson?.data?.currentAppInstallation?.id as string;

  if (!ownerId) {
    return { ok: false, error: "currentAppInstallation.id が取得できませんでした" as const };
  }

  // 現在のデータを取得
  const currentResp = await admin.graphql(
    `#graphql
      query GetCurrentData {
        currentAppInstallation {
          productGroupsMetafield: metafield(namespace: "${NS}", key: "${PRODUCT_GROUPS_KEY}") { value }
          inventoryCountsMetafield: metafield(namespace: "${NS}", key: "${INVENTORY_COUNTS_KEY}") { value }
        }
      }
    `
  );
  const currentJson = await currentResp.json();
  let productGroups: ProductGroup[] = [];
  let inventoryCounts: InventoryCount[] = [];

  const groupsRaw = currentJson?.data?.currentAppInstallation?.productGroupsMetafield?.value;
  if (typeof groupsRaw === "string" && groupsRaw) {
    try {
      productGroups = JSON.parse(groupsRaw) || [];
    } catch {}
  }

  const countsRaw = currentJson?.data?.currentAppInstallation?.inventoryCountsMetafield?.value;
  if (typeof countsRaw === "string" && countsRaw) {
    try {
      inventoryCounts = JSON.parse(countsRaw) || [];
    } catch {}
  }

  if (actionType === "save_product_group") {
    const id = formData.get("id") as string;
    const name = formData.get("name") as string;
    const collectionIdsStr = formData.get("collectionIds") as string;
    const collectionIds = collectionIdsStr ? collectionIdsStr.split(",").filter(Boolean) : [];
    const collectionConfigsStr = formData.get("collectionConfigs") as string;
    let collectionConfigs: CollectionConfig[] = [];
    if (collectionConfigsStr) {
      try {
        collectionConfigs = JSON.parse(collectionConfigsStr);
      } catch {
        collectionConfigs = [];
      }
    }
    const inventoryItemIdsStr = formData.get("inventoryItemIds") as string;
    const skusStr = formData.get("skus") as string;
    let directInventoryItemIds: string[] = [];
    let directSkus: string[] = [];
    if (inventoryItemIdsStr) {
      try {
        directInventoryItemIds = JSON.parse(inventoryItemIdsStr);
        if (!Array.isArray(directInventoryItemIds)) directInventoryItemIds = [];
      } catch {}
    }
    if (skusStr) {
      try {
        directSkus = JSON.parse(skusStr);
        if (!Array.isArray(directSkus)) directSkus = [];
      } catch {}
    }

    if (!name?.trim()) {
      return { ok: false, error: "グループ名は必須です" as const };
    }

    // パターン: SKU選択から作成（inventoryItemIds を直接渡した場合）
    if (directInventoryItemIds.length > 0) {
      const index = id ? productGroups.findIndex((g) => g.id === id) : -1;
      // 編集時: 一覧にないSKU（preserved）の skus は既存グループから補完する
      let finalSkus: string[] = directSkus.length > 0 ? [...directSkus] : [];
      if (index >= 0 && directInventoryItemIds.length > directSkus.length) {
        const existing = productGroups[index];
        const existingIds = existing.inventoryItemIds ?? [];
        const existingSkus = existing.skus ?? [];
        for (let i = directSkus.length; i < directInventoryItemIds.length; i++) {
          const invId = directInventoryItemIds[i];
          const idx = existingIds.indexOf(invId);
          if (idx >= 0 && existingSkus[idx] !== undefined) finalSkus.push(existingSkus[idx]);
        }
      }
      const newGroup: ProductGroup = {
        id: index >= 0 ? productGroups[index].id : generateId("group"),
        name: name.trim(),
        collectionIds: index >= 0 ? productGroups[index].collectionIds ?? [] : [],
        collectionConfigs: index >= 0 ? productGroups[index].collectionConfigs : undefined,
        skus: finalSkus.length > 0 ? finalSkus : (index >= 0 ? productGroups[index].skus : undefined),
        inventoryItemIds: directInventoryItemIds,
        createdAt: index >= 0 ? (productGroups[index].createdAt ?? new Date().toISOString()) : new Date().toISOString(),
      };
      if (index >= 0) {
        productGroups[index] = { ...productGroups[index], ...newGroup };
      } else {
        productGroups.push(newGroup);
      }
      const saveResp = await admin.graphql(
        `#graphql
          mutation SaveProductGroups($metafields: [MetafieldsSetInput!]!) {
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
                key: PRODUCT_GROUPS_KEY,
                type: "json",
                value: JSON.stringify(productGroups),
              },
            ],
          },
        }
      );
      const saveJson = await saveResp.json();
      const errs = saveJson?.data?.metafieldsSet?.userErrors ?? [];
      if (errs.length) {
        return { ok: false, error: errs.map((e: { message?: string }) => e.message).join(" / ") as const };
      }
      return { ok: true };
    }

    // ✅ 商品グループに含まれる商品リスト（inventoryItemIds）を取得（コレクションから）
    const inventoryItemIds: string[] = [];
    try {
      for (const collectionId of collectionIds) {
        const config = collectionConfigs.find((c) => c.collectionId === collectionId);
        
        // コレクションから商品を取得
        const productsResp = await admin.graphql(
          `#graphql
            query CollectionProducts($id: ID!, $first: Int!) {
              collection(id: $id) {
                id
                title
                products(first: $first) {
                  nodes {
                    id
                    title
                    variants(first: 250) {
                      nodes {
                        id
                        title
                        sku
                        barcode
                        inventoryItem {
                          id
                        }
                      }
                    }
                  }
                }
              }
            }
          `,
          { variables: { id: collectionId, first: 250 } }
        );

        const productsData = await productsResp.json();
        const collection = productsData?.data?.collection;
        if (collection) {
          // collectionConfigsで選択された商品のみをフィルタリング
          const selectedVariantIds = config?.selectedVariantIds || [];
          
          for (const product of collection.products?.nodes || []) {
            for (const variant of product.variants?.nodes || []) {
              if (variant.inventoryItem?.id) {
                // 選択された商品のみを追加（selectedVariantIdsが空の場合は全選択）
                if (selectedVariantIds.length === 0 || selectedVariantIds.includes(variant.id)) {
                  const inventoryItemId = variant.inventoryItem.id;
                  if (!inventoryItemIds.includes(inventoryItemId)) {
                    inventoryItemIds.push(inventoryItemId);
                  }
                }
              }
            }
          }
        }
      }
    } catch (e) {
      console.error("Failed to get inventory item IDs:", e);
      // エラーが発生しても保存は続行（商品リストなしで保存）
    }

    // 編集時・コレクション未選択: CSVで登録したSKUベースのグループは既存のinventoryItemIds/skusを維持
    let finalInventoryItemIds = inventoryItemIds.length > 0 ? inventoryItemIds : undefined;
    if (id && collectionIds.length === 0) {
      const existing = productGroups.find((g) => g.id === id);
      if (existing?.inventoryItemIds?.length) {
        finalInventoryItemIds = existing.inventoryItemIds;
      }
    }

    if (id) {
      // 編集
      const index = productGroups.findIndex((g) => g.id === id);
      if (index >= 0) {
        const existing = productGroups[index];
        productGroups[index] = {
          ...existing,
          name: name.trim(),
          collectionIds,
          collectionConfigs: collectionConfigs.length > 0 ? collectionConfigs : undefined,
          inventoryItemIds: finalInventoryItemIds ?? existing.inventoryItemIds,
          skus: existing.skus,
        };
      }
    } else {
      // 新規作成（フォームからはコレクション指定のみ。SKU指定はCSVインポートで行う）
      productGroups.push({
        id: generateId("group"),
        name: name.trim(),
        collectionIds,
        collectionConfigs: collectionConfigs.length > 0 ? collectionConfigs : undefined,
        inventoryItemIds: finalInventoryItemIds ?? (inventoryItemIds.length > 0 ? inventoryItemIds : undefined),
        createdAt: new Date().toISOString(),
      });
    }

    const saveResp = await admin.graphql(
      `#graphql
        mutation SaveProductGroups($metafields: [MetafieldsSetInput!]!) {
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
              key: PRODUCT_GROUPS_KEY,
              type: "json",
              value: JSON.stringify(productGroups),
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

    return { ok: true };
  }

  if (actionType === "delete_product_group") {
    const id = formData.get("id") as string;
    productGroups = productGroups.filter((g) => g.id !== id);

    const saveResp = await admin.graphql(
      `#graphql
        mutation SaveProductGroups($metafields: [MetafieldsSetInput!]!) {
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
              key: PRODUCT_GROUPS_KEY,
              type: "json",
              value: JSON.stringify(productGroups),
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

    return { ok: true };
  }

  // CSVインポート: グループ名＋SKUの行で商品グループを一括登録（コレクションに依存しない）
  // 1ファイル: グループ数は無制限、SKU行数は最大10000行（バッチ＋並列でAPI呼び出しを削減）
  if (actionType === "import_product_groups_csv") {
    const CSV_MAX_ROWS = 10000;
    const csvRaw = formData.get("csv") as string;
    if (!csvRaw || typeof csvRaw !== "string") {
      return { ok: false, error: "CSVデータが送信されていません" as const };
    }
    const csvImportMode = (formData.get("csvImportMode") as string) || "append";

    const lines = csvRaw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) {
      return { ok: false, error: "CSVに有効な行がありません" as const };
    }

    // 1行目がヘッダーかどうか（グループ名, SKU など）
    const parseCsvLine = (line: string): string[] => {
      const result: string[] = [];
      let current = "";
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') {
          inQuotes = !inQuotes;
        } else if ((c === "," && !inQuotes) || (c === "\t" && !inQuotes)) {
          result.push(current.trim());
          current = "";
        } else {
          current += c;
        }
      }
      result.push(current.trim());
      return result;
    };

    const isHeader = (cells: string[]) =>
      cells.length >= 2 &&
      (cells[0] === "グループ名" || cells[0].toLowerCase() === "group" || cells[0] === "group_name") &&
      (cells[1] === "SKU" || cells[1].toLowerCase() === "sku");

    const groupNameToSkus = new Map<string, string[]>();
    let startIndex = 0;
    const firstCells = parseCsvLine(lines[0]);
    if (isHeader(firstCells)) {
      startIndex = 1;
    }

    for (let i = startIndex; i < lines.length; i++) {
      const cells = parseCsvLine(lines[i]);
      const groupName = cells[0]?.trim();
      const sku = cells[1]?.trim();
      if (!groupName) continue;
      if (!sku) continue;
      const list = groupNameToSkus.get(groupName) ?? [];
      if (!list.includes(sku)) list.push(sku);
      groupNameToSkus.set(groupName, list);
    }

    const totalRows = Array.from(groupNameToSkus.values()).reduce((sum, arr) => sum + arr.length, 0);
    if (totalRows > CSV_MAX_ROWS) {
      return { ok: false, error: `CSVのSKU行数が上限（${CSV_MAX_ROWS}行）を超えています（現在${totalRows}行）。ファイルを分割するか行数を減らしてください。` as const };
    }

    if (groupNameToSkus.size === 0) {
      return { ok: false, error: "CSVから有効な「グループ名, SKU」の行がありません。1行目はヘッダー（グループ名,SKU）にできます。" as const };
    }

    let importedCount = 0;
    for (const [name, skus] of groupNameToSkus) {
      const existing = productGroups.find((g) => g.name === name);
      const inventoryItemIds = await resolveSkusToInventoryItemIds(admin, skus);

      if (existing) {
        if (csvImportMode === "new_only") {
          continue;
        }
        if (csvImportMode === "replace") {
          const idx = productGroups.findIndex((g) => g.id === existing.id);
          if (idx >= 0) {
            productGroups[idx] = {
              ...existing,
              skus: [...skus],
              inventoryItemIds: inventoryItemIds.length > 0 ? inventoryItemIds : undefined,
            };
            importedCount++;
          }
        } else {
          const group = {
            ...existing,
            skus: [...new Set([...(existing.skus ?? []), ...skus])],
            inventoryItemIds: [...new Set([...(existing.inventoryItemIds ?? []), ...inventoryItemIds])],
          };
          const idx = productGroups.findIndex((g) => g.id === existing.id);
          if (idx >= 0) {
            productGroups[idx] = group;
            importedCount++;
          }
        }
      } else {
        productGroups.push({
          id: generateId("group"),
          name,
          collectionIds: [],
          skus: [...skus],
          inventoryItemIds: inventoryItemIds.length > 0 ? inventoryItemIds : undefined,
          createdAt: new Date().toISOString(),
        });
        importedCount++;
      }
    }

    const saveResp = await admin.graphql(
      `#graphql
        mutation SaveProductGroups($metafields: [MetafieldsSetInput!]!) {
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
              key: PRODUCT_GROUPS_KEY,
              type: "json",
              value: JSON.stringify(productGroups),
            },
          ],
        },
      }
    );

    const saveJson = await saveResp.json();
    const errs = saveJson?.data?.metafieldsSet?.userErrors ?? [];
    if (errs.length) {
      return { ok: false, error: errs.map((e: { message?: string }) => e.message).join(" / ") as const };
    }

    return { ok: true, imported: importedCount };
  }

  if (actionType === "create_inventory_count") {
    const locationId = formData.get("locationId") as string;
    const productGroupIdStr = formData.get("productGroupId") as string; // 後方互換性のため残す
    const productGroupIdsStr = formData.get("productGroupIds") as string; // 複数選択対応

    if (!locationId) {
      return { ok: false, error: "ロケーションは必須です" as const };
    }

    // 複数選択対応：productGroupIdsがあればそれを使用、なければproductGroupIdを使用（後方互換性）
    let targetProductGroupIds: string[] = [];
    if (productGroupIdsStr) {
      try {
        targetProductGroupIds = JSON.parse(productGroupIdsStr);
      } catch {
        targetProductGroupIds = productGroupIdsStr.split(",").filter(Boolean);
      }
    } else if (productGroupIdStr) {
      targetProductGroupIds = [productGroupIdStr];
    }

    if (targetProductGroupIds.length === 0) {
      return { ok: false, error: "商品グループは必須です" as const };
    }

    // ロケーションを取得
    const locResp = await admin.graphql(
      `#graphql
        query Locations($first: Int!) {
          locations(first: $first) { nodes { id name } }
        }
      `,
      { variables: { first: 250 } }
    );
    const locData = await locResp.json();
    const locations: LocationNode[] = locData?.data?.locations?.nodes ?? [];

    // 商品グループ名とinventoryItemIdsを取得
    const groupNames: string[] = [];
    const inventoryItemIdsByGroup: Record<string, string[]> = {};
    for (const groupId of targetProductGroupIds) {
      const group = productGroups.find((g) => g.id === groupId);
      if (!group) {
        return { ok: false, error: `商品グループが見つかりません: ${groupId}` as const };
      }
      groupNames.push(group.name);
      // ✅ 生成時の商品グループのinventoryItemIdsを保存（商品グループを編集しても影響を受けないように）
      if (group.inventoryItemIds && group.inventoryItemIds.length > 0) {
        inventoryItemIdsByGroup[groupId] = [...group.inventoryItemIds];
      }
    }

    const loc = locations.find((l) => l.id === locationId);
    // 既存の棚卸数をカウントして連番を決定（#C0000形式）
    const existingCount = Array.isArray(inventoryCounts) ? inventoryCounts.length : 0;
    const countName = `#C${String(existingCount + 1).padStart(4, "0")}`;
    
    const newCount: InventoryCount = {
      id: generateId("count"),
      countName, // 表示用名称を追加
      locationId,
      locationName: loc?.name,
      productGroupId: targetProductGroupIds[0], // 後方互換性のため残す
      productGroupIds: targetProductGroupIds,
      productGroupName: groupNames[0], // 後方互換性のため残す
      productGroupNames: groupNames,
      inventoryItemIdsByGroup: Object.keys(inventoryItemIdsByGroup).length > 0 ? inventoryItemIdsByGroup : undefined, // ✅ 生成時の商品リストを保存
      status: "draft",
      createdAt: new Date().toISOString(),
    };

    inventoryCounts.push(newCount);

    const saveResp = await admin.graphql(
      `#graphql
        mutation SaveInventoryCounts($metafields: [MetafieldsSetInput!]!) {
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
              key: INVENTORY_COUNTS_KEY,
              type: "json",
              value: JSON.stringify(inventoryCounts),
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

    return { ok: true, inventoryCountId: newCount.id };
  }

  if (actionType === "get_collection_products") {
    const collectionId = formData.get("collectionId") as string;
    if (!collectionId) {
      return { ok: false, error: "コレクションIDは必須です" as const };
    }

    try {
      const COLLECTION_PRODUCTS_QUERY = `#graphql
        query CollectionProducts($id: ID!, $first: Int!, $after: String) {
          collection(id: $id) {
            id
            title
            products(first: $first, after: $after) {
              nodes {
                id
                title
                variants(first: 250) {
                  nodes {
                    id
                    title
                    sku
                    barcode
                    inventoryItem { id }
                  }
                }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      `;

      const products: CollectionProduct[] = [];
      let collectionTitle = "";
      let productsCursor: string | null = null;

      do {
        const productsResp = await admin.graphql(COLLECTION_PRODUCTS_QUERY, {
          variables: { id: collectionId, first: 250, after: productsCursor },
        });
        const productsData = await productsResp.json();
        const collection = productsData?.data?.collection;
        if (!collection) {
          return { ok: false, error: "コレクションが見つかりません" as const };
        }
        collectionTitle = collection.title || "";

        const productNodes = collection.products?.nodes ?? [];
        const pageInfo = collection.products?.pageInfo ?? {};
        for (const product of productNodes) {
          for (const variant of product.variants?.nodes ?? []) {
            if (variant?.inventoryItem?.id) {
              products.push({
                variantId: variant.id,
                inventoryItemId: variant.inventoryItem.id,
                productTitle: product.title || "",
                variantTitle: variant.title || "",
                sku: variant.sku || "",
                barcode: variant.barcode || "",
              });
            }
          }
        }
        productsCursor = pageInfo.hasNextPage ? pageInfo.endCursor ?? null : null;
      } while (productsCursor);

      return {
        ok: true,
        collectionTitle,
        products,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `商品取得エラー: ${errorMessage}` as const };
    }
  }

  // ✅ 未完了グループの商品リストと在庫数を取得
  if (actionType === "get_incomplete_group_products") {
    const groupId = formData.get("groupId") as string;
    const locationId = formData.get("locationId") as string;
    if (!groupId || !locationId) {
      return { ok: false, error: "グループIDまたはロケーションIDが指定されていません" as const };
    }

    try {
      const productGroup = productGroups.find((g) => g.id === groupId);
      if (!productGroup) {
        return { ok: true, products: [] };
      }

      const products: Array<{
        variantId: string;
        inventoryItemId: string;
        productTitle: string;
        variantTitle: string;
        sku: string;
        barcode?: string;
        title: string;
      }> = [];

      // パターン1: inventoryItemIds のみ（CSVインポート等）→ 並列で商品情報＋在庫を取得
      if ((!productGroup.collectionIds?.length) && productGroup.inventoryItemIds?.length) {
        const BATCH_SIZE = 10;
        const ids = productGroup.inventoryItemIds;
        const allResults: Array<{
          variantId: string;
          inventoryItemId: string;
          productTitle: string;
          variantTitle: string;
          sku: string;
          barcode?: string;
          title: string;
          currentQuantity: number;
          actualQuantity: number;
          delta: number;
        }> = [];
        for (let i = 0; i < ids.length; i += BATCH_SIZE) {
          const batch = ids.slice(i, i + BATCH_SIZE);
          const results = await Promise.all(
            batch.map(async (inventoryItemId) => {
              try {
                const resp = await admin.graphql(
                  `#graphql
                    query ItemAndLevel($id: ID!, $loc: ID!) {
                      inventoryItem(id: $id) {
                        id
                        variant {
                          id
                          title
                          sku
                          barcode
                          product { title }
                        }
                        inventoryLevel(locationId: $loc) {
                          quantities(names: ["available"]) { name quantity }
                        }
                      }
                    }
                  `,
                  { variables: { id: inventoryItemId, loc: locationId } }
                );
                const json = await resp.json();
                const item = json?.data?.inventoryItem;
                if (!item?.variant) return null;
                const productTitle = item.variant.product?.title ?? "";
                const variantTitle = item.variant.title ?? "";
                const fullTitle = variantTitle && variantTitle !== "Default Title" ? `${productTitle}/${variantTitle}` : productTitle;
                const qty = item.inventoryLevel?.quantities?.find((x: { name?: string; quantity?: string }) => x.name === "available")?.quantity;
                const currentQuantity = qty !== null && qty !== undefined ? Number(qty) : 0;
                return {
                  variantId: item.variant.id,
                  inventoryItemId: item.id,
                  productTitle,
                  variantTitle,
                  sku: item.variant.sku ?? "",
                  barcode: item.variant.barcode,
                  title: fullTitle,
                  currentQuantity,
                  actualQuantity: 0,
                  delta: 0,
                };
              } catch {
                return null;
              }
            })
          );
          const valid = results.filter((r): r is NonNullable<typeof r> => r != null);
          allResults.push(...valid);
        }
        return { ok: true, groupId, products: allResults };
      }

      // パターン2: コレクションから商品を取得
      if (!productGroup.collectionIds?.length) {
        return { ok: true, products: [] };
      }

      for (const collectionId of productGroup.collectionIds) {
        const config = productGroup.collectionConfigs?.find((c) => c.collectionId === collectionId);
        const selectedVariantIds = config?.selectedVariantIds || [];

        const productsResp = await admin.graphql(
          `#graphql
            query CollectionProducts($id: ID!, $first: Int!) {
              collection(id: $id) {
                id
                title
                products(first: $first) {
                  nodes {
                    id
                    title
                    variants(first: 250) {
                      nodes {
                        id
                        title
                        sku
                        barcode
                        inventoryItem {
                          id
                        }
                      }
                    }
                  }
                }
              }
            }
          `,
          { variables: { id: collectionId, first: 250 } }
        );

        const productsData = await productsResp.json();
        const collection = productsData?.data?.collection;
        if (collection) {
          for (const product of collection.products?.nodes || []) {
            for (const variant of product.variants?.nodes || []) {
              if (variant.inventoryItem?.id) {
                // 選択された商品のみを追加（selectedVariantIdsが空の場合は全選択）
                if (selectedVariantIds.length === 0 || selectedVariantIds.includes(variant.id)) {
                  const title = product.title || "";
                  const variantTitle = variant.title || "";
                  const fullTitle = variantTitle && variantTitle !== "Default Title" ? `${title}/${variantTitle}` : title;
                  products.push({
                    variantId: variant.id,
                    inventoryItemId: variant.inventoryItem.id,
                    productTitle: title,
                    variantTitle: variantTitle,
                    sku: variant.sku || "",
                    barcode: variant.barcode || "",
                    title: fullTitle,
                  });
                }
              }
            }
          }
        }
      }

      // 重複除去
      const seen = new Set<string>();
      const uniqueProducts = products.filter((p) => {
        if (seen.has(p.inventoryItemId)) return false;
        seen.add(p.inventoryItemId);
        return true;
      });

      // 各商品の在庫数を取得（並列化：バッチごとに同時リクエストして待機時間を短縮）
      const BATCH_SIZE = 15;
      const productsWithQuantity: Array<{
        variantId: string;
        inventoryItemId: string;
        productTitle: string;
        variantTitle: string;
        sku: string;
        barcode?: string;
        title: string;
        currentQuantity: number;
        actualQuantity: number;
        delta: number;
      }> = [];
      for (let i = 0; i < uniqueProducts.length; i += BATCH_SIZE) {
        const batch = uniqueProducts.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(
          batch.map(async (product) => {
            try {
              const qtyResp = await admin.graphql(
                `#graphql
                  query CurrentQuantity($id: ID!, $loc: ID!) {
                    inventoryItem(id: $id) {
                      inventoryLevel(locationId: $loc) {
                        quantities(names: ["available"]) { name quantity }
                      }
                    }
                  }
                `,
                { variables: { id: product.inventoryItemId, loc: locationId } }
              );
              const qtyData = await qtyResp.json();
              const level = qtyData?.data?.inventoryItem?.inventoryLevel;
              const qty = level?.quantities?.find((x: { name?: string; quantity?: string }) => x.name === "available")?.quantity;
              const currentQuantity = qty !== null && qty !== undefined ? Number(qty) : 0;
              return {
                ...product,
                currentQuantity,
                actualQuantity: 0,
                delta: 0,
              };
            } catch {
              return {
                ...product,
                currentQuantity: 0,
                actualQuantity: 0,
                delta: 0,
              };
            }
          })
        );
        productsWithQuantity.push(...results);
      }

      return {
        ok: true,
        groupId,
        products: productsWithQuantity,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `商品取得エラー: ${errorMessage}` as const };
    }
  }

  return { ok: false, error: "不明なアクション" as const };
}

function escapeCsv(s: string) {
  return `"${String(s).replace(/"/g, '""')}"`;
}

export type SkuSearchVariant = {
  variantId: string;
  inventoryItemId: string;
  sku: string;
  barcode?: string;
  variantTitle: string;
  productTitle: string;
  title: string;
  option1?: string;
  option2?: string;
  option3?: string;
};

export default function InventoryCountPage() {
  const loaderData = useLoaderData<typeof loader>();
  const locations = loaderData?.locations ?? [];
  const collections = loaderData?.collections ?? [];
  const productGroups = loaderData?.productGroups ?? [];
  const inventoryCounts = loaderData?.inventoryCounts ?? [];
  const fetcher = useFetcher<typeof action>();
  const allSkuVariants: SkuSearchVariant[] = Array.isArray(loaderData?.skuVariantList) ? loaderData.skuVariantList : [];
  const [skuSearchQuery, setSkuSearchQuery] = useState("");
  const [showOnlySelectedSku, setShowOnlySelectedSku] = useState(false);
  const [selectedSkuVariants, setSelectedSkuVariants] = useState<SkuSearchVariant[]>([]);
  const filteredSkuVariants = useMemo(() => {
    if (!skuSearchQuery.trim()) return allSkuVariants;
    const q = skuSearchQuery.trim().toLowerCase();
    return allSkuVariants.filter(
      (v) =>
        (v.sku || "").toLowerCase().includes(q) ||
        (v.barcode || "").toLowerCase().includes(q) ||
        (v.title || "").toLowerCase().includes(q) ||
        (v.productTitle || "").toLowerCase().includes(q) ||
        (v.variantTitle || "").toLowerCase().includes(q)
    );
  }, [allSkuVariants, skuSearchQuery]);

  const displaySkuVariants = useMemo(() => {
    if (!showOnlySelectedSku) return filteredSkuVariants;
    const selectedIds = new Set(selectedSkuVariants.map((s) => s.inventoryItemId));
    return filteredSkuVariants.filter((v) => selectedIds.has(v.inventoryItemId));
  }, [showOnlySelectedSku, filteredSkuVariants, selectedSkuVariants]);

  const [activeTab, setActiveTab] = useState<"groups" | "create" | "history">("groups");
  const [groupCreateMethod, setGroupCreateMethod] = useState<"collection" | "sku" | "csv">("collection");
  // SKU/CSV由来のグループ編集時、loader一覧にないinventoryItemIdを保存しておき、更新時に欠落しないようにする
  const [editingSkuOnlyPreservedIds, setEditingSkuOnlyPreservedIds] = useState<string[]>([]);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [groupName, setGroupName] = useState("");
  const [selectedCollectionIds, setSelectedCollectionIds] = useState<string[]>([]);
  const [collectionConfigs, setCollectionConfigs] = useState<Map<string, CollectionConfig>>(new Map()); // コレクションごとの選択商品設定

  // コレクション検索・モーダル関連
  const [collectionSearchQuery, setCollectionSearchQuery] = useState("");
  const [collectionModalOpen, setCollectionModalOpen] = useState(false);
  const [collectionModalCollectionId, setCollectionModalCollectionId] = useState<string | null>(null);
  const [collectionModalProducts, setCollectionModalProducts] = useState<CollectionProduct[]>([]);
  const [collectionModalSelectedVariantIds, setCollectionModalSelectedVariantIds] = useState<Set<string>>(new Set());
  const [collectionModalLoading, setCollectionModalLoading] = useState(false);
  const [collectionModalProductGroupId, setCollectionModalProductGroupId] = useState<string | null>(null); // 右側から開いた場合の商品グループID
  const [collectionModalSearchQuery, setCollectionModalSearchQuery] = useState("");
  const [showOnlySelectedInModal, setShowOnlySelectedInModal] = useState(false);
  const [collectionModalPage, setCollectionModalPage] = useState(1);
  const collectionProductsFetcher = useFetcher<typeof action>();
  const MODAL_ITEMS_PER_PAGE = 1000;

  const filteredModalProducts = useMemo(() => {
    const list = collectionModalProducts;
    if (!collectionModalSearchQuery.trim()) return list;
    const q = collectionModalSearchQuery.trim().toLowerCase();
    return list.filter(
      (p) =>
        (p.sku || "").toLowerCase().includes(q) ||
        (p.barcode || "").toLowerCase().includes(q) ||
        (p.productTitle || "").toLowerCase().includes(q) ||
        (p.variantTitle || "").toLowerCase().includes(q)
    );
  }, [collectionModalProducts, collectionModalSearchQuery]);
  const displayModalProducts = useMemo(() => {
    if (!showOnlySelectedInModal) return filteredModalProducts;
    const selectedSet = collectionModalSelectedVariantIds;
    return filteredModalProducts.filter((p) => selectedSet.has(p.variantId));
  }, [showOnlySelectedInModal, filteredModalProducts, collectionModalSelectedVariantIds]);
  const paginatedModalProducts = useMemo(() => {
    const start = (collectionModalPage - 1) * MODAL_ITEMS_PER_PAGE;
    return displayModalProducts.slice(start, start + MODAL_ITEMS_PER_PAGE);
  }, [displayModalProducts, collectionModalPage]);
  const modalTotalPages = Math.max(1, Math.ceil(displayModalProducts.length / MODAL_ITEMS_PER_PAGE));
  useEffect(() => {
    setCollectionModalPage(1);
  }, [collectionModalSearchQuery, showOnlySelectedInModal]);

  const [createLocationId, setCreateLocationId] = useState("");
  const [createLocationSearchQuery, setCreateLocationSearchQuery] = useState("");
  const [createProductGroupId, setCreateProductGroupId] = useState("");
  const [createProductGroupIds, setCreateProductGroupIds] = useState<string[]>([]);

  // イベントから値を読み取るヘルパー関数
  const readValue = (e: any) => String(e?.currentTarget?.value ?? e?.currentValue?.value ?? e ?? "");

  const [locationFilters, setLocationFilters] = useState<Set<string>>(new Set());
  const [statusFilters, setStatusFilters] = useState<Set<string>>(new Set());
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [modalOpen, setModalOpen] = useState(false);
  const [modalCount, setModalCount] = useState<InventoryCount | null>(null);
  // ✅ 未完了グループの商品リストを取得するためのfetcherとstate（モーダル用）
  const incompleteGroupProductsFetcher = useFetcher<typeof action>();
  const [incompleteGroupProducts, setIncompleteGroupProducts] = useState<Map<string, Array<any>>>(new Map());
  const incompleteGroupFetchIndexRef = useRef<number>(0);
  const incompleteGroupIdsRef = useRef<string[]>([]);
  
  // ✅ 一覧表示用の未完了グループの商品リストを取得するためのfetcherとstate
  const incompleteGroupProductsForListFetcher = useFetcher<typeof action>();
  const [incompleteGroupProductsForList, setIncompleteGroupProductsForList] = useState<Map<string, Map<string, Array<any>>>>(new Map());
  const incompleteGroupFetchIndexForListRef = useRef<Map<string, number>>(new Map());
  const incompleteGroupIdsForListRef = useRef<Map<string, string[]>>(new Map());
  const csvFileInputRef = useRef<HTMLInputElement>(null);
  const [csvImportMode, setCsvImportMode] = useState<"append" | "replace" | "new_only">("append");

  const editingGroup = editingGroupId
    ? productGroups.find((g) => g.id === editingGroupId)
    : null;

  // 編集モードの初期化（editingGroupId が変わったときだけ実行）
  // ✅ editingGroupId のみ依存にし、productGroups は含めない。これにより編集中にコレクションを解除しても、
  // ✅ loader の再検証などで productGroups の参照が変わってもフォームが上書きされず、解除が維持される。
  // ✅ SKU/CSV由来のグループの場合は「SKU選択から作成」タブに切り替え、選択済みSKUを復元する。
  useEffect(() => {
    if (!editingGroupId) return;
    const g = productGroups.find((pg) => pg.id === editingGroupId);
    if (!g) return;

    setGroupName(g.name);
    const skuCount = (g.inventoryItemIds ?? []).length;
    const isSkuOnly = (g.collectionIds?.length ?? 0) === 0 && skuCount > 0;

    if (isSkuOnly) {
      setGroupCreateMethod("sku");
      const ids = g.inventoryItemIds ?? [];
      setSelectedSkuVariants(allSkuVariants.filter((v) => ids.includes(v.inventoryItemId)));
      setEditingSkuOnlyPreservedIds(ids.filter((id) => !allSkuVariants.some((v) => v.inventoryItemId === id)));
      setSelectedCollectionIds([]);
      setCollectionConfigs(new Map());
    } else {
      setGroupCreateMethod("collection");
      setSelectedCollectionIds(g.collectionIds || []);
      setEditingSkuOnlyPreservedIds([]);
      const configMap = new Map<string, CollectionConfig>();
      if (g.collectionConfigs && g.collectionConfigs.length > 0) {
        for (const config of g.collectionConfigs) {
          configMap.set(config.collectionId, config);
        }
      }
      setCollectionConfigs(configMap);
    }
  }, [editingGroupId]);

  // ✅ モーダルが開いたときに未完了グループの商品リストを取得
  useEffect(() => {
    if (!modalOpen || !modalCount) {
      setIncompleteGroupProducts(new Map());
      incompleteGroupFetchIndexRef.current = 0;
      incompleteGroupIdsRef.current = [];
      return;
    }

    const allGroupIds = Array.isArray(modalCount.productGroupIds) && modalCount.productGroupIds.length > 0
      ? modalCount.productGroupIds
      : modalCount.productGroupId ? [modalCount.productGroupId] : [];
    const groupItemsMap = (modalCount as any)?.groupItems && typeof (modalCount as any).groupItems === "object" ? (modalCount as any).groupItems : {};

    // 未完了グループの商品リストを取得（各グループごとに順次実行）
    // ✅ 完了判定と同じロジックを使用（キーの型を考慮）
    const incompleteGroupIds = allGroupIds.filter((groupId) => {
      // ✅ 完了判定と同じロジック：キーの型を考慮してgroupItemsを取得
      let groupItems = Array.isArray(groupItemsMap[groupId]) ? groupItemsMap[groupId] : [];
      // ✅ キーが一致しない場合、文字列変換を試す
      if (groupItems.length === 0) {
        groupItems = Array.isArray(groupItemsMap[String(groupId)]) ? groupItemsMap[String(groupId)] : [];
      }
      // ✅ さらに、groupItemsMapの全てのキーを確認
      if (groupItems.length === 0 && Object.keys(groupItemsMap).length > 0) {
        const matchingKey = Object.keys(groupItemsMap).find((key) => {
          return key === String(groupId) || key === groupId || String(key) === String(groupId);
        });
        if (matchingKey) {
          groupItems = Array.isArray(groupItemsMap[matchingKey]) ? groupItemsMap[matchingKey] : [];
        }
      }
      return groupItems.length === 0;
    });

    // ✅ 未完了グループIDをrefに保存
    incompleteGroupIdsRef.current = incompleteGroupIds;
    incompleteGroupFetchIndexRef.current = 0;

    // ✅ 最初のグループを取得
    if (incompleteGroupIds.length > 0) {
      const formData = new FormData();
      formData.append("action", "get_incomplete_group_products");
      formData.append("groupId", incompleteGroupIds[0]);
      formData.append("locationId", modalCount.locationId);
      incompleteGroupProductsFetcher.submit(formData, { method: "post" });
      incompleteGroupFetchIndexRef.current = 1;
    }
  }, [modalOpen, modalCount]);

  // ✅ 未完了グループの商品リスト取得完了時の処理
  useEffect(() => {
    if (incompleteGroupProductsFetcher.data?.ok && incompleteGroupProductsFetcher.data?.products && incompleteGroupProductsFetcher.data?.groupId) {
      const { groupId, products } = incompleteGroupProductsFetcher.data;
      setIncompleteGroupProducts((prev) => {
        const newMap = new Map(prev);
        newMap.set(groupId, products);
        return newMap;
      });
      
      // ✅ 次の未完了グループを取得（まだ取得していないグループがある場合）
      const currentIndex = incompleteGroupFetchIndexRef.current;
      const remainingGroupIds = incompleteGroupIdsRef.current;
      if (currentIndex < remainingGroupIds.length && modalCount) {
        const formData = new FormData();
        formData.append("action", "get_incomplete_group_products");
        formData.append("groupId", remainingGroupIds[currentIndex]);
        formData.append("locationId", modalCount.locationId);
        incompleteGroupProductsFetcher.submit(formData, { method: "post" });
        incompleteGroupFetchIndexRef.current = currentIndex + 1;
      }
    }
  }, [incompleteGroupProductsFetcher.data, modalCount]);

  // コレクション検索結果
  const filteredCollections = useMemo(() => {
    if (!collectionSearchQuery.trim()) {
      return collections;
    }
    const query = collectionSearchQuery.toLowerCase();
    return collections.filter((col) => col.title.toLowerCase().includes(query));
  }, [collections, collectionSearchQuery]);

  const [showOnlySelectedCollection, setShowOnlySelectedCollection] = useState(false);
  const displayCollections = useMemo(() => {
    if (!showOnlySelectedCollection) return filteredCollections;
    const selectedSet = new Set(selectedCollectionIds);
    return filteredCollections.filter((col) => selectedSet.has(col.id));
  }, [showOnlySelectedCollection, filteredCollections, selectedCollectionIds]);

  const ITEMS_PER_PAGE = 1000;
  const [collectionPage, setCollectionPage] = useState(1);
  const [skuPage, setSkuPage] = useState(1);
  const paginatedCollections = useMemo(() => {
    const start = (collectionPage - 1) * ITEMS_PER_PAGE;
    return displayCollections.slice(start, start + ITEMS_PER_PAGE);
  }, [displayCollections, collectionPage]);
  const paginatedSkuVariants = useMemo(() => {
    const start = (skuPage - 1) * ITEMS_PER_PAGE;
    return displaySkuVariants.slice(start, start + ITEMS_PER_PAGE);
  }, [displaySkuVariants, skuPage]);
  const collectionTotalPages = Math.max(1, Math.ceil(displayCollections.length / ITEMS_PER_PAGE));
  const skuTotalPages = Math.max(1, Math.ceil(displaySkuVariants.length / ITEMS_PER_PAGE));

  useEffect(() => {
    setCollectionPage(1);
  }, [collectionSearchQuery, showOnlySelectedCollection]);
  useEffect(() => {
    setSkuPage(1);
  }, [skuSearchQuery, showOnlySelectedSku]);

  // コレクション選択時に商品リストを取得
  const handleOpenCollectionModal = async (collectionId: string, productGroupId?: string) => {
    setCollectionModalCollectionId(collectionId);
    setCollectionModalProductGroupId(productGroupId || null); // 右側から開いた場合は商品グループIDを保存
    setCollectionModalOpen(true);
    setCollectionModalLoading(true);
    setCollectionModalProducts([]);
    setCollectionModalSearchQuery("");
    setShowOnlySelectedInModal(false);
    setCollectionModalPage(1);

    // 既存の設定があれば復元（商品リスト取得前に設定）
    // 右側から開いた場合は、その商品グループの設定を読み込む
    let existingConfig: CollectionConfig | undefined;
    if (productGroupId) {
      const group = productGroups.find((g) => g.id === productGroupId);
      if (group?.collectionConfigs) {
        existingConfig = group.collectionConfigs.find((c) => c.collectionId === collectionId);
      }
    } else {
      existingConfig = collectionConfigs.get(collectionId);
    }

    if (existingConfig && existingConfig.selectedVariantIds.length > 0) {
      setCollectionModalSelectedVariantIds(new Set(existingConfig.selectedVariantIds));
    } else {
      // 既存設定がない場合は空セット（商品リスト取得後に全選択にする）
      setCollectionModalSelectedVariantIds(new Set());
    }

    const formData = new FormData();
    formData.append("action", "get_collection_products");
    formData.append("collectionId", collectionId);
    collectionProductsFetcher.submit(formData, { method: "post" });
  };

  // 商品リスト取得完了時の処理
  useEffect(() => {
    if (collectionProductsFetcher.data?.ok && collectionProductsFetcher.data.products) {
      setCollectionModalProducts(collectionProductsFetcher.data.products);
      // 既存の設定がなければ全選択
      if (collectionModalSelectedVariantIds.size === 0) {
        const allVariantIds = new Set(collectionProductsFetcher.data.products.map((p) => p.variantId));
        setCollectionModalSelectedVariantIds(allVariantIds);
      }
      setCollectionModalLoading(false);
    } else if (collectionProductsFetcher.data?.error) {
      alert(collectionProductsFetcher.data.error);
      setCollectionModalLoading(false);
    }
  }, [collectionProductsFetcher.data, collectionModalSelectedVariantIds.size]);

  // モーダルで選択商品を確定
  const handleConfirmCollectionSelection = () => {
    if (!collectionModalCollectionId) return;

    const selectedIds = Array.from(collectionModalSelectedVariantIds);
    const total = collectionModalProducts.length;
    const config: CollectionConfig = {
      collectionId: collectionModalCollectionId,
      selectedVariantIds: selectedIds,
      totalVariantCount: total,
    };

    // 右側から開いた場合（商品グループIDがある場合）は、直接商品グループを更新
    if (collectionModalProductGroupId) {
      const group = productGroups.find((g) => g.id === collectionModalProductGroupId);
      if (group) {
        const updatedConfigs = group.collectionConfigs ? [...group.collectionConfigs] : [];
        const existingIndex = updatedConfigs.findIndex((c) => c.collectionId === collectionModalCollectionId);
        if (existingIndex >= 0) {
          updatedConfigs[existingIndex] = config;
        } else {
          updatedConfigs.push(config);
        }

        const formData = new FormData();
        formData.append("action", "save_product_group");
        formData.append("id", collectionModalProductGroupId);
        formData.append("name", group.name);
        formData.append("collectionIds", group.collectionIds.join(","));
        formData.append("collectionConfigs", JSON.stringify(updatedConfigs));
        fetcher.submit(formData, { method: "post" });
      }
    } else {
      // 編集モード時は、collectionConfigsに保存
      const newConfigs = new Map(collectionConfigs);
      newConfigs.set(collectionModalCollectionId, config);
      setCollectionConfigs(newConfigs);

      // collectionIdsにも追加（まだない場合）
      if (!selectedCollectionIds.includes(collectionModalCollectionId)) {
        setSelectedCollectionIds([...selectedCollectionIds, collectionModalCollectionId]);
      }
    }

    setCollectionModalOpen(false);
    setCollectionModalCollectionId(null);
    setCollectionModalProductGroupId(null);
    setCollectionModalProducts([]);
    setCollectionModalSelectedVariantIds(new Set());
  };

  const filteredCounts = useMemo(() => {
    let list = [...inventoryCounts];
    // ロケーションフィルター（複数選択対応）
    if (locationFilters.size > 0) {
      list = list.filter((c) => locationFilters.has(c.locationId));
    }
    // ステータスフィルター（複数選択対応）
    if (statusFilters.size > 0) {
      list = list.filter((c) => statusFilters.has(c.status));
    }
    return list.sort((a, b) => {
      const t1 = new Date(a.createdAt).getTime();
      const t2 = new Date(b.createdAt).getTime();
      return t2 - t1;
    });
  }, [inventoryCounts, locationFilters, statusFilters]);

  // ✅ 一覧表示で未完了グループの商品リストを取得
  useEffect(() => {
    // 表示されている棚卸IDについて、未完了グループの商品リストを取得
    for (const c of filteredCounts) {
      const allGroupIds = Array.isArray(c.productGroupIds) && c.productGroupIds.length > 0
        ? c.productGroupIds
        : c.productGroupId ? [c.productGroupId] : [];
      const groupItemsMap = (c as any)?.groupItems && typeof (c as any).groupItems === "object" ? (c as any).groupItems : {};
      
      // 未完了グループIDを取得
      const incompleteGroupIds = allGroupIds.filter((groupId) => {
        const groupItems = groupId && groupItemsMap[groupId] && Array.isArray(groupItemsMap[groupId]) ? groupItemsMap[groupId] : [];
        return groupItems.length === 0;
      });
      
      // 未完了グループがない場合はスキップ
      if (incompleteGroupIds.length === 0) {
        continue;
      }
      
      // 既に取得済みの場合はスキップ
      const countId = c.id;
      const existingMap = incompleteGroupProductsForList.get(countId);
      if (existingMap && incompleteGroupIds.every((id) => existingMap.has(id))) {
        continue;
      }
      
      // 取得中の場合はスキップ（fetcherがloading中の場合）
      if (incompleteGroupProductsForListFetcher.state !== "idle") {
        continue;
      }
      
      // 未完了グループIDをrefに保存
      incompleteGroupIdsForListRef.current.set(countId, incompleteGroupIds);
      incompleteGroupFetchIndexForListRef.current.set(countId, 0);
      
      // 最初のグループを取得
      const formData = new FormData();
      formData.append("action", "get_incomplete_group_products");
      formData.append("groupId", incompleteGroupIds[0]);
      formData.append("locationId", c.locationId);
      incompleteGroupProductsForListFetcher.submit(formData, { method: "post" });
      incompleteGroupFetchIndexForListRef.current.set(countId, 1);
      break; // 一度に1つの棚卸IDのみ処理
    }
  }, [filteredCounts, incompleteGroupProductsForList, incompleteGroupProductsForListFetcher.state]);

  // ✅ 一覧表示用の未完了グループの商品リスト取得完了時の処理
  useEffect(() => {
    if (incompleteGroupProductsForListFetcher.state === "idle" && incompleteGroupProductsForListFetcher.data?.ok && incompleteGroupProductsForListFetcher.data?.products && incompleteGroupProductsForListFetcher.data?.groupId) {
      const { groupId, products } = incompleteGroupProductsForListFetcher.data;
      
      // どの棚卸IDのグループかを特定（最初に見つかった未完了グループを持つ棚卸IDを使用）
      let targetCountId: string | null = null;
      for (const [countId, incompleteGroupIds] of incompleteGroupIdsForListRef.current.entries()) {
        if (incompleteGroupIds.includes(groupId)) {
          targetCountId = countId;
          break;
        }
      }
      
      if (targetCountId) {
        setIncompleteGroupProductsForList((prev) => {
          const newMap = new Map(prev);
          const countMap = newMap.get(targetCountId) || new Map();
          countMap.set(groupId, products);
          newMap.set(targetCountId, countMap);
          return newMap;
        });
        
        // ✅ 次の未完了グループを取得（まだ取得していないグループがある場合）
        const currentIndex = incompleteGroupFetchIndexForListRef.current.get(targetCountId) || 0;
        const remainingGroupIds = incompleteGroupIdsForListRef.current.get(targetCountId) || [];
        if (currentIndex < remainingGroupIds.length) {
          const c = filteredCounts.find((c) => c.id === targetCountId);
          if (c) {
            const formData = new FormData();
            formData.append("action", "get_incomplete_group_products");
            formData.append("groupId", remainingGroupIds[currentIndex]);
            formData.append("locationId", c.locationId);
            incompleteGroupProductsForListFetcher.submit(formData, { method: "post" });
            incompleteGroupFetchIndexForListRef.current.set(targetCountId, currentIndex + 1);
          }
        }
      }
    }
  }, [incompleteGroupProductsForListFetcher.data, incompleteGroupProductsForListFetcher.state, filteredCounts]);

  const locationById = useMemo(() => {
    const m: Record<string, string> = {};
    locations.forEach((l) => {
      m[l.id] = l.name;
    });
    return m;
  }, [locations]);

  const getLocationName = (id: string) =>
    locationById[id] ?? (inventoryCounts.find((c) => c.locationId === id)?.locationName ?? id);

  const getStatusLabel = (status: string) => {
    const labels: Record<string, string> = {
      draft: "下書き",
      in_progress: "進行中",
      completed: "完了",
      cancelled: "キャンセル",
    };
    return labels[status] || status;
  };

  // ロケーション検索結果
  const filteredLocations = useMemo(() => {
    if (!createLocationSearchQuery.trim()) {
      return locations;
    }
    const query = createLocationSearchQuery.toLowerCase();
    return locations.filter((loc) => loc.name.toLowerCase().includes(query));
  }, [locations, createLocationSearchQuery]);

  const handleSaveGroup = () => {
    if (!groupName.trim()) {
      alert("グループ名を入力してください");
      return;
    }

    const formData = new FormData();
    formData.append("action", "save_product_group");
    if (editingGroupId) formData.append("id", editingGroupId);
    formData.append("name", groupName);
    formData.append("collectionIds", selectedCollectionIds.join(","));
    // collectionConfigsをJSON形式で送信
    const configsArray = Array.from(collectionConfigs.values());
    formData.append("collectionConfigs", JSON.stringify(configsArray));
    // ✅ collectionConfigsから商品リストを取得するための情報を送信（action関数内で処理）

    fetcher.submit(formData, { method: "post" });
    setGroupName("");
    setSelectedCollectionIds([]);
    setCollectionConfigs(new Map());
    setEditingGroupId(null);
  };

  const handleDeleteGroup = (id: string) => {
    if (!confirm("この商品グループを削除しますか？")) return;

    const formData = new FormData();
    formData.append("action", "delete_product_group");
    formData.append("id", id);
    fetcher.submit(formData, { method: "post" });
  };

  const handleCsvImportClick = () => {
    csvFileInputRef.current?.click();
  };

  const handleCsvFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result : "";
      if (!text.trim()) {
        alert("CSVファイルの内容が空です。");
        return;
      }
      const formData = new FormData();
      formData.append("action", "import_product_groups_csv");
      formData.append("csv", text);
      formData.append("csvImportMode", csvImportMode);
      fetcher.submit(formData, { method: "post" });
    };
    reader.readAsText(file, "UTF-8");
    e.target.value = "";
  };

  // SKU一覧は loader で取得済み。画面上の入力で filteredSkuVariants に絞り込み表示。

  const toggleSkuVariant = (v: SkuSearchVariant) => {
    setSelectedSkuVariants((prev) => {
      const has = prev.some((x) => x.inventoryItemId === v.inventoryItemId);
      if (has) return prev.filter((x) => x.inventoryItemId !== v.inventoryItemId);
      return [...prev, v];
    });
  };

  const handleSaveGroupFromSkuSelection = () => {
    if (!groupName.trim()) {
      alert("グループ名を入力してください");
      return;
    }
    const mergedIds = [...selectedSkuVariants.map((v) => v.inventoryItemId), ...editingSkuOnlyPreservedIds];
    if (mergedIds.length === 0) {
      alert("SKUを1件以上選択するか、既存のSKUを維持してください");
      return;
    }
    const formData = new FormData();
    formData.append("action", "save_product_group");
    if (editingGroupId) formData.append("id", editingGroupId);
    formData.append("name", groupName.trim());
    formData.append("inventoryItemIds", JSON.stringify(mergedIds));
    formData.append("skus", JSON.stringify(selectedSkuVariants.map((v) => v.sku)));
    fetcher.submit(formData, { method: "post" });
    setGroupName("");
    setSelectedSkuVariants([]);
    setEditingGroupId(null);
    setEditingSkuOnlyPreservedIds([]);
  };

  const handleCsvTemplateDownload = () => {
    const sample = [
      ["グループ名", "SKU"],
      ["食品", "SKU-001"],
      ["食品", "SKU-002"],
      ["衣類", "SKU-003"],
    ];
    const csvContent = sample.map((row) => row.map(escapeCsv).join(",")).join("\n");
    const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "商品グループ_テンプレート.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  /** 登録済み商品グループをCSVでダウンロード（グループ名,SKU 形式）。編集して再アップロード可能。 */
  const handleCsvExport = () => {
    const rows: [string, string][] = [["グループ名", "SKU"]];
    for (const g of productGroups) {
      const skus = g.skus ?? [];
      if (skus.length === 0 && (g.inventoryItemIds?.length ?? 0) > 0) {
        continue;
      }
      for (const sku of skus) {
        rows.push([g.name, sku]);
      }
    }
    if (rows.length <= 1) {
      alert("SKU指定のグループがありません。コレクションのみのグループはCSVに含まれません。");
      return;
    }
    const csvContent = rows.map((row) => row.map(escapeCsv).join(",")).join("\n");
    const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "商品グループ_登録済み.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCreateCount = () => {
    if (!createLocationId) {
      alert("ロケーションを選択してください");
      return;
    }
    if (createProductGroupIds.length === 0 && !createProductGroupId) {
      alert("商品グループを選択してください");
      return;
    }

    const formData = new FormData();
    formData.append("action", "create_inventory_count");
    formData.append("locationId", createLocationId);
    // 複数選択対応：productGroupIdsを優先、なければproductGroupIdを使用（後方互換性）
    if (createProductGroupIds.length > 0) {
      formData.append("productGroupIds", JSON.stringify(createProductGroupIds));
    } else if (createProductGroupId) {
      formData.append("productGroupId", createProductGroupId);
    }
    fetcher.submit(formData, { method: "post" });
    setCreateLocationId("");
    setCreateProductGroupId("");
    setCreateProductGroupIds([]);
  };

  const toggleProductGroup = (groupId: string) => {
    setCreateProductGroupIds((prev) => {
      if (prev.includes(groupId)) {
        return prev.filter((id) => id !== groupId);
      } else {
        return [...prev, groupId];
      }
    });
  };

  // 全選択/全解除（コメントアウトされたコード内で参照されているため定義）
  const toggleSelectAll = () => {
    if (selectedIds.size === filteredCounts.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredCounts.map((c) => c.id)));
    }
  };

  const exportCsv = (detail = false) => {
    if (selectedIds.size === 0) {
      alert("CSV出力する履歴を選択してください");
      return;
    }

    const selectedCounts = filteredCounts.filter((c) => selectedIds.has(c.id));

    const headers = detail
      ? [
          "棚卸ID",
          "名称",
          "ロケーション",
          "商品グループ",
          "ステータス",
          "商品名/SKU",
          "オプション1",
          "オプション2",
          "オプション3",
          "現在在庫",
          "実数",
          "差分",
          "作成日時",
          "完了日時",
        ]
      : [
          "棚卸ID",
          "名称",
          "ロケーション",
          "商品グループ",
          "ステータス",
          "作成日時",
          "完了日時",
        ];

    const rows: string[][] = [];
    selectedCounts.forEach((c) => {
      const locName = getLocationName(c.locationId);
      const statusLabel = getStatusLabel(c.status);
      const countName = c.countName || c.id;

      // 複数商品グループ対応
      const groupNames = Array.isArray(c.productGroupNames) && c.productGroupNames.length > 0
        ? c.productGroupNames.join(", ")
        : Array.isArray(c.productGroupIds) && c.productGroupIds.length > 0
        ? c.productGroupIds.join(", ")
        : c.productGroupName || c.productGroupId || "-";

      if (detail && c.items?.length) {
        c.items.forEach((it) => {
          // ✅ 商品名とオプションを分離（入出庫と同じ実装）
          const titleRaw = String(it.title || "").trim();
          const parts = titleRaw.split("/").map((s) => s.trim()).filter(Boolean);
          const productName = parts[0] || titleRaw || it.sku || "-";
          const optionParts = parts.length >= 2 ? parts.slice(1) : [];
          const option1 = optionParts[0] || "";
          const option2 = optionParts[1] || "";
          const option3 = optionParts[2] || "";

          rows.push([
            c.id,
            countName,
            locName,
            groupNames,
            statusLabel,
            productName,
            option1,
            option2,
            option3,
            String(it.currentQuantity ?? ""),
            String(it.actualQuantity ?? ""),
            String(it.delta ?? ""),
            c.createdAt,
            c.completedAt || "",
          ]);
        });
      } else {
        rows.push([
          c.id,
          countName,
          locName,
          groupNames,
          statusLabel,
          c.createdAt,
          c.completedAt || "",
        ]);
      }
    });

    const csvContent = [headers, ...rows]
      .map((row) => row.map(escapeCsv).join(","))
      .join("\n");
    const blob = new Blob(["\uFEFF" + csvContent], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `棚卸履歴_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };


  return (
    <s-page heading="棚卸">
      <s-scroll-box padding="base">
        <s-stack gap="base">
          {/* タブ切り替え（選択中のみ背景・角丸） */}
          <s-box padding="base">
            <div style={{ display: "flex", gap: "4px", alignItems: "center", flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => setActiveTab("groups")}
                style={{
                  padding: "8px 16px",
                  border: "none",
                  borderRadius: "8px",
                  background: activeTab === "groups" ? "#e5e7eb" : "transparent",
                  color: "#202223",
                  fontSize: "14px",
                  fontWeight: 500,
                  cursor: "pointer",
                }}
              >
                商品グループ設定
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("create")}
                style={{
                  padding: "8px 16px",
                  border: "none",
                  borderRadius: "8px",
                  background: activeTab === "create" ? "#e5e7eb" : "transparent",
                  color: "#202223",
                  fontSize: "14px",
                  fontWeight: 500,
                  cursor: "pointer",
                }}
              >
                棚卸ID発行
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("history")}
                style={{
                  padding: "8px 16px",
                  border: "none",
                  borderRadius: "8px",
                  background: activeTab === "history" ? "#e5e7eb" : "transparent",
                  color: "#202223",
                  fontSize: "14px",
                  fontWeight: 500,
                  cursor: "pointer",
                }}
              >
                履歴
              </button>
            </div>
          </s-box>

          <s-divider />

          {/* 商品グループ設定 */}
          {activeTab === "groups" && (
            <s-section heading="商品グループ設定">
              <s-box padding="base">
                {/* 二分割レイアウト（SP時は右カラムを左下部に回す） */}
                <div style={{ display: "flex", gap: "24px", alignItems: "flex-start", flexWrap: "wrap" }}>
                  {/* 左側: 作成方法タブ + 各フォーム */}
                  <div style={{ flex: "0 1 320px", minWidth: 0 }}>
                    <s-stack gap="base">
                      <s-text emphasis="bold" size="large">商品グループ</s-text>
                      <div style={{ display: "flex", gap: "4px", alignItems: "center", flexWrap: "wrap" }}>
                        <button
                          type="button"
                          onClick={() => setGroupCreateMethod("collection")}
                          style={{
                            padding: "8px 16px",
                            border: "none",
                            borderRadius: "8px",
                            background: groupCreateMethod === "collection" ? "#e5e7eb" : "transparent",
                            color: "#202223",
                            fontSize: "14px",
                            fontWeight: 500,
                            cursor: "pointer",
                          }}
                        >
                          コレクションから作成
                        </button>
                        <button
                          type="button"
                          onClick={() => setGroupCreateMethod("sku")}
                          style={{
                            padding: "8px 16px",
                            border: "none",
                            borderRadius: "8px",
                            background: groupCreateMethod === "sku" ? "#e5e7eb" : "transparent",
                            color: "#202223",
                            fontSize: "14px",
                            fontWeight: 500,
                            cursor: "pointer",
                          }}
                        >
                          SKU選択から作成
                        </button>
                        <button
                          type="button"
                          onClick={() => setGroupCreateMethod("csv")}
                          style={{
                            padding: "8px 16px",
                            border: "none",
                            borderRadius: "8px",
                            background: groupCreateMethod === "csv" ? "#e5e7eb" : "transparent",
                            color: "#202223",
                            fontSize: "14px",
                            fontWeight: 500,
                            cursor: "pointer",
                          }}
                        >
                          CSVで一括登録
                        </button>
                      </div>
                      <s-divider />

                      {/* 1. コレクションから作成（レイアウト・背景・ボタン位置をSKU選択から作成と同じに） */}
                      {groupCreateMethod === "collection" && (
                        <s-stack gap="base">
                          {editingGroupId && editingGroup && (
                            <div style={{ width: "100%", minWidth: 0, maxWidth: "100%", boxSizing: "border-box", padding: "12px 16px", background: "#e5e7eb", border: "1px solid #d1d5db", borderRadius: "8px", overflowWrap: "break-word", wordBreak: "break-word" }}>
                              <span style={{ fontWeight: 600, fontSize: "14px", whiteSpace: "normal" }}>「{editingGroup.name}」編集中</span>
                            </div>
                          )}
                          <s-text emphasis="bold" size="small">コレクションから作成</s-text>
                          <s-text tone="subdued" size="small">
                            グループ名を入力し、コレクションを選択してグループを作成します。初回からコレクションを選択できます。
                          </s-text>
                          <s-text-field
                            label="グループ名"
                            value={groupName}
                            onInput={(e: any) => setGroupName(readValue(e))}
                            onChange={(e: any) => setGroupName(readValue(e))}
                            placeholder="例: 食品、衣類、雑貨"
                          />
                          <s-text-field
                            label="コレクションで絞り込み"
                            value={collectionSearchQuery}
                            onInput={(e: any) => setCollectionSearchQuery(readValue(e))}
                            onChange={(e: any) => setCollectionSearchQuery(readValue(e))}
                            placeholder="コレクション名で絞り込み"
                          />
                          {collections.length > 0 && (
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}>
                              <s-text tone="subdued" size="small">
                                {showOnlySelectedCollection
                                  ? `表示: 選択済み${displayCollections.length}件`
                                  : displayCollections.length <= ITEMS_PER_PAGE
                                    ? `表示: ${filteredCollections.length}件 / 全${collections.length}件`
                                    : `表示: ${(collectionPage - 1) * ITEMS_PER_PAGE + 1}-${Math.min(collectionPage * ITEMS_PER_PAGE, displayCollections.length)}件 / 全${displayCollections.length}件`}
                              </s-text>
                              <s-button
                                size="small"
                                tone={showOnlySelectedCollection ? "success" : undefined}
                                onClick={() => setShowOnlySelectedCollection((prev) => !prev)}
                              >
                                {showOnlySelectedCollection ? "一覧表示に戻る" : "選択済み"}
                              </s-button>
                            </div>
                          )}
                          <div style={{ maxHeight: "280px", overflowY: "auto", border: "1px solid #e1e3e5", borderRadius: "8px", padding: "6px" }}>
                            {displayCollections.length === 0 ? (
                              <s-box padding="base">
                                <s-text tone="subdued" size="small">
                                  {showOnlySelectedCollection ? "選択済みのコレクションがありません" : "コレクションが見つかりません"}
                                </s-text>
                              </s-box>
                            ) : (
                              <>
                                {paginatedCollections.map((col) => {
                                  const isSelected = selectedCollectionIds.includes(col.id);
                                  const config = collectionConfigs.get(col.id);
                                  const selectedCount = config?.selectedVariantIds?.length ?? 0;
                                  const totalCount = config?.totalVariantCount ?? 0;

                                  return (
                                    <div
                                      key={col.id}
                                      onClick={() => handleOpenCollectionModal(col.id)}
                                      style={{
                                        padding: "10px 12px",
                                        borderRadius: "6px",
                                        cursor: "pointer",
                                        backgroundColor: isSelected ? "#f0f9f7" : "transparent",
                                        border: isSelected ? "1px solid #008060" : "1px solid transparent",
                                        borderBottom: isSelected ? undefined : "1px solid #e5e7eb",
                                        marginTop: "4px",
                                        display: "flex",
                                        alignItems: "center",
                                        gap: "8px",
                                      }}
                                    >
                                      <input type="checkbox" checked={isSelected} readOnly style={{ width: "16px", height: "16px", flexShrink: 0 }} />
                                      <div style={{ flex: "1 1 auto", minWidth: 0 }}>
                                        <span style={{ fontWeight: isSelected ? 600 : 500, overflow: "hidden", textOverflow: "ellipsis", display: "block" }}>
                                          {col.title}
                                        </span>
                                        <span style={{ fontSize: "12px", color: "#6d7175" }}>
                                          {selectedCount} / {totalCount}
                                        </span>
                                      </div>
                                      {isSelected && (
                                        <button
                                          type="button"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            setSelectedCollectionIds(selectedCollectionIds.filter((id) => id !== col.id));
                                            const newConfigs = new Map(collectionConfigs);
                                            newConfigs.delete(col.id);
                                            setCollectionConfigs(newConfigs);
                                          }}
                                          style={{
                                            fontSize: "12px",
                                            color: "#d72c0d",
                                            background: "none",
                                            border: "none",
                                            cursor: "pointer",
                                            textDecoration: "underline",
                                            padding: "4px 8px",
                                            flexShrink: 0,
                                          }}
                                        >
                                          解除
                                        </button>
                                      )}
                                    </div>
                                  );
                                })}
                              </>
                            )}
                          </div>
                          {displayCollections.length > ITEMS_PER_PAGE && (
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "12px", padding: "8px 0" }}>
                              <button
                                type="button"
                                onClick={() => setCollectionPage((p) => Math.max(1, p - 1))}
                                disabled={collectionPage <= 1}
                                style={{
                                  padding: "6px 12px",
                                  border: "1px solid #c9cccf",
                                  borderRadius: "6px",
                                  background: collectionPage <= 1 ? "#f6f6f7" : "#fff",
                                  cursor: collectionPage <= 1 ? "not-allowed" : "pointer",
                                  fontSize: "13px",
                                  color: collectionPage <= 1 ? "#8c9196" : "#202223",
                                }}
                              >
                                前へ
                              </button>
                              <span style={{ fontSize: "13px", color: "#6d7175" }}>
                                {(collectionPage - 1) * ITEMS_PER_PAGE + 1}-{Math.min(collectionPage * ITEMS_PER_PAGE, displayCollections.length)} / {displayCollections.length}件
                              </span>
                              <button
                                type="button"
                                onClick={() => setCollectionPage((p) => Math.min(collectionTotalPages, p + 1))}
                                disabled={collectionPage >= collectionTotalPages}
                                style={{
                                  padding: "6px 12px",
                                  border: "1px solid #c9cccf",
                                  borderRadius: "6px",
                                  background: collectionPage >= collectionTotalPages ? "#f6f6f7" : "#fff",
                                  cursor: collectionPage >= collectionTotalPages ? "not-allowed" : "pointer",
                                  fontSize: "13px",
                                  color: collectionPage >= collectionTotalPages ? "#8c9196" : "#202223",
                                }}
                              >
                                次へ
                              </button>
                            </div>
                          )}
                          {selectedCollectionIds.length > 0 && (
                            <s-text tone="subdued" size="small">
                              選択中: {selectedCollectionIds.length}件
                            </s-text>
                          )}
                          <s-stack direction="inline" gap="base">
                            <s-button
                              onClick={handleSaveGroup}
                              disabled={fetcher.state !== "idle" || !groupName.trim()}
                              tone={editingGroupId ? undefined : "success"}
                            >
                              {editingGroupId ? "更新" : "グループを追加する"}
                            </s-button>
                            {editingGroupId && (
                              <s-button
                                tone="critical"
                                onClick={() => {
                                  setEditingGroupId(null);
                                  setGroupName("");
                                  setSelectedCollectionIds([]);
                                  setCollectionConfigs(new Map());
                                }}
                              >
                                キャンセル
                              </s-button>
                            )}
                          </s-stack>
                        </s-stack>
                      )}

                      {/* 2. SKU選択から作成 */}
                      {groupCreateMethod === "sku" && (
                        <s-stack gap="base">
                          {editingGroupId && editingGroup && (
                            <div style={{ width: "100%", minWidth: 0, maxWidth: "100%", boxSizing: "border-box", padding: "12px 16px", background: "#e5e7eb", border: "1px solid #d1d5db", borderRadius: "8px", overflowWrap: "break-word", wordBreak: "break-word" }}>
                              <span style={{ fontWeight: 600, fontSize: "14px", whiteSpace: "normal" }}>「{editingGroup.name}」編集中</span>
                            </div>
                          )}
                          <s-text emphasis="bold" size="small">SKU選択から作成</s-text>
                          <s-text tone="subdued" size="small">
                            グループ名を入力し、一覧から商品を選択してグループを作成します。全商品・全バリアントを読み込み（多数の場合は初回ロードに時間がかかります）。入力で絞り込み。
                          </s-text>
                          <s-text-field
                            label="グループ名"
                            value={groupName}
                            onInput={(e: any) => setGroupName(readValue(e))}
                            onChange={(e: any) => setGroupName(readValue(e))}
                            placeholder="例: 食品グループ"
                          />
                          <s-text-field
                            label="SKUで絞り込み"
                            value={skuSearchQuery}
                            onInput={(e: any) => setSkuSearchQuery(readValue(e))}
                            onChange={(e: any) => setSkuSearchQuery(readValue(e))}
                            placeholder="SKU・商品名・JANの一部を入力"
                          />
                          {allSkuVariants.length > 0 && (
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}>
                              <s-text tone="subdued" size="small">
                                {showOnlySelectedSku
                                  ? `表示: 選択済み${displaySkuVariants.length}件`
                                  : displaySkuVariants.length <= ITEMS_PER_PAGE
                                    ? `表示: ${filteredSkuVariants.length}件 / 全${allSkuVariants.length}件`
                                    : `表示: ${(skuPage - 1) * ITEMS_PER_PAGE + 1}-${Math.min(skuPage * ITEMS_PER_PAGE, displaySkuVariants.length)}件 / 全${displaySkuVariants.length}件`}
                              </s-text>
                              <s-button
                                size="small"
                                tone={showOnlySelectedSku ? "success" : undefined}
                                onClick={() => setShowOnlySelectedSku((prev) => !prev)}
                              >
                                {showOnlySelectedSku ? "一覧表示に戻る" : "選択済み"}
                              </s-button>
                            </div>
                          )}
                          {allSkuVariants.length > 0 && (
                            <div style={{ maxHeight: "280px", overflowY: "auto", border: "1px solid #e1e3e5", borderRadius: "8px", padding: "6px" }}>
                              {displaySkuVariants.length > 0 ? paginatedSkuVariants.map((v) => {
                                const isSelected = selectedSkuVariants.some((x) => x.inventoryItemId === v.inventoryItemId);
                                return (
                                  <div
                                    key={v.inventoryItemId}
                                    onClick={() => toggleSkuVariant(v)}
                                    style={{
                                      padding: "10px 12px",
                                      borderRadius: "6px",
                                      cursor: "pointer",
                                      backgroundColor: isSelected ? "#f0f9f7" : "transparent",
                                      border: isSelected ? "1px solid #008060" : "1px solid transparent",
                                      borderBottom: isSelected ? undefined : "1px solid #e5e7eb",
                                      marginTop: "4px",
                                      display: "flex",
                                      alignItems: "center",
                                      gap: "8px",
                                    }}
                                  >
                                    <input type="checkbox" checked={isSelected} readOnly style={{ width: "16px", height: "16px", flexShrink: 0 }} />
                                    <div style={{ flex: "1 1 auto", minWidth: 0 }}>
                                      <span style={{ fontWeight: isSelected ? 600 : 500, overflow: "hidden", textOverflow: "ellipsis", display: "block" }}>
                                        {v.productTitle || "(商品名なし)"}
                                      </span>
                                      {v.sku ? (
                                        <span style={{ fontSize: "12px", color: "#6d7175", display: "block" }}>SKU：{v.sku}</span>
                                      ) : null}
                                      {v.barcode ? (
                                        <span style={{ fontSize: "12px", color: "#6d7175", display: "block" }}>JAN：{v.barcode}</span>
                                      ) : null}
                                      {(v.option1 || v.option2 || v.option3) ? (
                                        <span style={{ fontSize: "11px", color: "#8c9196", display: "block" }}>
                                          {[v.option1, v.option2, v.option3].filter(Boolean).join(" / ")}
                                        </span>
                                      ) : null}
                                    </div>
                                  </div>
                                );
                              }                              ) : (
                                <s-box padding="base">
                                  <s-text tone="subdued" size="small">
                                    {showOnlySelectedSku ? "選択済みの商品がありません" : "該当するSKUがありません"}
                                  </s-text>
                                </s-box>
                              )}
                            </div>
                          )}
                          {displaySkuVariants.length > ITEMS_PER_PAGE && (
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "12px", padding: "8px 0" }}>
                              <button
                                type="button"
                                onClick={() => setSkuPage((p) => Math.max(1, p - 1))}
                                disabled={skuPage <= 1}
                                style={{
                                  padding: "6px 12px",
                                  border: "1px solid #c9cccf",
                                  borderRadius: "6px",
                                  background: skuPage <= 1 ? "#f6f6f7" : "#fff",
                                  cursor: skuPage <= 1 ? "not-allowed" : "pointer",
                                  fontSize: "13px",
                                  color: skuPage <= 1 ? "#8c9196" : "#202223",
                                }}
                              >
                                前へ
                              </button>
                              <span style={{ fontSize: "13px", color: "#6d7175" }}>
                                {(skuPage - 1) * ITEMS_PER_PAGE + 1}-{Math.min(skuPage * ITEMS_PER_PAGE, displaySkuVariants.length)} / {displaySkuVariants.length}件
                              </span>
                              <button
                                type="button"
                                onClick={() => setSkuPage((p) => Math.min(skuTotalPages, p + 1))}
                                disabled={skuPage >= skuTotalPages}
                                style={{
                                  padding: "6px 12px",
                                  border: "1px solid #c9cccf",
                                  borderRadius: "6px",
                                  background: skuPage >= skuTotalPages ? "#f6f6f7" : "#fff",
                                  cursor: skuPage >= skuTotalPages ? "not-allowed" : "pointer",
                                  fontSize: "13px",
                                  color: skuPage >= skuTotalPages ? "#8c9196" : "#202223",
                                }}
                              >
                                次へ
                              </button>
                            </div>
                          )}
                          {(selectedSkuVariants.length > 0 || editingSkuOnlyPreservedIds.length > 0) && (
                            <s-text tone="subdued" size="small">
                              {editingGroupId && editingSkuOnlyPreservedIds.length > 0
                                ? `選択中: ${selectedSkuVariants.length}件（一覧外のSKU: ${editingSkuOnlyPreservedIds.length}件を含む）`
                                : `選択中: ${selectedSkuVariants.length}件`}
                            </s-text>
                          )}
                          <s-stack direction="inline" gap="base">
                            <s-button
                              onClick={handleSaveGroupFromSkuSelection}
                              disabled={fetcher.state !== "idle" || !groupName.trim() || (selectedSkuVariants.length === 0 && editingSkuOnlyPreservedIds.length === 0)}
                              tone={editingGroupId ? undefined : "success"}
                            >
                              {editingGroupId ? "更新" : "選択したSKUでグループを作成"}
                            </s-button>
                            {editingGroupId && (
                              <s-button
                                tone="critical"
                                onClick={() => {
                                  setEditingGroupId(null);
                                  setGroupName("");
                                  setSelectedSkuVariants([]);
                                  setEditingSkuOnlyPreservedIds([]);
                                }}
                              >
                                キャンセル
                              </s-button>
                            )}
                          </s-stack>
                        </s-stack>
                      )}

                      {/* 3. CSVで一括登録 */}
                      {groupCreateMethod === "csv" && (
                        <s-stack gap="base">
                          <s-text emphasis="bold" size="small">CSVで一括登録（グループ名＋SKU）</s-text>
                          <s-text tone="subdued" size="small">
                            1行目: グループ名,SKU（ヘッダー可）。同じグループ名の行は1グループにまとまります。1ファイル: グループ数は無制限、SKU行数は最大10000行です。
                          </s-text>
                          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                            <s-text tone="subdued" size="small">インポート時の動作</s-text>
                            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                              <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
                                <input
                                  type="radio"
                                  name="csvImportMode"
                                  checked={csvImportMode === "new_only"}
                                  onChange={() => setCsvImportMode("new_only")}
                                />
                                <span>新規作成（既存のグループ名はスキップし、存在しない名前だけ新規グループを作成）</span>
                              </label>
                              <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
                                <input
                                  type="radio"
                                  name="csvImportMode"
                                  checked={csvImportMode === "append"}
                                  onChange={() => setCsvImportMode("append")}
                                />
                                <span>追加（同じグループ名のSKUを既存に足す）</span>
                              </label>
                              <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
                                <input
                                  type="radio"
                                  name="csvImportMode"
                                  checked={csvImportMode === "replace"}
                                  onChange={() => setCsvImportMode("replace")}
                                />
                                <span>上書き（同じグループ名のSKUをCSVの内容で置き換える）</span>
                              </label>
                            </div>
                          </div>
                          <input
                            type="file"
                            ref={csvFileInputRef}
                            accept=".csv,text/csv"
                            style={{ display: "none" }}
                            onChange={handleCsvFileChange}
                          />
                          <s-stack direction="inline" gap="base">
                            <s-button onClick={handleCsvImportClick} disabled={fetcher.state !== "idle"} tone="secondary">
                              CSVでインポート
                            </s-button>
                            <s-button onClick={handleCsvTemplateDownload} tone="secondary">
                              テンプレートダウンロード
                            </s-button>
                            <s-button
                              onClick={handleCsvExport}
                              disabled={productGroups.length === 0}
                              tone="secondary"
                            >
                              登録済みをCSVダウンロード
                            </s-button>
                          </s-stack>
                          <s-text tone="subdued" size="small">
                            登録済みをCSVダウンロードで現在のグループ（SKU指定のみ）を取得できます。編集して「上書き」で再アップロードすると同じグループ名のSKUが置き換わります。
                          </s-text>
                          {fetcher.data && (fetcher.data as { ok?: boolean; imported?: number }).imported !== undefined && (fetcher.data as { ok?: boolean; imported?: number }).ok === true && (
                            <s-text tone="success" size="small">
                              {(fetcher.data as { imported: number }).imported}件のグループをインポートしました
                            </s-text>
                          )}
                          {fetcher.data && (fetcher.data as { ok?: boolean; error?: string }).error && (
                            <s-text tone="critical" size="small">
                              {(fetcher.data as { error: string }).error}
                            </s-text>
                          )}
                        </s-stack>
                      )}
                    </s-stack>
                  </div>

                  {/* 右側: 登録済み商品グループリスト */}
                  <div style={{ flex: "1 1 400px", minWidth: 0 }}>
                    <s-stack gap="base">
                      <s-stack direction="inline" gap="base" inlineAlignment="space-between">
                        <s-text emphasis="bold" size="large">登録済み商品グループ</s-text>
                        {productGroups.length > 0 && (
                          <s-text tone="subdued" size="small">
                            {productGroups.length}件のグループ
                          </s-text>
                        )}
                      </s-stack>
                      {productGroups.length === 0 ? (
                        <s-box padding="base" background="subdued">
                          <s-text tone="subdued">商品グループが登録されていません</s-text>
                        </s-box>
                      ) : (
                        <s-stack gap="base">
                          {productGroups.map((g) => {
                            const collectionConfigsMap = new Map<string, CollectionConfig>();
                            if (g.collectionConfigs && g.collectionConfigs.length > 0) {
                              for (const config of g.collectionConfigs) {
                                collectionConfigsMap.set(config.collectionId, config);
                              }
                            }

                            let groupSelectedTotal = 0;
                            let groupTotalTotal = 0;
                            g.collectionIds.forEach((cid) => {
                              const cfg = collectionConfigsMap.get(cid);
                              const sel = cfg?.selectedVariantIds?.length ?? 0;
                              const tot = cfg?.totalVariantCount ?? 0;
                              groupSelectedTotal += sel;
                              groupTotalTotal += tot;
                            });
                            const skuCount = g.skus?.length ?? g.inventoryItemIds?.length ?? 0;
                            const isSkuOnly = (g.collectionIds?.length ?? 0) === 0 && skuCount > 0;

                            return (
                              <s-box key={g.id} padding="base" background="subdued">
                                <s-stack gap="base">
                                  <s-stack direction="inline" gap="base" inlineAlignment="space-between">
                                    <s-stack direction="inline" gap="base" inlineAlignment="center">
                                      <s-text emphasis="bold">{g.name}</s-text>
                                      <s-text tone="subdued" size="small">
                                        {isSkuOnly ? `SKU指定: ${skuCount}件` : `合計: 選択 ${groupSelectedTotal} / ${groupTotalTotal}`}
                                      </s-text>
                                    </s-stack>
                                    <s-stack direction="inline" gap="base">
                                      <s-button
                                        size="small"
                                        onClick={() => {
                                          setEditingGroupId(g.id);
                                          setGroupName(g.name);
                                          if (isSkuOnly) {
                                            setGroupCreateMethod("sku");
                                            const ids = g.inventoryItemIds ?? [];
                                            setSelectedSkuVariants(allSkuVariants.filter((v) => ids.includes(v.inventoryItemId)));
                                            setEditingSkuOnlyPreservedIds(ids.filter((id) => !allSkuVariants.some((v) => v.inventoryItemId === id)));
                                            setSelectedCollectionIds([]);
                                            setCollectionConfigs(new Map());
                                          } else {
                                            setGroupCreateMethod("collection");
                                            setSelectedCollectionIds(g.collectionIds || []);
                                            const configMap = new Map<string, CollectionConfig>();
                                            if (g.collectionConfigs && g.collectionConfigs.length > 0) {
                                              for (const config of g.collectionConfigs) {
                                                configMap.set(config.collectionId, config);
                                              }
                                            }
                                            setCollectionConfigs(configMap);
                                            setEditingSkuOnlyPreservedIds([]);
                                          }
                                        }}
                                      >
                                        編集
                                      </s-button>
                                      <s-button
                                        size="small"
                                        tone="critical"
                                        onClick={() => handleDeleteGroup(g.id)}
                                      >
                                        削除
                                      </s-button>
                                    </s-stack>
                                  </s-stack>
                                  {g.collectionIds.length > 0 ? (
                                    <div style={{ display: "flex", flexDirection: "column", gap: "6px", width: "100%" }}>
                                      {g.collectionIds.map((cid) => {
                                        const col = collections.find((c) => c.id === cid);
                                        const config = collectionConfigsMap.get(cid);
                                        const selectedCount = config?.selectedVariantIds?.length ?? 0;
                                        const totalCount = config?.totalVariantCount ?? 0;

                                        return (
                                          <div
                                            key={cid}
                                            onClick={() => handleOpenCollectionModal(cid, g.id)}
                                            style={{
                                              cursor: "pointer",
                                              border: "1px solid #e1e3e5",
                                              borderRadius: "8px",
                                              padding: "8px",
                                              backgroundColor: "#ffffff",
                                              transition: "all 0.2s",
                                              width: "100%",
                                              display: "flex",
                                              alignItems: "center",
                                              gap: "10px",
                                            }}
                                            onMouseEnter={(e) => {
                                              e.currentTarget.style.borderColor = "#008060";
                                              e.currentTarget.style.backgroundColor = "#f9fafb";
                                            }}
                                            onMouseLeave={(e) => {
                                              e.currentTarget.style.borderColor = "#e1e3e5";
                                              e.currentTarget.style.backgroundColor = "#ffffff";
                                            }}
                                          >
                                            <div style={{
                                              width: "40px",
                                              height: "40px",
                                              backgroundColor: "#f6f6f7",
                                              borderRadius: "4px",
                                              display: "flex",
                                              alignItems: "center",
                                              justifyContent: "center",
                                              overflow: "hidden",
                                              flexShrink: 0,
                                            }}>
                                              {col?.image?.url ? (
                                                <img
                                                  src={col.image.url}
                                                  alt={col.image.altText || col.title || cid}
                                                  style={{
                                                    width: "100%",
                                                    height: "100%",
                                                    objectFit: "cover",
                                                  }}
                                                />
                                              ) : (
                                                <div style={{
                                                  color: "#8c9196",
                                                  fontSize: "20px",
                                                  fontWeight: "bold",
                                                }}>
                                                  {col?.title?.charAt(0).toUpperCase() || "?"}
                                                </div>
                                              )}
                                            </div>
                                            <div style={{ flex: "1 1 auto", minWidth: 0 }}>
                                              <div style={{
                                                fontSize: "14px",
                                                fontWeight: "500",
                                                color: "#202223",
                                                marginBottom: "4px",
                                                overflow: "hidden",
                                                textOverflow: "ellipsis",
                                                whiteSpace: "nowrap",
                                              }}>
                                                {col?.title || cid}
                                              </div>
                                              <div style={{
                                                fontSize: "12px",
                                                color: "#6d7175",
                                              }}>
                                                {selectedCount} / {totalCount}
                                              </div>
                                            </div>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  ) : isSkuOnly ? (
                                    <div
                                      role="button"
                                      tabIndex={0}
                                      onClick={() => {
                                        setEditingGroupId(g.id);
                                        setGroupName(g.name);
                                        setGroupCreateMethod("sku");
                                        const ids = g.inventoryItemIds ?? [];
                                        setSelectedSkuVariants(allSkuVariants.filter((v) => ids.includes(v.inventoryItemId)));
                                        setEditingSkuOnlyPreservedIds(ids.filter((id) => !allSkuVariants.some((v) => v.inventoryItemId === id)));
                                        setSelectedCollectionIds([]);
                                        setCollectionConfigs(new Map());
                                      }}
                                      onKeyDown={(e: React.KeyboardEvent) => {
                                        if (e.key === "Enter" || e.key === " ") {
                                          e.preventDefault();
                                          (e.currentTarget as HTMLElement).click();
                                        }
                                      }}
                                      style={{
                                        cursor: "pointer",
                                        border: "1px solid #e1e3e5",
                                        borderRadius: "8px",
                                        padding: "10px 12px",
                                        backgroundColor: "#ffffff",
                                        transition: "all 0.2s",
                                        width: "100%",
                                      }}
                                      onMouseEnter={(e) => {
                                        e.currentTarget.style.borderColor = "#008060";
                                        e.currentTarget.style.backgroundColor = "#f9fafb";
                                      }}
                                      onMouseLeave={(e) => {
                                        e.currentTarget.style.borderColor = "#e1e3e5";
                                        e.currentTarget.style.backgroundColor = "#ffffff";
                                      }}
                                    >
                                      <s-text tone="subdued" size="small">
                                        SKU一覧（{skuCount}件）を確認・編集
                                      </s-text>
                                      <s-text tone="subdued" size="small">
                                        クリックで左側の「SKU選択から作成」で一覧を表示
                                      </s-text>
                                    </div>
                                  ) : (
                                    <s-text tone="subdued" size="small">コレクション: なし</s-text>
                                  )}
                                </s-stack>
                              </s-box>
                            );
                          })}
                        </s-stack>
                      )}
                    </s-stack>
                  </div>
                </div>
              </s-box>
            </s-section>
          )}

          {/* 棚卸ID発行 */}
          {activeTab === "create" && (
            <s-section heading="棚卸ID発行">
              <s-box padding="base">
                <div style={{ display: "flex", gap: "24px", alignItems: "flex-start", flexWrap: "wrap" }}>
                  {/* 左側: 発行フォーム */}
                  <div style={{ flex: "0 1 320px", minWidth: 0 }}>
                    <s-stack gap="base">
                      <s-text emphasis="bold" size="large">棚卸IDを発行</s-text>
                      <s-text tone="subdued" size="small">
                        ロケーションと商品グループを選んで発行します。発行後はPOSで棚卸ができます。
                      </s-text>
                      <s-divider />

                      {/* Step 1: ロケーション選択 */}
                      <s-stack gap="base">
                        <s-text emphasis="bold" size="small">1. ロケーション選択</s-text>
                        <s-text tone="subdued" size="small">
                          棚卸を行うロケーションを1つ選びます。
                        </s-text>
                        <s-text-field
                          label="ロケーション検索"
                          value={createLocationSearchQuery}
                          onInput={(e: any) => setCreateLocationSearchQuery(readValue(e))}
                          onChange={(e: any) => setCreateLocationSearchQuery(readValue(e))}
                          placeholder="ロケーション名で検索..."
                        />
                        <div style={{ maxHeight: "220px", overflowY: "auto", border: "1px solid #e1e3e5", borderRadius: "8px", padding: "8px" }}>
                          {filteredLocations.length === 0 ? (
                            <s-text tone="subdued" size="small">ロケーションが見つかりません</s-text>
                          ) : (
                            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                              {filteredLocations.map((loc) => {
                                const isSelected = createLocationId === loc.id;
                                return (
                                  <div
                                    key={loc.id}
                                    onClick={() => setCreateLocationId(isSelected ? "" : loc.id)}
                                    style={{
                                      cursor: "pointer",
                                      padding: "10px 12px",
                                      borderRadius: "8px",
                                      border: isSelected ? "2px solid #008060" : "1px solid #e1e3e5",
                                      backgroundColor: isSelected ? "#f0f9f7" : "#ffffff",
                                    }}
                                  >
                                    <span style={{ fontWeight: isSelected ? 600 : 500 }}>{isSelected ? "✓ " : ""}{loc.name}</span>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                        {createLocationId && (
                          <s-text tone="subdued" size="small">
                            選択中: {locations.find((l) => l.id === createLocationId)?.name || createLocationId}
                          </s-text>
                        )}
                      </s-stack>
                      <s-divider />

                      {/* Step 2: 商品グループ選択 */}
                      <s-stack gap="base">
                        <s-text emphasis="bold" size="small">2. 商品グループ選択（複数可）</s-text>
                        <s-text tone="subdued" size="small">
                          対象の商品グループを1つ以上選びます。
                        </s-text>
                        <div style={{ maxHeight: "240px", overflowY: "auto", border: "1px solid #e1e3e5", borderRadius: "8px", padding: "8px" }}>
                          {productGroups.length === 0 ? (
                            <s-text tone="subdued" size="small">商品グループがありません。先に「商品グループ設定」で作成してください。</s-text>
                          ) : (
                            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                              {productGroups.map((g) => {
                                const isSelected = createProductGroupIds.includes(g.id);
                                const skuCount = g.skus?.length ?? g.inventoryItemIds?.length ?? 0;
                                const isSkuOnly = (g.collectionIds?.length ?? 0) === 0 && skuCount > 0;
                                const subLabel = isSkuOnly ? `SKU指定: ${skuCount}件` : `コレクション: ${g.collectionIds?.length ?? 0}件`;
                                return (
                                  <div
                                    key={g.id}
                                    onClick={() => toggleProductGroup(g.id)}
                                    style={{
                                      cursor: "pointer",
                                      padding: "10px 12px",
                                      borderRadius: "8px",
                                      border: isSelected ? "2px solid #008060" : "1px solid #e1e3e5",
                                      backgroundColor: isSelected ? "#f0f9f7" : "#ffffff",
                                      display: "flex",
                                      alignItems: "center",
                                      gap: "10px",
                                    }}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={isSelected}
                                      onChange={() => toggleProductGroup(g.id)}
                                      onClick={(e) => e.stopPropagation()}
                                      style={{ width: "18px", height: "18px", flexShrink: 0 }}
                                    />
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                      <div style={{ fontWeight: isSelected ? 600 : 500 }}>{g.name}</div>
                                      <div style={{ fontSize: "12px", color: "#6d7175" }}>{subLabel}</div>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                        {createProductGroupIds.length > 0 && (
                          <s-text tone="subdued" size="small">
                            選択中: {createProductGroupIds.length}グループ
                          </s-text>
                        )}
                      </s-stack>
                      <s-divider />

                      <s-button
                        onClick={handleCreateCount}
                        disabled={fetcher.state !== "idle" || !createLocationId || createProductGroupIds.length === 0}
                        tone="success"
                      >
                        棚卸IDを発行
                      </s-button>
                      {fetcher.data?.ok && fetcher.data.inventoryCountId && (
                        <s-box padding="base" background="subdued">
                          <s-text emphasis="bold" tone="success">
                            発行完了: {fetcher.data.countName ?? fetcher.data.inventoryCountId}
                          </s-text>
                          <s-text tone="subdued" size="small" style={{ display: "block", marginTop: "4px" }}>
                            履歴タブで確認・CSV出力できます。
                          </s-text>
                        </s-box>
                      )}
                    </s-stack>
                  </div>

                  {/* 右側: 発行の流れ・直近一覧 */}
                  <div style={{ flex: "1 1 400px", minWidth: 0 }}>
                    <s-stack gap="base">
                      <s-text emphasis="bold" size="large">発行の流れ</s-text>
                      <s-box padding="base" background="subdued" style={{ borderRadius: "8px" }}>
                        <s-stack gap="base">
                          <div style={{ display: "flex", gap: "8px", alignItems: "flex-start" }}>
                            <span style={{ fontWeight: 700, color: "#008060", minWidth: "20px" }}>1</span>
                            <span>左でロケーションと商品グループを選び「棚卸IDを発行」を押します。</span>
                          </div>
                          <div style={{ display: "flex", gap: "8px", alignItems: "flex-start" }}>
                            <span style={{ fontWeight: 700, color: "#008060", minWidth: "20px" }}>2</span>
                            <span>発行された棚卸IDがPOSに表示されます。</span>
                          </div>
                          <div style={{ display: "flex", gap: "8px", alignItems: "flex-start" }}>
                            <span style={{ fontWeight: 700, color: "#008060", minWidth: "20px" }}>3</span>
                            <span>POSで棚卸IDを選び、実数入力して完了させます。</span>
                          </div>
                        </s-stack>
                      </s-box>
                      <s-text emphasis="bold" size="small">直近の発行</s-text>
                      {inventoryCounts.length === 0 ? (
                        <s-text tone="subdued" size="small">まだ発行されていません。</s-text>
                      ) : (
                        <div style={{ maxHeight: "280px", overflowY: "auto", border: "1px solid #e1e3e5", borderRadius: "8px", padding: "8px" }}>
                          <s-stack gap="base">
                            {[...inventoryCounts]
                              .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
                              .slice(0, 10)
                              .map((c) => (
                              <div
                                key={c.id}
                                style={{
                                  padding: "10px",
                                  borderBottom: "1px solid #eee",
                                  fontSize: "13px",
                                }}
                              >
                                <div style={{ fontWeight: 600 }}>{c.countName ?? c.id}</div>
                                <div style={{ color: "#6d7175", fontSize: "12px", marginTop: "2px" }}>
                                  {locations.find((l) => l.id === c.locationId)?.name ?? c.locationId} · {getStatusLabel(c.status)} · {new Date(c.createdAt).toLocaleString("ja-JP")}
                                </div>
                              </div>
                            ))}
                          </s-stack>
                          <s-text tone="subdued" size="small" style={{ display: "block", marginTop: "8px" }}>
                            一覧は「履歴」タブで確認できます。
                          </s-text>
                        </div>
                      )}
                    </s-stack>
                  </div>
                </div>
              </s-box>
            </s-section>
          )}

          {/* 履歴 */}
          {activeTab === "history" && (
            <>
              <s-section heading="履歴">
                <s-box padding="base">
                  <div style={{ display: "flex", gap: "24px", alignItems: "flex-start", flexWrap: "wrap" }}>
                    {/* 左: フィルター（リスト選択で絞り込み） */}
                    <div style={{ flex: "0 1 260px", minWidth: 0 }}>
                      <s-stack gap="base">
                        <s-text emphasis="bold" size="large">フィルター</s-text>
                        <s-text tone="subdued" size="small">
                          ロケーション・ステータスを選ぶと一覧が絞り込まれます。未選択＝全て表示。
                        </s-text>
                        <s-divider />
                        <s-text emphasis="bold" size="small">ロケーション</s-text>
                        <div style={{ maxHeight: "200px", overflowY: "auto", border: "1px solid #e1e3e5", borderRadius: "8px", padding: "6px" }}>
                          <div
                            onClick={() => setLocationFilters(new Set())}
                            style={{
                              padding: "10px 12px",
                              borderRadius: "6px",
                              cursor: "pointer",
                              backgroundColor: locationFilters.size === 0 ? "#f0f9f7" : "transparent",
                              border: locationFilters.size === 0 ? "1px solid #008060" : "1px solid transparent",
                              display: "flex",
                              alignItems: "center",
                              gap: "8px",
                            }}
                          >
                            <input type="checkbox" checked={locationFilters.size === 0} readOnly style={{ width: "16px", height: "16px", flexShrink: 0 }} />
                            <span style={{ fontWeight: locationFilters.size === 0 ? 600 : 500 }}>全て</span>
                          </div>
                          {locations.map((loc) => {
                            const isSelected = locationFilters.has(loc.id);
                            return (
                              <div
                                key={loc.id}
                                onClick={() => {
                                  const newFilters = new Set(locationFilters);
                                  if (isSelected) {
                                    newFilters.delete(loc.id);
                                  } else {
                                    newFilters.add(loc.id);
                                  }
                                  setLocationFilters(newFilters);
                                }}
                                style={{
                                  padding: "10px 12px",
                                  borderRadius: "6px",
                                  cursor: "pointer",
                                  backgroundColor: isSelected ? "#f0f9f7" : "transparent",
                                  border: isSelected ? "1px solid #008060" : "1px solid transparent",
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
                                <span style={{ fontWeight: isSelected ? 600 : 500, overflow: "hidden", textOverflow: "ellipsis" }}>{loc.name}</span>
                              </div>
                            );
                          })}
                        </div>
                        <s-text emphasis="bold" size="small">ステータス</s-text>
                        <div style={{ maxHeight: "180px", overflowY: "auto", border: "1px solid #e1e3e5", borderRadius: "8px", padding: "6px" }}>
                          <div
                            onClick={() => setStatusFilters(new Set())}
                            style={{
                              padding: "10px 12px",
                              borderRadius: "6px",
                              cursor: "pointer",
                              backgroundColor: statusFilters.size === 0 ? "#f0f9f7" : "transparent",
                              border: statusFilters.size === 0 ? "1px solid #008060" : "1px solid transparent",
                              display: "flex",
                              alignItems: "center",
                              gap: "8px",
                            }}
                          >
                            <input type="checkbox" checked={statusFilters.size === 0} readOnly style={{ width: "16px", height: "16px", flexShrink: 0 }} />
                            <span style={{ fontWeight: statusFilters.size === 0 ? 600 : 500 }}>全て</span>
                          </div>
                          {["draft", "in_progress", "completed", "cancelled"].map((s) => {
                            const isSelected = statusFilters.has(s);
                            return (
                              <div
                                key={s}
                                onClick={() => {
                                  const newFilters = new Set(statusFilters);
                                  if (isSelected) {
                                    newFilters.delete(s);
                                  } else {
                                    newFilters.add(s);
                                  }
                                  setStatusFilters(newFilters);
                                }}
                                style={{
                                  padding: "10px 12px",
                                  borderRadius: "6px",
                                  cursor: "pointer",
                                  backgroundColor: isSelected ? "#f0f9f7" : "transparent",
                                  border: isSelected ? "1px solid #008060" : "1px solid transparent",
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
                                <span style={{ fontWeight: isSelected ? 600 : 500 }}>{getStatusLabel(s)}</span>
                              </div>
                            );
                          })}
                        </div>
                      </s-stack>
                    </div>

                    {/* 右: 履歴一覧 */}
                    <div style={{ flex: "1 1 400px", minWidth: 0 }}>
                      <s-stack gap="base">
                        <s-text tone="subdued" size="small">
                          表示: {filteredCounts.length}件 / 全{inventoryCounts.length}件
                        </s-text>
                        {/* 履歴一覧 */}
                        {filteredCounts.length === 0 ? (
                <s-box padding="base">
                  <s-text tone="subdued">履歴がありません</s-text>
                </s-box>
              ) : (
                <s-stack gap="none">
                  {filteredCounts.map((c) => {
                    const isSelected = selectedIds.has(c.id);
                    const locName = getLocationName(c.locationId);
                    const statusLabel = getStatusLabel(c.status);
                    const countName = c.countName || c.id;
                    const date = c.createdAt ? new Date(c.createdAt).toISOString().split("T")[0] : "";
                    // ✅ 複数商品グループがある場合はgroupItemsを優先、単一グループの場合はitemsフィールドを後方互換性として使用
                    const groupItemsMap = (c as any)?.groupItems && typeof (c as any).groupItems === "object" ? (c as any).groupItems : {};
                    const hasMultipleGroups = Array.isArray(c.productGroupIds) && c.productGroupIds.length > 1;
                    const allGroupIds = Array.isArray(c.productGroupIds) && c.productGroupIds.length > 0
                      ? c.productGroupIds
                      : c.productGroupId ? [c.productGroupId] : [];
                    
                    // ✅ 完了済みグループの商品を取得
                    const itemsFromGroup = allGroupIds.flatMap((id) => Array.isArray(groupItemsMap[id]) ? groupItemsMap[id] : []);
                    
                    // ✅ 未完了グループの商品リストを取得（一覧表示用）
                    const incompleteGroupProductsForThisCount = incompleteGroupProductsForList.get(c.id) || new Map();
                    const itemsFromIncompleteGroups = allGroupIds.flatMap((groupId) => {
                      const groupItems = groupId && groupItemsMap[groupId] && Array.isArray(groupItemsMap[groupId]) ? groupItemsMap[groupId] : [];
                      // 未完了グループの場合、incompleteGroupProductsForListから取得
                      if (groupItems.length === 0) {
                        return Array.isArray(incompleteGroupProductsForThisCount.get(groupId)) ? incompleteGroupProductsForThisCount.get(groupId) : [];
                      }
                      return [];
                    });
                    
                    // ✅ 複数グループの場合、未完了グループの商品も含めるため、itemsフィールドから取得（後方互換性）
                    // ✅ itemsフィールドには全グループの商品が含まれている（確定処理で修正済み）
                    // ✅ ただし、groupItemsMapに含まれているグループの商品は重複を避けるため、itemsから除外
                    const completedGroupInventoryItemIds = new Set(itemsFromGroup.map((it) => it.inventoryItemId));
                    const incompleteGroupInventoryItemIds = new Set(itemsFromIncompleteGroups.map((it) => it.inventoryItemId));
                    const itemsFromItemsForIncomplete = hasMultipleGroups && Array.isArray(c.items) && c.items.length > 0
                      ? c.items.filter((it) => !completedGroupInventoryItemIds.has(it.inventoryItemId) && !incompleteGroupInventoryItemIds.has(it.inventoryItemId))
                      : [];
                    
                    // ✅ 完了済みグループの商品 + 未完了グループの商品（incompleteGroupProductsForListから取得、なければitemsフィールドから）
                    // ✅ 単一グループの場合でも、未完了グループの商品リストを含める
                    const allGroupItems = hasMultipleGroups
                      ? [...itemsFromGroup, ...itemsFromIncompleteGroups, ...itemsFromItemsForIncomplete]
                      : (itemsFromGroup.length > 0 
                          ? itemsFromGroup 
                          : (itemsFromIncompleteGroups.length > 0 
                              ? itemsFromIncompleteGroups 
                              : (Array.isArray(c.items) && c.items.length > 0 ? c.items : [])));
                    
                    const itemCount = allGroupItems.length;
                    const totalQty = allGroupItems.reduce((s, it) => s + (it.actualQuantity || 0), 0);
                    const currentQty = allGroupItems.reduce((s, it) => s + (it.currentQuantity || 0), 0);
                    // ✅ 合計数（在庫数）の表示：currentQtyが0より大きい場合は表示、そうでない場合は"-"を表示
                    // ✅ 進捗状況のグループ別表示と同じロジック（1997行目参照）
                    const isCompleted = c.status === "completed";

                    const groupNames = Array.isArray(c.productGroupNames) && c.productGroupNames.length > 0
                      ? c.productGroupNames.join(", ")
                      : Array.isArray(c.productGroupIds) && c.productGroupIds.length > 0
                      ? c.productGroupIds.join(", ")
                      : c.productGroupName || c.productGroupId || "-";

                    return (
                      <div key={c.id}>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "flex-start",
                            padding: "12px",
                            cursor: "pointer",
                          }}
                          onClick={() => {
                            // ✅ 最新のinventoryCountsから該当のデータを取得
                            const latestCount = inventoryCounts.find((ic) => ic.id === c.id);
                            // ✅ countNameが設定されていない場合、cのcountNameを使用
                            const countToShow = latestCount || c;
                            if (!countToShow.countName && c.countName) {
                              countToShow.countName = c.countName;
                            }
                            setModalCount(countToShow);
                            setModalOpen(true);
                          }}
                        >
                          {/* チェックボックスは非表示（仕様は残す） */}
                          {/* <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={(e) => {
                              e.stopPropagation();
                              const newSelected = new Set(selectedIds);
                              if (e.target.checked) {
                                newSelected.add(c.id);
                              } else {
                                newSelected.delete(c.id);
                              }
                              setSelectedIds(newSelected);
                            }}
                            onClick={(e) => e.stopPropagation()}
                            style={{
                              width: "18px",
                              height: "18px",
                              cursor: "pointer",
                              marginRight: "12px",
                              marginTop: "2px",
                            }}
                          /> */}
                          <div style={{ flex: "1 1 auto", minWidth: 0 }}>
                            <div
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                                marginBottom: "4px",
                              }}
                            >
                              <s-text
                                emphasis="bold"
                                style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                              >
                                {countName}
                              </s-text>
                              <s-text tone="subdued" size="small" style={{ whiteSpace: "nowrap", marginLeft: "8px" }}>
                                {date}
                              </s-text>
                            </div>
                            <div style={{ marginBottom: "2px" }}>
                              <s-text
                                tone="subdued"
                                size="small"
                                style={{
                                  whiteSpace: "nowrap",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  display: "block",
                                }}
                              >
                                ロケーション: {locName}
                              </s-text>
                            </div>
                            <div>
                              <s-text
                                tone="subdued"
                                size="small"
                                style={{
                                  whiteSpace: "nowrap",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  display: "block",
                                }}
                              >
                                商品グループ: {groupNames}
                              </s-text>
                            </div>
                            <div
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                                marginTop: "4px",
                              }}
                            >
                              <s-text tone="subdued" size="small" style={{ whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: "4px" }}>
                                状態: {statusLabel}
                              </s-text>
                              <s-text tone="subdued" size="small" style={{ whiteSpace: "nowrap" }}>
                                {itemCount}件・実数{totalQty}{currentQty > 0 ? `/${currentQty}` : "/-"}
                              </s-text>
                            </div>
                          </div>
                        </div>
                        <s-divider />
                      </div>
                    );
                  })}
                </s-stack>
              )}
                      </s-stack>
                    </div>
                  </div>
                </s-box>
              </s-section>

              {/* ページネーション（入出庫履歴と同じ形式、metafieldは全件取得のため常に非表示） */}
              {/* 注意: 棚卸はmetafieldから全件取得しているため、実際にはページネーションは不要 */}
              {/* ただし、UIの一貫性のため、入出庫履歴と同じ形式でページネーションを追加 */}
              {/* pageInfoは常にfalseのため、ページネーションは表示されない */}
            </>
          )}

          {fetcher.data?.error && (
            <s-box padding="base" background="critical-subdued">
              <s-text tone="critical">{fetcher.data.error}</s-text>
            </s-box>
          )}

          {/* 商品リストモーダル（入出庫履歴と同じ形式） */}
          {modalOpen && modalCount && (
            <div
              style={{
                position: "fixed",
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                backgroundColor: "rgba(0, 0, 0, 0.5)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                zIndex: 1000,
              }}
              onClick={() => {
                setModalOpen(false);
                setModalCount(null);
              }}
            >
              <div
                style={{
                  backgroundColor: "white",
                  borderRadius: "8px",
                  padding: "24px",
                  maxWidth: "90%",
                  maxHeight: "90%",
                  overflow: "auto",
                  boxShadow: "0 4px 6px rgba(0, 0, 0, 0.1)",
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <div style={{ marginBottom: "16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <h2 style={{ margin: 0, fontSize: "20px", fontWeight: "bold" }}>
                    商品リスト
                  </h2>
                  <button
                    onClick={() => {
                      setModalOpen(false);
                      setModalCount(null);
                    }}
                    style={{
                      background: "none",
                      border: "none",
                      fontSize: "24px",
                      cursor: "pointer",
                      padding: "0",
                      width: "32px",
                      height: "32px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    ×
                  </button>
                </div>

                {modalCount && (
                  <div style={{ marginBottom: "16px", padding: "12px", backgroundColor: "#f5f5f5", borderRadius: "4px" }}>
                    <div style={{ fontSize: "14px", marginBottom: "4px" }}>
                      <strong>棚卸ID:</strong> {modalCount.countName || modalCount.id}
                    </div>
                    <div style={{ fontSize: "14px", marginBottom: "4px" }}>
                      <strong>ロケーション:</strong> {getLocationName(modalCount.locationId)}
                    </div>
                    <div style={{ fontSize: "14px", marginBottom: "4px" }}>
                      <strong>商品グループ:</strong> {
                        Array.isArray(modalCount.productGroupNames) && modalCount.productGroupNames.length > 0
                          ? modalCount.productGroupNames.join(", ")
                          : Array.isArray(modalCount.productGroupIds) && modalCount.productGroupIds.length > 0
                          ? modalCount.productGroupIds.join(", ")
                          : modalCount.productGroupName || modalCount.productGroupId || "-"
                      }
                    </div>
                    {(() => {
                      // ✅ 商品グループがある場合：各グループの進捗状況を表示（単一グループ・複数グループ両方に対応）
                      const allGroupIds = Array.isArray(modalCount.productGroupIds) && modalCount.productGroupIds.length > 0
                        ? modalCount.productGroupIds
                        : modalCount.productGroupId ? [modalCount.productGroupId] : [];
                      const groupItemsMap = (modalCount as any)?.groupItems && typeof (modalCount as any).groupItems === "object" ? (modalCount as any).groupItems : {};
                      
                      if (allGroupIds.length > 0) {
                        // ✅ 後方互換性：groupItemsがない場合、itemsフィールドから該当グループの商品をフィルタリング
                        const countItemsLegacy = Array.isArray(modalCount.items) ? modalCount.items : [];
                        const progressInfo = allGroupIds.map((groupId) => {
                          let groupItems = Array.isArray(groupItemsMap[groupId]) ? groupItemsMap[groupId] : [];
                          // ✅ 問題2の修正: アプリ側と同じロジックに統一（複数グループでもitemsからフィルタリングを試みる）
                          // ✅ 後方互換性：groupItemsがない場合、itemsフィールドから該当グループの商品をフィルタリング
                          if (groupItems.length === 0 && countItemsLegacy.length > 0) {
                            // ✅ 商品グループのinventoryItemIdsを取得（保存されている場合）
                            const productGroup = productGroups.find((g) => g.id === groupId);
                            const groupInventoryItemIds = productGroup?.inventoryItemIds || [];
                            
                            if (groupInventoryItemIds.length > 0) {
                              // ✅ inventoryItemIdsが保存されている場合、それを使ってフィルタリング
                              const groupInventoryItemIdsSet = new Set(groupInventoryItemIds);
                              groupItems = countItemsLegacy.filter((item) => {
                                const itemId = String(item?.inventoryItemId || "").trim();
                                return groupInventoryItemIdsSet.has(itemId);
                              });
                            } else if (allGroupIds.length === 1) {
                              // ✅ 単一グループの場合、itemsフィールドのデータをそのまま使用（後方互換性）
                              groupItems = countItemsLegacy;
                            }
                            // ✅ 複数グループでinventoryItemIdsが保存されていない場合は、groupItemsが空のまま（完了と判定しない）
                          }
                          // ✅ 未完了グループの商品リストを取得
                          const incompleteProducts = incompleteGroupProducts.get(groupId) || [];
                          // ✅ 完了判定：groupItems[groupId]が存在し、かつ配列の長さが0より大きい場合に完了と判定
                          const isCompleted = groupItems.length > 0;
                          // ✅ 完了済みの場合はgroupItemsを使用、未完了の場合はincompleteProductsを使用
                          const displayItems = isCompleted ? groupItems : incompleteProducts;
                          
                          const groupName = Array.isArray(modalCount.productGroupNames) && modalCount.productGroupNames.length > 0
                            ? modalCount.productGroupNames[allGroupIds.indexOf(groupId)] || groupId
                            : productGroups.find((g) => g.id === groupId)?.name || groupId;
                          // ✅ グループごとの進捗数を計算
                          const groupTotalQty = displayItems.reduce((sum, it) => sum + (Number(it?.currentQuantity || 0)), 0);
                          const groupActualQty = displayItems.reduce((sum, it) => sum + (Number(it?.actualQuantity || 0)), 0);
                          return { groupId, groupName, isCompleted, totalQty: groupTotalQty, actualQty: groupActualQty };
                        });
                        
                        return (
                          <div style={{ fontSize: "14px", marginBottom: "4px" }}>
                            <strong>進捗状況:</strong>
                            <div style={{ marginTop: "4px", marginLeft: "16px" }}>
                              {progressInfo.map((info) => (
                                <div key={info.groupId} style={{ fontSize: "13px", color: info.isCompleted ? "#28a745" : "#ffc107" }}>
                                  {info.groupName}: {info.isCompleted ? "完了済み" : "未完了"}
                                  {info.totalQty > 0 || info.actualQty > 0 ? (
                                    <span style={{ marginLeft: "8px", color: "#666" }}>
                                      （{info.actualQty}/{info.totalQty > 0 ? info.totalQty : "-"}）
                                    </span>
                                  ) : null}
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      }
                      return null;
                    })()}
                    <div style={{ fontSize: "14px", marginBottom: "4px" }}>
                      <strong>ステータス:</strong> {getStatusLabel(modalCount.status)}
                    </div>
                    <div style={{ fontSize: "14px", marginBottom: "4px" }}>
                      <strong>作成日時:</strong> {modalCount.createdAt ? new Date(modalCount.createdAt).toISOString().split("T")[0] : ""}
                    </div>
                    {modalCount.completedAt && (
                      <div style={{ fontSize: "14px" }}>
                        <strong>完了日時:</strong> {new Date(modalCount.completedAt).toISOString().split("T")[0]}
                      </div>
                    )}
                  </div>
                )}

                {(() => {
                  // ✅ 複数商品グループがある場合：groupItemsから各グループのデータを取得
                  const allGroupIds = Array.isArray(modalCount.productGroupIds) && modalCount.productGroupIds.length > 0
                    ? modalCount.productGroupIds
                    : modalCount.productGroupId ? [modalCount.productGroupId] : [];
                  const groupItemsMap = (modalCount as any)?.groupItems && typeof (modalCount as any).groupItems === "object" ? (modalCount as any).groupItems : {};
                  const hasMultipleGroups = allGroupIds.length > 1;
                  
                  // ✅ 商品グループごとのデータを取得
                  // ✅ CSV出力と同じロジックを使用
                  const itemsByGroup = new Map<string, typeof modalCount.items>();
                  // ✅ 完了済みグループを追跡するためのMap（groupId -> true/false）
                  // ✅ このMapはitemsByGroupの構築時と完了判定時の両方で使用される
                  const completedGroupsMap = new Map<string, boolean>();
                  const countItemsLegacy = Array.isArray(modalCount.items) && modalCount.items.length > 0 ? modalCount.items : [];
                  if (hasMultipleGroups) {
                    // ✅ 複数グループの場合：CSV出力と同じロジック
                    for (const groupId of allGroupIds) {
                      // ✅ groupItemsMapからデータを取得（キーの型を考慮）
                      let groupItems = Array.isArray(groupItemsMap[groupId]) ? groupItemsMap[groupId] : [];
                      // ✅ キーが一致しない場合、文字列変換を試す
                      if (groupItems.length === 0) {
                        groupItems = Array.isArray(groupItemsMap[String(groupId)]) ? groupItemsMap[String(groupId)] : [];
                      }
                      // ✅ さらに、groupItemsMapの全てのキーを確認（デバッグ用）
                      if (groupItems.length === 0 && Object.keys(groupItemsMap).length > 0) {
                        // groupItemsMapのキーとallGroupIdsの値を比較
                        const matchingKey = Object.keys(groupItemsMap).find((key) => {
                          return key === String(groupId) || key === groupId || String(key) === String(groupId);
                        });
                        if (matchingKey) {
                          groupItems = Array.isArray(groupItemsMap[matchingKey]) ? groupItemsMap[matchingKey] : [];
                        }
                      }
                      // ✅ 後方互換性：groupItemsがない場合、itemsフィールドから該当グループの商品をフィルタリング
                      if (groupItems.length === 0 && countItemsLegacy.length > 0) {
                        // ✅ 商品グループのinventoryItemIdsを取得（保存されている場合）
                        const productGroup = productGroups.find((g) => g.id === groupId);
                        const groupInventoryItemIds = productGroup?.inventoryItemIds || [];
                        
                        if (groupInventoryItemIds.length > 0) {
                          // ✅ inventoryItemIdsが保存されている場合、それを使ってフィルタリング
                          const groupInventoryItemIdsSet = new Set(groupInventoryItemIds);
                          groupItems = countItemsLegacy.filter((item) => {
                            const itemId = String(item?.inventoryItemId || "").trim();
                            return groupInventoryItemIdsSet.has(itemId);
                          });
                        }
                      }
                      const isGroupCompleted = groupItems.length > 0;
                      // ✅ 完了済みグループを追跡
                      completedGroupsMap.set(groupId, isGroupCompleted);
                      if (isGroupCompleted) {
                        // ✅ 完了済みの場合はgroupItemsを使用（予定外商品を最後にソート）
                        const normalItemsForGroup = groupItems.filter((it) => !(it as any).isExtra);
                        const extraItemsForGroup = groupItems.filter((it) => !!(it as any).isExtra);
                        const sortedGroupItems = [...normalItemsForGroup, ...extraItemsForGroup];
                        itemsByGroup.set(groupId, sortedGroupItems);
                      } else {
                        // ✅ 未完了グループの商品リストを取得
                        const incompleteProducts = incompleteGroupProducts.get(groupId) || [];
                        itemsByGroup.set(groupId, incompleteProducts);
                      }
                    }
                  } else {
                    // ✅ 単一グループの場合：後方互換性の処理
                    const groupId = allGroupIds[0];
                    let groupItems = Array.isArray(groupItemsMap[groupId]) ? groupItemsMap[groupId] : [];
                    if (groupItems.length === 0) {
                      const countItemsLegacy = Array.isArray(modalCount.items) ? modalCount.items : [];
                      if (countItemsLegacy.length > 0) {
                        groupItems = countItemsLegacy;
                      }
                    }
                    const isGroupCompleted = groupItems.length > 0;
                    // ✅ 完了済みグループを追跡
                    completedGroupsMap.set(groupId, isGroupCompleted);
                    if (isGroupCompleted) {
                      // ✅ 予定外商品を最後にソート
                      const normalItemsForGroup = groupItems.filter((it) => !(it as any).isExtra);
                      const extraItemsForGroup = groupItems.filter((it) => !!(it as any).isExtra);
                      const sortedGroupItems = [...normalItemsForGroup, ...extraItemsForGroup];
                      itemsByGroup.set(groupId, sortedGroupItems);
                    } else {
                      const incompleteProducts = incompleteGroupProducts.get(groupId) || [];
                      itemsByGroup.set(groupId, incompleteProducts);
                    }
                  }
                  
                  // ✅ 表示用のデータを準備（完了済みと未完了の両方を含む）
                  // ✅ CSV出力と同じロジック（ただし、単一グループの場合でもitemsByGroupから取得）
                  const displayItems = itemsByGroup.size > 0
                    ? Array.from(itemsByGroup.values()).flat()
                    : (Array.isArray(modalCount.items) && modalCount.items.length > 0 ? modalCount.items : []);
                  
                  // ✅ 合計の在庫数と実数を計算（未完了グループも含む）
                  const totalCurrentQty = displayItems.reduce((sum, it) => sum + (Number(it?.currentQuantity || 0)), 0);
                  const totalActualQty = displayItems.reduce((sum, it) => sum + (Number(it?.actualQuantity || 0)), 0);
                  
                  if (displayItems.length === 0) {
                    return (
                      <div style={{ padding: "24px", textAlign: "center" }}>
                        <div>商品明細がありません</div>
                      </div>
                    );
                  }
                  
                  return (
                    <div>
                      <div style={{ marginBottom: "12px", fontSize: "14px", color: "#666" }}>
                        合計: {displayItems.length}件
                        {totalCurrentQty > 0 || totalActualQty > 0 ? (
                          <span style={{ marginLeft: "8px" }}>
                            （実数: {totalActualQty} / 在庫数: {totalCurrentQty > 0 ? totalCurrentQty : "-"}）
                          </span>
                        ) : null}
                        {hasMultipleGroups && itemsByGroup.size > 0 && (
                          <div style={{ marginTop: "4px", fontSize: "12px" }}>
                            商品グループごとの進捗: {itemsByGroup.size}/{allGroupIds.length}グループ完了
                          </div>
                        )}
                      </div>
                      <div style={{ maxHeight: "400px", overflowY: "auto" }}>
                        {hasMultipleGroups && itemsByGroup.size > 0 ? (
                          // ✅ 複数商品グループがある場合：グループごとにセクションを分けて表示
                          <div>
                            {allGroupIds.map((groupId) => {
                              // ✅ itemsByGroupから既に取得したデータを使用（完了済み・未完了の両方を含む）
                              const groupItems = itemsByGroup.get(groupId) || [];
                              
                              // ✅ 完了判定：groupItemsMapにデータがあるかどうかで判定（キーの型を考慮）
                              let groupItemsFromMap = Array.isArray(groupItemsMap[groupId]) ? groupItemsMap[groupId] : [];
                              if (groupItemsFromMap.length === 0) {
                                groupItemsFromMap = Array.isArray(groupItemsMap[String(groupId)]) ? groupItemsMap[String(groupId)] : [];
                              }
                              if (groupItemsFromMap.length === 0 && Object.keys(groupItemsMap).length > 0) {
                                const matchingKey = Object.keys(groupItemsMap).find((key) => {
                                  return key === String(groupId) || key === groupId || String(key) === String(groupId);
                                });
                                if (matchingKey) {
                                  groupItemsFromMap = Array.isArray(groupItemsMap[matchingKey]) ? groupItemsMap[matchingKey] : [];
                                }
                              }
                              // ✅ 完了判定：
                              // 1. groupItemsFromMapにデータがある場合（groupItemsが保存されている場合）→ 必ず完了済み（incompleteProductsForGroupの値は無視）
                              // 2. または、itemsByGroupの構築時に完了済みとして設定された場合（completedGroupsMapで追跡）
                              // ✅ 重要：groupItemsFromMapにデータがある場合、またはitemsByGroupの構築時に完了済みとして設定された場合は、incompleteProductsForGroupの値に関係なく完了済みと判定
                              const incompleteProductsForGroup = incompleteGroupProducts.get(groupId) || [];
                              const hasGroupItemsFromMap = groupItemsFromMap.length > 0;
                              const hasGroupItems = groupItems.length > 0;
                              // ✅ itemsByGroupの構築時に完了済みとして設定されたかどうかを確認
                              const wasCompletedInItemsByGroup = completedGroupsMap.get(groupId) === true;
                              // ✅ groupItemsFromMapにデータがある場合、またはitemsByGroupの構築時に完了済みとして設定された場合は、必ず完了済み（incompleteProductsForGroupの値は無視）
                              // ✅ それ以外（groupItems.length === 0 または incompleteProductsForGroup.length > 0）は未完了
                              const isGroupCompleted = hasGroupItemsFromMap 
                                ? true 
                                : (wasCompletedInItemsByGroup ? true : (hasGroupItems && incompleteProductsForGroup.length === 0));
                              const groupName = Array.isArray(modalCount.productGroupNames) && modalCount.productGroupNames.length > 0
                                ? modalCount.productGroupNames[allGroupIds.indexOf(groupId)] || groupId
                                : productGroups.find((g) => g.id === groupId)?.name || groupId;
                              
                              // ✅ グループごとの進捗数を計算
                              const groupTotalQty = groupItems.reduce((sum, it) => sum + (Number(it?.currentQuantity || 0)), 0);
                              const groupActualQty = groupItems.reduce((sum, it) => sum + (Number(it?.actualQuantity || 0)), 0);
                              
                              return (
                                <div key={groupId} style={{ marginBottom: "24px", padding: "12px", backgroundColor: isGroupCompleted ? "#f0f8f0" : "#fff8f0", borderRadius: "4px" }}>
                                  <div style={{ marginBottom: "8px", fontSize: "14px", fontWeight: "bold", color: isGroupCompleted ? "#28a745" : "#ffc107" }}>
                                    {groupName} {isGroupCompleted ? "（完了済み）" : "（未完了）"}
                                    {groupItems.length > 0 && (
                                      <span style={{ fontSize: "12px", fontWeight: "normal", marginLeft: "8px", color: "#666" }}>
                                        （{groupActualQty}/{groupTotalQty > 0 ? groupTotalQty : "-"}）
                                      </span>
                                    )}
                                  </div>
                                  {groupItems.length > 0 ? (
                                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px", backgroundColor: "transparent" }}>
                                      <thead>
                                        <tr style={{ backgroundColor: "#f5f5f5", borderBottom: "2px solid #ddd" }}>
                                          <th style={{ padding: "8px", textAlign: "left", borderRight: "1px solid #ddd" }}>商品グループ</th>
                                          <th style={{ padding: "8px", textAlign: "left", borderRight: "1px solid #ddd" }}>商品名</th>
                                          <th style={{ padding: "8px", textAlign: "left", borderRight: "1px solid #ddd" }}>SKU</th>
                                          <th style={{ padding: "8px", textAlign: "left", borderRight: "1px solid #ddd" }}>JAN</th>
                                          <th style={{ padding: "8px", textAlign: "left", borderRight: "1px solid #ddd" }}>オプション1</th>
                                          <th style={{ padding: "8px", textAlign: "left", borderRight: "1px solid #ddd" }}>オプション2</th>
                                          <th style={{ padding: "8px", textAlign: "left", borderRight: "1px solid #ddd" }}>オプション3</th>
                                          <th style={{ padding: "8px", textAlign: "right", borderRight: "1px solid #ddd" }}>在庫</th>
                                          <th style={{ padding: "8px", textAlign: "right", borderRight: "1px solid #ddd" }}>実数</th>
                                          <th style={{ padding: "8px", textAlign: "right" }}>差分</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {(() => {
                                          // ✅ 予定外商品を分離（isExtraフラグで判定）
                                          const normalItems = groupItems.filter((it) => !(it as any).isExtra);
                                          const extraItems = groupItems.filter((it) => !!(it as any).isExtra);
                                          // ✅ 通常商品を先に表示し、予定外商品を最後に表示
                                          const sortedItems = [...normalItems, ...extraItems];
                                          
                                          
                                          return sortedItems.map((it, idx) => {
                                            const titleRaw = String(it.title || "").trim();
                                            const parts = titleRaw.split("/").map((s) => s.trim()).filter(Boolean);
                                            const productName = parts[0] || titleRaw || it.sku || "（商品名なし）";
                                            const optionParts = parts.length >= 2 ? parts.slice(1) : [];
                                            const option1 = optionParts[0] || "";
                                            const option2 = optionParts[1] || "";
                                            const option3 = optionParts[2] || "";
                                            // ✅ SKUとJANを分離（it.skuとit.barcodeから取得）
                                            const sku = String(it.sku || "").trim();
                                            const jan = String((it as any).barcode || "").trim();
                                            // ✅ 予定外商品かどうかを判定
                                            const isExtra = !!(it as any).isExtra;
                                            
                                            // ✅ 背景色を明示的に設定（入庫履歴のモーダルと同じ実装：app.history.tsx 1346行目を参照）
                                            // ✅ 入庫履歴ではインラインスタイルを直接設定しているため、同じ方法を使用
                                            const cellStyle: React.CSSProperties = {
                                              padding: "8px",
                                              borderRight: "1px solid #eee",
                                            };
                                            
                                            // ✅ 入庫履歴と同じ実装：インラインスタイルを直接設定
                                            const rowStyleInline = { borderBottom: "1px solid #eee", backgroundColor: isExtra ? "#ffe6e6" : "transparent" };
                                            
                                            return (
                                              <tr key={`${groupId}-${it.inventoryItemId}-${idx}`} style={rowStyleInline}>
                                              <td style={{ ...cellStyle, fontWeight: "bold", color: isGroupCompleted ? "#28a745" : "#ffc107" }}>
                                                {groupName}
                                                <div style={{ fontSize: "11px", color: "#666", marginTop: "2px" }}>
                                                  {isGroupCompleted ? "✓ 完了" : "未完了"}
                                                </div>
                                              </td>
                                              <td style={cellStyle}>
                                                {productName}
                                              </td>
                                              <td style={cellStyle}>
                                                {sku || "-"}
                                              </td>
                                              <td style={cellStyle}>
                                                {jan || "-"}
                                              </td>
                                              <td style={cellStyle}>
                                                {option1 || "-"}
                                              </td>
                                              <td style={cellStyle}>
                                                {option2 || "-"}
                                              </td>
                                              <td style={cellStyle}>
                                                {option3 || "-"}
                                              </td>
                                              <td style={{ ...cellStyle, textAlign: "right" }}>
                                                {it.currentQuantity ?? "-"}
                                              </td>
                                              <td style={{ ...cellStyle, textAlign: "right" }}>
                                                {it.actualQuantity ?? "-"}
                                              </td>
                                              <td style={{ ...cellStyle, textAlign: "right", borderRight: "none" }}>
                                                {it.delta ?? "-"}
                                              </td>
                                            </tr>
                                            );
                                          });
                                        })()}
                                      </tbody>
                                    </table>
                                  ) : (
                                    <div style={{ padding: "8px", fontSize: "14px", color: "#666" }}>
                                      この商品グループはまだ処理されていません
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          // ✅ 単一商品グループまたはitemsフィールドを使用する場合：列を統一
                          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px" }}>
                            <thead>
                              <tr style={{ backgroundColor: "#f5f5f5", borderBottom: "2px solid #ddd" }}>
                                <th style={{ padding: "8px", textAlign: "left", borderRight: "1px solid #ddd" }}>商品グループ</th>
                                <th style={{ padding: "8px", textAlign: "left", borderRight: "1px solid #ddd" }}>商品名</th>
                                <th style={{ padding: "8px", textAlign: "left", borderRight: "1px solid #ddd" }}>SKU</th>
                                <th style={{ padding: "8px", textAlign: "left", borderRight: "1px solid #ddd" }}>JAN</th>
                                <th style={{ padding: "8px", textAlign: "left", borderRight: "1px solid #ddd" }}>オプション1</th>
                                <th style={{ padding: "8px", textAlign: "left", borderRight: "1px solid #ddd" }}>オプション2</th>
                                <th style={{ padding: "8px", textAlign: "left", borderRight: "1px solid #ddd" }}>オプション3</th>
                                <th style={{ padding: "8px", textAlign: "right", borderRight: "1px solid #ddd" }}>在庫</th>
                                <th style={{ padding: "8px", textAlign: "right", borderRight: "1px solid #ddd" }}>実数</th>
                                <th style={{ padding: "8px", textAlign: "right" }}>差分</th>
                              </tr>
                            </thead>
                            <tbody>
                              {displayItems.map((it, idx) => {
                                const titleRaw = String(it.title || "").trim();
                                const parts = titleRaw.split("/").map((s) => s.trim()).filter(Boolean);
                                const productName = parts[0] || titleRaw || it.sku || "（商品名なし）";
                                const optionParts = parts.length >= 2 ? parts.slice(1) : [];
                                const option1 = optionParts[0] || "";
                                const option2 = optionParts[1] || "";
                                const option3 = optionParts[2] || "";
                                // ✅ SKUとJANを分離
                                const sku = String(it.sku || "").trim();
                                const jan = String((it as any).barcode || "").trim();
                                // ✅ 予定外商品かどうかを判定（入庫履歴のモーダルと同じ実装）
                                const isExtra = !!(it as any).isExtra;
                                // ✅ 商品グループ名を取得（単一グループの場合）
                                const groupName = Array.isArray(modalCount.productGroupNames) && modalCount.productGroupNames.length > 0
                                  ? modalCount.productGroupNames[0]
                                  : Array.isArray(modalCount.productGroupIds) && modalCount.productGroupIds.length > 0
                                  ? productGroups.find((g) => g.id === modalCount.productGroupIds[0])?.name || modalCount.productGroupIds[0]
                                  : modalCount.productGroupName || modalCount.productGroupId || "-";
                                
                                // ✅ 入庫履歴のモーダルと同じ実装：予定外商品に赤背景を設定（app.history.tsx 1346行目を参照）
                                const rowStyleInline = { borderBottom: "1px solid #eee", backgroundColor: isExtra ? "#ffe6e6" : "transparent" };
                                
                                return (
                                  <tr key={idx} style={rowStyleInline}>
                                    <td style={{ padding: "8px", borderRight: "1px solid #eee", fontWeight: "bold" }}>
                                      {groupName}
                                    </td>
                                    <td style={{ padding: "8px", borderRight: "1px solid #eee" }}>
                                      {productName}
                                    </td>
                                    <td style={{ padding: "8px", borderRight: "1px solid #eee" }}>
                                      {sku || "-"}
                                    </td>
                                    <td style={{ padding: "8px", borderRight: "1px solid #eee" }}>
                                      {jan || "-"}
                                    </td>
                                    <td style={{ padding: "8px", borderRight: "1px solid #eee" }}>
                                      {option1 || "-"}
                                    </td>
                                    <td style={{ padding: "8px", borderRight: "1px solid #eee" }}>
                                      {option2 || "-"}
                                    </td>
                                    <td style={{ padding: "8px", borderRight: "1px solid #eee" }}>
                                      {option3 || "-"}
                                    </td>
                                    <td style={{ padding: "8px", textAlign: "right", borderRight: "1px solid #eee" }}>
                                      {it.currentQuantity ?? "-"}
                                    </td>
                                    <td style={{ padding: "8px", textAlign: "right", borderRight: "1px solid #eee" }}>
                                      {it.actualQuantity ?? "-"}
                                    </td>
                                    <td style={{ padding: "8px", textAlign: "right" }}>
                                      {it.delta ?? "-"}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        )}
                      </div>
                    </div>
                  );
                })()}

                <div style={{ marginTop: "24px", display: "flex", justifyContent: "flex-end", gap: "12px" }}>
                  <button
                    onClick={() => {
                      // ✅ 複数商品グループがある場合：groupItemsから各グループのデータを取得
                      // ✅ モーダル表示と同じロジックを使用（キーの型を考慮、後方互換性対応）
                      const allGroupIds = Array.isArray(modalCount.productGroupIds) && modalCount.productGroupIds.length > 0
                        ? modalCount.productGroupIds
                        : modalCount.productGroupId ? [modalCount.productGroupId] : [];
                      const groupItemsMap = (modalCount as any)?.groupItems && typeof (modalCount as any).groupItems === "object" ? (modalCount as any).groupItems : {};
                      const hasMultipleGroups = allGroupIds.length > 1;
                      
                      // ✅ 商品グループごとのデータを取得（モーダル表示と同じロジック）
                      const itemsByGroup = new Map<string, typeof modalCount.items>();
                      const countItemsLegacy = Array.isArray(modalCount.items) && modalCount.items.length > 0 ? modalCount.items : [];
                      if (hasMultipleGroups) {
                        // ✅ 複数グループの場合：モーダル表示と同じロジック
                        for (const groupId of allGroupIds) {
                          // ✅ groupItemsMapからデータを取得（キーの型を考慮）
                          let groupItems = Array.isArray(groupItemsMap[groupId]) ? groupItemsMap[groupId] : [];
                          // ✅ キーが一致しない場合、文字列変換を試す
                          if (groupItems.length === 0) {
                            groupItems = Array.isArray(groupItemsMap[String(groupId)]) ? groupItemsMap[String(groupId)] : [];
                          }
                          // ✅ さらに、groupItemsMapの全てのキーを確認
                          if (groupItems.length === 0 && Object.keys(groupItemsMap).length > 0) {
                            const matchingKey = Object.keys(groupItemsMap).find((key) => {
                              return key === String(groupId) || key === groupId || String(key) === String(groupId);
                            });
                            if (matchingKey) {
                              groupItems = Array.isArray(groupItemsMap[matchingKey]) ? groupItemsMap[matchingKey] : [];
                            }
                          }
                          // ✅ 後方互換性：groupItemsがない場合、itemsフィールドから該当グループの商品をフィルタリング
                          if (groupItems.length === 0 && countItemsLegacy.length > 0) {
                            const productGroup = productGroups.find((g) => g.id === groupId);
                            const groupInventoryItemIds = productGroup?.inventoryItemIds || [];
                            
                            if (groupInventoryItemIds.length > 0) {
                              const groupInventoryItemIdsSet = new Set(groupInventoryItemIds);
                              groupItems = countItemsLegacy.filter((item) => {
                                const itemId = String(item?.inventoryItemId || "").trim();
                                return groupInventoryItemIdsSet.has(itemId);
                              });
                            }
                          }
                          const isGroupCompleted = groupItems.length > 0;
                          if (isGroupCompleted) {
                            // ✅ 完了済みの場合はgroupItemsを使用（予定外商品を最後にソート）
                            const normalItemsForGroup = groupItems.filter((it) => !(it as any).isExtra);
                            const extraItemsForGroup = groupItems.filter((it) => !!(it as any).isExtra);
                            const sortedGroupItems = [...normalItemsForGroup, ...extraItemsForGroup];
                            itemsByGroup.set(groupId, sortedGroupItems);
                          } else {
                            // ✅ 未完了グループの商品リストを取得
                            const incompleteProducts = incompleteGroupProducts.get(groupId) || [];
                            itemsByGroup.set(groupId, incompleteProducts);
                          }
                        }
                      } else {
                        // ✅ 単一グループの場合：モーダル表示と同じロジック
                        const groupId = allGroupIds[0];
                        let groupItems = Array.isArray(groupItemsMap[groupId]) ? groupItemsMap[groupId] : [];
                        // ✅ キーが一致しない場合、文字列変換を試す
                        if (groupItems.length === 0) {
                          groupItems = Array.isArray(groupItemsMap[String(groupId)]) ? groupItemsMap[String(groupId)] : [];
                        }
                        // ✅ さらに、groupItemsMapの全てのキーを確認
                        if (groupItems.length === 0 && Object.keys(groupItemsMap).length > 0) {
                          const matchingKey = Object.keys(groupItemsMap).find((key) => {
                            return key === String(groupId) || key === groupId || String(key) === String(groupId);
                          });
                          if (matchingKey) {
                            groupItems = Array.isArray(groupItemsMap[matchingKey]) ? groupItemsMap[matchingKey] : [];
                          }
                        }
                        // ✅ 後方互換性：groupItemsがない場合、itemsフィールドを使用
                        if (groupItems.length === 0) {
                          if (countItemsLegacy.length > 0) {
                            groupItems = countItemsLegacy;
                          }
                        }
                        const isGroupCompleted = groupItems.length > 0;
                        if (isGroupCompleted) {
                          // ✅ 予定外商品を最後にソート
                          const normalItemsForGroup = groupItems.filter((it) => !(it as any).isExtra);
                          const extraItemsForGroup = groupItems.filter((it) => !!(it as any).isExtra);
                          const sortedGroupItems = [...normalItemsForGroup, ...extraItemsForGroup];
                          itemsByGroup.set(groupId, sortedGroupItems);
                        } else {
                          // ✅ 未完了グループの商品リストを取得
                          const incompleteProducts = incompleteGroupProducts.get(groupId) || [];
                          itemsByGroup.set(groupId, incompleteProducts);
                        }
                      }
                      
                      // ✅ 表示用のデータを準備（完了済みと未完了の両方を含む）
                      // ✅ 各商品にグループIDとグループ名、完了状態を追加
                      const displayItemsWithGroupInfo: Array<typeof modalCount.items[0] & { groupId: string; groupName: string; isGroupCompleted: boolean }> = [];
                      
                      if (itemsByGroup.size > 0) {
                        // ✅ itemsByGroupから取得した商品にグループ情報を追加
                        for (const [groupId, groupItems] of itemsByGroup.entries()) {
                          // ✅ グループ名を取得
                          const groupName = Array.isArray(modalCount.productGroupNames) && modalCount.productGroupNames.length > 0
                            ? modalCount.productGroupNames[allGroupIds.indexOf(groupId)] || groupId
                            : productGroups.find((g) => g.id === groupId)?.name || groupId;
                          
                          // ✅ グループの完了状態を判定（モーダル表示と同じロジック）
                          let groupItemsFromMap = Array.isArray(groupItemsMap[groupId]) ? groupItemsMap[groupId] : [];
                          if (groupItemsFromMap.length === 0) {
                            groupItemsFromMap = Array.isArray(groupItemsMap[String(groupId)]) ? groupItemsMap[String(groupId)] : [];
                          }
                          if (groupItemsFromMap.length === 0 && Object.keys(groupItemsMap).length > 0) {
                            const matchingKey = Object.keys(groupItemsMap).find((key) => {
                              return key === String(groupId) || key === groupId || String(key) === String(groupId);
                            });
                            if (matchingKey) {
                              groupItemsFromMap = Array.isArray(groupItemsMap[matchingKey]) ? groupItemsMap[matchingKey] : [];
                            }
                          }
                          const hasGroupItemsFromMap = groupItemsFromMap.length > 0;
                          const hasGroupItems = groupItems.length > 0;
                          const incompleteProductsForGroup = incompleteGroupProducts.get(groupId) || [];
                          const wasCompletedInItemsByGroup = hasGroupItems && incompleteProductsForGroup.length === 0;
                          const isGroupCompleted = hasGroupItemsFromMap || wasCompletedInItemsByGroup;
                          
                          // ✅ 各商品にグループ情報を追加
                          groupItems.forEach((item) => {
                            displayItemsWithGroupInfo.push({
                              ...item,
                              groupId,
                              groupName,
                              isGroupCompleted,
                            } as any);
                          });
                        }
                      } else {
                        // ✅ itemsByGroupが空の場合、modalCount.itemsを使用（単一グループの場合）
                        const groupId = allGroupIds[0] || "";
                        const groupName = Array.isArray(modalCount.productGroupNames) && modalCount.productGroupNames.length > 0
                          ? modalCount.productGroupNames[0]
                          : modalCount.productGroupName || modalCount.productGroupId || "-";
                        const groupItemsFromMap = Array.isArray(groupItemsMap[groupId]) ? groupItemsMap[groupId] : [];
                        const isGroupCompleted = groupItemsFromMap.length > 0;
                        
                        (modalCount.items || []).forEach((item) => {
                          displayItemsWithGroupInfo.push({
                            ...item,
                            groupId,
                            groupName,
                            isGroupCompleted,
                          } as any);
                        });
                      }
                      
                      if (!displayItemsWithGroupInfo || displayItemsWithGroupInfo.length === 0) {
                        alert("商品リストがありません");
                        return;
                      }

                      const headers = [
                        "棚卸ID",
                        "名称",
                        "ロケーション",
                        "商品グループ",
                        "ステータス",
                        "商品名/SKU",
                        "オプション1",
                        "オプション2",
                        "オプション3",
                        "現在在庫",
                        "実数",
                        "差分",
                        "予定外",
                        "作成日時",
                        "完了日時",
                      ];

                      const rows: string[][] = [];
                      displayItemsWithGroupInfo.forEach((it) => {
                        const locName = getLocationName(modalCount.locationId);
                        const countName = modalCount.countName || modalCount.id;
                        
                        // ✅ 商品が属するグループの名前とステータスを使用
                        const groupName = (it as any).groupName || "-";
                        const isGroupCompleted = (it as any).isGroupCompleted || false;
                        const statusLabel = isGroupCompleted ? "完了" : "進行中";

                        // ✅ 商品名とオプションを分離（入出庫と同じ実装）
                        const titleRaw = String(it.title || "").trim();
                        const parts = titleRaw.split("/").map((s) => s.trim()).filter(Boolean);
                        const productName = parts[0] || titleRaw || it.sku || "-";
                        const optionParts = parts.length >= 2 ? parts.slice(1) : [];
                        const option1 = optionParts[0] || "";
                        const option2 = optionParts[1] || "";
                        const option3 = optionParts[2] || "";
                        
                        // ✅ 予定外商品かどうかを判定
                        const isExtra = !!(it as any).isExtra;
                        const extraLabel = isExtra ? "予定外" : "";

                        rows.push([
                          modalCount.id,
                          countName,
                          locName,
                          groupName,
                          statusLabel,
                          productName,
                          option1,
                          option2,
                          option3,
                          String(it.currentQuantity ?? ""),
                          String(it.actualQuantity ?? ""),
                          String(it.delta ?? ""),
                          extraLabel,
                          modalCount.createdAt,
                          modalCount.completedAt || "",
                        ]);
                      });

                      const csvContent = [headers, ...rows]
                        .map((row) => row.map(escapeCsv).join(","))
                        .join("\n");
                      const blob = new Blob(["\uFEFF" + csvContent], {
                        type: "text/csv;charset=utf-8;",
                      });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = `棚卸履歴_${modalCount.countName || modalCount.id}_${new Date().toISOString().slice(0, 10)}.csv`;
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                    style={{
                      padding: "8px 16px",
                      backgroundColor: "#007bff",
                      color: "white",
                      border: "none",
                      borderRadius: "4px",
                      cursor: "pointer",
                      fontSize: "14px",
                    }}
                  >
                    CSV出力
                  </button>
                  <button
                    onClick={() => {
                      setModalOpen(false);
                      setModalCount(null);
                    }}
                    style={{
                      padding: "8px 16px",
                      backgroundColor: "#6c757d",
                      color: "white",
                      border: "none",
                      borderRadius: "4px",
                      cursor: "pointer",
                      fontSize: "14px",
                    }}
                  >
                    閉じる
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* コレクション商品選択モーダル（入出庫履歴と同じ形式） */}
          {collectionModalOpen && (
            <div
              style={{
                position: "fixed",
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                backgroundColor: "rgba(0, 0, 0, 0.5)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                zIndex: 1000,
              }}
              onClick={() => {
                setCollectionModalOpen(false);
                setCollectionModalCollectionId(null);
                setCollectionModalProducts([]);
                setCollectionModalSelectedVariantIds(new Set());
              }}
            >
              <div
                style={{
                  backgroundColor: "white",
                  borderRadius: "8px",
                  padding: "24px",
                  maxWidth: "90%",
                  maxHeight: "90%",
                  overflow: "auto",
                  boxShadow: "0 4px 6px rgba(0, 0, 0, 0.1)",
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <div style={{ marginBottom: "16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <h2 style={{ margin: 0, fontSize: "20px", fontWeight: "bold" }}>
                    商品選択: {collectionProductsFetcher.data?.collectionTitle || "コレクション"}
                  </h2>
                  <button
                    onClick={() => {
                      setCollectionModalOpen(false);
                      setCollectionModalCollectionId(null);
                      setCollectionModalProductGroupId(null);
                      setCollectionModalProducts([]);
                      setCollectionModalSelectedVariantIds(new Set());
                    }}
                    style={{
                      background: "none",
                      border: "none",
                      fontSize: "24px",
                      cursor: "pointer",
                      padding: "0",
                      width: "32px",
                      height: "32px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    ×
                  </button>
                </div>

                <div style={{ marginBottom: "16px", padding: "12px", backgroundColor: "#f5f5f5", borderRadius: "4px" }}>
                  <div style={{ fontSize: "14px", marginBottom: "4px" }}>
                    <strong>コレクション:</strong> {collectionProductsFetcher.data?.collectionTitle || "コレクション"}
                  </div>
                  <div style={{ fontSize: "14px" }}>
                    <strong>選択:</strong> {collectionModalSelectedVariantIds.size} / <strong>合計:</strong> {collectionModalProducts.length}
                  </div>
                </div>

                {collectionModalLoading ? (
                  <div style={{ padding: "24px", textAlign: "center" }}>
                    <div>商品リストを取得中...</div>
                  </div>
                ) : collectionModalProducts.length === 0 ? (
                  <div style={{ padding: "24px", textAlign: "center" }}>
                    <div>商品が見つかりません</div>
                  </div>
                ) : (
                  <div>
                    <div style={{ marginBottom: "12px" }}>
                      <input
                        type="text"
                        value={collectionModalSearchQuery}
                        onChange={(e) => setCollectionModalSearchQuery(e.target.value)}
                        placeholder="SKU・商品名・JANの一部で絞り込み"
                        style={{
                          width: "100%",
                          padding: "8px 12px",
                          border: "1px solid #e1e3e5",
                          borderRadius: "6px",
                          fontSize: "14px",
                          marginBottom: "8px",
                          boxSizing: "border-box",
                        }}
                      />
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}>
                        <span style={{ fontSize: "13px", color: "#6d7175" }}>
                          {showOnlySelectedInModal
                            ? `表示: 選択済み${displayModalProducts.length}件`
                            : displayModalProducts.length <= MODAL_ITEMS_PER_PAGE
                              ? `表示: ${displayModalProducts.length}件 / 全${collectionModalProducts.length}件`
                              : `表示: ${(collectionModalPage - 1) * MODAL_ITEMS_PER_PAGE + 1}-${Math.min(collectionModalPage * MODAL_ITEMS_PER_PAGE, displayModalProducts.length)}件 / 全${displayModalProducts.length}件`}
                        </span>
                        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                          <button
                            type="button"
                            onClick={() => setShowOnlySelectedInModal((prev) => !prev)}
                            style={{
                              padding: "6px 12px",
                              backgroundColor: showOnlySelectedInModal ? "#008060" : "#e5e7eb",
                              color: showOnlySelectedInModal ? "#fff" : "#202223",
                              border: "none",
                              borderRadius: "6px",
                              cursor: "pointer",
                              fontSize: "13px",
                            }}
                          >
                            {showOnlySelectedInModal ? "一覧表示に戻る" : "選択済み"}
                          </button>
                          <button
                            onClick={() => {
                              const allIds = new Set(collectionModalProducts.map((p) => p.variantId));
                              setCollectionModalSelectedVariantIds(allIds);
                            }}
                            style={{
                              padding: "6px 12px",
                              backgroundColor: "#007bff",
                              color: "white",
                              border: "none",
                              borderRadius: "6px",
                              cursor: "pointer",
                              fontSize: "13px",
                            }}
                          >
                            全選択
                          </button>
                          <button
                            onClick={() => setCollectionModalSelectedVariantIds(new Set())}
                            style={{
                              padding: "6px 12px",
                              backgroundColor: "#6c757d",
                              color: "white",
                              border: "none",
                              borderRadius: "6px",
                              cursor: "pointer",
                              fontSize: "13px",
                            }}
                          >
                            全解除
                          </button>
                        </div>
                      </div>
                    </div>
                    <div style={{ maxHeight: "400px", overflowY: "auto" }}>
                      {displayModalProducts.length === 0 ? (
                        <div style={{ padding: "24px", textAlign: "center", fontSize: "14px", color: "#6d7175" }}>
                          {showOnlySelectedInModal ? "選択済みの商品がありません" : "該当する商品がありません"}
                        </div>
                      ) : (
                        paginatedModalProducts.map((product) => {
                          const isSelected = collectionModalSelectedVariantIds.has(product.variantId);
                          const title = [product.productTitle, product.variantTitle]
                            .filter(Boolean)
                            .join(" / ");

                          return (
                            <div
                              key={product.variantId}
                              style={{
                                padding: "12px",
                                marginBottom: "0",
                                borderBottom: "1px solid #e5e7eb",
                                backgroundColor: isSelected ? "#e7f3ff" : "#f5f5f5",
                                borderRadius: "0",
                                display: "flex",
                                alignItems: "center",
                                gap: "12px",
                              }}
                            >
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={(e) => {
                                  const newSet = new Set(collectionModalSelectedVariantIds);
                                  if (e.target.checked) {
                                    newSet.add(product.variantId);
                                  } else {
                                    newSet.delete(product.variantId);
                                  }
                                  setCollectionModalSelectedVariantIds(newSet);
                                }}
                                style={{ width: "20px", height: "20px", cursor: "pointer" }}
                              />
                              <div style={{ flex: 1, fontSize: "14px" }}>
                                {title}
                                {product.sku && <span style={{ color: "#666", marginLeft: "8px" }}>(SKU: {product.sku})</span>}
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                    {displayModalProducts.length > MODAL_ITEMS_PER_PAGE && (
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "12px", padding: "12px 0" }}>
                        <button
                          type="button"
                          onClick={() => setCollectionModalPage((p) => Math.max(1, p - 1))}
                          disabled={collectionModalPage <= 1}
                          style={{
                            padding: "6px 12px",
                            border: "1px solid #c9cccf",
                            borderRadius: "6px",
                            background: collectionModalPage <= 1 ? "#f6f6f7" : "#fff",
                            cursor: collectionModalPage <= 1 ? "not-allowed" : "pointer",
                            fontSize: "13px",
                            color: collectionModalPage <= 1 ? "#8c9196" : "#202223",
                          }}
                        >
                          前へ
                        </button>
                        <span style={{ fontSize: "13px", color: "#6d7175" }}>
                          {(collectionModalPage - 1) * MODAL_ITEMS_PER_PAGE + 1}-{Math.min(collectionModalPage * MODAL_ITEMS_PER_PAGE, displayModalProducts.length)} / {displayModalProducts.length}件
                        </span>
                        <button
                          type="button"
                          onClick={() => setCollectionModalPage((p) => Math.min(modalTotalPages, p + 1))}
                          disabled={collectionModalPage >= modalTotalPages}
                          style={{
                            padding: "6px 12px",
                            border: "1px solid #c9cccf",
                            borderRadius: "6px",
                            background: collectionModalPage >= modalTotalPages ? "#f6f6f7" : "#fff",
                            cursor: collectionModalPage >= modalTotalPages ? "not-allowed" : "pointer",
                            fontSize: "13px",
                            color: collectionModalPage >= modalTotalPages ? "#8c9196" : "#202223",
                          }}
                        >
                          次へ
                        </button>
                      </div>
                    )}
                  </div>
                )}

                <div style={{ marginTop: "24px", display: "flex", justifyContent: "flex-end", gap: "12px" }}>
                  <button
                    onClick={() => {
                      setCollectionModalOpen(false);
                      setCollectionModalCollectionId(null);
                      setCollectionModalProductGroupId(null);
                      setCollectionModalProducts([]);
                      setCollectionModalSelectedVariantIds(new Set());
                    }}
                    style={{
                      padding: "8px 16px",
                      backgroundColor: "#6c757d",
                      color: "white",
                      border: "none",
                      borderRadius: "4px",
                      cursor: "pointer",
                      fontSize: "14px",
                    }}
                  >
                    キャンセル
                  </button>
                  <button
                    onClick={handleConfirmCollectionSelection}
                    style={{
                      padding: "8px 16px",
                      backgroundColor: "#28a745",
                      color: "white",
                      border: "none",
                      borderRadius: "4px",
                      cursor: "pointer",
                      fontSize: "14px",
                    }}
                  >
                    確定
                  </button>
                </div>
              </div>
            </div>
          )}
        </s-stack>
      </s-scroll-box>
    </s-page>
  );
}
